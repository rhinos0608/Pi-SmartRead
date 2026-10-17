/**
 * Report assembly for the §9.16 kill-and-resume driver.
 *
 * The report JSON has the identical schema/field order/types as the frozen
 * runner output (run.ts:653-715): generatedAt, engine, judge, split,
 * formulations, seed, datasetRevision, manifestPath, manifestCanonical,
 * manifestSha256, state, inputs, deletion, engineSourceHash, rankingKnobs,
 * summary, excluded, excludedCount, [datasetFailures], outcomes. File naming
 * (`external-grep-<split>-<ts>-<digest>.json`), the digest input shape
 * (run-identity.ts:27-33, run.ts:704-710) and mode 0600 match run.ts.
 *
 * Watchdog error outcomes reuse the engine's computeInstanceMetrics
 * (metrics.ts:65-109) with empty shown/rendered text, shaped by the
 * toReportOutcome convention (adapter.ts:47-51: drop renderedText, empty
 * shownCards, null routing) — the same shape run.ts uses for its own error
 * outcomes, where metrics stay zero/empty (metrics.ts:99-101).
 */

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Minimal structural view of a benchmark instance (engine-owned shape). */
export interface DriverInstance {
    instanceId: string;
    repo: string;
    baseCommit: string;
    [key: string]: unknown;
}

/** Engine functions the driver reuses (loaded from --engine-root at runtime). */
export interface DriverEngineFns {
    computeInstanceMetrics: (input: {
        instance: unknown;
        formulation: string;
        shown: unknown[];
        renderedText: string;
        elapsedMs: number;
        status: string;
    }) => Record<string, unknown>;
    summarizeMetrics: (metrics: unknown[]) => Record<string, unknown>;
    computeExternalRunDigest: (input: Record<string, unknown>) => string;
}

export interface DeletionAttemptLite {
    instanceId: string;
    root: string | null;
    stage: string;
    outcome: string;
    createdFresh: boolean | null;
    preflightCounts?: unknown;
}

export interface OwnedStateLite {
    root: string;
    reposDir: string;
    snapshotsDir: string;
    multilingualDir: string;
    multiSweBenchDir: string;
    reportsDir: string;
}

/**
 * Synthesize a watchdog error outcome. Mirrors the adapter error path: an
 * errored runOwnGrep yields empty trace events, so shown=[], renderedText=""
 * and status=error/timeout (adapter.ts:96-136); computeInstanceMetrics then
 * zeroes success/recall for failed statuses (metrics.ts:84,99-100).
 */
export function buildWatchdogOutcome(
    engine: DriverEngineFns,
    instance: DriverInstance,
    formulation: string,
    status: "timeout:watchdog-query" | "error:watchdog-setup",
    elapsedMs: number,
): Record<string, unknown> {
    const metrics = engine.computeInstanceMetrics({ instance, formulation, shown: [], renderedText: "", elapsedMs, status });
    const { renderedText: _dropped, ...rest } = metrics as Record<string, unknown> & { renderedText?: unknown };
    void _dropped;
    return { ...rest, shownCards: [], routing: null };
}

/** Deterministic receipt order, ported from run.ts:161-170. */
export function sortDeletionAttempts<T extends { instanceId: string; root: string | null; stage: string; outcome: string }>(
    attempts: T[],
): T[] {
    return [...attempts].sort((a, b) => {
        if (a.instanceId !== b.instanceId) return a.instanceId < b.instanceId ? -1 : 1;
        const aRoot = a.root ?? "";
        const bRoot = b.root ?? "";
        if (aRoot !== bRoot) return aRoot < bRoot ? -1 : 1;
        if (a.stage !== b.stage) return a.stage < b.stage ? -1 : 1;
        return a.outcome < b.outcome ? -1 : a.outcome > b.outcome ? 1 : 0;
    });
}

/** Canonical root for receipts, ported from run.ts:469-475. */
export function canonicalizeCheckedRoot(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

export interface ReportAssemblyInput {
    engine: DriverEngineFns;
    split: string;
    formulations: string[];
    seed: string;
    revision: string;
    manifestPath: string;
    manifestSha256: string;
    owned: OwnedStateLite | null;
    canonicalReportsDir: string;
    engineSourceHash: string;
    rankingKnobs: Record<string, unknown>;
    /** Dataset-stage exclusions first, then per-instance receipts in run.ts loop order. */
    excluded: Array<Record<string, unknown>>;
    datasetFailures: Array<Record<string, unknown>>;
    attempts: DeletionAttemptLite[];
    /** Outcomes in run.ts pair order (instance × formulation). */
    outcomes: Array<Record<string, unknown>>;
    /** run.ts:681-684: manifest pins (or row refs in legacy pilot mode). */
    pinnedRefs: string[];
    generatedAt: string;
}

function tryCanonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

export interface AssembledReport {
    report: Record<string, unknown>;
    reportPath: string;
    digest: string;
    sha256: string;
}

/**
 * Assemble and write the whole-run report. Field order matches run.ts:653-702
 * exactly; the digest input matches run.ts:704-710; naming/mode match
 * run.ts:711-712.
 */
export function assembleDriverReport(input: ReportAssemblyInput): AssembledReport {
    const {
        engine,
        split,
        formulations,
        seed,
        revision,
        manifestPath,
        manifestSha256,
        owned,
        canonicalReportsDir,
        engineSourceHash,
        rankingKnobs,
        excluded,
        datasetFailures,
        attempts,
        outcomes,
        pinnedRefs,
        generatedAt,
    } = input;
    const summary = engine.summarizeMetrics(outcomes);
    const sortedAttempts = sortDeletionAttempts(attempts);
    const checkedRoots = [...new Set(
        sortedAttempts.map((a) => a.root).filter((r): r is string => r !== null).map(canonicalizeCheckedRoot),
    )].sort();
    const report: Record<string, unknown> = {
        generatedAt,
        engine: "smartread-grep",
        judge: "off",
        split,
        formulations,
        seed,
        datasetRevision: revision,
        manifestPath,
        manifestCanonical: tryCanonical(manifestPath),
        manifestSha256,
        state: owned
            ? {
                mode: "owned",
                stateRoot: owned.root,
                ownership: "external-grep-v1",
                reposDir: owned.reposDir,
                snapshotsDir: owned.snapshotsDir,
                multilingualDir: owned.multilingualDir,
                multiSweBenchDir: owned.multiSweBenchDir,
                reportsDir: owned.reportsDir,
            }
            : { mode: "legacy", stateRoot: null, reportsDir: canonicalReportsDir },
        inputs: {
            manifestCanonical: tryCanonical(manifestPath),
            datasetRevision: revision,
            pinnedRefs,
        },
        deletion: {
            checkedRoots,
            planned: [],
            deleted: [],
            ...(owned !== null ? { attempts: sortedAttempts } : {}),
        },
        engineSourceHash,
        rankingKnobs,
        summary,
        excluded,
        excludedCount: excluded.length,
        ...(owned !== null ? { datasetFailures } : {}),
        outcomes,
    };
    mkdirSync(canonicalReportsDir, { recursive: true });
    const digest = engine.computeExternalRunDigest({
        engineSourceHash,
        manifestSha256,
        seed,
        rankingKnobs,
        outcomesJson: JSON.stringify(outcomes),
    });
    const reportPath = join(canonicalReportsDir, `external-grep-${split}-${generatedAt.replace(/[:.]/g, "-")}-${digest}.json`);
    const bytes = Buffer.from(JSON.stringify(report, null, 2), "utf8");
    writeFileSync(reportPath, bytes, { mode: 0o600 });
    return { report, reportPath, digest, sha256: createHash("sha256").update(bytes).digest("hex") };
}
