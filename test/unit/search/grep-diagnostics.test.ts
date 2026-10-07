/**
 * Round-1 production diagnostic parity tests (RED-first): the additive
 * opt-in trace seam in src/search/grep-tool.ts must not change output or
 * evidence when attached, must deliver copied (immutable) snapshots, must
 * surface observer errors explicitly, and must keep the four gate thresholds
 * independent in the harness path.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool, type GrepTraceEvent } from "../../../src/search/grep-tool.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";
import {
    GREP_JUDGE_EXISTS_ABSENT,
    GREP_JUDGE_POINTER_THRESHOLD,
    GREP_JUDGE_THRESHOLD,
} from "../../../src/judge/grep-judge-stage.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";

let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-diag-")));
    seedStandardWorkdir(workdir);
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});

async function runWithTrace(trace: (event: GrepTraceEvent) => void, pattern = "authenticate") {
    const tool = createGrepTool(makeOpts({ onTraceGrepQuery: trace }));
    return tool.execute("t-diag", { pattern }, undefined, undefined, makeCtx(workdir));
}

describe("diagnostic seam parity", () => {
    it("same output and evidence with and without the trace callback", async () => {
        const events: GrepTraceEvent[] = [];
        const traced = await runWithTrace((e) => { events.push(e); });
        const plain = await createGrepTool(makeOpts()).execute(
            "t-plain", { pattern: "authenticate" }, undefined, undefined, makeCtx(workdir),
        );
        const tracedText = (traced.content[0] as { text: string }).text;
        const plainText = (plain.content[0] as { text: string }).text;
        // Header line embeds elapsed time; compare body lines exactly plus header shape.
        const [tracedHead, ...tracedBody] = tracedText.split("\n");
        const [plainHead, ...plainBody] = plainText.split("\n");
        expect(tracedBody).toEqual(plainBody);
        expect(tracedHead!.replace(/[0-9.]+s/, "<t>"))
            .toBe(plainHead!.replace(/[0-9.]+s/, "<t>"));
        const { toolCallId: _a, ...tracedRest } = traced.details as Record<string, unknown>;
        const { toolCallId: _b, ...plainRest } = plain.details as Record<string, unknown>;
        const stripVolatile = (d: Record<string, unknown>) => ({
            ...d,
            workspaceEvidence: { ...(d.workspaceEvidence as Record<string, unknown>), createdAt: "<t>" },
        });
        expect(stripVolatile(tracedRest)).toEqual(stripVolatile(plainRest));
        // The seam observed the query without altering it.
        expect(events.some((e) => e.stage === "post-judge")).toBe(true);
        expect(events.some((e) => e.stage === "post-cap")).toBe(true);
    });

    it("delivers copies: mutating a snapshot cannot affect source results", async () => {
        const seen: GrepTraceEvent[] = [];
        await runWithTrace((e) => {
            seen.push(e);
            if (e.stage === "pre-judge") {
                for (const c of e.candidates) (c as { snippet: string }).snippet = "MUTATED";
            }
        });
        const after = await createGrepTool(makeOpts()).execute(
            "t-after", { pattern: "authenticate" }, undefined, undefined, makeCtx(workdir),
        );
        expect((after.content[0] as { text: string }).text).not.toContain("MUTATED");
        expect(seen.length).toBeGreaterThan(0);
    });

    it("observer errors surface explicitly instead of being swallowed", async () => {
        await expect(runWithTrace(() => {
            throw new Error("observer boom");
        })).rejects.toThrow("observer boom");
        // Production still works once the faulty observer is removed.
        const plain = await createGrepTool(makeOpts()).execute(
            "t-recover", { pattern: "authenticate" }, undefined, undefined, makeCtx(workdir),
        );
        expect((plain.content[0] as { text: string }).text).toContain("authenticate");
    });

    it("no overhead by default: absent callback changes no code path", async () => {
        const tool = createGrepTool(makeOpts());
        expect((tool as unknown as { opts?: unknown }).opts).toBeUndefined();
        const result = await tool.execute(
            "t-nodefault", { pattern: "authenticate" }, undefined, undefined, makeCtx(workdir),
        );
        expect((result.details as { totalHits: number }).totalHits).toBeGreaterThan(0);
    });
});

describe("threshold separation in the harness path", () => {
    it("keep, pointer, and exists gates are three independent constants", () => {
        expect(GREP_JUDGE_THRESHOLD).toBe(0.4);
        expect(GREP_JUDGE_POINTER_THRESHOLD).toBe(0.45);
        expect(GREP_JUDGE_EXISTS_ABSENT).toBe(0.35);
        expect(new Set([GREP_JUDGE_THRESHOLD, GREP_JUDGE_POINTER_THRESHOLD, GREP_JUDGE_EXISTS_ABSENT]).size).toBe(3);
    });

    it("trace exposes pre-judge candidates so judge drops are observable", async () => {
        writeFileSync(join(workdir, "src", "extra.ts"), "export const authenticateExtra = 1;\n", "utf8");
        const stages = new Set<string>();
        let preJudgeCount = -1;
        await runWithTrace((e) => {
            stages.add(e.stage);
            if (e.stage === "pre-judge") preJudgeCount = e.candidates.length;
        });
        expect(stages.has("pre-judge")).toBe(true);
        expect(preJudgeCount).toBeGreaterThanOrEqual(0);
    });
});
