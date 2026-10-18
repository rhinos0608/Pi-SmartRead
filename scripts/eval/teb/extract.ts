/**
 * TEB (Tool Ergonomics Bench) event extractor: parses runner JSONL event
 * logs into correlated tool calls plus usage accounting.
 *
 * Input: one JSON object per line, either a raw Pi `--mode json` event
 * (`docs/json.md`: `tool_execution_start` carries
 * `toolCallId/toolName/args`, `tool_execution_end` carries
 * `toolCallId/toolName/result/isError`, `message_end.message` carries the
 * completed assistant message with authoritative `usage`) or a runner
 * wrapper `{rt, event}` where `rt` is the runner-stamped wall-clock
 * receipt millisecond. Neither tool event carries a timestamp of its own.
 *
 * Pure functions, no dependencies beyond node builtins (mirrors the D46
 * schema/validator pattern).
 */

export interface TebRunnerRecord {
    /** Runner receipt time in ms, or null for raw events without a stamp. */
    rt: number | null;
    /** The Pi session event object. */
    event: Record<string, unknown>;
}

/**
 * Parses one log line into a runner record. Accepts `{rt, event}`
 * wrappers or raw events. Returns null for blank lines; throws on
 * malformed JSON so the caller can count and report it.
 */
export function parseRunnerLine(line: string): TebRunnerRecord | null {
    if (line.trim().length === 0) return null;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error("line is not a JSON object");
    const maybeWrapper = parsed as { rt?: unknown; event?: unknown };
    if (isRecord(maybeWrapper.event)) {
        const rt = maybeWrapper.rt;
        return {
            rt: typeof rt === "number" && Number.isFinite(rt) ? rt : null,
            event: maybeWrapper.event as Record<string, unknown>,
        };
    }
    return { rt: null, event: parsed as Record<string, unknown> };
}

export type TebEnvelopeStatus =
    | "ok"
    | "empty"
    | "unsupported"
    | "unavailable"
    | "not_ready"
    | "timeout"
    | "cancelled"
    | "error"
    | "ambiguous"
    | "unknown";

export interface TebToolCall {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    startRt: number | null;
    endRt: number | null;
    /** False when no matching `tool_execution_end` was observed. */
    ended: boolean;
    isError: boolean;
    /**
     * True for strict-LSP `details.envelope.status == "unavailable"` or,
     * for other tools, rendered text matching the unavailable pattern.
     * Counted separately from errors, never merged into either numerator.
     */
    unavailable: boolean;
    /** Strict-LSP envelope status when present, else null. */
    envelopeStatus: TebEnvelopeStatus | null;
    /** Concatenated `result.content[]` text blocks. */
    renderedText: string;
    /**
     * `JSON.stringify(details.envelope.result)` for strict-LSP results,
     * else null. Grep details carry counts, not match lists, so there is
     * no `details.items` or grep match list to read.
     */
    lspResultJson: string | null;
    /** Summed assistant `message_end` usage tokens observed before the end. */
    tokensBefore: number | null;
}

export interface TebUsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal: number;
    /** Completed assistant `message_end` records observed. */
    messageCount: number;
    /** Summed tool-nested usage (`details.judge.costUsd`, tool-result `usage`). */
    toolNestedCostTotal: number;
    toolNestedTokens: number;
}

export interface TebExtractedRun {
    calls: TebToolCall[];
    usage: TebUsageTotals;
    /** Assistant text blocks from completed `message_end` records, in order. */
    assistantTexts: string[];
    /** Log lines that failed to parse. */
    malformedLines: number;
    /** `rt` of the first stamped record, or null when nothing was stamped. */
    startRt: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function asText(value: unknown): string {
    if (typeof value !== "string") return "";
    return value;
}

/** Concatenates `content[]` text blocks of a tool result. */
export function renderedResultText(result: unknown): string {
    if (!isRecord(result)) return "";
    const content = result["content"];
    if (!Array.isArray(content)) return "";
    return content
        .filter((block) => isRecord(block) && block["type"] === "text")
        .map((block) => asText((block as Record<string, unknown>)["text"]))
        .join("\n");
}

function envelopeOf(result: unknown): Record<string, unknown> | null {
    if (!isRecord(result)) return null;
    const details = result["details"];
    if (!isRecord(details)) return null;
    const envelope = details["envelope"];
    return isRecord(envelope) ? envelope : null;
}

/**
 * Unavailable classifier (E10.4). `unavailable` is a strict-LSP envelope
 * status only (`details.envelope.status == "unavailable"` per
 * `src/lsp/lsp-strict-contract.ts`). Rendered text is never classified:
 * real corpora and SmartRead output use the word constantly (e.g. a
 * source comment "service unavailable fallback"), so text matching
 * misclassifies ordinary results and corrupts success, first-correct,
 * and post-error accounting.
 */
export function isUnavailableResult(toolName: string, result: unknown): boolean {
    if (toolName !== "LSP") return false;
    return envelopeOf(result)?.["status"] === "unavailable";
}

/**
 * Strict-LSP envelope statuses that count as failed calls (E11). Only
 * request-validation failures throw (tool error path); server-side
 * outcomes (`error`, `timeout`, `not_ready`, `unsupported`, `cancelled`,
 * `ambiguous`) arrive with `isError:false`, so without this they would
 * count as successes. `ok` and `empty` are successes; `unavailable` is
 * counted separately, never merged into either numerator. `unknown` is
 * fail-closed: an unrecognized status is a failure, not a success.
 */
const LSP_FAILED_STATUSES: ReadonlySet<string> = new Set([
    "error",
    "timeout",
    "not_ready",
    "unsupported",
    "cancelled",
    "ambiguous",
    "unknown",
]);

export function isLspFailedStatus(status: TebEnvelopeStatus | string | null): boolean {
    return status !== null && LSP_FAILED_STATUSES.has(status);
}

/** A call is failed when it errored or carries a failed LSP envelope status. */
export function isFailedCall(call: Pick<TebToolCall, "isError" | "toolName" | "envelopeStatus">): boolean {
    if (call.isError) return true;
    return call.toolName === "LSP" && isLspFailedStatus(call.envelopeStatus);
}

function envelopeStatusOf(toolName: string, result: unknown): TebEnvelopeStatus | null {
    if (toolName !== "LSP") return null;
    const status = envelopeOf(result)?.["status"];
    return typeof status === "string" ? (status as TebEnvelopeStatus) : null;
}

function usageNumbers(message: unknown): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    costTotal: number;
} | null {
    if (!isRecord(message)) return null;
    const usage = message["usage"];
    if (!isRecord(usage)) return null;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const cost = isRecord(usage["cost"]) ? num(usage["cost"]["total"]) : 0;
    return {
        input: num(usage["input"]),
        output: num(usage["output"]),
        cacheRead: num(usage["cacheRead"]),
        cacheWrite: num(usage["cacheWrite"]),
        totalTokens: num(usage["totalTokens"]),
        costTotal: cost,
    };
}

/**
 * Correlates `tool_execution_start/end` by `toolCallId`, stamps cumulative
 * assistant-message usage onto each ended call, and sums `message_end`
 * usage. Tool-result `usage` / `details.judge.costUsd` are summed
 * separately from model tokens, never merged.
 */
export function extractRun(records: TebRunnerRecord[]): TebExtractedRun {
    const calls = new Map<string, TebToolCall>();
    const order: string[] = [];
    const usage: TebUsageTotals = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        costTotal: 0,
        messageCount: 0,
        toolNestedCostTotal: 0,
        toolNestedTokens: 0,
    };
    const assistantTexts: string[] = [];
    let tokensSoFar = 0;
    let startRt: number | null = null;

    const noteRt = (rt: number | null): void => {
        if (rt !== null && startRt === null) startRt = rt;
    };

    for (const { rt, event } of records) {
        noteRt(rt);
        const type = event["type"];
        if (type === "tool_execution_start") {
            const toolCallId = event["toolCallId"];
            const toolName = event["toolName"];
            if (typeof toolCallId !== "string" || typeof toolName !== "string") continue;
            if (!calls.has(toolCallId)) order.push(toolCallId);
            calls.set(toolCallId, {
                toolCallId,
                toolName,
                args: isRecord(event["args"]) ? (event["args"] as Record<string, unknown>) : {},
                startRt: rt,
                endRt: null,
                ended: false,
                isError: false,
                unavailable: false,
                envelopeStatus: null,
                renderedText: "",
                lspResultJson: null,
                tokensBefore: null,
            });
        } else if (type === "tool_execution_end") {
            const toolCallId = event["toolCallId"];
            if (typeof toolCallId !== "string") continue;
            let call = calls.get(toolCallId);
            if (!call) {
                // End without a start (truncated log): synthesize the entry.
                call = {
                    toolCallId,
                    toolName: typeof event["toolName"] === "string" ? event["toolName"] : "unknown",
                    args: {},
                    startRt: null,
                    endRt: rt,
                    ended: false,
                    isError: false,
                    unavailable: false,
                    envelopeStatus: null,
                    renderedText: "",
                    lspResultJson: null,
                    tokensBefore: null,
                };
                calls.set(toolCallId, call);
                order.push(toolCallId);
            }
            const result = event["result"];
            const isError = event["isError"] === true;
            call.ended = true;
            call.endRt = rt;
            call.isError = isError;
            call.unavailable = !isError && isUnavailableResult(call.toolName, result);
            call.envelopeStatus = envelopeStatusOf(call.toolName, result);
            call.renderedText = renderedResultText(result);
            const envelope = call.toolName === "LSP" ? envelopeOf(result) : null;
            call.lspResultJson =
                envelope && "result" in envelope ? JSON.stringify(envelope["result"]) : null;
            call.tokensBefore = tokensSoFar;
            // Tool-nested usage stays separate from model usage.
            if (isRecord(result)) {
                const nested = isRecord(result["usage"])
                    ? numField(result["usage"] as Record<string, unknown>, "totalTokens")
                    : 0;
                usage.toolNestedTokens += nested;
                const details = result["details"];
                if (isRecord(details) && isRecord(details["judge"])) {
                    const c = details["judge"]["costUsd"];
                    if (typeof c === "number" && Number.isFinite(c)) usage.toolNestedCostTotal += c;
                }
            }
        } else if (type === "message_end") {
            const message = event["message"];
            if (!isRecord(message) || message["role"] !== "assistant") continue;
            const numbers = usageNumbers(message);
            if (numbers) {
                usage.input += numbers.input;
                usage.output += numbers.output;
                usage.cacheRead += numbers.cacheRead;
                usage.cacheWrite += numbers.cacheWrite;
                usage.totalTokens += numbers.totalTokens;
                usage.costTotal += numbers.costTotal;
                usage.messageCount += 1;
                tokensSoFar += numbers.totalTokens;
            }
            const content = message["content"];
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (isRecord(block) && block["type"] === "text") {
                        assistantTexts.push(asText(block["text"]));
                    }
                }
            }
        }
    }

    return {
        calls: order.map((id) => calls.get(id) as TebToolCall),
        usage,
        assistantTexts,
        malformedLines: 0,
        startRt,
    };
}

function numField(record: Record<string, unknown>, key: string): number {
    const v = record[key];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parses full JSONL text into an extracted run. Blank lines are skipped;
 * unparseable lines are counted in `malformedLines`, never thrown.
 */
export function extractRunFromText(text: string): TebExtractedRun {
    const records: TebRunnerRecord[] = [];
    let malformedLines = 0;
    for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
            const record = parseRunnerLine(line);
            if (record) records.push(record);
        } catch {
            malformedLines += 1;
        }
    }
    const run = extractRun(records);
    run.malformedLines = malformedLines;
    return run;
}
