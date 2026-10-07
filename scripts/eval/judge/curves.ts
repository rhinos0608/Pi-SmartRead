#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
    bestThresholdByCost,
    computeJudgeMetrics,
    prCurve,
    rocCurve,
    thresholdSweep,
    type ScoredLabel,
} from "./metrics.js";

const DEFAULT_OUT_DIR = join(homedir(), ".cache/pi-smartread-judge-spike/bench/curves");
const COST_RATIOS = [1, 2, 5, 10];
const SWEEP_MARKERS = [0.2, 0.4, 0.45];
const PALETTE = ["#1f6feb", "#cf222e", "#1a7f37", "#9a6700", "#8250df"];

interface ReportEntry {
    backend: string;
    model: string;
    reportId: string;
    file: string;
    scores: ScoredLabel[];
}

function parseArgs(argv: string[]): { reports: string[]; outDir: string } {
    const reports: string[] = [];
    let outDir = DEFAULT_OUT_DIR;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i] ?? "";
        if (arg === "--out") {
            const dir = argv[++i];
            if (!dir) throw new Error("--out requires a directory");
            outDir = resolve(dir);
        } else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npx tsx scripts/eval/judge/curves.ts [--out DIR] <report.json> [...]");
            process.exit(0);
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown argument: ${arg}`);
        } else {
            reports.push(arg);
        }
    }
    if (reports.length === 0) throw new Error("Provide at least one report path");
    return { reports, outDir };
}

function reportIdFromFilename(path: string): string {
    const base = basename(path);
    const pid = base.match(/-p(\d+)\.json$/);
    if (pid) return `p${pid[1]}`;
    const stamped = base.match(/results-(.+)\.json$/);
    if (stamped) return stamped[1]!;
    return base.replace(/\.json$/, "");
}

function loadEntries(path: string): ReportEntry[] {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const items = Array.isArray(raw.results)
        ? (raw.results as Record<string, unknown>[])
        : [raw];
    return items
        .filter((item) => Array.isArray(item.scores))
        .map((item) => ({
            backend: String(item.backend ?? "unknown"),
            model: String(item.model ?? "unknown"),
            reportId: reportIdFromFilename(path),
            file: path,
            scores: (item.scores as Array<Record<string, unknown>>).map((score) => ({
                label: score.label as ScoredLabel["label"],
                p: Number(score.p),
            })),
        }));
}

function esc(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Line {
    points: Array<{ x: number; y: number }>;
    color: string;
    dashed?: boolean;
}

function svgFigure(options: {
    title: string;
    lines: Line[];
    xLabel: string;
    yLabel: string;
    legend: string[];
    markers?: number[];
}): string {
    const width = 560;
    const height = 420;
    const margin = { top: 44, right: 16, bottom: 52, left: 56 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const x = (v: number): number => margin.left + v * innerW;
    const y = (v: number): number => margin.top + (1 - v) * innerH;
    const parts: string[] = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" role="img">`);
    parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
    parts.push(`<text x="${width / 2}" y="22" text-anchor="middle" font-size="13" font-family="sans-serif">${esc(options.title)}</text>`);
    for (let g = 0; g <= 10; g++) {
        const v = g / 10;
        parts.push(`<line x1="${x(v)}" y1="${y(0)}" x2="${x(v)}" y2="${y(1)}" stroke="#e5e5e5" stroke-width="1"/>`);
        parts.push(`<line x1="${x(0)}" y1="${y(v)}" x2="${x(1)}" y2="${y(v)}" stroke="#e5e5e5" stroke-width="1"/>`);
        parts.push(`<text x="${x(v)}" y="${y(0) + 16}" text-anchor="middle" font-size="10" font-family="sans-serif">${v.toFixed(1)}</text>`);
        parts.push(`<text x="${x(0) - 8}" y="${y(v) + 3}" text-anchor="end" font-size="10" font-family="sans-serif">${v.toFixed(1)}</text>`);
    }
    parts.push(`<rect x="${x(0)}" y="${y(1)}" width="${innerW}" height="${innerH}" fill="none" stroke="#333" stroke-width="1"/>`);
    for (const marker of options.markers ?? []) {
        parts.push(`<line x1="${x(marker)}" y1="${y(0)}" x2="${x(marker)}" y2="${y(1)}" stroke="#666" stroke-width="1" stroke-dasharray="4 3"/>`);
        parts.push(`<text x="${x(marker)}" y="${y(1) - 6}" text-anchor="middle" font-size="10" font-family="sans-serif">${marker.toFixed(2)}</text>`);
    }
    for (const line of options.lines) {
        const d = line.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
        const dash = line.dashed ? ` stroke-dasharray="5 4"` : "";
        parts.push(`<path d="${d}" fill="none" stroke="${line.color}" stroke-width="2"${dash}/>`);
    }
    parts.push(`<text x="${margin.left + innerW / 2}" y="${height - 8}" text-anchor="middle" font-size="11" font-family="sans-serif">${esc(options.xLabel)}</text>`);
    parts.push(`<text x="14" y="${margin.top + innerH / 2}" text-anchor="middle" font-size="11" font-family="sans-serif" transform="rotate(-90 14,${margin.top + innerH / 2})">${esc(options.yLabel)}</text>`);
    options.legend.forEach((entry, i) => {
        const ly = margin.top + 4 + i * 16;
        const color = options.lines[i]?.color ?? "#333";
        parts.push(`<rect x="${margin.left + 8}" y="${ly - 9}" width="18" height="3" fill="${color}"/>`);
        parts.push(`<text x="${margin.left + 30}" y="${ly}" font-size="10" font-family="sans-serif">${esc(entry)}</text>`);
    });
    parts.push("</svg>");
    return parts.join("\n");
}

function fmt(n: number, digits = 4): string {
    return n.toFixed(digits);
}

function printSweepTable(label: string, scores: ScoredLabel[]): void {
    console.log(`\n## threshold sweep: ${label} (n=${scores.length})`);
    console.log("thr | TP | FP | FN | TN | prec | rec | f1");
    for (const row of thresholdSweep(scores)) {
        console.log(
            `${row.threshold.toFixed(2)} | ${row.truePositives} | ${row.falsePositives} | ${row.falseNegatives} | ${row.trueNegatives} | ` +
            `${fmt(row.precision)} | ${fmt(row.recall)} | ${fmt(row.f1)}`,
        );
    }
}

function printCosts(label: string, scores: ScoredLabel[]): void {
    console.log(`\n## best threshold by cost: ${label}`);
    console.log("fnCostRatio | thr | cost | TP | FP | FN | prec | rec");
    for (const ratio of COST_RATIOS) {
        const best = bestThresholdByCost(scores, ratio);
        if (!best) {
            console.log(`${ratio} | n/a (empty)`);
            continue;
        }
        console.log(
            `${ratio} | ${best.threshold.toFixed(2)} | ${best.cost} | ${best.truePositives} | ` +
            `${best.falsePositives} | ${best.falseNegatives} | ${fmt(best.precision)} | ${fmt(best.recall)}`,
        );
    }
}

const { reports, outDir } = parseArgs(process.argv.slice(2));
const entries = reports.flatMap((path) => loadEntries(path));
if (entries.length === 0) throw new Error("No scored report entries found");
mkdirSync(outDir, { recursive: true });

const rocAll = entries.map((entry) => ({ entry, roc: rocCurve(entry.scores) }));
const prAll = entries.map((entry) => ({ entry, pr: prCurve(entry.scores) }));
const pooled: ScoredLabel[] = entries.flatMap((entry) => entry.scores);
const pooledMetrics = computeJudgeMetrics(pooled);
const pooledRoc = rocCurve(pooled);
const pooledPr = prCurve(pooled);
const prevalence = pooled.length === 0 ? 0 : pooled.filter((s) => s.label === "gold").length / pooled.length;

for (const [index, entry] of entries.entries()) {
    const roc = rocAll[index]?.roc ?? { points: [], auc: null };
    const pr = prAll[index]?.pr ?? { points: [], averagePrecision: null };
    const base = `${entry.backend}-${entry.reportId}`;
    const rocSvg = svgFigure({
        title: `ROC (${entry.backend}, AUC ${fmt(roc.auc ?? 0)}) — overlaid`,
        lines: [
            { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: "#999", dashed: true },
            ...rocAll.map((other, i) => ({
                points: other.roc.points.map((p) => ({ x: p.fpr, y: p.tpr })),
                color: PALETTE[i % PALETTE.length] ?? "#333",
            })),
        ],
        xLabel: "FPR",
        yLabel: "TPR",
        legend: [
            "diagonal (chance)",
            ...rocAll.map((other) => `${other.entry.backend} (AUC ${fmt(other.roc.auc ?? 0)})`),
        ],
    });
    const prSvg = svgFigure({
        title: `PR (${entry.backend}, AP ${fmt(pr.averagePrecision ?? 0)}) — overlaid`,
        lines: [
            { points: [{ x: 0, y: prevalence }, { x: 1, y: prevalence }], color: "#999", dashed: true },
            ...prAll.map((other, i) => ({
                points: other.pr.points.map((p) => ({ x: p.recall, y: p.precision })),
                color: PALETTE[i % PALETTE.length] ?? "#333",
            })),
        ],
        xLabel: "recall",
        yLabel: "precision",
        legend: [
            `prevalence ${fmt(prevalence)}`,
            ...prAll.map((other) => `${other.entry.backend} (AP ${fmt(other.pr.averagePrecision ?? 0)})`),
        ],
    });
    const sweep = thresholdSweep(entry.scores);
    const sweepSvg = svgFigure({
        title: `Precision/recall vs threshold (${entry.backend})`,
        lines: [
            { points: sweep.map((r) => ({ x: r.threshold, y: r.precision })), color: PALETTE[0] ?? "#1f6feb" },
            { points: sweep.map((r) => ({ x: r.threshold, y: r.recall })), color: PALETTE[1] ?? "#cf222e" },
        ],
        xLabel: "threshold",
        yLabel: "score",
        legend: ["precision", "recall"],
        markers: SWEEP_MARKERS,
    });
    writeFileSync(join(outDir, `${base}-roc.svg`), rocSvg);
    writeFileSync(join(outDir, `${base}-pr.svg`), prSvg);
    writeFileSync(join(outDir, `${base}-sweep.svg`), sweepSvg);
    console.log(`wrote ${join(outDir, `${base}-roc.svg`)}`);
    console.log(`wrote ${join(outDir, `${base}-pr.svg`)}`);
    console.log(`wrote ${join(outDir, `${base}-sweep.svg`)}`);
}

for (const entry of entries) {
    const metrics = computeJudgeMetrics(entry.scores);
    console.log(`\n# ${entry.backend} model=${entry.model} auroc=${fmt(metrics.auroc ?? 0)} n=${entry.scores.length}`);
    printSweepTable(entry.backend, entry.scores);
    printCosts(entry.backend, entry.scores);
}
console.log(`\n# pooled auroc=${fmt(pooledMetrics.auroc ?? 0)} auprc=${fmt(pooledPr.averagePrecision ?? 0)} rocAUC=${fmt(pooledRoc.auc ?? 0)} n=${pooled.length}`);
printSweepTable("pooled", pooled);
printCosts("pooled", pooled);
