/**
 * Unit tests for the D46 held-out set schema and validator. No network:
 * repo-path checks run against temp fixture dirs; the repo-tree scan runs
 * against the real checkout and temp dirs.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
    DEV_QUOTA,
    HOLDOUT_QUOTA,
    type D46Query,
} from "../../../scripts/eval/d46/schema.js";
import {
    checkQuota,
    findRepoQueryFiles,
    sealQueries,
    validateQueryDoc,
} from "../../../scripts/eval/d46/validate.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function behaviourQuery(overrides: Partial<D46Query> = {}): D46Query {
    return {
        id: "zod-001",
        repo: "colinhacks/zod",
        split: "holdout",
        class: "behaviour",
        query: "Where is the email string validator implemented?",
        gold: [{ path: "src/types.ts", startLine: 10, endLine: 20, grade: 1 }],
        rationale: "The email check lives in the string type implementation.",
        author: "alice",
        authoredAt: "2026-10-07T00:00:00Z",
        ...overrides,
    };
}

describe("validateQueryDoc structure", () => {
    it("accepts a valid behaviour query", () => {
        const result = validateQueryDoc([behaviourQuery()]);
        expect(result.errors).toEqual([]);
        expect(result.queries).toHaveLength(1);
    });

    it("rejects duplicate ids", () => {
        const result = validateQueryDoc([behaviourQuery(), behaviourQuery()]);
        expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
    });

    it("rejects an unknown class", () => {
        const result = validateQueryDoc([
            behaviourQuery({ class: "vibes" as D46Query["class"] }),
        ]);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects gold with startLine > endLine or startLine < 1", () => {
        const badRange = validateQueryDoc([
            behaviourQuery({
                gold: [{ path: "src/a.ts", startLine: 20, endLine: 10, grade: 1 }],
            }),
        ]);
        expect(badRange.errors.length).toBeGreaterThan(0);
        const zeroLine = validateQueryDoc([
            behaviourQuery({
                gold: [{ path: "src/a.ts", startLine: 0, endLine: 10, grade: 2 }],
            }),
        ]);
        expect(zeroLine.errors.length).toBeGreaterThan(0);
    });

    it("rejects an invalid grade", () => {
        const result = validateQueryDoc([
            behaviourQuery({
                gold: [{ path: "src/a.ts", startLine: 1, endLine: 2, grade: 3 as 1 }],
            }),
        ]);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("requires empty gold plus absenceEvidence for absence queries", () => {
        const missing = validateQueryDoc([
            behaviourQuery({ id: "zod-a1", class: "absence", gold: [] }),
        ]);
        expect(missing.errors.some((e) => e.includes("absenceEvidence"))).toBe(true);
        const withGold = validateQueryDoc([
            behaviourQuery({
                id: "zod-a1",
                class: "absence",
                gold: [{ path: "src/a.ts", startLine: 1, endLine: 2, grade: 1 }],
                absenceEvidence: { searchesRun: ["rg foo"], synonymsChecked: ["bar"] },
            }),
        ]);
        expect(withGold.errors.some((e) => e.includes("absence"))).toBe(true);
        const ok = validateQueryDoc([
            behaviourQuery({
                id: "zod-a1",
                class: "absence",
                gold: [],
                absenceEvidence: { searchesRun: ["rg foo"], synonymsChecked: ["bar"] },
            }),
        ]);
        expect(ok.errors).toEqual([]);
    });

    it("requires exactForm for exact_ish and forbids it elsewhere", () => {
        const missing = validateQueryDoc([
            behaviourQuery({ id: "zod-e1", class: "exact_ish", exactForm: undefined }),
        ]);
        expect(missing.errors.some((e) => e.includes("exactForm"))).toBe(true);
        const misplaced = validateQueryDoc([
            behaviourQuery({ class: "behaviour", exactForm: "literal" }),
        ]);
        expect(misplaced.errors.some((e) => e.includes("exactForm"))).toBe(true);
        const ok = validateQueryDoc([
            behaviourQuery({ id: "zod-e1", class: "exact_ish", exactForm: "identifier" }),
        ]);
        expect(ok.errors).toEqual([]);
    });

    it("rejects a non-array doc and non-object entries", () => {
        expect(validateQueryDoc({}).errors.length).toBeGreaterThan(0);
        expect(validateQueryDoc([42]).errors.length).toBeGreaterThan(0);
    });
});

describe("checkQuota", () => {
    it("accepts a balanced holdout and rejects shortfalls", () => {
        const classes = [
            "behaviour",
            "architecture",
            "configuration",
            "error_retry",
            "multi_file",
            "exact_ish",
            "absence",
        ] as const;
        const queries: D46Query[] = [];
        const holdoutRepos = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
        let n = 0;
        for (const cls of classes) {
            for (let i = 0; i < HOLDOUT_QUOTA.perClass; i++) {
                queries.push(
                    behaviourQuery({
                        id: `h-${cls}-${i}`,
                        repo: holdoutRepos[n % holdoutRepos.length] as string,
                        class: cls,
                        gold: cls === "absence" ? [] : behaviourQuery().gold,
                        absenceEvidence:
                            cls === "absence"
                                ? { searchesRun: ["rg x"], synonymsChecked: ["y"] }
                                : undefined,
                    }),
                );
                n += 1;
            }
        }
        expect(checkQuota(queries, "holdout")).toEqual([]);
        expect(queries).toHaveLength(HOLDOUT_QUOTA.total);
        const short = queries.slice(1);
        const errors = checkQuota(short, "holdout");
        expect(errors.length).toBeGreaterThan(0);
    });

    it("expects the dev quota shape", () => {
        expect(DEV_QUOTA.total).toBe(56);
        expect(DEV_QUOTA.perClass).toBe(8);
    });
});

describe("sealQueries", () => {
    it("is deterministic and sensitive to content", () => {
        const a = sealQueries([behaviourQuery()]);
        const b = sealQueries([behaviourQuery()]);
        expect(a.sha256).toBe(b.sha256);
        expect(a.queryCount).toBe(1);
        const c = sealQueries([behaviourQuery({ query: "different" })]);
        expect(c.sha256).not.toBe(a.sha256);
    });
});

describe("findRepoQueryFiles", () => {
    let dir = "";
    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
            dir = "";
        }
    });

    it("finds no d46 query files in the repo tree", () => {
        expect(findRepoQueryFiles(REPO_ROOT)).toEqual([]);
    });

    it("detects a planted query file in a temp tree", () => {
        dir = mkdtempSync(join(tmpdir(), "d46-scan-"));
        mkdirSync(join(dir, "d46", "holdout"), { recursive: true });
        writeFileSync(join(dir, "d46", "holdout", "q.json"), "[]");
        expect(findRepoQueryFiles(dir)).toHaveLength(1);
    });
});
