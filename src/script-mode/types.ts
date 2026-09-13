/**
 * Script-mode shared types.
 *
 * Self-contained engine for the planned `inspect({ script })` feature.
 * Schema/tool wiring is a separate follow-up — nothing here touches
 * `src/inspect/inspect-tool.ts` or `executeInspectV4`'s dispatch.
 */
import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";
import type { ContextGraph } from "../context-graph.js";
import type { LspInspectionProvider } from "../lsp/lsp-inspection.js";

/** Per-host-call audit entry. Carried on the outer script result (§5). */
export interface HostCallLogEntry {
    readonly op: string;
    /** JSON-serialized args, redacted + truncated. Audit visibility only. */
    readonly argsSummary: string;
    /** Canonical file path or resourceId touched, when file-scoped. */
    readonly canonicalPathOrResourceId: string | null;
    readonly status: "ok" | "error" | "aborted" | "quota-exceeded";
    readonly elapsedMs: number;
}

/** Result of one host binding invocation: JSON value + per-call evidence. */
export interface HostCallResult {
    /** JSON-serializable result handed back into the guest script. */
    readonly value: unknown;
    /**
     * Per-call evidence envelope, or null when the operation legitimately
     * has no file-scoped output (e.g. a graph call with no resources).
     * Only successfully-completed calls produce envelopes (§5).
     */
    readonly evidence: WorkspaceEvidenceEnvelope | null;
}

/** Budget knobs. All constructor-configurable; defaults are provisional (§3). */
export interface RunBudgetOptions {
    /** Total host calls admitted per run. Default 50. */
    readonly maxTotalCalls?: number;
    /** Tighter sub-cap for expensive `lsp.*` calls. Default 10. */
    readonly maxLspCalls?: number;
    /** Max concurrent in-flight host operations. Default 5. */
    readonly maxConcurrent?: number;
    /** Per-call serialized result cap in bytes. Default 200_000. */
    readonly maxBytesPerCall?: number;
    /** Running total returned-bytes cap. Default 1_000_000. */
    readonly maxTotalBytes?: number;
    /** Wall-clock run budget in ms. Default 5000. */
    readonly deadlineMs?: number;
    /** Serialized final-return-value cap in bytes. Default 200_000. */
    readonly maxReturnBytes?: number;
}

/** Input to the script-mode engine. */
export interface ScriptModeInput {
    /** Guest JS source. Evaluated as `(async () => { <script> })()`. */
    readonly script: string;
    readonly cwd: string;
    readonly sessionFilePath: string;
    /** Outer abort (linked into the run budget). */
    readonly signal?: AbortSignal;
    /** Threaded into grep/inspect compute calls when present. */
    readonly contextGraph?: ContextGraph;
    /** Threaded into inspect LSP sections when present. */
    readonly lspInspectionProvider?: LspInspectionProvider;
    /** Budget overrides (deadline + quotas). */
    readonly budget?: RunBudgetOptions;
    /** QuickJS heap limit in bytes. Default 12MB (provisional 8–16MB). */
    readonly memoryLimitBytes?: number;
}

export type ScriptStatus = "ok" | "degraded";
export type ScriptErrorKind =
    | "timeout"
    | "interrupted"
    | "memory-limit"
    | "js-exception"
    | "aborted"
    | "budget-exceeded";

/** Full engine outcome. Degraded runs still carry partial log + evidence. */
export interface ScriptModeResult {
    readonly status: ScriptStatus;
    readonly errorKind?: ScriptErrorKind;
    readonly errorMessage?: string;
    /** Script's return value (JSON-serializable), or a truncation marker. */
    readonly returnValue?: unknown;
    /** Rendered text form, following InspectV4Result byte/line convention. */
    readonly contentText: string;
    readonly lineCount: number;
    readonly byteLength: number;
    readonly truncated: boolean;
    /** Merged envelope (mode "query", last-completed-wins), or null. */
    readonly workspaceEvidence: WorkspaceEvidenceEnvelope | null;
    /** Bounded per-call audit log (successes + failures, §5). */
    readonly callLog: readonly HostCallLogEntry[];
}
