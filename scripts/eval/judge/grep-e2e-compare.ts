#!/usr/bin/env npx tsx
/**
 * Paired comparison of two grep-e2e report JSONs (baseline, variant).
 * Pure offline reader: no engine IO, no reruns.
 *
 *   npx tsx scripts/eval/judge/grep-e2e-compare.ts --baseline A.json --variant B.json [--json]
 *
 * Refuses to pair unless fixture/corpus identity matches (fixtureSha,
 * corpus inventory hash, ordered qid set); engineSourceHash may differ.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pairReports, type PairedReport } from "./grep-e2e-contract.js";

function usage(): never {
    console.log("Usage: npx tsx scripts/eval/judge/grep-e2e-compare.ts --baseline A.json --variant B.json [--json]");
    process.exit(1);
}

function loadReport(path: string): PairedReport {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as PairedReport;
}

const argv = process.argv.slice(2);
let baselinePath: string | null = null;
let variantPath: string | null = null;
let asJson = false;
for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--baseline") baselinePath = argv[++i] ?? null;
    else if (arg === "--variant") variantPath = argv[++i] ?? null;
    else if (arg === "--json") asJson = true;
    else usage();
}
if (!baselinePath || !variantPath) usage();

const comparison = pairReports(loadReport(baselinePath), loadReport(variantPath), {
    baseline: baselinePath,
    variant: variantPath,
});
if (asJson) {
    console.log(JSON.stringify(comparison, null, 2));
} else {
    const line = (label: string, t: { wins: number; losses: number; ties: number }): string =>
        `${label}: +${t.wins}/-${t.losses}/=${t.ties}`;
    console.log(`paired ${comparison.queryCount} queries: ${baselinePath} vs ${variantPath}`);
    console.log(line("readReadySpanAt5", comparison.readReady));
    console.log(line("fileHit@5      ", comparison.fileHit));
    console.log(line("abstention     ", comparison.abstention));
    console.log(`meanTokenDelta(variant-baseline): ${comparison.meanTokenDelta.toFixed(1)}`);
    for (const d of comparison.deltas.filter((d) => d.readReady !== "tie" || d.fileHit !== "tie" || d.abstention !== "tie")) {
        console.log(`  ${d.qid}: readReady=${d.readReady} fileHit=${d.fileHit} abstention=${d.abstention} tokΔ=${d.tokenDelta}`);
    }
}
