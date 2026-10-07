/**
 * v4 dispatch: path-based mode detection. Directory → repo map. File → structural facts + signals.
 *
 * WP-4: Wires new inspect params (callDepth, callDirection, impact, deadCode, diff,
 * clusters, layers, boundaries, routes, hotspots, graphSchema) to wave-1 compute modules.
 * Renders output sections per spec output shapes, respecting token budget.
 *
 * Facade: directory pipeline lives in ./inspect-directory.js, file
 * pipeline in ./inspect-file-core.js (sections in
 * ./inspect-file-sections.js, token admission in ./inspect-budget.js),
 * shared canonical/range/token/callgraph helpers in ./inspect-runtime.js.
 */
import { statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import {
    canonicalizeWorkspaceRoot,
    hashSessionFilePath,
    inspectionIdFor,
    PROTOCOL_SCHEMA_VERSION,
    type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";
import type { InspectV4Input, InspectV4Mode, InspectV4Result } from "./inspect-types.js";
import { executeDirectoryInspect } from "./inspect-directory.js";
import { executeFileInspect } from "./inspect-file-core.js";

// Re-exported for existing importers (tests) — canonical home is ./inspect-diff.js.
export { runGitDiff, renderDiffSection } from "./inspect-diff.js";
// Directory pipeline canonical home is ./inspect-directory.js; re-exported for existing importers.
export { executeDirectoryInspect } from "./inspect-directory.js";
// File pipeline canonical home is ./inspect-file-core.js; re-exported for existing importers.
export { executeFileInspect } from "./inspect-file-core.js";

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
    // Script mode is its own branch checked BEFORE stat-based dispatch —
    // it never touches the file/dir machinery (a script anchored at a
    // nonexistent path still runs rather than throwing "neither file nor
    // directory").
    if (input.script !== undefined) return executeScriptInspect(input);
    const mode = resolveInspectV4Mode(input);
    if (mode === "directory") return executeDirectoryInspect(input);
    return executeFileInspect(input);
}

/**
 * Empty query-mode envelope for scripts with zero successfully-completed
 * host calls. Zero resources means zero authority (same posture as
 * directory map mode) — it keeps the outer result's evidence slot valid
 * so the tool wrapper's publish path stays unconditional, while the
 * per-call audit log carries what actually ran.
 */
function emptyQueryEnvelope(cwd: string, sessionFilePath: string): WorkspaceEvidenceEnvelope {
    const sessionId = hashSessionFilePath(sessionFilePath);
    const canonicalWorkspaceRoot = canonicalizeWorkspaceRoot(cwd);
    return {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId: inspectionIdFor({ sessionId, workspaceRoot: canonicalWorkspaceRoot, resources: [] }),
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot,
        createdAt: new Date().toISOString(),
        resources: [],
        mode: "query",
    };
}

// Script-mode dispatch. Dynamic import keeps this module cycle-free:
// script-mode/host-bindings.ts statically imports executeInspectV4, so a
// static import back would close a module-eval cycle. The engine itself
// never publishes into the resolver — publish stays exclusively in the
// tool wrapper (one publish per outer tool call).
async function executeScriptInspect(input: InspectV4Input): Promise<InspectV4Result> {
    const { executeScriptMode } = await import("../script-mode/index.js");
    const scriptResult = await executeScriptMode({
        script: input.script as string,
        cwd: input.cwd,
        sessionFilePath: input.sessionFilePath,
        signal: input.signal,
        ...(input.contextGraphGetter ?? input.contextGraph
            ? { contextGraph: (input.contextGraphGetter ?? input.contextGraph)! }
            : {}),
        ...(input.lspInspectionProvider ? { lspInspectionProvider: input.lspInspectionProvider } : {}),
    });
    const workspaceEvidence = scriptResult.workspaceEvidence ?? emptyQueryEnvelope(input.cwd, input.sessionFilePath);
    return {
        // Runtime "query": script evidence merges per-call envelopes in
        // query mode (InspectV4ResultMode; InspectV4Mode stays "directory" | "file").
        mode: "query",
        contentText: scriptResult.contentText,
        workspaceEvidence,
        lineCount: scriptResult.lineCount,
        byteLength: scriptResult.byteLength,
        truncated: scriptResult.truncated,
        upstreamDetails: {
            script: {
                status: scriptResult.status,
                ...(scriptResult.returnValue !== undefined ? { returnValue: scriptResult.returnValue } : {}),
                ...(scriptResult.errorKind ? { errorKind: scriptResult.errorKind } : {}),
                ...(scriptResult.errorMessage ? { errorMessage: scriptResult.errorMessage } : {}),
                // Engine's log is already bounded (truncated arg summaries,
                // host-call-count budget) — reused as-is for audit visibility.
                callLog: [...scriptResult.callLog],
                anchorPath: input.path,
            },
        },
    };
}
