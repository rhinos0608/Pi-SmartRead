/**
 * v4 dispatch: path-based mode detection. Directory → repo map. File → structural facts + signals.
 */
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
} from "@rhinos0608/pi-workspace-protocol";
import { createRepoTool } from "./repomap-tool.js";
import { extractStructuralFacts } from "./structural-facts.js";
import { computeFileSignals } from "./signals.js";
import type { InspectV4Input, InspectV4Mode, InspectV4Result } from "./inspect-types.js";
import type { StructuralFacts } from "./structural-facts-types.js";

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

export async function executeInspectV4(input: InspectV4Input): Promise<InspectV4Result> {
    requireSessionFilePath(input);
    const mode = resolveInspectV4Mode(input);
    if (mode === "directory") return executeDirectoryInspect(input);
    return executeFileInspect(input);
}

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
        mode: "map" as any,
    };

    return {
        mode: "directory",
        contentText,
        workspaceEvidence: envelope,
        lineCount: contentText === "" ? 0 : contentText.split("\n").length,
        byteLength: Buffer.byteLength(contentText, "utf8"),
        truncated: false,
        upstreamDetails: result.details as Record<string, unknown>,
    };
}

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
        mode: "symbol" as any,
    };

    // Render content text per SPEC example
    const relativePath = pathRelative(cwd, absolutePath);
    const lines: string[] = [
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
    const contentText = lines.join("\n");

    return {
        mode: "file",
        contentText,
        workspaceEvidence: envelope,
        lineCount: lines.length,
        byteLength: Buffer.byteLength(contentText, "utf8"),
        truncated: false,
    };
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
