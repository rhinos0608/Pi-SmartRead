#!/usr/bin/env node
/**
 * Retrieval-holdout freezer (E15): sealed, instance-disjoint holdout of
 * ~400 titles from already-seen external JS/TS repos.
 *
 * Default action is `--census`: loads the SWE-bench Multilingual +
 * Multi-SWE-bench JS/TS rows from cache (`--offline` where possible),
 * applies the exposure blacklist (every historical manifest/report, all
 * D46 repos), verifies gold presence at base against cached bare clones
 * (read-only `git ls-tree`, never fetches), and prints eligibility
 * counts by repo/language/patch-size bucket plus the minimum detectable
 * effect. The census writes nothing.
 *
 * `--run-freeze` performs the real freeze (implemented and unit-tested;
 * run only when the program authorizes opening a new holdout): seeded
 * stratified selection, a ranked reserve list, and a NEW non-overwriting
 * 0600 manifest with hashes of dataset bytes, query text, gold, and
 * base commit, plus a consumed-opening ledger helper.
 *
 * Usage:
 *   npx tsx scripts/eval/external/grep/freeze-instance-holdout.ts --accept-license-review [--seed SEED] [--offline]
 *   npx tsx scripts/eval/external/grep/freeze-instance-holdout.ts --accept-license-review --run-freeze [--size N] [--reserve M] [--offline]
 *
 * Runs NO grep engine and NO comparator: freezing must land before any
 * variant results exist on these instances.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    blacklistHit,
    buildExposureBlacklist,
    collectManifestIds,
    collectReportIds,
    issueKeyOfInstanceId,
    loadD46Repos,
    type BlacklistHit,
    type ExposureBlacklist,
} from "./exposure-blacklist.js";
import type { BenchmarkInstance } from "./instance.js";
import {
    MULTI_SWE_BENCH_FILES,
    MULTI_SWE_BENCH_LICENSE_NOTE,
    assertMultiSweBenchLicense,
    cachedFileRevision,
    ensureDatasetFileCached,
    msbRowsToInstances,
    readCachedRows,
} from "./multi-swe-bench.js";
import { bareRepoDir } from "./repos.js";
import {
    manifestsDir,
    patchSizeBucket,
    rankForSplit,
    seededRandom,
    seededShuffle,
} from "./sampling.js";
import {
    SWE_BENCH_MULTILINGUAL_LICENSE,
    datasetRevision,
    fetchAllRows,
    rowsToInstances,
} from "./swebench-multilingual.js";

export const RETRIEVAL_HOLDOUT_SEED = "external-grep-retrieval-holdout-v1";
export const RETRIEVAL_HOLDOUT_SIZE = 400;
export const RETRIEVAL_HOLDOUT_RESERVE = 80;

export type PatchBucket = 0 | 1 | 2;

export interface EligibilityExclusion {
    instanceId: string;
    stage: string;
    reason: string;
}

/**
 * Loader-level eligibility: nonempty title, recoverable base commit,
 * production JS/TS gold present, and no exposure-blacklist overlap
 * (instance id, linked issue key, or D46 repo). Base-side presence is
 * verified separately by verifyAtBase (needs the bare clones).
 */
export function filterEligible(
    instances: BenchmarkInstance[],
    blacklist: ExposureBlacklist,
): { eligible: BenchmarkInstance[]; exclusions: EligibilityExclusion[] } {
    const eligible: BenchmarkInstance[] = [];
    const exclusions: EligibilityExclusion[] = [];
    const seen = new Set<string>();
    for (const inst of instances) {
        if (seen.has(inst.instanceId)) {
            exclusions.push({ instanceId: inst.instanceId, stage: "census", reason: "duplicate-instance-id" });
            continue;
        }
        seen.add(inst.instanceId);
        if (!inst.title.trim()) {
            exclusions.push({ instanceId: inst.instanceId, stage: "census", reason: "empty-title" });
            continue;
        }
        if (!inst.baseCommit.trim()) {
            exclusions.push({ instanceId: inst.instanceId, stage: "census", reason: "missing-base-commit" });
            continue;
        }
        if (inst.goldFiles.length === 0) {
            exclusions.push({ instanceId: inst.instanceId, stage: "census", reason: "no-production-gold" });
            continue;
        }
        const hit: BlacklistHit | null = blacklistHit(blacklist, {
            instanceId: inst.instanceId,
            repo: inst.repo,
        });
        if (hit !== null) {
            exclusions.push({ instanceId: inst.instanceId, stage: "census", reason: `blacklist:${hit}` });
            continue;
        }
        eligible.push(inst);
    }
    return { eligible, exclusions };
}

export interface CensusCounts {
    total: number;
    byRepo: Array<{ repo: string; count: number }>;
    byLanguage: Record<string, number>;
    byBucket: [number, number, number];
}

/** Counts of eligible instances by repo, language, and patch-size bucket. */
export function censusCounts(instances: BenchmarkInstance[]): CensusCounts {
    const repoCount = new Map<string, number>();
    const byLanguage: Record<string, number> = {};
    const byBucket: [number, number, number] = [0, 0, 0];
    for (const inst of instances) {
        repoCount.set(inst.repo, (repoCount.get(inst.repo) ?? 0) + 1);
        byLanguage[inst.language] = (byLanguage[inst.language] ?? 0) + 1;
        const bucket = patchSizeBucket(inst) as PatchBucket;
        byBucket[bucket] += 1;
    }
    return {
        total: instances.length,
        byRepo: [...repoCount.entries()]
            .map(([repo, count]) => ({ repo, count }))
            .sort((a, b) => b.count - a.count || (a.repo < b.repo ? -1 : 1)),
        byLanguage,
        byBucket,
    };
}

export interface BaseVerification {
    verified: BenchmarkInstance[];
    /** Gold missing at base (excluded, counted). */
    missingAtBase: Array<{ instanceId: string; missing: string[] }>;
    /** Clone absent or git could not answer (kept separate, not claimed). */
    unverifiable: Array<{ instanceId: string; reason: string }>;
}

const NO_FETCH_ENV = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.origin.url",
    GIT_CONFIG_VALUE_0: "file:///blocked-offline",
} as Record<string, string>;

/**
 * Read-only base verification against cached bare clones: every gold
 * file must be listed by `git ls-tree <base>`. The remote URL is
 * overridden to an invalid value so a missing object fails fast
 * instead of fetching (offline-safe). Never writes snapshots.
 */
export function verifyAtBase(
    instances: BenchmarkInstance[],
    gitRunner: (args: string[]) => string = defaultGitRunner,
    cloneExists: (repo: string) => boolean = (repo) => existsSync(join(bareRepoDir(repo), "HEAD")),
): BaseVerification {
    const verified: BenchmarkInstance[] = [];
    const missingAtBase: Array<{ instanceId: string; missing: string[] }> = [];
    const unverifiable: Array<{ instanceId: string; reason: string }> = [];
    for (const inst of instances) {
        if (!cloneExists(inst.repo)) {
            unverifiable.push({ instanceId: inst.instanceId, reason: `missing-bare-clone:${inst.repo}` });
            continue;
        }
        let output: string;
        try {
            output = gitRunner(["--git-dir", bareRepoDir(inst.repo), "ls-tree", inst.baseCommit, "--", ...inst.goldFiles]);
        } catch (error) {
            unverifiable.push({
                instanceId: inst.instanceId,
                reason: `git-error:${error instanceof Error ? error.message.slice(0, 100) : "unknown"}`,
            });
            continue;
        }
        const present = new Set<string>();
        for (const line of output.split("\n")) {
            const tab = line.indexOf("\t");
            if (tab >= 0) present.add(line.slice(tab + 1));
        }
        const missing = inst.goldFiles.filter((f) => !present.has(f));
        if (missing.length > 0) missingAtBase.push({ instanceId: inst.instanceId, missing });
        else verified.push(inst);
    }
    return { verified, missingAtBase, unverifiable };
}

function defaultGitRunner(args: string[]): string {
    return execFileSync("git", args, { encoding: "utf8", timeout: 60_000, env: NO_FETCH_ENV }) as string;
}

// ---------------------------------------------------------------------------
// Selection: seeded stratified ranking with a ranked reserve list.
// ---------------------------------------------------------------------------

export interface HoldoutSelection {
    selected: BenchmarkInstance[];
    /** Next-ranked instances, in order, for missing-at-base replacements. */
    reserve: BenchmarkInstance[];
}

/**
 * Stratified selection: deterministic repo round-robin with TS-first
 * and patch-bucket balancing (rankForSplit), then a prefix take. The
 * reserve is the next-ranked tail, so replacements preserve the
 * stratification order. Unlike the D15 dev/holdout split this is
 * instance-disjoint, not repo-disjoint (E15: same repos, new issues).
 */
export function selectRetrievalHoldout(
    eligible: BenchmarkInstance[],
    seed: string,
    size: number,
    reserveSize: number,
): HoldoutSelection {
    const repos = [...new Set(eligible.map((i) => i.repo))].sort();
    const ranked = rankForSplit(eligible, `${seed}:retrieval-holdout`, seededShuffle(repos, `${seed}:repo-order`));
    if (ranked.length < size) {
        throw new Error(`retrieval-holdout shortfall: eligible=${ranked.length} < size=${size}`);
    }
    return { selected: ranked.slice(0, size), reserve: ranked.slice(size, size + reserveSize) };
}

// ---------------------------------------------------------------------------
// Manifest: hashes of dataset bytes, query text, gold, and base commit.
// ---------------------------------------------------------------------------

export interface RetrievalHoldoutEntry {
    id: string;
    repo: string;
    baseCommit: string;
    dataset: string;
    language: string;
    goldFiles: string[];
    issueKey: string;
    /** sha256 over `title + "\n" + body` (the query text for both formulations). */
    querySha256: string;
    /** sha256 over canonical gold JSON (files + hunks; derived from the fix patch). */
    goldSha256: string;
}

export interface RetrievalHoldoutManifest {
    version: 3;
    seed: string;
    requestedSize: number;
    createdAt: string;
    datasets: Array<{ name: string; revision: string; license: string }>;
    blacklist: { instanceIds: number; issueKeys: number; repos: number; sourceFiles: string[] };
    entries: RetrievalHoldoutEntry[];
    reserve: RetrievalHoldoutEntry[];
    exclusions: EligibilityExclusion[];
    sha256: string;
}

export function sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Query-text binding: the exact bytes both formulations derive from. */
export function queryHash(instance: BenchmarkInstance): string {
    return sha256Hex(`${instance.title}\n${instance.body}`);
}

/** Gold binding: canonical gold JSON (gold derives from the fix patch). */
export function goldHash(instance: BenchmarkInstance): string {
    return sha256Hex(JSON.stringify({ files: [...instance.goldFiles].sort(), hunks: instance.goldHunks }));
}

function entryOf(instance: BenchmarkInstance): RetrievalHoldoutEntry {
    return {
        id: instance.instanceId,
        repo: instance.repo,
        baseCommit: instance.baseCommit,
        dataset: instance.dataset,
        language: instance.language,
        goldFiles: [...instance.goldFiles],
        issueKey: issueKeyOfInstanceId(instance.instanceId),
        querySha256: queryHash(instance),
        goldSha256: goldHash(instance),
    };
}

export function computeRetrievalHoldoutSha(manifest: Omit<RetrievalHoldoutManifest, "sha256">): string {
    return sha256Hex(JSON.stringify(manifest));
}

export function verifyRetrievalHoldoutManifest(manifest: RetrievalHoldoutManifest): boolean {
    const { sha256, ...rest } = manifest;
    void sha256;
    return computeRetrievalHoldoutSha(rest) === manifest.sha256;
}

export function buildRetrievalHoldoutManifest(args: {
    seed: string;
    requestedSize: number;
    datasets: Array<{ name: string; revision: string; license: string }>;
    blacklist: ExposureBlacklist;
    sourceFiles: string[];
    selected: BenchmarkInstance[];
    reserve: BenchmarkInstance[];
    exclusions: EligibilityExclusion[];
}): RetrievalHoldoutManifest {
    const body = {
        version: 3 as const,
        seed: args.seed,
        requestedSize: args.requestedSize,
        createdAt: new Date().toISOString(),
        datasets: args.datasets,
        blacklist: {
            instanceIds: args.blacklist.instanceIds.size,
            issueKeys: args.blacklist.issueKeys.size,
            repos: args.blacklist.repos.size,
            sourceFiles: [...args.sourceFiles].sort(),
        },
        entries: args.selected.map(entryOf).sort((a, b) => (a.id < b.id ? -1 : 1)),
        reserve: args.reserve.map(entryOf),
        exclusions: [...args.exclusions],
    };
    return { ...body, sha256: computeRetrievalHoldoutSha(body) };
}

/**
 * Write a NEW manifest only: throws when the path already exists
 * (never overwrites a sealed freeze). Mode 0600.
 */
export function writeNewManifest(manifest: RetrievalHoldoutManifest, path: string): string {
    if (existsSync(path)) throw new Error(`refusing to overwrite existing manifest: ${path}`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return path;
}

/**
 * Bind loaded instances to frozen entries: the runner resolves each
 * entry id to a loader instance and re-verifies the query/gold/base
 * bindings, so a silent dataset drift fails closed instead of
 * re-running on different bytes.
 */
export function bindToManifest(
    manifest: RetrievalHoldoutManifest,
    loaded: BenchmarkInstance[],
): BenchmarkInstance[] {
    if (!verifyRetrievalHoldoutManifest(manifest)) throw new Error("manifest integrity mismatch (sha256); refusing to run");
    const byId = new Map(loaded.map((i) => [i.instanceId, i]));
    return manifest.entries.map((entry) => {
        const inst = byId.get(entry.id);
        if (!inst) throw new Error(`frozen instance not in loaded pool: ${entry.id}`);
        if (inst.baseCommit !== entry.baseCommit) {
            throw new Error(`base-commit drift for ${entry.id}: manifest=${entry.baseCommit} loaded=${inst.baseCommit}`);
        }
        if (queryHash(inst) !== entry.querySha256) throw new Error(`query-text drift for ${entry.id}; refusing to run`);
        if (goldHash(inst) !== entry.goldSha256) throw new Error(`gold drift for ${entry.id}; refusing to run`);
        return inst;
    });
}

// ---------------------------------------------------------------------------
// Consumed-opening ledger: one opening per sealed manifest.
// ---------------------------------------------------------------------------

export interface HoldoutOpening {
    manifestSha256: string;
    manifestPath: string;
    openedAt: string;
    openedBy: string;
    purpose: string;
    arms: string[];
}

/**
 * Append a consumed opening to the ledger (0600, created when
 * missing). Throws when this manifest sha was already opened: the
 * holdout admits exactly one baseline-vs-champion opening.
 */
export function recordOpening(ledgerPath: string, opening: HoldoutOpening): HoldoutOpening[] {
    let ledger: HoldoutOpening[] = [];
    if (existsSync(ledgerPath)) {
        const parsed = JSON.parse(readFileSync(ledgerPath, "utf8")) as unknown;
        if (!Array.isArray(parsed)) throw new Error(`ledger corrupt (not an array): ${ledgerPath}`);
        ledger = parsed as HoldoutOpening[];
    }
    if (ledger.some((o) => o.manifestSha256 === opening.manifestSha256)) {
        throw new Error(`holdout already opened for manifest sha ${opening.manifestSha256}; refusing a second opening`);
    }
    const next = [...ledger, opening];
    mkdirSync(join(ledgerPath, ".."), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
}

// ---------------------------------------------------------------------------
// Power: minimum detectable effect + paired simulation.
// ---------------------------------------------------------------------------

/** Normal-approximation MDE for a paired rate: sqrt(7.84 * d / n). */
export function minDetectableEffect(n: number, discordance: number): number {
    return Math.sqrt(Math.pow(1.96 + 0.84, 2) * discordance / n);
}

export interface PairedPowerEstimate {
    effect: number;
    discordance: number;
    n: number;
    sims: number;
    power: number;
}

/**
 * Exact paired (McNemar) power via simulation: m ~ Binomial(n, d)
 * discordant pairs, champion wins among them ~ Binomial(m, p) with
 * p = (d + effect) / 2d; significant when the two-sided exact
 * binomial p-value < 0.05. Seeded and cheap (10k sims default).
 */
export function pairedPowerSimulation(
    n: number,
    effect: number,
    discordance: number,
    sims = 10_000,
    seed = "retrieval-holdout-power",
): PairedPowerEstimate {
    const rand = seededRandom(seed);
    const p = (discordance + effect) / (2 * discordance);
    const drawBinomial = (trials: number, prob: number): number => {
        let successes = 0;
        for (let t = 0; t < trials; t++) if (rand() < prob) successes += 1;
        return successes;
    };
    const exactTwoSidedP = (m: number, b: number): number => {
        const kObs = Math.min(b, m - b);
        const comb = (nn: number, kk: number): number => {
            if (kk < 0 || kk > nn) return 0;
            let c = 1;
            for (let i = 0; i < kk; i++) c = (c * (nn - i)) / (i + 1);
            return c;
        };
        let tail = 0;
        for (let k = 0; k <= kObs; k++) tail += comb(m, k);
        // Symmetric null: double the smaller tail, capped at 1.
        return Math.min(1, (tail / Math.pow(2, m)) * 2);
    };
    let significant = 0;
    for (let s = 0; s < sims; s++) {
        const m = drawBinomial(n, discordance);
        if (m === 0) continue;
        const b = drawBinomial(m, p);
        if (exactTwoSidedP(m, b) < 0.05) significant += 1;
    }
    return { effect, discordance, n, sims, power: significant / sims };
}

// ---------------------------------------------------------------------------
// CLI: census by default; --run-freeze performs the real freeze.
// ---------------------------------------------------------------------------

interface CliArgs {
    seed: string;
    offline: boolean;
    runFreeze: boolean;
    size: number;
    reserve: number;
    outName: string;
}

function parseArgs(argv: string[]): CliArgs {
    let seed = RETRIEVAL_HOLDOUT_SEED;
    let offline = false;
    let runFreeze = false;
    let size = RETRIEVAL_HOLDOUT_SIZE;
    let reserve = RETRIEVAL_HOLDOUT_RESERVE;
    let outName = "external-grep-retrieval-holdout.json";
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--seed") seed = argv[++i] ?? seed;
        else if (arg === "--offline") offline = true;
        else if (arg === "--run-freeze") runFreeze = true;
        else if (arg === "--size") size = Number(argv[++i] ?? size);
        else if (arg === "--reserve") reserve = Number(argv[++i] ?? reserve);
        else if (arg === "--out") outName = argv[++i] ?? outName;
        else if (arg === "--accept-license-review") continue;
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: freeze-instance-holdout.ts --accept-license-review [--seed SEED] [--offline] [--run-freeze --size N --reserve M --out NAME]");
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    assertMultiSweBenchLicense(argv);
    return { seed, offline, runFreeze, size, reserve, outName };
}

/** CLI entry point (census by default; --run-freeze seals). Import-safe: module top level has no side effects. */
export async function runCensusOrFreeze(argv: string[]): Promise<void> {
const args = parseArgs(argv);

const mlRows = await fetchAllRows({ offline: args.offline });
const mlRevision = datasetRevision(mlRows);
const mlConverted = rowsToInstances(mlRows);

const msbInstances: BenchmarkInstance[] = [];
const msbFileRevisions: Array<{ file: string; sha256: string; rows: number }> = [];
for (const file of MULTI_SWE_BENCH_FILES) {
    if (!args.offline) await ensureDatasetFileCached(file);
    const rows = await readCachedRows(file);
    const revision = await cachedFileRevision(file);
    msbFileRevisions.push({ file, sha256: revision, rows: rows.length });
    const converted = msbRowsToInstances(rows);
    msbInstances.push(...converted.instances);
}

const loaderExclusions: EligibilityExclusion[] = [
    ...mlConverted.skipped.map((s) => ({ instanceId: s.instanceId, stage: "loader:swe-bench-multilingual", reason: s.reason })),
];
const all: BenchmarkInstance[] = [...mlConverted.instances];
const mlIds = new Set(mlConverted.instances.map((i) => i.instanceId));
for (const inst of msbInstances) {
    if (mlIds.has(inst.instanceId)) {
        loaderExclusions.push({ instanceId: inst.instanceId, stage: "loader:multi-swe-bench", reason: "duplicate-across-datasets" });
        continue;
    }
    all.push(inst);
}

const manifests = collectManifestIds([manifestsDir()]);
const fixtureManifests = collectManifestIds([join(process.cwd(), "test/fixtures/eval")]);
const reports = collectReportIds(join(homedir(), ".cache/pi-smartread-bench/reports"));
const d46Repos = loadD46Repos(join(homedir(), ".cache/pi-smartread-bench/d46/repos.json"));
const blacklist = buildExposureBlacklist({
    instanceIds: [...manifests.ids, ...fixtureManifests.ids, ...reports.ids],
    issueKeys: [],
    repos: d46Repos,
    patchHashes: [],
});
const sourceFiles = [...new Set([...manifests.files, ...fixtureManifests.files, ...reports.files])];

const { eligible, exclusions } = filterEligible(all, blacklist);
const base = verifyAtBase(eligible);
const census = censusCounts(base.verified);

console.log(`pool: loaded=${all.length} loader-excluded=${loaderExclusions.length}`);
console.log(`blacklist: ids=${blacklist.instanceIds.size} issueKeys=${blacklist.issueKeys.size} repos=${blacklist.repos.size} d46=${d46Repos.length}`);
console.log(`blacklist sources: ${manifests.files.length} manifests, ${reports.files.length} reports`);
console.log(`eligible-after-blacklist=${eligible.length} excluded=${exclusions.length}`);
for (const e of exclusions) console.log(`  excluded: ${e.instanceId} ${e.reason}`);
console.log(`at-base: verified=${base.verified.length} missing=${base.missingAtBase.length} unverifiable=${base.unverifiable.length}`);
for (const m of base.missingAtBase) console.log(`  missing-at-base: ${m.instanceId} ${m.missing.join(",")}`);
for (const u of base.unverifiable) console.log(`  unverifiable: ${u.instanceId} ${u.reason}`);
console.log(`census: total=${census.total}`);
for (const r of census.byRepo) console.log(`  repo ${r.repo}: ${r.count}`);
console.log(`  byLanguage: ${JSON.stringify(census.byLanguage)}`);
console.log(`  byBucket(small/medium/large): ${census.byBucket.join("/")}`);
for (const d of [0.078, 0.219, 0.313]) {
    console.log(`  MDE(n=${census.total}, d=${d}): ${(minDetectableEffect(Math.max(census.total, 1), d) * 100).toFixed(1)}pp`);
}

if (args.runFreeze) {
    const selection = selectRetrievalHoldout(base.verified, args.seed, args.size, args.reserve);
    const manifest = buildRetrievalHoldoutManifest({
        seed: args.seed,
        requestedSize: args.size,
        datasets: [
            { name: "SWE-bench/SWE-bench_Multilingual", revision: mlRevision, license: SWE_BENCH_MULTILINGUAL_LICENSE },
            {
                name: "ByteDance-Seed/Multi-SWE-bench",
                revision: msbFileRevisions.map((f) => `${f.file.split("/").pop()}:${f.sha256.slice(0, 16)}:rows=${f.rows}`).join(","),
                license: MULTI_SWE_BENCH_LICENSE_NOTE,
            },
        ],
        blacklist,
        sourceFiles,
        selected: selection.selected,
        reserve: selection.reserve,
        exclusions: [...loaderExclusions, ...exclusions],
    });
    if (!verifyRetrievalHoldoutManifest(manifest)) throw new Error("manifest integrity self-check failed");
    const path = writeNewManifest(manifest, join(manifestsDir(), args.outName));
    console.log(`manifest: ${path}`);
    console.log(`sha256: ${manifest.sha256}`);
    console.log(`selected=${selection.selected.length} reserve=${selection.reserve.length}`);
} else {
    console.log(`census only (no freeze). Re-run with --run-freeze to seal the holdout.`);
}
}

const invokedAsScript = (process.argv[1] ?? "").endsWith("freeze-instance-holdout.ts");
if (invokedAsScript) {
    await runCensusOrFreeze(process.argv.slice(2));
}
