/**
 * File inspect pipeline core.
 *
 * Owns InspectExecutionContext (resolved paths, facts, signals,
 * lazy call graph) plus FeatureSelection (which ordered sections are
 * enabled — derived from the flat public input, schema unchanged) and
 * executeFileInspect orchestration. Section builders live in
 * ./inspect-file-sections.js in render order; token admission and
 * evidence auth live in ./inspect-budget.js.
 */
import { realpathSync } from "node:fs";
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
import { extractStructuralFacts } from "../structural/structural-facts.js";
import { computeFileSignals } from "../structural/signals.js";
import type { InspectV4Input, InspectV4Result } from "./inspect-types.js";
import type { StructuralFacts } from "../structural/structural-facts-types.js";
import type { CallGraphResult } from "../structural/callgraph.js";
import {
    buildFileCallGraphSection,
    buildFileImpactSection,
    buildFileDiffSection,
    buildFileDeadCodeSection,
    buildFileRoutesSection,
    buildFileHotspotsSection,
    buildFileNavigationSection,
    buildFileDiagnosticsSection,
    buildFileGraphSchemaSection,
} from "./inspect-file-sections.js";
import { admitFileSections, assembleFileOutput } from "./inspect-budget.js";
import {
    estimateTokens,
    tryCanonical,
    setResourceRanges,
    mergeRanges,
    ensureCallGraph,
} from "./inspect-runtime.js";

// ── Internal execution context (not public API) ─────────────────────

export interface InspectExecutionContext {
    input: InspectV4Input;
    cwd: string;
    canonicalRoot: string;
    sessionId: string;
    absolutePath: string;
    relativePath: string;
    facts: StructuralFacts;
    signals: { path: string; signals: any[]; computedAt: string; fallbackNotices: string[] };
    callGraph: CallGraphResult | null;
    budget: number;
    usedTokens: number;
    coreLines: string[];
}

// ── Internal feature selection (flat public schema unchanged) ───────
// Predicates mirror the original inline `if (input.*)` guards verbatim,
// evaluated in render order. callGraph-gated sections additionally
// require a non-null graph.

export interface FeatureSelection {
    callGraph: boolean;
    impact: boolean;
    diff: boolean;
    deadCode: boolean;
    routes: boolean;
    hotspots: boolean;
    navigation: boolean;
    diagnostics: boolean;
    graphSchema: boolean;
}

export function selectFileFeatures(input: InspectV4Input, callGraph: CallGraphResult | null): FeatureSelection {
    return {
        callGraph: !!input.callDepth,
        impact: !!input.impact,
        diff: !!input.diff,
        deadCode: !!input.deadCode && !!callGraph,
        routes: !!input.routes,
        hotspots: !!input.hotspots && !!callGraph,
        navigation: !!input.navigation,
        diagnostics: !!input.diagnostics,
        graphSchema: !!input.graphSchema,
    };
}

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

async function loadFactsWithFallback(
    absolutePath: string,
    cwd: string,
    input: InspectV4Input,
): Promise<StructuralFacts> {
    try {
        return await extractStructuralFacts(absolutePath, cwd, input.signal, input.contextGraph);
    } catch (e) {
        if (input.signal?.aborted) throw e;
        return { callers: [], externalDependents: [], dependencies: [], internalCallSites: [], children: [], baseClasses: [], interfaces: [], overrides: [], reExportedBy: [], notices: ["extraction failed"] };
    }
}

async function loadSignalsWithFallback(
    absolutePath: string,
    cwd: string,
    input: InspectV4Input,
    facts: StructuralFacts,
): Promise<InspectExecutionContext["signals"]> {
    try {
        return await computeFileSignals(
            absolutePath,
            cwd,
            input.contextGraph,
            input.signals as any,
            input.signal,
            facts.externalDependents,
        );
    } catch (e) {
        if (input.signal?.aborted) throw e;
        return { path: absolutePath, signals: [], computedAt: new Date().toISOString(), fallbackNotices: ["signal computation failed"] };
    }
}

function renderCallSiteLines(facts: StructuralFacts): string[] {
    if (facts.internalCallSites.length === 0) return [`  (none)`];
    const maxShow = 15;
    const shown = facts.internalCallSites.slice(0, maxShow);
    const omitted = facts.internalCallSites.length - maxShow;
    return [
        ...shown.map(c => `  L${c.line}`),
        ...(omitted > 0 ? [`  ... (+${omitted} more call sites)`] : []),
    ];
}

function buildCoreLines(cwd: string, relativePath: string, facts: StructuralFacts, signals: InspectExecutionContext["signals"]): string[] {
    return [
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
        ...renderCallSiteLines(facts),
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
}

export async function loadFileContext(input: InspectV4Input): Promise<InspectExecutionContext> {
    const sessionFilePath = input.sessionFilePath;
    const cwd = realpathSync(input.cwd);
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(sessionFilePath);
    const absolutePath = tryCanonical(pathResolve(cwd, input.path));

    // Structural facts + signals
    const facts = await loadFactsWithFallback(absolutePath, cwd, input);
    const signals = await loadSignalsWithFallback(absolutePath, cwd, input, facts);

    const relativePath = pathRelative(cwd, absolutePath);
    const coreLines = buildCoreLines(cwd, relativePath, facts, signals);

    const budget = input.mapTokens ?? 4096;
    const usedTokens = estimateTokens(coreLines.join("\n"));

    // Lazy build call graph if needed by callDepth/deadCode/hotspots/impact/diff
    let callGraph: CallGraphResult | null = null;
    if (input.callDepth || input.deadCode || input.hotspots || input.impact || input.diff) {
        callGraph = await ensureCallGraph(input, null);
    }

    return { input, cwd, canonicalRoot, sessionId, absolutePath, relativePath, facts, signals, callGraph, budget, usedTokens, coreLines };
}

export function buildFileEvidenceBase(ctx: InspectExecutionContext): Map<string, InspectedResource> {
    const { cwd, absolutePath, facts } = ctx;
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

    return resourcesByPath;
}

export interface CollectedFileSections {
    extraSections: string[];
    sectionResources: Array<Map<string, InspectedResource>>;
    navDetails: any;
    diagDetails: any;
}

// Render-order collection: callGraph → impact → diff → deadCode →
// routes → hotspots → navigation → diagnostics → graphSchema.
export async function collectFileSections(
    ctx: InspectExecutionContext,
    features: FeatureSelection,
): Promise<CollectedFileSections> {
    const { input, cwd, absolutePath, relativePath, facts, callGraph } = ctx;
    const extraSections: string[] = [];
    const sectionResources: Array<Map<string, InspectedResource>> = [];
    let navDetails: any = undefined;
    let diagDetails: any = undefined;

    if (features.callGraph) {
        const s = buildFileCallGraphSection(input, cwd, absolutePath, relativePath, facts, callGraph);
        extraSections.push(s.text);
        sectionResources.push(s.resources);
    }

    if (features.impact) {
        const s = await buildFileImpactSection(input, cwd, absolutePath, relativePath, facts, callGraph);
        extraSections.push(s.text);
        sectionResources.push(s.resources);
    }

    if (features.diff) {
        const s = await buildFileDiffSection(input, cwd, absolutePath, callGraph);
        extraSections.push(s.text);
        sectionResources.push(s.resources);
    }

    if (features.deadCode && callGraph) {
        const dead = buildFileDeadCodeSection(cwd, absolutePath, callGraph);
        extraSections.push(dead.text);
        sectionResources.push(dead.resources);
    }

    if (features.routes) {
        const fr = buildFileRoutesSection(absolutePath, cwd);
        extraSections.push(fr.text);
        sectionResources.push(fr.resources);
    }

    if (features.hotspots && callGraph) {
        const hs = buildFileHotspotsSection(cwd, absolutePath, callGraph);
        extraSections.push(hs.text);
        sectionResources.push(hs.resources);
    }

    if (features.navigation) {
        const nav = await buildFileNavigationSection(input, cwd, absolutePath);
        navDetails = nav.details;
        extraSections.push(nav.text);
        sectionResources.push(nav.resources);
    }

    if (features.diagnostics) {
        const diag = await buildFileDiagnosticsSection(input, cwd, absolutePath);
        diagDetails = diag.details;
        extraSections.push(diag.text);
        sectionResources.push(diag.resources);
    }

    if (features.graphSchema) {
        const gs = buildFileGraphSchemaSection(input, cwd, absolutePath, facts);
        sectionResources.push(gs.resources);
        extraSections.push(gs.text);
    }

    return { extraSections, sectionResources, navDetails, diagDetails };
}

export async function executeFileInspect(input: InspectV4Input): Promise<InspectV4Result> {
    const ctx = await loadFileContext(input);
    const { cwd } = ctx;
    const features = selectFileFeatures(input, ctx.callGraph);
    const collected = await collectFileSections(ctx, features);
    const { extraSections, sectionResources } = collected;
    const __navDetails = collected.navDetails;
    const __diagDetails = collected.diagDetails;

    // ── Token admission + evidence auth (admitted sections only) ───
    const admission = admitFileSections(extraSections, sectionResources, ctx.usedTokens, ctx.budget);
    const finalParts = assembleFileOutput(ctx.coreLines, admission.admittedTexts, admission.omittedSections);

    const contentText = finalParts.join("\n");
    // Merge structural facts resources with admitted section resources
    const resourcesByPath = buildFileEvidenceBase(ctx);
    for (const [key, val] of admission.admittedResources) {
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
        sessionId: ctx.sessionId,
        workspaceRoot: ctx.canonicalRoot,
        resources: resources.map(r => ({
            canonicalPath: r.canonicalPath,
            ...(r.allowedRanges[0] ? { range: r.allowedRanges[0] } : {}),
        })),
    });
    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId: ctx.sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: ctx.canonicalRoot,
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
        truncated: admission.budgetExhausted,
        upstreamDetails: Object.keys(upstreamFile).length ? upstreamFile : undefined,
        navigation: __navDetails,
        diagnostics: __diagDetails,
    } as any;
}
