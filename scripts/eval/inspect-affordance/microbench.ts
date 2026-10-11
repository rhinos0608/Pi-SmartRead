#!/usr/bin/env node
/**
 * Inspect-affordance resource microbench (construction-time recipe budgets).
 *
 * LOCAL/OFFLINE ONLY. No agent benchmarks, no product optimization, no
 * network, no installs, no paid model sessions. Census + baseline only.
 *
 * What it does:
 *  1. Census: bounded lstat traversal (never follows symlinks) of the pinned
 *     TEB checkouts listed in repos.json — file/byte dimensions per
 *     extension, supported-syntax availability, pinned commit verification.
 *     Never reads pilot/dev/holdout gold or query files.
 *  2. Baseline: runs the CURRENT file/directory structural engine paths
 *     (executeFileInspect / executeDirectoryInspect, no contextGraph, no LSP
 *     provider, no indexing) against isolated scratch COPIES of small pinned
 *     scopes, for engine-flag sets representative of the five approved views:
 *     overview, dependencies, architecture, change-review, routes.
 *
 * Isolation: pinned originals are only stat'ed (plus read-only
 * `git rev-parse HEAD`). All engine runs execute with cwd inside a fresh
 * mkdtemp scratch dir; benchmark-owned temp session file lives there too.
 * No cache writes touch the developer checkout, pinned originals, or live
 * user caches.
 *
 * Usage:
 *   npx tsx scripts/eval/inspect-affordance/microbench.ts [--census-only]
 *     [--baseline-only] [--out <path>] [--cold-samples <n>] [--warm-samples <n>]
 *
 * Raw JSON report lands under
 * ~/.cache/pi-smartread-bench/reports/inspect-affordance-<ts>.json unless
 * --out overrides it. Stdout prints a short human summary only.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import {
    chmodSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

/** Extensions with a pinned tree-sitter grammar in package.json dependencies. */
export const TREE_SITTER_EXTENSIONS: ReadonlySet<string> = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
]);
export const TREE_SITTER_D_TS_NOTE =
    "JS resolution may land in .d.ts declarations (see repos.json corpusNote); .d.ts counted as supported TypeScript.";

export interface CensusBuckets {
    files: number;
    bytes: number;
    byExt: Record<string, { files: number; bytes: number }>;
    supportedFiles: number;
    supportedBytes: number;
    skippedSymlinks: number;
    skippedDirs: string[];
    truncated: boolean;
}

export function emptyCensusBuckets(): CensusBuckets {
    return {
        files: 0,
        bytes: 0,
        byExt: {},
        supportedFiles: 0,
        supportedBytes: 0,
        skippedSymlinks: 0,
        skippedDirs: [],
        truncated: false,
    };
}

export function recordCensusFile(
    buckets: CensusBuckets,
    ext: string,
    bytes: number,
    supported: ReadonlySet<string> = TREE_SITTER_EXTENSIONS,
): void {
    buckets.files += 1;
    buckets.bytes += bytes;
    const slot = buckets.byExt[ext] ?? { files: 0, bytes: 0 };
    slot.files += 1;
    slot.bytes += bytes;
    buckets.byExt[ext] = slot;
    if (supported.has(ext)) {
        buckets.supportedFiles += 1;
        buckets.supportedBytes += bytes;
    }
}

/** Approved view → current-engine flag set (structural paths only, no graph/LSP). */
export type ApprovedView = "overview" | "dependencies" | "architecture" | "change-review" | "routes";

export function mapViewToFlags(
    view: ApprovedView,
    mode: "file" | "directory",
): Record<string, unknown> {
    switch (view) {
        case "overview":
            return mode === "directory" ? { mapTokens: 1024 } : {};
        case "dependencies":
            if (mode !== "file") throw new Error("dependencies view is file-mode only in this baseline");
            return { callDepth: 1, callDirection: "both" };
        case "architecture":
            if (mode !== "directory") throw new Error("architecture view is directory-mode only in this baseline");
            return { layers: true, boundaries: true };
        case "change-review":
            return { diff: "HEAD" };
        case "routes":
            return { routes: true };
    }
}

export interface ProjectedCaps {
    maxFilesPerScope: number;
    maxBytesPerScope: number;
    maxOutputBytes: number;
    maxWallMsPerStage: number;
    basis: string;
}

/**
 * Derive PROVISIONAL safety caps from census maxima. These are engineering
 * starting points, NOT experimentally proven defaults and NOT frozen stage
 * budgets. No wall-time budget is derived here: wall time is observed only.
 * No budget freeze for graph/selective views may be built on these until
 * those stages are measured in isolation.
 */
export function deriveProvisionalCaps(censusMax: { files: number; bytes: number }): {
    maxFilesPerScope: number;
    maxBytesPerScope: number;
    basis: string;
} {
    const ceil = (n: number): number => Math.max(1, Math.ceil(n));
    return {
        maxFilesPerScope: ceil(censusMax.files),
        maxBytesPerScope: ceil(censusMax.bytes),
        basis:
            "provisional engineering limits from census maxima; NOT experimentally proven defaults; no wall-time budget; no freeze until selective-view/graph stages are measured",
    };
}

// ── Census (pinned originals: stat + read-only git verify only) ────────────

const CENSUS_SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
    ".git",
    "node_modules",
    ".pi-smartread.tags.cache",
    ".pi-smartread.embeddings.cache",
]);
const CENSUS_MAX_FILES_PER_REPO = 500_000;

interface PinnedRepoMeta {
    owner: string;
    name: string;
    tag: string;
    commit: string;
    workingTree: string;
    tsFiles: number;
    locTs: number;
}

function readReposManifest(): { reposDir: string; repos: PinnedRepoMeta[] } {
    const manifestPath = join(homedir(), ".cache", "pi-smartread-bench", "teb", "repos.json");
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        reposDir: string;
        repos: Array<{
            owner: string;
            name: string;
            tag: string;
            commit: string;
            workingTree: string;
            tsFiles: number;
            locTs: number;
        }>;
    };
    const reposDir = raw.reposDir.replace(/^~(?=\/|$)/, homedir());
    return { reposDir, repos: raw.repos };
}

function extensionOf(fileName: string): string {
    const dot = fileName.lastIndexOf(".");
    if (dot <= 0) return "(no-ext)";
    return fileName.slice(dot).toLowerCase();
}

function censusRepo(root: string, buckets: CensusBuckets): void {
    const stack: string[] = [root];
    while (stack.length > 0) {
        if (buckets.files >= CENSUS_MAX_FILES_PER_REPO) {
            buckets.truncated = true;
            return;
        }
        const dir = stack.pop() as string;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            buckets.skippedDirs.push(dir);
            continue;
        }
        for (const entry of entries) {
            const full = join(dir, entry);
            let st;
            try {
                st = lstatSync(full);
            } catch {
                continue;
            }
            if (st.isSymbolicLink()) {
                buckets.skippedSymlinks += 1;
                continue; // never follow external symlinks
            }
            if (st.isDirectory()) {
                if (CENSUS_SKIP_DIR_NAMES.has(entry)) continue;
                stack.push(full);
            } else if (st.isFile()) {
                recordCensusFile(buckets, extensionOf(entry), st.size);
            }
        }
    }
}

function verifyPinnedCommit(repoRoot: string, expected: string): { head: string; match: boolean } {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return { head, match: head === expected };
}

// ── Baseline (isolated scratch copies, local engine only) ──────────────────

interface BaselineCase {
    view: ApprovedView;
    mode: "file" | "directory";
    /** Pinned repo dir name (<owner>__<name>) + scope subpath inside it. */
    repoDir: string;
    scope: string;
    /** File within scope for file-mode cases. */
    file?: string;
    maxScopeFiles: number;
}

const BASELINE_CASES: BaselineCase[] = [
    // Smallest corpus: full-repo structural paths stay bounded.
    { view: "overview", mode: "file", repoDir: "egoist__tsup", scope: ".", file: "src/index.ts", maxScopeFiles: 500 },
    { view: "overview", mode: "directory", repoDir: "egoist__tsup", scope: "src", maxScopeFiles: 500 },
    { view: "dependencies", mode: "file", repoDir: "egoist__tsup", scope: ".", file: "src/cli-main.ts", maxScopeFiles: 500 },
    { view: "routes", mode: "file", repoDir: "egoist__tsup", scope: ".", file: "src/index.ts", maxScopeFiles: 500 },
    { view: "routes", mode: "directory", repoDir: "egoist__tsup", scope: "src", maxScopeFiles: 500 },
    // One bounded mid-size scope: query-core package src (file-capped copy).
    { view: "architecture", mode: "directory", repoDir: "TanStack__query", scope: "packages/query-core/src", maxScopeFiles: 200 },
    { view: "change-review", mode: "directory", repoDir: "egoist__tsup", scope: "src", maxScopeFiles: 500 },
];

/** One measured sample. wallMs is parent-measured child-process runtime;
 * engineMs/importMs are measured inside the child. Failed or timed-out
 * child samples are recorded with status error/timeout and stay visible. */
interface SampleRow {
    status: "ok" | "error" | "timeout";
    outputBytes: number;
    outputLines: number;
    rssDeltaBytes: number;
    wallMs: number;
    engineMs: number;
    importMs: number;
    pid: number;
    notes: string;
}

interface SeamSample {
    status: "ok" | "error";
    wallMs: number;
    routeCount: number;
    notes: string;
}

interface CaseResult {
    case: BaselineCase;
    flags: Record<string, unknown>;
    /** Legacy combined baseline for directory mode (includes baseline
     * repo-map work); legacy file path for file mode. Neither isolates
     * future selective-view stage costs. */
    measurementKind: string;
    ready: boolean;
    scratchScope: { files: number; bytes: number };
    cold: SampleRow[];
    warm: SampleRow[];
    /** Honest isolated seam measurement (routes scan), one per child. */
    seam: SeamSample[];
    setupMs: number;
}

function copyBoundedScope(srcRoot: string, scope: string, dest: string, maxFiles: number): { files: number; bytes: number } {
    const src = join(srcRoot, scope);
    let files = 0;
    let bytes = 0;
    const stack: Array<{ from: string; to: string }> = [{ from: src, to: dest }];
    mkdirSync(dest, { recursive: true });
    while (stack.length > 0 && files < maxFiles) {
        const { from, to } = stack.pop() as { from: string; to: string };
        for (const entry of readdirSync(from)) {
            if (files >= maxFiles) break;
            const f = join(from, entry);
            const st = lstatSync(f);
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) {
                if (CENSUS_SKIP_DIR_NAMES.has(entry)) continue;
                const t = join(to, entry);
                mkdirSync(t, { recursive: true });
                stack.push({ from: f, to: t });
            } else if (st.isFile()) {
                cpSync(f, join(to, entry));
                files += 1;
                bytes += st.size;
            }
        }
    }
    return { files, bytes };
}

/**
 * Visible error sample: failed/timed-out child samples are never dropped.
 */
export function errorSample(reason: "error" | "timeout", notes: string): SampleRow {
    return {
        status: reason,
        outputBytes: 0,
        outputLines: 0,
        rssDeltaBytes: 0,
        wallMs: 0,
        engineMs: 0,
        importMs: 0,
        pid: -1,
        notes,
    };
}

interface ChildSamplePayload {
    engineMs: number;
    outputBytes: number;
    outputLines: number;
    rssDeltaBytes: number;
    status: "ok" | "error";
    notes: string;
}

interface ChildResultPayload {
    pid: number;
    importMs: number;
    samples: ChildSamplePayload[];
    seam: { status: "ok" | "error"; wallMs: number; routeCount: number; notes: string } | null;
}

/**
 * Child entry point: runs `repeats` engine samples in THIS process and
 * writes machine-readable results to outPath (mode 0600, inside the
 * parent-created scratch dir). All import/setup/engine timing is measured
 * here so the parent can report them separately from spawn overhead.
 */
async function runAsChild(caseIdx: number, scratchRoot: string, scopeRel: string, repeats: number, outPath: string): Promise<void> {
    const c = BASELINE_CASES[caseIdx];
    if (c === undefined) throw new Error(`unknown baseline case index ${caseIdx}`);
    const flags = mapViewToFlags(c.view, c.mode);
    const tImport = performance.now();
    const { executeFileInspect } = await import("../../../src/inspect/inspect-file-core.js");
    const { executeDirectoryInspect } = await import("../../../src/inspect/inspect-directory.js");
    const { scanRoutes } = await import("../../../src/inspect/route-extraction.js");
    const importMs = performance.now() - tImport;
    const samples: ChildSamplePayload[] = [];
    for (let r = 0; r < repeats; r += 1) {
        const rssBefore = process.memoryUsage().rss;
        const start = performance.now();
        let status: "ok" | "error" = "ok";
        let outputBytes = 0;
        let outputLines = 0;
        let note = "";
        try {
            const sessionFilePath = join(scratchRoot, "session.json");
            if (c.mode === "file") {
                const result = await executeFileInspect({
                    path: c.file as string,
                    cwd: join(scratchRoot, scopeRel),
                    sessionFilePath,
                    ...flags,
                    // No contextGraph / lspInspectionProvider: structural paths only.
                });
                outputBytes = result.byteLength;
                outputLines = result.lineCount;
                note = `mode=${result.mode} truncated=${result.truncated}`;
            } else {
                const result = await executeDirectoryInspect({
                    path: ".",
                    cwd: join(scratchRoot, scopeRel),
                    sessionFilePath,
                    ...flags,
                });
                outputBytes = result.byteLength;
                outputLines = result.lineCount;
                note = `mode=${result.mode} truncated=${result.truncated}`;
            }
        } catch (err) {
            status = "error";
            note = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
        samples.push({
            engineMs: performance.now() - start,
            outputBytes,
            outputLines,
            rssDeltaBytes: process.memoryUsage().rss - rssBefore,
            status,
            notes: note,
        });
    }
    // Honest isolated seam: direct routes-scan over the same scope dir.
    // This is the only selective-view constituent measured in isolation;
    // all other selective-view/graph stage costs remain unmeasured.
    let seam: ChildResultPayload["seam"];
    try {
        const seamStart = performance.now();
        const routeCount = scanRoutes(join(scratchRoot, scopeRel)).length;
        seam = { status: "ok", wallMs: performance.now() - seamStart, routeCount, notes: `scope=${scopeRel}` };
    } catch (err) {
        seam = { status: "error", wallMs: 0, routeCount: 0, notes: `error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const payload: ChildResultPayload = { pid: process.pid, importMs, samples, seam };
    writeFileSync(outPath, JSON.stringify(payload), { mode: 0o600 });
}

/** Per-child spawn timeout. Sequential execution only (benchmark loop). */
export const CHILD_TIMEOUT_MS = 120_000;

/**
 * Spawn one controlled child process (`npx tsx microbench.ts --child-run …`)
 * and wait for it. Returns parent-measured wall time, the child result
 * payload when present, and explicit timeout/spawn failure signals.
 * No environment values are recorded or logged; only a truncated stderr
 * tail is kept on failure for diagnosability.
 */
function runChildProcess(
    caseIdx: number,
    scratch: string,
    scopeRel: string,
    repeats: number,
): { wallMs: number; result: ChildResultPayload | null; timedOut: boolean; spawnError: string | null } {
    const outPath = join(scratch, `child-${caseIdx}x${repeats}.json`);
    const scriptPath = resolve(import.meta.dirname, "microbench.ts");
    const start = performance.now();
    let timedOut = false;
    let spawnError: string | null = null;
    try {
        const res = spawnSync(
            "npx",
            ["tsx", scriptPath, "--child-run", String(caseIdx), scratch, scopeRel, String(repeats), outPath],
            { timeout: CHILD_TIMEOUT_MS, encoding: "utf8", cwd: scratch },
        );
        const stderrTail = typeof res.stderr === "string" ? res.stderr.slice(-500) : "";
        if (res.error !== undefined) {
            const code = (res.error as NodeJS.ErrnoException).code ?? "error";
            if (code === "ETIMEDOUT") timedOut = true;
            spawnError = `spawn ${code}: ${(res.error as Error).message}; stderr: ${stderrTail}`;
        } else if (res.status !== 0) {
            spawnError = `exit ${String(res.status)}; stderr: ${stderrTail}`;
        }
    } catch (err) {
        spawnError = `spawn threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    const wallMs = performance.now() - start;
    let result: ChildResultPayload | null = null;
    if (!timedOut && existsSync(outPath)) {
        try {
            result = JSON.parse(readFileSync(outPath, "utf8")) as ChildResultPayload;
        } catch (err) {
            spawnError = `unparseable child result: ${err instanceof Error ? err.message : String(err)}`;
        }
    } else if (!timedOut && spawnError === null) {
        spawnError = "child produced no result file";
    }
    // Remove ONLY the result file this parent created; the scratch dir
    // itself is removed wholesale after the case (tracked below).
    try {
        rmSync(outPath, { force: true });
    } catch {
        /* best effort */
    }
    return { wallMs, result, timedOut, spawnError };
}

function pushChildSamples(
    target: SampleRow[],
    seam: SeamSample[],
    child: { wallMs: number; result: ChildResultPayload | null; timedOut: boolean; spawnError: string | null },
    label: string,
): void {
    if (child.result !== null) {
        for (const s of child.result.samples) {
            target.push({
                status: s.status,
                outputBytes: s.outputBytes,
                outputLines: s.outputLines,
                rssDeltaBytes: s.rssDeltaBytes,
                wallMs: child.wallMs,
                engineMs: s.engineMs,
                importMs: child.result.importMs,
                pid: child.result.pid,
                notes: s.notes,
            });
        }
        if (child.result.seam !== null) seam.push({ ...child.result.seam });
    }
    if (child.timedOut) {
        target.push({ ...errorSample("timeout", `${label}: child exceeded ${String(CHILD_TIMEOUT_MS)}ms and was killed`), wallMs: child.wallMs });
    } else if (child.result === null) {
        target.push({ ...errorSample("error", `${label}: ${child.spawnError ?? "unknown spawn failure"}`), wallMs: child.wallMs });
    }
}

function summarize(samples: SampleRow[]): { n: number; minMs: number; maxMs: number; meanMs: number } {
    if (samples.length === 0) return { n: 0, minMs: 0, maxMs: 0, meanMs: 0 };
    const walls = samples.map((s) => s.wallMs);
    return {
        n: samples.length,
        minMs: Math.min(...walls),
        maxMs: Math.max(...walls),
        meanMs: walls.reduce((a, b) => a + b, 0) / walls.length,
    };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { censusOnly: boolean; baselineOnly: boolean; out: string | undefined; cold: number; warm: number } {
    let censusOnly = false;
    let baselineOnly = false;
    let out: string | undefined;
    let cold = 1;
    let warm = 2;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--census-only") censusOnly = true;
        else if (a === "--baseline-only") baselineOnly = true;
        else if (a === "--out") out = argv[++i];
        else if (a === "--cold-samples") cold = Math.max(0, Number(argv[++i]) || 0);
        else if (a === "--warm-samples") warm = Math.max(0, Number(argv[++i]) || 0);
        else throw new Error(`unknown arg: ${a}`);
    }
    return { censusOnly, baselineOnly, out, cold, warm };
}

export async function runMicrobench(argv: string[]): Promise<{ reportPath: string; reportSha256: string }> {
    const opts = parseArgs(argv);
    const { reposDir, repos } = readReposManifest();
    const startedAt = new Date().toISOString();

    // Census over pinned originals (stat + read-only git verify; no content reads
    // of gold/query files, no traversal into .git/node_modules, no symlink follow).
    const census: Record<string, CensusBuckets & { pinned: { expected: string; head: string; match: boolean }; manifest: { tag: string; workingTree: string; tsFiles: number; locTs: number } }> = {};
    if (!opts.baselineOnly) {
        for (const r of repos) {
            const root = join(reposDir, `${r.owner}__${r.name}`);
            const buckets = emptyCensusBuckets();
            if (!existsSync(root)) {
                buckets.skippedDirs.push(`${root} (missing checkout)`);
            } else {
                censusRepo(root, buckets);
            }
            const pinned = existsSync(root) ? verifyPinnedCommit(root, r.commit) : { head: "(missing)", match: false };
            census[`${r.owner}/${r.name}`] = {
                ...buckets,
                pinned: { expected: r.commit, head: pinned.head, match: pinned.match },
                manifest: { tag: r.tag, workingTree: r.workingTree, tsFiles: r.tsFiles, locTs: r.locTs },
            };
        }
    }

    // Baseline in isolated scratch dirs. Each cold sample runs in an
    // INDEPENDENT FRESH child process (own pid, own module import); warm
    // samples are repeats WITHIN one controlled child process. Children run
    // SEQUENTIALLY (benchmark only). Only scratch dirs created below are
    // removed, each in a finally block.
    const cases: CaseResult[] = [];
    const unmeasured: string[] = [];
    const ownedScratch: string[] = [];
    if (!opts.censusOnly) {
        unmeasured.push(
            "call-graph-backed sections (callers/callees BFS, impact blast radius, hotspots fan-in): no contextGraph is built in this baseline, so graph-dependent sections degrade to unavailable; graph construction cost is UNMEASURED — do not budget it from these numbers.",
            "selective-view stage costs: directory cases below are a LEGACY COMBINED baseline (baseline repo-map work runs for every directory flag set); they do NOT isolate future selective-view stages (architecture/layers/boundaries/routes/change-review sections). Only the routes-scan seam is measured in isolation (see seam). All other selective-view/graph stage costs are UNMEASURED until implemented against reusable exported functions.",
            "wall-time budgets: no maxWallMsPerStage is frozen from these observations; wall time is observed only.",
            "script-mode composition, LSP navigation/diagnostics, embeddings/indexing: not invoked; costs unknown.",
            "change-review renders the committed diff surface only where the scratch git setup applies; full-repo HEAD diff cost on large corpora is not covered.",
            `Node 20 / Linux / Windows portability: measured runtime is ${process.version} on ${process.platform}; other-runtimes/other-OS numbers are explicitly UNVERIFIED and these maxima do not generalize.`,
        );
        for (const c of BASELINE_CASES) {
            const caseIdx = BASELINE_CASES.indexOf(c);
            const measurementKind = c.mode === "directory"
                ? "legacy-combined: includes baseline repo-map work on every directory case; NOT a selective-view stage cost"
                : "legacy-file-path: current file structural path; NOT a selective-view stage cost";
            const srcRoot = join(reposDir, c.repoDir);
            if (!existsSync(srcRoot)) {
                cases.push({
                    case: c, flags: mapViewToFlags(c.view, c.mode), measurementKind, ready: false,
                    scratchScope: { files: 0, bytes: 0 }, cold: [], warm: [], seam: [], setupMs: 0,
                });
                unmeasured.push(`${c.view}/${c.mode} on ${c.repoDir}: checkout missing, skipped.`);
                continue;
            }
            const setupStart = performance.now();
            const scratch = mkdtempSync(join(tmpdir(), "inspect-affordance-"));
            ownedScratch.push(scratch);
            try {
                const scopeRel = `scope-${c.mode}-${c.view}`.replace(/[^a-z0-9-]+/gi, "-");
                const copied = copyBoundedScope(srcRoot, c.scope, join(scratch, scopeRel), c.maxScopeFiles);
                if (copied.files >= c.maxScopeFiles) {
                    unmeasured.push(`${c.view}/${c.mode} on ${c.repoDir}/${c.scope}: scope copy hit the ${c.maxScopeFiles}-file cap; larger scopes unmeasured.`);
                }
                writeFileSync(join(scratch, "session.json"), JSON.stringify({ microbench: true }));
                if (c.view === "change-review") {
                    // Deterministic local diff surface: init repo, commit, then dirty one file.
                    execFileSync("git", ["init", "-q"], { cwd: join(scratch, scopeRel) });
                    execFileSync("git", ["add", "-A"], { cwd: join(scratch, scopeRel) });
                    execFileSync("git", ["-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-qm", "baseline"], {
                        cwd: join(scratch, scopeRel),
                    });
                    const entries = readdirSync(join(scratch, scopeRel));
                    const victim = entries.find((e) => e.endsWith(".ts"));
                    if (victim) {
                        const p = join(scratch, scopeRel, victim);
                        writeFileSync(p, `${readFileSync(p, "utf8")}\n// microbench dirty marker\n`);
                    }
                }
                const setupMs = performance.now() - setupStart;
                const flags = mapViewToFlags(c.view, c.mode);
                const cold: SampleRow[] = [];
                const warm: SampleRow[] = [];
                const seam: SeamSample[] = [];
                // Cold: one independent FRESH process per sample, sequential.
                for (let i = 0; i < opts.cold; i++) {
                    pushChildSamples(cold, seam, runChildProcess(caseIdx, scratch, scopeRel, 1), `cold sample ${i}`);
                }
                // Warm: repeats within ONE controlled child process.
                if (opts.warm > 0) {
                    pushChildSamples(warm, seam, runChildProcess(caseIdx, scratch, scopeRel, opts.warm), "warm repeats");
                }
                cases.push({ case: c, flags, measurementKind, ready: true, scratchScope: copied, cold, warm, seam, setupMs });
            } finally {
                // Clean up ONLY the scratch dir created above for this case.
                rmSync(scratch, { recursive: true, force: true });
                ownedScratch.splice(ownedScratch.indexOf(scratch), 1);
            }
        }
    }

    // Provisional safety caps from CENSUS maxima (not from wall-time
    // observations, and with no x4 fabrication). NOT frozen stage budgets;
    // no budget freeze for graph/selective views until those are measured.
    let censusMaxFiles = 0;
    let censusMaxBytes = 0;
    for (const buckets of Object.values(census)) {
        censusMaxFiles = Math.max(censusMaxFiles, buckets.files);
        censusMaxBytes = Math.max(censusMaxBytes, buckets.bytes);
    }
    const provisionalCaps = deriveProvisionalCaps({ files: censusMaxFiles, bytes: censusMaxBytes });

    const report = {
        kind: "inspect-affordance-resource-baseline",
        version: 2,
        startedAt,
        finishedAt: new Date().toISOString(),
        provenance: {
            runtime: `${process.version} on ${process.platform} (pinned actual benchmark runtime)`,
            package: JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../package.json"), "utf8")).version,
            manifest: "~/.cache/pi-smartread-bench/teb/repos.json",
            samples: { coldPerCase: opts.cold, warmPerCase: opts.warm },
            childTimeoutMs: CHILD_TIMEOUT_MS,
            isolation:
                "each cold sample runs in an INDEPENDENT FRESH child process (own pid; engine modules imported per child; importMs recorded separately); " +
                "warm samples are repeats WITHIN one controlled child process; children execute SEQUENTIALLY (benchmark only); " +
                "each child gets an isolated scratch copy + temp session file, no contextGraph/LSP provider; scratch dirs removed per case. " +
                "No environment or credential values are copied into scratch or recorded in the report.",
            note: "cold = fresh-process sample (parent wall includes spawn+import+engine; engineMs/importMs split reported per sample); warm = same-child repeat. Raw n reported per case; no p95, no before/after gain claims.",
        },
        census,
        censusCaps: { maxFilesPerRepo: CENSUS_MAX_FILES_PER_REPO, skipDirs: [...CENSUS_SKIP_DIR_NAMES], followSymlinks: false },
        baseline: cases.map((r) => ({
            ...r,
            summary: {
                cold: summarize(r.cold),
                warm: summarize(r.warm),
                nFailed: [...r.cold, ...r.warm].filter((s) => s.status !== "ok").length,
            },
        })),
        unmeasured,
        provisionalCaps,
        warnings: [
            "Source-witness task/gold selection must NOT use these measurements; scope/corpus inclusion stays source-defined.",
            "Directory cases are a LEGACY COMBINED baseline (baseline repo-map work included); they are NOT selective-view stage costs.",
            "provisionalCaps are provisional engineering limits from census maxima, NOT frozen stage budgets; no wall-time budget is set from these observations; no budget freeze for graph/selective views until measured.",
            "Node 20 / other-OS portability is explicitly UNVERIFIED; these maxima do not generalize beyond the pinned runtime.",
        ],
    };
    const defaultPath = join(
        homedir(),
        ".cache",
        "pi-smartread-bench",
        "reports",
        `inspect-affordance-${startedAt.replace(/[:.]/g, "-")}.json`,
    );
    const reportPath = opts.out ?? defaultPath;
    mkdirSync(join(reportPath, ".."), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    chmodSync(reportPath, 0o600);
    const reportSha256 = createHash("sha256").update(readFileSync(reportPath)).digest("hex");

    const caseLines = cases.map((r) => {
        const all = [...r.cold, ...r.warm];
        const failed = all.filter((s) => s.status !== "ok");
        const okEngine = all.filter((s) => s.status === "ok").map((s) => s.engineMs);
        const pids = [...new Set(all.map((s) => s.pid))].join(",");
        const seamOk = r.seam.filter((x) => x.status === "ok");
        return (
            `  ${r.case.view}/${r.case.mode} ${r.case.repoDir}/${r.case.scope}${r.case.file ? `#${r.case.file}` : ""}: ` +
            `scope=${r.scratchScope.files}f/${r.scratchScope.bytes}B ` +
            `cold[n=${r.cold.length}]=${summarize(r.cold).maxMs.toFixed(0)}ms(max parent-wall) ` +
            `engine-max=${okEngine.length > 0 ? Math.max(...okEngine).toFixed(0) : "n/a"}ms ` +
            `warm[n=${r.warm.length}]=${summarize(r.warm).meanMs.toFixed(0)}ms(mean parent-wall) ` +
            `out=${Math.max(0, ...all.map((s) => s.outputBytes))}B ` +
            `pids=[${pids}] failed=${failed.length} ` +
            `seam-routes-scan=${seamOk.length > 0 ? `${Math.max(...seamOk.map((x) => x.wallMs)).toFixed(0)}ms` : "n/a"} ` +
            `status=${failed.length === 0 && r.ready ? "ok" : "MIXED"}`
        );
    });
    const repoLines = Object.entries(census).map(
        ([k, v]) =>
            `  ${k}: files=${v.files} bytes=${v.bytes} supported=${v.supportedFiles}f/${v.supportedBytes}B ` +
            `symlinks-skipped=${v.skippedSymlinks}${v.truncated ? " TRUNCATED" : ""} pin=${v.pinned.match ? "match" : "MISMATCH"}`,
    );
    process.stdout.write(
        [
            "inspect-affordance microbench",
            `report: ${reportPath}`,
            `sha256: ${reportSha256}`,
            "census:",
            ...repoLines,
            "baseline (raw; cold=max parent-wall with engine split in JSON; warm=mean; failed samples stay visible; setup in JSON):",
            ...caseLines,
            `unmeasured facets: ${unmeasured.length} (see JSON)`,
            `provisional census caps (NOT frozen budgets; no wall-time budget): ${JSON.stringify(provisionalCaps)}`,
            `basename check: ${basename(reportPath)}`,
        ].join("\n") + "\n",
    );
    return { reportPath, reportSha256 };
}

const invokedAsCli =
    process.argv[1] !== undefined &&
    (process.argv[1].endsWith("inspect-affordance/microbench.ts") ||
        process.argv[1].endsWith("inspect-affordance\\microbench.ts"));
if (invokedAsCli) {
    const cliArgs = process.argv.slice(2);
    if (cliArgs[0] === "--child-run") {
        const [, idxS, scratch, scopeRel, repeatsS, outPath] = cliArgs;
        if (idxS === undefined || scratch === undefined || scopeRel === undefined || repeatsS === undefined || outPath === undefined) {
            process.stderr.write("microbench --child-run requires <caseIdx> <scratch> <scopeRel> <repeats> <outPath>\n");
            process.exitCode = 2;
        } else {
            runAsChild(Number(idxS), scratch, scopeRel, Number(repeatsS), outPath).then(
                () => undefined,
                (err: unknown) => {
                    process.stderr.write(`microbench child failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
                    process.exitCode = 1;
                },
            );
        }
    } else {
        runMicrobench(cliArgs).then(
            () => undefined,
            (err: unknown) => {
                process.stderr.write(`microbench failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
                process.exitCode = 1;
            },
        );
    }
}
