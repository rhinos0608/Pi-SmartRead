/**
 * File inspect section builders in render order.
 *
 * Ordered descriptors preserve the pipeline's text order exactly:
 * callGraph → impact → diff → deadCode → routes → hotspots →
 * navigation → diagnostics → graphSchema. Each builder returns rendered
 * text plus its own evidence resources; the budget stage admits both
 * together so omitted sections authorize nothing.
 */
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import type { InspectedResource } from "@rhinos0608/pi-workspace-protocol";
import { detectDeadCode, expandBlastRadius, classifyFileRisk } from "./impact-analysis.js";
import { extractRoutes } from "./route-extraction.js";
import type { CallGraphResult } from "../structural/callgraph.js";
import { inspectNavigation as directInspectNavigation, inspectDiagnostics as directInspectDiagnostics } from "../lsp/lsp-inspection.js";
import { uriToFsPath, renderNavigationSection, renderDiagnosticsSection, renderCallGraphSection } from "./inspect-sections.js";
import { renderDiffSection } from "./inspect-diff.js";
import type { InspectV4Input } from "./inspect-types.js";
import {
    SECTION_NL,
    joinSectionLines,
    tryCanonical,
    addSearchMatchResource,
    addResource,
    canonicalizeNavigationItems,
    resolveLspProvider,
    toDiagnosticsOverallStatus,
    riskOrder,
} from "./inspect-runtime.js";

export type SectionResources = Map<string, InspectedResource>;

export interface FileSectionResult {
    text: string;
    resources: SectionResources;
}

export interface FileNavSectionResult extends FileSectionResult {
    details: any;
}

export interface FileDiagSectionResult extends FileSectionResult {
    details: any;
}

export interface FileCallGraphSectionResult extends FileSectionResult {
    emittedFiles: string[];
}

// ── Call graph (callDepth + callDirection) ──────────────────────────

type CallGraphSectionParams = [
    input: InspectV4Input,
    cwd: string,
    absolutePath: string,
    relativePath: string,
    facts: { internalCallSites: Array<{ line: number }>; externalDependents?: unknown },
    callGraph: CallGraphResult | null,
];

function renderCallGraphText(
    input: InspectV4Input,
    cwd: string,
    relativePath: string,
    facts: { internalCallSites: Array<{ line: number }>; externalDependents?: unknown },
    callGraph: CallGraphResult | null,
): { text: string; emittedFiles: string[] } {
    const depth = Math.min(Math.max(input.callDepth ?? 1, 1), 5);
    const direction = input.callDirection ?? "both";
    return renderCallGraphSection(callGraph, relativePath, facts as any, depth, direction, cwd);
}

export function buildFileCallGraphSection(...args: CallGraphSectionParams): FileSectionResult {
    const [input, cwd, absolutePath, relativePath, facts, callGraph] = args;
    try {
        const { text, emittedFiles } = renderCallGraphText(input, cwd, relativePath, facts, callGraph);
        const sr = new Map<string, InspectedResource>();
        addResource(sr, absolutePath, cwd);
        for (const refFile of emittedFiles) {
            addResource(sr, refFile, cwd);
        }
        return { text, resources: sr };
    } catch {
        return { text: "## Call Graph\n\n(computation failed)", resources: new Map() };
    }
}

// ── Impact ──────────────────────────────────────────────────────────

type ImpactSectionParams = [
    input: InspectV4Input,
    cwd: string,
    absolutePath: string,
    relativePath: string,
    facts: { externalDependents?: Array<{ file: string; line: number }> },
    callGraph: CallGraphResult | null,
];

interface AffectedFile { path: string; risk: string; fanIn: number; depth: number }

function buildFanInByFile(callGraph: CallGraphResult | null, cwd: string): Map<string, number> {
    const totals = new Map<string, number>();
    if (!callGraph) return totals;
    for (const f of callGraph.functions) {
        const rel = pathRelative(cwd, f.file);
        totals.set(rel, (totals.get(rel) ?? 0) + f.calledBy.length);
    }
    return totals;
}

function fanInForFile(fanInByFile: Map<string, number>, fp: string): number {
    return fanInByFile.get(fp) ?? 0;
}

function formatBlastRadiusLines(relativePath: string, affectedFiles: AffectedFile[]): string[] {
    const sorted = [...affectedFiles].sort((a, b) => riskOrder(a.risk) - riskOrder(b.risk) || b.fanIn - a.fanIn);
    const lines: string[] = [
        `## Impact Analysis: ${relativePath}`,
        "",
        `Risk: ${sorted.length > 0 ? sorted[0]!.risk.toUpperCase() : "LOW"}`,
        `  - Blast radius: depth ${sorted.reduce((m, f) => Math.max(m, f.depth), 0)} (${sorted.length} files)`,
        "",
        "Affected Files (by risk):",
    ];
    for (const af of sorted.slice(0, 15)) {
        lines.push(`  ${af.risk.toUpperCase().padEnd(10)} ${af.path.padEnd(40)} — ${af.fanIn} callers`);
    }
    if (sorted.length > 15) lines.push(`  ... (+${sorted.length - 15} more files)`);
    return lines;
}

async function buildImpactWithGraph(
    input: InspectV4Input,
    cwd: string,
    absolutePath: string,
    relativePath: string,
    callGraph: CallGraphResult | null,
): Promise<FileSectionResult> {
    const sr = new Map<string, InspectedResource>();
    const contextGraph = input.contextGraph!;
    const blastRadius = await expandBlastRadius(absolutePath, contextGraph, 3, input.cwd);
    const fanInByFile = buildFanInByFile(callGraph, cwd);
    const affectedFiles: AffectedFile[] = [];
    for (const [fp, { depth: d }] of blastRadius) {
        if (fp === absolutePath) continue;
        const fanIn = fanInForFile(fanInByFile, pathRelative(cwd, fp));
        const risk = classifyFileRisk({ filePath: fp, pageRank: 0, fanIn, blastRadiusDepth: d });
        affectedFiles.push({ path: pathRelative(cwd, fp), risk, fanIn, depth: d });
    }
    // Authorize only the displayed slice (same sort + top-15 as rendered).
    const displayed = [...affectedFiles]
        .sort((a, b) => riskOrder(a.risk) - riskOrder(b.risk) || b.fanIn - a.fanIn)
        .slice(0, 15);
    for (const af of displayed) addResource(sr, pathResolve(cwd, af.path), cwd);
    return { text: formatBlastRadiusLines(relativePath, affectedFiles).join("\n"), resources: sr };
}

function buildImpactFallback(
    cwd: string,
    relativePath: string,
    facts: { externalDependents?: Array<{ file: string; line: number }> },
): FileSectionResult {
    const deps = facts.externalDependents ?? [];
    const lines: string[] = [
        `## Impact Analysis: ${relativePath}`,
        "",
        "Context graph not available — direct import-scan only (no transitive blast radius)",
        "",
        `External Dependents (files importing this module): ${deps.length}`,
    ];
    const sr = new Map<string, InspectedResource>();
    if (deps.length === 0) return { text: lines.join("\n"), resources: sr };
    for (const d of deps) addResource(sr, d.file, cwd);
    lines.push("", "Direct dependent files:");
    for (const d of deps.slice(0, 20)) lines.push(`  ${pathRelative(cwd, d.file)}:${d.line}`);
    if (deps.length > 20) lines.push(`  ... (+${deps.length - 20} more)`);
    return { text: lines.join("\n"), resources: sr };
}

export async function buildFileImpactSection(...args: ImpactSectionParams): Promise<FileSectionResult> {
    const [input, cwd, absolutePath, relativePath, facts, callGraph] = args;
    try {
        if (input.contextGraph) return await buildImpactWithGraph(input, cwd, absolutePath, relativePath, callGraph);
        return buildImpactFallback(cwd, relativePath, facts);
    } catch {
        return { text: "## Impact Analysis\n\n(computation failed)", resources: new Map() };
    }
}

// ── Diff ────────────────────────────────────────────────────────────

export async function buildFileDiffSection(
    input: InspectV4Input,
    cwd: string,
    absolutePath: string,
    callGraph: CallGraphResult | null,
): Promise<FileSectionResult & { emittedFiles: string[] }> {
    try {
        const section = await renderDiffSection(input.diff!, cwd, callGraph);
        const sr = new Map<string, InspectedResource>();
        addResource(sr, absolutePath, cwd);
        for (const fp of section.emittedFiles) {
            addResource(sr, fp, cwd);
        }
        return { text: section.text, resources: sr, emittedFiles: section.emittedFiles };
    } catch {
        return { text: "## Diff Impact\n\n(computation failed)", resources: new Map(), emittedFiles: [] };
    }
}

export function buildFileDeadCodeSection(cwd: string, absolutePath: string, callGraph: CallGraphResult): { text: string; resources: SectionResources } {
    try {
        // Relative path required: callGraph.functions[].file stores relative paths.
        const fileRelPath = pathRelative(cwd, absolutePath);
        const deadCode = detectDeadCode(fileRelPath, callGraph);
        const sr = new Map<string, InspectedResource>();
        addResource(sr, absolutePath, cwd);
        if (deadCode.totalDeadFunctions === 0) {
            return { text: "## Dead Code" + SECTION_NL + SECTION_NL + "(no zero-caller functions found in this file)", resources: sr };
        }
        const lines: string[] = [`## Dead Code (${deadCode.totalDeadFunctions} zero-caller functions)`, ""];
        for (const file of deadCode.files) {
            lines.push(`  ${file.path}:`);
            for (const fn of file.functions) {
                lines.push(`    ${fn.name}()  L${fn.line}`);
            }
            lines.push("");
        }
        return { text: joinSectionLines(lines), resources: sr };
    } catch {
        return { text: "## Dead Code" + SECTION_NL + SECTION_NL + "(detection failed)", resources: new Map() };
    }
}

export function buildFileRoutesSection(absolutePath: string, cwd: string): { text: string; resources: SectionResources } {
    try {
        const routes = extractRoutes(absolutePath);
        if (routes.length === 0) {
            return { text: "## HTTP Routes" + SECTION_NL + SECTION_NL + "(no routes found in this file)", resources: new Map() };
        }
        const lines: string[] = [`## HTTP Routes (${routes.length} routes)`, ""];
        for (const r of routes) {
            const handler = r.handler ?? "(handler)";
            lines.push(`  ${r.method.padEnd(7)} ${r.path.padEnd(30)} → ${handler}  L${r.line}`);
        }
        const sr = new Map<string, InspectedResource>();
        addResource(sr, absolutePath, cwd);
        return { text: joinSectionLines(lines), resources: sr };
    } catch {
        return { text: "## HTTP Routes" + SECTION_NL + SECTION_NL + "(extraction failed)", resources: new Map() };
    }
}

export function buildFileHotspotsSection(cwd: string, absolutePath: string, callGraph: CallGraphResult): { text: string; resources: SectionResources } {
    try {
        const fileRelPath = pathRelative(cwd, absolutePath);
        const fileFns = callGraph.functions
            .filter(f => f.file === fileRelPath)
            .sort((a, b) => b.calledBy.length - a.calledBy.length)
            .slice(0, 15);
        const sr = new Map<string, InspectedResource>();
        addResource(sr, absolutePath, cwd);
        if (fileFns.length === 0) {
            return { text: "## Hotspots" + SECTION_NL + SECTION_NL + "(no function data for this file)", resources: sr };
        }
        const lines: string[] = [`## Hotspots (${fileFns.length} functions by fan-in)`, ""];
        for (let i = 0; i < fileFns.length; i++) {
            const fn = fileFns[i]!;
            const num = String(i + 1).padStart(2, " ");
            lines.push(`  ${num}. ${fn.name.padEnd(35)} L${fn.line}  — ${fn.calledBy.length} callers`);
        }
        return { text: joinSectionLines(lines), resources: sr };
    } catch {
        return { text: "## Hotspots" + SECTION_NL + SECTION_NL + "(computation failed)", resources: new Map() };
    }
}

function resolveOneNavPath(uri: unknown, loc: unknown): { path?: string; loc: unknown } | undefined {
    if (typeof uri !== "string" || uri.length === 0) return undefined;
    return { path: uriToFsPath(uri) ?? undefined, loc };
}

function resolveNavPath(it: any): { path?: string; loc: unknown } {
    const from = it?.from;
    const to = it?.to;
    const location = it?.location;
    const candidates: Array<{ uri: unknown; loc: unknown }> = [
        { uri: from?.uri, loc: from },
        { uri: to?.uri, loc: to },
        { uri: location?.uri, loc: it },
        { uri: it?.uri, loc: it },
    ];
    for (const c of candidates) {
        const r = resolveOneNavPath(c.uri, c.loc);
        if (r) return r;
    }
    return { path: undefined, loc: it };
}

function hasNavUri(it: any): boolean {
    if (!it || typeof it !== "object") return false;
    if (it.from && typeof it.from === "object" && "uri" in it.from) return true;
    if (it.to && typeof it.to === "object" && "uri" in it.to) return true;
    if (it.location && typeof it.location === "object" && "uri" in it.location) return true;
    return "uri" in it;
}

function collectNavResources(items: unknown[], cwd: string, absolutePath: string): SectionResources {
    const srNav = new Map<string, InspectedResource>();
    for (const it of items as any[]) {
        const { path: p, loc } = resolveNavPath(it);
        if (p) addSearchMatchResource(srNav, p, cwd, loc);
        else if (hasNavUri(it)) continue;
        else addSearchMatchResource(srNav, absolutePath, cwd, it);
    }
    return srNav;
}

async function runNavOutcome(input: InspectV4Input, cwd: string, absolutePath: string) {
    const op = input.navigation!.operation;
    const maxResults = Math.min(Math.max(input.navigation!.maxResults ?? 20, 1), 100);
    const navFn = resolveLspProvider(input)?.inspectNavigation ?? directInspectNavigation;
    const outcome = await navFn({
        operation: op as any,
        line: input.navigation!.line,
        character: input.navigation!.character,
        query: input.navigation!.query,
        maxResults,
        path: absolutePath,
        root: cwd,
        signal: input.signal as any,
    });
    return { op, outcome };
}

export async function buildFileNavigationSection(input: InspectV4Input, cwd: string, absolutePath: string): Promise<{ details: any; text: string; resources: SectionResources }> {
    try {
        const { op, outcome } = await runNavOutcome(input, cwd, absolutePath);
        const status = outcome.status === "confirmed" ? "ok" : outcome.status;
        // Extension seam: future mutating autofix/format and external security-scanner triage plugs here — add new status values without closing switch/default paths.
        const items = canonicalizeNavigationItems(outcome.items, cwd);
        const details = { schemaVersion: 1 as const, operation: op, status, source: "lsp" as const, items, truncated: outcome.truncated };
        // file-mode results stay coverage:"search-match" — add per-location resources (including call hierarchy from/to)
        const srNav = collectNavResources(items as any[], cwd, absolutePath);
        if (op === "hover" && input.navigation!.line !== undefined) addSearchMatchResource(srNav, absolutePath, cwd, { line: input.navigation!.line });
        // empty non-hover navigations produce no coverage (no fake line-1)
        // when items empty and not hover, srNav stays empty
        return { details, text: renderNavigationSection(details, cwd), resources: srNav };
    } catch {
        return { details: undefined, text: "## LSP Navigation" + SECTION_NL + SECTION_NL + "(computation failed)", resources: new Map() };
    }
}

export async function buildFileDiagnosticsSection(input: InspectV4Input, cwd: string, absolutePath: string): Promise<{ details: any; text: string; resources: SectionResources }> {
    try {
        const waitMs = input.diagnostics!.waitMs ?? 1500;
        const maxPerFile = input.diagnostics!.maxPerFile ?? 12;
        const diagFn = resolveLspProvider(input)?.inspectDiagnostics ?? directInspectDiagnostics;
        const outcome = await diagFn({ path: absolutePath, root: cwd, waitMs, maxPerFile, signal: input.signal as any });
        const status = toDiagnosticsOverallStatus([{ status: outcome.status, diagnostics: outcome.diagnostics }]);
        const canonPath = tryCanonical(absolutePath);
        const files = [{ path: canonPath, diagnostics: outcome.diagnostics, truncated: outcome.truncated }];
        const details = { schemaVersion: 1 as const, status, source: "lsp" as const, files, truncated: !!outcome.truncated };
        const srD = new Map<string, InspectedResource>();
        if (outcome.diagnostics.length === 0) {
            // empty diagnostics -> no coverage, do not fabricate line-1
        } else {
            for (const d of outcome.diagnostics as any[]) addSearchMatchResource(srD, absolutePath, cwd, d);
        }
        return { details, text: renderDiagnosticsSection(details, cwd), resources: srD };
    } catch {
        return { details: undefined, text: "## LSP Diagnostics" + SECTION_NL + SECTION_NL + "(computation failed)", resources: new Map() };
    }
}

type GraphSchemaFacts = { dependencies: Array<{ specifier: string; resolvedPath?: string }>; externalDependents?: Array<{ file: string }> };

function graphContextLines(contextGraph: NonNullable<InspectV4Input["contextGraph"]>): string[] {
    const provenanceEdges = contextGraph.getProvenanceEdges?.() ?? [];
    const capacityStats = contextGraph.getCapacityStats?.();
    // Use dedicated file index for file-node count, not derived from provenance edge endpoints
    const fileNodeCount = capacityStats?.fileIndex.entries ?? new Set([...provenanceEdges.flatMap(e => [e.from, e.to])]).size;
    const edgeCount = provenanceEdges.length;
    const symbolEntries = capacityStats?.symbolIndex.entries ?? 0;
    const out = [`Context graph: file-nodes=${fileNodeCount}, edges=${edgeCount}, symbol-entries=${symbolEntries}`];
    const sampleEdges = provenanceEdges.slice(0, 8).map(e => `${e.from} → ${e.to}`);
    if (sampleEdges.length === 0) return out;
    out.push("Sample edges:");
    for (const se of sampleEdges) out.push(`  ${se}`);
    return out;
}

function graphFallbackLines(cwd: string, absolutePath: string, facts: GraphSchemaFacts): string[] {
    const depCount = facts.dependencies.length;
    const extCount = facts.externalDependents?.length ?? 0;
    const out = [
        "Context graph: not available — using direct import/dependent edges",
        `Direct dependencies (imported modules): ${depCount}`,
        `External dependents (importing files): ${extCount}`,
    ];
    appendDependencySamples(out, cwd, facts);
    appendDependentSamples(out, cwd, absolutePath, facts);
    return out;
}

function appendDependencySamples(out: string[], cwd: string, facts: GraphSchemaFacts): void {
    if (facts.dependencies.length === 0) return;
    const sample = facts.dependencies.slice(0, 5).map(d => `${d.specifier} → ${d.resolvedPath ? pathRelative(cwd, d.resolvedPath) : "(external)"}`);
    out.push("Sample dependency edges:");
    for (const s of sample) out.push(`  ${s}`);
}

function appendDependentSamples(out: string[], cwd: string, absolutePath: string, facts: GraphSchemaFacts): void {
    const deps = facts.externalDependents ?? [];
    if (deps.length === 0) return;
    const sample = deps.slice(0, 5).map(d => `${pathRelative(cwd, d.file)} → ${pathRelative(cwd, absolutePath)}`);
    out.push("Sample dependent edges:");
    for (const s of sample) out.push(`  ${s}`);
}

export function buildFileGraphSchemaSection(input: InspectV4Input, cwd: string, absolutePath: string, facts: GraphSchemaFacts): { text: string; resources: SectionResources } {
    try {
        const lines: string[] = ["## Graph Schema", ""];
        if (input.contextGraph) {
            try {
                lines.push(...graphContextLines(input.contextGraph));
            } catch {
                lines.push("Context graph: available (introspection failed)");
            }
            return { text: joinSectionLines(lines), resources: new Map() };
        }
        // Fallback: use import/dependency data
        lines.push(...graphFallbackLines(cwd, absolutePath, facts));
        return { text: joinSectionLines(lines), resources: new Map() };
    } catch {
        return { text: "## Graph Schema" + SECTION_NL + SECTION_NL + "(introspection failed)", resources: new Map() };
    }
}
