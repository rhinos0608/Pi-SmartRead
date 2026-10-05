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
import type { BenchmarkInstance } from "./instance.js";

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

function patchSizeBucket(instance: BenchmarkInstance): number {
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
            const lang = (a.language === "ts" ? 0 : 1) - (b.language === "ts" ? 0 : 1);
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
