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
 * --accept-license-review.
 * Report JSON is written mode 0600 under ~/.cache/pi-smartread-bench/reports/.
 * Harness teardown (disposeSemanticIndexes + shutdownAllManagers +
 * resetLSPBridge) runs in a finally so the CLI exits on its own.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { ensureBareClone, materializeInstance } from "./repos.js";
import { freezeManifest, selectPilot, writeManifest, type FrozenManifest } from "./sampling.js";
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

function parseArgs(argv: string[]): {
    split: string;
    formulations: Formulation[];
    limit: number | null;
    timeoutMs: number;
    seed: string;
    offline: boolean;
    multiSweBench: boolean;
    manifestPath: string | null;
    openHoldout: boolean;
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
        else if (arg === "--open-holdout") openHoldout = true;
        else if (arg === "--accept-license-review") continue;
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npx tsx scripts/eval/external/grep/run.ts [--split pilot|dev] [--formulation title|body|both] [--limit N] [--timeout-ms N] [--seed SEED] [--offline]");
            console.log("   or: npx tsx scripts/eval/external/grep/run.ts --manifest PATH [--split dev|holdout] [--open-holdout] [--accept-license-review] [...]");
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
    return { split, formulations, limit, timeoutMs, seed, offline, multiSweBench, manifestPath, openHoldout };
}

function reportsDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/reports");
}

let args: ReturnType<typeof parseArgs>;
try {
    args = parseArgs(process.argv.slice(2));
} catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(2);
}
let failed = false;
try {
    if (args.offline && !existsSync(join(homedir(), ".cache/pi-smartread-bench/datasets/swe-bench-multilingual"))) {
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
    const rows = await fetchAllRows({ offline: args.offline });
    const revision = datasetRevision(rows);
    const { instances, skipped } = rowsToInstances(rows);
    const byId = new Map(instances.map((i) => [i.instanceId, i]));
    let manifestPath: string;
    let manifestSha256: string;
    let splitIds: string[];
    const extraExcluded: Array<Record<string, unknown>> = [];
    if (args.manifestPath !== null) {
        // Frozen run: verify integrity, select the split, never re-freeze or rewrite.
        const frozen = loadFrozenManifest(args.manifestPath);
        const { ids, holdoutWarning } = frozenSplitIds(frozen, args.split, { openHoldout: args.openHoldout });
        if (holdoutWarning !== null) console.log(holdoutWarning);
        manifestPath = args.manifestPath;
        manifestSha256 = frozen.sha256;
        // Frozen dev/holdout spans both datasets: resolve ids missing
        // from Multilingual via cached Multi-SWE-bench rows (offline
        // respects the cache; online refreshes it first).
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length > 0) {
            for (const file of MULTI_SWE_BENCH_FILES) {
                if (!args.offline) await ensureDatasetFileCached(file);
                const converted = msbRowsToInstances(await readCachedRows(file));
                for (const inst of converted.instances) {
                    if (!byId.has(inst.instanceId)) byId.set(inst.instanceId, inst);
                }
            }
        }
        splitIds = ids;
        for (const id of ids) {
            if (!byId.has(id)) {
                extraExcluded.push({ instanceId: id, reason: "manifest-id-unresolved", stage: "loader" });
            }
        }
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
    const excluded: Array<Record<string, unknown>> = [
        ...skipped.map((s) => ({ ...s, stage: "loader" })),
        ...extraExcluded,
    ];
    for (const instance of selected) {
        let root: string;
        try {
            ensureBareClone(instance.repo);
            const mat = materializeInstance(instance);
            if ("excluded" in mat) {
                excluded.push({ instanceId: instance.instanceId, reason: mat.reason, missing: mat.missing, stage: "materialize" });
                continue;
            }
            root = mat.root;
        } catch (error) {
            excluded.push({
                instanceId: instance.instanceId,
                reason: `materialize-error:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`,
                stage: "materialize",
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
    const report = {
        generatedAt,
        engine: "smartread-grep",
        judge: "off",
        split: args.split,
        formulations: args.formulations,
        seed: args.seed,
        datasetRevision: revision,
        manifestPath,
        manifestSha256,
        engineSourceHash,
        rankingKnobs,
        summary,
        excluded,
        excludedCount: excluded.length,
        outcomes,
    };
    mkdirSync(reportsDir(), { recursive: true });
    const digest = computeExternalRunDigest({
        engineSourceHash,
        manifestSha256,
        seed: args.seed,
        rankingKnobs,
        outcomesJson: JSON.stringify(outcomes),
    });
    const reportPath = join(reportsDir(), `external-grep-${args.split}-${generatedAt.replace(/[:.]/g, "-")}-${digest}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`\nreport: ${reportPath}`);
    console.log(`manifest: ${manifestPath} (split=${args.split} selected=${selected.length})`);
    console.log(`summary: success@5=${summary.successAt5} meanRecall@5=${summary.meanRecallAt5.toFixed(3)} meanMRR=${summary.meanMRR.toFixed(3)} errors=${summary.errors} excluded=${excluded.length}`);
} catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
} finally {
    // Benchmark-harness cleanup only (not a production change): release
    // semantic-index and LSP handles so the CLI exits on its own.
    disposeSemanticIndexes();
    await shutdownAllManagers();
    resetLSPBridge();
}
if (failed) process.exitCode = 2;
