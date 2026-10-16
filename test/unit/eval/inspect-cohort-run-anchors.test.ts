import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoHoldoutExposure, runInspectCli } from "../../../scripts/eval/inspect-cohort/run.js";
import { validateInspectTask, type InspectTask } from "../../../scripts/eval/inspect-cohort/schema.js";

/**
 * A3 declared-anchor conformity for the runner holdout gate (synthetic only).
 *
 * Protocol Amendment A3 (protocol §16): a gold string that EXACTLY equals a
 * declared `anchors` entry verbatim in the question is not a leak. The seal
 * validator (schema.ts) already implements this; run.ts must conform.
 */
describe("inspect-cohort runner A3 declared-anchor conformity (synthetic)", () => {
    const SYN_COMMIT = "f".repeat(40);
    const SHARED = "src/synth-shared.ts";
    const OTHER = "src/synth-other.ts";
    const anchorTaskA = (): InspectTask => ({
        id: "syn-pilot-N5-A", split: "pilot", repo: "synthetic/repo", commit: SYN_COMMIT, subpath: "src", family: "N5",
        prompt: `Synthetic question naming ${SHARED} as the module under test.`, scope: "", answerType: "file",
        gold: { kind: "file", path: SHARED },
        candidateUniverse: { id: "synthetic-universe-a", sha256: "a".repeat(64), count: 1 },
        decoys: [], negativeControl: true, derivation: "synthetic fixture",
        agreement: "agree", labelers: ["syn-a", "syn-b"], adjudication: "agree",
        snapshot: { head: SYN_COMMIT, clean: true }, anchors: [SHARED],
    });
    const crossTaskB = (): InspectTask => ({
        ...anchorTaskA(), id: "syn-pilot-N5-B",
        prompt: "Synthetic question about an unrelated synthetic module.",
        candidateUniverse: { id: "synthetic-universe-b", sha256: "b".repeat(64), count: 1 },
        anchors: undefined,
    });
    const writeTasks = (dir: string, tasks: InspectTask[]): string => {
        const file = join(dir, "tasks.jsonl");
        writeFileSync(file, tasks.map((task) => JSON.stringify(task)).join("\n") + "\n");
        return file;
    };

    it("holds schema validation for the anchored own-gold fixtures", () => {
        expect(validateInspectTask(anchorTaskA())).toEqual([]);
        expect(validateInspectTask(crossTaskB())).toEqual([]);
    });

    it("RED: exact declared anchor suppresses the pooled gold marker", () => {
        expect(() => assertNoHoldoutExposure(`prompt ${SHARED}`, [SHARED], [SHARED])).not.toThrow();
    });

    it("RED: dry-run accepts a declared anchor matching own and cross-task gold", async () => {
        const dir = mkdtempSync(join(tmpdir(), "inspect-anchor-"));
        const tasks = writeTasks(dir, [anchorTaskA(), crossTaskB()]);
        const result = await runInspectCli({ tasks, split: "pilot", arms: ["off", "on"], replicates: 1, maxTurns: 1,
            model: "provider/model-v2", thinking: "high", timeoutMs: 1000, out: join(dir, "out"), dryRun: true,
            taskIds: null, limit: null, openHoldout: false, freezeFile: null, piBin: "pi" });
        const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { sessions: unknown[] };
        expect(manifest.sessions).toHaveLength(4);
    });

    it("still rejects unanchored paths, substring anchors, wrong anchors, and other hidden answers", () => {
        expect(() => assertNoHoldoutExposure(`prompt ${SHARED}`, [SHARED], [])).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure(`prompt ${SHARED}`, [SHARED], ["src/synth-shared"])).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure(`prompt ${SHARED}`, [SHARED], [OTHER])).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure(`prompt ${SHARED} and ${OTHER}`, [SHARED, OTHER], [SHARED])).toThrow(/blacklist/);
    });

    it("anchors never bypass the general blacklist or absolute paths", () => {
        expect(() => assertNoHoldoutExposure("prompt grade.ts", ["grade.ts"], ["grade.ts"])).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure("prompt /tmp/gold/x", ["/tmp/gold/x"], ["/tmp/gold/x"])).toThrow(/blacklist/);
    });

    it("dry-run still rejects a task whose anchor is a protected universe hash", async () => {
        const universeSha = "c".repeat(64);
        const task: InspectTask = { ...anchorTaskA(), id: "syn-pilot-N5-C", prompt: `Synthetic question naming ${universeSha}.`,
            candidateUniverse: { id: "synthetic-universe-c", sha256: universeSha, count: 1 }, anchors: [universeSha] };
        expect(validateInspectTask(task).join("; ")).toMatch(/can never be an anchor/);
        const dir = mkdtempSync(join(tmpdir(), "inspect-anchor-neg-"));
        const tasks = writeTasks(dir, [task]);
        await expect(runInspectCli({ tasks, split: "pilot", arms: ["off"], replicates: 1, maxTurns: 1,
            model: "provider/model-v2", thinking: "high", timeoutMs: 1000, out: join(dir, "out"), dryRun: true,
            taskIds: null, limit: null, openHoldout: false, freezeFile: null, piBin: "pi" })).rejects.toThrow(/can never be an anchor/);
    });
});
