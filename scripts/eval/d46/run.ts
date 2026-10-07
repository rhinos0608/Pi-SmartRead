#!/usr/bin/env node
/**
 * D46 evaluation runner (D46, D53, D57, D59, D61).
 *
 * Drives the product grep tool exactly as scripts/eval/judge/grep-e2e.ts
 * does (createGrepTool.execute, same trace capture and LSP teardown),
 * with search root = realpath(<checkout>/<corpusRoot>) per D61, over the
 * sealed D46 splits. Scoring lives in ./score.ts (pure, unit-tested).
 *
 * Usage:
 *   npx tsx scripts/eval/d46/run.ts --split dev|holdout [--repo <owner__name>]
  *     [--config off|t040] [--replicate <k>] [--freeze <path>] [--open-holdout]
  *     [--reports-dir <dir>] ($PI_SMARTREAD_D46_REPORTS_DIR overrides the default)
 *
 * Integrity (fail-closed, exit 2):
 * - the split's sealed MANIFEST.sha256.json is re-verified against current
 *   files before running (refuse on mismatch);
 * - each pinned checkout HEAD must equal repos.json sha with a clean tree.
 *
 * Holdout guard: --split holdout requires BOTH --open-holdout and
 * --freeze <path>. The freeze file is JSON whose sha256 is recorded in the
 * report and which lists the allowed arms (ranking knobs + judge config +
 * replicate count); the run is refused when the resolved knobs/config are
 * not a listed arm or the engine source hash differs from the freeze's
 * engineSourceHash. Holdout query text is never printed to stdout/stderr,
 * and holdout reports carry ids, outcomes and rendered system output but
 * NOT query text or gold.
 *
 * Report JSON (0600) lands under
 * ~/.cache/pi-smartread-bench/reports/d46-<split>-<config>-<ts>-<rand>.json.
 * Report fields (adapter notes for scripts/eval/judge/variant-matrix.ts):
 * - manifest: { fixtureSha (= sealed queriesSha256), inventoryHashBefore
 *   (over pinned checkouts), corpusKind "d46-pinned-checkouts",
 *   gateConstants, retrievalConditions (rank knobs + unit settings +
 *   perQueryLimit/topK/context/tokenBudget), engineSourceHash,
 *   manifestSha256, freezeSha256?, judge { config, model, origin } }.
 * - queries[]: per-query rows each carrying qid + fileHit + readReady +
 *   covered + abstained + renderedTokens (the pairReports/variant-matrix
 *   surface) alongside the full D46ScoredQuery fields.
 * A later adapter can therefore feed variant-matrix by mapping
 * queries[] -> PairedReport.queries and manifest -> PairedReport.manifest.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CLOUD_JUDGE_DEFAULT_BASE_URL, CLOUD_JUDGE_DEFAULT_MODEL, CloudJudge } from "../../../src/judge/cloud-judge.js";
import { GREP_JUDGE_THRESHOLD_ENV_VAR } from "../../../src/judge/grep-judge-stage.js";
import type { GrepJudgeProvider } from "../../../src/judge/grep-judge-stage.js";
import type { Judge, JudgeNoulInput, JudgeNoulResult, JudgeUsage } from "../../../src/judge/types.js";
import { resolveGrepRankingOptions } from "../../../src/search/grep-ranking.js";
import {
    resolveGrepUnitExcerptLines,
    resolveGrepUnitMaxPerFile,
    resolveGrepUnitMode,
} from "../../../src/search/grep-units.js";
import { createGrepTool, type GrepTraceEvent } from "../../../src/search/grep-tool.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { shutdownAllManagers } from "../../../src/lsp/lsp-manager.js";
import { resetLSPBridge } from "../../../src/lsp/lsp-bridge.js";
import { GATE_CONSTANTS, READ_READY_DEFAULT_BUDGET } from "../judge/grep-e2e-metrics.js";
import {
    canonicalizeCorpusRoot,
    errorStatus,
    hashEngineSources,
    isKnownSourceHash,
    toRankReportSettings,
    type RankReportSettings,
} from "../judge/grep-e2e-contract.js";
import {
    D46_BENCH_ROOT,
    loadRepoManifest,
    loadSplitQueries,
    pinnedQueryFileNames,
    type D46SplitManifest,
} from "./validate.js";
import type { D46Query, D46Split } from "./schema.js";
import { aggregateD46, scoreD46Query, summarizeD46, type D46RenderedUnit } from "./score.js";

export const D46_REPORTS_DIR = join(homedir(), ".cache", "pi-smartread-bench", "reports");

export const D46_REPORTS_DIR_ENV_VAR = "PI_SMARTREAD_D46_REPORTS_DIR";

/** Reports dir: --reports-dir > $PI_SMARTREAD_D46_REPORTS_DIR > default. */
export function resolveD46ReportsDir(reportsDirArg: string | null): string {
    const env = process.env[D46_REPORTS_DIR_ENV_VAR];
    if (reportsDirArg !== null && reportsDirArg.length > 0) return reportsDirArg;
    if (env !== undefined && env.length > 0) return env;
    return D46_REPORTS_DIR;
}

export type D46RunConfig = "off" | "t040";
const CONFIG_THRESHOLD: Record<Exclude<D46RunConfig, "off">, string> = { t040: "0.40" };

export interface D46RunArgs {
    split: D46Split;
    repo: string | null;
    config: D46RunConfig;
    replicate: number;
    freeze: string | null;
    openHoldout: boolean;
    reportsDir: string | null;
}

export function parseD46RunArgs(argv: string[]): D46RunArgs {
    let split: string | undefined;
    let repo: string | null = null;
    let config = "off";
    let replicate = 1;
    let freeze: string | null = null;
    let openHoldout = false;
    let reportsDir: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] as string;
        if (arg === "--split") split = argv[++i];
        else if (arg === "--repo") repo = argv[++i] ?? "";
        else if (arg === "--config") config = argv[++i] ?? "";
        else if (arg === "--replicate") replicate = Number(argv[++i] ?? "");
        else if (arg === "--freeze") freeze = argv[++i] ?? "";
        else if (arg === "--open-holdout") openHoldout = true;
        else if (arg === "--reports-dir") reportsDir = argv[++i] ?? "";
        else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: npx tsx scripts/eval/d46/run.ts --split dev|holdout [--repo <owner__name>] [--config off|t040] [--replicate <k>] [--freeze <path>] [--open-holdout] [--reports-dir <dir>]",
            );
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (split !== "dev" && split !== "holdout") throw new Error("--split must be dev|holdout");
    if (config !== "off" && config !== "t040") throw new Error("--config must be off|t040");
    if (!Number.isInteger(replicate) || replicate < 1) throw new Error("--replicate must be a positive integer");
    return { split, repo, config: config as D46RunConfig, replicate, freeze, openHoldout, reportsDir };
}

/** Re-verify the sealed manifest against current split-dir files. Returns error strings. */
export function verifySplitManifest(splitDir: string, manifest: D46SplitManifest): string[] {
    const errors: string[] = [];
    let entries: string[];
    try {
        entries = readdirSync(splitDir).sort();
    } catch {
        return [`split dir not found: ${splitDir}`];
    }
    const current = new Map<string, string>();
    for (const name of entries) {
        if (name === "MANIFEST.sha256.json") continue;
        current.set(name, sha256OfFile(join(splitDir, name)));
    }
    const seen = new Set<string>();
    for (const f of manifest.files) {
        seen.add(f.file);
        const hash = current.get(f.file);
        if (hash === undefined) {
            errors.push(`sealed query file missing: ${f.file}`);
        } else if (hash !== f.sha256) {
            errors.push(`sealed query file changed: ${f.file}`);
        }
    }
    for (const a of manifest.artifacts) {
        seen.add(a.file);
        const hash = current.get(a.file);
        if (hash === undefined) {
            errors.push(`sealed artifact missing: ${a.file}`);
        } else if (hash !== a.sha256) {
            errors.push(`sealed artifact changed: ${a.file}`);
        }
    }
    for (const name of current.keys()) {
        if (!seen.has(name)) errors.push(`unsealed file in split dir: ${name}`);
    }
    return errors;
}

function sha256OfFile(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** SmartRead runtime-cache directory names (AGENTS.md 'Generated/runtime state').
 * Untouched caches created by SmartRead itself inside a searched tree must not
 * fail the runner's clean-checkout check, and are cold-started (deleted)
 * before running queries for a repo. */
export const SMARTREAD_RUNTIME_CACHE_DIRS = [
    ".pi",
    ".pi-smartread",
    ".pi-smartread.tags.cache",
    ".pi-smartread.embeddings.cache",
    ".pi-subagents",
    "graphify-out",
    ".smart-edit-undo",
    ".subagent-work",
] as const;

/** True when any full '/'-separated path segment is a runtime-cache dir name. */
export function isRuntimeCachePath(path: string): boolean {
    const normalized = path.replace(/\\/g, "/").replace(/^\"|\"$/g, "");
    const segments = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
    return segments.some((s) => (SMARTREAD_RUNTIME_CACHE_DIRS as readonly string[]).includes(s));
}

/**
 * Cleanliness over `git status --porcelain --untracked-files=all` output:
 * any tracked change (M/A/D/R/C/U/T in either XY column) anywhere refuses,
 * including inside cache-named dirs; only untracked (`??`) cache paths
 * are tolerated.
 */
export function isCleanPorcelain(porcelain: string): boolean {
    for (const line of porcelain.split("\n")) {
        if (line.trim().length === 0) continue;
        if (line.slice(0, 2) !== "??") return false;
        const raw = line.length > 3 ? line.slice(3) : "";
        // Renames/copies: 'old -> new'; ignore only when every side is a cache path.
        const sides = raw.includes(" -> ") ? raw.split(" -> ") : [raw];
        const allCache = sides.length > 0 && sides.every((s) => s.trim().length > 0 && isRuntimeCachePath(s.trim()));
        if (allCache) continue;
        return false;
    }
    return true;
}

/**
 * Cold start, phase 1 (no deletion): walk realpath(checkout) and classify
 * every runtime-cache directory as either deletable or tracked-skipped.
 * Never follows symlinks. Any filesystem or git failure yields `error`
 * with NOTHING deleted (callers must not delete on error).
 */
export function planColdStartRuntimeCaches(
    checkoutDir: string,
    git: ColdStartGit = {},
): {
    root: string;
    toDelete: string[];
    skippedTracked: string[];
    error: string | null;
} {
    let root: string;
    try {
        root = realpathSync(checkoutDir);
    } catch {
        return { root: checkoutDir, toDelete: [], skippedTracked: [], error: `cannot resolve checkout: ${checkoutDir}` };
    }
    const lsFiles = git.lsFiles ?? defaultLsFiles;
    const cacheNames = new Set<string>(SMARTREAD_RUNTIME_CACHE_DIRS as readonly string[]);
    const candidates: string[] = [];
    const walkError = walkCacheCandidates(root, cacheNames, candidates);
    if (walkError) return { root, toDelete: [], skippedTracked: [], error: walkError };
    // Classify EVERY candidate before deleting any: a git failure here
    // (fail-closed) aborts with nothing deleted.
    const skippedTracked: string[] = [];
    const toDelete: string[] = [];
    for (const full of candidates) {
        let tracked: boolean;
        try {
            tracked = dirHasTrackedFilesOrThrow(root, full, lsFiles);
        } catch {
            return { root, toDelete: [], skippedTracked: [], error: `cannot list tracked files under ${full}` };
        }
        // A cache-named dir holding tracked content is legitimate and skipped.
        // Relative paths use forward slashes on every platform so reports,
        // manifests, and tests compare identically on Windows and POSIX.
        (tracked ? skippedTracked : toDelete).push(relative(root, full).replace(/\\/g, "/"));
    }
    toDelete.sort();
    skippedTracked.sort();
    return { root, toDelete, skippedTracked, error: null };
}

/**
 * Walk root (never following symlinks) and collect cache-named directories.
 * Returns a sanitized error string on refusal/failure, or null when the
 * walk completed and `out` holds every candidate.
 */
function walkCacheCandidates(root: string, cacheNames: Set<string>, out: string[]): string | null {
    const stack: string[] = [root];
    try {
        while (stack.length > 0) {
            const dir = stack.pop() as string;
            let entries: import("node:fs").Dirent[];
            try {
                entries = readdirSync(dir, { withFileTypes: true });
            } catch {
                return `cannot list directory: ${dir}`;
            }
            for (const entry of entries) {
                const full = join(dir, entry.name);
                if (!entry.isSymbolicLink()) {
                    if (entry.isDirectory()) {
                        if (cacheNames.has(entry.name)) out.push(full);
                        else stack.push(full);
                    }
                    continue;
                }
                if (!cacheNames.has(entry.name)) continue;
                // Symlinked cache dir: resolve without following beyond readlink.
                let target: string;
                try {
                    target = realpathSync(full);
                } catch {
                    return `refuses-symlink: ${full} is not resolvable`;
                }
                if (target !== root && !target.replace(/\\/g, "/").startsWith(`${root.replace(/\\/g, "/")}/`)) {
                    return `refuses-symlink: ${full} points outside the checkout`;
                }
                // Inside-checkout symlink: leave it in place, do not follow/delete.
                return `refuses-symlink: ${full} is a symlink`;
            }
        }
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return null;
}

/**
 * Cold start, phase 2: delete the runtime-cache directories classified by
 * {@link planColdStartRuntimeCaches}. Callers must plan every checkout
 * first and only delete when all plans are error-free.
 */
export function coldStartRuntimeCaches(
    checkoutDir: string,
    git: ColdStartGit = {},
): {
    deleted: string[];
    skippedTracked: string[];
    error: string | null;
} {
    const plan = planColdStartRuntimeCaches(checkoutDir, git);
    if (plan.error) return { deleted: [], skippedTracked: [], error: plan.error };
    const deleted: string[] = [];
    try {
        for (const rel of plan.toDelete) {
            rmSync(join(plan.root, rel), { recursive: true, force: true });
            deleted.push(rel);
        }
    } catch (error) {
        return { deleted, skippedTracked: [], error: error instanceof Error ? error.message : String(error) };
    }
    return { deleted, skippedTracked: plan.skippedTracked, error: null };
}

/** Injectable git access for the cold-start path (tests stub failures). */
export interface ColdStartGit {
    lsFiles?: (gitDir: string, dir: string) => string;
}

function defaultLsFiles(gitDir: string, dir: string): string {
    return execFileSync("git", ["-C", gitDir, "ls-files", "--", dir], { encoding: "utf8" }) as string;
}

/**
 * True when `git ls-files` reports any tracked file at or under dir.
 * Fail-closed: any git failure (non-zero exit, spawn error) or non-string
 * output throws, so callers can never read an error as 'no tracked files'.
 */
function dirHasTrackedFilesOrThrow(
    gitDir: string,
    dir: string,
    lsFiles: (gitDir: string, dir: string) => string,
): boolean {
    let out: unknown;
    try {
        out = lsFiles(gitDir, dir);
    } catch {
        throw new Error(`cannot list tracked files under ${dir}`);
    }
    if (typeof out !== "string") throw new Error(`cannot list tracked files under ${dir}`);
    return out.trim().length > 0;
}

/** Check each pinned checkout: HEAD equals the pinned sha and the tree is clean. */
export function verifyCheckoutPins(
    queries: D46Query[],
    pins: ReturnType<typeof loadRepoManifest>["repos"],
    reposRoot: string,
    git?: { head(dir: string): string; status?(dir: string): string; clean?(dir: string): boolean },
): string[] {
    const errors: string[] = [];
    const byRepo = new Map(pins.map((p) => [`${p.owner}/${p.name}`, p]));
    const needed = [...new Set(queries.map((q) => q.repo))].sort();
    const run = git ?? {
        head: (dir: string) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        status: (dir: string) =>
            execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }),
    };
    for (const repo of needed) {
        const pin = byRepo.get(repo);
        if (!pin) {
            errors.push(`${repo}: not pinned in repos.json`);
            continue;
        }
        const dir = join(reposRoot, `${pin.owner}__${pin.name}`);
        let head: string;
        try {
            head = run.head(dir);
        } catch {
            errors.push(`${repo}: cannot read HEAD of ${dir}`);
            continue;
        }
        if (head !== pin.sha) {
            errors.push(`${repo}: HEAD ${head} != pinned ${pin.sha}`);
            continue;
        }
        try {
            const clean = run.status ? isCleanPorcelain(run.status(dir)) : run.clean!(dir);
            if (!clean) errors.push(`${repo}: working tree is not clean`);
        } catch {
            errors.push(`${repo}: cannot check tree cleanliness of ${dir}`);
        }
    }
    return errors;
}

export interface D46FreezeArm {
    config: D46RunConfig;
    replicate: number;
    ranking: RankReportSettings;
}

export interface D46FreezeFile {
    engineSourceHash: string;
    arms: D46FreezeArm[];
}

export function loadFreezeFile(path: string): { freeze: D46FreezeFile; sha256: string } {
    const raw = readFileSync(path);
    const freeze = JSON.parse(raw.toString("utf8")) as D46FreezeFile;
    if (typeof freeze.engineSourceHash !== "string" || !Array.isArray(freeze.arms)) {
        throw new Error(`freeze file ${path}: must be { engineSourceHash: string, arms: [...] }`);
    }
    return { freeze, sha256: createHash("sha256").update(raw).digest("hex") };
}

function rankingsEqual(a: RankReportSettings, b: RankReportSettings): boolean {
    return (
        a.rankTestDemote === b.rankTestDemote &&
        a.rankFilename === b.rankFilename &&
        a.rankBm25k1 === b.rankBm25k1 &&
        a.rankBm25b === b.rankBm25b &&
        a.rankCoverage === b.rankCoverage &&
        a.rankStopwords === b.rankStopwords
    );
}

/**
 * Holdout guard (fail-closed). Returns an error string, or null when the
 * run may proceed. Dev splits always pass; holdout requires BOTH
 * --open-holdout and --freeze, an arm match, and engine-hash equality.
 */
export function checkHoldoutGuard(input: {
    split: D46Split;
    openHoldout: boolean;
    freeze: D46FreezeFile | null;
    config: D46RunConfig;
    replicate: number;
    ranking: RankReportSettings;
    engineSourceHash: string;
}): string | null {
    if (input.split !== "holdout") return null;
    if (!input.openHoldout) return "refuses-holdout: --split holdout requires --open-holdout";
    if (!input.freeze) return "refuses-holdout: --split holdout requires --freeze <path>";
    if (input.engineSourceHash !== input.freeze.engineSourceHash) {
        return "refuses-holdout: engine source hash differs from the freeze file";
    }
    const match = input.freeze.arms.some(
        (arm) =>
            arm.config === input.config &&
            arm.replicate === input.replicate &&
            rankingsEqual(arm.ranking, input.ranking),
    );
    if (!match) return "refuses-holdout: current knobs/config are not a listed freeze arm";
    return null;
}

/** Strip query text and gold from per-query rows for holdout reports. */
export function redactForHoldout(row: Record<string, unknown>, holdout: boolean): Record<string, unknown> {
    if (!holdout) return row;
    const redacted = { ...row };
    if ("query" in redacted) redacted["query"] = null;
    if ("gold" in redacted) redacted["gold"] = [];
    return redacted;
}

function wrapJudge(inner: Judge, onCall: () => void, calls: JudgeUsage[]): Judge {
    return {
        info: inner.info,
        judgeNouls: async (input: JudgeNoulInput, signal?: AbortSignal): Promise<JudgeNoulResult> => {
            const result = await inner.judgeNouls(input, signal);
            onCall();
            calls.push(result.usage);
            return result;
        },
    };
}

function createProvider(config: D46RunConfig): GrepJudgeProvider | undefined {
    if (config === "off") return undefined;
    const apiKey = process.env.PI_SMARTREAD_JUDGE_API_KEY;
    if (!apiKey) {
        throw new Error(
            'Refusing judged config "t040": PI_SMARTREAD_JUDGE_API_KEY is absent in the environment.',
        );
    }
    const inner = new CloudJudge({
        apiKey,
        baseUrl: CLOUD_JUDGE_DEFAULT_BASE_URL,
        model: process.env.PI_SMARTREAD_JUDGE_MODEL,
        cache: null,
    });
    const judge = wrapJudge(inner, () => {}, []);
    return { resolveJudge: async () => ({ judge }) };
}

interface RunTrace {
    units: D46RenderedUnit[];
    totalHits: number;
    text: string;
    judged: boolean;
    abstained: boolean;
    routingMode: string;
    judgeInvoked: boolean;
    cost: JudgeUsage;
}

async function runD46Query(input: {
    query: string;
    root: string;
    judge: GrepJudgeProvider | undefined;
    timeoutMs: number;
}): Promise<{ trace: RunTrace; status: string; elapsedMs: number }> {
    const started = performance.now();
    const events: GrepTraceEvent[] = [];
    let judgeInvoked = false;
    const costs: JudgeUsage[] = [];
    const recordingJudge = input.judge
        ? {
            resolveJudge: async (...args: Parameters<NonNullable<GrepJudgeProvider["resolveJudge"]>>) => {
                const resolved = await input.judge!.resolveJudge(...args);
                if (!("judge" in resolved)) return resolved;
                return { judge: wrapJudge(resolved.judge, () => { judgeInvoked = true; }, costs) };
            },
        }
        : undefined;
    const opts = {
        getWorkspaceRevision: () => 0,
        onTraceGrepQuery: (e: GrepTraceEvent) => { events.push(e); },
        ...(recordingJudge ? { judge: recordingJudge } : {}),
    };
    let status = "ok";
    let routingMode = "unknown";
    try {
        const tool = createGrepTool(opts);
        const signal = AbortSignal.timeout(input.timeoutMs);
        const result = await tool.execute(
            "d46",
            { pattern: input.query },
            signal,
            undefined,
            { cwd: input.root } as Parameters<ReturnType<typeof createGrepTool>["execute"]>[4],
        );
        // Routing lives in the tool result details (the post-judge trace
        // snapshot carries no routing); read it structurally so the
        // runner never duplicates the product's routing logic.
        const details = (result as { details?: unknown }).details as
            | { routing?: { mode?: unknown } }
            | undefined;
        if (typeof details?.routing?.mode === "string") routingMode = details.routing.mode;
    } catch (error) {
        status = errorStatus(error);
    }
    const elapsedMs = performance.now() - started;
    const postJudge = events.find((e) => e.stage === "post-judge");
    const postCap = events.find((e) => e.stage === "post-cap");
    const shown = postJudge?.stage === "post-judge" ? postJudge.shown : [];
    const text = postCap?.stage === "post-cap" ? postCap.text : "";
    const units: D46RenderedUnit[] = shown.map((h) => ({
        file: h.relFile,
        line: h.line,
        endLine: h.endLine,
        snippet: h.snippet,
    }));
    return {
        trace: {
            units,
            totalHits: postJudge?.stage === "post-judge" ? postJudge.totalHits : units.length,
            text,
            judged: postJudge?.stage === "post-judge" ? postJudge.judged : false,
            abstained: postJudge?.stage === "post-judge" ? postJudge.abstained : false,
            routingMode,
            judgeInvoked,
            cost: {
                inputTokens: costs.reduce((a, c) => a + c.inputTokens, 0),
                requests: costs.reduce((a, c) => a + c.requests, 0),
                costUsd: costs.reduce((a, c) => a + (c.costUsd ?? 0), 0),
            },
        },
        status,
        elapsedMs,
    };
}

function gitRootFromScript(): string | null {
    try {
        const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: resolve(import.meta.dirname ?? "."),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return root.length > 0 ? root : null;
    } catch {
        return null;
    }
}

export async function runD46Cli(argv: string[], benchRoot: string = D46_BENCH_ROOT, overrides: { engineSourceHash?: string; reportsDir?: string } = {}): Promise<number> {
    const args = parseD46RunArgs(argv);
    const holdout = args.split === "holdout";
    const splitDir = join(benchRoot, args.split);
    const manifestPath = join(splitDir, "MANIFEST.sha256.json");
    if (!existsSync(manifestPath)) {
        console.error(`error: sealed manifest missing: ${manifestPath}`);
        return 2;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as D46SplitManifest;
    const manifestErrors = verifySplitManifest(splitDir, manifest);
    if (manifestErrors.length > 0) {
        for (const e of manifestErrors) console.error(`error: ${e}`);
        return 2;
    }
    let repoManifest: ReturnType<typeof loadRepoManifest>;
    try {
        repoManifest = loadRepoManifest(benchRoot);
    } catch {
        console.error(`error: cannot load ${benchRoot}/repos.json`);
        return 2;
    }
    const loaded = loadSplitQueries(splitDir, pinnedQueryFileNames(repoManifest.repos, args.split));
    if (loaded.errors.length > 0) {
        for (const e of loaded.errors) console.error(`error: ${e}`);
        return 2;
    }
    let queries: D46Query[] = loaded.queries;
    if (args.repo) {
        const slug = args.repo.includes("__") ? args.repo.replace("__", "/") : args.repo;
        queries = queries.filter((q) => q.repo === slug);
        if (queries.length === 0) {
            console.error(`error: --repo ${args.repo}: no queries`);
            return 2;
        }
    }
    const reposRoot = repoManifest.reposDir.startsWith("~")
        ? join(homedir(), repoManifest.reposDir.slice(1))
        : repoManifest.reposDir;
    const pinErrors = verifyCheckoutPins(queries, repoManifest.repos, reposRoot);
    if (pinErrors.length > 0) {
        for (const e of pinErrors) console.error(`error: ${e}`);
        return 2;
    }
    // Preflight ordering: plan cache deletions for every repo (no
    // deletion), then run every remaining preflight check (engine hash,
    // freeze, holdout guard, judge provider construction). Only after ALL
    // checks pass are the planned deletions executed, so a refused run
    // never deletes caches.
    const ranking = toRankReportSettings(resolveGrepRankingOptions());
    const engineSourceHash = overrides.engineSourceHash ?? hashEngineSources(gitRootFromScript() ?? resolve("."));
    if (!isKnownSourceHash(engineSourceHash)) {
        console.error("error: unknown engine source hash; refusing to run");
        return 2;
    }
    let freeze: D46FreezeFile | null = null;
    let freezeSha256: string | null = null;
    if (args.freeze) {
        try {
            const loadedFreeze = loadFreezeFile(args.freeze);
            freeze = loadedFreeze.freeze;
            freezeSha256 = loadedFreeze.sha256;
        } catch (error) {
            console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            return 2;
        }
    }
    const guard = checkHoldoutGuard({
        split: args.split,
        openHoldout: args.openHoldout,
        freeze,
        config: args.config,
        replicate: args.replicate,
        ranking,
        engineSourceHash,
    });
    if (guard) {
        console.error(`error: ${guard}`);
        return 2;
    }
    // Judge provider construction can refuse (e.g. missing judge API key
    // for a judge-backed config); construct BEFORE any cache deletion.
    let provider: GrepJudgeProvider | undefined;
    try {
        provider = createProvider(args.config);
    } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
    }
    const coldDeleted: string[] = [];
    const coldSkippedTracked: string[] = [];
    {
        // Two phases: plan EVERY checkout (full cleanliness re-check + full
        // tracked classification, no deletion) before deleting anything.
        const seen = new Set<string>();
        const plans: { root: string; toDelete: string[]; skippedTracked: string[] }[] = [];
        for (const q of queries) {
            const pin = repoManifest.repos.find((p) => `${p.owner}/${p.name}` === q.repo);
            if (!pin) continue;
            let dir: string;
            try {
                dir = realpathSync(join(reposRoot, `${pin.owner}__${pin.name}`));
            } catch {
                console.error(`error: cannot resolve checkout: ${q.repo}`);
                return 2;
            }
            if (seen.has(dir)) continue;
            seen.add(dir);
            const plan = planColdStartRuntimeCaches(dir);
            if (plan.error) {
                console.error(`error: ${plan.error}`);
                return 2;
            }
            plans.push({ root: plan.root, toDelete: plan.toDelete, skippedTracked: plan.skippedTracked });
        }
        for (const plan of plans) {
            for (const p of plan.toDelete) {
                try {
                    rmSync(join(plan.root, p), { recursive: true, force: true });
                } catch {
                    console.error(`error: cannot delete runtime cache: ${p}`);
                    return 2;
                }
                coldDeleted.push(`${plan.root}/${p}`);
            }
            for (const p of plan.skippedTracked) coldSkippedTracked.push(`${plan.root}/${p}`);
        }
        coldDeleted.sort();
        coldSkippedTracked.sort();
    }

    if (args.config === "off") delete process.env[GREP_JUDGE_THRESHOLD_ENV_VAR];
    else process.env[GREP_JUDGE_THRESHOLD_ENV_VAR] = CONFIG_THRESHOLD[args.config];

    const pins = new Map(repoManifest.repos.map((p) => [`${p.owner}/${p.name}`, p]));
    const rows: Array<Record<string, unknown>> = [];
    try {
        for (let r = 0; r < args.replicate; r++) {
            for (const q of queries) {
                const pin = pins.get(q.repo)!;
                const root = canonicalizeCorpusRoot(realpathSync(join(reposRoot, `${pin.owner}__${pin.name}`, pin.corpusRoot)));
                const { trace, status, elapsedMs } = await runD46Query({
                    query: q.query,
                    root,
                    judge: provider,
                    timeoutMs: 60000,
                });
                const scored = scoreD46Query({
                    query: q,
                    units: trace.units,
                    totalHits: trace.totalHits,
                    renderedChars: trace.text.length,
                    renderedText: trace.text,
                    routingMode: trace.routingMode,
                    judgeInvoked: trace.judgeInvoked,
                    status,
                    elapsedMs,
                });
                // Variant-matrix surface: qid + fileHit + readReady + covered
                // (successAt5) + abstained + renderedTokens on every row.
                const row: Record<string, unknown> = {
                    ...scored,
                    qid: scored.id,
                    fileHit: trace.units.slice(0, 5).some((u) => q.gold.some((g) => g.path === u.file)),
                    readReady: scored.readReadyAt5,
                    covered: scored.successAt5,
                    abstained: trace.abstained,
                    renderedTokens: Math.ceil(trace.text.length / 4),
                    replicate: r,
                    latencyMs: elapsedMs,
                    routing: trace.routingMode,
                    judged: trace.judged,
                    cost: trace.cost,
                    manifestSha256: manifest.queriesSha256,
                    engineSourceHash: engineSourceHash,
                };
                if (holdout) {
                    rows.push(redactForHoldout({ ...row, text: trace.text }, true));
                } else {
                    rows.push({ ...row, query: q.query, gold: q.gold, text: trace.text });
                }
                if (!holdout) process.stdout.write(`[${args.config}] ${q.id} ... ${status}\n`);
                else process.stdout.write(`[${args.config}] query ${rows.length}/${queries.length * args.replicate} ... ${status}\n`);
            }
        }
    } finally {
        await shutdownAllManagers().catch(() => {});
        try {
            resetLSPBridge();
        } catch { /* harness-only cleanup */ }
        disposeSemanticIndexes();
    }

    const scoredRows = rows.map((r) => ({
        id: r["id"] as string,
        repo: r["repo"] as string,
        class: r["class"] as D46Query["class"],
        answerable: r["answerable"] as boolean,
        top5Files: r["top5Files"] as string[],
        successAt5: r["successAt5"] as boolean,
        recallAt5: r["recallAt5"] as number | null,
        precisionAt5: r["precisionAt5"] as number | null,
        mrr: r["mrr"] as number,
        ndcgAt5: r["ndcgAt5"] as number | null,
        readReadyAt5: r["readReadyAt5"] as boolean,
        readReadyTokens: r["readReadyTokens"] as number,
        falseEmpty: r["falseEmpty"] as boolean,
        falseContent: r["falseContent"] as boolean | null,
        correctAbstention: r["correctAbstention"] as boolean | null,
        unexpectedJudge: r["unexpectedJudge"] as boolean | null,
        routingMode: r["routingMode"] as string,
        judgeInvoked: r["judgeInvoked"] as boolean,
        status: r["status"] as string,
        elapsedMs: r["elapsedMs"] as number,
    }));
    const summary = summarizeD46(scoredRows);
    const report = {
        generatedAt: new Date().toISOString(),
        split: args.split,
        config: args.config,
        status: "complete",
        replicate: args.replicate,
        coldStart: { deleted: coldDeleted, skippedTracked: coldSkippedTracked, count: coldDeleted.length },
        threshold: args.config === "off" ? null : CONFIG_THRESHOLD[args.config],
        model: {
            alias: args.config === "off" ? "off" : (process.env.PI_SMARTREAD_JUDGE_MODEL ?? CLOUD_JUDGE_DEFAULT_MODEL),
            origin: args.config === "off" ? "off" : "cloud-openrouter",
        },
        manifest: {
            fixtureSha: manifest.queriesSha256,
            inventoryHashBefore: manifest.queriesSha256,
            corpusKind: "d46-pinned-checkouts",
            sourceRef: null,
            gateConstants: { ...GATE_CONSTANTS },
            retrievalConditions: {
                perQueryLimit: 20,
                topKWindow: 20,
                topKMetricWindow: 5,
                contextLines: 2,
                tokenBudget: READ_READY_DEFAULT_BUDGET,
                readReadyK: 5,
                unitMode: resolveGrepUnitMode(),
                maxPerFile: resolveGrepUnitMaxPerFile(),
                excerptLines: resolveGrepUnitExcerptLines(),
                ...ranking,
            },
            engineSourceHash: engineSourceHash,
            manifestSha256: manifest.queriesSha256,
            freezeSha256,
            rankingKnobs: ranking,
            queryCount: queries.length,
        },
        judge: {
            config: args.config,
            model: args.config === "off" ? "off" : (process.env.PI_SMARTREAD_JUDGE_MODEL ?? CLOUD_JUDGE_DEFAULT_MODEL),
            origin: args.config === "off" ? "off" : "cloud-openrouter",
        },
        metricDefinitions: {
            successAt5: "answerable query with any gold file among the first five distinct rendered files in rank order",
            recallAt5: "gold files in the first five distinct rendered files / all gold files",
            precisionAt5: "gold files in the first five distinct rendered files / distinct files shown (<=5)",
            mrr: "1 / rank of the first gold file in distinct-file order, else 0",
            ndcgAt5: "graded nDCG@5 with gain(grade 1)=2, gain(grade 2)=1 and IDCG from ALL gold files",
            readReadyAt5: "a gold span overlapped by RENDERED gutter lines of a top-5 unit (first five rendered units) within the token budget",
            falseEmpty: "answerable query with zero rendered results",
            falseContent: "absence query with any rendered hit",
            unexpectedJudge: "exact_ish query where the judge ran under literal/regex routing",
        },
        adapterNotes:
            "variant-matrix adapter: map manifest -> PairedReport.manifest (fixtureSha, inventoryHashBefore, corpusKind, gateConstants, retrievalConditions) and queries[] -> PairedReport.queries (qid, fileHit, readReady, covered, abstained, renderedTokens).",
        summary: { ...summary, overall: { ...summary.overall, ...aggregateD46(scoredRows) } },
        queries: rows,
    };
    const reportsDir = resolveD46ReportsDir(args.reportsDir ?? overrides.reportsDir ?? null);
    mkdirSync(reportsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = join(reportsDir, `d46-${args.split}-${args.config}-${stamp}-${randomBytes(4).toString("hex")}.json`);
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    chmodSync(out, 0o600);
    console.log(`report: ${out} status=${report.status}`);
    return 0;
}

const invokedAsCli =
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    (process.argv[1].endsWith("d46/run.ts") || process.argv[1].endsWith("d46\\run.ts"));
if (invokedAsCli) {
    runD46Cli(process.argv.slice(2)).then(
        (code) => { process.exitCode = code; },
        (error) => {
            console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 2;
        },
    );
}
