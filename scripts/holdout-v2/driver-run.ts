#!/usr/bin/env node
/**
 * §9.16 external kill-and-resume driver for the retrieval holdout.
 *
 * Executes the frozen runner semantics (run.ts, esp. ~300-713) against the
 * frozen engine at --engine-root WITHOUT modifying it: owned+manifest
 * holdout path, owned state root claim/validation, manifest loading and
 * integrity, instance selection and ORDER, pin gates, exclusion and dataset
 * receipts, ranking knobs via env, judge off, per-pair runOwnGrep with the
 * 60 s internal limit, summarizeMetrics, digest, report naming/mode 0600 and
 * teardown. Anything run.ts does that is not engine-exported is
 * re-implemented minimally with the mirrored run.ts lines cited.
 *
 * Supervision (§9.16): a supervisor spawns a worker with `detached: true`
 * (own process group). The worker processes pairs in run.ts order, emits
 * phase markers and appends one fsync'd checkpoint record per pair.
 * The watchdog kills hung queries (120 s → `timeout:watchdog-query`) and
 * stalled setups (10 × 60 s checks under 5 CPU-s with no progress, 30 min
 * hard cap → retry once, then `error:watchdog-setup` for both formulations).
 * Kill procedure is SIGTERM to -pgid, 10 s grace, SIGKILL, then a survivor
 * check that stops for owner review on survivors. Thresholds live in
 * driver-thresholds.ts and are overridable ONLY via test-only injection.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { appendCheckpointRecord, loadCheckpoint, pairKey } from "./driver-checkpoint.js";
import { assembleDriverReport, buildWatchdogOutcome, type DeletionAttemptLite, type DriverEngineFns } from "./driver-report.js";
import { DRIVER_THRESHOLDS, FROZEN_ENGINE_HASH, type DriverThresholds } from "./driver-thresholds.js";
import { countStatusClasses } from "./status-classes.js";
import type { WorkerConfig } from "./driver-worker.js";

// ---------------------------------------------------------------------------
// Arguments (run.ts:79-132 mirrored, plus driver-only flags).
// ---------------------------------------------------------------------------

export interface DriverArgs {
    split: string;
    formulations: string[];
    limit: number | null;
    timeoutMs: number;
    seed: string;
    offline: boolean;
    multiSweBench: boolean;
    manifestPath: string | null;
    openHoldout: boolean;
    stateRoot: string | null;
    engineRoot: string;
    mode: "warm" | "cold-per-pair";
    resume: string | null;
}

function takeValue(flag: string, argv: string[], i: number): string {
    const value = argv[i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value (got ${value ?? "nothing"})`);
    return value;
}

export function parseDriverArgs(argv: string[]): DriverArgs {
    let split = "pilot";
    let formulationArg = "both";
    let limit: number | null = null;
    let timeoutMs = 60000;
    let seed = "external-grep-v1";
    let offline = false;
    let multiSweBench = false;
    let manifestPath: string | null = null;
    let openHoldout = false;
    let stateRoot: string | null = null;
    let engineRoot: string | null = null;
    let mode: "warm" | "cold-per-pair" = "warm";
    let resume: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--split") split = takeValue(arg, argv, ++i);
        else if (arg === "--formulation") formulationArg = takeValue(arg, argv, ++i);
        else if (arg === "--limit") limit = Number(takeValue(arg, argv, ++i));
        else if (arg === "--timeout-ms") timeoutMs = Number(takeValue(arg, argv, ++i));
        else if (arg === "--seed") seed = takeValue(arg, argv, ++i);
        else if (arg === "--offline") offline = true;
        else if (arg === "--multi-swe-bench") multiSweBench = true;
        else if (arg === "--manifest") manifestPath = takeValue(arg, argv, ++i);
        else if (arg === "--state-root") stateRoot = takeValue(arg, argv, ++i);
        else if (arg === "--open-holdout") openHoldout = true;
        else if (arg === "--accept-license-review") continue;
        else if (arg === "--engine-root") engineRoot = takeValue(arg, argv, ++i);
        else if (arg === "--mode") {
            const m = takeValue(arg, argv, ++i);
            if (m !== "warm" && m !== "cold-per-pair") throw new Error(`--mode must be warm|cold-per-pair (got ${m})`);
            mode = m;
        } else if (arg === "--resume") resume = takeValue(arg, argv, ++i);
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: driver-run.ts --engine-root DIR [--mode warm|cold-per-pair] [--resume CKPT] [run.ts flags...]");
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (engineRoot === null) throw new Error("--engine-root <frozen engine worktree> is required");
    // License gates mirrored from run.ts:121-125.
    if (multiSweBench || manifestPath !== null) assertLicenseAccepted(argv);
    if (manifestPath !== null) {
        if (!["dev", "holdout"].includes(split)) throw new Error("--split must be dev|holdout with --manifest");
    } else if (split === "holdout") {
        throw new Error("--split holdout requires --manifest (the holdout only exists frozen)");
    } else if (!["pilot", "dev"].includes(split)) throw new Error("--split must be pilot|dev");
    if (!["title", "body", "both"].includes(formulationArg)) throw new Error("--formulation must be title|body|both");
    const formulations: string[] = formulationArg === "both" ? ["title", "body"] : [formulationArg];
    return { split, formulations, limit, timeoutMs, seed, offline, multiSweBench, manifestPath, openHoldout, stateRoot, engineRoot, mode, resume };
}

function assertLicenseAccepted(argv: string[]): void {
    if (!argv.includes("--accept-license-review")) {
        throw new Error("refuses: frozen manifests span Multi-SWE-bench rows; re-run with --accept-license-review (D12)");
    }
}

// ---------------------------------------------------------------------------
// Test-only injection (never CLI flags, so study runs cannot alter thresholds).
// ---------------------------------------------------------------------------

export interface GroupProcess {
    pid: number;
    pgid: number;
    cpuS: number;
}

export interface WorkerHandle {
    pid: number;
    pgid: number;
    /** Subscribe to worker stdout lines (markers arrive prefixed). */
    onLine: (cb: (line: string) => void) => void;
    wait: () => Promise<{ code: number | null; signal: string | null }>;
}

export interface SupervisorEngine extends DriverEngineFns {
    // Dataset + selection (run.ts:46-69 mirrored usage).
    fetchAllRows: (opts: { offline: boolean; cacheDir?: string }) => Promise<unknown[]>;
    datasetRevision: (rows: unknown[]) => string;
    rowsToInstances: (rows: unknown[]) => { instances: InstanceLite[]; skipped: Array<{ instanceId: string; reason: string }> };
    ensureDatasetFileCached: (file: string, opts: { offline: boolean; cacheDir?: string }) => Promise<void>;
    readCachedRows: (file: string, cacheDir?: string) => Promise<unknown[]>;
    msbRowsToInstances: (rows: unknown[]) => { instances: InstanceLite[]; skipped: Array<{ instanceId: string; reason: string }> };
    MULTI_SWE_BENCH_FILES: string[];
    multiSweBenchFileRepo: (file: string) => string | null;
    // Manifest (frozen-manifest.ts:21,45).
    loadFrozenManifest: (path: string) => FrozenManifestLite;
    frozenSplitIds: (manifest: FrozenManifestLite, split: string, opts: { openHoldout: boolean }) => { ids: string[]; holdoutWarning: string | null };
    // Pilot path (sampling.ts:75,130,159).
    selectPilot: (instances: InstanceLite[], seed: string) => InstanceLite[];
    freezeManifest: (instances: InstanceLite[], pilot: InstanceLite[], seed: string, revision: string) => { pilot: string[]; dev: string[]; sha256: string };
    writeManifest: (manifest: unknown) => string;
    // Owned roots (repos.ts:46,196,397,402).
    resolveExternalStateRoot: (cliValue: string | null | undefined) => string | null;
    ensureOwnedStateRoot: (root: string) => OwnedPaths;
    bareRepoDirUnder: (stateRoot: string, repo: string) => string;
    snapshotDirUnder: (stateRoot: string, instanceId: string) => string;
    // Identity + knobs (grep-e2e-contract.ts:90,302; run-identity.ts:36; grep-ranking.ts:96).
    hashEngineSources: (gitRoot: string) => string;
    gitRootFromScript: (scriptUrl: string) => string | null;
    resolveGrepRankingOptions: () => Record<string, unknown>;
    toRankReportSettings: (options: Record<string, unknown>) => Record<string, unknown>;
}

export interface InstanceLite {
    instanceId: string;
    repo: string;
    baseCommit: string;
    [key: string]: unknown;
}

export interface FrozenManifestLite {
    dev: Array<{ id: string; repo: string; baseCommit: string; dataset: string }>;
    holdout: Array<{ id: string; repo: string; baseCommit: string; dataset: string }>;
    sha256: string;
}

export interface OwnedPaths {
    root: string;
    reposDir: string;
    snapshotsDir: string;
    multilingualDir: string;
    multiSweBenchDir: string;
    reportsDir: string;
}

export interface DriverTestHooks {
    thresholds?: Partial<DriverThresholds>;
    /** Supervisor tick interval (default 15 s). Test-only. */
    tickMs?: number;
    /** Sampler interval; null disables (default: thresholds.loadSampleMs). Test-only. */
    samplerMs?: number | null;
    nodeArgs?: string[];
    workerEntry?: string;
    launchWorker?: (spec: { nodeArgs: string[]; entry: string; configPath: string; cwd: string }) => Promise<WorkerHandle>;
    listGroup?: (pgid: number) => Promise<GroupProcess[]>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    expectedEngineHash?: string;
    loadEngine?: (engineRoot: string) => Promise<SupervisorEngine>;
    maxExtraLaunches?: number;
    runId?: string;
    cwd?: string;
}

export class StopForReview extends Error {}

// ---------------------------------------------------------------------------
// Process-group primitives (§9.16 kill procedure).
// ---------------------------------------------------------------------------

function parseCpuTime(text: string): number {
    const t = text.trim();
    if (t === "" || t === "-") return 0;
    let days = 0;
    let rest = t;
    const dash = t.indexOf("-");
    if (dash >= 0) {
        days = Number(t.slice(0, dash)) || 0;
        rest = t.slice(dash + 1);
    }
    const parts = rest.split(":").map((p) => Number(p));
    if (parts.some((p) => !Number.isFinite(p))) return 0;
    let seconds = 0;
    if (parts.length === 3) seconds = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    else if (parts.length === 2) seconds = parts[0]! * 60 + parts[1]!;
    else if (parts.length === 1) seconds = parts[0]!;
    return days * 86400 + seconds;
}

function execFileAsync(file: string, args: string[]): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        execFile(file, args, { encoding: "utf8" }, (error, stdout) => {
            if (error) reject(error);
            else resolvePromise(stdout);
        });
    });
}

/** List processes with their group and CPU seconds (default: one `ps` call). */
export async function defaultListGroup(pgid: number): Promise<GroupProcess[]> {
    const out = await execFileAsync("ps", ["-e", "-o", "pid=,pgid=,cputime="]);
    const rows: GroupProcess[] = [];
    for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const pid = Number(parts[0]);
        const g = Number(parts[1]);
        if (!Number.isInteger(pid) || !Number.isInteger(g) || g !== pgid) continue;
        rows.push({ pid, pgid: g, cpuS: parseCpuTime(parts.slice(2).join(" ")) });
    }
    return rows;
}

async function defaultSleep(ms: number): Promise<void> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * §9.16 kill procedure: SIGTERM to -pgid, grace, SIGKILL, then verify no
 * group member survives. Survivors stop for owner review (never more workers).
 */
export async function killProcessTree(
    pgid: number,
    graceMs: number,
    listGroup: (pgid: number) => Promise<GroupProcess[]>,
    sleep: (ms: number) => Promise<void>,
): Promise<void> {
    try {
        process.kill(-pgid, "SIGTERM");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return;
        throw error;
    }
    const deadline = Date.now() + graceMs;
    for (;;) {
        const members = await listGroup(pgid).catch(() => [] as GroupProcess[]);
        if (members.length === 0) return;
        if (Date.now() >= deadline) break;
        await sleep(250);
    }
    try {
        process.kill(-pgid, "SIGKILL");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") throw error;
    }
    const sigkillDeadline = Date.now() + 5000;
    for (;;) {
        const members = await listGroup(pgid).catch(() => [] as GroupProcess[]);
        if (members.length === 0) return;
        if (Date.now() >= sigkillDeadline) {
            throw new StopForReview(`worker group ${pgid} survives SIGKILL: pids ${members.map((m) => m.pid).join(",")}; stopping for owner review`);
        }
        await sleep(250);
    }
}

// ---------------------------------------------------------------------------
// Supervisor.
// ---------------------------------------------------------------------------

interface SupervisorDeps {
    engine: SupervisorEngine;
    thresholds: DriverThresholds;
    tickMs: number;
    samplerMs: number | null;
    nodeArgs: string[];
    workerEntry: string;
    launchWorker: (spec: { nodeArgs: string[]; entry: string; configPath: string; cwd: string }) => Promise<WorkerHandle>;
    listGroup: (pgid: number) => Promise<GroupProcess[]>;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    expectedEngineHash: string;
    maxExtraLaunches: number;
    cwd: string;
}

interface KillEvent {
    at: string;
    reason: "query-watchdog" | "setup-stall" | "setup-hard-cap" | "query-completed-during-kill" | "crash-restart" | "clean-exit-restart";
    instanceId?: string;
    pair?: string;
    elapsedMs?: number;
}

function defaultWorkerEntry(): string {
    return join(dirname(fileURLToPath(import.meta.url)), "driver-worker.ts");
}

async function defaultLoadEngine(engineRoot: string): Promise<SupervisorEngine> {
    const url = (rel: string): string => new URL(`file://${resolve(engineRoot, rel)}`).href;
    const grepDir = "scripts/eval/external/grep";
    const [fetch1, msb, frozen, sampling, repos, contract, identity, ranking, metrics] = await Promise.all([
        import(url(`${grepDir}/swebench-multilingual.ts`)),
        import(url(`${grepDir}/multi-swe-bench.ts`)),
        import(url(`${grepDir}/frozen-manifest.ts`)),
        import(url(`${grepDir}/sampling.ts`)),
        import(url(`${grepDir}/repos.ts`)),
        import(url(`scripts/eval/judge/grep-e2e-contract.ts`)),
        import(url(`${grepDir}/run-identity.ts`)),
        import(url(`src/search/grep-ranking.ts`)),
        import(url(`${grepDir}/metrics.ts`)),
    ]);
    // multiSweBenchFileRepo is module-private in run.ts (run.ts:203-210);
    // re-implemented here minimally (same mapping, cited).
    const multiSweBenchFileRepo = (file: string): string | null => {
        const base = file.split("/").pop() ?? file;
        const suffix = "_dataset.jsonl";
        const stem = base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
        const sep = stem.indexOf("__");
        if (sep <= 0 || sep === stem.length - 2) return null;
        return `${stem.slice(0, sep)}/${stem.slice(sep + 2)}`.toLowerCase();
    };
    void repos.bareRepoDirUnder;
    return {
        fetchAllRows: fetch1.fetchAllRows,
        datasetRevision: fetch1.datasetRevision,
        rowsToInstances: fetch1.rowsToInstances,
        ensureDatasetFileCached: msb.ensureDatasetFileCached,
        readCachedRows: msb.readCachedRows,
        msbRowsToInstances: msb.msbRowsToInstances,
        MULTI_SWE_BENCH_FILES: msb.MULTI_SWE_BENCH_FILES,
        multiSweBenchFileRepo,
        loadFrozenManifest: frozen.loadFrozenManifest,
        frozenSplitIds: frozen.frozenSplitIds,
        selectPilot: sampling.selectPilot,
        freezeManifest: sampling.freezeManifest,
        writeManifest: sampling.writeManifest,
        resolveExternalStateRoot: repos.resolveExternalStateRoot,
        ensureOwnedStateRoot: repos.ensureOwnedStateRoot,
        bareRepoDirUnder: repos.bareRepoDirUnder,
        snapshotDirUnder: repos.snapshotDirUnder,
        hashEngineSources: contract.hashEngineSources,
        gitRootFromScript: identity.gitRootFromScript,
        resolveGrepRankingOptions: ranking.resolveGrepRankingOptions,
        toRankReportSettings: contract.toRankReportSettings,
        computeInstanceMetrics: metrics.computeInstanceMetrics,
        summarizeMetrics: metrics.summarizeMetrics,
        computeExternalRunDigest: identity.computeExternalRunDigest,
    };
}

export async function launchDetachedWorker(spec: { nodeArgs: string[]; entry: string; configPath: string; cwd: string }): Promise<WorkerHandle> {
    if (process.platform === "win32") throw new Error("refuses: process-group supervision (SIGTERM to -pgid) is POSIX-only");
    const child: ChildProcess = spawn("node", [...spec.nodeArgs, spec.entry, "--config", spec.configPath], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        cwd: spec.cwd,
    });
    if (child.pid === undefined) throw new Error("worker spawn failed: no pid");
    const pid = child.pid;
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    const lineCallbacks: Array<(line: string) => void> = [];
    if (child.stdout !== null) {
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line) => {
            if (line.startsWith("@@DRIVER ")) {
                const marker = line.slice("@@DRIVER ".length);
                for (const cb of lineCallbacks) cb(marker);
            }
        });
    }
    return {
        pid,
        pgid: pid,
        onLine: (cb) => {
            lineCallbacks.push(cb);
        },
        wait: () =>
            new Promise((resolvePromise) => {
                child.on("exit", (code, signal) => resolvePromise({ code, signal }));
            }),
    };
}

function truncateDatasetError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 200);
}

function ownedMultilingualDir(owned: OwnedPaths | null): string {
    if (owned) return owned.multilingualDir;
    return join(homedir(), ".cache/pi-smartread-bench/datasets/swe-bench-multilingual");
}

function legacyReportsDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/reports");
}

function sha256File(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface DriverResult {
    reportPath: string;
    reportSha256: string;
    receiptPath: string;
    pairs: number;
    statusClasses: ReturnType<typeof countStatusClasses>;
    killEvents: KillEvent[];
    engineHashBefore: string;
    engineHashAfter: string;
}

/**
 * Run one supervised execution. Import-safe: no work happens on import.
 * Exit-code contract: 0 complete report; 2 usage/refusal; 3 stop-for-review.
 */
export async function runDriverCli(argv: string[], hooks: DriverTestHooks = {}): Promise<number> {
    let args: DriverArgs;
    try {
        args = parseDriverArgs(argv);
    } catch (error) {
        console.error(`error: ${(error as Error).message}`);
        return 2;
    }
    const thresholds: DriverThresholds = { ...DRIVER_THRESHOLDS, ...hooks.thresholds };
    let engine: SupervisorEngine;
    try {
        engine = hooks.loadEngine ? await hooks.loadEngine(args.engineRoot) : await defaultLoadEngine(args.engineRoot);
    } catch (error) {
        console.error(`error: cannot load engine at ${args.engineRoot}: ${(error as Error).message}`);
        return 2;
    }
    const deps: SupervisorDeps = {
        engine,
        thresholds,
        tickMs: hooks.tickMs ?? 15000,
        samplerMs: hooks.samplerMs === undefined ? thresholds.loadSampleMs : hooks.samplerMs,
        nodeArgs: hooks.nodeArgs ?? ["--import", "tsx"],
        workerEntry: hooks.workerEntry ?? defaultWorkerEntry(),
        launchWorker: hooks.launchWorker ?? launchDetachedWorker,
        listGroup: hooks.listGroup ?? defaultListGroup,
        sleep: hooks.sleep ?? defaultSleep,
        now: hooks.now ?? Date.now,
        expectedEngineHash: hooks.expectedEngineHash ?? FROZEN_ENGINE_HASH,
        maxExtraLaunches: hooks.maxExtraLaunches ?? 10,
        cwd: hooks.cwd ?? process.cwd(),
    };
    try {
        await runSupervised(args, deps, hooks);
        return 0;
    } catch (error) {
        if (error instanceof StopForReview) {
            console.error(`error: stop-for-review: ${error.message}`);
            return 3;
        }
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
    }
}

interface PrePhase {
    owned: OwnedPaths | null;
    canonicalStateRoot: string | null;
    rankingKnobs: Record<string, unknown>;
    engineSourceHash: string;
    revision: string;
    manifestPath: string;
    manifestSha256: string;
    manifestEntries: Map<string, { id: string; repo: string; baseCommit: string; dataset: string }> | null;
    selected: InstanceLite[];
    pinnedRefs: string[];
    excluded: Array<Record<string, unknown>>;
    datasetFailures: Array<Record<string, unknown>>;
    canonicalReportsDir: string;
}

async function runSupervised(args: DriverArgs, deps: SupervisorDeps, hooks: DriverTestHooks): Promise<DriverResult> {
    const { engine } = deps;
    // Engine hash BEFORE (refuses on mismatch, §9.16).
    const engineHashBefore = engine.hashEngineSources(args.engineRoot);
    if (engineHashBefore !== deps.expectedEngineHash) {
        throw new Error(`refuses: engine hash mismatch before execution: ${engineHashBefore} (expected ${deps.expectedEngineHash})`);
    }
    // Owned state root claim BEFORE anything else (run.ts:228-243).
    let owned: OwnedPaths | null = null;
    const canonicalStateRoot = engine.resolveExternalStateRoot(args.stateRoot);
    if (canonicalStateRoot !== null) {
        if (args.manifestPath === null) {
            throw new Error("--state-root requires --manifest <frozen> (pilot freeze writes to the legacy cache)");
        }
        try {
            owned = engine.ensureOwnedStateRoot(canonicalStateRoot);
        } catch (error) {
            throw new Error((error as Error).message);
        }
    }
    if (args.offline && !existsSync(ownedMultilingualDir(owned))) {
        throw new Error("--offline with no cached dataset rows; run once online first");
    }
    // Ranking knobs via env (run.ts:260), judge off by construction.
    const rankingKnobs = engine.toRankReportSettings(engine.resolveGrepRankingOptions()) as Record<string, unknown>;
    // Dataset loads with owned receipts (run.ts:272-281).
    let rows: unknown[] = [];
    const datasetLoadFailures: Array<{ dataset: string; file?: string; error: string }> = [];
    try {
        rows = await engine.fetchAllRows({ offline: args.offline, cacheDir: owned?.multilingualDir });
    } catch (error) {
        if (owned === null) throw error;
        datasetLoadFailures.push({ dataset: "swe-bench-multilingual", error: truncateDatasetError(error) });
    }
    const revision = datasetLoadFailures.length > 0 ? "unknown" : engine.datasetRevision(rows);
    const { instances, skipped } = engine.rowsToInstances(rows);
    const byId = new Map(instances.map((i) => [i.instanceId, i]));
    let manifestPath: string;
    let manifestSha256: string;
    let splitIds: string[];
    let manifestEntries: PrePhase["manifestEntries"] = null;
    const msbSkips: Array<{ instanceId: string; reason: string; dataset: string; file: string }> = [];
    if (args.manifestPath !== null) {
        // Frozen run: integrity + split selection (run.ts:292-327).
        const frozen = engine.loadFrozenManifest(args.manifestPath);
        const { ids, holdoutWarning } = engine.frozenSplitIds(frozen, args.split, { openHoldout: args.openHoldout });
        if (holdoutWarning !== null) console.log(holdoutWarning);
        manifestPath = args.manifestPath;
        manifestSha256 = frozen.sha256;
        manifestEntries = new Map((args.split === "dev" ? frozen.dev : frozen.holdout).map((e) => [e.id, e]));
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
            for (const file of engine.MULTI_SWE_BENCH_FILES) {
                try {
                    await engine.ensureDatasetFileCached(file, { offline: args.offline, cacheDir: owned?.multiSweBenchDir });
                    const converted = engine.msbRowsToInstances(await engine.readCachedRows(file, owned?.multiSweBenchDir));
                    for (const inst of converted.instances) {
                        if (!byId.has(inst.instanceId)) byId.set(inst.instanceId, inst);
                    }
                    for (const s of converted.skipped) msbSkips.push({ ...s, dataset: "multi-swe-bench", file });
                } catch (error) {
                    if (owned === null) throw error;
                    datasetLoadFailures.push({ dataset: "multi-swe-bench", file, error: truncateDatasetError(error) });
                }
            }
        }
        splitIds = ids;
    } else {
        const pilot = engine.selectPilot(instances, args.seed);
        const manifest = engine.freezeManifest(instances, pilot, args.seed, revision);
        manifestPath = engine.writeManifest(manifest);
        manifestSha256 = manifest.sha256;
        splitIds = args.split === "pilot" ? manifest.pilot : manifest.dev;
    }
    let selected = splitIds.map((id) => byId.get(id)).filter((i): i is InstanceLite => i !== undefined);
    if (args.limit !== null) selected = selected.slice(0, args.limit);
    // Dataset-stage resolution (run.ts:346-380).
    const splitIdSet = new Set(splitIds);
    const unresolvedIds = splitIds.filter((id) => !byId.has(id));
    const unresolvedSet = new Set(unresolvedIds);
    const loaderSkips: Array<{ instanceId: string; reason: string; dataset: string; file?: string }> = [
        ...skipped.map((s) => ({ instanceId: s.instanceId, reason: s.reason, dataset: "swe-bench-multilingual" })),
        ...msbSkips,
    ];
    const firstSelectedSkip = new Map<string, { instanceId: string; reason: string; dataset: string; file?: string }>();
    for (const s of loaderSkips) {
        if (splitIdSet.has(s.instanceId) && unresolvedSet.has(s.instanceId) && !firstSelectedSkip.has(s.instanceId)) {
            firstSelectedSkip.set(s.instanceId, s);
        }
    }
    const excluded: Array<Record<string, unknown>> = [];
    for (const s of loaderSkips) {
        if (splitIdSet.has(s.instanceId) && unresolvedSet.has(s.instanceId)) {
            if (firstSelectedSkip.get(s.instanceId) !== s) continue;
            excluded.push({
                instanceId: s.instanceId,
                reason: s.reason,
                stage: "dataset",
                dataset: s.dataset,
                ...(s.file !== undefined ? { file: s.file } : {}),
            });
        } else if (s.dataset === "swe-bench-multilingual") {
            excluded.push({ instanceId: s.instanceId, reason: s.reason, stage: "loader" });
        }
    }
    for (const id of unresolvedIds) {
        if (firstSelectedSkip.has(id)) continue;
        excluded.push({ instanceId: id, reason: "manifest-id-unresolved", stage: "dataset" });
    }
    // Owned-only datasetFailures (run.ts:386-450).
    const datasetFailures: Array<Record<string, unknown>> = [];
    if (owned !== null) {
        const unresolvedWithoutSkip = unresolvedIds.filter((id) => !firstSelectedSkip.has(id));
        const failedLoaderOwnsId = (f: { dataset: string; file?: string }, id: string): boolean => {
            const entry = manifestEntries?.get(id);
            if (entry === undefined || entry.dataset !== f.dataset) return false;
            if (f.dataset === "multi-swe-bench") {
                return f.file !== undefined && engine.multiSweBenchFileRepo(f.file) === entry.repo.toLowerCase();
            }
            return true;
        };
        for (const f of datasetLoadFailures) {
            datasetFailures.push({
                dataset: f.dataset,
                ...(f.file !== undefined ? { file: f.file } : {}),
                revision: "unknown",
                error: f.error,
                instanceIds: unresolvedWithoutSkip.filter((id) => failedLoaderOwnsId(f, id)),
            });
        }
        if (datasetLoadFailures.length === 0) {
            const groups = new Map<string, Record<string, unknown>>();
            for (const id of unresolvedWithoutSkip) {
                const key = manifestEntries?.get(id)?.dataset ?? "unknown";
                let group = groups.get(key);
                if (group === undefined) {
                    group = {
                        dataset: key,
                        revision,
                        error: "manifest-id-unresolved: no convertible row in any cached dataset",
                        instanceIds: [],
                    };
                    groups.set(key, group);
                    datasetFailures.push(group);
                }
                (group["instanceIds"] as string[]).push(id);
            }
        }
        const conversionGroups = new Map<string, Record<string, unknown>>();
        for (const id of splitIds) {
            const s = firstSelectedSkip.get(id);
            if (s === undefined) continue;
            const key = `${s.dataset} ${s.file ?? ""} ${s.reason}`;
            let group = conversionGroups.get(key);
            if (group === undefined) {
                group = {
                    dataset: s.dataset,
                    ...(s.file !== undefined ? { file: s.file } : {}),
                    revision,
                    error: `unconvertible-row: ${s.reason}`.slice(0, 200),
                    instanceIds: [],
                };
                conversionGroups.set(key, group);
                datasetFailures.push(group);
            }
            (group["instanceIds"] as string[]).push(id);
        }
    }
    // Pinned refs (run.ts:681-684).
    const pinnedRefs = selected.map((i) => {
        const entry = manifestEntries?.get(i.instanceId);
        return entry !== undefined ? `${entry.repo}@${entry.baseCommit}` : `${i.repo}@${i.baseCommit}`;
    });
    const canonicalReportsDir = owned ? owned.reportsDir : legacyReportsDir();
    mkdirSync(canonicalReportsDir, { recursive: true });
    // Checkpoint path: fresh or resumed.
    const runId = hooks.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
    const checkpointPath = args.resume ?? join(canonicalReportsDir, `driver-checkpoint-${runId}.jsonl`);
    const samplerPath = `${checkpointPath}.load.log`;
    const argsPath = `${checkpointPath}.args.json`;
    const argFingerprint = { split: args.split, formulations: args.formulations, seed: args.seed, manifestPath: args.manifestPath ? realpathSync(args.manifestPath) : null, stateRoot: canonicalStateRoot, engineRoot: resolve(args.engineRoot), timeoutMs: args.timeoutMs, mode: args.mode, limit: args.limit, offline: args.offline };
    if (args.resume !== null) {
        if (!existsSync(checkpointPath)) throw new Error(`--resume checkpoint does not exist: ${checkpointPath}`);
        if (!existsSync(argsPath)) throw new Error(`--resume checkpoint has no args record: ${argsPath}`);
        const prior = JSON.parse(readFileSync(argsPath, "utf8"));
        if (JSON.stringify(prior) !== JSON.stringify(argFingerprint)) {
            throw new Error("--resume args differ from the checkpoint's recorded args; refusing to resume");
        }
    } else {
        if (existsSync(checkpointPath)) throw new Error(`refusing to overwrite existing checkpoint: ${checkpointPath}`);
        writeFileSync(argsPath, JSON.stringify(argFingerprint, null, 2), { mode: 0o600 });
    }
    // Pair list in run.ts order: selected instances × formulations (run.ts:639-648).
    const pairs = selected.flatMap((i) => args.formulations.map((f) => pairKey(i.instanceId, f)));
    const killEvents: KillEvent[] = [];
    const restarts = { count: 0 };
    let launches = 0;
    const nominalLaunches = args.mode === "cold-per-pair" ? pairs.length : 1;
    // Supervise until every pair is present exactly once.
    for (;;) {
        const state = loadCheckpoint(checkpointPath);
        const excludedIds = new Set(state.exclusions.map((e) => String(e["instanceId"])));
        const pending = pairs.filter((p) => {
            if (state.outcomes.has(p)) return false;
            const [instanceId] = JSON.parse(p) as [string, string];
            return !excludedIds.has(instanceId);
        });
        if (pending.length === 0) break;
        // Nominal launches (1 warm, 1 per pair cold) are always allowed;
        // only relaunches beyond the extra budget stop for review.
        if (launches - nominalLaunches >= deps.maxExtraLaunches) {
            throw new StopForReview(`worker relaunch budget exhausted (${launches} launches); stopping for owner review`);
        }
        const assigned = args.mode === "cold-per-pair" ? [pending[0]!] : pending;
        launches += 1;
        await runOneWorker(args, deps, { owned, canonicalStateRoot, selected, manifestEntries, checkpointPath, samplerPath, assigned, killEvents, restarts, launchIndex: launches, revision });
    }
    // Final assembly in run.ts order, only when every pair is resolved
    // exactly once. Excluded instances yield exclusion receipts, not pairs
    // (run.ts:573-604 `continue` before the formulation loop).
    const state = loadCheckpoint(checkpointPath);
    const excludedIds = new Set(state.exclusions.map((e) => String(e["instanceId"])));
    const outcomes: Array<Record<string, unknown>> = [];
    for (const instance of selected) {
        if (excludedIds.has(instance.instanceId)) continue;
        for (const formulation of args.formulations) {
            const p = pairKey(instance.instanceId, formulation);
            const outcome = state.outcomes.get(p);
            if (outcome === undefined) throw new Error(`refuses: pair ${p} has no checkpointed outcome; no report assembled`);
            outcomes.push(outcome);
        }
    }
    const generatedAt = new Date().toISOString();
    const { reportPath, digest, sha256 } = assembleDriverReport({
        engine: deps.engine,
        split: args.split,
        formulations: args.formulations,
        seed: args.seed,
        revision,
        manifestPath,
        manifestSha256,
        owned,
        canonicalReportsDir,
        engineSourceHash: engineHashBefore,
        rankingKnobs,
        excluded: [...excluded, ...state.exclusions],
        datasetFailures: [...datasetFailures, ...state.datasetFailures],
        attempts: state.attempts as unknown as DeletionAttemptLite[],
        outcomes,
        pinnedRefs,
        generatedAt,
    });
    // Engine hash AFTER every execution (refuses on mismatch, §9.16).
    const engineHashAfter = engine.hashEngineSources(args.engineRoot);
    if (engineHashAfter !== deps.expectedEngineHash) {
        throw new Error(`refuses: engine hash mismatch after execution: ${engineHashAfter} (expected ${deps.expectedEngineHash})`);
    }
    const statusClasses = countStatusClasses(outcomes.map((o) => ({ status: String(o["status"]) })));
    // Sidecar run receipt (JSON, 0600) next to the report.
    const here = dirname(fileURLToPath(import.meta.url));
    const driverFiles = ["driver-run.ts", "driver-worker.ts", "driver-checkpoint.ts", "driver-report.ts", "driver-thresholds.ts", "status-classes.ts"];
    const receipt = {
        driver: "holdout-v2-driver-run",
        mode: args.mode,
        engineRoot: resolve(args.engineRoot),
        expectedEngineHash: deps.expectedEngineHash,
        engineHashBefore,
        engineHashAfter,
        driverFileSha256s: Object.fromEntries(driverFiles.map((f) => [f, sha256File(join(here, f))])),
        thresholds: deps.thresholds,
        tickMs: deps.tickMs,
        args: argFingerprint,
        pairs: pairs.length,
        outcomes: outcomes.length,
        excludedCount: excluded.length + state.exclusions.length,
        statusClasses,
        killEvents,
        restarts: restarts.count,
        tornLineDropped: state.tornLineDropped,
        checkpointPath,
        samplerPath,
        reportPath,
        reportSha256: sha256,
        digest,
        generatedAt,
    };
    const receiptPath = `${checkpointPath}.receipt.json`;
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(`\nreport: ${reportPath}`);
    console.log(`manifest: ${manifestPath} (split=${args.split} selected=${selected.length})`);
    console.log(`summary: outcomes=${outcomes.length} errors=${statusClasses.total - statusClasses.counts.ok - statusClasses.counts["over-token-cap"]} excluded=${excluded.length + state.exclusions.length}`);
    console.log(`receipt: ${receiptPath}`);
    console.log(`watchdog: ${killEvents.length} kill events, ${restarts.count} restarts`);
    return { reportPath, reportSha256: sha256, receiptPath, pairs: pairs.length, statusClasses, killEvents, engineHashBefore, engineHashAfter };
}

interface WorkerRunContext {
    owned: OwnedPaths | null;
    canonicalStateRoot: string | null;
    selected: InstanceLite[];
    manifestEntries: Map<string, { id: string; repo: string; baseCommit: string; dataset: string }> | null;
    checkpointPath: string;
    samplerPath: string;
    assigned: string[];
    killEvents: KillEvent[];
    restarts: { count: number };
    launchIndex: number;
    /** Resolved dataset revision, passed to workers for pin-mismatch receipts. */
    revision: string;
}

type Phase =
    | { kind: "idle" }
    | { kind: "setup"; instanceId: string; start: number; lastProgress: number; stallChecks: number; cpuAtCheck: number }
    | { kind: "query"; pair: string; instanceId: string; formulation: string; start: number };

let workerLaunchCounter = 0;

/**
 * Producer for the internal authority-bearing worker config.
 *
 * Exclusive creation (`O_EXCL`) at mode `0600` with `O_NOFOLLOW` on POSIX:
 * never truncates an existing file and never follows a pre-existing config
 * symlink. Throws a generic error (no config content) when the target
 * already exists.
 */
export function writeWorkerConfigFile(configPath: string, config: WorkerConfig): void {
    if (typeof configPath !== "string" || configPath === "") throw new Error("worker config: invalid path");
    const flags =
        process.platform === "win32"
            ? "wx"
            : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
    let fd: number;
    try {
        fd = openSync(configPath, flags, 0o600);
    } catch {
        throw new Error("worker config: refusing to overwrite existing file");
    }
    try {
        writeSync(fd, JSON.stringify(config));
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

async function runOneWorker(
    args: DriverArgs,
    deps: SupervisorDeps,
    ctx: WorkerRunContext,
): Promise<void> {
    const config: WorkerConfig = {
        engineRoot: resolve(args.engineRoot),
        stateRoot: ctx.canonicalStateRoot,
        owned: ctx.owned !== null,
        offline: args.offline,
        timeoutMs: args.timeoutMs,
        checkpointPath: ctx.checkpointPath,
        instances: ctx.selected as WorkerConfig["instances"],
        manifestEntries: ctx.manifestEntries ? Object.fromEntries(ctx.manifestEntries) : null,
        formulations: args.formulations,
        assignedPairs: ctx.assigned,
        launchIndex: ctx.launchIndex,
        revision: ctx.revision,
    };
    const configPath = `${ctx.checkpointPath}.worker-${deps.now()}-${(workerLaunchCounter += 1)}.json`;
    writeWorkerConfigFile(configPath, config);
    const worker = await deps.launchWorker({ nodeArgs: deps.nodeArgs, entry: deps.workerEntry, configPath, cwd: deps.cwd });
    const pgid = worker.pgid;
    let phase: Phase = { kind: "idle" };
    let lastStallCheckWall = 0;
    let lastSampleWall = 0;
    let treeCpuS = 0;
    let exited: { code: number | null; signal: string | null } | null = null;
    // Marker ingestion is synchronous with line arrival; evaluation happens on ticks.
    const ingest = (raw: string): void => {
        let marker: Record<string, unknown>;
        try {
            marker = JSON.parse(raw);
        } catch {
            return;
        }
        const now = deps.now();
        if (marker["phase"] === "setup-start") {
            phase = { kind: "setup", instanceId: String(marker["instanceId"]), start: now, lastProgress: now, stallChecks: 0, cpuAtCheck: treeCpuS };
            // Each setup's first 60 s stall window starts at its own
            // setup-start: a stale window from a previous setup in this
            // worker must not shorten (or lengthen) it.
            lastStallCheckWall = now;
        } else if (marker["phase"] === "setup-end") {
            phase = { kind: "idle" };
        } else if (marker["phase"] === "query-start") {
            phase = { kind: "query", pair: String(marker["pair"]), instanceId: String(marker["instanceId"]), formulation: String(marker["formulation"]), start: now };
        } else if (marker["phase"] === "query-end") {
            phase = { kind: "idle" };
        }
    };
    // Default and hook launchers deliver worker stdout lines via onLine.
    worker.onLine((line) => ingest(line));
    const exitPromise = worker.wait().then((result) => {
        exited = result;
        return result;
    });
    const sampleLoad = async (): Promise<void> => {
        if (deps.samplerMs === null) return;
        const members = await deps.listGroup(pgid).catch(() => [] as GroupProcess[]);
        const cpu = members.reduce((sum, m) => sum + m.cpuS, 0);
        // Sidecar log, created mode 0600 like the other driver sidecars.
        const fd = openSync(ctx.samplerPath, "a", 0o600);
        try {
            writeSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), loadavg: loadavg(), workerTreeCpuS: cpu, phase: phase.kind })}\n`);
        } finally {
            closeSync(fd);
        }
    };
    if (deps.samplerMs !== null) {
        lastSampleWall = deps.now();
        await sampleLoad();
    }
    const evaluate = async (): Promise<"continue" | "killed-query" | "killed-setup" | "exited"> => {
        if (exited !== null) return "exited";
        const now = deps.now();
        if (now - lastSampleWall >= (deps.samplerMs ?? Number.POSITIVE_INFINITY)) {
            lastSampleWall = now;
            await sampleLoad();
        }
        if (phase.kind === "query") {
            if (now - phase.start >= deps.thresholds.queryWatchdogMs) {
                await killProcessTree(pgid, deps.thresholds.killGraceMs, deps.listGroup, deps.sleep);
                const after = loadCheckpoint(ctx.checkpointPath);
                if (after.outcomes.has(phase.pair)) {
                    ctx.killEvents.push({ at: new Date().toISOString(), reason: "query-completed-during-kill", pair: phase.pair, elapsedMs: now - phase.start });
                } else {
                    const [instanceId, formulation] = JSON.parse(phase.pair) as [string, string];
                    const instance = ctx.selected.find((i) => i.instanceId === instanceId);
                    if (instance === undefined) throw new Error(`unknown pair in checkpoint: ${phase.pair}`);
                    const outcome = buildWatchdogOutcome(deps.engine, instance, formulation, "timeout:watchdog-query", now - phase.start);
                    appendCheckpointRecord(ctx.checkpointPath, { v: 1, kind: "outcome", pair: phase.pair, outcome });
                    ctx.killEvents.push({ at: new Date().toISOString(), reason: "query-watchdog", pair: phase.pair, elapsedMs: now - phase.start });
                }
                return "killed-query";
            }
        } else if (phase.kind === "setup") {
            // Hard cap is evaluated every tick; stall accounting below runs
            // on 60 s checks, not supervisor ticks (§9.16).
            if (now - phase.start >= deps.thresholds.setupHardCapMs) {
                await killProcessTree(pgid, deps.thresholds.killGraceMs, deps.listGroup, deps.sleep);
                await recordSetupKill(args.formulations, deps, ctx, phase.instanceId, now - phase.start, "setup-hard-cap");
                return "killed-setup";
            }
            // A check is stalled when the window since the previous check saw
            // no phase progress AND under 5 process-tree CPU-seconds.
            const windowStart = lastStallCheckWall;
            if (windowStart !== 0 && now - windowStart < deps.thresholds.setupCheckMs) {
                return "continue";
            }
            if (windowStart !== 0 && now - windowStart > deps.thresholds.setupCheckGapResetMs) phase.stallChecks = 0;
            lastStallCheckWall = now;
            const members = await deps.listGroup(pgid).catch(() => [] as GroupProcess[]);
            treeCpuS = members.reduce((sum, m) => sum + m.cpuS, 0);
            const progressed = windowStart === 0 ? phase.lastProgress >= phase.start : phase.lastProgress > windowStart;
            const cpuDelta = treeCpuS - phase.cpuAtCheck;
            if (!progressed && cpuDelta < deps.thresholds.setupStallCpuSeconds) phase.stallChecks += 1;
            else phase.stallChecks = 0;
            phase.cpuAtCheck = treeCpuS;
            if (phase.stallChecks >= deps.thresholds.setupStallChecks) {
                await killProcessTree(pgid, deps.thresholds.killGraceMs, deps.listGroup, deps.sleep);
                await recordSetupKill(args.formulations, deps, ctx, phase.instanceId, now - phase.start, "setup-stall");
                return "killed-setup";
            }
        }
        return "continue";
    };
    for (;;) {
        await Promise.race([exitPromise, deps.sleep(deps.tickMs)]);
        const verdict = await evaluate();
        if (verdict === "killed-query" || verdict === "killed-setup") {
            await exitPromise;
            return;
        }
        if (verdict === "exited") {
            const exitResult = await exitPromise;
            const state = loadCheckpoint(ctx.checkpointPath);
            const excludedIds = new Set(state.exclusions.map((e) => String(e["instanceId"])));
            const pending = ctx.assigned.filter((p) => {
                if (state.outcomes.has(p)) return false;
                const [instanceId] = JSON.parse(p) as [string, string];
                return !excludedIds.has(instanceId);
            });
            if (pending.length === 0) return;
            ctx.restarts.count += 1;
            ctx.killEvents.push({ at: new Date().toISOString(), reason: exitResult.code === 0 ? "clean-exit-restart" : "crash-restart" });
            return;
        }
    }
}

async function recordSetupKill(
    formulations: string[],
    deps: SupervisorDeps,
    ctx: WorkerRunContext,
    instanceId: string,
    elapsedMs: number,
    reason: "setup-stall" | "setup-hard-cap",
): Promise<void> {
    const after = loadCheckpoint(ctx.checkpointPath);
    const kills = (after.setupKills.get(instanceId) ?? 0) + 1;
    appendCheckpointRecord(ctx.checkpointPath, { v: 1, kind: "setup-kill", instanceId, at: new Date().toISOString(), elapsedMs });
    ctx.killEvents.push({ at: new Date().toISOString(), reason, instanceId, elapsedMs });
    if (kills >= 2) {
        // Second kill: both formulations recorded error:watchdog-setup
        // (§9.16); pairs already resolved keep their outcomes.
        const instance = ctx.selected.find((i) => i.instanceId === instanceId);
        if (instance === undefined) throw new Error(`unknown instance in setup kill: ${instanceId}`);
        const latest = loadCheckpoint(ctx.checkpointPath);
        for (const formulation of formulations) {
            const pair = pairKey(instanceId, formulation);
            if (latest.outcomes.has(pair)) continue;
            const outcome = buildWatchdogOutcome(deps.engine, instance, formulation, "error:watchdog-setup", elapsedMs);
            appendCheckpointRecord(ctx.checkpointPath, { v: 1, kind: "outcome", pair, outcome });
        }
    }
}

const invokedAsCli =
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    process.argv[1].endsWith("holdout-v2/driver-run.ts");
if (invokedAsCli) {
    runDriverCli(process.argv.slice(2)).then(
        (code) => {
            process.exitCode = code;
        },
        (error) => {
            console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 2;
        },
    );
}
