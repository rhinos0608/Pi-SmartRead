/**
 * Unit tests for the inspect-cohort task schema and validator.
 * No network, no disk: all fixtures are inline. Covers valid/invalid
 * tasks per family, the runner-view projection (gold/sealed-universe
 * isolation), final-answer shapes (including the P5 evidence-chain range
 * contract and the conclusion tri-state), and structural completeness
 * tagging (direction only — NOT a semantic grade).
 */
import { describe, expect, it } from "vitest";
import {
    INSPECT_ANSWER_TYPES,
    INSPECT_FAMILIES,
    inspectAnswerShapeFor,
    parseInspectJsonl,
    tagCoverageSignal,
    toInspectRunnerView,
    validateInspectDoc,
    validateInspectFinalAnswer,
    validateInspectTask,
    type InspectTask,
} from "../../../scripts/eval/inspect-cohort/schema.js";

const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function baseTask(overrides: Partial<InspectTask> = {}): InspectTask {
    return {
        id: "insp-pilot-P2-001",
        split: "pilot",
        repo: "TanStack__query",
        commit: SHA40,
        subpath: "packages/query-core",
        family: "P2",
        prompt: "Which source files bring in the focus manager within packages/query-core?",
        scope: "",
        answerType: "relation-set",
        gold: {
            kind: "relation-set",
            relations: [
                {
                    from: "src/index.ts",
                    specifier: "./focusManager",
                    kind: "import",
                    line: 3,
                    witness: { path: "src/index.ts", line: 3 },
                    resolved: "src/focusManager.ts",
                },
            ],
            minRecall: 1,
            minPrecision: 0.5,
        },
        candidateUniverse: { id: "universe-p2-001", sha256: SHA256, count: 12 },
        decoys: ["decoy-string-import"],
        negativeControl: false,
        derivation: "import-scan v1 + manual review alice+bob",
        agreement: "agree",
        labelers: ["alice", "bob"],
        adjudication: "agree",
        snapshot: { head: SHA40, clean: true },
        ...overrides,
    };
}

function evidenceTask(overrides: Partial<InspectTask> = {}): InspectTask {
    return baseTask({
        id: "insp-pilot-P5-001",
        family: "P5",
        prompt: "What structural relations touch the sealed patch inside the store module?",
        answerType: "evidence-chain",
        gold: {
            kind: "evidence-chain",
            patch: { sha: SHA40, ranges: [{ path: "src/store.ts", start: 10, end: 20 }] },
            relations: [
                {
                    from: "src/store.ts",
                    specifier: "./types",
                    kind: "import",
                    line: 2,
                    witness: { path: "src/store.ts", line: 2 },
                    resolved: "src/types.ts",
                },
            ],
            minRecall: 1,
            minPrecision: 0.5,
        },
        ...overrides,
    });
}

describe("validateInspectTask structure", () => {
    it("accepts a valid positive task", () => {
        expect(validateInspectTask(baseTask())).toEqual([]);
    });

    it("accepts a valid evidence-chain task with 1-based inclusive ranges", () => {
        expect(validateInspectTask(evidenceTask())).toEqual([]);
    });

    it("rejects unknown top-level keys", () => {
        const errors = validateInspectTask({ ...baseTask(), inventedCount: 3 });
        expect(errors.some((e) => e.includes("unknown field"))).toBe(true);
    });

    it("rejects family/answerType mismatch", () => {
        const errors = validateInspectTask(baseTask({ answerType: "route-set" }));
        expect(errors.some((e) => e.includes("answerType"))).toBe(true);
    });

    it("rejects absolute and parent-traversal paths", () => {
        const task = baseTask();
        task.gold = {
            kind: "relation-set",
            relations: [
                {
                    from: "/abs/index.ts",
                    specifier: "./x",
                    kind: "import",
                    line: 1,
                    witness: { path: "src/index.ts", line: 1 },
                    resolved: "src/x.ts",
                },
            ],
            minRecall: 1,
            minPrecision: 0.5,
        };
        expect(validateInspectTask(task).some((e) => e.includes("scope-relative"))).toBe(true);
    });

    it("rejects non-integer lines and end<start ranges", () => {
        const badLine = baseTask();
        badLine.gold = {
            kind: "relation-set",
            relations: [
                {
                    from: "src/a.ts",
                    specifier: "./b",
                    kind: "import",
                    line: 1.5,
                    witness: { path: "src/a.ts", line: 1 },
                    resolved: "src/b.ts",
                },
            ],
            minRecall: 1,
            minPrecision: 0.5,
        };
        expect(validateInspectTask(badLine).some((e) => e.includes("1-based integer"))).toBe(true);

        const evGold = evidenceTask().gold;
        const badRange = evidenceTask();
        badRange.gold = {
            kind: "evidence-chain",
            patch: { sha: SHA40, ranges: [{ path: "src/store.ts", start: 20, end: 10 }] },
            relations: evGold.kind === "evidence-chain" ? evGold.relations : [],
            minRecall: 1,
            minPrecision: 0.5,
        };
        expect(validateInspectTask(badRange).some((e) => e.includes("end must be >= start"))).toBe(true);
    });

    it("rejects duplicate relation identities", () => {
        const task = baseTask();
        const gold = task.gold;
        if (gold.kind === "relation-set") gold.relations.push({ ...(gold.relations[0] as object) } as never);
        expect(validateInspectTask(task).some((e) => e.includes("duplicate relation"))).toBe(true);
    });

    it("rejects resolved/reason mismatches in both directions", () => {
        const missing = baseTask();
        missing.gold = {
            kind: "relation-set",
            relations: [
                {
                    from: "src/a.ts",
                    specifier: "dynamic-x",
                    kind: "import",
                    line: 4,
                    witness: { path: "src/a.ts", line: 4 },
                    resolved: null,
                } as never,
            ],
            minRecall: 1,
            minPrecision: 0.5,
        };
        expect(validateInspectTask(missing).some((e) => e.includes("REQUIRED iff resolved is null"))).toBe(true);

        const forbidden = baseTask();
        forbidden.gold = {
            kind: "relation-set",
            relations: [
                {
                    from: "src/a.ts",
                    specifier: "./b",
                    kind: "import",
                    line: 4,
                    witness: { path: "src/a.ts", line: 4 },
                    resolved: "src/b.ts",
                    unresolvedReason: "generated",
                } as never,
            ],
            minRecall: 1,
            minPrecision: 0.5,
        };
        expect(validateInspectTask(forbidden).some((e) => e.includes("MUST be absent"))).toBe(true);
    });

    it("requires claim omission exactly on cannot-establish", () => {
        const withClaim = baseTask({
            family: "P4",
            answerType: "conclusion",
            gold: {
                kind: "conclusion",
                verdict: "cannot-establish",
                claim: false,
                reason: "Only dynamic specifiers in scope; nothing checkable.",
                scope: "",
                path: [],
            },
        });
        expect(validateInspectTask(withClaim).some((e) => e.includes("MUST be omitted"))).toBe(true);

        const withoutClaim = baseTask({
            family: "P4",
            answerType: "conclusion",
            gold: {
                kind: "conclusion",
                verdict: "supported-true",
                reason: "Witnessed path through source relations.",
                scope: "",
                path: [{ from: "src/a.ts", to: "src/b.ts", kind: "import", witness: { path: "src/a.ts", line: 1 } }],
            },
        });
        expect(validateInspectTask(withoutClaim).some((e) => e.includes("must be true"))).toBe(true);
    });

    it("requires enumeratedFiles on supported-false", () => {
        const task = baseTask({
            family: "P4",
            answerType: "conclusion",
            gold: {
                kind: "conclusion",
                verdict: "supported-false",
                claim: false,
                reason: "Checked the full scope boundary; no path.",
                scope: "",
                path: [],
            },
        });
        expect(validateInspectTask(task).some((e) => e.includes("enumeratedFiles: required"))).toBe(true);
    });

    it("rejects positive tasks without decoys and dirty snapshots", () => {
        expect(validateInspectTask(baseTask({ decoys: [] })).some((e) => e.includes("decoy"))).toBe(true);
        expect(
            validateInspectTask(baseTask({ snapshot: { head: SHA40, clean: false } })).some((e) =>
                e.includes("must be true"),
            ),
        ).toBe(true);
    });

    it("rejects gold leaking into the prompt", () => {
        const task = baseTask({
            prompt: "Which files import ./focusManager? Hint: src/index.ts does.",
        });
        expect(validateInspectTask(task).some((e) => e.includes("leaks gold"))).toBe(true);
    });

    it("rejects sealed universe hash leaking into the prompt", () => {
        const task = baseTask({ prompt: `Enumerate universe ${SHA256} now.` });
        expect(validateInspectTask(task).some((e) => e.includes("leaks gold"))).toBe(true);
    });
});

describe("toInspectRunnerView projection", () => {
    it("exposes only the pure whitelist", () => {
        const view = toInspectRunnerView(baseTask());
        expect(Object.keys(view).sort()).toEqual(["answerShape", "id", "prompt"]);
        expect(JSON.stringify(view)).not.toContain(SHA256);
        expect(JSON.stringify(view)).not.toContain("universe-p2-001");
        expect(JSON.stringify(view)).not.toContain("focusManager");
    });

    it("covers every answer type with a shape", () => {
        for (const answerType of INSPECT_ANSWER_TYPES) {
            expect(inspectAnswerShapeFor(answerType).length).toBeGreaterThan(0);
        }
        expect(INSPECT_FAMILIES).toHaveLength(10);
    });
});

describe("validateInspectFinalAnswer shapes", () => {
    it("accepts a valid relation-set answer with matching coverage scope", () => {
        const errors = validateInspectFinalAnswer(
            "relation-set",
            {
                answer: [
                    {
                        from: "src/index.ts",
                        specifier: "./focusManager",
                        resolved: "src/focusManager.ts",
                        kind: "import",
                        line: 3,
                        witness: { path: "src/index.ts", line: 3 },
                    },
                ],
                coverage: { claim: "partial", scope: "", enumeratedFiles: ["src/index.ts"] },
            },
            { taskScope: "" },
        );
        expect(errors).toEqual([]);
    });

    it("rejects unknown top-level keys and non-matching coverage scope", () => {
        const errors = validateInspectFinalAnswer(
            "relation-set",
            {
                answer: [],
                coverage: { claim: "partial", scope: "elsewhere", enumeratedFiles: [] },
                inventedCount: 1,
            },
            { taskScope: "" },
        );
        expect(errors.some((e) => e.includes("unknown key"))).toBe(true);
        expect(errors.some((e) => e.includes("must match the task scope"))).toBe(true);
    });

    it("rejects unsorted coverage file lists", () => {
        const errors = validateInspectFinalAnswer("route-set", {
            answer: [],
            coverage: { claim: "partial", scope: "", enumeratedFiles: ["src/b.ts", "src/a.ts"] },
        });
        expect(errors.some((e) => e.includes("sorted"))).toBe(true);
    });

    it("validates evidence-chain ranges and rejects malformed ones", () => {
        const good = validateInspectFinalAnswer("evidence-chain", {
            answer: {
                ranges: [{ path: "src/store.ts", start: 10, end: 20 }],
                relations: [],
            },
            coverage: { claim: "exhaustive", scope: "", enumeratedFiles: ["src/store.ts"] },
        });
        expect(good).toEqual([]);

        const bad = validateInspectFinalAnswer("evidence-chain", {
            answer: {
                ranges: [{ path: "src/store.ts", start: 30, end: 10 }],
                relations: [],
            },
            coverage: { claim: "partial", scope: "", enumeratedFiles: [] },
        });
        expect(bad.some((e) => e.includes("end must be >= start"))).toBe(true);
    });

    it("grades cannot-establish without a claim field", () => {
        const good = validateInspectFinalAnswer("conclusion", {
            verdict: "cannot-establish",
            reason: "Scope holds only dynamic specifiers.",
            scope: "",
            path: [],
        });
        expect(good).toEqual([]);

        const bad = validateInspectFinalAnswer("conclusion", {
            verdict: "cannot-establish",
            claim: false,
            reason: "Scope holds only dynamic specifiers.",
            scope: "",
            path: [],
        });
        expect(bad.some((e) => e.includes("MUST be omitted"))).toBe(true);
    });

    it("rejects negative answers carrying coverage", () => {
        const errors = validateInspectFinalAnswer("location-set", {
            answer: [],
            coverage: { claim: "partial", scope: "", enumeratedFiles: [] },
        });
        expect(errors.length).toBeGreaterThan(0);
    });
});

describe("inspect review gaps RED", () => {
    it("accepts a contract-conforming N5 file answer", () => {
        expect(validateInspectFinalAnswer("file", { answer: { path: "src/a.ts" } })).toEqual([]);
    });

    it("rejects unknown keys inside the N5 file answer object", () => {
        const errors = validateInspectFinalAnswer("file", { answer: { path: "src/a.ts", invented: 1 } });
        expect(errors.some((e) => e.includes("unknown key"))).toBe(true);
    });

    it("rejects gold objects with variant-extra keys", () => {
        const task = baseTask();
        (task.gold as Record<string, unknown>)["invented"] = 1;
        expect(validateInspectTask(task).some((e) => e.includes("unknown key"))).toBe(true);
    });

    it("rejects relations whose witness does not equal from/line", () => {
        const task = baseTask();
        task.gold = {
            kind: "relation-set",
            relations: [
                {
                    from: "src/a.ts",
                    specifier: "./b",
                    kind: "import",
                    line: 4,
                    witness: { path: "src/other.ts", line: 9 },
                    resolved: "src/b.ts",
                },
            ],
            minRecall: 1,
            minPrecision: 0.5,
        };
        expect(validateInspectTask(task).some((e) => e.includes("witness"))).toBe(true);
    });

    it("rejects enumerated files outside the task scope", () => {
        const errors = validateInspectFinalAnswer(
            "relation-set",
            {
                answer: [],
                coverage: { claim: "partial", scope: "src/a", enumeratedFiles: ["src/b.ts"] },
            },
            { taskScope: "src/a" },
        );
        expect(errors.some((e) => e.includes("scope"))).toBe(true);
    });

    it("rejects unsorted supported-false enumeratedFiles", () => {
        const errors = validateInspectFinalAnswer("conclusion", {
            verdict: "supported-false",
            claim: false,
            reason: "Checked the full scope boundary; no path.",
            scope: "",
            path: [],
            enumeratedFiles: ["src/b.ts", "src/a.ts"],
        });
        expect(errors.some((e) => e.includes("sorted"))).toBe(true);
    });

    it("rejects duplicate final evidence-chain ranges", () => {
        const errors = validateInspectFinalAnswer("evidence-chain", {
            answer: {
                ranges: [
                    { path: "src/store.ts", start: 10, end: 20 },
                    { path: "src/store.ts", start: 10, end: 20 },
                ],
                relations: [],
            },
            coverage: {
                claim: "partial",
                scope: "",
                enumeratedFiles: ["src/store.ts"],
            },
        });
        expect(errors.some((e) => e.includes("duplicate range"))).toBe(true);
    });
});

describe("validateInspectDoc and parseInspectJsonl", () => {
    it("rejects duplicate ids and invalid JSONL", () => {
        const doc = [baseTask(), baseTask()];
        expect(validateInspectDoc(doc).errors.some((e) => e.includes("duplicate id"))).toBe(true);
        expect(validateInspectDoc({}).errors.length).toBeGreaterThan(0);
        expect(parseInspectJsonl("not json\n").errors.length).toBeGreaterThan(0);
        const line = JSON.stringify(baseTask());
        expect(parseInspectJsonl(`${line}\n`).errors).toEqual([]);
    });
});

describe("tagCoverageSignal direction", () => {
    it("tags high coverage as GOOD and false-complete as BAD without grading", () => {
        const full = tagCoverageSignal(
            { claim: "exhaustive", scope: "", enumeratedFiles: ["a", "b"] },
            2,
            true,
        );
        expect(full.coverageRatio).toBe(1);
        expect(full.falseCompleteFlag).toBe(false);

        const short = tagCoverageSignal(
            { claim: "exhaustive", scope: "", enumeratedFiles: ["a"] },
            2,
            true,
        );
        expect(short.coverageRatio).toBeLessThan(1);
        expect(short.falseCompleteFlag).toBe(true);
    });

    it("treats empty universes as unknown without independent confirmation", () => {
        const unconfirmed = tagCoverageSignal(
            { claim: "exhaustive", scope: "", enumeratedFiles: [] },
            0,
            false,
        );
        expect(unconfirmed.coverageRatio).toBeNull();
        expect(unconfirmed.falseCompleteFlag).toBe(true);

        const confirmed = tagCoverageSignal(
            { claim: "exhaustive", scope: "", enumeratedFiles: [] },
            0,
            true,
        );
        expect(confirmed.coverageRatio).toBe(1);
        expect(confirmed.falseCompleteFlag).toBe(false);
    });
});
