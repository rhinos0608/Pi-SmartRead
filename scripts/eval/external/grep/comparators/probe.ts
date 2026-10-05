/**
 * Probe comparator (benchmark harness only, D13/D17).
 *
 * Search rule (disclosed, all Probe defaults): the formulation text (issue
 * title or full body — the same source text given to every system) is passed
 * verbatim as the search PATTERN:
 *
 *   `probe search <formulationText> <snapshotRoot> -o json --max-results 50`
 *
 * Frequency tokenization + stemming + BM25 ranking stay at Probe defaults
 * (`--frequency` on, `--reranker bm25`). No `--allow-tests`: test files and
 * test blocks are excluded by Probe's default product behavior. Results keep
 * Probe's rank order; ranks dedupe by first file appearance downstream.
 *
 * Rendered text: at most PROBE_RENDERED_RESULTS (50) lines of
 * `<relFile>:<startLine>:<firstCodeLine>` in rank order.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { formulationText, type BenchmarkInstance, type Formulation } from "../instance.js";
import type { ComparatorManifest, ComparatorOptions, ComparatorOutput, ComparatorUnit } from "./types.js";

export const PROBE_VERSION = "v0.6.0-rc341";
export const PROBE_MAX_RESULTS = 50;

export function probeBinary(): string {
    return join(
        homedir(),
        ".cache/pi-smartread-bench/tools/probe/probe-v0.6.0-rc341-aarch64-apple-darwin/probe",
    );
}

interface ProbeResult {
    file?: unknown;
    lines?: unknown;
    code?: unknown;
}

/** Parse `probe search -o json` stdout into rank-ordered units. */
export function parseProbeJson(stdout: string, root: string): ComparatorUnit[] {
    const start = stdout.indexOf("{");
    if (start < 0) return [];
    let doc: { results?: ProbeResult[] };
    try {
        doc = JSON.parse(stdout.slice(start)) as { results?: ProbeResult[] };
    } catch {
        return [];
    }
    const results = Array.isArray(doc.results) ? doc.results : [];
    const units: ComparatorUnit[] = [];
    for (const r of results) {
        if (typeof r !== "object" || r === null) continue;
        const abs = typeof r.file === "string" ? r.file : null;
        if (abs === null) continue;
        const rel = abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
        if (rel.startsWith("..") || rel === "") continue;
        const lines = Array.isArray(r.lines) ? r.lines : [];
        const startLine = typeof lines[0] === "number" && lines[0] >= 1 ? lines[0] : 1;
        const endLine = typeof lines[1] === "number" && lines[1] >= startLine ? lines[1] : startLine;
        const code = typeof r.code === "string" ? r.code.split("\n")[0]?.slice(0, 200) ?? "" : "";
        units.push({ relFile: rel, line: startLine, endLine, name: "", text: code });
    }
    return units;
}

/** Render at most PROBE_MAX_RESULTS rank-ordered result lines. */
export function renderProbeText(units: ComparatorUnit[]): string {
    return units
        .slice(0, PROBE_MAX_RESULTS)
        .map((u) => `${u.relFile}:${u.line}:${u.text ?? ""}`)
        .join("\n");
}

function errorStatus(error: unknown): string {
    if (error instanceof Error) {
        const timedOut = /ETIMEDOUT|timed out/i.test(error.message);
        const code = error.message.split(":")[0]?.trim().slice(0, 80) || "unknown";
        return `${timedOut ? "timeout" : "error"}:${code}`;
    }
    return "error:unknown";
}

/** Run Probe for one instance+formulation (no index step; setupMs = 0). */
export async function runProbe(
    instance: BenchmarkInstance,
    snapshotRoot: string,
    formulation: Formulation,
    options: ComparatorOptions,
): Promise<ComparatorOutput> {
    const query = formulationText(instance, formulation);
    if (query.trim() === "") {
        return { units: [], renderedText: "", elapsedMs: 0, setupMs: 0, status: "empty-query" };
    }
    const timeoutSec = Math.max(1, Math.ceil(options.timeoutMs / 1000));
    const started = performance.now();
    let status = "ok";
    let units: ComparatorUnit[] = [];
    try {
        const out: Buffer = execFileSync(
            probeBinary(),
            ["search", query, snapshotRoot, "-o", "json", "--max-results", String(PROBE_MAX_RESULTS), "--timeout", String(timeoutSec)],
            { timeout: options.timeoutMs, maxBuffer: 256 * 1024 * 1024 },
        );
        units = parseProbeJson(out.toString("utf8"), snapshotRoot);
    } catch (error) {
        status = errorStatus(error);
    }
    const elapsedMs = performance.now() - started;
    return { units, renderedText: renderProbeText(units), elapsedMs, setupMs: 0, status };
}

export function probeManifest(checksum: string): ComparatorManifest {
    return {
        system: "probe",
        tool: "probe",
        version: `${PROBE_VERSION} (probelabs/probe, Apache-2.0)`,
        checksumOrCommit: `sha256:${checksum}`,
        binaryPath: probeBinary(),
        searchRule:
            "formulation text verbatim as PATTERN; defaults kept " +
            "(frequency tokenization+stemming, bm25); --max-results 50; " +
            "test files/blocks excluded by Probe default (no --allow-tests)",
        formulationSource: "issue title (primary) / full body (stress), same source text",
        tokenCap: 8000,
    };
}
