import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { gradeInspectTask } from "../../../scripts/eval/inspect-cohort/grade.js";
import type { FrozenGraderContext } from "../../../scripts/eval/inspect-cohort/grade.js";
import type { InspectTask } from "../../../scripts/eval/inspect-cohort/schema.js";

const task: InspectTask = {
    id: "insp-pilot-P1-001", split: "pilot", repo: "owner__name", commit: "a".repeat(40), subpath: "pkg",
    family: "P1", prompt: "Inventory routes.", scope: "src", answerType: "route-set",
    gold: { kind: "route-set", routes: [{ method: "GET", path: "/real", file: "src/routes.ts", line: 3 }], minRecall: 1, minPrecision: 1 },
    candidateUniverse: { id: "u", sha256: "c".repeat(64), count: 1 }, decoys: ["comment-decoy"], negativeControl: false,
    derivation: "synthetic fixture", agreement: "agree", labelers: ["one", "two"], adjudication: "agree", snapshot: { head: "b".repeat(40), clean: true },
};
function context(): FrozenGraderContext {
    return { tasks: { [task.id]: {
        binding: { repo: task.repo, commit: task.commit, subpath: task.subpath, scope: task.scope, snapshotHead: task.snapshot.head, snapshotClean: true },
        universe: { id: "u", sha256: "c".repeat(64), count: 1, files: ["src/routes.ts"] }, sourceLines: { "src/routes.ts": 4 }, trackedFiles: ["src/routes.ts"],
        certifiedRoutes: [{ method: "GET", path: "/real", file: "src/routes.ts", line: 3 }], certifiedRelations: [], certifiedEdges: [], completeness: { complete: true }, manifestRef: "synthetic-seal",
    } } };
}
const answer = (route: string, claim: "partial" | "exhaustive" = "partial", line = 3) => ({ answer: [{ method: "GET", path: route, file: "src/routes.ts", line }], coverage: { claim, scope: "src", enumeratedFiles: ["src/routes.ts"] } });

describe("inspect cohort adversarial grader fixtures", () => {
    it("rejects an answer citing the commented route decoy in the synthetic source fixture", async () => {
        const source = await readFile(new URL("../../fixtures/eval/inspect-cohort/source/routes.ts", import.meta.url), "utf8");
        expect(source.split("\n")[3]).toContain("// Decoy: app.get('/decoy'");
        expect(gradeInspectTask(task, answer("/decoy", "partial", 4), context()).pass).toBe(false);
    });
    it("marks renderer-truncated exhaustive claims as false completeness", () => {
        const ctx = context(); ctx.tasks[task.id]!.completeness = { complete: false, truncated: true };
        expect(gradeInspectTask(task, answer("/real", "exhaustive"), ctx).falseCompleteness).toBe(true);
    });
    it("rejects unsupported-syntax claims that lack certified source support", () => expect(gradeInspectTask(task, answer("/decorator"), context()).pass).toBe(false));
});
