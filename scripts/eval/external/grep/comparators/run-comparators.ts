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
import { COMPARATORS, comparatorManifest, isComparatorName, type ComparatorName } from "./index.js";
import type { BenchmarkInstance, Formulation } from "../instance.js";
import { computeInstanceMetrics, summarizeMetrics, type InstanceMetrics } from "../metrics.js";
import { assertMultiSweBenchLicense } from "../multi-swe-bench.js";
import { ensureBareClone, materializeInstance } from "../repos.js";
import { freezeManifest, selectPilot, writeManifest, type FrozenManifest } from "../sampling.js";
import { datasetRevision, fetchAllRows, rowsToInstances } from "../swebench-multilingual.js";

/** Per-run outcome: standard metrics plus comparator setup/index time. */
export type ComparatorOutcome = InstanceMetrics & { setupMs: number };

function parseArgs(argv: string[]): {
    system: ComparatorName;
    split: string;
    formulations: Formulation[];
    limit: number | null;
    timeoutMs: number;
    seed: string;
    offline: boolean;
    multiSweBench: boolean;
} {
    let system: ComparatorName | null = null;
    let split = "pilot";
    let formulationArg = "both";
    let limit: number | null = null;
    let timeoutMs = 60000;
    let seed = "external-grep-v1";
    let offline = false;
    let multiSweBench = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--system") {
            const value = argv[++i] ?? "";
            if (!isComparatorName(value)) throw new Error("--system must be ripgrep|probe|codanna");
            system = value;
        } else if (arg === "--split") split = argv[++i] ?? split;
        else if (arg === "--formulation") formulationArg = argv[++i] ?? formulationArg;
        else if (arg === "--limit") limit = Number(argv[++i]);
        else if (arg === "--timeout-ms") timeoutMs = Number(argv[++i] ?? "");
        else if (arg === "--seed") seed = argv[++i] ?? seed;
        else if (arg === "--offline") offline = true;
        else if (arg === "--multi-swe-bench") multiSweBench = true;
        else if (arg === "--accept-license-review") continue;
        else if (arg === "--help" || arg === "-h") {
            console.log("Usage: run-comparators.ts --system ripgrep|probe|codanna [--split pilot|dev] [--formulation title|body|both] [--limit N] [--timeout-ms N] [--seed SEED] [--offline]");
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (system === null) throw new Error("--system is required (ripgrep|probe|codanna)");
    if (multiSweBench) assertMultiSweBenchLicense(argv);
    if (!["pilot", "dev"].includes(split)) throw new Error("--split must be pilot|dev");
    if (!["title", "body", "both"].includes(formulationArg)) throw new Error("--formulation must be title|body|both");
    const formulations: Formulation[] =
        formulationArg === "both" ? ["title", "body"] : [formulationArg as Formulation];
    return { system, split, formulations, limit, timeoutMs, seed, offline, multiSweBench };
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
    const rows = await fetchAllRows({ offline: args.offline });
    const revision = datasetRevision(rows);
    const { instances, skipped } = rowsToInstances(rows);
    const pilot = selectPilot(instances, args.seed);
    const manifest: FrozenManifest = freezeManifest(instances, pilot, args.seed, revision);
    const manifestPath = writeManifest(manifest);
    const byId = new Map(instances.map((i) => [i.instanceId, i]));
    const splitIds = args.split === "pilot" ? manifest.pilot : manifest.dev;
    let selected = splitIds.map((id) => byId.get(id)).filter((i): i is BenchmarkInstance => i !== undefined);
    if (args.limit !== null) selected = selected.slice(0, args.limit);

    const runner = COMPARATORS[args.system];
    const outcomes: ComparatorOutcome[] = [];
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
        manifestSha256: manifest.sha256,
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
    console.log(`manifest: ${manifestPath} (pilot=${manifest.pilot.length} dev=${manifest.dev.length} holdout=${manifest.holdout.length})`);
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
