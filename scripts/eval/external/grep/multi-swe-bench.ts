/**
 * Multi-SWE-bench loader (D15/D20: license review cleared).
 *
 * License note: the Multi-SWE-bench dataset card is CC0, the evaluation
 * harness is Apache-2.0, and upstream instance content (issue text,
 * patches) carries each upstream repo's own licence. This loader refuses
 * to run unless the operator passes --accept-license-review, confirming
 * the D20 license review. Run with that flag only after the review.
 *
 * Instances stream from the ByteDance-Seed/Multi-SWE-bench jsonl files
 * (js/* and ts/* only) via HTTPS range-friendly download. Raw jsonl is
 * cached under ~/.cache/pi-smartread-bench/datasets/multi-swe-bench/ so
 * reruns are offline. Datasets and repo checkouts are never vendored into
 * the repo (D12).
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { deriveGold } from "./patch.js";
import { classifyLanguageByGoldFiles, type BenchmarkInstance } from "./instance.js";

export const MULTI_SWE_BENCH_LICENSE_STATUS = "cleared (D20)";
export const MULTI_SWE_BENCH_LICENSE_NOTE =
    "dataset CC0 per card License section; harness Apache-2.0; upstream instance content per-repo licences (D20)";
export const MULTI_SWE_BENCH_DATASET = "ByteDance-Seed/Multi-SWE-bench";
const HF_RESOLVE = `https://huggingface.co/datasets/${MULTI_SWE_BENCH_DATASET}/resolve/main`;

/** JS/TS dataset files used for the external grep benchmark. */
export const MULTI_SWE_BENCH_FILES = [
    "js/Kong__insomnia_dataset.jsonl",
    "js/anuraghazra__github-readme-stats_dataset.jsonl",
    "js/axios__axios_dataset.jsonl",
    "js/expressjs__express_dataset.jsonl",
    "js/iamkun__dayjs_dataset.jsonl",
    "js/sveltejs__svelte_dataset.jsonl",
    "ts/darkreader__darkreader_dataset.jsonl",
    "ts/mui__material-ui_dataset.jsonl",
    "ts/vuejs__core_dataset.jsonl",
] as const;

export function multiSweBenchCacheDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/datasets/multi-swe-bench");
}

export function assertMultiSweBenchLicense(args: string[]): void {
    if (!args.includes("--accept-license-review")) {
        throw new Error(
            `Refusing Multi-SWE-bench load: license review flag missing (${MULTI_SWE_BENCH_LICENSE_STATUS}). ` +
                "Re-run with --accept-license-review only after the license review clears (D20).",
        );
    }
}

function cacheFileName(datasetFile: string): string {
    return datasetFile.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-jsonl$/, ".jsonl");
}

/** Download one dataset jsonl into the cache (no-op when already cached). */
export async function ensureDatasetFileCached(datasetFile: string): Promise<string> {
    const dir = multiSweBenchCacheDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, cacheFileName(datasetFile));
    if (existsSync(path)) return path;
    const res = await fetch(`${HF_RESOLVE}/${datasetFile}`);
    if (!res.ok || !res.body) throw new Error(`huggingface ${res.status} for ${datasetFile}`);
    const out = createWriteStream(path, { mode: 0o600 });
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), out);
    return path;
}

export interface MultiSweBenchRow {
    instance_id: string;
    org: string;
    repo: string;
    number: number;
    base: { sha: string };
    title: string;
    body: string;
    resolved_issues: Array<{ title: string; body: string }>;
    fix_patch: string;
}

/**
 * Read cached jsonl rows for one dataset file (skips blank/malformed
 * lines). Streams line-by-line: some files hold >512MB single lines, so
 * whole-file string reads are avoided.
 */
export async function readCachedRows(datasetFile: string): Promise<MultiSweBenchRow[]> {
    const path = join(multiSweBenchCacheDir(), cacheFileName(datasetFile));
    const rows: MultiSweBenchRow[] = [];
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            rows.push(JSON.parse(trimmed) as MultiSweBenchRow);
        } catch {
            continue;
        }
    }
    return rows;
}

/** sha256 over cached raw file bytes (dataset-revision binding per file). */
export async function cachedFileRevision(datasetFile: string): Promise<string> {
    const path = join(multiSweBenchCacheDir(), cacheFileName(datasetFile));
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

/**
 * Convert raw rows to benchmark instances, keeping only rows with at
 * least one locatable (production, base-side) gold file. The query text
 * is the linked issue (resolved_issues[0]), falling back to the PR
 * title/body when no linked issue exists.
 */
export function msbRowsToInstances(rows: MultiSweBenchRow[]): {
    instances: BenchmarkInstance[];
    skipped: Array<{ instanceId: string; reason: string }>;
} {
    const instances: BenchmarkInstance[] = [];
    const skipped: Array<{ instanceId: string; reason: string }> = [];
    for (const row of rows) {
        const instanceId = row.instance_id;
        const repo = `${String(row.org ?? "").toLowerCase()}/${row.repo}`;
        const baseCommit = row.base?.sha;
        const issue = (row.resolved_issues ?? [])[0];
        const title = (issue?.title ?? row.title ?? "").split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
        const body = issue?.body ?? row.body ?? "";
        if (!instanceId || !row.org || !row.repo || !title || !row.fix_patch || !baseCommit) {
            skipped.push({ instanceId: instanceId || `row-${row.number}`, reason: "missing-title-patch-or-base" });
            continue;
        }
        const gold = deriveGold(row.fix_patch);
        if (gold.goldFiles.length === 0) {
            skipped.push({ instanceId, reason: "no-production-gold" });
            continue;
        }
        instances.push({
            instanceId,
            dataset: "multi-swe-bench",
            repo,
            baseCommit,
            title,
            body,
            goldFiles: gold.goldFiles,
            goldHunks: gold.goldHunks,
            excludedFiles: gold.excludedFiles,
            language: classifyLanguageByGoldFiles(gold.goldFiles),
            split: "dev",
            license: MULTI_SWE_BENCH_LICENSE_NOTE,
        });
    }
    return { instances, skipped };
}
