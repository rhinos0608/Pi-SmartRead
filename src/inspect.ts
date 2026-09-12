/**
 * v4 dispatch: path-based mode detection. Directory → repo map. File → structural facts + signals.
 *
 * WP-4: Wires new inspect params (callDepth, callDirection, impact, deadCode, diff,
 * clusters, layers, boundaries, routes, hotspots, graphSchema) to wave-1 compute modules.
 * Renders output sections per spec output shapes, respecting token budget.
 *
 * Seam2: directory pipeline lives in ./inspect-directory.js, shared
 * canonical/range/token/callgraph helpers in ./inspect-runtime.js.
 */
import { realpathSync, statSync } from "node:fs";
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
    type InspectMode,
} from "@rhinos0608/pi-workspace-protocol";
import { extractStructuralFacts } from "./structural-facts.js";
import { computeFileSignals } from "./signals.js";
import type { InspectV4Input, InspectV4Mode, InspectV4Result } from "./inspect-types.js";
import type { StructuralFacts } from "./structural-facts-types.js";
import { expandBlastRadius, classifyFileRisk, detectDeadCode } from "./impact-analysis.js";
import { extractRoutes } from "./route-extraction.js";
import type { CallGraphResult } from "./callgraph.js";
import { inspectNavigation as directInspectNavigation, inspectDiagnostics as directInspectDiagnostics } from "./lsp-inspection.js";
import { uriToFsPath, renderNavigationSection, renderDiagnosticsSection, renderCallGraphSection } from "./inspect-sections.js";
import { renderDiffSection } from "./inspect-diff.js";
import { executeDirectoryInspect } from "./inspect-directory.js";
import {
    SECTION_NL,
    joinSectionLines,
    tryCanonical,
    estimateTokens,
    resolveLspProvider,
    canonicalizeNavigationItems,
    addSearchMatchResource,
    addResource,
    setResourceRanges,
    mergeRanges,
    toDiagnosticsOverallStatus,
    ensureCallGraph,
    findSectionName,
    riskOrder,
} from "./inspect-runtime.js";

// Re-exported for existing importers (tests) — canonical home is ./inspect-diff.js.
export { runGitDiff, renderDiffSection } from "./inspect-diff.js";
// Directory pipeline canonical home is ./inspect-directory.js; re-exported for existing importers.
export { executeDirectoryInspect } from "./inspect-directory.js";

function requireSessionFilePath(input: InspectV4Input): string {
    if (typeof input.sessionFilePath !== "string" || input.sessionFilePath.length === 0) {
        throw new Error("inspect requires a real session file path (in-memory/ephemeral identity is rejected)");
    }
    return input.sessionFilePath;
}

export function resolveInspectV4Mode(input: InspectV4Input): InspectV4Mode {
    const absolutePath = pathResolve(input.cwd, input.path);
    const st = statSync(absolutePath);
    if (st.isDirectory()) return "directory";
    if (st.isFile()) return "file";
    throw new Error(`inspect path is neither file nor directory: ${input.path}`);
}

// ── Main dispatch ────────────────────────────────────────────────

export async function executeInspectV4(input: InspectV4Input): Promise<InspectV4Result> {
    requireSessionFilePath(input);
    const mode = resolveInspectV4Mode(input);
    if (mode === "directory") return executeDirectoryInspect(input);
    return executeFileInspect(input);
}

// ── File inspect ─────────────────────────────────────────────────

type SectionResources = Map<string, InspectedResource>;
function buildFileDeadCodeSection(cwd: string, absolutePath: string, callGraph: CallGraphResult): { text: string; resources: SectionResources } {
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
function buildFileRoutesSection(absolutePath: string, cwd: string): { text: string; resources: SectionResources } {
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
function buildFileHotspotsSection(cwd: string, absolutePath: string, callGraph: CallGraphResult): { text: string; resources: SectionResources } {
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
async function buildFileNavigationSection(input: InspectV4Input, cwd: string, absolutePath: string): Promise<{ details: any; text: string; resources: SectionResources }> {
    try {
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
        const status = outcome.status === "confirmed" ? "ok" : outcome.status;
        // Extension seam: future mutating autofix/format and external security-scanner triage plugs here — add new status values without closing switch/default paths.
        const items = canonicalizeNavigationItems(outcome.items, cwd);
        const details = { schemaVersion: 1 as const, operation: op, status, source: "lsp" as const, items, truncated: outcome.truncated };
        const srNav = new Map<string, InspectedResource>();
        // file-mode results stay coverage:"search-match" — add per-location resources (including call hierarchy from/to)
        for (const it of items as any[]) {
            let p: string | undefined;
            let loc: unknown = it;
            if ((it as any)?.from?.uri) { p = uriToFsPath((it as any).from.uri); loc = (it as any).from; }
            else if ((it as any)?.to?.uri) { p = uriToFsPath((it as any).to.uri); loc = (it as any).to; }
            else p = (it as any)?.location?.uri ? uriToFsPath((it as any).location.uri) : (it as any)?.uri ? uriToFsPath((it as any).uri) : undefined;
            if (p) addSearchMatchResource(srNav, p, cwd, loc);
            else addSearchMatchResource(srNav, absolutePath, cwd, it);
        }
        if (op === "hover" && input.navigation!.line !== undefined) {
            addSearchMatchResource(srNav, absolutePath, cwd, { line: input.navigation!.line });
        }
        // empty non-hover navigations produce no coverage (no fake line-1)
        // when items empty and not hover, srNav stays empty
        return { details, text: renderNavigationSection(details, cwd), resources: srNav };
    } catch {
        return { details: undefined, text: "## LSP Navigation" + SECTION_NL + SECTION_NL + "(computation failed)", resources: new Map() };
    }
}
async function buildFileDiagnosticsSection(input: InspectV4Input, cwd: string, absolutePath: string): Promise<{ details: any; text: string; resources: SectionResources }> {
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
function buildFileGraphSchemaSection(input: InspectV4Input, cwd: string, absolutePath: string, facts: { dependencies: Array<{ specifier: string; resolvedPath?: string }>; externalDependents?: Array<{ file: string }> }): { text: string; resources: SectionResources } {
    try {
        const lines: string[] = ["## Graph Schema", ""];
        if (input.contextGraph) {
            try {
                const provenanceEdges = input.contextGraph.getProvenanceEdges?.() ?? [];
                const capacityStats = input.contextGraph.getCapacityStats?.();
                // Use dedicated file index for file-node count, not derived from provenance edge endpoints
                const fileNodeCount = capacityStats?.fileIndex.entries ?? new Set([...provenanceEdges.flatMap(e => [e.from, e.to])]).size;
                const edgeCount = provenanceEdges.length;
                const symbolEntries = capacityStats?.symbolIndex.entries ?? 0;
                const sampleEdges = provenanceEdges.slice(0, 8).map(e => `${e.from} → ${e.to}`);
                lines.push(`Context graph: file-nodes=${fileNodeCount}, edges=${edgeCount}, symbol-entries=${symbolEntries}`);
                if (sampleEdges.length > 0) {
                    lines.push("Sample edges:");
                    for (const se of sampleEdges) {
                        lines.push(`  ${se}`);
                    }
                }
            } catch {
                lines.push("Context graph: available (introspection failed)");
            }
        } else {
            // Fallback: use import/dependency data
            const depCount = facts.dependencies.length;
            const extCount = facts.externalDependents?.length ?? 0;
            lines.push("Context graph: not available — using direct import/dependent edges");
            lines.push(`Direct dependencies (imported modules): ${depCount}`);
            lines.push(`External dependents (importing files): ${extCount}`);
            if (depCount > 0) {
                const sample = facts.dependencies.slice(0, 5).map(d => `${d.specifier} → ${d.resolvedPath ? pathRelative(cwd, d.resolvedPath) : "(external)"}`);
                lines.push("Sample dependency edges:");
                for (const s of sample) lines.push(`  ${s}`);
            }
            if (extCount > 0) {
                const sample = (facts.externalDependents ?? []).slice(0, 5).map(d => `${pathRelative(cwd, absolutePath)} → ${pathRelative(cwd, d.file)}`);
                lines.push("Sample dependent edges:");
                for (const s of sample) lines.push(`  ${s}`);
            }
        }
        return { text: joinSectionLines(lines), resources: new Map() };
    } catch {
        return { text: "## Graph Schema" + SECTION_NL + SECTION_NL + "(introspection failed)", resources: new Map() };
    }
}
export async function executeFileInspect(input: InspectV4Input): Promise<InspectV4Result> {
    const sessionFilePath = input.sessionFilePath;
    const cwd = realpathSync(input.cwd);
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(sessionFilePath);
    const absolutePath = tryCanonical(pathResolve(cwd, input.path));

    // Structural facts + signals
    let facts: StructuralFacts;
    try {
        facts = await extractStructuralFacts(absolutePath, cwd, input.signal, input.contextGraph);
    } catch {
        facts = { callers: [], externalDependents: [], dependencies: [], internalCallSites: [], children: [], baseClasses: [], interfaces: [], overrides: [], reExportedBy: [], notices: ["extraction failed"] };
    }
    let signals: { path: string; signals: any[]; computedAt: string; fallbackNotices: string[] };
    try {
        signals = await computeFileSignals(
            absolutePath,
            cwd,
            input.contextGraph,
            input.signals as any,
            input.signal,
            facts.externalDependents,
        );
    } catch {
        signals = { path: absolutePath, signals: [], computedAt: new Date().toISOString(), fallbackNotices: ["signal computation failed"] };
    }

    // Build evidence envelope: mode "symbol" (protocol-valid), resources with search-match coverage
    const resourcesByPath = new Map<string, InspectedResource>();

    // External dependents => each file that imports/re-exports us gets a resource on the importer file
    for (const dep of facts.externalDependents ?? []) {
        const canonical = tryCanonical(pathResolve(cwd, dep.file));
        setResourceRanges(resourcesByPath, canonical, dep.line);
    }

    // Dependencies => line belongs to inspected file (where import occurs), not dependency file
    for (const dep of facts.dependencies) {
        setResourceRanges(resourcesByPath, absolutePath, dep.line);
    }

    // Internal call sites => only authorize rendered entries (first 15)
    const maxShownCalls = 15;
    for (const caller of facts.internalCallSites.slice(0, maxShownCalls)) {
        setResourceRanges(resourcesByPath, absolutePath, caller.line);
    }

    // Children => each child line gets a resource on the inspected file
    for (const child of facts.children) {
        setResourceRanges(resourcesByPath, absolutePath, child.line);
    }

    // Overrides => each override line
    for (const override of facts.overrides) {
        setResourceRanges(resourcesByPath, absolutePath, override.line);
    }

    // Re-exports => each barrel file
    for (const reexport of facts.reExportedBy) {
        const canonical = tryCanonical(pathResolve(cwd, reexport.barrelFile));
        setResourceRanges(resourcesByPath, canonical, reexport.line);
    }

    // ── Signal-name → human-readable mapping ──────────────────
    const SIGNAL_DISPLAY_NAMES: Record<string, string> = {
        complexity: "Complexity",
        "public-api": "Public API",
        reuse: "External Reuse",
        recency: "Last Change",
        tests: "Tests",
        deprecation: "Deprecation",
    };

    function humanSignalName(s: any): string {
        return SIGNAL_DISPLAY_NAMES[s.name] ?? s.name;
    }

    function renderSignalLine(s: any): string {
        const heading = humanSignalName(s);
        // Avoid "Yes: Yes" / "Unknown: Unknown" repetition;
        // use value which already embeds label+detail for most signals
        const display = s.value && s.value !== s.label ? s.value : s.label;
        const detail = s.detail && s.detail !== s.label ? ` (${s.detail})` : "";
        return `  ${heading}: ${display}${detail}`;
    }

    // ── Core content lines ─────────────────────────────────────
    const relativePath = pathRelative(cwd, absolutePath);
    const coreLines: string[] = [
        `## Structural Facts: ${relativePath}`,
        "",
        `External Dependents (${facts.externalDependents?.length ?? 0})`,
        ...((facts.externalDependents?.length ?? 0) > 0
            ? facts.externalDependents!.map(d => `  ${pathRelative(cwd, d.file)}:${d.line}`)
            : [`  (none)`]),
        "",
        `Dependencies (${facts.dependencies.length})`,
        ...(facts.dependencies.length > 0
            ? facts.dependencies.map(d => `  ${d.specifier} L${d.line}${d.resolvedPath ? ` → ${pathRelative(cwd, d.resolvedPath)}` : ""}`)
            : [`  (none)`]),
        "",
        `Internal Call Sites (${facts.internalCallSites.length})`,
        ...(facts.internalCallSites.length > 0
            ? (() => {
                const maxShow = 15;
                const shown = facts.internalCallSites.slice(0, maxShow);
                const omitted = facts.internalCallSites.length - maxShow;
                return [
                    ...shown.map(c => `  L${c.line}`),
                    ...(omitted > 0 ? [`  ... (+${omitted} more call sites)`] : []),
                ];
            })()
            : [`  (none)`]),
        "",
        `Parent Module`,
        `  ${facts.parentModule ?? "(top-level module)"}`,
        "",
        `Children (${facts.children.length}${facts.children.some(c => c.isExported) ? " exported" : ""})`,
        ...(facts.children.length > 0
            ? facts.children.map(c => `  ${c.name}()\t\tL${c.line}${c.isExported ? " exported" : ""}${c.deprecated ? " deprecated" : ""}`)
            : [`  (none)`]),
        "",
        `Base Classes / Interfaces`,
        ...(facts.baseClasses.length > 0
            ? facts.baseClasses.map(b => `  ${b.name} (${b.kind})`)
            : [`  (none)`]),
        "",
        `Overrides`,
        ...(facts.overrides.length > 0
            ? facts.overrides.map(o => `  ${o.methodName} overrides ${o.parentName} — L${o.line}${o.isExplicit ? " explicit" : ""}`)
            : [`  (none)`]),
        "",
        `Re-Exported By (${facts.reExportedBy.length})`,
        ...(facts.reExportedBy.length > 0
            ? facts.reExportedBy.map(r => `  ${r.barrelFile} — ${r.kind} export "${r.exportName}"`)
            : [`  (none)`]),
        "",
        `Signals`,
        ...(signals.signals.length > 0
            ? signals.signals.map(s => renderSignalLine(s))
            : [`  (none computed)`]),
        ...(signals.fallbackNotices.length > 0
            ? ["", `  Notes: ${signals.fallbackNotices.join("; ")}`]
            : []),
        "",
    ];

    // Token budget tracking
    const budget = input.mapTokens ?? 4096;
    let usedTokens = estimateTokens(coreLines.join("\n"));
    let callGraph: CallGraphResult | null = null;

    // Lazy build call graph if needed by callDepth/deadCode/hotspots/impact/diff
    if (input.callDepth || input.deadCode || input.hotspots || input.impact || input.diff) {
        callGraph = await ensureCallGraph(input, null);
    }

    // ── Compute extra sections ──────────────────────────────────
    const extraSections: string[] = [];
    const sectionResources: Map<string, InspectedResource>[] = [];

    // callDepth + callDirection (file mode only)
    if (input.callDepth) {
        try {
            const depth = Math.min(Math.max(input.callDepth ?? 1, 1), 5);
            const direction = input.callDirection ?? "both";
            const { text, emittedFiles } = renderCallGraphSection(callGraph, relativePath, facts, depth, direction, cwd);
            extraSections.push(text);
            const sr = new Map<string, InspectedResource>();
            addResource(sr, absolutePath, cwd);
            for (const refFile of emittedFiles) {
                addResource(sr, refFile, cwd);
            }
            sectionResources.push(sr);
        } catch {
            extraSections.push("## Call Graph\n\n(computation failed)");
            sectionResources.push(new Map());
        }
    }

    // impact (file mode)
    if (input.impact) {
        try {
            const sr = new Map<string, InspectedResource>();
            if (input.contextGraph) {
                const blastRadius = await expandBlastRadius(absolutePath, input.contextGraph, 3, input.cwd);
                const affectedFiles: Array<{ path: string; risk: string; fanIn: number; depth: number }> = [];
                for (const [fp, { depth: d }] of blastRadius) {
                    if (fp === absolutePath) continue;
                    const fanIn = callGraph
                        ? callGraph.functions.filter(f => f.file === pathRelative(cwd, fp)).reduce((sum, f) => sum + f.calledBy.length, 0)
                        : 0;
                    const risk = classifyFileRisk({ filePath: fp, pageRank: 0, fanIn, blastRadiusDepth: d });
                    affectedFiles.push({ path: pathRelative(cwd, fp), risk, fanIn, depth: d });
                    addResource(sr, fp, cwd);
                }
                sectionResources.push(sr);
                affectedFiles.sort((a, b) => riskOrder(a.risk) - riskOrder(b.risk) || b.fanIn - a.fanIn);
                const lines: string[] = [
                    `## Impact Analysis: ${relativePath}`,
                    "",
                    `Risk: ${affectedFiles.length > 0 ? affectedFiles[0]!.risk.toUpperCase() : "LOW"}`,
                    `  - Blast radius: depth ${Math.max(...affectedFiles.map(f => f.depth), 0)} (${affectedFiles.length} files)`,
                    "",
                    "Affected Files (by risk):",
                ];
                for (const af of affectedFiles.slice(0, 15)) {
                    lines.push(`  ${af.risk.toUpperCase().padEnd(10)} ${af.path.padEnd(40)} — ${af.fanIn} callers`);
                }
                if (affectedFiles.length > 15) {
                    lines.push(`  ... (+${affectedFiles.length - 15} more files)`);
                }
                extraSections.push(lines.join("\n"));
            } else {
                // No contextGraph — use direct import-scan fallback
                const deps = facts.externalDependents ?? [];
                const lines: string[] = [
                    `## Impact Analysis: ${relativePath}`,
                    "",
                    "Context graph not available — direct import-scan only (no transitive blast radius)",
                    "",
                    `External Dependents (files importing this module): ${deps.length}`,
                ];
                const sr = new Map<string, InspectedResource>();
                if (deps.length > 0) {
                    for (const d of deps) {
                        addResource(sr, d.file, cwd);
                    }
                    lines.push("", "Direct dependent files:");
                    for (const d of deps.slice(0, 20)) {
                        lines.push(`  ${pathRelative(cwd, d.file)}:${d.line}`);
                    }
                    if (deps.length > 20) {
                        lines.push(`  ... (+${deps.length - 20} more)`);
                    }
                }
                sectionResources.push(sr);
                extraSections.push(lines.join("\n"));
            }
        } catch {
            extraSections.push("## Impact Analysis\n\n(computation failed)");
            sectionResources.push(new Map());
        }
    }

    // diff (file scope)
    if (input.diff) {
        try {
            const section = await renderDiffSection(input.diff, cwd, callGraph);
            extraSections.push(section.text);
            const sr = new Map<string, InspectedResource>();
            addResource(sr, absolutePath, cwd);
            for (const fp of section.emittedFiles) {
                addResource(sr, fp, cwd);
            }
            sectionResources.push(sr);
        } catch {
            extraSections.push("## Diff Impact\n\n(computation failed)");
            sectionResources.push(new Map());
        }
    }

    // deadCode (file scope)
    if (input.deadCode && callGraph) {
        const dead = buildFileDeadCodeSection(cwd, absolutePath, callGraph);
        extraSections.push(dead.text);
        sectionResources.push(dead.resources);
    }

    // routes (file mode — single file)
    if (input.routes) {
        const fr = buildFileRoutesSection(absolutePath, cwd);
        extraSections.push(fr.text);
        sectionResources.push(fr.resources);
    }

    // hotspots (file scope — functions in this file ranked by fan-in)
    if (input.hotspots && callGraph) {
        const hs = buildFileHotspotsSection(cwd, absolutePath, callGraph);
        extraSections.push(hs.text);
        sectionResources.push(hs.resources);
    }

    // ── WP-SR3 navigation (file) ──
    let __navDetails: any = undefined;
    if (input.navigation) {
        const nav = await buildFileNavigationSection(input, cwd, absolutePath);
        __navDetails = nav.details;
        extraSections.push(nav.text);
        sectionResources.push(nav.resources);
    }

    // ── WP-SR3 diagnostics (file) ──
    let __diagDetails: any = undefined;
    if (input.diagnostics) {
        const diag = await buildFileDiagnosticsSection(input, cwd, absolutePath);
        __diagDetails = diag.details;
        extraSections.push(diag.text);
        sectionResources.push(diag.resources);
    }

    // graphSchema (file scope)
    if (input.graphSchema) {
        const gs = buildFileGraphSchemaSection(input, cwd, absolutePath, facts);
        sectionResources.push(gs.resources);
        extraSections.push(gs.text);
    }

    // ── Render extra sections with token budget ────────────────
    const allSectionTexts: string[] = [];
    const omittedSections: string[] = [];
    let budgetExhausted = false;
    const admittedSectionResources = new Map<string, InspectedResource>();

    for (let i = 0; i < extraSections.length; i++) {
        const sectionText = extraSections[i]!;
        const tokens = estimateTokens(sectionText);
        if (!budgetExhausted && usedTokens + tokens <= budget) {
            allSectionTexts.push(sectionText);
            usedTokens += tokens;
            // Merge this section's resources into admitted set
            for (const [key, val] of sectionResources[i]!) {
                const existing = admittedSectionResources.get(key);
                if (existing) {
                    const merged = mergeRanges([...existing.allowedRanges, ...val.allowedRanges]);
                    admittedSectionResources.set(key, { ...existing, allowedRanges: merged });
                } else {
                    admittedSectionResources.set(key, val);
                }
            }
        } else {
            budgetExhausted = true;
            const sectionName = findSectionName(extraSections, i);
            omittedSections.push(sectionName);
        }
    }

    // Build final content
    const finalParts = [...coreLines];
    if (allSectionTexts.length > 0) {
        for (const s of allSectionTexts) {
            finalParts.push(...s.split("\n"));
        }
    }
    if (omittedSections.length > 0) {
        finalParts.push("");
        for (const name of omittedSections) {
            finalParts.push(`## ${name} (omitted: token budget reached — rerun with higher mapTokens)`);
        }
    }

    const contentText = finalParts.join("\n");
    // Merge structural facts resources with admitted section resources
    for (const [key, val] of admittedSectionResources) {
        const existing = resourcesByPath.get(key);
        if (existing) {
            const merged = mergeRanges([...existing.allowedRanges, ...val.allowedRanges]);
            resourcesByPath.set(key, { ...existing, allowedRanges: merged });
        } else {
            resourcesByPath.set(key, val);
        }
    }
    const resources = [...resourcesByPath.values()];
    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: canonicalRoot,
        resources: resources.map(r => ({
            canonicalPath: r.canonicalPath,
            ...(r.allowedRanges[0] ? { range: r.allowedRanges[0] } : {}),
        })),
    });
    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources,
        mode: "symbol" as InspectMode,
    };

    const upstreamFile: Record<string, unknown> = {};
    if (__navDetails) upstreamFile.navigation = __navDetails;
    if (__diagDetails) upstreamFile.diagnostics = __diagDetails;
    return {
        mode: "file",
        contentText,
        workspaceEvidence: envelope,
        lineCount: finalParts.length,
        byteLength: Buffer.byteLength(contentText, "utf8"),
        truncated: budgetExhausted,
        upstreamDetails: Object.keys(upstreamFile).length ? upstreamFile : undefined,
        navigation: __navDetails,
        diagnostics: __diagDetails,
    } as any;
}
