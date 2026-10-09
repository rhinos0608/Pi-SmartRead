import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CloudJudge } from "../../../src/judge/cloud-judge.js";
import {
    PLAN_CLIENT_ATTEMPTS_PER_REQUEST,
    PLAN_MAX_REPLICATES,
    deriveFullRunPlan,
    scalePlannedRequests,
} from "../../../scripts/eval/judge/model-comparison-plan.js";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "") || "/";
const PINNED_SOURCE_FIXTURE = "export function fixtureSymbol() { return true; }";

function fixtureDataDir(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "judge-plan-test-")));
    const rows = Array.from({ length: 314 }, (_, index) => {
        const set = index < 159 ? "a" : "b";
        const localIndex = set === "a" ? index : index - 159;
        const count = set === "a" ? 159 : 155;
        const queryIndex = Math.floor(localIndex * 22 / count);
        const label = index < 78 ? "gold" : index < 226 ? "hard_negative" : "easy_negative";
        return JSON.stringify({ qid: `${set}-${queryIndex + 1}`, query: `fixture query ${queryIndex + 1}`, file: "src/search/grep-cascade.ts", startLine: 1, endLine: 1, symbol: null, label });
    });
    writeFileSync(join(root, "set-a.jsonl"), `${rows.slice(0, 159).join("\n")}\n`);
    writeFileSync(join(root, "set-b.jsonl"), `${rows.slice(159).join("\n")}\n`);
    return root;
}

describe("deriveFullRunPlan (offline, no network)", () => {
    it("covers all 314 items in 44 namespaced query groups with the normal question builder", async () => {
        const dataDir = fixtureDataDir();
        const plan = await deriveFullRunPlan({ repoRoot: REPO_ROOT, dataDir, sourceReader: () => PINNED_SOURCE_FIXTURE });
        rmSync(dataDir, { recursive: true });
        expect(plan.totalUnits).toBe(314);
        expect(plan.totalQueryGroups).toBe(44);
        expect(plan.labelCounts).toEqual({ gold: 78, hard_negative: 148, easy_negative: 88 });
        expect(plan.fixtureSets).toEqual([
            { set: "a", rows: 159, queries: 22 },
            { set: "b", rows: 155, queries: 22 },
        ]);
        expect(plan.fixtureSha).toMatch(/^[0-9a-f]{64}$/);
        expect(plan.questionBuilder).toBe("unitRelevanceQuestion");
        expect(plan.models).toHaveLength(3);
        expect(plan.maxReplicates).toBe(PLAN_MAX_REPLICATES);
        // Every observation binds the submitted wire shape.
        expect(plan.observations.length).toBeGreaterThan(0);
        for (const obs of plan.observations) {
            expect(obs.questionCount).toBeGreaterThan(0);
            expect(obs.questionHash).toMatch(/^[0-9a-f]{64}$/);
            expect(obs.stateHash).toMatch(/^[0-9a-f]{64}$/);
            expect(obs.requestBytes).toBeGreaterThan(0);
        }
        // Set namespaces never merge: observation group keys carry the set prefix.
        const keys = new Set(plan.observations.map((o) => o.groupKey));
        expect(keys.size).toBe(44);
        expect([...keys].every((k) => k.startsWith("a:") || k.startsWith("b:"))).toBe(true);
    });

    it("counts the planned warmup plus every group batch per arm (measured, not hardcoded)", async () => {
        const dataDir = fixtureDataDir();
        const plan = await deriveFullRunPlan({ repoRoot: REPO_ROOT, dataDir, sourceReader: () => PINNED_SOURCE_FIXTURE });
        rmSync(dataDir, { recursive: true });
        // 3 arms x (1 warmup + 44 groups); each group currently packs to one batch.
        expect(plan.warmupRequestsSingleRun).toBe(3);
        expect(plan.groupWireRequestsSingleRun).toBe(44 * 3);
        expect(plan.plannedWireRequestsSingleRun).toBe(3 + 44 * 3);
        expect(plan.fiveReplicatePlannedRequests).toBe(plan.plannedWireRequestsSingleRun * 5);
        expect(plan.attemptUpperBound).toBe(
            plan.fiveReplicatePlannedRequests * PLAN_CLIENT_ATTEMPTS_PER_REQUEST + 6,
        );
        expect(plan.groupsRequiringSplit).toEqual([]);
    });

    it.skipIf(process.env.PI_SMARTREAD_PRIVATE_ARTIFACT_AUDIT !== "1")("reads the actual pinned source from git history", async () => {
        const dataDir = fixtureDataDir();
        try {
            const plan = await deriveFullRunPlan({ repoRoot: REPO_ROOT, dataDir });
            expect(plan.totalUnits).toBe(314);
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it("RED: an oversized query group splits into multiple batches (one-batch is measured, not assumed)", async () => {
        const hugeText = "x".repeat(30_000);
        const items = Array.from({ length: 8 }, (_, i) => ({
            id: `u${i}`,
            state: { path: "src/search/grep-cascade.ts", symbol: "s", text: hugeText },
            question: (ref: string) => ({
                type: "noul" as const,
                instructions: `Does \`${ref}\` matter?`,
                criteria: { true: "t", false: "f" },
            }),
        }));
        let wireRequests = 0;
        const stub = async (_url: string, init?: RequestInit) => {
            wireRequests += 1;
            const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, unknown> };
            const answers: Record<string, number> = {};
            for (const key of Object.keys(body.questions)) answers[key] = 0.01;
            return new Response(JSON.stringify({ answers, usage: { input_tokens: 1, cost: 0 } }), { status: 200 });
        };
        const judge = new CloudJudge({ apiKey: "offline", model: "offline", cache: null, fetchFn: stub as never });
        await judge.judgeNouls({ shared: { query: "q" }, items });
        expect(wireRequests).toBeGreaterThan(1);
    });
});

describe("scalePlannedRequests", () => {
    it("rejects replicates above the frozen max and non-positive inputs", () => {
        expect(scalePlannedRequests(135, 5, 3)).toBe(2025);
        expect(() => scalePlannedRequests(135, 6, 3)).toThrow(/1\.\.5/);
        expect(() => scalePlannedRequests(0, 5, 3)).toThrow(/positive integer/);
    });
});

export { REPO_ROOT };
