/**
 * D46 second-label sampler: deterministically selects 25% of answerable
 * queries per repo (rounded up) plus ALL absence queries, and writes the
 * id list (without gold) per repo for blind second labelling (D46).
 *
 * Usage:
 *   npx tsx scripts/eval/d46/sample-second-label.ts --split dev --seed <n>
 *
 * Reads `*.jsonl` query files under
 * `~/.cache/pi-smartread-bench/d46/<split>/` and writes
 * `second-label-<owner>__<name>.json` (mode 0600) per repo.
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { D46Query, D46Split } from "./schema.js";
import { D46_BENCH_ROOT, loadSplitQueries } from "./validate.js";

/** FNV-1a 32-bit hash for seeding per-repo streams from one seed. */
export function hashSeed(seed: string, repo: string): number {
    let h = 0x811c9dc5;
    for (const ch of `${seed}\u0000${repo}`) {
        h ^= ch.codePointAt(0) ?? 0;
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Mulberry32 PRNG: deterministic across runs for a given seed. */
export function mulberry32(state: number): () => number {
    let a = state >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Deterministically select the second-label sample from one repo's queries:
 * ceil(25%) of answerable (non-absence) queries via a seeded shuffle, plus
 * every absence query id. Returns ids only, sorted for stable output.
 */
export function selectSecondLabelIds(queries: D46Query[], seed: number | string): string[] {
    if (queries.length === 0) return [];
    const repo = queries[0]?.repo ?? "";
    const answerable = queries.filter((q) => q.class !== "absence").map((q) => q.id);
    const absence = queries.filter((q) => q.class === "absence").map((q) => q.id);
    const rand = mulberry32(hashSeed(String(seed), repo));
    const shuffled = [...answerable];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const a = shuffled[i] as string;
        shuffled[i] = shuffled[j] as string;
        shuffled[j] = a;
    }
    const take = Math.ceil(answerable.length * 0.25);
    return [...shuffled.slice(0, take), ...absence].sort();
}

/** Group queries by repo slug (`owner/name` -> `owner__name`). */
export function groupByRepo(queries: D46Query[]): Map<string, D46Query[]> {
    const groups = new Map<string, D46Query[]>();
    for (const q of queries) {
        const list = groups.get(q.repo) ?? [];
        list.push(q);
        groups.set(q.repo, list);
    }
    return groups;
}

export interface D46SecondLabelFile {
    version: 1;
    split: D46Split;
    repo: string;
    seed: string;
    /** Query ids selected for blind second labelling (no gold content). */
    ids: string[];
}

/** Write one second-label id file per repo (mode 0600). Returns paths.
 *
 * Idempotent: a file whose recorded seed matches is reused untouched, so
 * re-running with the same seed never perturbs sealed labelling work. */
export function writeSecondLabelFiles(
    splitDir: string,
    split: D46Split,
    seed: string,
    groups: Map<string, D46Query[]>,
): string[] {
    const paths: string[] = [];
    for (const [repo, queries] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const doc: D46SecondLabelFile = {
            version: 1,
            split,
            repo,
            seed,
            ids: selectSecondLabelIds(queries, seed),
        };
        const out = join(splitDir, `second-label-${repo.replace("/", "__")}.json`);
        try {
            const existing = JSON.parse(readFileSync(out, "utf8")) as Partial<D46SecondLabelFile>;
            if (existing.seed === seed && existing.split === split && existing.repo === repo) {
                paths.push(out);
                continue;
            }
        } catch {
            // Missing or unreadable: write it below.
        }
        writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
        chmodSync(out, 0o600);
        paths.push(out);
    }
    return paths;
}

export function runSampleCli(argv: string[], benchRoot: string = D46_BENCH_ROOT): number {
    let split: string | undefined;
    let seed: string | undefined;
    let repo: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg === "--split") split = argv[++i];
        else if (arg === "--seed") seed = argv[++i];
        else if (arg === "--repo") repo = argv[++i];
        else {
            console.error(`unknown argument: ${arg}`);
            console.error("usage: sample-second-label.ts --split dev|holdout --seed <n> [--repo <owner__name>]");
            return 2;
        }
    }
    if ((split !== "dev" && split !== "holdout") || seed === undefined || seed.length === 0) {
        console.error("usage: sample-second-label.ts --split dev|holdout --seed <n> [--repo <owner__name>]");
        return 2;
    }
    const splitDir = join(benchRoot, split);
    const loaded = loadSplitQueries(splitDir);
    if (loaded.errors.length > 0) {
        for (const e of loaded.errors) console.error(`error: ${e}`);
        return 2;
    }
    const groups = groupByRepo(loaded.queries);
    if (repo !== undefined) {
        const slug = repo.includes("__") ? repo.replace("__", "/") : repo;
        const scoped = groups.get(slug);
        if (scoped === undefined) {
            console.error(`error: --repo ${repo}: no queries for ${slug}`);
            return 2;
        }
        const paths = writeSecondLabelFiles(splitDir, split, seed, new Map([[slug, scoped]]));
        console.log(`${split}: seed ${seed}, second-label files ready for ${slug} (${paths.length} file(s))`);
        return 0;
    }
    const paths = writeSecondLabelFiles(splitDir, split, seed, groups);
    console.log(`${split}: seed ${seed}, second-label files ready (${paths.length} file(s))`);
    return 0;
}

const invokedAsCli =
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    (process.argv[1].endsWith("d46/sample-second-label.ts") ||
        process.argv[1].endsWith("d46\\sample-second-label.ts"));
if (invokedAsCli) {
    process.exitCode = runSampleCli(process.argv.slice(2));
}
