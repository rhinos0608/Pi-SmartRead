/**
 * v4 dispatch: path-based mode detection. Directory → repo map. File → structural facts + signals.
 *
 * WP-4: Wires new inspect params (callDepth, callDirection, impact, deadCode, diff,
 * clusters, layers, boundaries, routes, hotspots, graphSchema) to wave-1 compute modules.
 * Renders output sections per spec output shapes, respecting token budget.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, statSync } from "node:fs";
import { relative as pathRelative, resolve as pathResolve } from "node:path";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
    type InspectMode,
} from "@rhinos0608/pi-workspace-protocol";
import { createRepoTool } from "./repomap-tool.js";
import { extractStructuralFacts } from "./structural-facts.js";
import { computeFileSignals } from "./signals.js";
import type { InspectV4Input, InspectV4Mode, InspectV4Result, CallDirection, DiffTarget } from "./inspect-types.js";
import type { StructuralFacts } from "./structural-facts-types.js";
import type { ContextGraph } from "./context-graph.js";
import { expandBlastRadius, classifyFileRisk, detectDeadCode } from "./impact-analysis.js";
import { detectCommunities } from "./community-detection.js";
import { extractRoutes, scanRoutes } from "./route-extraction.js";
import { deriveLayers } from "./layer-analysis.js";
import { detectServiceBoundaries } from "./monorepo-detector.js";
import { findGitRoot } from "./git-history.js";
import { buildCallGraph, type CallGraphResult } from "./callgraph.js";
import { findSrcFiles } from "./file-discovery.js";

const execFileAsync = promisify(execFile);

// ── Token budget helpers ─────────────────────────────────────────

function estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

// ── Validation (spec §4) ─────────────────────────────────────────

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

// ── Lazy call-graph builder ──────────────────────────────────────

async function ensureCallGraph(
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

// ── Main dispatch ────────────────────────────────────────────────

export async function executeInspectV4(input: InspectV4Input): Promise<InspectV4Result> {
    requireSessionFilePath(input);
    const mode = resolveInspectV4Mode(input);
    if (mode === "directory") return executeDirectoryInspect(input);
    return executeFileInspect(input);
}

// ── Directory inspect ────────────────────────────────────────────

export async function executeDirectoryInspect(input: InspectV4Input): Promise<InspectV4Result> {
    const sessionFilePath = input.sessionFilePath;
    const cwd = realpathSync(input.cwd);
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(sessionFilePath);

    const mapRoot = pathResolve(cwd, input.path);
    const repoTool = createRepoTool();
    const fakeCtx = { cwd, sessionManager: undefined } as any;
    const params: Record<string, unknown> = {
        directory: mapRoot,
        mapTokens: input.mapTokens ?? 4096,
        compact: input.compact ?? true,
    };
    if (input.focus && input.focus.length > 0) {
        params.focus = input.focus;
    }
    const result = await repoTool.execute(
        "inspect-v4-map",
        params as any,
        input.signal,
        undefined,
        fakeCtx,
    );
    const contentText = (result.content?.[0] as { type: "text"; text: string } | undefined)?.text ?? "";

    // Token budget tracking
    const budget = input.mapTokens ?? 4096;
    let usedTokens = estimateTokens(contentText);
    const coreLines = contentText.split("\n");

    // ── Compute sections for directory mode ─────────────────────
    const extraSections: string[] = [];
    let callGraph: CallGraphResult | null = null;

    // Lazy build call graph if needed by hotspots/deadCode/diff
    if (input.hotspots || input.deadCode || input.diff) {
        callGraph = await ensureCallGraph(input, null);
    }

    // clusters
    if (input.clusters) {
        try {
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
            extraSections.push(lines.join("\n"));
        } catch {
            extraSections.push("## Community Clusters\n\n(computation failed)");
        }
    }

    // layers
    if (input.layers) {
        try {
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
            extraSections.push(lines.join("\n"));
        } catch {
            extraSections.push("## Architectural Layers\n\n(computation failed)");
        }
    }

    // boundaries
    if (input.boundaries) {
        try {
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
            extraSections.push(lines.join("\n"));
        } catch {
            extraSections.push("## Service Boundaries\n\n(detection failed)");
        }
    }

    // deadCode (directory scope)
    if (input.deadCode && callGraph) {
        try {
            const deadCode = detectDeadCode(pathRelative(cwd, pathResolve(cwd, input.path)), callGraph);
            if (deadCode.totalDeadFunctions > 0) {
                const lines: string[] = [`## Dead Code (${deadCode.totalDeadFunctions} zero-caller functions)`, ""];
                for (const file of deadCode.files) {
                    lines.push(`  ${pathRelative(cwd, file.path)}:`);
                    for (const fn of file.functions.slice(0, 10)) {
                        lines.push(`    ${fn.name}()  L${fn.line}`);
                    }
                    if (file.functions.length > 10) {
                        lines.push(`    (${file.functions.length - 10} more in this file)`);
                    }
                    // Directory mode: refs stay in rendered text; no resource authorization
                }
                extraSections.push(lines.join("\n"));
            } else {
                extraSections.push("## Dead Code\n\n(no zero-caller functions found)");
            }
        } catch {
            extraSections.push("## Dead Code\n\n(detection failed)");
        }
    }

    // routes (directory scan)
    if (input.routes) {
        try {
            const routes = scanRoutes(pathResolve(cwd, input.path));
            if (routes.length > 0) {
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
                // Directory mode: route refs stay in rendered text; no resource authorization
                extraSections.push(lines.join("\n"));
            } else {
                extraSections.push("## HTTP Routes\n\n(no routes found)");
            }
        } catch {
            extraSections.push("## HTTP Routes\n\n(extraction failed)");
        }
    }

    // hotspots (directory scope)
    if (input.hotspots && callGraph) {
        try {
            const sorted = [...callGraph.functions]
                .sort((a, b) => b.calledBy.length - a.calledBy.length)
                .slice(0, 15);
            if (sorted.length > 0) {
                const lines: string[] = [`## Hotspots (top ${sorted.length} by fan-in)`, ""];
                for (let i = 0; i < sorted.length; i++) {
                    const fn = sorted[i]!;
                    const num = String(i + 1).padStart(2, " ");
                    lines.push(`  ${num}. ${fn.name.padEnd(35)} ${fn.file}:${fn.line}  — ${fn.calledBy.length} callers`);
                }
                extraSections.push(lines.join("\n"));
            } else {
                extraSections.push("## Hotspots\n\n(no function data available)");
            }
        } catch {
            extraSections.push("## Hotspots\n\n(computation failed)");
        }
    }

    // graphSchema (directory scope)
    if (input.graphSchema) {
        try {
            const lines: string[] = ["## Graph Schema", ""];
            if (input.contextGraph) {
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
            } else {
                lines.push('contextGraph: "not built"');
            }
            lines.push("");
            extraSections.push(lines.join("\n"));
        } catch {
            extraSections.push("## Graph Schema\n\n(introspection failed)");
        }
    }

    // diff (directory scope)
    if (input.diff) {
        try {
            const section = await renderDiffSection(input.diff, cwd, callGraph);
            extraSections.push(section.text);
        } catch {
            extraSections.push("## Diff Impact\n\n(computation failed)");
        }
    }

    // ── Render extra sections with token budget ────────────────
    const allSectionTexts: string[] = [];
    let omittedSections: string[] = [];
    let budgetExhausted = false;

    for (let i = 0; i < extraSections.length; i++) {
        const sectionText = extraSections[i]!;
        const tokens = estimateTokens(sectionText);
        if (!budgetExhausted && usedTokens + tokens <= budget) {
            allSectionTexts.push(sectionText);
            usedTokens += tokens;
        } else {
            budgetExhausted = true;
            // Find section name from order
            const sectionName = findSectionName(extraSections, i);
            omittedSections.push(sectionName);
        }
    }

    // Build final content
    const finalSections = [...coreLines];
    if (allSectionTexts.length > 0) {
        finalSections.push("", ...allSectionTexts.map(s => s).flatMap(s => s.split("\n")));
    }
    if (omittedSections.length > 0) {
        finalSections.push("");
        for (const name of omittedSections) {
            finalSections.push(`## ${name} (omitted: token budget reached — rerun with higher mapTokens)`);
        }
    }

    const finalText = finalSections.join("\n");

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

    return {
        mode: "directory",
        contentText: finalText,
        workspaceEvidence: envelope,
        lineCount: finalText === "" ? 0 : finalText.split("\n").length,
        byteLength: Buffer.byteLength(finalText, "utf8"),
        truncated: budgetExhausted,
        upstreamDetails: result.details as Record<string, unknown>,
    };
}

// ── File inspect ─────────────────────────────────────────────────

export async function executeFileInspect(input: InspectV4Input): Promise<InspectV4Result> {
    const sessionFilePath = input.sessionFilePath;
    const cwd = realpathSync(input.cwd);
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(sessionFilePath);
    const absolutePath = pathResolve(cwd, input.path);

    // Structural facts + signals — stubs return empty data (P1/P2 engines WIP)
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
        const canonical = pathResolve(cwd, dep.file);
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
        const canonical = pathResolve(cwd, reexport.barrelFile);
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
        try {
            const fileRelPath = pathRelative(cwd, absolutePath);
            const deadCode = detectDeadCode(fileRelPath, callGraph);
            if (deadCode.totalDeadFunctions > 0) {
                const lines: string[] = [`## Dead Code (${deadCode.totalDeadFunctions} zero-caller functions)`, ""];
                for (const file of deadCode.files) {
                    lines.push(`  ${file.path}:`);
                    for (const fn of file.functions) {
                        lines.push(`    ${fn.name}()  L${fn.line}`);
                    }
                    lines.push("");
                }
                const sr2 = new Map<string, InspectedResource>();
                addResource(sr2, absolutePath, cwd);
                sectionResources.push(sr2);
                extraSections.push(lines.join("\n"));
            } else {
                const sr3 = new Map<string, InspectedResource>();
                addResource(sr3, absolutePath, cwd);
                sectionResources.push(sr3);
                extraSections.push("## Dead Code\n\n(no zero-caller functions found in this file)");
            }
        } catch {
            extraSections.push("## Dead Code\n\n(detection failed)");
            sectionResources.push(new Map());
        }
    }

    // routes (file mode — single file)
    if (input.routes) {
        try {
            const routes = extractRoutes(absolutePath);
            if (routes.length > 0) {
                const lines: string[] = [`## HTTP Routes (${routes.length} routes)`, ""];
                for (const r of routes) {
                    const handler = r.handler ?? "(handler)";
                    lines.push(`  ${r.method.padEnd(7)} ${r.path.padEnd(30)} → ${handler}  L${r.line}`);
                }
                const sr4 = new Map<string, InspectedResource>();
                addResource(sr4, absolutePath, cwd);
                sectionResources.push(sr4);
                extraSections.push(lines.join("\n"));
            } else {
                sectionResources.push(new Map());
                extraSections.push("## HTTP Routes\n\n(no routes found in this file)");
            }
        } catch {
            extraSections.push("## HTTP Routes\n\n(extraction failed)");
            sectionResources.push(new Map());
        }
    }

    // hotspots (file scope — functions in this file ranked by fan-in)
    if (input.hotspots && callGraph) {
        try {
            const fileRelPath = pathRelative(cwd, absolutePath);
            const fileFns = callGraph.functions
                .filter(f => f.file === fileRelPath)
                .sort((a, b) => b.calledBy.length - a.calledBy.length)
                .slice(0, 15);
            if (fileFns.length > 0) {
                const lines: string[] = [`## Hotspots (${fileFns.length} functions by fan-in)`, ""];
                for (let i = 0; i < fileFns.length; i++) {
                    const fn = fileFns[i]!;
                    const num = String(i + 1).padStart(2, " ");
                    lines.push(`  ${num}. ${fn.name.padEnd(35)} L${fn.line}  — ${fn.calledBy.length} callers`);
                }
                const sr5 = new Map<string, InspectedResource>();
                addResource(sr5, absolutePath, cwd);
                sectionResources.push(sr5);
                extraSections.push(lines.join("\n"));
            } else {
                const sr6 = new Map<string, InspectedResource>();
                addResource(sr6, absolutePath, cwd);
                sectionResources.push(sr6);
                extraSections.push("## Hotspots\n\n(no function data for this file)");
            }
        } catch {
            extraSections.push("## Hotspots\n\n(computation failed)");
            sectionResources.push(new Map());
        }
    }

    // graphSchema (file scope)
    if (input.graphSchema) {
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
            sectionResources.push(new Map());
            extraSections.push(lines.join("\n"));
        } catch {
            extraSections.push("## Graph Schema\n\n(introspection failed)");
            sectionResources.push(new Map());
        }
    }

    // ── Render extra sections with token budget ────────────────
    const allSectionTexts: string[] = [];
    let omittedSections: string[] = [];
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
                if (!admittedSectionResources.has(key)) {
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
        if (!resourcesByPath.has(key)) {
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

    return {
        mode: "file",
        contentText,
        workspaceEvidence: envelope,
        lineCount: finalParts.length,
        byteLength: Buffer.byteLength(contentText, "utf8"),
        truncated: budgetExhausted,
    };
}

// ── Section renderers ────────────────────────────────────────────

function renderCallGraphSection(
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

// ── Helpers ──────────────────────────────────────────────────────

function setResourceRanges(
    resourcesByPath: Map<string, InspectedResource>,
    canonical: string,
    line: number,
): void {
    const existing = resourcesByPath.get(canonical);
    if (existing) {
        const merged = mergeRanges([...existing.allowedRanges, { startLine: line, endLine: line }]);
        resourcesByPath.set(canonical, { ...existing, allowedRanges: merged });
    } else {
        resourcesByPath.set(canonical, {
            resourceId: resourceIdFor({ canonicalPath: canonical, kind: "range", range: { startLine: line, endLine: line } }),
            canonicalPath: canonical,
            kind: "range",
            coverage: "search-match",
            allowedRanges: [{ startLine: line, endLine: line }],
            fresh: false,
        });
    }
}

function tryCanonical(filePath: string): string {
    try { return realpathSync(filePath); } catch { return filePath; }
}

function addResource(
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

function mergeRanges(ranges: Array<{ startLine: number; endLine: number }>): Array<{ startLine: number; endLine: number }> {
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

function riskOrder(risk: string): number {
    switch (risk) {
        case "critical": return 0;
        case "high": return 1;
        case "medium": return 2;
        case "low": return 3;
        default: return 4;
    }
}

/**
 * Build import edges from ContextGraph for community detection / layer analysis.
 * Falls back to empty array when contextGraph is not available.
 */
function buildImportEdges(contextGraph: ContextGraph | undefined): Array<{ from: string; to: string }> {
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
function guessClusterLabel(members: string[]): string {
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
function findSectionName(sections: string[], index: number): string {
    const text = sections[index] ?? "";
    const match = text.match(/^##\s+(.+?)(?:\s*\(|$)/m);
    if (match?.[1]) return match[1].trim();
    return `Section ${index + 1}`;
}

/**
 * Run git diff and return structured changes for the diff param.
 * Returns null when git is absent, not a repo, or diff fails.
 */
export async function runGitDiff(
    diffTarget: DiffTarget,
    cwd: string
): Promise<{ file: string; status?: string; oldFile?: string; addedCount: number; addedLines: number[]; deletedLines: number; changedLineRanges: Array<{ startLine: number; endLine: number }> }[] | null> {
    const gitRoot = await findGitRoot(cwd);
    if (!gitRoot) return null;

    const args: string[] = ["diff"];
    if (diffTarget === "staged") args.push("--cached");
    else if (diffTarget === "HEAD") args.push("HEAD~1");
    args.push("--numstat");

    let stdout: string;
    try {
        const result = await execFileAsync("git", args, {
            cwd: gitRoot,
            encoding: "utf-8",
            maxBuffer: 5 * 1024 * 1024,
        }) as { stdout: string };
        stdout = result.stdout;
    } catch {
        return null;
    }

    if (!stdout.trim()) return [];

    const files: Array<{
        file: string;
        addedCount: number;
        addedLines: number[];
        deletedLines: number;
        changedLineRanges: Array<{ startLine: number; endLine: number }>;
    }> = [];

    for (const line of stdout.trim().split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const added = parseInt(parts[0]!, 10);
        const _deleted = parseInt(parts[1]!, 10);
        const file = parts.slice(2).join("\t").trim();
        if (!file || isNaN(added)) continue;
        files.push({ file, addedCount: added, addedLines: [], deletedLines: _deleted, changedLineRanges: [] });
    }

    if (files.length === 0) return files;

    // Get unified diff with hunk headers for line number mapping
    const unifiedArgs: string[] = ["diff"];
    if (diffTarget === "staged") unifiedArgs.push("--cached");
    else if (diffTarget === "HEAD") unifiedArgs.push("HEAD~1");
    unifiedArgs.push("--unified=0");

    try {
        const unifiedResult = await execFileAsync("git", unifiedArgs, {
            cwd: gitRoot,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
        }) as { stdout: string };
        const unifiedStdout = unifiedResult.stdout;

        // Parse hunk headers to get changed line ranges per file
        const hunkRegex = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
        let currentFile = "";
        for (const uline of unifiedStdout.split("\n")) {
            const fileMatch = uline.match(/^\+\+\+\s+b\/(.+)$/);
            if (fileMatch) {
                currentFile = fileMatch[1]!;
                continue;
            }
            if (!currentFile) continue;
            const hunkMatch = hunkRegex.exec(uline);
            if (hunkMatch) {
                const startLine = parseInt(hunkMatch[1]!, 10);
                const hunkLen = hunkMatch[2] ? parseInt(hunkMatch[2]!, 10) : 1;
                const endLine = startLine + hunkLen - 1;
                const entry = files.find(f => f.file === currentFile);
                if (entry && hunkLen > 0) {
                    entry.addedLines.push(startLine, endLine);
                    entry.changedLineRanges.push({ startLine, endLine });
                }
            }
        }
    } catch {
        // Unified diff parsing is best-effort; numstat data is still usable
    }

    return files;
}

/**
 * Render the diff impact section text.
 */
export async function renderDiffSection(
    diffTarget: DiffTarget,
    cwd: string,
    callGraph?: CallGraphResult | null,
): Promise<{ text: string; emittedFiles: string[] }> {
    const changes = await runGitDiff(diffTarget, cwd);

    if (changes === null) {
        return { text: "## Diff Impact\n\nError: inspect diff requires a git repository", emittedFiles: [] };
    }

    if (changes.length === 0) {
        return { text: `## Diff Impact: ${diffTarget} changes\n\n(no changes found)`, emittedFiles: [] };
    }

    // Find symbols in changed line ranges using basic function-definition regex
    const lines: string[] = [
        `## Diff Impact: ${diffTarget} changes`,
        "",
        `Changed Files (${changes.length}):`,
    ];

    for (const change of changes) {
        const absPath = pathResolve(cwd, change.file);
        const symbols = (callGraph?.functions ?? []).filter((fn) => {
            const fnPath = pathResolve(cwd, fn.file);
            return fnPath === absPath && change.changedLineRanges.some((r) => fn.line <= r.endLine && (fn.endLine ?? fn.line) >= r.startLine);
        });
        const symbolNote = symbols.length > 0
            ? `${symbols.length} symbol${symbols.length !== 1 ? "s" : ""} modified: ${symbols.map((fn) => fn.qualifiedName ?? fn.name).join(", ")}`
            : "symbols unavailable (AST coverage incomplete)";
        lines.push(`  ${change.file}  — ${symbolNote}`);
    }

    // Risk requires complete impact evidence; diff churn alone is not evidence.
    lines.push("", "Impact assessment: unavailable (diff does not include complete callgraph coverage)");

    return { text: lines.join("\n"), emittedFiles: changes.map(c => pathResolve(cwd, c.file)) };
}
