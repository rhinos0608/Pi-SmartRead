/**
 * Unit tests for the TEB secondary metrics. Synthetic runs plus one case
 * replayed against the real trimmed fixture session. Covers the
 * family specialist matcher (§2 "counts as specialist use"), the
 * arg-echo exclusion in first-correct evidence, invalid-call and
 * post-error-success rates, negative-control overuse, and aggregation
 * (opportunity recall, specialist precision).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractRunFromText } from "../../../scripts/eval/teb/extract.js";
import {
    aggregateRunMetrics,
    containsLocation,
    containsToken,
    firstCorrectEvidence,
    goldNeedles,
    isSpecialistCall,
    isSpecialistCallForFamily,
    locationNeedleEchoed,
    lspResultLocations,
    matchesGoldLocation,
    scoreRunMetrics,
    stripEnrichmentFooter,
} from "../../../scripts/eval/teb/metrics.js";
import type { TebTask } from "../../../scripts/eval/teb/schema.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function definitionTask(overrides: Partial<TebTask> = {}): TebTask {
    return {
        id: "teb-pilot-definition-001",
        split: "pilot",
        repo: "egoist__tsup",
        commit: SHA,
        subpath: "src",
        family: "definition",
        prompt: "Where is symbol `build`, as spelled at src/cli-main.ts:154:13, defined?",
        useSite: { path: "src/cli-main.ts", line: 154, character: 13 },
        anchorKind: "use",
        scope: "",
        answerType: "single-location",
        gold: {
            kind: "single-location",
            location: { path: "src/index.ts", line: 167, character: 23 },
        },
        opportunity: {
            tools: ["LSP"],
            rationale: "Exact jump in one call.",
            calls: ["LSP {operation: goToDefinition, path, position}"],
        },
        negativeControl: false,
        derivation: "lsp-probe.py v1",
        agreement: "agree",
        labelers: ["alice", "bob"],
        adjudication: "agree",
        ...overrides,
    };
}

function negativeTask(): TebTask {
    return definitionTask({
        id: "teb-pilot-config-value-001",
        family: "config-value",
        answerType: "scalar",
        gold: { kind: "scalar", value: "8.5.1" },
        opportunity: { tools: [], rationale: "Solvable with first-line read." },
        negativeControl: true,
    });
}

function start(id: string, toolName: string, args: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName, args });
}

function end(
    id: string,
    toolName: string,
    text: string,
    opts: { isError?: boolean; envelopeResult?: unknown; envelopeStatus?: string } = {},
): string {
    const details =
        opts.envelopeResult !== undefined || opts.envelopeStatus !== undefined
            ? { envelope: { status: opts.envelopeStatus ?? "ok", result: opts.envelopeResult ?? null } }
            : {};
    return JSON.stringify({
        type: "tool_execution_end",
        toolCallId: id,
        toolName,
        result: { content: [{ type: "text", text }], details },
        isError: opts.isError ?? false,
    });
}

describe("isSpecialistCallForFamily", () => {
    it("matches LSP operations per family", () => {
        expect(
            isSpecialistCallForFamily("definition", "LSP", { operation: "goToDefinition" }),
        ).toBe(true);
        expect(isSpecialistCallForFamily("definition", "LSP", { operation: "hover" })).toBe(false);
        expect(
            isSpecialistCallForFamily("callers", "LSP", { operation: "incomingCalls" }),
        ).toBe(true);
        expect(
            isSpecialistCallForFamily("callers", "LSP", { operation: "goToDefinition" }),
        ).toBe(false);
        expect(isSpecialistCallForFamily("type-of-symbol", "LSP", { operation: "hover" })).toBe(
            true,
        );
    });

    it("matches structural families with real tool contracts (E13.5)", () => {
        // No exhaustive inspect importer view exists: inspect never
        // counts for direct-importers, not even file mode.
        expect(
            isSpecialistCallForFamily("direct-importers", "inspect", {
                mode: "file",
                path: "src/x.ts",
            }),
        ).toBe(false);
        expect(
            isSpecialistCallForFamily("direct-importers", "inspect", {
                mode: "file",
                path: "src/x.ts",
                analysis: { dependents: true },
            }),
        ).toBe(false);
        expect(
            isSpecialistCallForFamily("direct-importers", "grep", {
                pattern: "./module",
                structural: { language: "typescript" },
            }),
        ).toBe(true);
        expect(isSpecialistCallForFamily("direct-importers", "grep", { pattern: "x" })).toBe(
            false,
        );
        expect(
            isSpecialistCallForFamily("direct-importers", "LSP", { operation: "findReferences" }),
        ).toBe(true);
        expect(
            isSpecialistCallForFamily("direct-importers", "LSP", { operation: "hover" }),
        ).toBe(false);
        expect(
            isSpecialistCallForFamily("package-exports", "inspect", {
                mode: "directory",
                path: "pkg",
            }),
        ).toBe(true);
        expect(
            isSpecialistCallForFamily("package-exports", "inspect", {
                mode: "file",
                path: "pkg/x.ts",
            }),
        ).toBe(false);
        expect(
            isSpecialistCallForFamily("http-routes", "inspect", {
                mode: "file",
                path: "src/app.ts",
                analysis: { routes: true },
            }),
        ).toBe(true);
        expect(isSpecialistCallForFamily("http-routes", "grep", { pattern: "app.get" })).toBe(
            true,
        );
    });

    it("never fires on negative-control families", () => {
        for (const family of ["literal-location", "file-by-name", "config-value"] as const) {
            expect(isSpecialistCallForFamily(family, "LSP", { operation: "hover" })).toBe(false);
            expect(isSpecialistCallForFamily(family, "inspect", { mode: "file" })).toBe(false);
            expect(isSpecialistCallForFamily(family, "grep", { pattern: "x" })).toBe(false);
        }
    });

    it("isSpecialistCall is the union over families", () => {
        expect(isSpecialistCall("LSP", { operation: "goToDefinition" })).toBe(true);
        expect(isSpecialistCall("grep", { pattern: "literal string" })).toBe(false);
        expect(isSpecialistCall("bash", { command: "rg x" })).toBe(false);
    });
});

describe("firstCorrectEvidence", () => {
    it("finds the first successful result containing gold, skipping echo", () => {
        const task = definitionTask();
        const text = [
            // Echoes the prompt's own path back: must not count.
            start("a", "read", { path: "src/index.ts" }),
            end("a", "read", "confirming path src/index.ts was queried"),
            start("b", "LSP", {
                operation: "goToDefinition",
                path: "src/cli-main.ts",
                position: { line: 153, character: 13 },
            }),
            end("b", "LSP", "definition result", {
                envelopeResult: [
                    {
                        uri: "file:///repo/src/index.ts",
                        range: { start: { line: 166, character: 1 }, end: { line: 166, character: 6 } },
                    },
                ],
            }),
        ].join("\n");
        const run = extractRunFromText(text);
        const first = firstCorrectEvidence(run, task);
        expect(first?.toolCallId).toBe("b");
        expect(first?.callsTo).toBe(2);
    });

    it("matches same-file LSP jumps structurally on uri + 0-based line", () => {
        // Real fixture shape: goToDefinition on src/cli-main.ts answers in
        // the same file at 0-based line 103 (= 1-based 104). The old
        // substring needles could never hit: the path is echoed in args.
        const task = definitionTask({
            gold: {
                kind: "single-location",
                location: { path: "src/cli-main.ts", line: 104, character: 15 },
            },
        });
        const text = [
            start("b", "LSP", {
                operation: "goToDefinition",
                path: "src/cli-main.ts",
                position: { line: 153, character: 13 },
            }),
            end("b", "LSP", "definition result", {
                envelopeResult: [
                    {
                        uri: "file:///repo/src/cli-main.ts",
                        range: { start: { line: 103, character: 14 }, end: { line: 103, character: 19 } },
                    },
                ],
            }),
        ].join("\n");
        const first = firstCorrectEvidence(extractRunFromText(text), task);
        expect(first?.toolCallId).toBe("b");
    });

    it("rejects right-file wrong-line LSP results", () => {
        // Gold line 999, result points at src/index.ts line 6: the path
        // alone must not count.
        const task = definitionTask({
            gold: {
                kind: "single-location",
                location: { path: "src/index.ts", line: 999, character: 1 },
            },
        });
        const text = [
            start("b", "LSP", {
                operation: "goToDefinition",
                path: "src/cli-main.ts",
                position: { line: 153, character: 13 },
            }),
            end("b", "LSP", "definition result", {
                envelopeResult: [
                    {
                        uri: "file:///repo/src/index.ts",
                        range: { start: { line: 5, character: 0 }, end: { line: 5, character: 9 } },
                    },
                ],
            }),
        ].join("\n");
        expect(firstCorrectEvidence(extractRunFromText(text), task)).toBeNull();
    });

    it("strips the read enrichment footer before matching", () => {
        // The footer names nearby files (here src/index.ts); a read of
        // cli-main.ts lines 145-164 never shows the src/index.ts:167
        // definition, so with the task gold it must not count.
        const task = definitionTask();
        const body = [
            "145|        const loader = ensureArray(flags.loader)",
            "154|      await build(options)",
            "---",
            "\ud83d\udd0d Context for src/cli-main.ts:",
            "\u2022 Nearby: src/index.ts \u2014 import",
        ].join("\n");
        const text = [
            start("a", "read", { path: "src/cli-main.ts", offset: 145, limit: 20 }),
            end("a", "read", body),
        ].join("\n");
        expect(firstCorrectEvidence(extractRunFromText(text), task)).toBeNull();
    });

    it("excludes a location needle only when path and line are both echoed", () => {
        const task = definitionTask();
        const echoed = [
            start("a", "grep", { pattern: "src/index.ts:167" }),
            end("a", "grep", "src/index.ts:167: export function build"),
        ].join("\n");
        expect(firstCorrectEvidence(extractRunFromText(echoed), task)).toBeNull();
    });

    it("excludes needles already present in the call's own arguments", () => {
        const task = definitionTask();
        const text = [
            start("a", "grep", { pattern: "src/index.ts" }),
            end("a", "grep", "match in src/index.ts at line 1"),
        ].join("\n");
        const run = extractRunFromText(text);
        expect(firstCorrectEvidence(run, task)).toBeNull();
    });

    it("skips error and unavailable results", () => {
        const task = definitionTask();
        const text = [
            start("a", "LSP", { operation: "goToDefinition" }),
            end("a", "LSP", "boom", { isError: true }),
            start("b", "LSP", { operation: "goToDefinition" }),
            end("b", "LSP", "no server", { envelopeStatus: "unavailable" }),
        ].join("\n");
        const run = extractRunFromText(text);
        expect(firstCorrectEvidence(run, task)).toBeNull();
        expect(goldNeedles(task).length).toBeGreaterThan(0);
    });
});

describe("scoreRunMetrics", () => {
    it("computes invalid rate, recall, and post-error success", () => {
        const task = definitionTask();
        const text = [
            start("a", "LSP", { operation: "goToDefinition" }),
            end("a", "LSP", "boom", { isError: true }),
            start("b", "read", { path: "src/index.ts" }),
            end("b", "read", "export function build at src/index.ts:167"),
        ].join("\n");
        const metrics = scoreRunMetrics(task, extractRunFromText(text));
        expect(metrics.toolCalls).toBe(2);
        expect(metrics.errors).toBe(1);
        expect(metrics.invalidCallRate).toBe(0.5);
        expect(metrics.opportunityRecall).toBe(true);
        expect(metrics.postErrorSuccess).toBe(true);
        expect(metrics.firstCorrect?.toolCallId).toBe("b");
    });

    it("reports null post-error success with no errors, null recall on negatives", () => {
        const metrics = scoreRunMetrics(negativeTask(), extractRunFromText(""));
        expect(metrics.postErrorSuccess).toBeNull();
        expect(metrics.opportunityRecall).toBeNull();
        expect(metrics.negativeOveruse).toBe(false);
        expect(metrics.invalidCallRate).toBe(0);
    });

    it("flags negative-control specialist overuse", () => {
        const task = negativeTask();
        const text = [start("a", "LSP", { operation: "hover" }), end("a", "LSP", "t")].join("\n");
        const metrics = scoreRunMetrics(task, extractRunFromText(text));
        expect(metrics.negativeOveruse).toBe(true);
    });

    it("counts a non-throwing LSP failure envelope as an error, not a success", () => {
        const task = definitionTask();
        const text = [
            start("a", "LSP", { operation: "goToDefinition" }),
            end("a", "LSP", "timeout", { envelopeStatus: "timeout" }),
            start("b", "read", { path: "src/index.ts" }),
            end("b", "read", "export function build at src/index.ts:167"),
        ].join("\n");
        const run = extractRunFromText(text);
        const metrics = scoreRunMetrics(task, run);
        expect(metrics.errors).toBe(1);
        expect(metrics.invalidCallRate).toBe(0.5);
        // Recovery counts the later successful read; the failed LSP call is
        // not eligible as the recovery itself.
        expect(metrics.postErrorSuccess).toBe(true);
        expect(firstCorrectEvidence(run, task)?.toolCallId).toBe("b");
    });

    it("never lets a failed LSP envelope satisfy first-correct", () => {
        const task = definitionTask();
        const text = [
            start("a", "LSP", { operation: "goToDefinition" }),
            end("a", "LSP", "src/index.ts:167", { envelopeStatus: "error" }),
        ].join("\n");
        const run = extractRunFromText(text);
        expect(firstCorrectEvidence(run, task)).toBeNull();
        expect(scoreRunMetrics(task, run).errors).toBe(1);
    });

    it("matches scalar gold as an exact token, not a substring", () => {
        const task = definitionTask({
            id: "teb-pilot-config-value-001",
            family: "config-value",
            answerType: "scalar",
            gold: { kind: "scalar", value: "3" },
            opportunity: { tools: [], rationale: "Solvable with first-line read." },
        });
        const miss = [
            start("a", "read", { path: "src/x.ts" }),
            end("a", "read", "the value 30 appears here"),
        ].join("\n");
        // Bare-substring matching would credit "30" for gold "3".
        expect(firstCorrectEvidence(extractRunFromText(miss), task)).toBeNull();
        const hit = [
            start("a", "read", { path: "src/x.ts" }),
            end("a", "read", "the value is 3 here"),
        ].join("\n");
        expect(firstCorrectEvidence(extractRunFromText(hit), task)?.toolCallId).toBe("a");
    });
});

describe("aggregateRunMetrics", () => {
    it("aggregates recall and precision across runs", () => {
        const def = definitionTask();
        const neg = negativeTask();
        const withSpecialist = extractRunFromText(
            [start("a", "LSP", { operation: "goToDefinition" }), end("a", "LSP", "t")].join("\n"),
        );
        const plain = extractRunFromText(
            [start("a", "read", { path: "x" }), end("a", "read", "t")].join("\n"),
        );
        const scored = [
            { task: def, run: withSpecialist, metrics: scoreRunMetrics(def, withSpecialist) },
            { task: def, run: plain, metrics: scoreRunMetrics(def, plain) },
            { task: neg, run: plain, metrics: scoreRunMetrics(neg, plain) },
        ];
        const agg = aggregateRunMetrics(scored);
        expect(agg.runs).toBe(3);
        expect(agg.opportunityRecall).toBe(0.5);
        // One specialist call (LSP on a definition task listing LSP): precision 1.
        expect(agg.specialistPrecision).toBe(1);
        expect(agg.negativeOveruse).toBe(0);
        // No run shows gold evidence, so every first-correct mean is null
        // and the success fraction is 0 (survivor-bias guard).
        expect(agg.firstCorrectSuccessRate).toBe(0);
        expect(agg.meanCallsToFirstCorrect).toBeNull();
    });

    it("reports the success fraction alongside survivor-only means", () => {
        const def = definitionTask();
        const goldText = [
            start("a", "read", { path: "src/other.ts" }),
            end("a", "read", "see src/index.ts:167 for the definition"),
        ].join("\n");
        const goldRun = extractRunFromText(goldText);
        const noCallRun = extractRunFromText("");
        const scored = [
            { task: def, run: noCallRun, metrics: scoreRunMetrics(def, noCallRun) },
            { task: def, run: goldRun, metrics: scoreRunMetrics(def, goldRun) },
        ];
        const agg = aggregateRunMetrics(scored);
        expect(agg.firstCorrectSuccessRate).toBe(0.5);
        expect(agg.meanCallsToFirstCorrect).toBe(1);
    });
});

describe("evidence-matching helpers", () => {
    it("strips the enrichment footer, keeping the body", () => {
        const body = "154|      await build(options)";
        const text = `${body}\n---\n\ud83d\udd0d Context for src/cli-main.ts:\n\u2022 Nearby: src/index.ts \u2014 import`;
        expect(stripEnrichmentFooter(text)).toBe(body);
        expect(stripEnrichmentFooter(body)).toBe(body);
    });

    it("matches tokens with word boundaries, not substrings", () => {
        expect(containsToken("the value 30", "3", false)).toBe(false);
        expect(containsToken("the value is 3 here", "3", false)).toBe(true);
        expect(containsToken("rebuild the index", "build", true)).toBe(false);
        expect(containsToken("export function build(", "build", true)).toBe(true);
        expect(containsToken("/api/users/123", "/api/users", true)).toBe(true);
        expect(containsToken("/api/users-list", "/api/users", true)).toBe(true);
    });

    it("parses structural locations from real envelope result shapes", () => {
        const json = JSON.stringify([
            {
                uri: "file:///repo/src/cli-main.ts",
                range: { start: { line: 103, character: 14 }, end: { line: 103, character: 19 } },
            },
        ]);
        const locations = lspResultLocations(json);
        expect(locations).toHaveLength(1);
        expect(
            matchesGoldLocation(locations, { path: "src/cli-main.ts", line: 104 }),
        ).toBe(true);
        expect(
            matchesGoldLocation(locations, { path: "src/cli-main.ts", line: 999 }),
        ).toBe(false);
        expect(
            matchesGoldLocation(locations, { path: "src/other.ts", line: 104 }),
        ).toBe(false);
        expect(matchesGoldLocation(locations, { path: "src/cli-main.ts", line: null })).toBe(true);
        expect(lspResultLocations("not json")).toEqual([]);
        expect(lspResultLocations(null)).toEqual([]);
    });
});

describe("real fixture session", () => {
    it("shows opportunity recall via the real LSP call but no gold hit", () => {
        const text = readFileSync(
            new URL("../../fixtures/eval/teb/sample-session.jsonl", import.meta.url),
            "utf8",
        );
        const run = extractRunFromText(text);
        // The fixture prompt asked for the local binding at cli-main.ts:104,
        // while this synthetic gold points at src/index.ts:167, so recall
        // fires (real goToDefinition) but first-correct stays null.
        const task = definitionTask();
        const metrics = scoreRunMetrics(task, run);
        expect(metrics.opportunityRecall).toBe(true);
        expect(metrics.errors).toBe(0);
        expect(metrics.unavailable).toBe(0);
        expect(metrics.totalTokens).toBeGreaterThan(0);
    });

    it("matches same-file evidence structurally on the real LSP result", () => {
        // The fixture prompt asked for the local binding answered in-file
        // at 0-based line 103 (= 1-based 104): with that gold, the real
        // goToDefinition result is first-correct at the LSP call even
        // though the path is echoed in the call's own args.
        const text = readFileSync(
            new URL("../../fixtures/eval/teb/sample-session.jsonl", import.meta.url),
            "utf8",
        );
        const run = extractRunFromText(text);
        const task = definitionTask({
            gold: {
                kind: "single-location",
                location: { path: "src/cli-main.ts", line: 104, character: 15 },
            },
        });
        const first = firstCorrectEvidence(run, task);
        expect(first?.toolName).toBe("LSP");
        expect(first?.callIndex).toBe(2);
    });
});

describe("E13.4 first-correct evidence rules", () => {
    function callerTask(): TebTask {
        return definitionTask({
            id: "teb-pilot-callers-001",
            family: "callers",
            anchorKind: "definition",
            answerType: "caller-set",
            gold: {
                kind: "caller-set",
                callers: [{ name: "startServer", path: "src/server.ts", line: 12 }],
                minRecall: 1,
                minPrecision: 0.5,
            },
        });
    }

    function routeTask(): TebTask {
        return definitionTask({
            id: "teb-pilot-http-routes-001",
            family: "http-routes",
            answerType: "route-set",
            gold: {
                kind: "route-set",
                routes: [{ method: "GET", path: "/health", file: "src/server.ts", line: 12 }],
                minRecall: 1,
                minPrecision: 0.5,
            },
        });
    }

    function textRun(
        toolName: string,
        text: string,
        args: Record<string, unknown> = {},
        opts: { isError?: boolean; envelopeResult?: unknown; envelopeStatus?: string } = {},
    ): ReturnType<typeof extractRunFromText> {
        return extractRunFromText([start("a", toolName, args), end("a", toolName, text, opts)].join("\n"));
    }

    it("matches path:line with numeric boundaries", () => {
        expect(containsLocation("see src/index.ts:10 below", "src/index.ts", 10)).toBe(true);
        expect(containsLocation("see src/index.ts:100 below", "src/index.ts", 10)).toBe(false);
        expect(containsLocation("src/index.ts:10,", "src/index.ts", 10)).toBe(true);
        expect(containsLocation("src/index.ts:1", "src/index.ts", 10)).toBe(false);
    });

    it("does not count a bare caller name without path+line context", () => {
        const task = callerTask();
        const nameOnly = textRun("grep", "caller startServer found in results");
        expect(firstCorrectEvidence(nameOnly, task)).toBeNull();
        const withContext = textRun("grep", "startServer defined at src/server.ts:12");
        expect(firstCorrectEvidence(withContext, task)?.callsTo).toBe(1);
    });

    it("does not count a bare route path without file+line context", () => {
        const task = routeTask();
        // `/health` alone — even with longer lookalikes — is not evidence.
        const pathOnly = textRun("grep", "routes: /health, /health/ready and /health-check");
        expect(firstCorrectEvidence(pathOnly, task)).toBeNull();
        const withContext = textRun("grep", "GET /health registered in src/server.ts:12");
        expect(firstCorrectEvidence(withContext, task)?.callsTo).toBe(1);
    });

    it("counts only LSP ok results, never empty or envelope-less ones", () => {
        const task = definitionTask();
        const text = "defined at src/index.ts:167";
        expect(
            firstCorrectEvidence(textRun("LSP", text, {}, { envelopeStatus: "ok" }), task)?.callsTo,
        ).toBe(1);
        expect(firstCorrectEvidence(textRun("LSP", text, {}, { envelopeStatus: "empty" }), task)).toBeNull();
        expect(firstCorrectEvidence(textRun("LSP", text), task)).toBeNull();
    });

    it("compares echoed lines with numeric boundaries", () => {
        const task = definitionTask();
        const needle = goldNeedles(task)[0]!;
        expect(locationNeedleEchoed("src/index.ts:167", needle)).toBe(true);
        // Echoed line 1670 is not an echo of line 167.
        expect(locationNeedleEchoed('{"path": "src/index.ts:1670"}', needle)).toBe(false);
        expect(locationNeedleEchoed('{"pattern": "other"}', needle)).toBe(false);
    });
});
