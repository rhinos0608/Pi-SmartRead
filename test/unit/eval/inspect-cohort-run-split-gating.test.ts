import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    assertNoHoldoutExposure,
    collectGoldPathMarkers,
    collectHandoffBlacklist,
    runInspectCli,
} from "../../../scripts/eval/inspect-cohort/run.js";
import type { InspectTask } from "../../../scripts/eval/inspect-cohort/schema.js";

/**
 * Amendment A5 — split-gated pooled gold-path markers (synthetic only).
 *
 * The pooled GOLD-PATH (path/basename) markers in the holdout-exposure
 * blacklist come only from tasks in OTHER splits than the task being
 * launched. Same-split, non-current-task gold-path coincidences are
 * permitted. Unchanged and still enforced: the current task's own A3 gold
 * checks, globally protected identifiers/hashes (holdout ids, universe
 * ids/shas, patch shas), other-split prompts, and privacy restrictions.
 */
describe("inspect-cohort runner A5 split-gated gold-path pooling (synthetic)", () => {
    const SYN_COMMIT = "f".repeat(40);
    const OWN_GOLD = "src/synth-a5-current.ts";
    const SAME_SPLIT_GOLD = "src/synth-a5-samesplit.ts";
    const OTHER_SPLIT_GOLD = "src/synth-a5-devsplit.ts";
    const P = "src/synth-a5-collide.ts";
    const SHA_LIKE = "d".repeat(64);
    const PATCH_SHA = "e".repeat(40);

    const baseTask = (over: Partial<InspectTask> = {}): InspectTask => ({
        id: "syn-pilot-A5-A", split: "pilot", repo: "synthetic/repo", commit: SYN_COMMIT, subpath: "src",
        family: "N5", prompt: "Synthetic question about an unrelated synthetic module.", scope: "",
        answerType: "file", gold: { kind: "file", path: OWN_GOLD },
        candidateUniverse: { id: "synthetic-universe-a5-a", sha256: "a".repeat(64), count: 1 },
        decoys: [], negativeControl: true, derivation: "synthetic fixture",
        agreement: "agree", labelers: ["syn-a", "syn-b"], adjudication: "agree",
        snapshot: { head: SYN_COMMIT, clean: true },
        ...over,
    });
    const writeTasks = (dir: string, tasks: InspectTask[]): string => {
        const file = join(dir, "tasks.jsonl");
        writeFileSync(file, tasks.map((task) => JSON.stringify(task)).join("\n") + "\n");
        return file;
    };
    const dryRun = async (tasks: InspectTask[], taskIds: string[] | null = null) => {
        const dir = mkdtempSync(join(tmpdir(), "inspect-a5-"));
        const file = writeTasks(dir, tasks);
        return runInspectCli({ tasks: file, split: "pilot", arms: ["off"], replicates: 1, maxTurns: 1,
            model: "provider/model-v2", thinking: "high", timeoutMs: 1000, out: join(dir, "out"),
            dryRun: true, taskIds, limit: null, openHoldout: false, freezeFile: null, piBin: "pi" });
    };

    it("a. ALLOWS a same-split other-task gold path in a prompt", async () => {
        const tasks = [
            baseTask({ prompt: `Synthetic question mentioning ${SAME_SPLIT_GOLD} in passing.` }),
            baseTask({ id: "syn-pilot-A5-B", prompt: "Unrelated synthetic question.",
                gold: { kind: "file", path: SAME_SPLIT_GOLD },
                candidateUniverse: { id: "synthetic-universe-a5-b", sha256: "b".repeat(64), count: 1 } }),
        ];
        const result = await dryRun(tasks);
        const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { sessions: unknown[] };
        expect(manifest.sessions).toHaveLength(2);
    });

    it("b. BLOCKS an other-split task's gold path in a prompt", async () => {
        const tasks = [
            baseTask({ prompt: `Synthetic question mentioning ${OTHER_SPLIT_GOLD} in passing.` }),
            baseTask({ id: "syn-dev-A5-X", split: "dev", prompt: "Unrelated dev question.",
                gold: { kind: "file", path: OTHER_SPLIT_GOLD },
                candidateUniverse: { id: "synthetic-universe-a5-x", sha256: "c".repeat(64), count: 1 } }),
        ];
        await expect(dryRun(tasks)).rejects.toThrow(/blacklist/);
    });

    it("c. BLOCKS the current task's own gold path absent an exact declared anchor (A3)", async () => {
        // Gate primitive: own gold in the blacklist with no anchor still hits.
        expect(() => assertNoHoldoutExposure(`Synthetic question naming ${OWN_GOLD}.`,
            ["/tmp/tasks.jsonl", OWN_GOLD], [])).toThrow(/blacklist/);
        // End to end: the task never launches (seal-time validator fails it closed).
        const tasks = [baseTask({ prompt: `Synthetic question naming ${OWN_GOLD} as the module under test.` })];
        await expect(dryRun(tasks)).rejects.toThrow(/leaks gold|blacklist/);
    });

    it("d. BLOCKS protected ids/hashes from a same-split task", async () => {
        const protId = "syn-prot-universe";
        const protSha = "d".repeat(64);
        const tasks = [
            baseTask({ prompt: `Synthetic question mentioning ${protId} and ${protSha}.` }),
            baseTask({ id: "syn-pilot-A5-B", prompt: "Unrelated synthetic question.",
                gold: { kind: "file", path: SAME_SPLIT_GOLD },
                candidateUniverse: { id: protId, sha256: protSha, count: 1 } }),
        ];
        await expect(dryRun(tasks)).rejects.toThrow(/blacklist/);
    });

    it("e1. anchor cannot suppress a holdout-id collision", async () => {
        const current = baseTask({ prompt: `Synthetic question naming ${P} as the module under test.`,
            gold: { kind: "file", path: P }, anchors: [P] });
        const holdout = baseTask({ id: P, split: "holdout", prompt: "Unrelated synthetic question.",
            gold: { kind: "file", path: "src/unrelated.ts" }, anchors: undefined,
            candidateUniverse: { id: "synthetic-universe-a5-h", sha256: "b".repeat(64), count: 1 } });
        await expect(dryRun([current, holdout], [current.id])).rejects.toThrow(/blacklist/);
    });

    it("e2. anchor cannot suppress an other-split universe-id collision", async () => {
        const current = baseTask({ prompt: `Synthetic question naming ${P} as the module under test.`,
            gold: { kind: "file", path: P }, anchors: [P] });
        const other = baseTask({ id: "syn-dev-A5-X", split: "dev", prompt: "Unrelated dev question.",
            gold: { kind: "file", path: "src/unrelated.ts" }, anchors: undefined,
            candidateUniverse: { id: P, sha256: "b".repeat(64), count: 1 } });
        await expect(dryRun([current, other], [current.id])).rejects.toThrow(/blacklist/);
    });

    it("e3. anchor cannot suppress an other-task universe-sha collision", async () => {
        const current = baseTask({ prompt: `Synthetic question naming ${SHA_LIKE}.`,
            gold: { kind: "file", path: SHA_LIKE }, anchors: [SHA_LIKE] });
        const other = baseTask({ id: "syn-pilot-A5-B", prompt: "Unrelated synthetic question.",
            gold: { kind: "file", path: "src/unrelated.ts" }, anchors: undefined,
            candidateUniverse: { id: "u-a5-b", sha256: SHA_LIKE, count: 1 } });
        await expect(dryRun([current, other], [current.id])).rejects.toThrow(/blacklist/);
    });

    it("e4. anchor cannot suppress an other-split prompt collision", async () => {
        const current = baseTask({ prompt: `Synthetic question naming ${P} as the module under test.`,
            gold: { kind: "file", path: P }, anchors: [P] });
        const other = baseTask({ id: "syn-dev-A5-X", split: "dev", prompt: P,
            gold: { kind: "file", path: "src/unrelated.ts" }, anchors: undefined,
            candidateUniverse: { id: "synthetic-universe-a5-x", sha256: "b".repeat(64), count: 1 } });
        await expect(dryRun([current, other], [current.id])).rejects.toThrow(/blacklist/);
    });

    it("e5. anchor cannot suppress a same-split other-task universe-id collision", async () => {
        const current = baseTask({ prompt: `Synthetic question naming ${P} as the module under test.`,
            gold: { kind: "file", path: P }, anchors: [P] });
        const other = baseTask({ id: "syn-pilot-A5-B", prompt: "Unrelated synthetic question.",
            gold: { kind: "file", path: "src/unrelated.ts" }, anchors: undefined,
            candidateUniverse: { id: P, sha256: "b".repeat(64), count: 1 } });
        await expect(dryRun([current, other], [current.id])).rejects.toThrow(/blacklist/);
    });

    it("e6. anchor cannot suppress a cross-task patch-sha collision", async () => {
        const current = baseTask({ prompt: `Synthetic question naming ${PATCH_SHA}.`,
            gold: { kind: "file", path: PATCH_SHA }, anchors: [PATCH_SHA] });
        const other: InspectTask = { ...baseTask({ id: "syn-pilot-A5-E", family: "P5", answerType: "evidence-chain",
            negativeControl: false, prompt: "Unrelated synthetic evidence question.", scope: "src",
            anchors: undefined }),
        gold: { kind: "evidence-chain", patch: { sha: PATCH_SHA, ranges: [{ path: "src/other.ts", start: 1, end: 2 }] },
            relations: [{ from: "src/other.ts", specifier: "./x", kind: "import", line: 1,
                witness: { path: "src/other.ts", line: 1 }, resolved: "src/x.ts" }],
            minRecall: 1, minPrecision: 1 },
        decoys: ["decoy"] };
        await expect(dryRun([current, other], [current.id])).rejects.toThrow(/blacklist/);
    });

    it("f. a per-split file yields zero pooled gold-path markers but keeps protected identifiers", () => {
        const tasks = [
            baseTask(),
            baseTask({ id: "syn-pilot-A5-B", prompt: "Unrelated synthetic question.",
                gold: { kind: "file", path: SAME_SPLIT_GOLD },
                candidateUniverse: { id: "synthetic-universe-a5-b", sha256: "b".repeat(64), count: 1 } }),
            baseTask({ id: "syn-pilot-A5-C", prompt: "Another unrelated synthetic question.",
                gold: { kind: "file", path: OTHER_SPLIT_GOLD },
                candidateUniverse: { id: "synthetic-universe-a5-c", sha256: "c".repeat(64), count: 1 } }),
        ];
        const markers = collectHandoffBlacklist(tasks, "pilot");
        for (const task of tasks) {
            for (const marker of collectGoldPathMarkers(task.gold)) {
                expect(markers).not.toContain(marker);
            }
        }
        expect(markers).toContain("synthetic-universe-a5-a");
        expect(markers).toContain("synthetic-universe-a5-b");
        expect(markers).toContain("synthetic-universe-a5-c");
        expect(markers).toContain("a".repeat(64));
        expect(markers).toContain("b".repeat(64));
        expect(markers).toContain("c".repeat(64));
    });
});
