#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_JUDGE_DEFAULT_BASE_URL, CloudJudge } from "../../../src/judge/cloud-judge.js";
import { LocalJudge } from "../../../src/judge/local-judge.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";
import { JudgeError, type Judge, type JudgeNoulItem } from "../../../src/judge/types.js";
import { computeJudgeMetrics, percentile, type ScoredLabel } from "./metrics.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const SOURCE_REF = "18f6463caa78e6657b1af6c7eb86b711bc2364f8";
const DEFAULT_DATA_DIR = join(homedir(), ".cache/pi-smartread-judge-spike/eval");
const OUTPUT_DIR = join(homedir(), ".cache/pi-smartread-judge-spike/bench");

type Backend = "cloud" | "local";
type Label = ScoredLabel["label"];
interface EvalRow {
    qid: string;
    query: string;
    answerable: boolean;
    file: string;
    startLine: number;
    endLine: number;
    symbol: string | null;
    label: Label;
    why: string;
}
interface ScoredRow extends EvalRow {
    p: number;
}

function parseArgs(argv: string[]): { backends: Backend[]; dataDir: string; sets: string[] } {
    let backendArg = "both";
    let dataDir = DEFAULT_DATA_DIR;
    let setArg = "both";
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--backend") backendArg = argv[++i] ?? "";
        else if (arg === "--data-dir") dataDir = resolve(argv[++i] ?? "");
        else if (arg === "--set") setArg = argv[++i] ?? "";
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npx tsx scripts/eval/judge/run.ts [--backend cloud|local|both] [--set a|b|both] [--data-dir PATH]");
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!["cloud", "local", "both"].includes(backendArg)) throw new Error("--backend must be cloud, local, or both");
    if (!["a", "b", "both"].includes(setArg)) throw new Error("--set must be a, b, or both");
    return {
        backends: backendArg === "both" ? ["cloud", "local"] : [backendArg as Backend],
        dataDir,
        sets: setArg === "both" ? ["a", "b"] : [setArg],
    };
}

function loadRows(path: string): EvalRow[] {
    const rows = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`${path}:${index + 1}: invalid JSON`);
        }
        if (!isEvalRow(value)) throw new Error(`${path}:${index + 1}: invalid evaluation row`);
        return value;
    });
    if (rows.length === 0) throw new Error(`No evaluation rows in ${path}`);
    return rows;
}

function isEvalRow(value: unknown): value is EvalRow {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return typeof row.qid === "string" && typeof row.query === "string" &&
        typeof row.answerable === "boolean" && typeof row.file === "string" &&
        Number.isInteger(row.startLine) && Number.isInteger(row.endLine) &&
        (typeof row.symbol === "string" || row.symbol === null) &&
        ["gold", "hard_negative", "easy_negative"].includes(String(row.label)) &&
        typeof row.why === "string" && row.startLine as number > 0 && row.endLine as number >= (row.startLine as number);
}

function sourceRange(file: string, startLine: number, endLine: number, symbol: string | null): string {
    if (isAbsolute(file) || file.split(/[\\/]/).includes("..") || !(file.startsWith("src/") || file.startsWith("test/"))) {
        throw new Error(`Refusing non-repository eval path: ${file}`);
    }
    const source = execFileSync("git", ["show", `${SOURCE_REF}:${file}`], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = source.split(/\r?\n/);
    if (endLine > lines.length || endLine - startLine + 1 > 120) {
        throw new Error(`Invalid pinned source range ${file}:${startLine}-${endLine}`);
    }
    const code = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}|${line}`).join("\n");
    return `${file}:${startLine}-${endLine}${symbol ? ` ${symbol}` : ""}\n${code}`.slice(0, 3500);
}

function createJudge(backend: Backend): Judge {
    if (backend === "cloud") {
        const apiKey = process.env.PI_SMARTREAD_JUDGE_API_KEY;
        if (!apiKey) throw new Error("Cloud evaluation requires PI_SMARTREAD_JUDGE_API_KEY");
        return new CloudJudge({
            apiKey,
            baseUrl: CLOUD_JUDGE_DEFAULT_BASE_URL,
            model: process.env.PI_SMARTREAD_JUDGE_MODEL,
            cache: null,
        });
    }
    const baseUrl = process.env.PI_SMARTREAD_JUDGE_BASE_URL ?? "http://127.0.0.1:8000";
    const endpoint = new URL(baseUrl);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
        throw new Error("Local judge endpoint must use http://127.0.0.1");
    }
    return new LocalJudge({
        baseUrl,
        model: process.env.PI_SMARTREAD_JUDGE_MODEL,
        cache: null,
    });
}

async function scoreQuery(judge: Judge, rows: EvalRow[]): Promise<{ rows: ScoredRow[]; usage: { costUsd?: number; inputTokens: number }; durationMs: number }> {
    const query = rows[0]!.query;
    const items: JudgeNoulItem[] = rows.map((row, index) => ({
        id: `u${index}`,
        state: { path: row.file, symbol: row.symbol ?? "", text: sourceRange(row.file, row.startLine, row.endLine, row.symbol) },
        question: (stateRef) => unitRelevanceQuestion(query, stateRef),
    }));
    const started = performance.now();
    const result = await judge.judgeNouls({ shared: { query }, items });
    const durationMs = performance.now() - started;
    const scored = rows.flatMap((row, index) => {
        const p = result.p.get(`u${index}`);
        return p === undefined ? [] : [{ ...row, p }];
    });
    const failed = result.unjudged.map((item) => `${item.id}:${item.code}`);
    if (failed.length > 0 || scored.length !== rows.length) {
        throw new Error(`Incomplete judgment for ${rows[0]!.qid}: ${failed.join(", ") || "missing answers"}`);
    }
    return {
        rows: scored,
        usage: result.usage,
        durationMs,
    };
}

async function warm(judge: Judge, rows: EvalRow[]): Promise<{ durationMs: number; usage: { costUsd?: number; inputTokens: number } }> {
    const first = rows[0]!;
    const item: JudgeNoulItem = {
        id: "warm",
        state: { path: first.file, symbol: first.symbol ?? "", text: sourceRange(first.file, first.startLine, first.endLine, first.symbol) },
        question: (stateRef) => unitRelevanceQuestion(first.query, stateRef),
    };
    const started = performance.now();
    const result = await judge.judgeNouls({ shared: { query: first.query }, items: [item] });
    return { durationMs: performance.now() - started, usage: result.usage };
}

function summarize(scored: ScoredRow[], queryLatencies: number[], costUsd: number | undefined, inputTokens: number) {
    const uniqueQueries = new Set(scored.map((row) => row.qid)).size;
    return {
        metrics: computeJudgeMetrics(scored, [0.2, 0.4, 0.45]),
        queryCount: uniqueQueries,
        latencyMs: { p50: percentile(queryLatencies, 0.5), p95: percentile(queryLatencies, 0.95) },
        usage: { costUsd: costUsd ?? null, inputTokens },
    };
}

async function runBackend(backend: Backend, sets: string[], dataDir: string) {
    const input = sets.flatMap((set) => loadRows(join(dataDir, `set-${set}.jsonl`)));
    const byQuery = new Map<string, EvalRow[]>();
    for (const row of input) {
        const group = byQuery.get(row.qid) ?? [];
        group.push(row);
        byQuery.set(row.qid, group);
    }
    const judge = createJudge(backend);
    const warmup = await warm(judge, input);
    const scored: ScoredRow[] = [];
    const queryLatencies: number[] = [];
    let costUsd: number | undefined = warmup.usage.costUsd;
    let inputTokens = warmup.usage.inputTokens;
    for (const [qid, rows] of byQuery) {
        process.stdout.write(`[${backend}] ${qid} ... `);
        const result = await scoreQuery(judge, rows);
        scored.push(...result.rows);
        queryLatencies.push(result.durationMs);
        if (result.usage.costUsd !== undefined) costUsd = (costUsd ?? 0) + result.usage.costUsd;
        inputTokens += result.usage.inputTokens;
        console.log(`${Math.round(result.durationMs)}ms`);
    }
    return {
        backend,
        model: judge.info.model,
        sets,
        warmup: { durationMs: warmup.durationMs, costUsd: warmup.usage.costUsd ?? null, inputTokens: warmup.usage.inputTokens },
        summary: summarize(scored, queryLatencies, costUsd, inputTokens),
        scores: scored,
    };
}

const config = parseArgs(process.argv.slice(2));
execFileSync("git", ["cat-file", "-e", `${SOURCE_REF}^{commit}`], { cwd: ROOT, stdio: "ignore" });
const generatedAt = new Date().toISOString();
const results: Array<Record<string, unknown>> = [];
let failed = false;
for (const backend of config.backends) {
    try {
        results.push(await runBackend(backend, config.sets, config.dataDir));
    } catch (error) {
        failed = true;
        results.push({ backend, status: "failed", errorCode: error instanceof JudgeError ? error.code : "unexpected_error" });
        console.error(`[${backend}] stopped: ${error instanceof JudgeError ? error.code : "unexpected_error"}`);
        break;
    }
}
mkdirSync(OUTPUT_DIR, { recursive: true });
const outputPath = join(OUTPUT_DIR, `results-${generatedAt.replace(/[:.]/g, "-")}-p${process.pid}.json`);
writeFileSync(outputPath, JSON.stringify({
    generatedAt,
    sourceRef: SOURCE_REF,
    latencyScope: "per-query judge call after warm-up; excludes source-range materialization",
    results,
}, null, 2), { mode: 0o600 });
for (const result of results) if ("summary" in result) console.log(`${result.backend}: ${JSON.stringify(result.summary)}`);
console.log(`Report: ${relative(ROOT, outputPath).split(sep).join("/")}`);
if (failed) process.exitCode = 1;
