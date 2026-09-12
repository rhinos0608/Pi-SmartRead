/**
 * Seam2 split of inspect.ts: shared runtime helpers.
 *
 * Canonical home for canonicalization (realpathSync), range merging,
 * token estimation, LSP provider resolution, lazy call-graph, and
 * import-edge / cluster-label / section-name utilities shared by
 * file + directory inspect pipelines. No envelopes, no dispatch.
 */
import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { resourceIdFor, type InspectedResource } from "@rhinos0608/pi-workspace-protocol";
import { uriToFsPath } from "./inspect-sections.js";
import type { InspectV4Input } from "./inspect-types.js";
import type { ContextGraph } from "./context-graph.js";
import { buildCallGraph, type CallGraphResult } from "./callgraph.js";
import { findSrcFiles } from "./file-discovery.js";
import type { LspInspectionProvider } from "./lsp-inspection.js";

export const SECTION_NL = "\n";
export function joinSectionLines(lines: string[]): string {
    return lines.join(SECTION_NL);
}

export function tryCanonical(filePath: string): string {
    try { return realpathSync(filePath); } catch { return filePath; }
}

export function estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

export function resolveLspProvider(input: InspectV4Input): LspInspectionProvider | null {
    return (input.lspInspectionProvider as LspInspectionProvider | undefined) ?? null;
}

export function canonicalizeSingleNavItem(it: unknown): unknown {
    if (!it || typeof it !== "object") return it;
    const rec = it as Record<string, any>;
    // callHierarchy incoming/outgoing: { from/to: { uri, range } }
    if (rec.from?.uri && typeof rec.from.uri === "string") {
        const canon = tryCanonical(uriToFsPath(rec.from.uri));
        return { ...rec, from: { ...rec.from, uri: "file://" + canon } };
    }
    if (rec.to?.uri && typeof rec.to.uri === "string") {
        const canon = tryCanonical(uriToFsPath(rec.to.uri));
        return { ...rec, to: { ...rec.to, uri: "file://" + canon } };
    }
    const loc = rec.location ?? it;
    if (loc && typeof (loc as any).uri === "string") {
        const canon = tryCanonical(uriToFsPath((loc as any).uri));
        const newUri = "file://" + canon;
        if (rec.location) return { ...rec, location: { ...rec.location, uri: newUri } };
        return { ...rec, uri: newUri };
    }
    if (typeof rec.uri === "string") {
        const canon = tryCanonical(uriToFsPath(rec.uri));
        return { ...rec, uri: "file://" + canon };
    }
    return it;
}

export function canonicalizeNavigationItems(items: unknown[], _cwd: string): unknown[] {
    return (items as any[]).map(canonicalizeSingleNavItem);
}

export function mergeRanges(ranges: Array<{ startLine: number; endLine: number }>): Array<{ startLine: number; endLine: number }> {
    if (ranges.length <= 1) return ranges;
    const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
    const out: Array<{ startLine: number; endLine: number }> = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r.startLine <= last.endLine + 1) {
            last.endLine = Math.max(last.endLine, r.endLine);
        } else {
            out.push({ ...r });
        }
    }
    return out;
}

export function setResourceRanges(
    resourcesByPath: Map<string, InspectedResource>,
    canonical: string,
    line: number,
): void {
    const canon = tryCanonical(canonical);
    const existing = resourcesByPath.get(canon);
    if (existing) {
        const merged = mergeRanges([...existing.allowedRanges, { startLine: line, endLine: line }]);
        resourcesByPath.set(canon, { ...existing, allowedRanges: merged });
    } else {
        resourcesByPath.set(canon, {
            resourceId: resourceIdFor({ canonicalPath: canon, kind: "range", range: { startLine: line, endLine: line } }),
            canonicalPath: canon,
            kind: "range",
            coverage: "search-match",
            allowedRanges: [{ startLine: line, endLine: line }],
            fresh: false,
        });
    }
}

export function addResource(
    resourcesByPath: Map<string, InspectedResource>,
    filePath: string,
    cwd: string,
): void {
    const canonical = tryCanonical(pathResolve(cwd, filePath));
    if (!resourcesByPath.has(canonical)) {
        resourcesByPath.set(canonical, {
            resourceId: resourceIdFor({ canonicalPath: canonical, kind: "range" }),
            canonicalPath: canonical,
            kind: "range",
            coverage: "search-match",
            allowedRanges: [{ startLine: 1, endLine: 1 }],
            fresh: false,
        });
    }
}

export function addSearchMatchResource(map: Map<string, InspectedResource>, filePath: string, _cwd: string, _loc: unknown) {
    try {
        const canon = tryCanonical(filePath);
        let startLine: number | undefined;
        let endLine: number | undefined;
        try {
            const rawRange =
                (_loc as any)?.range ??
                (_loc as any)?.location?.range ??
                (_loc as any)?.selectionRange ??
                (_loc as any)?.location?.selectionRange;
            if (rawRange?.start?.line !== undefined) {
                startLine = (rawRange.start.line as number) + 1;
                if (rawRange?.end?.line !== undefined) endLine = (rawRange.end.line as number) + 1;
                else endLine = startLine;
            } else if ((_loc as any)?.line !== undefined) {
                startLine = (_loc as any).line as number;
                endLine = ((_loc as any).endLine as number | undefined) ?? startLine;
                // legacy line is already 1-based; if endLine provided but seems 0-based, keep as is
            }
        } catch {}
        if (startLine === undefined || endLine === undefined) return;
        const newRange = { startLine, endLine };
        const existing = map.get(canon);
        if (existing) {
            const merged = mergeRanges([...existing.allowedRanges, newRange]);
            map.set(canon, { ...existing, allowedRanges: merged });
            return;
        }
        map.set(canon, {
            resourceId: resourceIdFor({ canonicalPath: canon, kind: "range", range: newRange }),
            canonicalPath: canon,
            kind: "range",
            coverage: "search-match",
            allowedRanges: [newRange],
            fresh: false,
        });
    } catch {}
}

export function toDiagnosticsOverallStatus(files: Array<{ status: string; diagnostics: unknown[] }>): string {
    // Extension seam: future mutating autofix/format and external security-scanner triage plugs here — add new status values (e.g. "needs-triage") without closing switch/default paths.
    const hasFindings = files.some((f) => (f.diagnostics as unknown[]).length > 0);
    if (hasFindings) return "findings";
    const allUnavailable = files.every((f) => f.status === "unavailable");
    if (allUnavailable) return "unavailable";
    const allEmpty = files.every((f) => f.status === "empty");
    if (allEmpty) return "unconfirmed";
    return "partial";
}

export async function ensureCallGraph(
    input: InspectV4Input,
    existing: CallGraphResult | null,
): Promise<CallGraphResult | null> {
    if (existing) return existing;
    try {
        const cwd = realpathSync(input.cwd);
        const files = await findSrcFiles(cwd);
        return await buildCallGraph(files);
    } catch {
        return null;
    }
}

/**
 * Build import edges from ContextGraph for community detection / layer analysis.
 * Falls back to empty array when contextGraph is not available.
 */
export function buildImportEdges(contextGraph: ContextGraph | undefined): Array<{ from: string; to: string }> {
    if (!contextGraph) return [];
    // Use ContextGraph's getProvenanceEdges() to extract import/call edges
    // recorded during file-index population.
    const provenances = contextGraph.getProvenanceEdges();
    if (provenances.length > 0) return provenances;
    // If no provenances recorded yet, try getFileNeighbours on each known file.
    // For now, return empty — community detection / layer analysis degrade gracefully.
    return [];
}

/**
 * Guess a human-readable label for a cluster based on common path patterns.
 */
export function guessClusterLabel(members: string[]): string {
    // Count path segment tokens
    const tokens = new Map<string, number>();
    for (const m of members) {
        const parts = m.split("/");
        for (const p of parts) {
            const clean = p.replace(/\.[^.]+$/, "").toLowerCase();
            if (clean.length > 2 && clean !== "src" && clean !== "lib" && clean !== "index") {
                tokens.set(clean, (tokens.get(clean) ?? 0) + 1);
            }
        }
    }
    // Most common token wins
    let best = "";
    let bestCount = 0;
    for (const [token, count] of tokens) {
        if (count > bestCount) {
            bestCount = count;
            best = token;
        }
    }
    return best || "unknown";
}

/**
 * Map section index back to a human-readable section name for budget truncation messages.
 */
export function findSectionName(sections: string[], index: number): string {
    const text = sections[index] ?? "";
    const match = text.match(/^##\s+(.+?)(?:\s*\(|$)/m);
    if (match?.[1]) return match[1].trim();
    return `Section ${index + 1}`;
}

export function riskOrder(risk: string): number {
    switch (risk) {
        case "critical": return 0;
        case "high": return 1;
        case "medium": return 2;
        case "low": return 3;
        default: return 4;
    }
}
