/**
 * Gap-closure fixtures for the three BLOCK findings on
 * `scripts/eval/inspect-cohort/grade.ts`:
 *  1. counted route/relation hits must be independently certified;
 *     gold items absent from the certified set invalidate the batch.
 *  2. malformed nested certified facts fail closed (goldInvalid, no throw).
 *  3. absolute/outside-checkout paths never alias into certified identities.
 *
 * Synthetic fixtures only; no real gold, bodies, or holdouts.
 */

import { describe, expect, it } from "vitest";
import type { InspectTask } from "../../../scripts/eval/inspect-cohort/schema.js";
import {
    gradeInspectTask,
    type FrozenGraderContext,
} from "../../../scripts/eval/inspect-cohort/grade.js";

const COMMIT = "a".repeat(40);
const HEAD = "b".repeat(40);
const SHA = "c".repeat(64);
const UNIVERSE_ID = "universe-sealed-001";

function routeTask(overrides: Partial<InspectTask> = {}): InspectTask {
    return {
        id: "insp-pilot-P1-101",
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

function routeCtx(task: InspectTask): FrozenGraderContext {
    return {
        tasks: {
            [task.id]: {
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
            },
        },
    };
}

function relationTask(): InspectTask {
    return routeTask({
        id: "insp-pilot-P2-101",
        family: "P2",
        answerType: "relation-set",
        prompt: "Map the package boundaries in this area.",
        gold: {
            kind: "relation-set",
            relations: [
                {
                    from: "src/a.ts",
                    specifier: "./b",
                    kind: "import",
                    line: 5,
                    witness: { path: "src/a.ts", line: 5 },
                    resolved: "src/b.ts",
                },
            ],
            minRecall: 1,
            minPrecision: 0.5,
        },
    });
}

function relationCtx(task: InspectTask): FrozenGraderContext {
    const ctx = routeCtx(task);
    ctx.tasks[task.id]!.certifiedRoutes = [];
    ctx.tasks[task.id]!.certifiedRelations = [
        {
            from: "src/a.ts",
            specifier: "./b",
            kind: "import",
            line: 5,
            witness: { path: "src/a.ts", line: 5 },
            resolved: "src/b.ts",
        },
    ];
    return ctx;
}

const ANSWER = {
    answer: [{ method: "GET", path: "/users", file: "src/a.ts", line: 3 }],
    coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] },
};

describe("gap 1: hits require independent certification", () => {
    it("gold route absent from certifiedRoutes -> goldInvalid, pass null", () => {
        const task = routeTask();
        const ctx = routeCtx(task);
        ctx.tasks[task.id]!.certifiedRoutes = [];
        const r = gradeInspectTask(task, ANSWER, ctx);
        expect(r.status).toBe("goldInvalid");
        expect(r.pass).toBeNull();
    });

    it("phantom prediction matching gold shape but uncertified -> graded false, precision penalty", () => {
        const task = routeTask();
        const ctx = routeCtx(task);
        // Certified set covers a DIFFERENT route, so the gold item itself is
        // unsupported -> batch invalid... instead certify gold AND check the
        // phantom: certify only gold, predict gold + phantom extra.
        const r = gradeInspectTask(
            task,
            {
                answer: [
                    { method: "GET", path: "/users", file: "src/a.ts", line: 3 },
                    { method: "POST", path: "/phantom", file: "src/b.ts", line: 9 },
                ],
                coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] },
            },
            ctx,
        );
        expect(r.status).toBe("graded");
        expect(r.recall).toBe(1);
        expect(r.precision).toBeCloseTo(0.5);
    });

    it("gold relation absent from certifiedRelations -> goldInvalid, pass null", () => {
        const task = relationTask();
        const ctx = relationCtx(task);
        ctx.tasks[task.id]!.certifiedRelations = [];
        const r = gradeInspectTask(
            task,
            {
                answer: [
                    {
                        from: "src/a.ts",
                        specifier: "./b",
                        kind: "import",
                        line: 5,
                        witness: { path: "src/a.ts", line: 5 },
                        resolved: "src/b.ts",
                    },
                ],
                coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] },
            },
            ctx,
        );
        expect(r.status).toBe("goldInvalid");
        expect(r.pass).toBeNull();
    });
});

describe("gap 2: malformed nested certified facts fail closed", () => {
    it("null entry in certifiedRoutes -> goldInvalid, no throw", () => {
        const task = routeTask();
        const ctx = routeCtx(task);
        (ctx.tasks[task.id]!.certifiedRoutes as unknown[]).push(null);
        let r: ReturnType<typeof gradeInspectTask> | undefined;
        expect(() => {
            r = gradeInspectTask(task, ANSWER, ctx);
        }).not.toThrow();
        expect(r!.status).toBe("goldInvalid");
        expect(r!.pass).toBeNull();
    });

    it("primitive entry in certifiedRelations -> goldInvalid, no throw", () => {
        const task = relationTask();
        const ctx = relationCtx(task);
        ctx.tasks[task.id]!.certifiedRelations = ["src/a.ts" as unknown as never];
        let r: ReturnType<typeof gradeInspectTask> | undefined;
        expect(() => {
            r = gradeInspectTask(
                task,
                {
                    answer: [
                        {
                            from: "src/a.ts",
                            specifier: "./b",
                            kind: "import",
                            line: 5,
                            witness: { path: "src/a.ts", line: 5 },
                            resolved: "src/b.ts",
                        },
                    ],
                    coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] },
                },
                ctx,
            );
        }).not.toThrow();
        expect(r!.status).toBe("goldInvalid");
        expect(r!.pass).toBeNull();
    });

    it("relation with null witness -> goldInvalid, no throw", () => {
        const task = relationTask();
        const ctx = relationCtx(task);
        (ctx.tasks[task.id]!.certifiedRelations as unknown[])[0] = {
            from: "src/a.ts",
            specifier: "./b",
            kind: "import",
            line: 5,
            witness: null,
            resolved: "src/b.ts",
        };
        let r: ReturnType<typeof gradeInspectTask> | undefined;
        expect(() => {
            r = gradeInspectTask(
                task,
                {
                    answer: [
                        {
                            from: "src/a.ts",
                            specifier: "./b",
                            kind: "import",
                            line: 5,
                            witness: { path: "src/a.ts", line: 5 },
                            resolved: "src/b.ts",
                        },
                    ],
                    coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] },
                },
                ctx,
            );
        }).not.toThrow();
        expect(r!.status).toBe("goldInvalid");
        expect(r!.pass).toBeNull();
    });

    it("certified fact with extra key -> goldInvalid, no throw", () => {
        const task = routeTask();
        const ctx = routeCtx(task);
        (ctx.tasks[task.id]!.certifiedRoutes as unknown[])[0] = {
            method: "GET",
            path: "/users",
            file: "src/a.ts",
            line: 3,
            verified: true,
        };
        let r: ReturnType<typeof gradeInspectTask> | undefined;
        expect(() => {
            r = gradeInspectTask(task, ANSWER, ctx);
        }).not.toThrow();
        expect(r!.status).toBe("goldInvalid");
        expect(r!.pass).toBeNull();
    });
});

describe("gap 3: absolute/outside paths never alias", () => {
    it("absolute model path does not count as a hit", () => {
        const task = routeTask();
        const r = gradeInspectTask(
            task,
            {
                answer: [{ method: "GET", path: "/users", file: "/checkout/packages/core/src/a.ts", line: 3 }],
                coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] },
            },
            routeCtx(task),
        );
        // Absolute paths are outside the strict subpath-relative contract:
        // either malformed (modelFail) or an unsupported miss — never a hit.
        expect(r.pass).toBe(false);
        expect(r.recall ?? 0).toBe(0);
    });

    it("outside-checkout absolute path sharing the subpath segment does not alias", () => {
        const task = routeTask();
        const r = gradeInspectTask(
            task,
            {
                answer: [{ method: "GET", path: "/users", file: "/outside/packages/core/src/a.ts", line: 3 }],
                coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] },
            },
            routeCtx(task),
        );
        expect(r.pass).toBe(false);
        expect(r.recall ?? 0).toBe(0);
    });

    it("repo/subpath-prefixed relative path does not alias", () => {
        const task = routeTask();
        const r = gradeInspectTask(
            task,
            {
                answer: [{ method: "GET", path: "/users", file: "packages/core/src/a.ts", line: 3 }],
                coverage: { claim: "partial", scope: "src", enumeratedFiles: ["src/a.ts"] },
            },
            routeCtx(task),
        );
        expect(r.pass).toBe(false);
        expect(r.recall ?? 0).toBe(0);
    });

    it("negative location absolute path is never a hit", () => {
        const task = routeTask({
            id: "insp-pilot-N1-101",
            family: "N1",
            answerType: "location-set",
            prompt: "Where does the literal appear?",
            gold: { kind: "location-set", locations: [{ path: "src/a.ts", line: 7, character: 10 }] },
            negativeControl: true,
            decoys: [],
        });
        const ctx = routeCtx(task);
        ctx.tasks[task.id]!.certifiedRoutes = [];
        Object.assign(ctx.tasks[task.id]!, { negativePolicy: { minRecall: 1, minPrecision: 0.5 } });
        const r = gradeInspectTask(
            task,
            { answer: [{ path: "/checkout/packages/core/src/a.ts", line: 7, character: 10 }] },
            ctx,
        );
        expect(r.pass).toBe(false);
    });
});
