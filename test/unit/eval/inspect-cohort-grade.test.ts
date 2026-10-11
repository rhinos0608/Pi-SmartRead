/**
 * Pure-grader fixtures for `scripts/eval/inspect-cohort/grade.ts`.
 *
 * Ten hard fixture groups from the oracle handoff; synthetic tasks only
 * (no real gold, bodies, or holdouts). Contexts are independently certified
 * fixtures — the loader boundary (digest verification) lives outside the
 * pure module.
 */

import { describe, expect, it } from "vitest";
import type { InspectTask } from "../../../scripts/eval/inspect-cohort/schema.js";
import { gradeInspectTask } from "../../../scripts/eval/inspect-cohort/grade.js";
import type { FrozenGraderContext } from "../../../scripts/eval/inspect-cohort/grade.js";

const COMMIT = "a".repeat(40);
const HEAD = "b".repeat(40);
const SHA = "c".repeat(64);
const UNIVERSE_ID = "universe-sealed-001";
const PATCH_SHA = "d".repeat(40);

function baseTask(overrides: Partial<InspectTask>): InspectTask {
    return {
        id: "insp-pilot-P1-001",
        split: "pilot",
        repo: "owner__name",
        commit: COMMIT,
        subpath: "packages/core",
        family: "P1",
        prompt: "Inventory the registrations visible here.",
        scope: "src",
        answerType: "route-set",
        gold: {
            kind: "route-set",
            routes: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }],
            minRecall: 1,
            minPrecision: 0.5,
        },
        candidateUniverse: { id: UNIVERSE_ID, sha256: SHA, count: 2 },
        decoys: ["decoy-route-comment"],
        negativeControl: false,
        derivation: "route-scan v1 --frozen",
        agreement: "agree",
        labelers: ["labeler-one", "labeler-two"],
        adjudication: "agree",
        snapshot: { head: HEAD, clean: true },
        ...overrides,
    } as InspectTask;
}

function baseContext(): FrozenGraderContext["tasks"][string] {
    return {
        binding: {
            repo: "owner__name",
            commit: COMMIT,
            subpath: "packages/core",
            scope: "src",
            snapshotHead: HEAD,
            snapshotClean: true,
        },
        universe: { id: UNIVERSE_ID, sha256: SHA, count: 2, files: ["src/a.ts", "src/b.ts"] },
        sourceLines: { "src/a.ts": 50, "src/b.ts": 50 },
        trackedFiles: ["src/a.ts", "src/b.ts"],
        certifiedRoutes: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }],
        certifiedRelations: [],
        certifiedEdges: [],
        completeness: { complete: true },
        manifestRef: "manifest-sealed-001",
    };
}

function ctxFor(task: InspectTask): FrozenGraderContext {
    return { tasks: { [task.id]: baseContext() } };
}

describe("group 1: shape routing", () => {
    it("extra final key is malformed -> modelFail, pass false", () => {
        const task = baseTask({});
        const r = gradeInspectTask(
            task,
            { answer: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }], coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] }, extra: 1 },
            ctxFor(task),
        );
        expect(r.status).toBe("modelFail");
        expect(r.pass).toBe(false);
    });
    it("invalid task -> goldInvalid, pass null", () => {
        const bad = { ...baseTask({}), commit: "short" };
        const r = gradeInspectTask(bad, {}, ctxFor(baseTask({})));
        expect(r.status).toBe("goldInvalid");
        expect(r.pass).toBeNull();
    });
    it("context universe digest mismatch -> goldInvalid", () => {
        const task = baseTask({});
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.universe.sha256 = "e".repeat(64);
        const r = gradeInspectTask(
            task,
            { answer: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }], coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] } },
            ctx,
        );
        expect(r.status).toBe("goldInvalid");
        expect(r.pass).toBeNull();
    });
});

describe("group 2: route matching", () => {
    it("lower-case method matches -> recall=precision=1, pass", () => {
        const task = baseTask({});
        const r = gradeInspectTask(
            task,
            { answer: [{ method: "get", path: "/users", file: "src/a.ts", line: 3 }], coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] } },
            ctxFor(task),
        );
        expect(r.status).toBe("graded");
        expect(r.pass).toBe(true);
        expect(r.recall).toBe(1);
        expect(r.precision).toBe(1);
    });
    it("comment-decoy citation at a real line -> 0/0 fail", () => {
        const task = baseTask({});
        const r = gradeInspectTask(
            task,
            { answer: [{ method: "GET", path: "/users-fake", file: "src/a.ts", line: 10 }], coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] } },
            ctxFor(task),
        );
        expect(r.status).toBe("graded");
        expect(r.pass).toBe(false);
        expect(r.recall).toBe(0);
        expect(r.precision).toBe(0);
    });
});

describe("group 3: relation matching", () => {
    function relationTask(): InspectTask {
        return baseTask({
            id: "insp-pilot-P2-001",
            family: "P2",
            answerType: "relation-set",
            prompt: "Map the package boundaries in this area.",
            gold: {
                kind: "relation-set",
                relations: [
                    { from: "src/a.ts", specifier: "./b", kind: "import", line: 5, witness: { path: "src/a.ts", line: 5 }, resolved: null, unresolvedReason: "dynamic-specifier" },
                ],
                minRecall: 1,
                minPrecision: 0.5,
            },
        });
    }
    function relationCtx(task: InspectTask): FrozenGraderContext {
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.certifiedRelations = [
            { from: "src/a.ts", specifier: "./b", kind: "import", line: 5, witness: { path: "src/a.ts", line: 5 }, resolved: null, unresolvedReason: "dynamic-specifier" },
        ];
        ctx.tasks[task.id]!.certifiedRoutes = [];
        return ctx;
    }
    it("supported unresolved relation -> 1/1 pass", () => {
        const task = relationTask();
        const r = gradeInspectTask(
            task,
            { answer: [{ from: "src/a.ts", specifier: "./b", kind: "import", line: 5, witness: { path: "src/a.ts", line: 5 }, resolved: null, unresolvedReason: "dynamic-specifier" }], coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] } },
            relationCtx(task),
        );
        expect(r.pass).toBe(true);
        expect(r.recall).toBe(1);
    });
    it("wrong reason -> 0/0 fail", () => {
        const task = relationTask();
        const r = gradeInspectTask(
            task,
            { answer: [{ from: "src/a.ts", specifier: "./b", kind: "import", line: 5, witness: { path: "src/a.ts", line: 5 }, resolved: null, unresolvedReason: "generated" }], coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] } },
            relationCtx(task),
        );
        expect(r.pass).toBe(false);
        expect(r.recall).toBe(0);
        expect(r.precision).toBe(0);
    });
    it("null without reason -> malformed modelFail", () => {
        const task = relationTask();
        const r = gradeInspectTask(
            task,
            { answer: [{ from: "src/a.ts", specifier: "./b", kind: "import", line: 5, witness: { path: "src/a.ts", line: 5 }, resolved: null }], coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] } },
            relationCtx(task),
        );
        expect(r.status).toBe("modelFail");
        expect(r.pass).toBe(false);
    });
});

describe("group 4: P5 ranges", () => {
    function p5Task(): InspectTask {
        return baseTask({
            id: "insp-pilot-P5-001",
            family: "P5",
            answerType: "evidence-chain",
            prompt: "Collect the evidence touching the frozen change.",
            gold: {
                kind: "evidence-chain",
                patch: { sha: PATCH_SHA, ranges: [{ path: "src/a.ts", start: 1, end: 10 }, { path: "src/b.ts", start: 4, end: 8 }] },
                relations: [
                    { from: "src/a.ts", specifier: "./b", kind: "import", line: 5, witness: { path: "src/a.ts", line: 5 }, resolved: "src/b.ts" },
                ],
                minRecall: 1,
                minPrecision: 0.5,
            },
        });
    }
    function p5Ctx(task: InspectTask): FrozenGraderContext {
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.patchSha = PATCH_SHA;
        ctx.tasks[task.id]!.certifiedRelations = [
            { from: "src/a.ts", specifier: "./b", kind: "import", line: 5, witness: { path: "src/a.ts", line: 5 }, resolved: "src/b.ts" },
        ];
        ctx.tasks[task.id]!.certifiedRoutes = [];
        return ctx;
    }
    const rel = { from: "src/a.ts", specifier: "./b", kind: "import", line: 5, witness: { path: "src/a.ts", line: 5 }, resolved: "src/b.ts" };
    const cov = { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] };
    it("one exact + one near-miss -> range recall=precision=.5 fail", () => {
        const task = p5Task();
        const r = gradeInspectTask(
            task,
            { answer: { ranges: [{ path: "src/a.ts", start: 1, end: 10 }, { path: "src/b.ts", start: 4, end: 9 }], relations: [rel] }, coverage: cov },
            p5Ctx(task),
        );
        expect(r.status).toBe("graded");
        expect(r.pass).toBe(false);
        expect(r.rangeRecall).toBe(0.5);
        expect(r.rangePrecision).toBe(0.5);
    });
    it("both exact plus extra unsupported range -> recall 1, precision 2/3, fail", () => {
        const task = p5Task();
        const r = gradeInspectTask(
            task,
            { answer: { ranges: [{ path: "src/a.ts", start: 1, end: 10 }, { path: "src/b.ts", start: 4, end: 8 }, { path: "src/a.ts", start: 20, end: 25 }], relations: [rel] }, coverage: cov },
            p5Ctx(task),
        );
        expect(r.rangeRecall).toBe(1);
        expect(r.rangePrecision).toBeCloseTo(2 / 3);
        expect(r.pass).toBe(false);
    });
});

describe("group 5: coverage membership", () => {
    it("declaration {a,c} over universe {a,b} -> coverage .5, exhaustive false-completeness true", () => {
        const task = baseTask({});
        const r = gradeInspectTask(
            task,
            { answer: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }], coverage: { claim: "exhaustive", scope: "src", enumeratedFiles: ["src/a.ts", "src/c.ts"] } },
            ctxFor(task),
        );
        expect(r.coverageRatio).toBe(0.5);
        expect(r.falseCompleteness).toBe(true);
        // False-completeness is a separate gated metric (§8), never merged
        // into recall: the route itself still passes thresholds.
        expect(r.pass).toBe(true);
    });
    it("full enumeration but omitted gold item -> coverage 1 yet flag true", () => {
        const task = baseTask({});
        const r = gradeInspectTask(
            task,
            { answer: [], coverage: { claim: "exhaustive", scope: "src", enumeratedFiles: ["src/a.ts", "src/b.ts"] } },
            ctxFor(task),
        );
        expect(r.coverageRatio).toBe(1);
        expect(r.falseCompleteness).toBe(true);
        expect(r.pass).toBe(false);
    });
});

describe("group 6: P4 alternative chains", () => {
    function p4Task(): InspectTask {
        return baseTask({
            id: "insp-pilot-P4-001",
            family: "P4",
            answerType: "conclusion",
            prompt: "Does the first module transitively depend on the last one here?",
            candidateUniverse: { id: UNIVERSE_ID, sha256: SHA, count: 4 },
            gold: {
                kind: "conclusion",
                verdict: "supported-true",
                claim: true,
                reason: "chain through intermediate modules",
                scope: "src",
                path: [
                    { from: "src/a.ts", to: "src/m.ts", kind: "import", witness: { path: "src/a.ts", line: 2 } },
                    { from: "src/m.ts", to: "src/z.ts", kind: "import", witness: { path: "src/m.ts", line: 3 } },
                ],
            },
        });
    }
    function p4Ctx(task: InspectTask): FrozenGraderContext {
        const ctx = ctxFor(task);
        const c = ctx.tasks[task.id]!;
        c.certifiedRoutes = [];
        c.sourceLines = { "src/a.ts": 50, "src/b.ts": 50, "src/m.ts": 50, "src/z.ts": 50 };
        c.trackedFiles = ["src/a.ts", "src/b.ts", "src/m.ts", "src/z.ts"];
        c.universe = { id: UNIVERSE_ID, sha256: SHA, count: 4, files: ["src/a.ts", "src/b.ts", "src/m.ts", "src/z.ts"] };
        c.certifiedEdges = [
            { from: "src/a.ts", to: "src/m.ts", kind: "import", witness: { path: "src/a.ts", line: 2 } },
            { from: "src/m.ts", to: "src/z.ts", kind: "import", witness: { path: "src/m.ts", line: 3 } },
            { from: "src/a.ts", to: "src/b.ts", kind: "import", witness: { path: "src/a.ts", line: 4 } },
            { from: "src/b.ts", to: "src/z.ts", kind: "import", witness: { path: "src/b.ts", line: 6 } },
        ];
        c.requestedEndpoints = { from: "src/a.ts", to: "src/z.ts" };
        return ctx;
    }
    it("alternative witnessed chain A->B->Z passes (not literal gold path)", () => {
        const task = p4Task();
        const r = gradeInspectTask(
            task,
            { verdict: "supported-true", claim: true, reason: "through b", scope: "src", path: [{ from: "src/a.ts", to: "src/b.ts", kind: "import", witness: { path: "src/a.ts", line: 4 } }, { from: "src/b.ts", to: "src/z.ts", kind: "import", witness: { path: "src/b.ts", line: 6 } }] },
            p4Ctx(task),
        );
        expect(r.status).toBe("graded");
        expect(r.pass).toBe(true);
    });
    it("supported but disconnected/wrong-endpoint chain fails", () => {
        const task = p4Task();
        const r = gradeInspectTask(
            task,
            { verdict: "supported-true", claim: true, reason: "wrong end", scope: "src", path: [{ from: "src/a.ts", to: "src/b.ts", kind: "import", witness: { path: "src/a.ts", line: 4 } }] },
            p4Ctx(task),
        );
        expect(r.pass).toBe(false);
    });
});

describe("group 7: P4 supported-false", () => {
    function falseTask(): InspectTask {
        return baseTask({
            id: "insp-pilot-P4-002",
            family: "P4",
            answerType: "conclusion",
            prompt: "Is there a dependency between these two isolated modules?",
            gold: { kind: "conclusion", verdict: "supported-false", claim: false, reason: "checked boundary, no path", scope: "src", path: [], enumeratedFiles: ["src/a.ts", "src/b.ts"] },
        });
    }
    it("certified unreachable + full enumeration -> false passes", () => {
        const task = falseTask();
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.certifiedRoutes = [];
        ctx.tasks[task.id]!.certifiedEdges = [];
        ctx.tasks[task.id]!.requestedEndpoints = { from: "src/a.ts", to: "src/b.ts" };
        const r = gradeInspectTask(
            task,
            { verdict: "supported-false", claim: false, reason: "checked boundary, no path", scope: "src", path: [], enumeratedFiles: ["src/a.ts", "src/b.ts"] },
            ctx,
        );
        expect(r.status).toBe("graded");
        expect(r.pass).toBe(true);
    });
    it("incomplete declaration -> fail with flag true", () => {
        const task = falseTask();
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.certifiedRoutes = [];
        ctx.tasks[task.id]!.certifiedEdges = [];
        ctx.tasks[task.id]!.requestedEndpoints = { from: "src/a.ts", to: "src/b.ts" };
        const r = gradeInspectTask(
            task,
            { verdict: "supported-false", claim: false, reason: "checked boundary", scope: "src", path: [], enumeratedFiles: ["src/a.ts"] },
            ctx,
        );
        expect(r.pass).toBe(false);
        expect(r.falseCompleteness).toBe(true);
    });
    it("reachable reference contradicting false gold -> goldInvalid", () => {
        const task = falseTask();
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.certifiedRoutes = [];
        ctx.tasks[task.id]!.certifiedEdges = [
            { from: "src/a.ts", to: "src/b.ts", kind: "import", witness: { path: "src/a.ts", line: 2 } },
        ];
        ctx.tasks[task.id]!.requestedEndpoints = { from: "src/a.ts", to: "src/b.ts" };
        const r = gradeInspectTask(
            task,
            { verdict: "supported-false", claim: false, reason: "checked boundary", scope: "src", path: [], enumeratedFiles: ["src/a.ts", "src/b.ts"] },
            ctx,
        );
        expect(r.status).toBe("goldInvalid");
        expect(r.pass).toBeNull();
    });
});

describe("group 8: P4 unknown", () => {
    function unknownTask(): InspectTask {
        return baseTask({
            id: "insp-pilot-P4-003",
            family: "P4",
            answerType: "conclusion",
            prompt: "Can the dependency be established from supported syntax?",
            gold: { kind: "conclusion", verdict: "cannot-establish", reason: "only dynamic syntax present", scope: "src", path: [] },
        });
    }
    function unknownCtx(task: InspectTask): FrozenGraderContext {
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.certifiedRoutes = [];
        ctx.tasks[task.id]!.requestedEndpoints = { from: "src/a.ts", to: "src/b.ts" };
        return ctx;
    }
    it("unknown with omitted claim passes", () => {
        const task = unknownTask();
        const r = gradeInspectTask(
            task,
            { verdict: "cannot-establish", reason: "only dynamic syntax present", scope: "src", path: [] },
            unknownCtx(task),
        );
        expect(r.status).toBe("graded");
        expect(r.pass).toBe(true);
        expect(r.predicted).toBe("unknown");
    });
    it("claim:false on unknown gold -> malformed modelFail", () => {
        const task = unknownTask();
        const r = gradeInspectTask(
            task,
            { verdict: "cannot-establish", claim: false, reason: "x", scope: "src", path: [] },
            unknownCtx(task),
        );
        expect(r.status).toBe("modelFail");
    });
    it("supported-false answer on unknown gold -> graded failure, never a match", () => {
        const task = unknownTask();
        const r = gradeInspectTask(
            task,
            { verdict: "supported-false", claim: false, reason: "no path", scope: "src", path: [], enumeratedFiles: ["src/a.ts", "src/b.ts"] },
            unknownCtx(task),
        );
        expect(r.status).toBe("graded");
        expect(r.pass).toBe(false);
    });
});

describe("group 9: empty universe", () => {
    function emptyTask(): InspectTask {
        return baseTask({
            id: "insp-pilot-P1-002",
            prompt: "Inventory the registrations visible here.",
            gold: { kind: "route-set", routes: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }], minRecall: 1, minPrecision: 0.5 },
            candidateUniverse: { id: UNIVERSE_ID, sha256: SHA, count: 0 },
        });
    }
    it("certified empty universe + declared [] -> coverage 1", () => {
        const task = emptyTask();
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.universe = { id: UNIVERSE_ID, sha256: SHA, count: 0, files: [] };
        ctx.tasks[task.id]!.completeness = { complete: true };
        const r = gradeInspectTask(
            task,
            { answer: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }], coverage: { claim: "exhaustive", scope: "src", enumeratedFiles: [] } },
            ctx,
        );
        expect(r.coverageRatio).toBe(1);
    });
    it("absent completeness certification -> goldInvalid, never automatic absence", () => {
        const task = emptyTask();
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.universe = { id: UNIVERSE_ID, sha256: SHA, count: 0, files: [] };
        ctx.tasks[task.id]!.completeness = { complete: false };
        const r = gradeInspectTask(
            task,
            { answer: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }], coverage: { claim: "partial", scope: "src", enumeratedFiles: [] } },
            ctx,
        );
        expect(r.status).toBe("goldInvalid");
        expect(r.coverageRatio).toBeNull();
    });
});

describe("group 10: negative fixtures", () => {
    function negTask(kind: "location" | "scalar" | "file"): InspectTask {
        if (kind === "scalar") {
            return baseTask({
                id: "insp-pilot-N2-001",
                family: "N2",
                answerType: "scalar",
                prompt: "What value does the single key hold?",
                gold: { kind: "scalar", value: "Hello World" },
                negativeControl: true,
                decoys: [],
            });
        }
        if (kind === "file") {
            return baseTask({
                id: "insp-pilot-N5-001",
                family: "N5",
                answerType: "file",
                prompt: "Which single file changed?",
                gold: { kind: "file", path: "src/a.ts" },
                negativeControl: true,
                decoys: [],
            });
        }
        return baseTask({
            id: "insp-pilot-N1-001",
            family: "N1",
            answerType: "location-set",
            prompt: "Where does the literal appear?",
            gold: { kind: "location-set", locations: [{ path: "src/a.ts", line: 7, character: 10 }] },
            negativeControl: true,
            decoys: [],
        });
    }
    function negCtx(task: InspectTask, policy: Record<string, unknown> = {}): FrozenGraderContext {
        const ctx = ctxFor(task);
        ctx.tasks[task.id]!.certifiedRoutes = [];
        Object.assign(ctx.tasks[task.id]!, policy);
        return ctx;
    }
    it("location ±2 passes, ±3 fails (explicit thresholds required)", () => {
        const task = negTask("location");
        const policy = { negativePolicy: { minRecall: 1, minPrecision: 0.5 } };
        const close = gradeInspectTask(task, { answer: [{ path: "src/a.ts", line: 7, character: 12 }] }, negCtx(task, policy));
        expect(close.pass).toBe(true);
        const far = gradeInspectTask(task, { answer: [{ path: "src/a.ts", line: 7, character: 13 }] }, negCtx(task, policy));
        expect(far.pass).toBe(false);
    });
    it("missing negative thresholds -> goldInvalid", () => {
        const task = negTask("location");
        const r = gradeInspectTask(task, { answer: [{ path: "src/a.ts", line: 7, character: 10 }] }, negCtx(task));
        expect(r.status).toBe("goldInvalid");
    });
    it("scalar case-insensitive trim passes; case-sensitive mismatch fails", () => {
        const task = negTask("scalar");
        const loose = gradeInspectTask(task, { answer: { value: "  hello world " } }, negCtx(task, { scalarPolicy: { caseSensitive: false } }));
        expect(loose.pass).toBe(true);
        const strict = gradeInspectTask(task, { answer: { value: "hello world" } }, negCtx(task, { scalarPolicy: { caseSensitive: true } }));
        expect(strict.pass).toBe(false);
    });
    it("file mismatch fails", () => {
        const task = negTask("file");
        const r = gradeInspectTask(task, { answer: { path: "src/b.ts" } }, negCtx(task));
        expect(r.status).toBe("graded");
        expect(r.pass).toBe(false);
    });
    it("added coverage on a negative -> malformed modelFail", () => {
        const task = negTask("file");
        const r = gradeInspectTask(task, { answer: { path: "src/a.ts" }, coverage: { claim: "partial", scope: "src", enumeratedFiles: [] } }, negCtx(task));
        expect(r.status).toBe("modelFail");
    });
});
