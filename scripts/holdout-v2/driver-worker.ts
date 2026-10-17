#!/usr/bin/env node
/**
 * §9.16 driver worker: one process-group member processing pairs in run.ts order.
 *
 * Spawned by driver-run.ts with `detached: true` (own process group) and
 * its config as JSON on stdin. It mirrors the frozen runner's per-instance loop
 * (run.ts:488-648) using the engine's exported functions loaded from
 * --engine-root, emits phase markers (setup-start/setup-end per instance,
 * query-start/query-end per pair) on stdout as `@@DRIVER <json>` lines, and
 * appends one fsync'd checkpoint record per completed pair before starting
 * the next. Harness teardown mirrors run.ts:722-728.
 *
 * The worker never decides kills or retries; the supervisor owns the
 * watchdog. On startup it reloads the checkpoint and skips resolved pairs,
 * so a fresh worker resumes exactly where a killed one stopped.
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendCheckpointRecord, loadCheckpoint, pairKey } from "./driver-checkpoint.js";

export interface WorkerConfig {
    engineRoot: string;
    /** Canonical owned root, or null for legacy homedir mode (mirrors run.ts). */
    stateRoot: string | null;
    owned: boolean;
    offline: boolean;
    timeoutMs: number;
    checkpointPath: string;
    /** Selected instances, post-dataset-resolution, in run.ts loop order. */
    instances: Array<Record<string, unknown> & { instanceId: string; repo: string; baseCommit: string }>;
    /** Frozen-manifest pin authority, run.ts:289-301 (null in legacy pilot mode). */
    manifestEntries: Record<string, { repo: string; baseCommit: string; dataset: string }> | null;
    /** Resolved dataset revision for pin-mismatch receipts (run.ts:509). */
    revision: string;
    formulations: string[];
    /** Pair keys this worker must process, in run.ts order. */
    assignedPairs: string[];
    /** 1-based launch counter (lets tests stage once-only faults). */
    launchIndex: number;
}

/** Generated worker-file suffix: `.worker-<now>-<counter>.json`. */
export const WORKER_CONFIG_SUFFIX_RE = /\.worker-\d+-\d+\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate consumed worker-config shape. Throws a generic error (no raw
 * config content) on mismatch. Extra per-instance fields are preserved.
 */
export function validateWorkerConfig(value: unknown): WorkerConfig {
    if (!isRecord(value)) throw new Error("worker config: invalid shape");
    const engineRoot = value["engineRoot"];
    const stateRoot = value["stateRoot"];
    const owned = value["owned"];
    const offline = value["offline"];
    const timeoutMs = value["timeoutMs"];
    const checkpointPath = value["checkpointPath"];
    const instances = value["instances"];
    const manifestEntries = value["manifestEntries"];
    const revision = value["revision"];
    const formulations = value["formulations"];
    const assignedPairs = value["assignedPairs"];
    const launchIndex = value["launchIndex"];
    if (typeof engineRoot !== "string" || engineRoot === "") throw new Error("worker config: invalid engineRoot");
    if (typeof stateRoot !== "string" && stateRoot !== null) throw new Error("worker config: invalid stateRoot");
    if (typeof stateRoot === "string" && stateRoot === "") throw new Error("worker config: invalid stateRoot");
    if (typeof owned !== "boolean") throw new Error("worker config: invalid owned");
    if (typeof offline !== "boolean") throw new Error("worker config: invalid offline");
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("worker config: invalid timeoutMs");
    if (typeof checkpointPath !== "string" || checkpointPath === "") throw new Error("worker config: invalid checkpointPath");
    if (!Array.isArray(instances)) throw new Error("worker config: invalid instances");
    const cleanInstances: WorkerConfig["instances"] = instances.map((entry) => {
        if (!isRecord(entry)) throw new Error("worker config: invalid instance");
        if (typeof entry["instanceId"] !== "string" || entry["instanceId"] === "") throw new Error("worker config: invalid instanceId");
        if (typeof entry["repo"] !== "string" || entry["repo"] === "") throw new Error("worker config: invalid instance repo");
        if (typeof entry["baseCommit"] !== "string" || entry["baseCommit"] === "") throw new Error("worker config: invalid instance baseCommit");
        return { ...entry, instanceId: entry["instanceId"], repo: entry["repo"], baseCommit: entry["baseCommit"] };
    });
    if (manifestEntries !== null) {
        if (!isRecord(manifestEntries)) throw new Error("worker config: invalid manifestEntries");
        for (const entry of Object.values(manifestEntries)) {
            if (!isRecord(entry)) throw new Error("worker config: invalid manifest entry");
            if (typeof entry["repo"] !== "string" || entry["repo"] === "") throw new Error("worker config: invalid manifest entry repo");
            if (typeof entry["baseCommit"] !== "string" || entry["baseCommit"] === "") throw new Error("worker config: invalid manifest entry baseCommit");
            if (typeof entry["dataset"] !== "string" || entry["dataset"] === "") throw new Error("worker config: invalid manifest entry dataset");
        }
    }
    if (typeof revision !== "string") throw new Error("worker config: invalid revision");
    if (!Array.isArray(formulations) || formulations.length === 0 || formulations.some((f) => typeof f !== "string" || f === "")) {
        throw new Error("worker config: invalid formulations");
    }
    if (!Array.isArray(assignedPairs) || assignedPairs.some((p) => typeof p !== "string")) throw new Error("worker config: invalid assignedPairs");
    if (typeof launchIndex !== "number" || !Number.isInteger(launchIndex) || launchIndex < 1) throw new Error("worker config: invalid launchIndex");
    return {
        engineRoot,
        stateRoot,
        owned,
        offline,
        timeoutMs,
        checkpointPath,
        instances: cleanInstances,
        manifestEntries: manifestEntries as WorkerConfig["manifestEntries"],
        revision,
        formulations: formulations as string[],
        assignedPairs: assignedPairs as string[],
        launchIndex,
    };
}

/**
 * Read the worker config from a stdin stream.
 *
 * Bounded: refuses a TTY, caps total bytes, and times out a stream that
 * never ends. Parses strict JSON, then runs the same shape validation the
 * file path used. Rejects before any engine import or checkpoint mutation.
 * Errors are generic and never embed config content.
 */
export async function readWorkerConfigFromStdin(
    stream: NodeJS.ReadableStream = process.stdin,
    opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<WorkerConfig> {
    const maxBytes = opts.maxBytes ?? MAX_WORKER_CONFIG_BYTES;
    const timeoutMs = opts.timeoutMs ?? WORKER_CONFIG_STDIN_TIMEOUT_MS;
    if ((stream as { isTTY?: unknown }).isTTY === true) throw new Error("worker config: stdin is a TTY");
    const chunks: Array<Buffer> = [];
    let total = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await new Promise<void>((resolvePromise, reject) => {
            const cleanup = (): void => {
                stream.off("data", onData);
                stream.off("end", onEnd);
                stream.off("error", onError);
            };
            const onData = (chunk: Buffer | string): void => {
                const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
                total += buf.length;
                if (total > maxBytes) {
                    cleanup();
                    reject(new Error("worker config: input too large"));
                    return;
                }
                chunks.push(buf);
            };
            const onEnd = (): void => {
                cleanup();
                resolvePromise();
            };
            const onError = (error: Error): void => {
                cleanup();
                reject(error);
            };
            timer = setTimeout(() => {
                cleanup();
                reject(new Error("worker config: stdin timeout"));
            }, timeoutMs);
            timer.unref();
            stream.on("data", onData);
            stream.on("end", onEnd);
            stream.on("error", onError);
        });
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.length === 0) throw new Error("worker config: empty stdin");
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("worker config: malformed JSON");
    }
    return validateWorkerConfig(parsed);
}

const MARKER_PREFIX = "@@DRIVER ";

function emitMarker(marker: Record<string, unknown>): void {
    process.stdout.write(`${MARKER_PREFIX}${JSON.stringify(marker)}\n`);
}

/**
 * Pin-mismatch receipts for one instance (run.ts:493-516): the exclusion
 * plus, in owned mode, the datasetFailure carrying the resolved dataset
 * revision (run.ts:506-513, where `revision` is the run's dataset revision,
 * never "unknown" — unknown is only the loader-failure receipt revision).
 */
export function pinMismatchRecords(
    entry: { repo: string; baseCommit: string; dataset: string },
    instance: { instanceId: string; repo: string; baseCommit: string },
    revision: string,
): { exclusion: Record<string, unknown>; datasetFailure: Record<string, unknown> } {
    const pinnedRef = `${entry.repo}@${entry.baseCommit}`;
    const rowRef = `${instance.repo}@${instance.baseCommit}`;
    return {
        exclusion: {
            instanceId: instance.instanceId,
            reason: "pin-mismatch",
            stage: "dataset",
            dataset: entry.dataset,
            pinned: pinnedRef,
            row: rowRef,
        },
        datasetFailure: {
            dataset: entry.dataset,
            revision,
            error: `pin-mismatch: manifest ${pinnedRef} vs row ${rowRef}`.slice(0, 200),
            instanceIds: [instance.instanceId],
        },
    };
}

/**
 * Maximum worker-config stdin payload: real configs are tens of kilobytes
 * (one JSON object with the assigned instance rows); 4 MiB leaves wide
 * headroom while bounding worker memory on hostile input.
 */
export const MAX_WORKER_CONFIG_BYTES = 4 * 1024 * 1024;

/** How long the worker waits for its stdin config before giving up. */
export const WORKER_CONFIG_STDIN_TIMEOUT_MS = 30_000;

/**
 * The worker takes no pathname and no flags: the driver feeds the config on
 * stdin. Any argv (including the removed `--config FILE`) is rejected so a
 * stale launcher fails closed instead of running unconfigured.
 */
export function parseWorkerArgs(argv: string[]): void {
    if (argv.length > 0) throw new Error(`error: unknown argument: ${argv[0]}`);
}

// Engine module surface used here (structural; loaded from --engine-root).
interface EngineRepos {
    ensureBareClone: (repo: string, opts: { stateRoot?: string | null; offline?: boolean }) => string;
    materializeInstance: (instance: unknown, opts: { stateRoot?: string | null; offline?: boolean }) => unknown;
    assertCanonicalBaseCommit: (baseCommit: string) => void;
    bareRepoDirUnder: (stateRoot: string, repo: string) => string;
    snapshotDirUnder: (stateRoot: string, instanceId: string) => string;
}
interface EngineAdapter {
    runOwnGrep: (instance: unknown, root: string, formulation: string, timeoutMs: number) => Promise<Record<string, unknown>>;
    toReportOutcome: (result: Record<string, unknown>) => Record<string, unknown>;
}
interface EngineTeardown {
    disposeSemanticIndexes: () => void;
    shutdownAllManagers: () => Promise<void>;
    resetLSPBridge: () => void;
}

async function loadEngine(engineRoot: string): Promise<{ repos: EngineRepos; adapter: EngineAdapter; teardown: EngineTeardown }> {
    const url = (rel: string): string => pathToFileURL(join(engineRoot, rel)).href;
    const repos = (await import(url("scripts/eval/external/grep/repos.ts"))) as EngineRepos;
    const adapter = (await import(url("scripts/eval/external/grep/adapter.ts"))) as EngineAdapter;
    const registry = (await import(url("src/indexing/semantic-index-registry.ts"))) as {
        disposeSemanticIndexes: () => void;
    };
    const bridge = (await import(url("src/lsp/lsp-bridge.ts"))) as {
        shutdownAllManagers: () => Promise<void>;
        resetLSPBridge: () => void;
    };
    return {
        repos,
        adapter,
        teardown: {
            disposeSemanticIndexes: registry.disposeSemanticIndexes,
            shutdownAllManagers: bridge.shutdownAllManagers,
            resetLSPBridge: bridge.resetLSPBridge,
        },
    };
}

export async function runWorker(rawConfig: WorkerConfig): Promise<number> {
    const config = validateWorkerConfig(rawConfig);
    const { repos, adapter, teardown } = await loadEngine(config.engineRoot);
    const assigned = new Set(config.assignedPairs);
    try {
        for (const instance of config.instances) {
            const mine = config.formulations.filter((f) => assigned.has(pairKey(instance.instanceId, f)));
            if (mine.length === 0) continue;
            const state = loadCheckpoint(config.checkpointPath);
            if (mine.every((f) => state.outcomes.has(pairKey(instance.instanceId, f)))) continue;
            if (state.exclusions.some((e) => e["instanceId"] === instance.instanceId)) continue;
            if ((state.setupKills.get(instance.instanceId) ?? 0) >= 2) continue;
            // Per-instance setup block, mirroring run.ts:488-638.
            emitMarker({ phase: "setup-start", instanceId: instance.instanceId });
            let root: string | null = null;
            // Owned-mode root a thrown stage was attempting (run.ts:478-487).
            const attemptedOwnedRoot = (stage: "clone" | "materialize"): string | null => {
                if (!config.owned || config.stateRoot === null) return null;
                try {
                    return stage === "clone"
                        ? repos.bareRepoDirUnder(config.stateRoot, instance.repo)
                        : repos.snapshotDirUnder(config.stateRoot, instance.instanceId);
                } catch {
                    return null;
                }
            };
            const canonicalizeCheckedRoot = (p: string): string => {
                try {
                    return realpathSync(p);
                } catch {
                    return p;
                }
            };
            const recordAttempt = (attempt: Record<string, unknown>): void => {
                appendCheckpointRecord(config.checkpointPath, { v: 1, kind: "attempt", attempt });
            };
            // Frozen-manifest pin binding (run.ts:489-516).
            const entry = config.manifestEntries?.[instance.instanceId];
            if (entry !== undefined && (entry.repo !== instance.repo || entry.baseCommit !== instance.baseCommit)) {
                const { exclusion, datasetFailure } = pinMismatchRecords(entry, instance, config.revision);
                appendCheckpointRecord(config.checkpointPath, {
                    v: 1,
                    kind: "excluded",
                    instanceId: instance.instanceId,
                    exclusion,
                });
                if (config.owned) {
                    appendCheckpointRecord(config.checkpointPath, {
                        v: 1,
                        kind: "dataset-failure",
                        datasetFailure,
                    });
                }
                emitMarker({ phase: "setup-end", instanceId: instance.instanceId, excluded: true });
                continue;
            }
            // Owned pin gate before ensureBareClone (run.ts:521-544).
            if (config.owned) {
                try {
                    repos.assertCanonicalBaseCommit(instance.baseCommit);
                } catch (error) {
                    const message = error instanceof Error ? error.message : "unknown";
                    const attempted = attemptedOwnedRoot("materialize");
                    appendCheckpointRecord(config.checkpointPath, {
                        v: 1,
                        kind: "excluded",
                        instanceId: instance.instanceId,
                        exclusion: {
                            instanceId: instance.instanceId,
                            reason: `materialize-error:${message.slice(0, 120)}`,
                            stage: "preflight",
                            root: attempted,
                            createdFresh: null,
                        },
                    });
                    recordAttempt({
                        instanceId: instance.instanceId,
                        root: attempted,
                        stage: "preflight",
                        outcome: "refused",
                        createdFresh: null,
                    });
                    emitMarker({ phase: "setup-end", instanceId: instance.instanceId, excluded: true });
                    continue;
                }
            }
            let stage: "clone" | "materialize" = "clone";
            let excluded = false;
            try {
                repos.ensureBareClone(instance.repo, { stateRoot: config.stateRoot, offline: config.offline });
                stage = "materialize";
                const mat = repos.materializeInstance(instance, { stateRoot: config.stateRoot, offline: config.offline }) as
                    | { root: string; createdFresh: boolean; preflightCounts?: unknown }
                    | { excluded: true; reason: string; missing: string[]; root?: string; createdFresh?: boolean; preflightCounts?: unknown }
                    | { failed: true; root: string; createdFresh: boolean; completedStage: string; error: string; preflightCounts?: unknown };
                if ("failed" in mat) {
                    recordAttempt({
                        instanceId: instance.instanceId,
                        root: canonicalizeCheckedRoot(mat.root),
                        stage: mat.completedStage,
                        outcome: "failed",
                        createdFresh: mat.createdFresh,
                        ...(mat.preflightCounts !== undefined ? { preflightCounts: mat.preflightCounts } : {}),
                    });
                    appendCheckpointRecord(config.checkpointPath, {
                        v: 1,
                        kind: "excluded",
                        instanceId: instance.instanceId,
                        exclusion: {
                            instanceId: instance.instanceId,
                            reason: `materialize-error:${mat.error.slice(0, 120)}`,
                            stage: mat.completedStage,
                            root: mat.root,
                            createdFresh: mat.createdFresh,
                        },
                    });
                    excluded = true;
                } else if ("excluded" in mat) {
                    if ("root" in mat && typeof mat.root === "string") {
                        recordAttempt({
                            instanceId: instance.instanceId,
                            root: canonicalizeCheckedRoot(mat.root),
                            stage: "materialize",
                            outcome: "excluded",
                            createdFresh: mat.createdFresh ?? null,
                            ...(mat.preflightCounts !== undefined ? { preflightCounts: mat.preflightCounts } : {}),
                        });
                        appendCheckpointRecord(config.checkpointPath, {
                            v: 1,
                            kind: "excluded",
                            instanceId: instance.instanceId,
                            exclusion: {
                                instanceId: instance.instanceId,
                                reason: mat.reason,
                                missing: mat.missing,
                                stage: "materialize",
                                root: mat.root,
                                createdFresh: mat.createdFresh ?? null,
                            },
                        });
                    } else {
                        appendCheckpointRecord(config.checkpointPath, {
                            v: 1,
                            kind: "excluded",
                            instanceId: instance.instanceId,
                            exclusion: { instanceId: instance.instanceId, reason: mat.reason, missing: mat.missing, stage: "materialize" },
                        });
                    }
                    excluded = true;
                } else {
                    root = mat.root;
                    recordAttempt({
                        instanceId: instance.instanceId,
                        root: canonicalizeCheckedRoot(root),
                        stage: "materialize",
                        outcome: "success",
                        createdFresh: "createdFresh" in mat ? mat.createdFresh : null,
                        ...(mat.preflightCounts !== undefined ? { preflightCounts: mat.preflightCounts } : {}),
                    });
                }
            } catch (error) {
                // Thrown stage (run.ts:615-638): legacy keeps the bare shape,
                // owned records the attempted root with unknown freshness.
                const message = error instanceof Error ? error.message : "unknown";
                const reason = `materialize-error:${message.slice(0, 120)}`;
                if (!config.owned) {
                    appendCheckpointRecord(config.checkpointPath, {
                        v: 1,
                        kind: "excluded",
                        instanceId: instance.instanceId,
                        exclusion: { instanceId: instance.instanceId, reason, stage: "materialize" },
                    });
                    excluded = true;
                } else {
                    const attempted = attemptedOwnedRoot(stage);
                    appendCheckpointRecord(config.checkpointPath, {
                        v: 1,
                        kind: "excluded",
                        instanceId: instance.instanceId,
                        exclusion: { instanceId: instance.instanceId, reason, stage, root: attempted, createdFresh: null },
                    });
                    recordAttempt({
                        instanceId: instance.instanceId,
                        root: attempted,
                        stage,
                        outcome: message.startsWith("refuses-") ? "refused" : "failed",
                        createdFresh: null,
                    });
                    excluded = true;
                }
            }
            emitMarker({ phase: "setup-end", instanceId: instance.instanceId, ...(excluded ? { excluded: true } : {}) });
            if (excluded || root === null) continue;
            for (const formulation of mine) {
                const pair = pairKey(instance.instanceId, formulation);
                const fresh = loadCheckpoint(config.checkpointPath);
                if (fresh.outcomes.has(pair)) continue;
                emitMarker({ phase: "query-start", pair, instanceId: instance.instanceId, formulation });
                process.stdout.write(`[${instance.instanceId}] ${formulation} ... `);
                const result = await adapter.runOwnGrep(instance, root, formulation, config.timeoutMs);
                const outcome = adapter.toReportOutcome(result);
                console.log(
                    `${String(result["status"])} success@5=${String(result["successAt5"])} recall@5=${Number(result["recallAt5"]).toFixed(2)} ` +
                        `cards=${Array.isArray(result["shownCards"]) ? (result["shownCards"] as unknown[]).length : 0} tok=${String(result["renderedTokens"])} ${Math.round(Number(result["elapsedMs"]))}ms`,
                );
                emitMarker({ phase: "query-end", pair, instanceId: instance.instanceId, formulation });
                appendCheckpointRecord(config.checkpointPath, {
                    v: 1,
                    kind: "outcome",
                    pair,
                    outcome: outcome as Record<string, unknown>,
                });
            }
        }
        return 0;
    } finally {
        teardown.disposeSemanticIndexes();
        await teardown.shutdownAllManagers();
        teardown.resetLSPBridge();
    }
}

const invokedAsWorker =
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    process.argv[1].endsWith("driver-worker.ts");
if (invokedAsWorker) {
    void (async () => {
        try {
            parseWorkerArgs(process.argv.slice(2));
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            process.exitCode = 2;
            return;
        }
        try {
            process.exitCode = await runWorker(await readWorkerConfigFromStdin());
        } catch (error) {
            console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        }
    })();
}
