/**
 * Unit tests for the TEB task schema and validator. No network, no disk:
 * all fixtures are inline. Covers valid/invalid tasks, the runner-view
 * projection (gold/opportunity/grading must never leak), final-answer
 * shapes, and the frozen family table.
 */
import { describe, expect, it } from "vitest";
import {
    FAMILY_TABLE,
    TEB_ANSWER_TYPES,
    TEB_FAMILIES,
    answerShapeFor,
    parseTebJsonl,
    toRunnerView,
    validateFinalAnswer,
    validateTebDoc,
    validateTebTask,
    type TebTask,
} from "../../../scripts/eval/teb/schema.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function definitionTask(overrides: Partial<TebTask> = {}): TebTask {
    return {
        id: "teb-pilot-definition-001",
        split: "pilot",
        repo: "TanStack__query",
        commit: SHA,
        subpath: "packages/query-core",
        family: "definition",
        prompt:
            "Where is symbol `QueryClient`, as spelled at " +
            "packages/query-core/src/queryCache.ts:106:13, defined?",
        useSite: { path: "src/queryCache.ts", line: 106, character: 13 },
        anchorKind: "use",
        scope: "",
        answerType: "single-location",
        gold: {
            kind: "single-location",
            location: { path: "src/queryClient.ts", line: 61, character: 14 },
        },
        opportunity: {
            tools: ["LSP"],
            rationale: "Exact jump through the workspace alias in one call.",
            calls: ["LSP {operation: goToDefinition, path, position}"],
        },
        negativeControl: false,
        derivation: "lsp-probe.py v1 + ts.getDefinitionAtPosition on TS 5.9.2",
        agreement: "agree",
        labelers: ["alice", "bob"],
        adjudication: "agree",
        ...overrides,
    };
}

function negativeTask(overrides: Partial<TebTask> = {}): TebTask {
    return {
        id: "teb-pilot-config-value-001",
        split: "pilot",
        repo: "egoist__tsup",
        commit: SHA,
        subpath: ".",
        family: "config-value",
        prompt: "What value does key `target` have in `tsup.config.ts`?",
        scope: "",
        answerType: "scalar",
        gold: { kind: "scalar", value: "es2022" },
        opportunity: {
            tools: [],
            rationale: "Solvable with first-line retrieval; specialist use is over-routing.",
        },
        negativeControl: true,
        derivation: "rg 'target' tsup.config.ts, labels alice+bob",
        agreement: "agree",
        labelers: ["alice", "bob"],
        adjudication: "agree",
        ...overrides,
    };
}

describe("validateTebTask structure", () => {
    it("accepts a valid semantic task", () => {
        expect(validateTebTask(definitionTask())).toEqual([]);
    });

    it("accepts a valid negative-control task without useSite", () => {
        expect(validateTebTask(negativeTask())).toEqual([]);
    });
    describe("prompt gold-leakage guard (fail closed)", () => {
        it("rejects a prompt embedding the gold definition path", () => {
            const errors = validateTebTask(
                definitionTask({ prompt: "Where is QueryClient defined? See src/queryClient.ts for the answer." }),
            );
            expect(errors.some((e) => e.includes("leaks gold"))).toBe(true);
        });
        it("rejects a prompt embedding the gold path:line", () => {
            const errors = validateTebTask(
                definitionTask({ prompt: "Look at src/queryClient.ts:61 for where QueryClient is defined." }),
            );
            expect(errors.some((e) => e.includes("leaks gold"))).toBe(true);
        });
        it("rejects a prompt embedding the gold scalar value", () => {
            const errors = validateTebTask(
                negativeTask({ prompt: "Is the value of key `target` in `tsup.config.ts` es2022?" }),
            );
            expect(errors.some((e) => e.includes("leaks gold"))).toBe(true);
        });
        it("rejects a prompt embedding a gold caller name", () => {
            const task = definitionTask({
                family: "callers",
                answerType: "caller-set",
                anchorKind: "definition",
                prompt: "Who calls QueryClient? Is resolveQueryCache one of them?",
                gold: {
                    kind: "caller-set",
                    callers: [{ name: "resolveQueryCache", path: "src/other.ts", line: 7 }],
                    minRecall: 1,
                    minPrecision: 1,
                },
            });
            expect(validateTebTask(task).some((e) => e.includes("leaks gold"))).toBe(true);
        });
        it("allows naming the useSite anchor even when it shares the gold file", () => {
            // useSite packages/query-core/src/queryCache.ts is stripped
            // before the gold check; the gold file here differs.
            expect(validateTebTask(definitionTask())).toEqual([]);
            const sameFile = definitionTask({
                prompt: "Where is `QueryClient`, as spelled at src/queryClient.ts:106:13, defined?",
                useSite: { path: "src/queryClient.ts", line: 106, character: 13 },
            });
            expect(validateTebTask(sameFile)).toEqual([]);
        });
    });

    it("rejects an unknown family", () => {
        const errors = validateTebTask(
            definitionTask({ family: "vibes" as TebTask["family"] }),
        );
        expect(errors.some((e) => e.includes("family"))).toBe(true);
    });

    it("rejects a bad split and a short commit sha", () => {
        const split = validateTebTask(definitionTask({ split: "prod" as TebTask["split"] }));
        expect(split.some((e) => e.includes("split"))).toBe(true);
        const sha = validateTebTask(definitionTask({ commit: "abc123" }));
        expect(sha.some((e) => e.includes("commit"))).toBe(true);
    });

    it("requires useSite on semantic families and forbids it elsewhere", () => {
        const { useSite: _dropped, anchorKind: _ak, ...rest } = definitionTask();
        const missing = validateTebTask({ ...rest, anchorKind: undefined });
        expect(missing.some((e) => e.includes("useSite"))).toBe(true);
        const misplaced = validateTebTask({
            ...negativeTask(),
            useSite: { path: "a.ts", line: 1, character: 1 },
            anchorKind: "use",
        });
        expect(misplaced.some((e) => e.includes("useSite"))).toBe(true);
    });

    it("requires anchorKind with useSite and definition anchors for callers", () => {
        const noAnchor = validateTebTask(
            definitionTask({ anchorKind: undefined }),
        );
        expect(noAnchor.some((e) => e.includes("anchorKind"))).toBe(true);
        const callerUse = validateTebTask(
            definitionTask({
                id: "teb-pilot-callers-001",
                family: "callers",
                anchorKind: "use",
                answerType: "caller-set",
                gold: {
                    kind: "caller-set",
                    callers: [{ name: "f", path: "src/a.ts", line: 3 }],
                    minRecall: 1,
                    minPrecision: 0.5,
                },
            }),
        );
        expect(callerUse.some((e) => e.includes("definition site"))).toBe(true);
        const callerDef = validateTebTask(
            definitionTask({
                id: "teb-pilot-callers-001",
                family: "callers",
                anchorKind: "definition",
                answerType: "caller-set",
                gold: {
                    kind: "caller-set",
                    callers: [{ name: "f", path: "src/a.ts", line: 3 }],
                    minRecall: 1,
                    minPrecision: 0.5,
                },
            }),
        );
        expect(callerDef).toEqual([]);
    });

    it("rejects answerType/gold mismatches and oversized location sets", () => {
        const mismatch = validateTebTask(
            definitionTask({
                answerType: "location-set",
                gold: {
                    kind: "location-set",
                    locations: [{ path: "src/a.ts", line: 1, character: 1 }],
                    minRecall: 1,
                    minPrecision: 0.5,
                },
            }),
        );
        expect(mismatch.some((e) => e.includes("answerType"))).toBe(true);
        const big = validateTebTask(
            definitionTask({
                family: "all-references",
                answerType: "location-set",
                gold: {
                    kind: "location-set",
                    locations: Array.from({ length: 41 }, (_, i) => ({
                        path: "src/a.ts",
                        line: i + 1,
                        character: 1,
                    })),
                    minRecall: 0.8,
                    minPrecision: 0.5,
                },
            }),
        );
        expect(big.some((e) => e.includes("40-reference"))).toBe(true);
    });

    it("enforces negative-control opportunity and flag placement", () => {
        const toolsOnNegative = validateTebTask({
            ...negativeTask(),
            opportunity: { tools: ["LSP"], rationale: "leak" },
        });
        expect(toolsOnNegative.some((e) => e.includes("opportunity.tools"))).toBe(true);
        const noToolsOnPositive = validateTebTask({
            ...definitionTask(),
            opportunity: { tools: [], rationale: "none" },
        });
        expect(noToolsOnPositive.some((e) => e.includes("opportunity.tools"))).toBe(true);
        const wrongNegativeFlag = validateTebTask({
            ...negativeTask(),
            negativeControl: false,
        });
        expect(wrongNegativeFlag.some((e) => e.includes("negativeControl"))).toBe(true);
        const caseOffScalar = validateTebTask({ ...definitionTask(), caseSensitive: true });
        expect(caseOffScalar.some((e) => e.includes("caseSensitive"))).toBe(true);
        const forgivenessOffPrettier = validateTebTask({ ...definitionTask(), extensionForgiveness: true });
        expect(forgivenessOffPrettier.some((e) => e.includes("extensionForgiveness"))).toBe(true);
    });

    it("requires derivation, two labelers, and adjudication notes on disagreement", () => {
        const noDerivation = validateTebTask({ ...definitionTask(), derivation: "" });
        expect(noDerivation.some((e) => e.includes("derivation"))).toBe(true);
        const sameLabeler = validateTebTask({ ...definitionTask(), labelers: ["alice", "alice"] });
        expect(sameLabeler.some((e) => e.includes("labelers"))).toBe(true);
        const silentDisagreement = validateTebTask({
            ...definitionTask(),
            agreement: "server-only",
            adjudication: "",
        });
        expect(silentDisagreement.some((e) => e.includes("adjudication"))).toBe(true);
    });

    it("accepts the protocol §3 top-level audit layout and rejects the legacy nested grading object", () => {
        expect(validateTebTask(definitionTask())).toEqual([]);
        const { derivation, agreement, labelers, adjudication, ...rest } = definitionTask() as unknown as Record<string, unknown>;
        void derivation;
        void agreement;
        void labelers;
        void adjudication;
        const legacy = validateTebTask({
            ...rest,
            grading: { derivation: "x", agreement: "agree", labelers: ["a", "b"], adjudication: "agree" },
        });
        expect(legacy.some((e) => e.includes("unknown field"))).toBe(true);
    });

    it("rejects empty scalar gold and set gold without explicit thresholds", () => {
        const emptyScalar = validateTebTask({
            ...negativeTask(),
            gold: { kind: "scalar", value: "" },
        });
        expect(emptyScalar.some((e) => e.includes("gold.value"))).toBe(true);
        const noThresholds = validateTebTask({
            ...definitionTask(),
            family: "all-references",
            answerType: "location-set",
            gold: { kind: "location-set", locations: [{ path: "a.ts", line: 1, character: 1 }] },
        });
        expect(noThresholds.some((e) => e.includes("minRecall"))).toBe(true);
    });

    it("rejects unknown top-level fields and non-object tasks", () => {
        const extra = validateTebTask({ ...definitionTask(), goldPaths: [] });
        expect(extra.some((e) => e.includes("unknown field"))).toBe(true);
        expect(validateTebTask(42)).toHaveLength(1);
    });
});

describe("validateTebDoc and parseTebJsonl", () => {
    it("accepts a two-task doc and rejects duplicates", () => {
        expect(validateTebDoc([definitionTask(), negativeTask()]).errors).toEqual([]);
        const dup = validateTebDoc([definitionTask(), definitionTask()]);
        expect(dup.errors.some((e) => e.includes("duplicate"))).toBe(true);
        expect(validateTebDoc({}).errors.length).toBeGreaterThan(0);
    });

    it("parses JSONL lines and reports bad lines", () => {
        const text = [JSON.stringify(definitionTask()), JSON.stringify(negativeTask())].join("\n");
        const ok = parseTebJsonl(`${text}\n`);
        expect(ok.errors).toEqual([]);
        expect(ok.tasks).toHaveLength(2);
        const bad = parseTebJsonl(`${text}\nnot json`);
        expect(bad.errors.some((e) => e.includes("invalid JSON"))).toBe(true);
    });
});

describe("toRunnerView projection", () => {
    it("exposes only id, prompt, and answer shape", () => {
        const view = toRunnerView(definitionTask());
        expect(Object.keys(view).sort()).toEqual(["answerShape", "id", "prompt"]);
        expect(view.answerShape).toBe(answerShapeFor("single-location"));
    });

    it("strips every gold, opportunity, and grading string", () => {
        for (const task of [definitionTask(), negativeTask()]) {
            const serialized = JSON.stringify(toRunnerView(task));
            const gold = task.gold;
            const hidden: string[] = [];
            if (gold.kind === "single-location") {
                hidden.push(gold.location.path, String(gold.location.line));
            } else if (gold.kind === "scalar") {
                hidden.push(gold.value);
            }
            hidden.push(
                ...task.opportunity.tools,
                task.opportunity.rationale,
                task.derivation,
                task.adjudication,
                ...task.labelers,
            );
            for (const secret of hidden) {
                expect(serialized.includes(secret)).toBe(false);
            }
        }
    });
});

describe("validateFinalAnswer shapes", () => {
    it("accepts each answerType's canonical shape", () => {
        expect(
            validateFinalAnswer("single-location", {
                answer: { path: "src/a.ts", line: 3, character: 5 },
            }),
        ).toEqual([]);
        expect(
            validateFinalAnswer("caller-set", {
                answer: [{ name: "f", path: "src/a.ts", line: 3 }],
            }),
        ).toEqual([]);
        expect(validateFinalAnswer("file-set", { answer: { files: ["src/a.ts"] } })).toEqual([]);
        expect(validateFinalAnswer("file", { answer: { path: "src/a.ts" } })).toEqual([]);
        expect(validateFinalAnswer("scalar", { answer: { value: "es2022" } })).toEqual([]);
        expect(validateFinalAnswer("type-string", { answer: { type: "string" } })).toEqual([]);
        expect(
            validateFinalAnswer("route-set", {
                answer: [{ method: "get", path: "/x", file: "src/r.ts", line: 9 }],
            }),
        ).toEqual([]);
    });

    it("rejects extra keys, wrong containers, and bad locations", () => {
        expect(
            validateFinalAnswer("file", { answer: { path: "a.ts" }, extra: 1 }),
        ).not.toEqual([]);
        expect(validateFinalAnswer("scalar", { answer: "es2022" })).not.toEqual([]);
        expect(
            validateFinalAnswer("single-location", { answer: { path: "a.ts", line: 0 } }),
        ).not.toEqual([]);
        expect(validateFinalAnswer("single-location", {})).not.toEqual([]);
    });

    it("rejects extra keys inside answer entries per the §4 no-extra-keys contract", () => {
        expect(
            validateFinalAnswer("single-location", {
                answer: { path: "src/a.ts", line: 3, character: 5, column: 5 },
            }).some((e) => e.includes("unknown key")),
        ).toBe(true);
        expect(
            validateFinalAnswer("location-set", {
                answer: [{ path: "src/a.ts", line: 3, character: 5, extra: true }],
            }).some((e) => e.includes("unknown key")),
        ).toBe(true);
        expect(
            validateFinalAnswer("caller-set", {
                answer: [{ name: "f", path: "src/a.ts", line: 3, sites: 2 }],
            }).some((e) => e.includes("unknown key")),
        ).toBe(true);
        expect(
            validateFinalAnswer("route-set", {
                answer: [{ method: "get", path: "/x", file: "src/r.ts", line: 9, handler: "h" }],
            }).some((e) => e.includes("unknown key")),
        ).toBe(true);
        expect(
            validateFinalAnswer("file-set", { answer: { files: ["src/a.ts"], extra: 1 } }).some((e) =>
                e.includes("unknown key"),
            ),
        ).toBe(true);
        expect(
            validateFinalAnswer("scalar", { answer: { value: "es2022", extra: 1 } }).some((e) =>
                e.includes("answer"),
            ),
        ).toBe(true);
        expect(
            validateFinalAnswer("type-string", { answer: { type: "string", extra: 1 } }).some((e) =>
                e.includes("answer"),
            ),
        ).toBe(true);
    });
});

describe("FAMILY_TABLE", () => {
    it("covers every family and answerType with matching negative flags", () => {
        expect(Object.keys(FAMILY_TABLE).sort()).toEqual([...TEB_FAMILIES].sort());
        const answerTypes = new Set(Object.values(FAMILY_TABLE).map((e) => e.answerType));
        expect([...answerTypes].sort()).toEqual([...TEB_ANSWER_TYPES].sort());
        for (const [family, entry] of Object.entries(FAMILY_TABLE)) {
            const negative = (["literal-location", "file-by-name", "config-value"] as string[]).includes(
                family,
            );
            expect(entry.negativeControl).toBe(negative);
            if (entry.negativeControl) {
                expect(entry.specialistTools).toEqual([]);
            } else {
                expect(entry.specialistTools.length).toBeGreaterThan(0);
            }
        }
        expect(FAMILY_TABLE["package-exports"].answerType).toBe("file-set");
        expect(FAMILY_TABLE["callers"].answerType).toBe("caller-set");
    });

    it("names only real tool contracts for direct-importers (E13.5)", () => {
        const entry = FAMILY_TABLE["direct-importers"];
        expect(entry.specialistTools).toEqual(["grep", "LSP"]);
        for (const call of entry.exampleCalls) {
            expect(call).not.toContain("dependents");
            expect(call).not.toContain("kind");
        }
        expect(entry.exampleCalls.some((call) => call.includes("structural"))).toBe(true);
        expect(entry.exampleCalls.some((call) => call.includes("findReferences"))).toBe(true);
    });
});

describe("E13 task layout", () => {
    function implementationsTask(overrides: Partial<TebTask> = {}): TebTask {
        return definitionTask({
            id: "teb-pilot-implementations-001",
            family: "implementations",
            anchorKind: "definition",
            answerType: "location-set",
            gold: {
                kind: "location-set",
                locations: [{ path: "src/a.ts", line: 1, character: 1 }],
                minRecall: 1,
                minPrecision: 0.5,
            },
            ...overrides,
        });
    }

    it("accepts an optional free-text note (E13.1)", () => {
        expect(validateTebTask(definitionTask({ note: "thresholds: labeler-authored" }))).toEqual(
            [],
        );
    });

    it("rejects a non-string note", () => {
        const errors = validateTebTask(definitionTask({ note: 5 as unknown as string }));
        expect(errors.some((e) => e.includes("note"))).toBe(true);
    });

    it("requires definition-site anchors for implementations (E13.2)", () => {
        expect(validateTebTask(implementationsTask())).toEqual([]);
        const errors = validateTebTask(implementationsTask({ anchorKind: "use" }));
        expect(errors.some((e) => e.includes("anchorKind"))).toBe(true);
    });
});
