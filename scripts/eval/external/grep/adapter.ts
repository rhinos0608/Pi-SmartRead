/**
 * Our-grep adapter for the external benchmark (judge off by default).
 *
 * Runs the production createGrepTool(...).execute on the per-instance
 * snapshot root with pattern = formulation text (issue title or full issue
 * body, D13). Captures the exact rendered text, shown cards, and ranks via
 * the onTraceGrepQuery seam; the ranked file list is deduped by first
 * appearance and metrics follow scripts/eval/external/grep/metrics.ts.
 * Judge is off: no judge provider is passed (byte-identical to production
 * mode-off).
 */

import { createGrepTool, type GrepTraceEvent } from "../../../../src/search/grep-tool.js";
import { formulationText, type BenchmarkInstance, type Formulation } from "./instance.js";
import { computeInstanceMetrics, type InstanceMetrics, type ShownUnit } from "./metrics.js";

export interface AdapterResult extends InstanceMetrics {
    /** Exact guarded rendered text (headers/notes included). */
    renderedText: string;
    /** Curated shown hit cards: tool-rendered fields only (no dataset text). */
    shownCards: ShownCard[];
    /** Routing details from the tool result (null when the call failed). */
    routing: AdapterRouting | null;
}

export interface ShownCard {
    relFile: string;
    line: number;
    endLine: number;
    engines: string[];
    score: number;
    name: string;
    kind: string;
}

export interface AdapterRouting {
    mode: string;
    reason: string;
}

export interface ReportOutcome extends InstanceMetrics {
    shownCards: ShownCard[];
    routing: AdapterRouting | null;
}

/** Per-query report row: metrics plus shown cards and routing, without rendered text. */
export function toReportOutcome(result: AdapterResult): ReportOutcome {
    const { renderedText: _dropped, ...rest } = result;
    void _dropped;
    return { ...rest, shownCards: result.shownCards.map((c) => ({ ...c, engines: [...c.engines] })) };
}

function errorStatus(error: unknown): string {
    if (error instanceof Error) {
        const name = error.name === "TimeoutError" || error.name === "AbortError" ? "timeout" : "error";
        const code = error.message.split(":")[0]?.trim().slice(0, 80) || "unknown";
        return `${name}:${code}`;
    }
    return "error:unknown";
}

/** Run our grep for one instance+formulation; judge off. */
export async function runOwnGrep(
    instance: BenchmarkInstance,
    snapshotRoot: string,
    formulation: Formulation,
    timeoutMs = 60000,
): Promise<AdapterResult> {
    const pattern = formulationText(instance, formulation);
    const events: GrepTraceEvent[] = [];
    const started = performance.now();
    let status = "ok";
    let fallbackText = "";
    let routing: AdapterRouting | null = null;
    try {
        const tool = createGrepTool({
            getWorkspaceRevision: () => 0,
            onTraceGrepQuery: (e: GrepTraceEvent) => {
                events.push(e);
            },
        });
        const signal = AbortSignal.timeout(timeoutMs);
        const result = await tool.execute(
            instance.instanceId,
            { pattern },
            signal,
            undefined,
            { cwd: snapshotRoot } as Parameters<ReturnType<typeof createGrepTool>["execute"]>[4],
        );
        const first = result.content[0] as { text?: string } | undefined;
        fallbackText = typeof first?.text === "string" ? first.text : "";
        const details = result.details as { routing?: { mode?: unknown; reason?: unknown } } | undefined;
        if (typeof details?.routing?.mode === "string" && typeof details?.routing?.reason === "string") {
            routing = { mode: details.routing.mode, reason: details.routing.reason };
        }
    } catch (error) {
        status = errorStatus(error);
    }
    const elapsedMs = performance.now() - started;
    const postJudge = events.find((e) => e.stage === "post-judge");
    const postCap = events.find((e) => e.stage === "post-cap");
    const renderedText = postCap?.stage === "post-cap" ? postCap.text : fallbackText;
    const shownHits = postJudge?.stage === "post-judge" ? postJudge.shown : [];
    const shown: ShownUnit[] = shownHits.map((h) => ({
        relFile: h.relFile,
        line: h.line,
        endLine: h.endLine,
        name: h.name,
        engines: [...h.engines],
        score: h.score,
        kind: h.kind,
    }));
    const shownCards: ShownCard[] = shownHits.map((h) => ({
        relFile: h.relFile,
        line: h.line,
        endLine: h.endLine,
        engines: [...h.engines],
        score: h.score,
        name: h.name,
        kind: h.kind,
    }));
    const metrics = computeInstanceMetrics({
        instance,
        formulation,
        shown,
        renderedText,
        elapsedMs,
        status,
    });
    return {
        ...metrics,
        renderedText,
        shownCards,
        routing,
    };
}
