/**
 * Phase B split of inspect.ts: shared section renderers + runSection helpers.
 *
 * Pure rendering (no envelopes, no LSP gating). Callers own budgets/resources.
 */
import { fileURLToPath } from "node:url";
import type { CallGraphResult } from "../structural/callgraph.js";
import type { StructuralFacts } from "../structural/structural-facts-types.js";
import type { CallDirection } from "./inspect-types.js";

// ── runSection helpers ─────────────────────────────────────────
// Collapse near-identical try/catch section fallbacks into one helper.
// Failure note preserved per caller; default matches majority case.
export function runSection(label: string, fn: () => string, failureNote = "(computation failed)"): string {
    try {
        return fn();
    } catch {
        return `## ${label}\n\n${failureNote}`;
    }
}

export async function runSectionAsync(label: string, fn: () => Promise<string>, failureNote = "(computation failed)"): Promise<string> {
    try {
        return await fn();
    } catch {
        return `## ${label}\n\n${failureNote}`;
    }
}

export function uriToFsPath(uri: string): string | null {
    if (!uri.startsWith("file://")) return null;
    try {
        return fileURLToPath(uri);
    } catch {
        try {
            const parsed = new URL(uri);
            if (parsed.protocol !== "file:") return null;
            return decodeURIComponent(parsed.pathname);
        } catch {
            return null;
        }
    }
}

export function renderNavigationSection(details: { operation: string; status: string; items: unknown[]; truncated: boolean }, _cwd: string): string {
    const lines: string[] = [];
    lines.push("## LSP Navigation");
    lines.push("");
    lines.push(`Operation: ${details.operation} — status: ${details.status} — source: lsp${details.truncated ? " — truncated" : ""}`);
    lines.push("");
    if (details.status === "empty") lines.push("_empty \u2260 clean/complete — never treat as proof of absence._");
    if (details.status === "unavailable") lines.push("_LSP unavailable for this file/query._");
    if (details.status === "degraded") lines.push("_LSP degraded (timeout/error)._"
    );
    if (details.items.length === 0) {
        lines.push("No results.");
    } else {
        lines.push(`Results (${details.items.length}${details.truncated ? ", truncated" : ""}):`);
        for (const it of details.items as any[]) {
            if (it?.from?.uri) {
                const p = typeof it.from.uri === "string" ? uriToFsPath(it.from.uri) : null;
                if (p === null) continue;
                const range = it.from.range ?? it.fromRanges?.[0];
                const pos = range ? `:${range.start.line + 1}:${range.start.character + 1}` : "";
                const fromRanges = it.fromRanges ? ` (${it.fromRanges.length} range(s))` : "";
                lines.push(`- incoming from ${it.from.name} (kind ${it.from.kind}) — ${p}${pos}${fromRanges}`);
            } else if (it?.to?.uri) {
                const p = typeof it.to.uri === "string" ? uriToFsPath(it.to.uri) : null;
                if (p === null) continue;
                const range = it.to.range ?? it.fromRanges?.[0];
                const pos = range ? `:${range.start.line + 1}:${range.start.character + 1}` : "";
                const fromRanges = it.fromRanges ? ` (${it.fromRanges.length} range(s))` : "";
                lines.push(`- outgoing to ${it.to.name} (kind ${it.to.kind}) — ${p}${pos}${fromRanges}`);
            } else if (it?.name) {
                const rawLoc = typeof it.location?.uri === "string" ? it.location.uri : typeof it.uri === "string" ? it.uri : null;
                const loc = rawLoc === null ? null : uriToFsPath(rawLoc);
                const range = it.location?.range ?? it.range;
                const pos = range ? `:${range.start.line + 1}:${range.start.character + 1}` : "";
                lines.push(`- ${it.name} (kind ${it.kind})${loc ? ` — ${loc}${pos}` : ""}`);
            } else if (it?.contents !== undefined) {
                const text = typeof it.contents === "string" ? it.contents : Array.isArray(it.contents) ? (it.contents as any[]).map((c: any) => typeof c === "string" ? c : c.value ?? "").join("\n") : (it.contents as any).value ?? "";
                const preview = String(text).slice(0, 200).replace(/\n/g, " ");
                lines.push(`- hover: ${preview}`);
            } else if (it?.uri) {
                const p = typeof it.uri === "string" ? uriToFsPath(it.uri) : null;
                if (p === null) continue;
                const range = it.range;
                const pos = range ? `:${range.start.line + 1}:${range.start.character + 1}` : "";
                lines.push(`- ${p}${pos}`);
            } else if (it?.location?.uri) {
                const p = typeof it.location.uri === "string" ? uriToFsPath(it.location.uri) : null;
                if (p === null) continue;
                const range = it.location.range;
                const pos = range ? `:${range.start.line + 1}:${range.start.character + 1}` : "";
                lines.push(`- ${p}${pos}`);
            } else {
                lines.push(`- ${JSON.stringify(it).slice(0, 200)}`);
            }
        }
    }
    return lines.join("\n");
}

export function renderDiagnosticsSection(details: { status: string; files: Array<{ path: string; diagnostics: unknown[]; truncated?: boolean }>; truncated: boolean }, _cwd: string): string {
    const lines: string[] = [];
    lines.push("## LSP Diagnostics");
    lines.push("");
    lines.push(`Status: ${details.status} — source: lsp${details.truncated ? " — truncated" : ""}`);
    lines.push("");
    if (details.status === "unconfirmed") lines.push("_unconfirmed \u2260 clean/complete — not proof of absence._");
    if (details.status === "unavailable") lines.push("_LSP unavailable._");
    if (details.status === "partial") lines.push("_Partial results (some files unavailable/degraded)._"
    );
    if (details.files.length === 0) {
        lines.push("No files.");
    } else {
        for (const f of details.files) {
            const diags = f.diagnostics as any[];
            lines.push(`- ${f.path}: ${diags.length} diagnostic(s)${f.truncated ? " (truncated)" : ""}`);
            for (const d of diags) {
                const msg = (d as any).message ?? JSON.stringify(d).slice(0, 200);
                const sev = (d as any).severity !== undefined ? ` [severity ${(d as any).severity}]` : "";
                const range = (d as any).range;
                const pos = range ? ` @ ${range.start.line + 1}:${range.start.character + 1}` : "";
                lines.push(`  - ${msg}${sev}${pos}`);
            }
        }
    }
    return lines.join("\n");
}

// ── Call-graph renderer ────────────────────────────────────────────

export function renderCallGraphSection(
    callGraph: CallGraphResult | null,
    targetFile: string,
    facts: StructuralFacts,
    depth: number,
    direction: CallDirection,
    cwd: string,
): { text: string; emittedFiles: string[] } {
    const lines: string[] = [
        `## Call Graph (depth=${depth}, direction=${direction})`,
        "",
    ];
    const emittedFiles = new Set<string>();

    if (!callGraph) {
        lines.push("(call graph not available — build with includeCalls: true)");
        return { text: lines.join("\n"), emittedFiles: [] };
    }

    // Find functions defined in this file
    const fileFns = callGraph.functions.filter(f => f.file === targetFile);

    if (fileFns.length === 0) {
        // Fall back to children from structural facts
        for (const child of facts.children) {
            lines.push(`  ${child.name}()  L${child.line}`);
            lines.push("");
        }
        if (facts.children.length === 0) {
            lines.push("(no function definitions found in file)");
        }
        return { text: lines.join("\n"), emittedFiles: [] };
    }

    // Outbound (callees)
    if (direction === "callees" || direction === "both") {
        lines.push("outbound:");
        for (const fn of fileFns.slice(0, 5)) {
            lines.push(`  ${fn.name}()  L${fn.line}`);
            renderCallees(callGraph, fn, lines, depth, 1, cwd, undefined, emittedFiles);
        }
        lines.push("");
    }

    // Inbound (callers)
    if (direction === "callers" || direction === "both") {
        lines.push("inbound:");
        for (const fn of fileFns.slice(0, 5)) {
            if (fn.calledBy.length > 0) {
                lines.push(`  ${fn.name}()  L${fn.line}  ← calls this`);
                renderCallers(callGraph, fn, lines, depth, 1, cwd, undefined, emittedFiles);
            }
        }
        lines.push("");
    }

    return { text: lines.join("\n"), emittedFiles: [...emittedFiles] };
}

function renderCallees(
    cg: CallGraphResult,
    fn: { calls: string[] },
    lines: string[],
    maxDepth: number,
    currentDepth: number,
    cwd: string,
    visited?: Set<string>,
    emittedFiles?: Set<string>,
): void {
    if (currentDepth > maxDepth) return;
    const visitedSet = visited ?? new Set<string>();
    const indent = "    ".repeat(currentDepth);
    for (const calleeStr of fn.calls.slice(0, 10)) {
        const parts = calleeStr.split(":");
        const name = parts.length === 2 ? parts[1]! : calleeStr;
        if (visitedSet.has(name)) continue;
        visitedSet.add(name);
        const file = parts.length === 2 ? parts[0] : undefined;
        if (file) emittedFiles?.add(file);
        const fileSuffix = file ? `  ${file}` : "";
        lines.push(`${indent}→ ${name}()${fileSuffix}`);
        // Recurse into callees of the called function
        const calleeFn = cg.functions.find(f => f.name === name);
        if (calleeFn) {
            renderCallees(cg, calleeFn, lines, maxDepth, currentDepth + 1, cwd, visitedSet, emittedFiles);
        }
    }
}

function renderCallers(
    cg: CallGraphResult,
    fn: { calledBy: string[] },
    lines: string[],
    maxDepth: number,
    currentDepth: number,
    _cwd: string,
    visited?: Set<string>,
    emittedFiles?: Set<string>,
): void {
    if (currentDepth >= maxDepth) return;
    const visitedSet = visited ?? new Set<string>();
    const indent = "    ".repeat(currentDepth);
    for (const callerStr of fn.calledBy.slice(0, 10)) {
        const parts = callerStr.split(":");
        const name = parts.length === 2 ? parts[1]! : callerStr;
        if (visitedSet.has(name)) continue;
        visitedSet.add(name);
        const file = parts.length === 2 ? parts[0] : undefined;
        if (file) emittedFiles?.add(file);
        const fileSuffix = file ? `  ${file}` : "";
        lines.push(`${indent}← ${name}()${fileSuffix}`);
        const callerFn = cg.functions.find(f => f.name === name);
        if (callerFn) {
            renderCallers(cg, callerFn, lines, maxDepth, currentDepth + 1, _cwd, visitedSet, emittedFiles);
        }
    }
}
