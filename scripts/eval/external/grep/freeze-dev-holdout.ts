#!/usr/bin/env node
/**
 * Freeze the expanded external-grep manifest (D15): 64 dev + 32 holdout.
 *
 * Usage:
 *   npx tsx scripts/eval/external/grep/freeze-dev-holdout.ts --accept-license-review [--seed SEED] [--offline]
 *
 * Loads SWE-bench Multilingual JS/TS rows plus Multi-SWE-bench js/ts rows,
 * drops the 12 pilot ids, selects dev/holdout with per-repo caps, then
 * materializes bare partial clones + per-instance base snapshots for all 96
 * (gold files must exist at base; missing-at-base instances are excluded and
 * replaced from the same ranked pool, with counts recorded). Writes the
 * frozen manifest (mode 0600) to
 * ~/.cache/pi-smartread-bench/manifests/external-grep-dev64-holdout32.json.
 *
 * Runs NO grep engine and NO comparator on dev or holdout: the freeze must
 * land before any variant results exist.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { ensureBareClone, materializeInstance } from "./repos.js";
import {
    DEV_HOLDOUT_DEFAULTS,
    buildDevHoldoutManifest,
    manifestsDir,
    rankForSplit,
    seededShuffle,
    selectDevHoldout,
    verifyDevHoldoutManifest,
    writeDevHoldoutManifest,
    type DevHoldoutDataset,
} from "./sampling.js";
import {
    SWE_BENCH_MULTILINGUAL_LICENSE,
    datasetRevision,
    fetchAllRows,
    rowsToInstances,
} from "./swebench-multilingual.js";

const FREEZE_SEED = "external-grep-dev64-holdout32-v1";

function parseArgs(argv: string[]): { seed: string; offline: boolean } {
    let seed = FREEZE_SEED;
    let offline = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--seed") seed = argv[++i] ?? seed;
        else if (arg === "--offline") offline = true;
        else if (arg === "--accept-license-review") continue;
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: freeze-dev-holdout.ts --accept-license-review [--seed SEED] [--offline]");
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    assertMultiSweBenchLicense(argv);
    return { seed, offline };
}

const args = parseArgs(process.argv.slice(2));

const mlRows = await fetchAllRows();
const mlRevision = datasetRevision(mlRows);
const mlConverted = rowsToInstances(mlRows);
const loaderExclusions: Array<{ instanceId: string; stage: string; reason: string }> = [
    ...mlConverted.skipped.map((s) => ({ ...s, stage: "loader:swe-bench-multilingual" })),
];

const msbInstances: BenchmarkInstance[] = [];
const msbFileRevisions: Array<{ file: string; sha256: string; rows: number }> = [];
for (const file of MULTI_SWE_BENCH_FILES) {
    if (!args.offline) await ensureDatasetFileCached(file);
    const rows = await readCachedRows(file);
    const revision = await cachedFileRevision(file);
    msbFileRevisions.push({ file, sha256: revision, rows: rows.length });
    const converted = msbRowsToInstances(rows);
    msbInstances.push(...converted.instances);
    loaderExclusions.push(...converted.skipped.map((s) => ({ ...s, stage: `loader:multi-swe-bench:${file}` })));
}

const all: BenchmarkInstance[] = [...mlConverted.instances];
const mlIds = new Set(mlConverted.instances.map((i) => i.instanceId));
for (const inst of msbInstances) {
    if (mlIds.has(inst.instanceId)) {
        const mlBase = mlConverted.instances.find((i) => i.instanceId === inst.instanceId)?.baseCommit;
        loaderExclusions.push({
            instanceId: inst.instanceId,
            stage: "loader:multi-swe-bench",
            reason: `duplicate-across-datasets:kept-swe-bench-multilingual(msb-base=${inst.baseCommit},ml-base=${mlBase})`,
        });
        continue;
    }
    all.push(inst);
}
const seen = new Set<string>();
for (const inst of all) {
    if (seen.has(inst.instanceId)) throw new Error(`duplicate instance id across datasets: ${inst.instanceId}`);
    seen.add(inst.instanceId);
}

// Pilot ids: the frozen 12-pilot manifest (pilot stays a separate split).
const pilotManifestPath = join(manifestsDir(), "external-grep-freeze.json");
if (!existsSync(pilotManifestPath)) throw new Error(`pilot manifest missing: ${pilotManifestPath}`);
const pilotIds = new Set<string>(
    (JSON.parse(readFileSync(pilotManifestPath, "utf8")) as { pilot: string[] }).pilot,
);
if (pilotIds.size !== 12) throw new Error(`expected 12 pilot ids, got ${pilotIds.size}`);

// Feasibility gate: throws when the pool cannot satisfy sizes, caps, or
// the TS floor. Repo sets come from the gated selection; acceptance below
// walks each split's full ranking so missing-at-base instances are replaced
// by the next-ranked instance of the same split (deterministic given the
// same caches).
const devPool = all.filter((i) => !pilotIds.has(i.instanceId) && i.goldFiles.length > 0);
// Pass the full pool (including pilot instances) so pilot repos are known;
// selectDevHoldout excludes pilot ids from both splits internally.
// The 40% TS floor is infeasible for the JS-dominated pool (see tsShareNote
// below): on a floor miss, fall back to the TS-preferred ranking with no
// floor, which greedily maximizes the TS share under the same caps, and
// record the actual share plus the reason in the manifest.
let selection: ReturnType<typeof selectDevHoldout>;
let tsShareNote: string | undefined;
try {
    selection = selectDevHoldout(
        all.filter((i) => i.goldFiles.length > 0),
        pilotIds,
        args.seed,
        DEV_HOLDOUT_DEFAULTS,
    );
} catch (error) {
    if (!(error instanceof Error) || !error.message.includes("TS floor missed")) throw error;
    selection = selectDevHoldout(all.filter((i) => i.goldFiles.length > 0), pilotIds, args.seed, {
        ...DEV_HOLDOUT_DEFAULTS,
        minTsFraction: 0,
    });
    const devTs = selection.dev.filter((i) => i.language === "ts").length;
    const holdoutTs = selection.holdout.filter((i) => i.language === "ts").length;
    tsShareNote =
        `TS floor ${DEV_HOLDOUT_DEFAULTS.minTsFraction} infeasible for this pool ` +
        `(gold classified by file extension: dev ts=${devTs}/${selection.dev.length}, ` +
        `holdout ts=${holdoutTs}/${selection.holdout.length}); ` +
        `kept the maximum TS-preferred selection under the same repo caps. ` +
        `Supersedes manifest sha c884064c, whose TS labels came from the buggy patch-sniffing detector.`;
    console.log(tsShareNote);
}
const holdoutRepoNote = selection.holdoutRepoNote;
const holdoutRepoSet = new Set(selection.holdout.map((i) => i.repo));
const devRepos = [...new Set(devPool.map((i) => i.repo))].filter((r) => !holdoutRepoSet.has(r)).sort();
console.log(`holdout repos: ${JSON.stringify([...holdoutRepoSet].sort())}`);
console.log(`dev repos: ${JSON.stringify(devRepos)}`);
console.log(`holdout note: ${holdoutRepoNote}`);

function rankedFor(
    pool: BenchmarkInstance[],
    seedSuffix: string,
    repos: string[],
): BenchmarkInstance[] {
    return rankForSplit(pool, `${args.seed}:${seedSuffix}`, seededShuffle(repos, `${args.seed}:${seedSuffix}-order`));
}

const materializeExclusions: Array<{ instanceId: string; stage: string; reason: string }> = [];
const acceptedDev: BenchmarkInstance[] = [];
const acceptedHoldout: BenchmarkInstance[] = [];

const devRanked = rankedFor(
    devPool.filter((i) => !holdoutRepoSet.has(i.repo)),
    "dev",
    devRepos.filter((r) => !holdoutRepoSet.has(r)),
);
const holdoutRanked = rankedFor(
    devPool.filter((i) => holdoutRepoSet.has(i.repo)),
    "holdout",
    [...holdoutRepoSet].sort(),
);

function acceptRanked(
    ranked: BenchmarkInstance[],
    size: number,
    capPerRepo: number,
    accepted: BenchmarkInstance[],
    wantSplit: "dev" | "holdout",
): void {
    const perRepo = new Map<string, number>();
    for (const inst of ranked) {
        if (accepted.length >= size) break;
        const used = perRepo.get(inst.repo) ?? 0;
        if (used >= capPerRepo) continue;
        try {
            ensureBareClone(inst.repo);
            const mat = materializeInstance(inst);
            if ("excluded" in mat) {
                materializeExclusions.push({
                    instanceId: inst.instanceId,
                    stage: "materialize",
                    reason: `missing-at-base:${mat.missing.join(",")}`,
                });
                process.stdout.write(`excluded ${wantSplit}: ${inst.instanceId} missing-at-base\n`);
                continue;
            }
        } catch (error) {
            materializeExclusions.push({
                instanceId: inst.instanceId,
                stage: "materialize",
                reason: `materialize-error:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
            });
            continue;
        }
        perRepo.set(inst.repo, used + 1);
        accepted.push(inst);
        process.stdout.write(`accepted ${wantSplit} ${accepted.length}: ${inst.instanceId}\n`);
    }
}

acceptRanked(devRanked, DEV_HOLDOUT_DEFAULTS.devSize, DEV_HOLDOUT_DEFAULTS.devCapPerRepo, acceptedDev, "dev");
acceptRanked(
    holdoutRanked,
    DEV_HOLDOUT_DEFAULTS.holdoutSize,
    DEV_HOLDOUT_DEFAULTS.holdoutCapPerRepo,
    acceptedHoldout,
    "holdout",
);
if (acceptedDev.length < DEV_HOLDOUT_DEFAULTS.devSize || acceptedHoldout.length < DEV_HOLDOUT_DEFAULTS.holdoutSize) {
    throw new Error(
        `materialization shortfall: dev=${acceptedDev.length}/${DEV_HOLDOUT_DEFAULTS.devSize} ` +
            `holdout=${acceptedHoldout.length}/${DEV_HOLDOUT_DEFAULTS.holdoutSize}`,
    );
}

const datasets: DevHoldoutDataset[] = [
    { name: "SWE-bench/SWE-bench_Multilingual", revision: mlRevision, license: SWE_BENCH_MULTILINGUAL_LICENSE },
    {
        name: "ByteDance-Seed/Multi-SWE-bench",
        revision: msbFileRevisions.map((f) => `${f.file.split("/").pop()}:${f.sha256.slice(0, 16)}:rows=${f.rows}`).join(","),
        license: MULTI_SWE_BENCH_LICENSE_NOTE,
    },
];

const acceptedDevTs = acceptedDev.filter((i) => i.language === "ts").length;
const acceptedHoldoutTs = acceptedHoldout.filter((i) => i.language === "ts").length;
if (tsShareNote === undefined) {
    tsShareNote =
        `TS floor ${DEV_HOLDOUT_DEFAULTS.minTsFraction} met ` +
        `(dev ts=${acceptedDevTs}/${acceptedDev.length}, ` +
        `holdout ts=${acceptedHoldoutTs}/${acceptedHoldout.length}). ` +
        `Supersedes manifest sha c884064c (buggy patch-sniffing language detector).`;
} else {
    tsShareNote +=
        ` Materialized: dev ts=${acceptedDevTs}/${acceptedDev.length}, ` +
        `holdout ts=${acceptedHoldoutTs}/${acceptedHoldout.length}.`;
}

const manifest = buildDevHoldoutManifest({
    seed: args.seed,
    datasets,
    pilot: all.filter((i) => pilotIds.has(i.instanceId)),
    dev: acceptedDev,
    holdout: acceptedHoldout,
    exclusions: [...loaderExclusions, ...materializeExclusions],
    holdoutRepoNote,
    tsShareNote,
});
if (!verifyDevHoldoutManifest(manifest)) throw new Error("manifest integrity self-check failed");
const manifestPath = writeDevHoldoutManifest(manifest);

const du = execSync(`du -sh ${join(homedir(), ".cache/pi-smartread-bench/repos")} ` +
    ` ${join(homedir(), ".cache/pi-smartread-bench/snapshots")} ` +
    ` ${join(homedir(), ".cache/pi-smartread-bench/datasets")}`, { encoding: "utf8" }).trim();

const perRepoDev = new Map<string, number>();
for (const i of acceptedDev) perRepoDev.set(i.repo, (perRepoDev.get(i.repo) ?? 0) + 1);
const perRepoHoldout = new Map<string, number>();
for (const i of acceptedHoldout) perRepoHoldout.set(i.repo, (perRepoHoldout.get(i.repo) ?? 0) + 1);
const tsDev = acceptedDev.filter((i) => i.language === "ts").length;
const tsHoldout = acceptedHoldout.filter((i) => i.language === "ts").length;
console.log(`manifest: ${manifestPath}`);
console.log(`sha256: ${manifest.sha256}`);
console.log(`dev=${acceptedDev.length} (ts=${tsDev}) holdout=${acceptedHoldout.length} (ts=${tsHoldout})`);
console.log(`dev per-repo: ${JSON.stringify([...perRepoDev].sort())}`);
console.log(`holdout per-repo: ${JSON.stringify([...perRepoHoldout].sort())}`);
console.log(`excluded: loader=${loaderExclusions.length} materialize=${materializeExclusions.length}`);
console.log(`disk:\n${du}`);
console.log(`holdout note: ${holdoutRepoNote}`);