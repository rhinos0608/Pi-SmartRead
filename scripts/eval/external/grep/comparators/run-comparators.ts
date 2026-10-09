#!/usr/bin/env node
/**
 * External grep comparator runner (benchmark harness only, D13/D17).
 *
 * Runs one non-ours system over the frozen pilot/dev split and writes a
 * mode-0600 report under ~/.cache/pi-smartread-bench/reports/. This is a NEW
 * entry script so the existing run.ts (ours system) stays untouched; it
 * reuses the instance schema, metrics, token cap, sampling manifest, repo
 * materialization, and report format of the sibling modules.
 *
 * Usage:
 *   npx tsx scripts/eval/external/grep/comparators/run-comparators.ts --system ripgrep|probe|codanna
 *     [--split pilot|dev] [--formulation title|body|both] [--limit N] [--timeout-ms N]
 *     [--seed SEED] [--offline] [--multi-swe-bench --accept-license-review]
 *   npx tsx scripts/eval/external/grep/comparators/run-comparators.ts --system ripgrep|probe|codanna
 *     --manifest PATH [--split dev|holdout] [--open-holdout] [--accept-license-review]
 *     [--formulation title|body|both] [--limit N] [--timeout-ms N] [--offline]
 *
 * --manifest loads a frozen dev/holdout manifest with integrity
 * verification (fail closed) and runs --split dev from it without
 * re-freezing or rewriting any manifest. --split holdout is refused
 * unless --open-holdout is also given (single-use per D41). Frozen
 * manifests span Multi-SWE-bench rows, so --manifest also requires
 * --accept-license-review.
 *
 * Per-system setup/index time is captured separately from per-query latency
 * (setupMs vs elapsedMs on each outcome, totalSetupMs on the report).
 * Comparator search rules, versions, and checksums are embedded in the
 * report's `comparator` manifest fragment (non-equivalence disclosed).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMPARATORS, comparatorManifest } from "./index.js";
import type { BenchmarkInstance } from "../instance.js";
import { frozenSplitIds, loadFrozenManifest } from "../frozen-manifest.js";
import { computeInstanceMetrics, summarizeMetrics, type InstanceMetrics } from "../metrics.js";
import {
    ensureDatasetFileCached,
    msbRowsToInstances,
    MULTI_SWE_BENCH_FILES,
    readCachedRows,
} from "../multi-swe-bench.js";
import { ensureBareClone, materializeInstance } from "../repos.js";
import { freezeManifest, selectPilot, writeManifest, type FrozenManifest } from "../sampling.js";
import { datasetRevision, fetchAllRows, rowsToInstances } from "../swebench-multilingual.js";

/** Per-run outcome: standard metrics plus comparator setup/index time. */
export type ComparatorOutcome = InstanceMetrics & { setupMs: number };

import { parseComparatorArgs } from "./args.js";

function reportsDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/reports");
}

let args: ReturnType<typeof parseComparatorArgs>;
try {
    args = parseComparatorArgs(process.argv.slice(2));
} catch (error) {
    console.error(`error: ${(error as Error).message}`);
    process.exit(2);
}
let failed = false;
try {
    if (args.offline && !existsSync(join(homedir(), ".cache/pi-smartread-bench/datasets/swe-bench-multilingual"))) {
        throw new Error("--offline with no cached dataset rows; run once online first");
    }
    const rows = await fetchAllRows({ offline: args.offline });
    const revision = datasetRevision(rows);
    const { instances, skipped } = rowsToInstances(rows);
    const byId = new Map(instances.map((i) => [i.instanceId, i]));
    let manifestPath: string;
    let manifestSha256: string;
    let splitIds: string[];
    let manifestLine: string;
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
        manifestLine = `manifest: ${manifestPath} (split=${args.split} frozen-dev=${frozen.dev.length} frozen-holdout=${frozen.holdout.length})`;
    } else {
        const pilot = selectPilot(instances, args.seed);
        const manifest: FrozenManifest = freezeManifest(instances, pilot, args.seed, revision);
        manifestPath = writeManifest(manifest);
        manifestSha256 = manifest.sha256;
        splitIds = args.split === "pilot" ? manifest.pilot : manifest.dev;
        manifestLine = `manifest: ${manifestPath} (pilot=${manifest.pilot.length} dev=${manifest.dev.length} holdout=${manifest.holdout.length})`;
    }
    let selected = splitIds.map((id) => byId.get(id)).filter((i): i is BenchmarkInstance => i !== undefined);
    if (args.limit !== null) selected = selected.slice(0, args.limit);

    const runner = COMPARATORS[args.system];
    const outcomes: ComparatorOutcome[] = [];
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
            const comp = await runner(instance, root, formulation, { timeoutMs: args.timeoutMs });
            const metrics = computeInstanceMetrics({
                instance,
                formulation,
                shown: comp.units.map((u) => ({ relFile: u.relFile, line: u.line, endLine: u.endLine, name: u.name })),
                renderedText: comp.renderedText,
                elapsedMs: comp.elapsedMs,
                status: comp.status,
            });
            outcomes.push({ ...metrics, setupMs: comp.setupMs });
            console.log(
                `${metrics.status} success@5=${metrics.successAt5} recall@5=${metrics.recallAt5.toFixed(2)} ` +
                    `files=${metrics.rankedFiles.length} tok=${metrics.renderedTokens} ` +
                    `${Math.round(comp.elapsedMs)}ms setup=${Math.round(comp.setupMs)}ms`,
            );
        }
    }
    const summary = summarizeMetrics(outcomes);
    const totalSetupMs = outcomes.reduce((a, o) => a + o.setupMs, 0);
    const generatedAt = new Date().toISOString();
    const report = {
        generatedAt,
        engine: args.system,
        judge: "off",
        split: args.split,
        formulations: args.formulations,
        seed: args.seed,
        datasetRevision: revision,
        manifestPath,
        manifestSha256,
        comparator: comparatorManifest(args.system),
        totalSetupMs,
        summary,
        excluded,
        excludedCount: excluded.length,
        outcomes,
    };
    mkdirSync(reportsDir(), { recursive: true });
    const digest = createHash("sha256").update(JSON.stringify(outcomes)).digest("hex").slice(0, 8);
    const reportPath = join(
        reportsDir(),
        `external-grep-${args.system}-${args.split}-${generatedAt.replace(/[:.]/g, "-")}-${digest}.json`,
    );
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`\nreport: ${reportPath}`);
    console.log(manifestLine);
    console.log(
        `summary: success@5=${summary.successAt5} meanRecall@5=${summary.meanRecallAt5.toFixed(3)} ` +
            `meanMRR=${summary.meanMRR.toFixed(3)} errors=${summary.errors} excluded=${excluded.length} ` +
            `setupMs=${Math.round(totalSetupMs)}`,
    );
} catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
}
if (failed) process.exitCode = 2;
