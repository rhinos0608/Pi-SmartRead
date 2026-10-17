import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInspectCli } from "../../../scripts/eval/inspect-cohort/run.js";
import { validateInspectTask, type InspectTask } from "../../../scripts/eval/inspect-cohort/schema.js";
import { assertNoHoldoutExposure } from "../../../scripts/eval/inspect-cohort/run.js";

/**
 * Runner anchor-collision protection (synthetic only).
 *
 * Parse guards in schema.ts reject only the CURRENT task's own
 * universe id/sha and patch sha as anchors. They do not protect other
 * tasks' metadata. The runner holdout gate must therefore never suppress
 * a pooled non-gold marker through a current-task gold anchor, even when
 * the strings are exactly equal. ALL-task gold-path pooling is preserved:
 * a current-task gold-path anchor still suppresses its own (and pooled
 * cross-task identical gold-path) marker when there is no protected
 * collision.
 */
describe("inspect-cohort runner anchor-collision protection (synthetic)", () => {
    const SYN_COMMIT = "f".repeat(40);
    const P = "src/synth-collide.ts";
    const SHA_LIKE = "d".repeat(64);
    const PATCH_SHA = "e".repeat(40);

    const pilotA = (over: Partial<InspectTask> = {}, goldPath: string = P): InspectTask => ({
        id: "syn-pilot-A", split: "pilot", repo: "synthetic/repo", commit: SYN_COMMIT, subpath: "src", family: "N5",
        prompt: `Synthetic question naming ${goldPath} as the module under test.`, scope: "", answerType: "file",
        gold: { kind: "file", path: goldPath },
        candidateUniverse: { id: "synthetic-universe-a", sha256: "a".repeat(64), count: 1 },
        decoys: [], negativeControl: true, derivation: "synthetic fixture",
        agreement: "agree", labelers: ["syn-a", "syn-b"], adjudication: "agree",
        snapshot: { head: SYN_COMMIT, clean: true }, anchors: [goldPath],
        ...over,
    });
    const otherPilot = (over: Partial<InspectTask> = {}): InspectTask => ({
        ...pilotA({}, "src/unrelated.ts"), id: "syn-other", prompt: "Unrelated synthetic question.",
        anchors: undefined, candidateUniverse: { id: "synthetic-universe-b", sha256: "b".repeat(64), count: 1 },
        ...over,
    });
    const writeTasks = (dir: string, tasks: InspectTask[]): string => {
        const file = join(dir, "tasks.jsonl");
        writeFileSync(file, tasks.map((task) => JSON.stringify(task)).join("\n") + "\n");
        return file;
    };
    const dryOnlyA = async (tasks: InspectTask[]): Promise<void> => {
        const dir = mkdtempSync(join(tmpdir(), "inspect-collide-"));
        const file = writeTasks(dir, tasks);
        await runInspectCli({ tasks: file, split: "pilot", arms: ["off"], replicates: 1, maxTurns: 1,
            model: "provider/model-v2", thinking: "high", timeoutMs: 1000, out: join(dir, "out"), dryRun: true,
            taskIds: ["syn-pilot-A"], limit: null, openHoldout: false, freezeFile: null, piBin: "pi" });
    };

    it("parse allows the current gold anchor while runner blocks a holdout-id collision", async () => {
        const tasks = [pilotA(), otherPilot({ id: P, split: "holdout" })];
        expect(validateInspectTask(tasks[0])).toEqual([]);
        await expect(dryOnlyA(tasks)).rejects.toThrow(/blacklist/);
    });

    it("parse allows the current gold anchor while runner blocks an other-split universe-id collision", async () => {
        const tasks = [pilotA(), otherPilot({ id: "syn-dev-x", split: "dev",
            candidateUniverse: { id: P, sha256: "b".repeat(64), count: 1 } })];
        expect(validateInspectTask(tasks[0])).toEqual([]);
        await expect(dryOnlyA(tasks)).rejects.toThrow(/blacklist/);
    });

    it("parse allows the current sha-like gold anchor while runner blocks an other-task universe-sha collision", async () => {
        const tasks = [pilotA({}, SHA_LIKE), otherPilot({ candidateUniverse: { id: "u-b", sha256: SHA_LIKE, count: 1 } })];
        expect(validateInspectTask(tasks[0])).toEqual([]);
        await expect(dryOnlyA(tasks)).rejects.toThrow(/blacklist/);
    });

    it("parse allows the current gold anchor while runner blocks an other-split prompt collision", async () => {
        const tasks = [pilotA(), otherPilot({ id: "syn-dev-x", split: "dev", prompt: P })];
        expect(validateInspectTask(tasks[0])).toEqual([]);
        await expect(dryOnlyA(tasks)).rejects.toThrow(/blacklist/);
    });

    it("parse allows the current gold anchor while runner blocks a same-split other-task universe-id collision", async () => {
        const tasks = [pilotA(), otherPilot({ split: "pilot",
            candidateUniverse: { id: P, sha256: "b".repeat(64), count: 1 } })];
        expect(validateInspectTask(tasks[0])).toEqual([]);
        await expect(dryOnlyA(tasks)).rejects.toThrow(/blacklist/);
    });

    it("parse allows the current gold path while runner blocks a cross-task patch-sha collision", async () => {
        const goldPath = PATCH_SHA;
        const current = pilotA({}, goldPath);
        const otherEvidence: InspectTask = {
            ...otherPilot(), id: "syn-pilot-E", family: "P5", answerType: "evidence-chain", negativeControl: false,
            prompt: "Unrelated synthetic evidence question.", scope: "src",
            gold: { kind: "evidence-chain", patch: { sha: PATCH_SHA, ranges: [{ path: "src/other.ts", start: 1, end: 2 }] },
                relations: [{ from: "src/other.ts", specifier: "./x", kind: "import", line: 1,
                    witness: { path: "src/other.ts", line: 1 }, resolved: "src/x.ts" }],
                minRecall: 1, minPrecision: 1 },
            decoys: ["decoy"], anchors: undefined,
        };
        expect(validateInspectTask(current)).toEqual([]);
        expect(validateInspectTask(otherEvidence)).toEqual([]);
        await expect(dryOnlyA([current, otherEvidence])).rejects.toThrow(/blacklist/);
    });

    it("runner still accepts a valid gold-path anchor with no protected collision (control)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "inspect-collide-ctrl-"));
        const file = writeTasks(dir, [pilotA(), otherPilot()]);
        const result = await runInspectCli({ tasks: file, split: "pilot", arms: ["off"], replicates: 1, maxTurns: 1,
            model: "provider/model-v2", thinking: "high", timeoutMs: 1000, out: join(dir, "out"), dryRun: true,
            taskIds: ["syn-pilot-A"], limit: null, openHoldout: false, freezeFile: null, piBin: "pi" });
        const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { sessions: unknown[] };
        expect(manifest.sessions).toHaveLength(1);
    });

    it("general blacklist and absolute-path markers are never suppressible by anchors", () => {
        expect(() => assertNoHoldoutExposure("prompt grade.ts", ["grade.ts"], ["grade.ts"])).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure("prompt /tmp/gold/x", ["/tmp/gold/x"], ["/tmp/gold/x"])).toThrow(/blacklist/);
    });

    it("unanchored and substring markers still hit without anchors (no-anchor controls)", () => {
        expect(() => assertNoHoldoutExposure(`prompt ${P}`, [P], [])).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure(`prompt ${P}`, [P], ["src/synth-collide"])).toThrow(/blacklist/);
    });

    it("parse rejects an own universe-sha anchor (current-task guard, not runner collision)", () => {
        const sha = "c".repeat(64);
        const task = pilotA({ prompt: `Synthetic question naming ${sha}.`,
            candidateUniverse: { id: "synthetic-universe-c", sha256: sha, count: 1 } }, sha);
        expect(validateInspectTask(task).join("; ")).toMatch(/can never be an anchor/);
    });
});
