/**
 * TEB grader tests on synthetic data (pure, no IO). Covers correct,
 * near-miss, ambiguous-symbol, stale-location, malformed, empty, extra-key,
 * multiple-json-block, and path-variant (./, absolute under repo,
 * backslash) cases across the graded answerTypes.
 */
import { describe, expect, it } from "vitest";
import {
    extractLastJsonBlock,
    gradeTebTask,
    levenshteinSimilarity,
    normalizeTebPath,
    normalizeTypeString,
    setF1,
} from "../../../scripts/eval/teb/grade.js";
import { normalizeTypeString as goldNormalizeTypeString } from "../../../scripts/eval/teb/gold/normalize.js";
import type { TebTask } from "../../../scripts/eval/teb/schema.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function base(overrides: Partial<TebTask> = {}): TebTask {
    return {
        id: "teb-pilot-definition-001",
        split: "pilot",
        repo: "TanStack__query",
        commit: SHA,
        subpath: "packages/query-core",
        family: "definition",
        prompt: "synthetic prompt",
        useSite: { path: "src/queryCache.ts", line: 106, character: 13 },
        anchorKind: "use",
        scope: "",
        answerType: "single-location",
        gold: { kind: "single-location", location: { path: "src/queryClient.ts", line: 61, character: 14 } },
        opportunity: { tools: ["LSP"], rationale: "synthetic" },
        negativeControl: false,
        derivation: "synthetic",
        agreement: "agree",
        labelers: ["a", "b"],
        adjudication: "agree",
        ...overrides,
    };
}

function fenced(payload: unknown): string {
    return `Some reasoning text.\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

function locationSetTask(): TebTask {
    return base({
        id: "teb-pilot-all-references-001",
        family: "all-references",
        answerType: "location-set",
        gold: {
            kind: "location-set",
            locations: [
                { path: "src/a.ts", line: 10, character: 5 },
                { path: "src/b.ts", line: 20, character: 8 },
            ],
            minRecall: 1.0,
            minPrecision: 0.5,
        },
    });
}

describe("single-location grading", () => {
    it("passes on the exact gold point", () => {
        const task = base();
        const row = gradeTebTask(task, fenced({ answer: { path: "src/queryClient.ts", line: 61, character: 14 } }));
        expect(row.pass).toBe(true);
        expect(row.reason).toBe("pass");
        expect(row.secondary).toBe(1);
    });

    it("passes within the ±2 column tolerance", () => {
        const task = base();
        const row = gradeTebTask(task, fenced({ answer: { path: "src/queryClient.ts", line: 61, character: 16 } }));
        expect(row.pass).toBe(true);
        expect(row.secondary).toBe(1);
    });

    it("fails a column outside tolerance with no partial credit", () => {
        const task = base();
        const row = gradeTebTask(task, fenced({ answer: { path: "src/queryClient.ts", line: 61, character: 20 } }));
        expect(row.pass).toBe(false);
        expect(row.reason).toBe("fail");
        expect(row.secondary).toBe(0.5);
    });

    it("gives half credit for right-file-wrong-line (near-miss)", () => {
        const task = base();
        const row = gradeTebTask(task, fenced({ answer: { path: "src/queryClient.ts", line: 200, character: 14 } }));
        expect(row.pass).toBe(false);
        expect(row.secondary).toBe(0.5);
    });

    it("fails a stale location in the wrong file with zero credit", () => {
        const task = base();
        const row = gradeTebTask(task, fenced({ answer: { path: "src/staleBarrel.ts", line: 61, character: 14 } }));
        expect(row.pass).toBe(false);
        expect(row.reason).toBe("fail");
        expect(row.secondary).toBe(0);
    });

    it("fails an ambiguous-symbol answer pointing at the barrel, not the ultimate target", () => {
        const task = base();
        const row = gradeTebTask(task, fenced({ answer: { path: "src/index.ts", line: 3, character: 14 } }));
        expect(row.pass).toBe(false);
        expect(row.secondary).toBe(0);
    });
});

describe("last-block extraction and malformed answers", () => {
    it("grades the LAST fenced json block when several are present", () => {
        const task = base();
        const transcript =
            "First attempt:\n```json\n" +
            JSON.stringify({ answer: { path: "src/wrong.ts", line: 1, character: 1 } }) +
            "\n```\nCorrected:\n" +
            fenced({ answer: { path: "src/queryClient.ts", line: 61, character: 14 } });
        expect(gradeTebTask(task, transcript).pass).toBe(true);
    });

    it("marks a missing block malformed", () => {
        const row = gradeTebTask(base(), "No structured answer here.");
        expect(row.pass).toBe(false);
        expect(row.reason).toBe("malformed");
        expect(row.secondary).toBe(0);
    });

    it("marks unparseable JSON malformed", () => {
        const row = gradeTebTask(base(), "```json\n{not json\n```");
        expect(row.reason).toBe("malformed");
    });

    it("marks extra keys malformed (fail-closed shapes)", () => {
        const row = gradeTebTask(
            base(),
            fenced({ answer: { path: "src/queryClient.ts", line: 61, character: 14 }, confidence: 0.9 }),
        );
        expect(row.reason).toBe("malformed");
        expect(row.pass).toBe(false);
    });

    it("marks a wrong-shape answer malformed", () => {
        const row = gradeTebTask(base(), fenced({ answer: { files: ["src/queryClient.ts"] } }));
        expect(row.reason).toBe("malformed");
    });

    it("extracts only ```json blocks, ignoring other fences", () => {
        const block = extractLastJsonBlock("```typescript\nconst x = 1;\n```\n" + fenced({ answer: 1 }));
        expect(block.found).toBe(true);
        expect(JSON.parse(block.raw) as unknown).toEqual({ answer: 1 });
    });
});

describe("path normalisation", () => {
    const task = base();

    it("strips a leading ./ prefix", () => {
        expect(normalizeTebPath("./src/queryClient.ts", task, false)).toBe("src/queryClient.ts");
    });

    it("strips an echoed subpath prefix", () => {
        expect(normalizeTebPath("packages/query-core/src/queryClient.ts", task, false)).toBe("src/queryClient.ts");
    });

    it("resolves an absolute checkout path containing the subpath", () => {
        expect(normalizeTebPath("/checkout/packages/query-core/src/queryClient.ts", task, false)).toBe(
            "src/queryClient.ts",
        );
    });

    it("converts backslash separators", () => {
        expect(normalizeTebPath("src\\queryClient.ts", task, false)).toBe("src/queryClient.ts");
    });

    it("grades path variants as correct end to end", () => {
        for (const path of [
            "./src/queryClient.ts",
            "packages/query-core/src/queryClient.ts",
            "/checkout/packages/query-core/src/queryClient.ts",
            "src\\queryClient.ts",
        ]) {
            const row = gradeTebTask(task, fenced({ answer: { path, line: 61, character: 14 } }));
            expect(row.pass).toBe(true);
        }
    });

    it("applies .js→.ts forgiveness only when the task sets it", () => {
        const js = fenced({ answer: { path: "src/queryClient.js", line: 61, character: 14 } });
        expect(gradeTebTask(task, js).pass).toBe(false);
        const forgiving = base({ repo: "prettier__prettier", extensionForgiveness: true });
        expect(gradeTebTask(forgiving, js).pass).toBe(true);
    });
});

describe("location-set grading", () => {
    it("passes on the full gold set", () => {
        const row = gradeTebTask(
            locationSetTask(),
            fenced({
                answer: [
                    { path: "src/a.ts", line: 10, character: 5 },
                    { path: "src/b.ts", line: 20, character: 9 },
                ],
            }),
        );
        expect(row.pass).toBe(true);
        expect(row.recall).toBe(1);
        expect(row.precision).toBe(1);
        expect(row.f1).toBe(1);
        expect(row.secondary).toBe(1);
    });

    it("fails a partial set under minRecall 1.0 but reports recall/precision", () => {
        const row = gradeTebTask(
            locationSetTask(),
            fenced({ answer: [{ path: "src/a.ts", line: 10, character: 5 }] }),
        );
        expect(row.pass).toBe(false);
        expect(row.reason).toBe("fail");
        expect(row.recall).toBe(0.5);
        expect(row.precision).toBe(1);
    });

    it("scores an empty prediction 0/0", () => {
        const row = gradeTebTask(locationSetTask(), fenced({ answer: [] }));
        expect(row.pass).toBe(false);
        expect(row.recall).toBe(0);
        expect(row.precision).toBe(0);
        expect(row.secondary).toBe(0);
    });

    it("penalises precision on extra predictions", () => {
        const row = gradeTebTask(
            locationSetTask(),
            fenced({
                answer: [
                    { path: "src/a.ts", line: 10, character: 5 },
                    { path: "src/b.ts", line: 20, character: 8 },
                    { path: "src/noise.ts", line: 1, character: 1 },
                    { path: "src/more.ts", line: 2, character: 2 },
                    { path: "src/extra.ts", line: 3, character: 3 },
                ],
            }),
        );
        expect(row.recall).toBe(1);
        expect(row.precision).toBeCloseTo(0.4);
        expect(row.pass).toBe(false);
    });
});

describe("caller-set grading", () => {
    function callerTask(): TebTask {
        return base({
            id: "teb-pilot-callers-001",
            family: "callers",
            anchorKind: "definition",
            answerType: "caller-set",
            gold: {
                kind: "caller-set",
                callers: [{ name: "loadConfig", path: "src/loader.ts", line: 42 }],
                minRecall: 1.0,
                minPrecision: 0.5,
            },
        });
    }

    it("passes on exact name/path/line", () => {
        const row = gradeTebTask(callerTask(), fenced({ answer: [{ name: "loadConfig", path: "src/loader.ts", line: 42 }] }));
        expect(row.pass).toBe(true);
    });

    it("rejects a name mismatch on the same path+line", () => {
        const row = gradeTebTask(callerTask(), fenced({ answer: [{ name: "loadConfigFast", path: "src/loader.ts", line: 42 }] }));
        expect(row.pass).toBe(false);
        expect(row.recall).toBe(0);
    });

    it("trims caller names before comparison", () => {
        const row = gradeTebTask(callerTask(), fenced({ answer: [{ name: "  loadConfig ", path: "src/loader.ts", line: 42 }] }));
        expect(row.pass).toBe(true);
    });
});

describe("route-set grading", () => {
    function routeTask(): TebTask {
        return base({
            id: "teb-pilot-http-routes-001",
            family: "http-routes",
            answerType: "route-set",
            gold: {
                kind: "route-set",
                routes: [{ method: "GET", path: "/health", file: "src/server.ts", line: 12 }],
                minRecall: 1.0,
                minPrecision: 0.5,
            },
        });
    }

    it("upper-cases methods before comparison", () => {
        const row = gradeTebTask(
            routeTask(),
            fenced({ answer: [{ method: "get", path: "/health", file: "src/server.ts", line: 12 }] }),
        );
        expect(row.pass).toBe(true);
    });

    it("rejects a wrong route path", () => {
        const row = gradeTebTask(
            routeTask(),
            fenced({ answer: [{ method: "GET", path: "/ready", file: "src/server.ts", line: 12 }] }),
        );
        expect(row.pass).toBe(false);
    });
});

describe("file and scalar grading", () => {
    it("matches file answers on normalized paths", () => {
        const task = base({
            id: "teb-pilot-file-by-name-001",
            family: "file-by-name",
            answerType: "file",
            gold: { kind: "file", path: "src/config.ts" },
            negativeControl: true,
            opportunity: { tools: [], rationale: "solvable with first-line retrieval" },
        });
        expect(gradeTebTask(task, fenced({ answer: { path: "./src/config.ts" } })).pass).toBe(true);
        expect(gradeTebTask(task, fenced({ answer: { path: "src/other.ts" } })).pass).toBe(false);
    });

    it("compares scalars case-insensitively after trim by default", () => {
        const task = base({
            id: "teb-pilot-config-value-001",
            family: "config-value",
            answerType: "scalar",
            gold: { kind: "scalar", value: "strict" },
            negativeControl: true,
            opportunity: { tools: [], rationale: "solvable with first-line retrieval" },
        });
        expect(gradeTebTask(task, fenced({ answer: { value: "  Strict " } })).pass).toBe(true);
    });

    it("honours caseSensitive scalar tasks", () => {
        const task = base({
            id: "teb-pilot-config-value-002",
            family: "config-value",
            answerType: "scalar",
            gold: { kind: "scalar", value: "Strict" },
            negativeControl: true,
            opportunity: { tools: [], rationale: "solvable with first-line retrieval" },
            caseSensitive: true,
        });
        expect(gradeTebTask(task, fenced({ answer: { value: "strict" } })).pass).toBe(false);
        expect(gradeTebTask(task, fenced({ answer: { value: "Strict" } })).pass).toBe(true);
    });

    it("gives partial Levenshtein credit on scalar near-misses", () => {
        const task = base({
            id: "teb-pilot-config-value-003",
            family: "config-value",
            answerType: "scalar",
            gold: { kind: "scalar", value: "strict" },
            negativeControl: true,
            opportunity: { tools: [], rationale: "solvable with first-line retrieval" },
        });
        const row = gradeTebTask(task, fenced({ answer: { value: "stric" } }));
        expect(row.pass).toBe(false);
        expect(row.secondary).toBeGreaterThan(0.5);
    });
});

describe("type-string grading", () => {
    function typeTask(): TebTask {
        return base({
            id: "teb-pilot-type-of-symbol-001",
            family: "type-of-symbol",
            answerType: "type-string",
            gold: {
                kind: "type-string",
                normalized: "Promise<void>",
                normalization: { arrayRewrite: false, dropUndefined: false },
            },
        });
    }

    it("normalises hover renderings with alias qualifiers and fenced blocks", () => {
        const row = gradeTebTask(
            typeTask(),
            fenced({ answer: { type: "```typescript\n(alias) function build(_options: Options): Promise<void>\n```" } }),
        );
        expect(normalizeTypeString("```typescript\n(alias) function build(_options: Options): Promise<void>\n```", {
            arrayRewrite: false,
            dropUndefined: false,
        })).toContain("Promise<void>");
        expect(row.pass).toBe(false);
        const exact = gradeTebTask(typeTask(), fenced({ answer: { type: "```typescript\nPromise<void>\n```" } }));
        expect(exact.pass).toBe(true);
    });

    it("applies the arrayRewrite flag", () => {
        const task = base({
            ...typeTask(),
            gold: {
                kind: "type-string",
                normalized: "string[]",
                normalization: { arrayRewrite: true, dropUndefined: false },
            },
        });
        expect(gradeTebTask(task, fenced({ answer: { type: "Array<string>" } })).pass).toBe(true);
    });

    it("applies the dropUndefined flag", () => {
        const task = base({
            ...typeTask(),
            gold: {
                kind: "type-string",
                normalized: "string",
                normalization: { arrayRewrite: false, dropUndefined: true },
            },
        });
        expect(gradeTebTask(task, fenced({ answer: { type: "string | undefined" } })).pass).toBe(true);
    });
});

describe("P1-5 anchored path normalisation", () => {
    function ctx(subpath: string, repo = "acme__pkg"): Pick<TebTask, "repo" | "subpath"> {
        return { repo, subpath };
    }

    it("does not strip an unanchored subpath occurrence (no false positive)", () => {
        expect(normalizeTebPath("query-core/src/x.ts", ctx("core"), false)).toBe("query-core/src/x.ts");
    });

    it("does not strip a bare basename prefix (no false negative)", () => {
        expect(normalizeTebPath("core/utils.ts", ctx("packages/core"), false)).toBe("core/utils.ts");
    });

    it("strips at most one leading subpath segment", () => {
        expect(normalizeTebPath("src/foo/src/bar.ts", ctx("src"), false)).toBe("foo/src/bar.ts");
    });

    it("leaves a relative path with only a mid-path subpath match untouched", () => {
        expect(normalizeTebPath("lib/other/packages/core/src/x.ts", ctx("packages/core"), false)).toBe(
            "lib/other/packages/core/src/x.ts",
        );
    });

    it("strips a leading repo dir then one subpath prefix on relative paths", () => {
        expect(normalizeTebPath("acme__pkg/packages/core/src/x.ts", ctx("packages/core"), false)).toBe(
            "src/x.ts",
        );
    });

    it("resolves absolute checkout paths through the repo dir and subpath", () => {
        expect(normalizeTebPath("/bench/repos/acme__pkg/packages/core/src/x.ts", ctx("packages/core"), false)).toBe(
            "src/x.ts",
        );
        expect(normalizeTebPath("/checkout/packages/core/src/x.ts", ctx("packages/core"), false)).toBe("src/x.ts");
    });

    it("normalises gold paths exactly like predicted paths", () => {
        const task = base({
            id: "teb-pilot-file-by-name-004",
            family: "file-by-name",
            answerType: "file",
            gold: { kind: "file", path: "packages/query-core/src/config.ts" },
            negativeControl: true,
            opportunity: { tools: [], rationale: "solvable with first-line retrieval" },
        });
        expect(gradeTebTask(task, fenced({ answer: { path: "src/config.ts" } })).pass).toBe(true);
    });

    it("grades a mid-path-subpath decoy as a miss end to end", () => {
        const task = base({
            id: "teb-pilot-file-by-name-005",
            family: "file-by-name",
            answerType: "file",
            gold: { kind: "file", path: "src/x.ts" },
            negativeControl: true,
            opportunity: { tools: [], rationale: "solvable with first-line retrieval" },
        });
        expect(gradeTebTask(task, fenced({ answer: { path: "query-packages/query-core/src/x.ts" } })).pass).toBe(
            false,
        );
    });
});

describe("P1-5 absolute-path anchoring (E13)", () => {
    function ctx(subpath: string, repo = "acme__pkg"): Pick<TebTask, "repo" | "subpath"> {
        return { repo, subpath };
    }

    it("does not strip a mid-segment subpath occurrence in absolute paths", () => {
        // `core` occurs inside the `query-core` segment: stripping there
        // is a false positive (`/tmp/query-core/src/x.ts` → `src/x.ts`).
        // The leading-slash clean is unrelated firewalling; the subpath
        // itself must survive untouched.
        expect(normalizeTebPath("/tmp/query-core/src/x.ts", ctx("core"), false)).toBe(
            "tmp/query-core/src/x.ts",
        );
    });

    it("strips repo dir + subpath on whole-segment boundaries only", () => {
        expect(
            normalizeTebPath("/bench/acme__pkg/packages/core/src/x.ts", ctx("packages/core"), false),
        ).toBe("src/x.ts");
        expect(normalizeTebPath("/checkout/packages/core/src/x.ts", ctx("packages/core"), false)).toBe(
            "src/x.ts",
        );
    });

    it("grades an absolute mid-segment decoy as a miss end to end", () => {
        const task = base({
            id: "teb-pilot-file-by-name-006",
            family: "file-by-name",
            answerType: "file",
            subpath: "core",
            gold: { kind: "file", path: "src/x.ts" },
            negativeControl: true,
            opportunity: { tools: [], rationale: "solvable with first-line retrieval" },
        });
        expect(
            gradeTebTask(task, fenced({ answer: { path: "/tmp/query-core/src/x.ts" } })).pass,
        ).toBe(false);
    });
});

describe("no double normalisation (E13)", () => {
    function doublestripTask(): TebTask {
        return base({
            id: "teb-pilot-file-by-name-007",
            family: "file-by-name",
            subpath: "packages/core",
            answerType: "file",
            gold: { kind: "file", path: "src/utils.ts" },
            negativeControl: true,
            opportunity: { tools: [], rationale: "solvable with first-line retrieval" },
        });
    }

    it("does not collapse a repeated subpath prefix twice", () => {
        // One normalisation strips one leading prefix, leaving
        // `packages/core/src/utils.ts`, which must NOT match gold.
        const row = gradeTebTask(
            doublestripTask(),
            fenced({ answer: { path: "packages/core/packages/core/src/utils.ts" } }),
        );
        expect(row.pass).toBe(false);
        expect(row.reason).toBe("fail");
    });

    it("still strips a single leading subpath prefix", () => {
        expect(
            gradeTebTask(
                doublestripTask(),
                fenced({ answer: { path: "packages/core/src/utils.ts" } }),
            ).pass,
        ).toBe(true);
    });
});

describe("null and non-object fenced answers (E13 blocker 1)", () => {
    const task = base();

    it.each([[null], [5], ["just a string"], [[1, 2]], [true]])(
        "grades %p as malformed zero without throwing",
        (payload) => {
            let row;
            expect(() => {
                row = gradeTebTask(task, fenced(payload));
            }).not.toThrow();
            expect(row!.pass).toBe(false);
            expect(row!.reason).toBe("malformed");
            expect(row!.secondary).toBe(0);
        },
    );
});

describe("explicit set thresholds (R4)", () => {
    it("grades set gold without explicit thresholds as malformed, never defaulted", () => {
        const task = base({
            id: "teb-pilot-all-references-002",
            family: "all-references",
            answerType: "location-set",
            gold: {
                kind: "location-set",
                locations: [{ path: "src/a.ts", line: 10, character: 5 }],
            } as unknown as TebTask["gold"],
        });
        const row = gradeTebTask(task, fenced({ answer: [{ path: "src/a.ts", line: 10, character: 5 }] }));
        expect(row.pass).toBe(false);
        expect(row.reason).toBe("malformed");
    });
});

describe("single pinned type-string normaliser", () => {
    it("re-exports the gold normaliser instead of carrying a copy", () => {
        expect(normalizeTypeString).toBe(goldNormalizeTypeString);
    });
});

describe("metric primitives", () => {
    it("computes set-F1 with 0/0 defined as 0", () => {
        expect(setF1(1, 1)).toBe(1);
        expect(setF1(0.5, 1)).toBeCloseTo(2 / 3);
        expect(setF1(0, 0)).toBe(0);
    });

    it("computes normalized Levenshtein similarity", () => {
        expect(levenshteinSimilarity("abc", "abc")).toBe(1);
        expect(levenshteinSimilarity("", "")).toBe(1);
        expect(levenshteinSimilarity("abc", "")).toBe(0);
        expect(levenshteinSimilarity("kitten", "sitting")).toBeGreaterThan(0.4);
    });
});
