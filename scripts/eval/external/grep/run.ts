#!/usr/bin/env node
/**
 * External grep benchmark runner: dataset → snapshots → our-grep → report.
 *
 * Usage:
 *   npx tsx scripts/eval/external/grep/run.ts [--split pilot|dev] [--formulation title|body|both]
 *     [--limit N] [--timeout-ms N] [--seed SEED] [--offline]
 *     [--multi-swe-bench --accept-license-review]
 *   npx tsx scripts/eval/external/grep/run.ts --manifest PATH [--split dev|holdout] [--open-holdout]
 *     [--formulation title|body|both] [--limit N] [--timeout-ms N] [--offline]
 *     --accept-license-review
 *
 * --offline skips network (uses cached rows + existing bare clones only).
 * The Multi-SWE-bench flag refuses without --accept-license-review (D12).
 * --manifest loads a frozen dev/holdout manifest with integrity
 * verification (fail closed) and runs --split dev from it without
 * re-freezing or rewriting any manifest. --split holdout is refused
 * unless --open-holdout is also given (single-use per D41). Frozen
 * manifests span Multi-SWE-bench rows, so --manifest also requires
 * --accept-license-review
 *
 * --state-root <dir> ($PI_SMARTREAD_EXTERNAL_STATE_ROOT) scopes EVERY
 * writable clone/snapshot/dataset/report path under a fresh private root
 * with ownership metadata (fail-closed on foreign roots). Legacy homedir
 * caches are never read or written in this mode: populate the owned root
 * with one online run, then --offline fails before any network when owned
 * data is missing. Owned mode requires --manifest (the pilot freeze path
 * writes into the legacy manifest cache)..
 * Report JSON is written mode 0600 under ~/.cache/pi-smartread-bench/reports/.
 * Harness teardown (disposeSemanticIndexes + shutdownAllManagers +
 * resetLSPBridge) runs in a finally so the CLI exits on its own.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { disposeSemanticIndexes } from "../../../../src/indexing/semantic-index-registry.js";
import { resetLSPBridge, shutdownAllManagers } from "../../../../src/lsp/lsp-bridge.js";
import { resolveGrepRankingOptions } from "../../../../src/search/grep-ranking.js";
import { hashEngineSources, isKnownSourceHash, toRankReportSettings } from "../../judge/grep-e2e-contract.js";
import { runOwnGrep, toReportOutcome, type ReportOutcome } from "./adapter.js";
import { frozenSplitIds, loadFrozenManifest } from "./frozen-manifest.js";
import type { BenchmarkInstance, Formulation } from "./instance.js";
import { summarizeMetrics } from "./metrics.js";
import {
    assertMultiSweBenchLicense,
    ensureDatasetFileCached,
    msbRowsToInstances,
    MULTI_SWE_BENCH_FILES,
    readCachedRows,
} from "./multi-swe-bench.js";
import {
    assertCanonicalBaseCommit,
    bareRepoDirUnder,
    ensureBareClone,
    ensureOwnedStateRoot,
    materializeInstance,
    resolveExternalStateRoot,
    snapshotDirUnder,
    type ExternalStatePaths,
    type SnapshotStage,
    type SnapshotTreeCounts,
} from "./repos.js";
import { freezeManifest, selectPilot, writeManifest, type DevHoldoutEntry, type FrozenManifest } from "./sampling.js";
import { datasetRevision, fetchAllRows, rowsToInstances } from "./swebench-multilingual.js";
import {
    computeExternalRunDigest,
    gitRootFromScript,
} from "./run-identity.js";

function takeValue(flag: string, argv: string[], i: number): string {
    const value = argv[i];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value (got ${value ?? "nothing"})`);
    }
    return value;
}

export function parseArgs(argv: string[]): {
    split: string;
    formulations: Formulation[];
    limit: number | null;
    timeoutMs: number;
    seed: string;
    offline: boolean;
    multiSweBench: boolean;
    manifestPath: string | null;
    openHoldout: boolean;
    stateRoot: string | null;
} {
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
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npx tsx scripts/eval/external/grep/run.ts [--split pilot|dev] [--formulation title|body|both] [--limit N] [--timeout-ms N] [--seed SEED] [--offline]");
            console.log("   or: npx tsx scripts/eval/external/grep/run.ts --manifest PATH [--split dev|holdout] [--open-holdout] [--accept-license-review] [...]");
            console.log("  --state-root DIR ($PI_SMARTREAD_EXTERNAL_STATE_ROOT): own ALL writable clone/snapshot/dataset/report paths under DIR (owned mode requires --manifest; --offline fails before any network when owned data is missing)");
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (multiSweBench) assertMultiSweBenchLicense(argv);
    if (manifestPath !== null) {
        // Frozen manifests span Multi-SWE-bench rows: same license gate as --multi-swe-bench.
        assertMultiSweBenchLicense(argv);
        if (!["dev", "holdout"].includes(split)) throw new Error("--split must be dev|holdout with --manifest");
    } else if (split === "holdout") {
        throw new Error("--split holdout requires --manifest (the holdout only exists frozen)");
    } else if (!["pilot", "dev"].includes(split)) throw new Error("--split must be pilot|dev");
    if (!["title", "body", "both"].includes(formulationArg)) throw new Error("--formulation must be title|body|both");
    const formulations: Formulation[] = formulationArg === "both" ? ["title", "body"] : [formulationArg as Formulation];
    return { split, formulations, limit, timeoutMs, seed, offline, multiSweBench, manifestPath, openHoldout, stateRoot };
}

export function reportsDir(stateRoot?: string | null): string {
    if (stateRoot) return join(resolve(stateRoot), "reports");
    return join(homedir(), ".cache/pi-smartread-bench/reports");
}

/**
 * One owned-mode attempt receipt in `report.deletion.attempts` (additive,
 * owned mode only; legacy reports never emit this field). Covers EVERY
 * owned attempt — success, exclusion, owned failure, and thrown
 * clone/materialize — so successes carry the stage/createdFresh context
 * that `checkedRoots` (canonical root strings) cannot. `root` is null when
 * no root could be derived; `createdFresh` is null when creation status is
 * unknown (thrown attempts are never assumed fresh or reused).
 * `preflightCounts` (symlinks/gitlinks) is present exactly when a
 * source-tree preflight ran for this attempt (absent for clone/pin
 * refusals, thrown attempts, and reused snapshots).
 */
export interface DeletionAttempt {
    instanceId: string;
    root: string | null;
    stage: "clone" | "materialize" | SnapshotStage;
    outcome: "success" | "excluded" | "failed" | "refused";
    createdFresh: boolean | null;
    preflightCounts?: SnapshotTreeCounts;
}

/** Deterministic receipt order: instanceId, then root/stage/outcome ties. */
function sortDeletionAttempts(attempts: DeletionAttempt[]): DeletionAttempt[] {
    return [...attempts].sort((a, b) => {
        if (a.instanceId !== b.instanceId) return a.instanceId < b.instanceId ? -1 : 1;
        const aRoot = a.root ?? "";
        const bRoot = b.root ?? "";
        if (aRoot !== bRoot) return aRoot < bRoot ? -1 : 1;
        if (a.stage !== b.stage) return a.stage < b.stage ? -1 : 1;
        return a.outcome < b.outcome ? -1 : a.outcome > b.outcome ? 1 : 0;
    });
}

/**
 * One owned-mode dataset receipt in the TOP-LEVEL `report.datasetFailures`
 * array (owned-only; legacy reports carry no such field). It is
 * independent of `deletion.attempts` and indexes every dataset-stage
 * exclusion: a dataset load that threw, a selected row that could not be
 * converted, a manifest id with no convertible row, or a frozen-pin
 * disagreement — always with the SELECTED instance ids affected.
 * `revision` is the run's dataset revision, `"unknown"` when the rows
 * behind the receipt never loaded. `error` is a loader message truncated
 * to 200 chars; these loaders embed no credentials in their messages.
 */
export interface DatasetFailureReceipt {
    dataset: string;
    revision: string;
    file?: string;
    error: string;
    instanceIds: string[];
}

/** Truncated loader error for dataset receipts (no secrets in loader messages). */
function truncateDatasetError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, 200);
}

/**
 * Repo a Multi-SWE-bench dataset file could hold:
 * `js/Kong__insomnia_dataset.jsonl` -> `kong/insomnia` (lowercased, like
 * `msbRowsToInstances` lowercases the org). Null when the file name does
 * not follow the `<lang>/<org>__<repo>_dataset.jsonl` convention.
 */
function multiSweBenchFileRepo(file: string): string | null {
    const base = file.split("/").pop() ?? file;
    const suffix = "_dataset.jsonl";
    const stem = base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
    const sep = stem.indexOf("__");
    if (sep <= 0 || sep === stem.length - 2) return null;
    return `${stem.slice(0, sep)}/${stem.slice(sep + 2)}`.toLowerCase();
}

/**
 * Campaign entry point. Callable AND import-safe: importing this module
 * under vitest/tsx parses/runs NOTHING (see invokedAsCli guard at the
 * bottom). The CLI wrapper maps the return value to process.exitCode and
 * runs harness teardown in a finally.
 */
export async function runExternalGrepCli(argv: string[]): Promise<number> {
    let args: ReturnType<typeof parseArgs>;
    try {
        args = parseArgs(argv);
    } catch (error) {
        console.error(`error: ${(error as Error).message}`);
        return 2;
    }
    // Private state root: claim BEFORE any clone/snapshot/dataset/report path
    // is touched. Owned mode refuses foreign roots and requires --manifest.
    let owned: ExternalStatePaths | null = null;
    const canonicalStateRoot = resolveExternalStateRoot(args.stateRoot);
    if (canonicalStateRoot !== null) {
        // Fail before claiming any state: owned mode requires a frozen
        // manifest (the pilot freeze path writes to the legacy cache).
        if (args.manifestPath === null) {
            console.error("error: --state-root requires --manifest <frozen> (pilot freeze writes to the legacy cache)");
            return 2;
        }
        try {
            owned = ensureOwnedStateRoot(canonicalStateRoot);
        } catch (error) {
            console.error(`error: ${(error as Error).message}`);
            return 2;
        }
    }
function ownedMultilingualDir(state: ExternalStatePaths | null): string {
    if (state) return state.multilingualDir;
    return join(homedir(), ".cache/pi-smartread-bench/datasets/swe-bench-multilingual");
}
function tryCanonical(p: string): string | null {
    try {
        return realpathSync(p);
    } catch {
        return null;
    }
}
try {
    if (args.offline && !existsSync(ownedMultilingualDir(owned))) {
        throw new Error("--offline with no cached dataset rows; run once online first");
    }
    // Resolved ranking knobs, recorded in every external report.
    const rankingKnobs = toRankReportSettings(resolveGrepRankingOptions());
    // Engine source content identity (shared helper): ties this report to
    // one code state. Unknown stays unknown and never claims an identity.
    const gitRoot = gitRootFromScript(import.meta.url);
    const engineSourceHash = gitRoot ? hashEngineSources(gitRoot) : "unknown:no-git-root";
    if (!isKnownSourceHash(engineSourceHash)) {
        console.warn(`warning: engine source identity unknown (${engineSourceHash}); report cannot be tied to a known code state`);
    }
    // Dataset loads are receipted instead of aborting an owned campaign: a
    // failed load can only exclude the instances it leaves unresolved (the
    // owned-only `datasetFailures` receipt below). Legacy mode keeps the
    // historical fail-loud throw — no report exists at this point yet.
    let rows: Awaited<ReturnType<typeof fetchAllRows>> = [];
    const datasetLoadFailures: Array<{ dataset: string; file?: string; error: string }> = [];
    try {
        rows = await fetchAllRows({ offline: args.offline, cacheDir: owned?.multilingualDir });
    } catch (error) {
        if (owned === null) throw error;
        datasetLoadFailures.push({ dataset: "swe-bench-multilingual", error: truncateDatasetError(error) });
    }
    const revision = datasetLoadFailures.length > 0 ? "unknown" : datasetRevision(rows);
    const { instances, skipped } = rowsToInstances(rows);
    const byId = new Map(instances.map((i) => [i.instanceId, i]));
    let manifestPath: string;
    let manifestSha256: string;
    let splitIds: string[];
    // Frozen pin authority: the manifest entry (not the dataset row) decides
    // repo/baseCommit for every instance materialized in --manifest mode.
    let manifestEntries: Map<string, DevHoldoutEntry> | null = null;
    // Multi-SWE-bench conversion skips, kept for selected-id receipts
    // (historically these were dropped without a trace).
    const msbSkips: Array<{ instanceId: string; reason: string; dataset: string; file: string }> = [];
    if (args.manifestPath !== null) {
        // Frozen run: verify integrity, select the split, never re-freeze or rewrite.
        const frozen = loadFrozenManifest(args.manifestPath);
        const { ids, holdoutWarning } = frozenSplitIds(frozen, args.split, { openHoldout: args.openHoldout });
        if (holdoutWarning !== null) console.log(holdoutWarning);
        manifestPath = args.manifestPath;
        manifestSha256 = frozen.sha256;
        manifestEntries = new Map<string, DevHoldoutEntry>(
            (args.split === "dev" ? frozen.dev : frozen.holdout).map((e) => [e.id, e]),
        );
        // Frozen dev/holdout spans both datasets: resolve ids missing
        // from Multilingual via cached Multi-SWE-bench rows (offline
        // respects the cache; online refreshes it first).
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
            for (const file of MULTI_SWE_BENCH_FILES) {
                try {
                    // Equivalent to the historical online/offline branches:
                    // offline:false keeps the online refresh path.
                    await ensureDatasetFileCached(file, { offline: args.offline, cacheDir: owned?.multiSweBenchDir });
                    const converted = msbRowsToInstances(await readCachedRows(file, owned?.multiSweBenchDir));
                    for (const inst of converted.instances) {
                        if (!byId.has(inst.instanceId)) byId.set(inst.instanceId, inst);
                    }
                    for (const s of converted.skipped) {
                        msbSkips.push({ ...s, dataset: "multi-swe-bench", file });
                    }
                } catch (error) {
                    // Legacy: historical fail-loud throw. Owned: receipt the
                    // failure and attribute it to the ids left unresolved.
                    if (owned === null) throw error;
                    datasetLoadFailures.push({ dataset: "multi-swe-bench", file, error: truncateDatasetError(error) });
                }
            }
        }
        splitIds = ids;
    } else {
        const pilot = selectPilot(instances, args.seed);
        const manifest: FrozenManifest = freezeManifest(instances, pilot, args.seed, revision);
        manifestPath = writeManifest(manifest);
        manifestSha256 = manifest.sha256;
        splitIds = args.split === "pilot" ? manifest.pilot : manifest.dev;
    }
    let selected = splitIds.map((id) => byId.get(id)).filter((i): i is BenchmarkInstance => i !== undefined);
    if (args.limit !== null) selected = selected.slice(0, args.limit);

    const outcomes: ReportOutcome[] = [];

    // ---- Dataset-stage resolution -------------------------------------
    // Every selected id that disappears between manifest selection and
    // materialization gets an explicit `excluded` receipt (never a silent
    // drop): loader skips and `byId` misses report stage `dataset`.
    // Loader skips outside the selection keep their historical
    // stage-`loader` shape, so non-manifest legacy reports stay identical.
    const splitIdSet = new Set(splitIds);
    const unresolvedIds = splitIds.filter((id) => !byId.has(id));
    const unresolvedSet = new Set(unresolvedIds);
    const loaderSkips: Array<{ instanceId: string; reason: string; dataset: string; file?: string }> = [
        ...skipped.map((s) => ({ instanceId: s.instanceId, reason: s.reason, dataset: "swe-bench-multilingual" })),
        ...msbSkips,
    ];
    // First loader wins per unresolved selected id (Multilingual precedes
    // Multi-SWE-bench, mirroring instance precedence in `byId`).
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
            // Historical loader-stage entry for every non-dataset-stage skip.
            excluded.push({ instanceId: s.instanceId, reason: s.reason, stage: "loader" });
        }
    }
    for (const id of unresolvedIds) {
        if (firstSelectedSkip.has(id)) continue;
        excluded.push({ instanceId: id, reason: "manifest-id-unresolved", stage: "dataset" });
    }

    // Owned-only `datasetFailures` receipt: top-level, independent of
    // `deletion.attempts`, indexing every dataset-stage exclusion with the
    // selected ids affected.
    const datasetFailures: DatasetFailureReceipt[] = [];
    if (owned !== null) {
        const unresolvedWithoutSkip = unresolvedIds.filter((id) => !firstSelectedSkip.has(id));
        // A load that threw may have hidden only ids its own dataset (and,
        // per Multi-SWE-bench file, its own repo) could contain. Attribute
        // by the frozen manifest entry; ids no failed loader could hold are
        // left out of every load-failure receipt and keep only their
        // `manifest-id-unresolved` exclusion.
        const failedLoaderOwnsId = (f: { dataset: string; file?: string }, id: string): boolean => {
            const entry = manifestEntries?.get(id);
            if (entry === undefined || entry.dataset !== f.dataset) return false;
            if (f.dataset === "multi-swe-bench") {
                return f.file !== undefined && multiSweBenchFileRepo(f.file) === entry.repo.toLowerCase();
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
            // No loader threw: the rows are simply absent from every cached
            // dataset. Group by the dataset frozen for each instance.
            const groups = new Map<string, DatasetFailureReceipt>();
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
                group.instanceIds.push(id);
            }
        }
        // Conversion failures for selected ids, grouped by loader + reason.
        const conversionGroups = new Map<string, DatasetFailureReceipt>();
        for (const id of splitIds) {
            const s = firstSelectedSkip.get(id);
            if (s === undefined) continue;
            const key = `${s.dataset}\u0000${s.file ?? ""}\u0000${s.reason}`;
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
            group.instanceIds.push(id);
        }
    }
    // No-clean receipts: this campaign NEVER deletes snapshot, repo, or
    // dataset paths. Every owned attempt — success, exclusion, or owned
    // failure — records its canonical root in checkedSnapshotRoots BEFORE
    // any gold-dependent step, so the receipt never omits failed or partial
    // materializations (no success-only omission). Planned/deleted stay
    // empty to prove nothing was removed. Mismatched/foreign snapshots
    // throw inside materializeInstance (files retained) and land in
    // `excluded` below without an adopted root.
    const snapshotPlanned: string[] = [];
    const snapshotDeleted: string[] = [];
    const checkedSnapshotRoots: string[] = [];
    // Owned-only attempts receipt: every owned attempt records its stage,
    // outcome, and creation status. Legacy mode records nothing here, so
    // legacy report byte-shape stays unchanged.
    const deletionAttempts: DeletionAttempt[] = [];
    const recordAttempt = (attempt: DeletionAttempt): void => {
        if (owned !== null) deletionAttempts.push(attempt);
    };
    const canonicalizeCheckedRoot = (p: string): string => {
        try {
            return realpathSync(p);
        } catch {
            return p;
        }
    };
    // Owned-mode root a thrown stage was attempting; null in legacy mode or
    // when the id itself is unsafe (no derivable root).
    const attemptedOwnedRoot = (instance: BenchmarkInstance, stage: "clone" | "materialize"): string | null => {
        if (owned === null) return null;
        try {
            return stage === "clone"
                ? bareRepoDirUnder(owned.root, instance.repo)
                : snapshotDirUnder(owned.root, instance.instanceId);
        } catch {
            return null;
        }
    };
    for (const instance of selected) {
        // Frozen-manifest pin binding: the manifest entry — never the
        // dataset row — decides repo/baseCommit. A disagreeing row is
        // excluded with BOTH values recorded (stage `dataset`) before any
        // clone or materialize, so neither value is ever silently used.
        if (manifestEntries !== null) {
            const entry = manifestEntries.get(instance.instanceId);
            if (entry !== undefined && (entry.repo !== instance.repo || entry.baseCommit !== instance.baseCommit)) {
                const pinnedRef = `${entry.repo}@${entry.baseCommit}`;
                const rowRef = `${instance.repo}@${instance.baseCommit}`;
                excluded.push({
                    instanceId: instance.instanceId,
                    reason: "pin-mismatch",
                    stage: "dataset",
                    dataset: entry.dataset,
                    pinned: pinnedRef,
                    row: rowRef,
                });
                if (owned !== null) {
                    datasetFailures.push({
                        dataset: entry.dataset,
                        revision,
                        error: `pin-mismatch: manifest ${pinnedRef} vs row ${rowRef}`.slice(0, 200),
                        instanceIds: [instance.instanceId],
                    });
                }
                continue;
            }
        }
        // Owned pin gate BEFORE ensureBareClone: the SAME validator
        // materializeInstance applies at entry runs here so a noncanonical
        // pin (e.g. "HEAD") is refused with no clone write and no network
        // access. Legacy mode keeps its historical behavior (no gate).
        if (owned !== null) {
            try {
                assertCanonicalBaseCommit(instance.baseCommit);
            } catch (error) {
                const message = error instanceof Error ? error.message : "unknown";
                const attempted = attemptedOwnedRoot(instance, "materialize");
                if (attempted !== null) checkedSnapshotRoots.push(canonicalizeCheckedRoot(attempted));
                excluded.push({
                    instanceId: instance.instanceId,
                    reason: `materialize-error:${message.slice(0, 120)}`,
                    stage: "preflight",
                    root: attempted,
                    createdFresh: null,
                });
                recordAttempt({
                    instanceId: instance.instanceId,
                    root: attempted,
                    stage: "preflight",
                    outcome: "refused",
                    createdFresh: null,
                });
                continue;
            }
        }
        let root: string;
        let stage: "clone" | "materialize" = "clone";
        try {
            // No-clean receipts: this campaign NEVER deletes. Materialize
            // refuses mismatched/foreign snapshots (files retained); every
            // owned attempt reports its root (success, exclusion, or owned
            // failure) for the checked-roots receipt.
            ensureBareClone(instance.repo, { stateRoot: canonicalStateRoot, offline: args.offline });
            stage = "materialize";
            const mat = materializeInstance(instance, { stateRoot: canonicalStateRoot, offline: args.offline });
            if ("failed" in mat) {
                checkedSnapshotRoots.push(canonicalizeCheckedRoot(mat.root));
                recordAttempt({
                    instanceId: instance.instanceId,
                    root: mat.root,
                    stage: mat.completedStage,
                    outcome: "failed",
                    createdFresh: mat.createdFresh,
                    preflightCounts: mat.preflightCounts,
                });
                excluded.push({
                    instanceId: instance.instanceId,
                    reason: `materialize-error:${mat.error.slice(0, 120)}`,
                    stage: mat.completedStage,
                    root: mat.root,
                    createdFresh: mat.createdFresh,
                });
                continue;
            }
            if ("excluded" in mat) {
                // Owned exclusions carry their receipt root (recorded above);
                // legacy exclusions keep their exact historical shape.
                if ("root" in mat) {
                    checkedSnapshotRoots.push(canonicalizeCheckedRoot(mat.root));
                    recordAttempt({
                        instanceId: instance.instanceId,
                        root: mat.root,
                        stage: "materialize",
                        outcome: "excluded",
                        createdFresh: mat.createdFresh,
                        preflightCounts: mat.preflightCounts,
                    });
                    excluded.push({
                        instanceId: instance.instanceId,
                        reason: mat.reason,
                        missing: mat.missing,
                        stage: "materialize",
                        root: mat.root,
                        createdFresh: mat.createdFresh,
                    });
                } else {
                    excluded.push({
                        instanceId: instance.instanceId,
                        reason: mat.reason,
                        missing: mat.missing,
                        stage: "materialize",
                    });
                }
                continue;
            }
            root = mat.root;
            checkedSnapshotRoots.push(canonicalizeCheckedRoot(root));
            recordAttempt({
                instanceId: instance.instanceId,
                root,
                stage: "materialize",
                outcome: "success",
                createdFresh: "createdFresh" in mat ? mat.createdFresh : null,
                preflightCounts: "preflightCounts" in mat ? mat.preflightCounts : undefined,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "unknown";
            const reason = `materialize-error:${message.slice(0, 120)}`;
            const attempted = attemptedOwnedRoot(instance, stage);
            if (owned === null) {
                // Legacy: exact historical exclusion shape.
                excluded.push({ instanceId: instance.instanceId, reason, stage: "materialize" });
                continue;
            }
            // Owned: a throw (refusal or clone failure) still records the
            // attempted root and stage; creation status is unknown (null),
            // never assumed. Explicit `refuses-*` throws are refusals; any
            // other throw (e.g. a clone failure) is a plain failure.
            if (attempted !== null) checkedSnapshotRoots.push(canonicalizeCheckedRoot(attempted));
            excluded.push({ instanceId: instance.instanceId, reason, stage, root: attempted, createdFresh: null });
            recordAttempt({
                instanceId: instance.instanceId,
                root: attempted,
                stage,
                outcome: message.startsWith("refuses-") ? "refused" : "failed",
                createdFresh: null,
            });
            continue;
        }
        for (const formulation of args.formulations) {
            process.stdout.write(`[${instance.instanceId}] ${formulation} ... `);
            const result = await runOwnGrep(instance, root, formulation, args.timeoutMs);
            const outcome = toReportOutcome(result);
            outcomes.push({ ...outcome, rankedFiles: [...outcome.rankedFiles] });
            console.log(
                `${result.status} success@5=${result.successAt5} recall@5=${result.recallAt5.toFixed(2)} ` +
                `cards=${result.shownCards.length} tok=${result.renderedTokens} ${Math.round(result.elapsedMs)}ms`,
            );
        }
    }
    const summary = summarizeMetrics(outcomes);
    const generatedAt = new Date().toISOString();
    const canonicalReportsDir = owned ? owned.reportsDir : reportsDir();
    const report = {
        generatedAt,
        engine: "smartread-grep",
        judge: "off",
        split: args.split,
        formulations: args.formulations,
        seed: args.seed,
        datasetRevision: revision,
        manifestPath,
        manifestCanonical: manifestPath ? (tryCanonical(manifestPath) ?? manifestPath) : manifestPath,
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
            manifestCanonical: manifestPath ? (tryCanonical(manifestPath) ?? manifestPath) : manifestPath,
            datasetRevision: revision,
            // Manifest mode pins from the frozen entries (the authority
            // checked per instance above); legacy keeps row-derived refs.
            pinnedRefs: selected.map((i) => {
                const entry = manifestEntries?.get(i.instanceId);
                return entry !== undefined ? `${entry.repo}@${entry.baseCommit}` : `${i.repo}@${i.baseCommit}`;
            }),
        },
        deletion: {
            checkedRoots: [...new Set(checkedSnapshotRoots)].sort(),
            planned: [...snapshotPlanned].sort(),
            deleted: [...snapshotDeleted].sort(),
            // Additive owned-only receipt: legacy reports carry no `attempts`.
            ...(owned !== null ? { attempts: sortDeletionAttempts(deletionAttempts) } : {}),
        },
        engineSourceHash,
        rankingKnobs,
        summary,
        excluded,
        excludedCount: excluded.length,
        // Owned-only receipt (legacy reports carry no `datasetFailures`):
        // dataset-stage failures independent of `deletion.attempts`.
        ...(owned !== null ? { datasetFailures } : {}),
        outcomes,
    };
    mkdirSync(canonicalReportsDir, { recursive: true });
    const digest = computeExternalRunDigest({
        engineSourceHash,
        manifestSha256,
        seed: args.seed,
        rankingKnobs,
        outcomesJson: JSON.stringify(outcomes),
    });
    const reportPath = join(canonicalReportsDir, `external-grep-${args.split}-${generatedAt.replace(/[:.]/g, "-")}-${digest}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`\nreport: ${reportPath}`);
    console.log(`manifest: ${manifestPath} (split=${args.split} selected=${selected.length})`);
    console.log(`summary: success@5=${summary.successAt5} meanRecall@5=${summary.meanRecallAt5.toFixed(3)} meanMRR=${summary.meanMRR.toFixed(3)} errors=${summary.errors} excluded=${excluded.length}`);
    if (datasetFailures.length > 0) {
        console.error(`dataset failures: ${datasetFailures.length} receipt(s) affecting selected instances (see report.datasetFailures)`);
    }
    } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        return 2;
    } finally {
        // Benchmark-harness cleanup only (not a production change): release
        // semantic-index and LSP handles so the CLI exits on its own.
        disposeSemanticIndexes();
        await shutdownAllManagers();
        resetLSPBridge();
    }
    return 0;
}

const invokedAsCli =
    typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    (process.argv[1].endsWith("external/grep/run.ts") || process.argv[1].endsWith("external\\grep\\run.ts"));
if (invokedAsCli) {
    runExternalGrepCli(process.argv.slice(2)).then(
        (code) => { process.exitCode = code; },
        (error) => {
            console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 2;
        },
    );
}
