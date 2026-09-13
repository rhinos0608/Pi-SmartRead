/**
 * Script-mode orchestrator: `executeScriptMode(input)`.
 *
 * Creates the `RunBudget`, builds the frozen host bindings, runs the
 * QuickJS sandbox, then merges only successfully-completed calls'
 * per-call envelopes (completion order) via the generalized
 * `buildBatchWorkspaceEvidence` (`mode: "query"`, `"last-wins"` §6).
 * Failed/aborted calls appear in the call log but contribute no
 * resources (§5).
 */
import { buildBatchWorkspaceEvidence } from "../evidence/read-many-evidence.js";
import { buildHostBindings } from "./host-bindings.js";
import { runInSandbox } from "./sandbox.js";
import { RunBudget } from "./run-budget.js";
import type { ScriptModeInput, ScriptModeResult } from "./types.js";

function renderContentText(
    status: ScriptModeResult["status"],
    returnPreview: string,
    callLog: ScriptModeResult["callLog"],
    errorMessage?: string,
): string {
    const lines: string[] = [`Script result (${status}):`, "", returnPreview, "", `Calls (${callLog.length}):`];
    callLog.forEach((entry, i) => {
        const where = entry.canonicalPathOrResourceId ?? "(no path)";
        lines.push(`  ${i + 1}. ${entry.op} ${entry.status} ${entry.elapsedMs}ms ${where} ${entry.argsSummary}`);
    });
    if (errorMessage) {
        lines.push("", `Error: ${errorMessage}`);
    }
    return lines.join("\n");
}

export async function executeScriptMode(input: ScriptModeInput): Promise<ScriptModeResult> {
    const budget = new RunBudget(input.budget ?? {}, input.signal);
    try {
        const host = buildHostBindings({
            budget,
            cwd: input.cwd,
            sessionFilePath: input.sessionFilePath,
            ...(input.contextGraph ? { contextGraph: input.contextGraph } : {}),
            ...(input.lspInspectionProvider ? { lspInspectionProvider: input.lspInspectionProvider } : {}),
        });
        const outcome = await runInSandbox({
            script: input.script,
            host,
            signal: budget.signal,
            timeoutMs: budget.options.deadlineMs,
            memoryLimitBytes: input.memoryLimitBytes,
        });

        const perFile = new Map<number, (typeof outcome.evidences)[number]>();
        outcome.evidences.forEach((envelope, i) => perFile.set(i, envelope));
        const workspaceEvidence = buildBatchWorkspaceEvidence({
            cwd: input.cwd,
            sessionFilePath: input.sessionFilePath,
            perFile,
            mode: "query",
            dedupe: "last-wins",
        });

        const callLog = [...budget.callLog];
        if (outcome.status !== "ok") {
            const contentText = renderContentText("degraded", "(no return value)", callLog, outcome.errorMessage);
            return {
                status: "degraded",
                ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
                ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
                contentText,
                lineCount: contentText === "" ? 0 : contentText.split("\n").length,
                byteLength: Buffer.byteLength(contentText, "utf8"),
                truncated: false,
                workspaceEvidence,
                callLog,
            };
        }

        // Final-return-value size cap: truncate + flag (InspectV4Result convention).
        const maxReturnBytes = budget.options.maxReturnBytes;
        let serialized = "";
        try {
            serialized = JSON.stringify(outcome.returnValue) ?? "";
        } catch {
            serialized = "(unserializable return value)";
        }
        let returnValue: unknown = outcome.returnValue;
        let truncated = false;
        if (Buffer.byteLength(serialized, "utf8") > maxReturnBytes) {
            truncated = true;
            const preview = serialized.slice(0, Math.min(serialized.length, maxReturnBytes));
            returnValue = { __truncated: true, preview, note: "return value exceeded size cap; preview truncated" };
        }
        const returnPreview = truncated ? JSON.stringify(returnValue) : serialized;
        const contentText = renderContentText("ok", returnPreview, callLog);
        return {
            status: "ok",
            returnValue,
            contentText,
            lineCount: contentText === "" ? 0 : contentText.split("\n").length,
            byteLength: Buffer.byteLength(contentText, "utf8"),
            truncated,
            workspaceEvidence,
            callLog,
        };
    } finally {
        budget.dispose();
    }
}
