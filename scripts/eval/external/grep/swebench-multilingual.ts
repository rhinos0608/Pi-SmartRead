/**
 * SWE-bench Multilingual loader (MIT — usable now, D12).
 *
 * Fetches JS/TS instances via the Hugging Face datasets-server JSON API
 * with Node fetch. Raw row pages are cached under
 * ~/.cache/pi-smartread-bench/datasets/swe-bench-multilingual/ so reruns
 * are offline. Datasets and repo checkouts are never vendored into the
 * repo (D12).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveGold } from "./patch.js";
import type { BenchmarkInstance, InstanceLanguage } from "./instance.js";

export const SWE_BENCH_MULTILINGUAL_LICENSE = "MIT";
export const SWE_BENCH_MULTILINGUAL_DATASET = "SWE-bench/SWE-bench_Multilingual";
const API_BASE = "https://datasets-server.huggingface.co";

/** Upstream repos in SWE-bench Multilingual whose patches are JS/TS. */
export const JS_TS_REPOS = new Set([
    "axios/axios",
    "babel/babel",
    "facebook/docusaurus",
    "immutable-js/immutable-js",
    "mrdoob/three.js",
    "preactjs/preact",
    "vuejs/core",
]);

export function cacheDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/datasets/swe-bench-multilingual");
}

interface DatasetRow {
    instance_id: string;
    repo: string;
    base_commit: string;
    problem_statement: string;
    patch: string;
    version?: string;
    hints_text?: string;
}

function cacheKey(offset: number, length: number): string {
    return `rows-offset-${offset}-length-${length}.json`;
}

async function fetchRowsPage(
    offset: number,
    length: number,
    options: { offline?: boolean } = {},
): Promise<{ rows: DatasetRow[]; total: number }> {
    const dir = cacheDir();
    mkdirSync(dir, { recursive: true });
    const cached = join(dir, cacheKey(offset, length));
    if (existsSync(cached)) {
        return JSON.parse(readFileSync(cached, "utf8")) as { rows: DatasetRow[]; total: number };
    }
    if (options.offline) {
        throw new Error(`--offline: missing cached dataset page offset ${offset} length ${length}; run once online first`);
    }
    const url =
        `${API_BASE}/rows?dataset=${encodeURIComponent(SWE_BENCH_MULTILINGUAL_DATASET)}` +
        `&config=default&split=test&offset=${offset}&length=${length}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`datasets-server ${res.status} for offset ${offset}`);
    const body = (await res.json()) as {
        rows: Array<{ row: DatasetRow }>;
        num_rows_total?: number;
    };
    const page = {
        rows: body.rows.map((r) => r.row),
        total: body.num_rows_total ?? -1,
    };
    writeFileSync(cached, JSON.stringify(page), { mode: 0o600 });
    return page;
}

/** Fetch all rows (paginated, cached). Returns raw rows in dataset order. */
export async function fetchAllRows(options: { offline?: boolean } = {}): Promise<DatasetRow[]> {
    const first = await fetchRowsPage(0, 100, options);
    const total = first.total > 0 ? first.total : 300;
    const all = [...first.rows];
    for (let offset = 100; offset < total; offset += 100) {
        const page = await fetchRowsPage(offset, 100, options);
        all.push(...page.rows);
    }
    return all;
}

/** sha256 over the cached raw row payloads (dataset-revision binding). */
export function datasetRevision(rows: DatasetRow[]): string {
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function detectLanguage(patch: string): InstanceLanguage {
    return /\+\+\+ b\/.*\.m?[tj]sx?|\+\+\+ b\/.*\.[cm]?ts/.test(patch) ? "ts" : "js";
}

function splitTitleBody(problemStatement: string): { title: string; body: string } {
    const body = problemStatement.replace(/\r\n/g, "\n");
    const first = body.split("\n").find((l) => l.trim().length > 0) ?? "";
    return { title: first.trim(), body };
}

/**
 * Convert raw rows to benchmark instances, keeping only JS/TS repos with
 * at least one locatable (production, base-side) gold file.
 */
export function rowsToInstances(rows: DatasetRow[]): {
    instances: BenchmarkInstance[];
    skipped: Array<{ instanceId: string; reason: string }>;
} {
    const instances: BenchmarkInstance[] = [];
    const skipped: Array<{ instanceId: string; reason: string }> = [];
    for (const row of rows) {
        if (!JS_TS_REPOS.has(row.repo)) continue;
        const { title, body } = splitTitleBody(row.problem_statement ?? "");
        if (!title || !row.patch || !row.base_commit) {
            skipped.push({ instanceId: row.instance_id, reason: "missing-title-patch-or-base" });
            continue;
        }
        const gold = deriveGold(row.patch);
        if (gold.goldFiles.length === 0) {
            skipped.push({ instanceId: row.instance_id, reason: "no-production-gold" });
            continue;
        }
        instances.push({
            instanceId: row.instance_id,
            dataset: "swe-bench-multilingual",
            repo: row.repo,
            baseCommit: row.base_commit,
            title,
            body,
            goldFiles: gold.goldFiles,
            goldHunks: gold.goldHunks,
            excludedFiles: gold.excludedFiles,
            language: detectLanguage(row.patch),
            split: "dev",
            license: SWE_BENCH_MULTILINGUAL_LICENSE,
        });
    }
    return { instances, skipped };
}
