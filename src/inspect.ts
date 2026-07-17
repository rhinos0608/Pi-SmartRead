/**
 * v4 dispatch: path-based mode detection. Directory → repo map. File → structural facts + signals.
 *
 * WP-4: Wires new inspect params (callDepth, callDirection, impact, deadCode, diff,
 * clusters, layers, boundaries, routes, hotspots, graphSchema) to wave-1 compute modules.
 * Renders output sections per spec output shapes, respecting token budget.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, statSync, readFileSync } from "node:fs";
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

    // Lazy build call graph if needed by hotspots/deadCode
    if (input.hotspots || input.deadCode) {
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
            const deadCode = detectDeadCode(pathResolve(cwd, input.path), callGraph);
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
                lines.push("Context graph: available (node/edge introspection pending full index)");
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
            const section = await renderDiffSection(input.diff, cwd);
            extraSections.push(section);
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
        facts = await extractStructuralFacts(absolutePath, cwd, input.signal);
    } catch {
        facts = { callers: [], children: [], baseClasses: [], interfaces: [], overrides: [], reExportedBy: [], notices: ["extraction failed"] };
    }
    let signals: { path: string; signals: any[]; computedAt: string; fallbackNotices: string[] };
    try {
        signals = await computeFileSignals(
            absolutePath,
            cwd,
            null,
            input.signals as any,
            input.signal,
        );
    } catch {
        signals = { path: absolutePath, signals: [], computedAt: new Date().toISOString(), fallbackNotices: ["signal computation failed"] };
    }

    // Build evidence envelope: mode "symbol" (protocol-valid), resources with search-match coverage
    const resourcesByPath = new Map<string, InspectedResource>();

    // Callers => each caller file gets a resource
    for (const caller of facts.callers) {
        const canonical = pathResolve(cwd, caller.file);
        setResourceRanges(resourcesByPath, canonical, caller.line);
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

    // ── Core content lines ─────────────────────────────────────
    const relativePath = pathRelative(cwd, absolutePath);
    const coreLines: string[] = [
        `## Structural Facts: ${relativePath}`,
        "",
        `Callers (${facts.callers.length})`,
        ...(facts.callers.length > 0
            ? facts.callers.map(c => `  ${c.file}:${c.line}`)
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
            ? signals.signals.map(s => `  ${s.label}: ${s.value}${s.detail ? ` (${s.detail})` : ""}`)
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

    // Lazy build call graph if needed
    if (input.callDepth || input.deadCode || input.hotspots) {
        callGraph = await ensureCallGraph(input, null);
    }

    // ── Compute extra sections ──────────────────────────────────
    const extraSections: string[] = [];

    // callDepth + callDirection (file mode only)
    if (input.callDepth) {
        try {
            const depth = Math.min(Math.max(input.callDepth, 1), 5);
            const direction = input.callDirection ?? "both";
            const section = renderCallGraphSection(callGraph, relativePath, facts, depth, direction, cwd);
            extraSections.push(section);
            addResource(resourcesByPath, absolutePath, cwd);
        } catch {
            extraSections.push("## Call Graph\n\n(computation failed)");
        }
    }

    // impact (file mode)
    if (input.impact) {
        try {
            if (input.contextGraph) {
                const blastRadius = await expandBlastRadius(absolutePath, input.contextGraph, 3);
                const affectedFiles: Array<{ path: string; risk: string; fanIn: number; depth: number }> = [];
                for (const [fp, { depth: d }] of blastRadius) {
                    if (fp === absolutePath) continue;
                    const fanIn = callGraph
                        ? callGraph.functions.filter(f => f.file === pathRelative(cwd, fp)).reduce((sum, f) => sum + f.calledBy.length, 0)
                        : 0;
                    const risk = classifyFileRisk({ filePath: fp, pageRank: 0, fanIn, blastRadiusDepth: d });
                    affectedFiles.push({ path: pathRelative(cwd, fp), risk, fanIn, depth: d });
                    addResource(resourcesByPath, fp, cwd);
                }
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
                // No contextGraph — run standalone computeImpact
                const { computeImpact } = await import("./impact-analysis.js");
                const impact = await computeImpact({
                    targetFile: pathRelative(cwd, absolutePath),
                    workspaceRoot: cwd,
                });
                const lines: string[] = [
                    `## Impact Analysis: ${relativePath}`,
                    "",
                    `Risk: ${impact.risk.toUpperCase()}`,
                    `  - ${impact.affectedFiles.length} affected files, blast radius depth ${impact.blastRadiusDepth}`,
                    "",
                    "Affected Files (by risk):",
                ];
                for (const af of impact.affectedFiles.slice(0, 15)) {
                    lines.push(`  ${af.risk.toUpperCase().padEnd(10)} ${af.path.padEnd(40)} — ${af.fanIn} callers`);
                }
                extraSections.push(lines.join("\n"));
            }
        } catch {
            extraSections.push("## Impact Analysis\n\n(computation failed)");
        }
    }

    // diff (file scope)
    if (input.diff) {
        try {
            const section = await renderDiffSection(input.diff, cwd);
            extraSections.push(section);
        } catch {
            extraSections.push("## Diff Impact\n\n(computation failed)");
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
                addResource(resourcesByPath, absolutePath, cwd);
                extraSections.push(lines.join("\n"));
            } else {
                addResource(resourcesByPath, absolutePath, cwd);
                extraSections.push("## Dead Code\n\n(no zero-caller functions found in this file)");
            }
        } catch {
            extraSections.push("## Dead Code\n\n(detection failed)");
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
                addResource(resourcesByPath, absolutePath, cwd);
                extraSections.push(lines.join("\n"));
            } else {
                extraSections.push("## HTTP Routes\n\n(no routes found in this file)");
            }
        } catch {
            extraSections.push("## HTTP Routes\n\n(extraction failed)");
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
                addResource(resourcesByPath, absolutePath, cwd);
                extraSections.push(lines.join("\n"));
            } else {
                addResource(resourcesByPath, absolutePath, cwd);
                extraSections.push("## Hotspots\n\n(no function data for this file)");
            }
        } catch {
            extraSections.push("## Hotspots\n\n(computation failed)");
        }
    }

    // graphSchema (file scope)
    if (input.graphSchema) {
        try {
            const lines: string[] = ["## Graph Schema", ""];
            if (input.contextGraph) {
                lines.push("Context graph: available (node/edge introspection pending full index)");
            } else {
                lines.push('contextGraph: "not built"');
            }
            lines.push("");
            extraSections.push(lines.join("\n"));
        } catch {
            extraSections.push("## Graph Schema\n\n(introspection failed)");
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
): string {
    const lines: string[] = [
        `## Call Graph (depth=${depth}, direction=${direction})`,
        "",
    ];

    if (!callGraph) {
        lines.push("(call graph not available — build with includeCalls: true)");
        return lines.join("\n");
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
        return lines.join("\n");
    }

    // Outbound (callees)
    if (direction === "callees" || direction === "both") {
        lines.push("outbound:");
        for (const fn of fileFns.slice(0, 5)) {
            lines.push(`  ${fn.name}()  L${fn.line}`);
            renderCallees(callGraph, fn, lines, depth, 1, cwd);
        }
        lines.push("");
    }

    // Inbound (callers)
    if (direction === "callers" || direction === "both") {
        lines.push("inbound:");
        for (const fn of fileFns.slice(0, 5)) {
            if (fn.calledBy.length > 0) {
                lines.push(`  ${fn.name}()  L${fn.line}  ← calls this`);
                renderCallers(callGraph, fn, lines, depth, 1, cwd);
            }
        }
        lines.push("");
    }

    return lines.join("\n");
}

function renderCallees(
    cg: CallGraphResult,
    fn: { calls: string[] },
    lines: string[],
    maxDepth: number,
    currentDepth: number,
    cwd: string,
    visited?: Set<string>,
): void {
    if (currentDepth >= maxDepth) return;
    const visitedSet = visited ?? new Set<string>();
    const indent = "    ".repeat(currentDepth);
    for (const calleeStr of fn.calls.slice(0, 10)) {
        const parts = calleeStr.split(":");
        const name = parts.length === 2 ? parts[1]! : calleeStr;
        if (visitedSet.has(name)) continue;
        visitedSet.add(name);
        const file = parts.length === 2 ? parts[0] : undefined;
        const fileSuffix = file ? `  ${file}` : "";
        lines.push(`${indent}→ ${name}()${fileSuffix}`);
        // Recurse into callees of the called function
        const calleeFn = cg.functions.find(f => f.name === name);
        if (calleeFn) {
            renderCallees(cg, calleeFn, lines, maxDepth, currentDepth + 1, cwd, visitedSet);
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
        const fileSuffix = file ? `  ${file}` : "";
        lines.push(`${indent}← ${name}()${fileSuffix}`);
        const callerFn = cg.functions.find(f => f.name === name);
        if (callerFn) {
            renderCallers(cg, callerFn, lines, maxDepth, currentDepth + 1, _cwd, visitedSet);
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

function addResource(
    resourcesByPath: Map<string, InspectedResource>,
    filePath: string,
    cwd: string,
): void {
    const canonical = pathResolve(cwd, filePath);
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
): Promise<{ file: string; addedCount: number; addedLines: number[]; deletedLines: number; changedLineRanges: Array<{ startLine: number; endLine: number }> }[] | null> {
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
        const hunkRegex = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
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
                const entry = files.find(f => f.file === currentFile);
                if (entry) {
                    entry.addedLines.push(startLine);
                    entry.changedLineRanges.push({ startLine, endLine: startLine });
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
): Promise<string> {
    const changes = await runGitDiff(diffTarget, cwd);

    if (changes === null) {
        return "## Diff Impact\n\nError: inspect diff requires a git repository";
    }

    if (changes.length === 0) {
        return `## Diff Impact: ${diffTarget} changes\n\n(no changes found)`;
    }

    // Find symbols in changed line ranges using basic function-definition regex
    const lines: string[] = [
        `## Diff Impact: ${diffTarget} changes`,
        "",
        `Changed Files (${changes.length}):`,
    ];

    for (const change of changes) {
        const symbolCount = countSymbolsInRanges(change.file, cwd, change.changedLineRanges);
        const symbolNote = symbolCount > 0
            ? `${symbolCount} symbol${symbolCount !== 1 ? "s" : ""} modified`
            : "0 symbols (comment only)";
        lines.push(`  ${change.file}  — ${symbolNote}`);
    }

    // Risk summary (simple heuristic based on number of changes)
    const criticalFiles = changes.filter(c => c.addedCount > 20).length;
    const highFiles = changes.filter(c => c.addedCount > 10 || c.deletedLines > 20).length;
    const mediumFiles = changes.length > 5 ? changes.length - criticalFiles - highFiles : 0;
    const lowFiles = Math.max(0, changes.length - criticalFiles - highFiles - mediumFiles);

    lines.push("", "Risk Summary:");
    if (criticalFiles > 0) {
        const names = changes.filter(c => c.addedCount > 20).map(c => c.file);
        lines.push(`  CRITICAL  ${criticalFiles} file${criticalFiles !== 1 ? "s" : ""}  ${names.join(", ")}`);
    }
    if (highFiles > 0) {
        const names = changes.filter(c => c.addedCount > 10 || c.deletedLines > 20).map(c => c.file);
        lines.push(`  HIGH      ${highFiles} file${highFiles !== 1 ? "s" : ""}  ${names.join(", ")}`);
    }
    if (mediumFiles > 0) {
        lines.push(`  MEDIUM    ${mediumFiles} files  (import chain)`);
    }
    if (lowFiles > 0) {
        lines.push(`  LOW       ${lowFiles} files  test files`);
    }

    return lines.join("\n");
}

/**
 * Count function/class definitions in changed line ranges using basic regex.
 */
function countSymbolsInRanges(
    relPath: string,
    cwd: string,
    ranges: Array<{ startLine: number; endLine: number }>
): number {
    if (ranges.length === 0) return 0;
    const absPath = pathResolve(cwd, relPath);
    let content: string;
    try {
        content = readFileSync(absPath, "utf-8");
    } catch {
        return 0;
    }
    const lines = content.split("\n");
    const funcRegex = /^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?(?:class|interface|type|enum)\s+\w+|^(?:export\s+)?const\s+\w+\s*[:=]\s*(?:\(|async|function)/m;
    let count = 0;
    for (const range of ranges) {
        for (let i = range.startLine - 1; i < Math.min(range.endLine, lines.length); i++) {
            if (funcRegex.test(lines[i] ?? "")) count++;
        }
    }
    return count;
}
