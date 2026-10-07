/**
 * D65: D46 per-query judge details (no engine IO, no network).
 * The runner captures existsP / excerpt mode / bounded unit probabilities /
 * kept-dropped counts / threshold into each row's `judge` object so the D42
 * exists-threshold sweep can run off the report alone.
 */
import { describe, expect, it } from "vitest";
import {
    applyExistsEvidenceFlag,
    buildD46JudgeReport,
    D46_JUDGE_UNIT_CAP,
    parseD46RunArgs,
} from "../../../scripts/eval/d46/run.js";
import { GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR } from "../../../src/judge/grep-judge-stage.js";

function fakeJudgeDetails(n: number, existsP?: number) {
    return {
        backend: "cloud",
        model: "fake",
        judged: n,
        kept: 2,
        belowThreshold: n - 2,
        threshold: 0.4,
        cacheHits: 0,
        abstained: false,
        pointers: [],
        hits: Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, line: i + 1, endLine: i + 1, p: 0.9 - i * 0.01 })),
        unitMode: "anchor",
        unjudged: { count: 0, ids: [] },
        "unscored_beyond_cap": 0,
        ...(existsP === undefined ? {} : { existsP }),
        existsExcerptMode: true,
    };
}

const KEY_PATTERNS = [/api[_-]?key/i, /bearer/i, /secret/i, /\bsk-[A-Za-z0-9]/, /auth[_-]?store/i];

function assertNoKeyMaterial(value: unknown): void {
    const text = JSON.stringify(value);
    for (const re of KEY_PATTERNS) expect(text).not.toMatch(re);
}

describe("buildD46JudgeReport", () => {
    it("records existsP when the exists noul was consulted", () => {
        const report = buildD46JudgeReport(fakeJudgeDetails(3, 0.82), "t040");
        expect(report.judged).toBe(true);
        expect(report.existsP).toBe(0.82);
        expect(report.existsExcerptMode).toBe(true);
        expect(report.kept).toBe(2);
        expect(report.dropped).toBe(1);
        expect(report.judgedUnits).toBe(3);
        expect(report.threshold).toBe(0.4);
        expect(report.units).toHaveLength(3);
        expect(report.units[0]).toEqual({ path: "src/f0.ts", line: 1, p: 0.9 });
        expect(report.existsThreshold).toEqual(expect.any(Number));
        assertNoKeyMaterial(report);
    });

    it("records existsP null when the exists noul was not consulted", () => {
        const report = buildD46JudgeReport(fakeJudgeDetails(3), "t040");
        expect(report.judged).toBe(true);
        expect(report.existsP).toBeNull();
        assertNoKeyMaterial(report);
    });

    it("caps the unit probability list", () => {
        const report = buildD46JudgeReport(fakeJudgeDetails(D46_JUDGE_UNIT_CAP + 8, 0.5), "t040");
        expect(report.units).toHaveLength(D46_JUDGE_UNIT_CAP);
        assertNoKeyMaterial(report);
    });

    it("records {judged:false} with nulls when config=off, even with details present", () => {
        const report = buildD46JudgeReport(fakeJudgeDetails(3, 0.9), "off");
        expect(report).toEqual({
            judged: false,
            existsP: null,
            existsExcerptMode: null,
            threshold: null,
            existsThreshold: null,
            kept: null,
            dropped: null,
            judgedUnits: null,
            units: [],
        });
        assertNoKeyMaterial(report);
    });

    it("records {judged:false} when there are no judge details", () => {
        expect(buildD46JudgeReport(null, "t040").judged).toBe(false);
        expect(buildD46JudgeReport(undefined, "t040").existsP).toBeNull();
        expect(buildD46JudgeReport({ surprise: "not-a-judge" }, "t040").units).toEqual([]);
    });
});

describe("--exists-evidence CLI passthrough", () => {
    it("parses excerpts|count|off and rejects anything else", () => {
        expect(parseD46RunArgs(["--split", "dev", "--exists-evidence", "excerpts"]).existsEvidence).toBe("excerpts");
        expect(parseD46RunArgs(["--split", "dev", "--exists-evidence", "count"]).existsEvidence).toBe("count");
        expect(parseD46RunArgs(["--split", "dev", "--exists-evidence", "off"]).existsEvidence).toBe("off");
        expect(parseD46RunArgs(["--split", "dev"]).existsEvidence).toBeNull();
        expect(() => parseD46RunArgs(["--split", "dev", "--exists-evidence", "yes"])).toThrow();
    });

    it("forwards the flag to the env: excerpts sets, count/off clear, absent inherits", () => {
        const prev = process.env[GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR];
        try {
            expect(applyExistsEvidenceFlag("excerpts")).toBe(true);
            expect(process.env[GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR]).toBe("excerpts");
            applyExistsEvidenceFlag("count");
            expect(process.env[GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR]).toBeUndefined();
            process.env[GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR] = "excerpts";
            applyExistsEvidenceFlag("off");
            expect(process.env[GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR]).toBeUndefined();
            process.env[GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR] = "excerpts";
            expect(applyExistsEvidenceFlag(null)).toBe(true);
        } finally {
            if (prev === undefined) delete process.env[GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR];
            else process.env[GREP_JUDGE_EXISTS_EVIDENCE_ENV_VAR] = prev;
        }
    });
});
