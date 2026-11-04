/**
 * Deterministic seeded sampling for the external grep benchmark (D15).
 *
 * 12-case pilot (diverse repos, TS preferred, varied patch size), then a
 * frozen manifest for dev/holdout with repo-disjoint holdout. The manifest
 * records seed, ids, dataset revision, and its own sha256.
 *
 * With only ~43 JS/TS Multilingual instances available now, the freeze
 * writes the pilot plus a provisional dev split and leaves holdout empty
 * until the Multi-SWE-bench license clears; the manifest says so.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BenchmarkInstance, InstanceLanguage } from "./instance.js";

export const PILOT_SIZE = 12;

export interface FrozenManifest {
    version: 1;
    seed: string;
    dataset: string;
    datasetRevision: string;
    createdAt: string;
    pilot: string[];
    dev: string[];
    holdout: string[];
    note: string;
    sha256: string;
}

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function seededRandom(seed: string): () => number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    let state = h >>> 0;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Deterministic shuffle; same input+seed always yields the same order. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
    const rand = seededRandom(seed);
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
}

/** Patch-size bucket shared by the D15 split and the E15 retrieval holdout: 0 = single-file single-hunk, 1 = small multi-file/hunk, 2 = large. */
export function patchSizeBucket(instance: BenchmarkInstance): number {
    const hunks = instance.goldHunks.reduce((a, h) => a + h.ranges.length, 0);
    if (hunks <= 1 && instance.goldFiles.length === 1) return 0;
    if (instance.goldFiles.length <= 2 && hunks <= 4) return 1;
    return 2;
}

/**
 * Select the pilot: round-robin across repos (seeded repo order) for
 * diversity, TS instances first within a repo, then least-covered
 * patch-size bucket, then seeded order. Pure and deterministic.
 */
export function selectPilot(instances: BenchmarkInstance[], seed: string, size = PILOT_SIZE): BenchmarkInstance[] {
    const byRepo = new Map<string, BenchmarkInstance[]>();
    for (const inst of [...instances].sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1))) {
        const group = byRepo.get(inst.repo) ?? [];
        group.push(inst);
        byRepo.set(inst.repo, group);
    }
    const repos = seededShuffle([...byRepo.keys()].sort(), `${seed}:repos`);
    const orderKey = new Map<string, number>();
    seededShuffle(instances.map((i) => i.instanceId).sort(), `${seed}:order`).forEach((id, idx) =>
        orderKey.set(id, idx),
    );
    for (const group of byRepo.values()) {
        group.sort((a, b) => {
            const lang = langRank(a.language) - langRank(b.language);
            if (lang !== 0) return lang;
            return (orderKey.get(a.instanceId) ?? 0) - (orderKey.get(b.instanceId) ?? 0);
        });
    }
    const picked: BenchmarkInstance[] = [];
    const bucketCount = [0, 0, 0];
    let progress = true;
    while (picked.length < Math.min(size, instances.length) && progress) {
        progress = false;
        for (const repo of repos) {
            if (picked.length >= size) break;
            const group = byRepo.get(repo) ?? [];
            // Prefer the candidate whose size bucket is least covered so far.
            let best = -1;
            let bestScore = Number.POSITIVE_INFINITY;
            for (let i = 0; i < group.length; i++) {
                const cand = group[i] as BenchmarkInstance;
                if (picked.includes(cand)) continue;
                const score = (bucketCount[patchSizeBucket(cand)] as number) * 100 + (orderKey.get(cand.instanceId) ?? 0);
                if (score < bestScore) {
                    bestScore = score;
                    best = i;
                }
            }
            if (best >= 0) {
                const chosen = group[best] as BenchmarkInstance;
                picked.push(chosen);
                bucketCount[patchSizeBucket(chosen)] = ((bucketCount[patchSizeBucket(chosen)] as number) ?? 0) + 1;
                progress = true;
            }
        }
    }
    return picked;
}

/**
 * Freeze pilot + provisional dev; holdout stays empty until the
 * Multi-SWE-bench license clears (repo-disjoint holdout needs the larger
 * pool). Provisional dev = all non-pilot instances.
 */
export function freezeManifest(
    instances: BenchmarkInstance[],
    pilot: BenchmarkInstance[],
    seed: string,
    datasetRevision: string,
    dataset = "swe-bench-multilingual",
): FrozenManifest {
    const pilotIds = new Set(pilot.map((p) => p.instanceId));
    const dev = instances.map((i) => i.instanceId).filter((id) => !pilotIds.has(id)).sort();
    const body = {
        version: 1 as const,
        seed,
        dataset,
        datasetRevision,
        createdAt: new Date().toISOString(),
        pilot: pilot.map((p) => p.instanceId).sort(),
        dev,
        holdout: [] as string[],
        note: "provisional: holdout empty until Multi-SWE-bench license clears (D12); dev is all non-pilot JS/TS Multilingual instances",
    };
    const sha256 = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    return { ...body, sha256 };
}

export function manifestsDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/manifests");
}

/** Write the frozen manifest (mode 0600); returns the path. */
export function writeManifest(manifest: FrozenManifest, name = "external-grep-freeze.json"): string {
    const dir = manifestsDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return path;
}

// ---------------------------------------------------------------------------
// Expanded dev/holdout freeze (D15): 64 dev + 32 holdout, frozen before any
// variant results exist. Holdout repos are disjoint from dev repos and,
// where possible, from the pilot repos (documented in `holdoutRepoNote`).
// ---------------------------------------------------------------------------

export interface DevHoldoutEntry {
    id: string;
    repo: string;
    baseCommit: string;
    dataset: string;
    language: InstanceLanguage;
    goldFiles: string[];
}

export interface DevHoldoutDataset {
    name: string;
    revision: string;
    license: string;
}

export interface DevHoldoutManifest {
    version: 2;
    seed: string;
    createdAt: string;
    datasets: DevHoldoutDataset[];
    /** Pilot ids (separate split; never rerun as dev/holdout). */
    pilot: string[];
    dev: DevHoldoutEntry[];
    holdout: DevHoldoutEntry[];
    exclusions: Array<{ instanceId: string; stage: string; reason: string }>;
    holdoutRepoNote: string;
    /** Present when the TS floor was relaxed: actual shares and the reason. */
    tsShareNote?: string;
    sha256: string;
}

export interface DevHoldoutOptions {
    devSize: number;
    holdoutSize: number;
    devCapPerRepo: number;
    holdoutCapPerRepo: number;
    /** Minimum TS fraction per split (0-1). */
    minTsFraction: number;
}

export const DEV_HOLDOUT_DEFAULTS: DevHoldoutOptions = {
    devSize: 64,
    holdoutSize: 32,
    // Pool geometry forces caps above the D12-era sketch (<=6/<=4): only a
    // few repos have depth. Dev takes the deep repos up to 20 (headroom for
    // missing-at-base replacements) while the holdout spreads 32 across
    // six repos at up to 9. Both caps are enforced and recorded; raise pool
    // diversity before tightening them.
    devCapPerRepo: 20,
    holdoutCapPerRepo: 9,
    minTsFraction: 0.4,
};

function entryOf(instance: BenchmarkInstance): DevHoldoutEntry {
    return {
        id: instance.instanceId,
        repo: instance.repo,
        baseCommit: instance.baseCommit,
        dataset: instance.dataset,
        language: instance.language,
        goldFiles: [...instance.goldFiles],
    };
}

/**
 * Rank candidates deterministically: seeded repo round-robin, TS first
 * within a repo, then least-covered patch-size bucket, then seeded order.
 * Returns the ordered list (callers take prefixes per repo cap).
 */
export function rankForSplit(
    instances: BenchmarkInstance[],
    seed: string,
    reposInOrder: string[],
): BenchmarkInstance[] {
    const byRepo = new Map<string, BenchmarkInstance[]>();
    for (const inst of instances) {
        const group = byRepo.get(inst.repo) ?? [];
        group.push(inst);
        byRepo.set(inst.repo, group);
    }
    const orderKey = new Map<string, number>();
    seededShuffle(
        instances.map((i) => i.instanceId).sort(),
        `${seed}:order`,
    ).forEach((id, idx) => orderKey.set(id, idx));
    for (const group of byRepo.values()) {
        group.sort((a, b) => {
            const lang = langRank(a.language) - langRank(b.language);
            if (lang !== 0) return lang;
            return (orderKey.get(a.instanceId) ?? 0) - (orderKey.get(b.instanceId) ?? 0);
        });
    }
    const picked: BenchmarkInstance[] = [];
    const bucketCount = [0, 0, 0];
    let progress = true;
    while (picked.length < instances.length && progress) {
        progress = false;
        for (const repo of reposInOrder) {
            const group = byRepo.get(repo) ?? [];
            let best = -1;
            let bestScore = Number.POSITIVE_INFINITY;
            for (let i = 0; i < group.length; i++) {
                const cand = group[i] as BenchmarkInstance;
                if (picked.includes(cand)) continue;
                const score = (bucketCount[patchSizeBucket(cand)] as number) * 100 + (orderKey.get(cand.instanceId) ?? 0);
                if (score < bestScore) {
                    bestScore = score;
                    best = i;
                }
            }
            if (best >= 0) {
                const chosen = group[best] as BenchmarkInstance;
                picked.push(chosen);
                bucketCount[patchSizeBucket(chosen)] = ((bucketCount[patchSizeBucket(chosen)] as number) ?? 0) + 1;
                progress = true;
            }
        }
    }
    return picked;
}

function takeWithCap(
    ranked: BenchmarkInstance[],
    size: number,
    capPerRepo: number,
): BenchmarkInstance[] {
    const perRepo = new Map<string, number>();
    const out: BenchmarkInstance[] = [];
    for (const inst of ranked) {
        if (out.length >= size) break;
        const used = perRepo.get(inst.repo) ?? 0;
        if (used >= capPerRepo) continue;
        perRepo.set(inst.repo, used + 1);
        out.push(inst);
    }
    return out;
}

/** Rank languages for TS-preferred selection: ts first, then mixed, then js. */
function langRank(language: InstanceLanguage): number {
    return language === "ts" ? 0 : language === "mixed" ? 1 : 2;
}

function tsFraction(instances: BenchmarkInstance[]): number {
    if (instances.length === 0) return 0;
    return instances.filter((i) => i.language === "ts").length / instances.length;
}

/**
 * Pick holdout repos: non-pilot repos first (pilot stays a separate
 * split), ascending by eligible count so the deep repos remain for dev
 * depth under the per-repo cap; ties break by seeded shuffle for
 * determinism. Pilot repos are used only when non-pilot capacity cannot
 * cover holdoutSize (reported, not silent).
 */
export function pickHoldoutRepos(
    pool: BenchmarkInstance[],
    pilotRepos: Set<string>,
    seed: string,
    holdoutSize: number,
    holdoutCapPerRepo: number,
): { repos: string[]; spillover: string[] } {
    const byRepoCount = new Map<string, number>();
    for (const inst of pool) byRepoCount.set(inst.repo, (byRepoCount.get(inst.repo) ?? 0) + 1);
    const poolRepos = [...byRepoCount.keys()];
    const tiebreak = new Map<string, number>();
    seededShuffle(poolRepos, `${seed}:holdout-repos`).forEach((r, idx) => tiebreak.set(r, idx));
    const byCountAsc = [...poolRepos].sort(
        (a, b) => (byRepoCount.get(a) ?? 0) - (byRepoCount.get(b) ?? 0) || (tiebreak.get(a) ?? 0) - (tiebreak.get(b) ?? 0),
    );
    const ordered = [
        ...byCountAsc.filter((r) => !pilotRepos.has(r)),
        ...byCountAsc.filter((r) => pilotRepos.has(r)),
    ];
    const repos: string[] = [];
    let capacity = 0;
    for (const repo of ordered) {
        if (capacity >= holdoutSize) break;
        repos.push(repo);
        capacity += Math.min(byRepoCount.get(repo) ?? 0, holdoutCapPerRepo);
    }
    if (capacity < holdoutSize) {
        throw new Error(
            `holdout infeasible: capacity ${capacity} < ${holdoutSize} ` +
                `(repos=${poolRepos.length}, cap=${holdoutCapPerRepo})`,
        );
    }
    return { repos, spillover: repos.filter((r) => pilotRepos.has(r)) };
}
/**
 * Select dev + holdout from eligible (non-pilot, non-empty-gold)
 * instances. Holdout repos come from pickHoldoutRepos (non-pilot first);
 * dev takes the remaining repos. Throws when the pool cannot satisfy the
 * sizes, caps, or TS floor so the freeze fails loudly instead of
 * silently weakening.
 */
export function selectDevHoldout(
    eligible: BenchmarkInstance[],
    pilotIds: Set<string> | string[],
    seed: string,
    options: Partial<DevHoldoutOptions> = {},
): { dev: BenchmarkInstance[]; holdout: BenchmarkInstance[]; holdoutRepoNote: string } {
    const opts = { ...DEV_HOLDOUT_DEFAULTS, ...options };
    const pilot = pilotIds instanceof Set ? pilotIds : new Set(pilotIds);
    const pool = eligible.filter((i) => !pilot.has(i.instanceId));
    const ids = new Set(pool.map((i) => i.instanceId));
    if (ids.size !== pool.length) throw new Error("duplicate instance ids in eligible pool");
    const pilotRepos = new Set(eligible.filter((i) => pilot.has(i.instanceId)).map((i) => i.repo));
    const { repos: holdoutRepos, spillover } = pickHoldoutRepos(
        pool,
        pilotRepos,
        seed,
        opts.holdoutSize,
        opts.holdoutCapPerRepo,
    );
    const holdoutRepoSet = new Set(holdoutRepos);
    const holdoutRepoNote =
        spillover.length === 0
            ? `holdout repos disjoint from dev and pilot repos (${holdoutRepos.length} repos)`
            : `holdout repos disjoint from dev; pilot-repo spillover (capacity): ${spillover.join(", ")}`;
    const holdoutRanked = rankForSplit(
        pool.filter((i) => holdoutRepoSet.has(i.repo)),
        `${seed}:holdout`,
        seededShuffle(holdoutRepos, `${seed}:holdout-order`),
    );
    const holdout = takeWithCap(holdoutRanked, opts.holdoutSize, opts.holdoutCapPerRepo);
    const devRanked = rankForSplit(
        pool.filter((i) => !holdoutRepoSet.has(i.repo)),
        `${seed}:dev`,
        seededShuffle(
            [...new Set(pool.map((i) => i.repo))].filter((r) => !holdoutRepoSet.has(r)),
            `${seed}:dev-order`,
        ),
    );
    const dev = takeWithCap(devRanked, opts.devSize, opts.devCapPerRepo);
    if (holdout.length < opts.holdoutSize) {
        throw new Error(`holdout shortfall: ${holdout.length} < ${opts.holdoutSize} (cap=${opts.holdoutCapPerRepo})`);
    }
    if (dev.length < opts.devSize) {
        throw new Error(
            `dev shortfall: ${dev.length} < ${opts.devSize} (cap=${opts.devCapPerRepo}, ranked=${devRanked.length})`,
        );
    }
    if (tsFraction(holdout) < opts.minTsFraction || tsFraction(dev) < opts.minTsFraction) {
        throw new Error(
            `TS floor missed: holdout=${tsFraction(holdout).toFixed(2)} dev=${tsFraction(dev).toFixed(2)} ` +
                `(min=${opts.minTsFraction})`,
        );
    }
    return { dev, holdout, holdoutRepoNote };
}

function devHoldoutBody(manifest: Omit<DevHoldoutManifest, "sha256">): string {
    return JSON.stringify(manifest);
}

/** sha256 binding for a dev/holdout manifest (everything except `sha256`). */
export function computeDevHoldoutSha(manifest: Omit<DevHoldoutManifest, "sha256">): string {
    const { sha256: _ignored, ...rest } = manifest as DevHoldoutManifest & { sha256?: string };
    void _ignored;
    return createHash("sha256").update(devHoldoutBody(rest)).digest("hex");
}

/** True when the manifest matches its embedded sha256 (detects any edit). */
export function verifyDevHoldoutManifest(manifest: DevHoldoutManifest): boolean {
    const { sha256, ...rest } = manifest;
    void sha256;
    return computeDevHoldoutSha(rest as Omit<DevHoldoutManifest, "sha256">) === manifest.sha256;
}

/** Assemble a dev/holdout manifest (without writing); caller materializes. */
export function buildDevHoldoutManifest(args: {
    seed: string;
    datasets: DevHoldoutDataset[];
    pilot: BenchmarkInstance[];
    dev: BenchmarkInstance[];
    holdout: BenchmarkInstance[];
    exclusions: Array<{ instanceId: string; stage: string; reason: string }>;
    holdoutRepoNote: string;
    tsShareNote?: string;
}): DevHoldoutManifest {
    const body = {
        version: 2 as const,
        seed: args.seed,
        createdAt: new Date().toISOString(),
        datasets: args.datasets,
        pilot: args.pilot.map((p) => p.instanceId).sort(),
        dev: args.dev.map(entryOf).sort((a, b) => (a.id < b.id ? -1 : 1)),
        holdout: args.holdout.map(entryOf).sort((a, b) => (a.id < b.id ? -1 : 1)),
        exclusions: [...args.exclusions],
        holdoutRepoNote: args.holdoutRepoNote,
        ...(args.tsShareNote === undefined ? {} : { tsShareNote: args.tsShareNote }),
    };
    return { ...body, sha256: computeDevHoldoutSha(body) };
}

/** Write a dev/holdout manifest (mode 0600); returns the path. */
export function writeDevHoldoutManifest(
    manifest: DevHoldoutManifest,
    name = "external-grep-dev64-holdout32.json",
): string {
    const dir = manifestsDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return path;
}
