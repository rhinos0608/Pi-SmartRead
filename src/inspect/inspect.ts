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
    const mode = resolveInspectV4Mode(input);
    if (mode === "directory") return executeDirectoryInspect(input);
    return executeFileInspect(input);
}
