/**
 * Unit tests for the TEB event extractor. No network; one test reads the
 * real trimmed runner log at `test/fixtures/eval/teb/sample-session.jsonl`
 * (a genuine `pi --mode json` session against egoist__tsup); the rest are
 * synthetic. Covers `{rt, event}` wrappers vs raw events, start/end
 * correlation by `toolCallId`, end-without-start, usage accounting, and
 * the `unavailable` classifier (strict-LSP envelope vs other-tool text).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    extractRun,
    extractRunFromText,
    isFailedCall,
    isLspFailedStatus,
    isUnavailableResult,
    parseRunnerLine,
    renderedResultText,
} from "../../../scripts/eval/teb/extract.js";

function start(id: string, toolName: string, args: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName, args });
}

function end(
    id: string,
    toolName: string,
    text: string,
    isError = false,
    details: Record<string, unknown> = {},
): string {
    return JSON.stringify({
        type: "tool_execution_end",
        toolCallId: id,
        toolName,
        result: { content: [{ type: "text", text }], details },
        isError,
    });
}

function assistantEnd(input: number, output: number, text = "answer"): string {
    return JSON.stringify({
        type: "message_end",
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            usage: {
                input,
                output,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: input + output,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
        },
    });
}

describe("parseRunnerLine", () => {
    it("accepts {rt, event} wrappers", () => {
        const record = parseRunnerLine(
            JSON.stringify({ rt: 123, event: { type: "tool_execution_start" } }),
        );
        expect(record?.rt).toBe(123);
        expect(record?.event["type"]).toBe("tool_execution_start");
    });

    it("accepts raw events with null rt", () => {
        const record = parseRunnerLine(JSON.stringify({ type: "turn_end" }));
        expect(record?.rt).toBeNull();
        expect(record?.event["type"]).toBe("turn_end");
    });

    it("returns null for blank lines and throws on malformed JSON", () => {
        expect(parseRunnerLine("   ")).toBeNull();
        expect(() => parseRunnerLine("{nope")).toThrow();
    });
});

describe("extractRun correlation", () => {
    it("correlates start/end by toolCallId and stamps usage", () => {
        const text = [
            assistantEnd(10, 5),
            start("a", "read", { path: "src/x.ts" }),
            assistantEnd(20, 5),
            end("a", "read", "file content here"),
            assistantEnd(30, 5),
        ].join("\n");
        const run = extractRunFromText(text);
        expect(run.calls).toHaveLength(1);
        expect(run.calls[0]!.toolName).toBe("read");
        expect(run.calls[0]!.ended).toBe(true);
        expect(run.calls[0]!.isError).toBe(false);
        expect(run.calls[0]!.renderedText).toBe("file content here");
        // Only the two message_ends before the tool end count.
        expect(run.calls[0]!.tokensBefore).toBe(15 + 25);
        expect(run.usage.totalTokens).toBe(15 + 25 + 35);
        expect(run.usage.messageCount).toBe(3);
        expect(run.malformedLines).toBe(0);
    });

    it("keeps unended calls and synthesizes end-without-start", () => {
        const text = [start("a", "grep", { pattern: "x" }), end("orphan", "LSP", "{}", false)].join(
            "\n",
        );
        const run = extractRunFromText(text);
        expect(run.calls).toHaveLength(2);
        expect(run.calls[0]!.ended).toBe(false);
        expect(run.calls[1]!.toolCallId).toBe("orphan");
        expect(run.calls[1]!.ended).toBe(true);
    });

    it("counts malformed lines without throwing", () => {
        const run = extractRunFromText(`${start("a", "read")}\n{bad json}\n`);
        expect(run.calls).toHaveLength(1);
        expect(run.malformedLines).toBe(1);
    });

    it("records rt origin and per-call receipt times", () => {
        const run = extractRun([
            { rt: 1000, event: { type: "turn_start" } },
            {
                rt: 1100,
                event: { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} },
            },
            {
                rt: 1500,
                event: {
                    type: "tool_execution_end",
                    toolCallId: "a",
                    toolName: "read",
                    result: { content: [], details: {} },
                    isError: false,
                },
            },
        ]);
        expect(run.startRt).toBe(1000);
        expect(run.calls[0]!.startRt).toBe(1100);
        expect(run.calls[0]!.endRt).toBe(1500);
    });
});

describe("isUnavailableResult", () => {
    it("classifies strict-LSP unavailable envelopes, not other statuses", () => {
        const unavailable = { content: [], details: { envelope: { status: "unavailable" } } };
        const ok = { content: [], details: { envelope: { status: "ok" } } };
        expect(isUnavailableResult("LSP", unavailable)).toBe(true);
        expect(isUnavailableResult("LSP", ok)).toBe(false);
    });

    it("never classifies non-LSP text as unavailable (E10.4 envelope-only)", () => {
        // Regression: a read of source containing the word "unavailable"
        // (e.g. a "service unavailable fallback" comment) is an ordinary
        // result, not an unavailable one.
        expect(isUnavailableResult("read", { content: [{ type: "text", text: "server unavailable" }], details: {} })).toBe(false);
        expect(isUnavailableResult("read", { content: [{ type: "text", text: "service unavailable fallback" }], details: {} })).toBe(false);
        expect(isUnavailableResult("read", { content: [{ type: "text", text: "all good" }], details: {} })).toBe(false);
        expect(isUnavailableResult("grep", { content: [{ type: "text", text: "unavailable" }], details: {} })).toBe(false);
    });

    it("does not mark isError results unavailable", () => {
        const text = [
            start("a", "read"),
            end("a", "read", "server unavailable", true),
        ].join("\n");
        const run = extractRunFromText(text);
        expect(run.calls[0]!.isError).toBe(true);
        expect(run.calls[0]!.unavailable).toBe(false);
    });

    it("keeps an ordinary read with the word unavailable successful", () => {
        const text = [
            start("a", "read", { path: "src/x.ts" }),
            end("a", "read", "// service unavailable fallback"),
        ].join("\n");
        const run = extractRunFromText(text);
        expect(run.calls[0]!.unavailable).toBe(false);
        expect(run.calls[0]!.isError).toBe(false);
    });
});

describe("isLspFailedStatus / isFailedCall", () => {
    it.each([
        "error",
        "timeout",
        "not_ready",
        "unsupported",
        "cancelled",
        "ambiguous",
        "unknown",
    ] as const)(
        "treats LSP status %s as failed even with isError:false",
        (status) => {
            expect(isLspFailedStatus(status)).toBe(true);
            expect(
                isFailedCall({ isError: false, toolName: "LSP", envelopeStatus: status }),
            ).toBe(true);
        },
    );

    it("treats ok, empty, and unavailable envelopes as non-failed", () => {
        for (const status of ["ok", "empty", null] as const) {
            expect(isLspFailedStatus(status)).toBe(false);
            expect(
                isFailedCall({ isError: false, toolName: "LSP", envelopeStatus: status }),
            ).toBe(false);
        }
        // `unavailable` is counted separately from errors, never merged in.
        expect(
            isFailedCall({ isError: false, toolName: "LSP", envelopeStatus: "unavailable" }),
        ).toBe(false);
    });

    it("treats tool isError as failed for every tool", () => {
        expect(isFailedCall({ isError: true, toolName: "read", envelopeStatus: null })).toBe(true);
        expect(isFailedCall({ isError: true, toolName: "LSP", envelopeStatus: "ok" })).toBe(true);
        expect(isFailedCall({ isError: false, toolName: "read", envelopeStatus: null })).toBe(false);
    });

    it("extracts a non-throwing LSP error envelope as a failed call", () => {
        const text = [
            start("a", "LSP", { operation: "goToDefinition" }),
            end("a", "LSP", JSON.stringify({ status: "error" }), false, {
                envelope: { status: "error", result: null },
            }),
        ].join("\n");
        const run = extractRunFromText(text);
        expect(run.calls[0]!.isError).toBe(false);
        expect(run.calls[0]!.envelopeStatus).toBe("error");
        expect(isFailedCall(run.calls[0]!)).toBe(true);
    });
});

describe("renderedResultText", () => {
    it("joins text blocks and ignores non-text blocks", () => {
        expect(
            renderedResultText({
                content: [
                    { type: "text", text: "a" },
                    { type: "image", data: "x" },
                    { type: "text", text: "b" },
                ],
            }),
        ).toBe("a\nb");
        expect(renderedResultText(null)).toBe("");
    });
});

describe("real fixture session", () => {
    const fixture = new URL("../../fixtures/eval/teb/sample-session.jsonl", import.meta.url);

    it("parses the trimmed real log with real shapes", () => {
        const text = readFileSync(fixture, "utf8");
        const run = extractRunFromText(text);
        // One read + one LSP goToDefinition + one follow-up read.
        expect(run.calls).toHaveLength(3);
        const lsp = run.calls.filter((c) => c.toolName === "LSP");
        expect(lsp).toHaveLength(1);
        expect(lsp[0]!.ended).toBe(true);
        expect(lsp[0]!.isError).toBe(false);
        expect(lsp[0]!.unavailable).toBe(false);
        expect(lsp[0]!.envelopeStatus).toBe("ok");
        expect(lsp[0]!.lspResultJson).toContain("cli-main.ts");
        expect(run.usage.totalTokens).toBeGreaterThan(0);
        expect(run.usage.messageCount).toBeGreaterThan(0);
        expect(run.malformedLines).toBe(0);
        expect(run.assistantTexts.length).toBeGreaterThan(0);
    });
});
