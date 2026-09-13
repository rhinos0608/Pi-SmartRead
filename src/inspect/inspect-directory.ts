/**
 * Seam2 split of inspect.ts: directory inspect pipeline.
 *
 * Owns directory builders, diagnostics scan, token-budget fitting, and
 * executeDirectoryInspect. Shared canonical/range/token/callgraph helpers
 * live in ./inspect-runtime.js. Section order, token budget, LSP sync,
 * relative dead-code paths, and realpathSync semantics preserved verbatim.
 */
import { realpathSync } from "node:fs";
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import { clampMapTokens, createRepoTool } from "./repomap-tool.js";
import { detectCommunities } from "./community-detection.js";
import { scanRoutes } from "./route-extraction.js";
import { deriveLayers } from "./layer-analysis.js";
import { detectServiceBoundaries } from "./monorepo-detector.js";
import { detectDeadCode } from "./impact-analysis.js";
import type { CallGraphResult } from "./callgraph.js";
import { findSrcFiles } from "./file-discovery.js";
import { inspectNavigation as directInspectNavigation, inspectDiagnostics as directInspectDiagnostics, type LspInspectionProvider } from "./lsp-inspection.js";
import { renderNavigationSection, renderDiagnosticsSection, runSection, runSectionAsync } from "./inspect-sections.js";
import { renderDiffSection } from "./inspect-diff.js";
import type { InspectV4Input, InspectV4Result } from "./inspect-types.js";
import {
    SECTION_NL,
    joinSectionLines,
    tryCanonical,
    estimateTokens,
    resolveLspProvider,
    canonicalizeNavigationItems,
    toDiagnosticsOverallStatus,
    ensureCallGraph,
    buildImportEdges,
    guessClusterLabel,
} from "./inspect-runtime.js";

export const DIRECTORY_TRUNCATION_FOOTER =
    "[truncated: ranked map or requested analysis omitted — rerun with higher mapTokens]";

export function assembleDirectoryOutput(coreText: string, sections: string[]): string {
    if (sections.length === 0) return coreText;
    return coreText + "\n\n" + sections.join("\n\n");
}

export async function buildDirectoryDiagnostics(opts: { cwd: string; dirPath: string; waitMs: number; maxPerFile: number; maxFiles: number; signal?: AbortSignal; lspInspectionProvider?: LspInspectionProvider }): Promise<{ details: any; sectionText: string }> {
    const { cwd, dirPath, waitMs, maxPerFile, maxFiles, signal, lspInspectionProvider } = opts as any;
    const allFiles = await findSrcFiles(dirPath);
    allFiles.sort();
    const truncatedByFiles = allFiles.length > maxFiles;
    const selected = allFiles.slice(0, maxFiles);
    const files: Array<{ path: string; diagnostics: unknown[]; truncated?: boolean }> = [];
    let anyTruncated = truncatedByFiles;
    const perFileStatuses: Array<{ status: string; diagnostics: unknown[] }> = [];
    for (const fp of selected) {
        try {
            const fileAbs = fp.startsWith("/") ? fp : pathResolve(fp);
            const diagFn = lspInspectionProvider ? lspInspectionProvider.inspectDiagnostics : directInspectDiagnostics;
            const outcome = await diagFn({ path: fileAbs, root: cwd, waitMs, maxPerFile, signal } as any);
            const canon = tryCanonical(fileAbs);
            files.push({ path: canon, diagnostics: outcome.diagnostics, truncated: outcome.truncated });
            perFileStatuses.push({ status: outcome.status, diagnostics: outcome.diagnostics });
            if (outcome.truncated) anyTruncated = true;
        } catch {
            const canon = (() => { try { return tryCanonical(fp); } catch { return fp; } })();
            files.push({ path: canon, diagnostics: [], truncated: false });
            perFileStatuses.push({ status: "degraded", diagnostics: [] });
        }
    }
    const status = toDiagnosticsOverallStatus(perFileStatuses.length ? perFileStatuses : [{ status: "unavailable", diagnostics: [] }]);
    const details = { schemaVersion: 1 as const, status, source: "lsp" as const, files, truncated: anyTruncated };
    const sectionText = renderDiagnosticsSection(details, cwd);
    return { details, sectionText };
}

export function fitDirectoryOutput(coreText: string, extraSections: string[], budget: number): { text: string; truncated: boolean; admittedCount: number } {
    const footerSep = "\n\n" + DIRECTORY_TRUNCATION_FOOTER;
    const totalSections = extraSections.length;
    // Binary-search max k sections fitting with reserved footer
    let lo = 0;
    let hi = totalSections;
    let bestK = -1;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const candidate = assembleDirectoryOutput(coreText, extraSections.slice(0, mid)) + (mid < totalSections ? footerSep : "");
        if (estimateTokens(candidate) <= budget) {
            bestK = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (bestK >= 0) {
        const truncated = bestK < totalSections;
        const text = assembleDirectoryOutput(coreText, extraSections.slice(0, bestK)) + (truncated ? footerSep : "");
        return { text, truncated, admittedCount: bestK };
    }
    // Core alone exceeds budget — binary-search line prefix
    const coreLines = coreText.split("\n");
    let lLo = 0;
    let lHi = coreLines.length;
    let bestL = 0;
    while (lLo <= lHi) {
        const mid = Math.floor((lLo + lHi) / 2);
        const candidate = coreLines.slice(0, mid).join("\n") + footerSep;
        if (estimateTokens(candidate) <= budget) {
            bestL = mid;
            lLo = mid + 1;
        } else {
            lHi = mid - 1;
        }
    }
    const text = coreLines.slice(0, bestL).join("\n") + footerSep;
    // Ensure hard cap even if footer alone exceeds budget (clamped min 256 prevents this)
    if (estimateTokens(text) > budget) {
        // Last resort: truncate footer itself line-aligned (should not happen with valid budget)
        const footerLines = DIRECTORY_TRUNCATION_FOOTER.split("\n");
        return { text: footerLines.join("\n"), truncated: true, admittedCount: 0 };
    }
    return { text, truncated: true, admittedCount: 0 };
}

export function buildDirRoutesSection(input: InspectV4Input, cwd: string): string {
    return runSection("HTTP Routes", () => {
        const routes = scanRoutes(pathResolve(cwd, input.path));
        if (routes.length === 0) return "## HTTP Routes" + SECTION_NL + SECTION_NL + "(no routes found)";
        const lines: string[] = [`## HTTP Routes (${routes.length} routes)`, ""];
        const byFile = new Map<string, typeof routes>();
        for (const r of routes) {
            const key = r.file;
            if (!byFile.has(key)) byFile.set(key, []);
            byFile.get(key)!.push(r);
        }
        for (const [file, fileRoutes] of byFile) {
            lines.push(`${file}:`);
            for (const r of fileRoutes) {
                const handler = r.handler ?? "(handler)";
                lines.push(`  ${r.method.padEnd(7)} ${r.path.padEnd(30)} → ${handler}  L${r.line}`);
            }
            lines.push("");
        }
        return joinSectionLines(lines);
    }, "(extraction failed)");
}

export function buildDirHotspotsSection(callGraph: CallGraphResult): string {
    return runSection("Hotspots", () => {
        const sorted = [...callGraph.functions]
            .sort((a, b) => b.calledBy.length - a.calledBy.length)
            .slice(0, 15);
        if (sorted.length === 0) return "## Hotspots" + SECTION_NL + SECTION_NL + "(no function data available)";
        const lines: string[] = [`## Hotspots (top ${sorted.length} by fan-in)`, ""];
        for (let i = 0; i < sorted.length; i++) {
            const fn = sorted[i]!;
            const num = String(i + 1).padStart(2, " ");
            lines.push(`  ${num}. ${fn.name.padEnd(35)} ${fn.file}:${fn.line}  — ${fn.calledBy.length} callers`);
        }
        return joinSectionLines(lines);
    });
}

export function buildDirGraphSchemaSection(input: InspectV4Input): string {
    return runSection("Graph Schema", () => {
        const lines: string[] = ["## Graph Schema", ""];
        if (!input.contextGraph) {
            lines.push('contextGraph: "not built"');
        } else {
            try {
                const provenanceEdges = input.contextGraph.getProvenanceEdges?.() ?? [];
                const capacityStats = input.contextGraph.getCapacityStats?.();
                const sampleEdges = provenanceEdges.slice(0, 8).map(e => `${e.from} → ${e.to}`);
                // Use dedicated file index for file-node count, not derived from provenance edge endpoints
                const fileNodeCount = capacityStats?.fileIndex?.entries ?? new Set([...provenanceEdges.flatMap(e => [e.from, e.to])]).size;
                const edgeCount = provenanceEdges.length;
                const symbolEntries = capacityStats?.symbolIndex?.entries ?? 0;
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
        }
        lines.push("");
        return joinSectionLines(lines);
    }, "(introspection failed)");
}

export async function buildDirNavigationSection(input: InspectV4Input, cwd: string): Promise<{ details: any; text: string }> {
    try {
        const op = input.navigation!.operation;
        const maxResults = Math.min(Math.max(input.navigation!.maxResults ?? 20, 1), 100);
        const navFn = resolveLspProvider(input)?.inspectNavigation ?? directInspectNavigation;
        const outcome = await navFn({
            operation: op as any,
            query: input.navigation!.query,
            line: input.navigation!.line,
            character: input.navigation!.character,
            maxResults,
            path: pathResolve(cwd, input.path),
            root: cwd,
            signal: input.signal as any,
        });
        const status = outcome.status === "confirmed" ? "ok" : outcome.status;
        const items = canonicalizeNavigationItems(outcome.items, cwd);
        const details = { schemaVersion: 1 as const, operation: op, status, source: "lsp" as const, items, truncated: outcome.truncated };
        return { details, text: renderNavigationSection(details, cwd) };
    } catch {
        return { details: undefined, text: "## LSP Navigation" + SECTION_NL + SECTION_NL + "(computation failed)" };
    }
}

export async function buildDirDiagnosticsSection(input: InspectV4Input, cwd: string): Promise<{ details: any; text: string }> {
    try {
        const waitMs = input.diagnostics!.waitMs ?? 1500;
        const maxPerFile = input.diagnostics!.maxPerFile ?? 12;
        const maxFiles = input.diagnostics!.maxFiles ?? 20;
        const r = await buildDirectoryDiagnostics({ cwd, dirPath: pathResolve(cwd, input.path), waitMs, maxPerFile, maxFiles, signal: input.signal as any, lspInspectionProvider: resolveLspProvider(input) ?? undefined } as any);
        return { details: r.details, text: r.sectionText };
    } catch {
        return { details: undefined, text: "## LSP Diagnostics" + SECTION_NL + SECTION_NL + "(computation failed)" };
    }
}

export async function buildLayersSection(input: InspectV4Input, cwd: string): Promise<string> {
    return runSectionAsync("Architectural Layers", async () => {
        const importEdges = buildImportEdges(input.contextGraph);
        const files = await findSrcFiles(pathResolve(cwd, input.path));
        const layerMap = deriveLayers(importEdges, files);
        const lines: string[] = ["## Architectural Layers (derived from imports)", ""];
        for (const [layer, members] of layerMap.layers) {
            lines.push(`${layer} (${members.length} files):`);
            const sample = members.slice(0, 5).map(m => pathRelative(cwd, m)).join(", ");
            const more = members.length > 5 ? `, ...(+${members.length - 5})` : "";
            lines.push(`  ${sample}${more}`);
            lines.push("");
        }
        if (layerMap.unclassified.length > 0) {
            lines.push(`unclassified (${layerMap.unclassified.length} files):`);
            lines.push(`  (files without clear layer assignment)`);
            lines.push("");
        }
        return joinSectionLines(lines);
    });
}

export function buildBoundariesSection(cwd: string): string {
    return runSection("Service Boundaries", () => {
        const boundary = detectServiceBoundaries(cwd);
        const lines: string[] = ["## Service Boundaries", ""];
        if (boundary.services.length === 0) {
            lines.push("(no service boundaries detected)");
        } else {
            for (const svc of boundary.services) {
                lines.push(`${svc.name} (package: ${svc.rootPath})`);
                if (svc.dependencies.length > 0) {
                    lines.push(`  → depends on: ${svc.dependencies.join(", ")}`);
                }
                lines.push("");
            }
        }
        return joinSectionLines(lines);
    }, "(detection failed)");
}

export function buildDirDeadCodeSection(input: InspectV4Input, cwd: string, callGraph: CallGraphResult): string {
    return runSection("Dead Code", () => {
        // Relative path required: callGraph.functions[].file stores relative paths.
        const deadCode = detectDeadCode(pathRelative(cwd, pathResolve(cwd, input.path)), callGraph);
        if (deadCode.totalDeadFunctions === 0) return "## Dead Code" + SECTION_NL + SECTION_NL + "(no zero-caller functions found)";
        const lines: string[] = [`## Dead Code (${deadCode.totalDeadFunctions} zero-caller functions)`, ""];
        for (const file of deadCode.files) {
            lines.push(`  ${pathRelative(cwd, file.path)}:`);
            for (const fn of file.functions.slice(0, 10)) {
                lines.push(`    ${fn.name}()  L${fn.line}`);
            }
            if (file.functions.length > 10) {
                lines.push(`    (${file.functions.length - 10} more in this file)`);
            }
        }
        return joinSectionLines(lines);
    }, "(detection failed)");
}

export function buildClustersSection(input: InspectV4Input, cwd: string): string {
    return runSection("Community Clusters", () => {
        const importEdges = buildImportEdges(input.contextGraph);
        const clusters = detectCommunities(importEdges);
        const lines: string[] = [
            `## Community Clusters (modularity: ${clusters.modularity.toFixed(2)}, ${clusters.clusters.size} clusters)`,
            "",
        ];
        for (const [cid, members] of clusters.clusters) {
            const label = guessClusterLabel(members);
            lines.push(`Cluster ${cid} (${members.length} files)  — "${label}"`);
            const sample = members.slice(0, 8).map(m => pathRelative(cwd, m)).join(", ");
            const more = members.length > 8 ? `, ...(+${members.length - 8})` : "";
            lines.push(`  ${sample}${more}`);
            lines.push("");
        }
        return joinSectionLines(lines);
    });
}

export async function executeDirectoryInspect(input: InspectV4Input): Promise<InspectV4Result> {
    const sessionFilePath = input.sessionFilePath;
    const cwd = realpathSync(input.cwd);
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(sessionFilePath);

    const mapRoot = pathResolve(cwd, input.path);
    const repoTool = createRepoTool();
    const fakeCtx = { cwd, sessionManager: undefined } as any;
    const clampedBudget = clampMapTokens(input.mapTokens);
    const params: Record<string, unknown> = {
        directory: mapRoot,
        mapTokens: clampedBudget,
        compact: input.compact ?? true,
    };
    if (input.focus && input.focus.length > 0) {
        params.focus = input.focus;
    }
    // Lazy-start contract: repomap LSP fallback only when navigation/diagnostics requested
    (params as any).allowLspFallback = !!(input.navigation || input.diagnostics);
    const result = await repoTool.execute(
        "inspect-v4-map",
        params as any,
        input.signal,
        undefined,
        fakeCtx,
    );
    const contentText = (result.content?.[0] as { type: "text"; text: string } | undefined)?.text ?? "";

    // Hard budget enforcement (foveated: ranked core + complete optional sections)
    const budget = clampedBudget;

    // ── Compute sections for directory mode ─────────────────────
    const extraSections: string[] = [];
    let callGraph: CallGraphResult | null = null;

    // Lazy build call graph if needed by hotspots/deadCode/diff
    if (input.hotspots || input.deadCode || input.diff) {
        callGraph = await ensureCallGraph(input, null);
    }

    // clusters
    if (input.clusters) {
        extraSections.push(buildClustersSection(input, cwd));
    }

    // layers
    if (input.layers) {
        extraSections.push(await buildLayersSection(input, cwd));
    }

    // boundaries
    if (input.boundaries) {
        extraSections.push(buildBoundariesSection(cwd));
    }

    // deadCode (directory scope)
    if (input.deadCode && callGraph) {
        extraSections.push(buildDirDeadCodeSection(input, cwd, callGraph));
    }

    // routes (directory scan)
    if (input.routes) {
        extraSections.push(buildDirRoutesSection(input, cwd));
    }

    // hotspots (directory scope)
    if (input.hotspots && callGraph) {
        extraSections.push(buildDirHotspotsSection(callGraph));
    }

    // graphSchema (directory scope)
    if (input.graphSchema) {
        extraSections.push(buildDirGraphSchemaSection(input));
    }

    // diff (directory scope)
    if (input.diff) {
        const diffTarget = input.diff;
        extraSections.push(
            await runSectionAsync("Diff Impact", async () => (await renderDiffSection(diffTarget, cwd, callGraph)).text),
        );
    }

    // ── WP-SR3 navigation (directory: workspaceSymbols only) ──
    let __navDetails: any = undefined;
    if (input.navigation) {
        // Extension seam: future mutating autofix/format and external security-scanner triage plugs here — add new status values without closing switch/default paths.
        const nav = await buildDirNavigationSection(input, cwd);
        __navDetails = nav.details;
        extraSections.push(nav.text);
    }

    // ── WP-SR3 diagnostics (directory) ──
    let __diagDetails: any = undefined;
    if (input.diagnostics) {
        const diag = await buildDirDiagnosticsSection(input, cwd);
        __diagDetails = diag.details;
        extraSections.push(diag.text);
    }

    // ── Hard budget fitting (preserves ranked order, complete sections only) ──
    const { text: fittedText, truncated, admittedCount } = fitDirectoryOutput(contentText, extraSections, budget);
    void admittedCount;
    // Keep LSP text/details in sync when budget trimming drops their sections.
    // MCP clients only see rendered text, so a dropped section with retained
    // details would silently lose information.
    const renderDroppedNav = __navDetails !== undefined && !fittedText.includes("## LSP Navigation");
    const renderDroppedDiag = __diagDetails !== undefined && !fittedText.includes("## LSP Diagnostics");
    let finalText = fittedText;
    let navDetails: typeof __navDetails = __navDetails;
    let diagDetails: typeof __diagDetails = __diagDetails;
    const omissionNotes: string[] = [];
    if (renderDroppedNav) {
        omissionNotes.push("Note: LSP Navigation section omitted due to token-budget fitting (mapTokens too low to include it).");
        navDetails = undefined;
    }
    if (renderDroppedDiag) {
        omissionNotes.push("Note: LSP Diagnostics section omitted due to token-budget fitting (mapTokens too low to include it).");
        diagDetails = undefined;
    }
    if (omissionNotes.length > 0) {
        const footerIdx = finalText.indexOf(DIRECTORY_TRUNCATION_FOOTER);
        const noteBlock = omissionNotes.join("\n") + "\n";
        const candidate = footerIdx >= 0
            ? finalText.slice(0, footerIdx) + noteBlock + finalText.slice(footerIdx)
            : finalText + "\n" + noteBlock;
        if (estimateTokens(candidate) <= budget) {
            finalText = candidate;
        }
        // else: note block omitted to preserve hard budget; fittedText already carries truncation footer when truncated
    }

    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: canonicalRoot,
        resources: [],
    });
    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources: [],
        mode: "map",
    };

    const upstream: Record<string, unknown> = { ...(result.details as Record<string, unknown> ?? {}) };
    if (navDetails) upstream.navigation = navDetails;
    if (diagDetails) upstream.diagnostics = diagDetails;
    // Remove stale LSP keys when their sections were budget-dropped
    if (renderDroppedNav) delete (upstream as any).navigation;
    if (renderDroppedDiag) delete (upstream as any).diagnostics;
    return {
        mode: "directory",
        contentText: finalText,
        workspaceEvidence: envelope,
        lineCount: finalText === "" ? 0 : finalText.split("\n").length,
        byteLength: Buffer.byteLength(finalText, "utf8"),
        truncated: truncated || omissionNotes.length > 0,
        upstreamDetails: upstream,
        navigation: navDetails,
        diagnostics: diagDetails,
    } as any;
}
