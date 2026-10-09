import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSPECT_ANSWER_SHAPES, toInspectRunnerView } from "../../../scripts/eval/inspect-cohort/schema.js";
import { assertNoHoldoutExposure, buildInspectTaskPrompt, checkInspectSessionIdentity, checkPromptParity, collectGoldPathMarkers, resolveInspectArms, runInspectCli, selectorIdentityMismatch, sessionValidity, summarizeExclusions, type InspectSelectorIdentity } from "../../../scripts/eval/inspect-cohort/run.js";
import { INSPECT_GENERIC_TEXT, INSPECT_INSTRUCTED_TEXT } from "../../../scripts/eval/inspect-cohort/prompts.js";
import { scanLogForContamination } from "../../../scripts/eval/teb/run.js";
import type { InspectTask } from "../../../scripts/eval/inspect-cohort/schema.js";

const view = { id: "insp-pilot-P1-001", prompt: "List routes within src.", answerShape: INSPECT_ANSWER_SHAPES["route-set"] };

describe("inspect cohort runner contracts", () => {
    it("uses the same task prompt and shape for natural-choice off/on arms", () => {
        const arms = resolveInspectArms(["off", "on"], true);
        expect(arms[0]?.env).toMatchObject({ PI_SMARTREAD_AFFORDANCES: "0", PI_SMARTREAD_INSPECT_AFFORDANCES: "0" });
        expect(arms[1]?.env).toMatchObject({ PI_SMARTREAD_AFFORDANCES: "0", PI_SMARTREAD_INSPECT_AFFORDANCES: "1" });
        expect(buildInspectTaskPrompt(view, arms[0]!)).toBe(buildInspectTaskPrompt(view, arms[1]!));
    });

    it("allows instructed/generic arms only on positives and enforces prompt parity", () => {
        expect(resolveInspectArms(["instructed", "generic"], false)).toEqual([]);
        expect(checkPromptParity(INSPECT_INSTRUCTED_TEXT, INSPECT_GENERIC_TEXT)).toBe(true);
        expect(checkPromptParity("x", "a much longer text" )).toBe(false);
        const [instructed, generic] = resolveInspectArms(["instructed", "generic"], true);
        expect(buildInspectTaskPrompt(view, instructed!)).toContain(INSPECT_INSTRUCTED_TEXT);
        expect(buildInspectTaskPrompt(view, generic!)).toContain(INSPECT_GENERIC_TEXT);
        expect(INSPECT_GENERIC_TEXT).not.toMatch(/inspect/i);
    });

    it("marks bench-cache, task-file, and gold-path tool-argument contamination as graded failures", () => {
        const goldPaths = collectGoldPathMarkers({ kind: "route-set", routes: [{ file: "src/private.ts", path: "/secret" }] });
        expect(goldPaths).toContain("src/private.ts");
        expect(goldPaths).toContain("/secret");
        const cache = "/home/test/.cache/pi-smartread-bench/tasks.jsonl";
        const log = JSON.stringify({ event: { type: "tool_execution_start", toolName: "bash", args: { command: `cat ${cache} src/private.ts` } } });
        const contaminated = scanLogForContamination(log, ["/home/test/.cache/pi-smartread-bench/tasks.jsonl", "/home/test/tasks.jsonl", ...goldPaths]);
        expect(contaminated.contaminated).toBe(true);
        expect(contaminated.hit).toBe("/home/test/.cache/pi-smartread-bench/tasks.jsonl");
        expect(sessionValidity({ identityMismatch: null, infraFailure: null, contaminated: contaminated.contaminated, timedOut: false }))
            .toMatchObject({ excluded: false, exclusionReason: null, gradedFailure: true, rerunRequired: false });
        expect(sessionValidity({ identityMismatch: "guidance hash mismatch", infraFailure: null, contaminated: true, timedOut: false }))
            .toMatchObject({ excluded: false, gradedFailure: true, rerunRequired: false }); // contamination is never excluded
    });

    it("checks provider, full model identity, thinking and resolved response model pins", () => {
        const requested = { model: "provider/model-v2", thinking: "high" };
        expect(checkInspectSessionIdentity({ provider: "provider", model: "provider/model-v2", thinking: "high", responseModel: "provider/model-v2", providerThinkingLevel: "high" }, requested).ok).toBe(true);
        expect(checkInspectSessionIdentity({ provider: "provider", model: "provider/model-v2", thinking: "high", responseModel: "provider/model-old", providerThinkingLevel: "high" }, requested).reason).toMatch(/responseModel/);
        expect(checkInspectSessionIdentity({ provider: "wrong-provider", model: "provider/model-v2", thinking: "high" }, requested).ok).toBe(false);
        expect(checkInspectSessionIdentity({ provider: "provider", model: "provider/model-old", thinking: "high" }, requested).ok).toBe(false);
        expect(checkInspectSessionIdentity({ provider: "provider", model: "provider/model-v2", thinking: "low" }, requested).ok).toBe(false);
    });

    it("excludes narrow infrastructure failures, retains timeouts, and records reruns and batch invalidation", () => {
        expect(sessionValidity({ identityMismatch: null, infraFailure: { kind: "runner", detail: "crash" }, contaminated: false, timedOut: false }))
            .toMatchObject({ excluded: true, rerunRequired: true });
        expect(sessionValidity({ identityMismatch: "missing model identity", infraFailure: null, contaminated: false, timedOut: true }))
            .toMatchObject({ excluded: false, gradedFailure: true, rerunRequired: false });
        expect(sessionValidity({ identityMismatch: null, infraFailure: { kind: "runner", detail: "crash" }, contaminated: true, timedOut: false }))
            .toMatchObject({ excluded: false, gradedFailure: true, rerunRequired: false });
        expect(summarizeExclusions([{ excluded: true }, ...Array.from({ length: 19 }, () => ({ excluded: false }))]))
            .toMatchObject({ batchInvalidated: false, rerunList: [0] });
        expect(summarizeExclusions([{ excluded: true }, ...Array.from({ length: 18 }, () => ({ excluded: false }))]))
            .toMatchObject({ batchInvalidated: true, rerunList: [0] });
    });

    it("records a fake-launcher crash as excluded with a rerun entry", async () => {
        const dir = mkdtempSync(join(tmpdir(), "inspect-catch-"));
        const repos = join(dir, "repos"), repo = join(repos, "fake__repo");
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src", "index.js"), "export {};\n");
        const git = (args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
        git(["init", "--quiet"]); git(["add", "."]);
        git(["-c", "user.email=inspect@test", "-c", "user.name=inspect", "commit", "-m", "fixture", "--quiet"]);
        const commit = git(["rev-parse", "HEAD"]);
        const task: InspectTask = { id: "insp-pilot-N5-001", split: "pilot", repo: "fake__repo", commit, subpath: ".", family: "N5",
            prompt: "Which file contains the answer?", scope: "", answerType: "file", gold: { kind: "file", path: "src/answer.ts" },
            candidateUniverse: { id: "fixture-universe", sha256: "a".repeat(64), count: 1 }, decoys: [], negativeControl: true,
            derivation: "synthetic fixture", agreement: "agree", labelers: ["a", "b"], adjudication: "agree", snapshot: { head: commit, clean: true } };
        const tasks = join(dir, "tasks.jsonl"); writeFileSync(tasks, `${JSON.stringify(task)}\n`);
        const oldRepos = process.env["INSPECT_REPOS_DIR"]; process.env["INSPECT_REPOS_DIR"] = repos;
        const identity: InspectSelectorIdentity = { selectors: { general: false, inspect: false }, variants: { lsp: "baseline", inspect: "baseline", grep: "baseline", guidance: "baseline", mcpInstructions: "baseline" }, surfaceIdentity: "surface-pin", schemaHash: "schema-pin", guidanceHash: "guidance-pin" };
        try {
            const result = await runInspectCli({ tasks, split: "pilot", arms: ["off"], replicates: 1, maxTurns: 1, model: "provider/model-v2",
                thinking: "high", timeoutMs: 1000, out: join(dir, "out"), dryRun: false, taskIds: null, limit: null,
                openHoldout: false, freezeFile: null, piBin: "pi" }, {
                expectedIdentityByArm: { off: identity },
                spawnFn: () => { throw new Error("spawn fake-pi ENOENT"); },
            });
            const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { batchInvalidated: boolean; rerunList: unknown[]; sessions: Array<{ excluded: boolean; rerunRequired: boolean; infraFailure: { kind: string } | null }> };
            expect(manifest.sessions[0]).toMatchObject({ excluded: true, rerunRequired: true, infraFailure: { kind: "spawn" } });
            expect(manifest.rerunList).toHaveLength(1);
            expect(manifest.batchInvalidated).toBe(true);
            expect(existsSync(result.runDir)).toBe(true);
        } finally {
            if (oldRepos === undefined) delete process.env["INSPECT_REPOS_DIR"];
            else process.env["INSPECT_REPOS_DIR"] = oldRepos;
        }
    });

    it("allows an empty non-dry batch without requiring a per-arm identity", async () => {
        const dir = mkdtempSync(join(tmpdir(), "inspect-identity-"));
        const tasks = join(dir, "empty.jsonl"); writeFileSync(tasks, "");
        await expect(runInspectCli({ tasks, split: "pilot", arms: ["off"], replicates: 1, maxTurns: 1,
            model: "provider/model-v2", thinking: "high", timeoutMs: 1000, out: join(dir, "out"), dryRun: false,
            taskIds: null, limit: null, openHoldout: false, freezeFile: null, piBin: "pi" })).resolves.toMatchObject({ manifestPath: expect.any(String) });
    });

    it("excludes selector or guidance identity mismatch and invalid selectors for rerun", () => {
        const expected: InspectSelectorIdentity = { selectors: { general: false, inspect: true }, variants: { lsp: "baseline", inspect: "inspect-bundle", grep: "baseline", guidance: "inspect-bundle", mcpInstructions: "inspect-bundle" }, surfaceIdentity: "surface-a", schemaHash: "schema-a", guidanceHash: "guide-a" };
        expect(selectorIdentityMismatch(expected, expected)).toBeNull();
        expect(selectorIdentityMismatch({ ...expected, guidanceHash: "guide-b" }, expected)).toMatch(/guidance/);
        expect(selectorIdentityMismatch({ ...expected, selectors: { general: false, inspect: false } }, expected)).toMatch(/selector/);
        const invalidReason = selectorIdentityMismatch({ ...expected, selectors: { general: false, inspect: true, invalid: ["PI_SMARTREAD_INSPECT_AFFORDANCES=on"] } }, expected);
        expect(invalidReason).toMatch(/invalid selector/);
        expect(sessionValidity({ identityMismatch: invalidReason, infraFailure: null, contaminated: false, timedOut: false }))
            .toEqual({ excluded: true, exclusionReason: invalidReason, rerunRequired: true, gradedFailure: false });
    });

    it("keeps holdout blacklist strings out of agent-visible prompts", () => {
        const prompt = buildInspectTaskPrompt(view, resolveInspectArms(["off"], true)[0]!);
        expect(() => assertNoHoldoutExposure(prompt)).not.toThrow();
        expect(() => assertNoHoldoutExposure(`${prompt} .cache/pi-smartread-bench`)).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure(`${prompt} grade.ts`)).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure(prompt, ["sealed-task-id"])).not.toThrow();
        expect(() => assertNoHoldoutExposure(`${prompt} sealed-task-id`, ["sealed-task-id"])).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure(`${prompt} forbidden pilot wording`, ["forbidden pilot wording"])).toThrow(/blacklist/);
        expect(() => assertNoHoldoutExposure(`${prompt} /tmp/gold/routes.json`)).toThrow(/blacklist/);
    });

    it("constructs the task prompt from runner-visible projection only", () => {
        const task = { prompt: "Find routes", answerType: "route-set" } as Parameters<typeof toInspectRunnerView>[0];
        const prompt = buildInspectTaskPrompt(toInspectRunnerView(task), resolveInspectArms(["off"], true)[0]!);
        expect(prompt).toContain(task.prompt);
        expect(prompt).toContain(INSPECT_ANSWER_SHAPES["route-set"]);
        expect(prompt).not.toContain("gold");
    });
});
