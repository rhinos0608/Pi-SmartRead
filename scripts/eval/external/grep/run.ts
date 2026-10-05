#!/usr/bin/env node
/**
 * External grep benchmark runner: dataset → snapshots → our-grep → report.
 *
 * Usage:
 *   npx tsx scripts/eval/external/grep/run.ts [--split pilot|dev] [--formulation title|body|both]
 *     [--limit N] [--timeout-ms N] [--seed SEED] [--offline]
 *     [--multi-swe-bench --accept-license-review]
 *
 * --offline skips network (uses cached rows + existing bare clones only).
 * The Multi-SWE-bench flag refuses without --accept-license-review (D12).
 * Report JSON is written mode 0600 under ~/.cache/pi-smartread-bench/reports/.
 * Harness teardown (disposeSemanticIndexes + shutdownAllManagers +
 * resetLSPBridge) runs in a finally so the CLI exits on its own.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { disposeSemanticIndexes } from "../../../../src/indexing/semantic-index-registry.js";
import { resetLSPBridge, shutdownAllManagers } from "../../../../src/lsp/lsp-bridge.js";
import { runOwnGrep, toReportOutcome, type ReportOutcome } from "./adapter.js";
import type { BenchmarkInstance, Formulation } from "./instance.js";
import { summarizeMetrics } from "./metrics.js";
import { assertMultiSweBenchLicense } from "./multi-swe-bench.js";
import { ensureBareClone, materializeInstance } from "./repos.js";
import { freezeManifest, selectPilot, writeManifest, type FrozenManifest } from "./sampling.js";
import { datasetRevision, fetchAllRows, rowsToInstances } from "./swebench-multilingual.js";

function parseArgs(argv: string[]): {
    split: string;
    formulations: Formulation[];
    limit: number | null;
    timeoutMs: number;
    seed: string;
    offline: boolean;
    multiSweBench: boolean;
} {
    let split = "pilot";
    let formulationArg = "both";
    let limit: number | null = null;
    let timeoutMs = 60000;
    let seed = "external-grep-v1";
    let offline = false;
    let multiSweBench = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--split") split = argv[++i] ?? split;
        else if (arg === "--formulation") formulationArg = argv[++i] ?? formulationArg;
        else if (arg === "--limit") limit = Number(argv[++i]);
        else if (arg === "--timeout-ms") timeoutMs = Number(argv[++i] ?? "");
        else if (arg === "--seed") seed = argv[++i] ?? seed;
        else if (arg === "--offline") offline = true;
        else if (arg === "--multi-swe-bench") multiSweBench = true;
        else if (arg === "--accept-license-review") continue;
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npx tsx scripts/eval/external/grep/run.ts [--split pilot|dev] [--formulation title|body|both] [--limit N] [--timeout-ms N] [--seed SEED] [--offline]");
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (multiSweBench) assertMultiSweBenchLicense(argv);
    if (!["pilot", "dev"].includes(split)) throw new Error("--split must be pilot|dev");
    if (!["title", "body", "both"].includes(formulationArg)) throw new Error("--formulation must be title|body|both");
    const formulations: Formulation[] = formulationArg === "both" ? ["title", "body"] : [formulationArg as Formulation];
    return { split, formulations, limit, timeoutMs, seed, offline, multiSweBench };
}

function reportsDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/reports");
}

const args = parseArgs(process.argv.slice(2));
let failed = false;
try {
    if (args.offline && !existsSync(join(homedir(), ".cache/pi-smartread-bench/datasets/swe-bench-multilingual"))) {
        throw new Error("--offline with no cached dataset rows; run once online first");
    }
    const rows = await fetchAllRows();
    const revision = datasetRevision(rows);
    const { instances, skipped } = rowsToInstances(rows);
    const pilot = selectPilot(instances, args.seed);
    const manifest: FrozenManifest = freezeManifest(instances, pilot, args.seed, revision);
    const manifestPath = writeManifest(manifest);
    const byId = new Map(instances.map((i) => [i.instanceId, i]));
    const splitIds = args.split === "pilot" ? manifest.pilot : manifest.dev;
    let selected = splitIds.map((id) => byId.get(id)).filter((i): i is BenchmarkInstance => i !== undefined);
    if (args.limit !== null) selected = selected.slice(0, args.limit);

    const outcomes: ReportOutcome[] = [];
    const excluded: Array<Record<string, unknown>> = [...skipped.map((s) => ({ ...s, stage: "loader" }))];
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
        manifestSha256: manifest.sha256,
        summary,
        excluded,
        excludedCount: excluded.length,
        outcomes,
    };
    mkdirSync(reportsDir(), { recursive: true });
    const digest = createHash("sha256").update(JSON.stringify(outcomes)).digest("hex").slice(0, 8);
    const reportPath = join(reportsDir(), `external-grep-${args.split}-${generatedAt.replace(/[:.]/g, "-")}-${digest}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`\nreport: ${reportPath}`);
    console.log(`manifest: ${manifestPath} (pilot=${manifest.pilot.length} dev=${manifest.dev.length} holdout=${manifest.holdout.length})`);
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
