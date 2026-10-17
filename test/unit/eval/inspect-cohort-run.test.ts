import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INSPECT_ANSWER_SHAPES, toInspectRunnerView } from "../../../scripts/eval/inspect-cohort/schema.js";
import { assertNoHoldoutExposure, buildInspectTaskPrompt, checkInspectSessionIdentity, checkPromptParity, collectInspectContaminationMarkers, resolveInspectArms, runInspectCli, selectorIdentityMismatch, sessionValidity, summarizeExclusions, type InspectSelectorIdentity } from "../../../scripts/eval/inspect-cohort/run.js";
import { INSPECT_GENERIC_TEXT, INSPECT_INSTRUCTED_TEXT } from "../../../scripts/eval/inspect-cohort/prompts.js";
import { benchCacheDir, classifyInfraFailure, scanLogForContamination } from "../../../scripts/eval/teb/run.js";
import type { PiSpawnFn } from "../../../scripts/eval/teb/launch.js";
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

    it("scopes tool-arg contamination to bench-cache and task-file markers, never gold paths (protocol §9)", () => {
        // Protocol §9 defines contamination as a bench-cache/task-file
        // reference in tool args or bash — not a gold source path. Reading
        // the target file that holds the answer is ordinary agent behavior.
        const tasksPath = join(tmpdir(), "tasks.jsonl");
        const markers = collectInspectContaminationMarkers(tasksPath);
        expect(markers).toEqual([benchCacheDir(), resolve(tasksPath)]);
        const goldBashRead = JSON.stringify({
            event: { type: "tool_execution_start", toolName: "bash", args: { command: "cat src/private.ts" } },
        });
        expect(scanLogForContamination(goldBashRead, markers)).toEqual({ contaminated: false, hit: null });
        const goldReadCall = JSON.stringify({
            event: {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [{ type: "toolCall", name: "read", arguments: { path: "src/private.ts" } }],
                },
            },
        });
        expect(scanLogForContamination(goldReadCall, markers)).toEqual({ contaminated: false, hit: null });
        const home = process.env["HOME"] ?? "/root";
        const homeRelativeCache = `~${benchCacheDir().slice(home.length)}`;
        const taskBase = resolve(tasksPath).split(/[\\/]/).pop() ?? "tasks.jsonl";
        const cases: Array<[string, string]> = [
            ["bench-cache absolute", `cat ${benchCacheDir()}/teb/pilot.jsonl`],
            ["bench-cache home-relative", `cat ${homeRelativeCache}/teb/pilot.jsonl`],
            ["bench-cache $HOME", `cat $HOME/.cache/pi-smartread-bench/teb/pilot.jsonl`],
            ["task-file absolute", `cat ${resolve(tasksPath)}`],
            ["task-file basename", `cat ${taskBase}`],
        ];
        for (const [label, command] of cases) {
            const line = JSON.stringify({
                event: { type: "tool_execution_start", toolName: "bash", args: { command } },
            });
            expect(scanLogForContamination(line, markers).contaminated, label).toBe(true);
        }
        const taskReadCall = JSON.stringify({
            event: {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [{ type: "toolCall", name: "read", arguments: { path: resolve(tasksPath) } }],
                },
            },
        });
        expect(scanLogForContamination(taskReadCall, markers).contaminated).toBe(true);
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
        expect(selectorIdentityMismatch({ ...expected, selectors: { general: { enabled: false }, inspect: { enabled: true } } }, expected)).toBeNull();
        expect(selectorIdentityMismatch({ ...expected, selectors: { general: { enabled: false }, inspect: { enabled: true } }, guidanceHash: "guide-b" }, expected)).toMatch(/guidance/);
        expect(selectorIdentityMismatch({ ...expected, selectors: { general: { enabled: false }, inspect: { enabled: false } } }, expected)).toMatch(/selector/);
        const invalidReason = selectorIdentityMismatch({ ...expected, selectors: { general: { enabled: false }, inspect: { enabled: true, invalid: "on" } } }, expected);
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

    it("never treats our turn-limit kill or post-settle reap as an infrastructure exclusion", () => {
        // Mirrors the TEB runner's classifyInfraFailure contract: our own
        // kills explain any signal/nonzero exit, so the session grades
        // downstream instead of excluding the batch.
        expect(classifyInfraFailure({ logText: "", stderrText: "", spawnError: null, exitCode: null,
            signal: "SIGKILL", timedOut: false, turnLimitHit: true })).toBeNull();
        expect(classifyInfraFailure({ logText: "", stderrText: "", spawnError: null, exitCode: null,
            signal: "SIGKILL", timedOut: false, postSettleReap: true })).toBeNull();
    });

    it("grades failed sessions without excluding them", () => {
        expect(sessionValidity({ identityMismatch: null, infraFailure: null, contaminated: false, timedOut: false, failed: true }))
            .toMatchObject({ excluded: false, rerunRequired: false, gradedFailure: true });
    });

    it("grades a settled session reaped post-settle on its answer, never as a runner crash", async () => {
        const dir = mkdtempSync(join(tmpdir(), "inspect-settle-"));
        const fixture = makeLaunchFixture(dir);
        const identityLine = `${JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "provider", model: "provider/model-v2", thinkingLevel: "high" } })}\n`;
        const settleLine = `${JSON.stringify({ type: "agent_settled" })}\n`;
        const restore = setReposDir(fixture.repos);
        try {
            const result = await runInspectCli(launchArgs(fixture, 25, 60000), {
                expectedIdentityByArm: { off: offIdentity() },
                spawnFn: fakeSettledSpawn([identityLine, settleLine]),
            });
            const manifest = readManifest(result.manifestPath);
            expect(manifest.sessions).toHaveLength(1);
            // Our post-settle reap explains the SIGKILL exit: graded, never excluded.
            expect(manifest.sessions[0]).toMatchObject({ infraFailure: null, excluded: false, timedOut: false, contaminated: false });
        } finally {
            restore();
        }
    }, 30000);

    it("grades a turn-limit kill as a failure, not an exclusion", async () => {
        const dir = mkdtempSync(join(tmpdir(), "inspect-turnlimit-"));
        const fixture = makeLaunchFixture(dir);
        const identityLine = `${JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "provider", model: "provider/model-v2", thinkingLevel: "high" } })}\n`;
        const turnLine = `${JSON.stringify({ type: "turn_start" })}\n`;
        const restore = setReposDir(fixture.repos);
        try {
            const result = await runInspectCli(launchArgs(fixture, 2, 10000), {
                expectedIdentityByArm: { off: offIdentity() },
                spawnFn: fakeSettledSpawn([identityLine, turnLine, turnLine, turnLine]),
            });
            const manifest = readManifest(result.manifestPath);
            expect(manifest.sessions).toHaveLength(1);
            expect(manifest.sessions[0]).toMatchObject({ infraFailure: null, excluded: false, timedOut: false, gradedFailure: true });
        } finally {
            restore();
        }
    });
});

const IDENTITY_HEX = "ab".repeat(32);

function offIdentity(): InspectSelectorIdentity {
    return { selectors: { general: false, inspect: false },
        variants: { lsp: "baseline", inspect: "baseline", grep: "baseline", guidance: "baseline", mcpInstructions: "baseline" },
        surfaceIdentity: IDENTITY_HEX, schemaHash: IDENTITY_HEX, guidanceHash: IDENTITY_HEX };
}

function surfaceIdentityStderr(): string {
    return `[pi-smartread:surface-identity] ${JSON.stringify({ selectors: { general: { enabled: false }, inspect: { enabled: false } },
        variants: { lsp: "baseline", inspect: "baseline", grep: "baseline", guidance: "baseline", mcpInstructions: "baseline" },
        surfaceIdentity: IDENTITY_HEX, schemaHash: IDENTITY_HEX, guidanceHash: IDENTITY_HEX })}\n`;
}

interface LaunchFixture { repos: string; tasks: string; out: string; }

function makeLaunchFixture(dir: string): LaunchFixture {
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
    return { repos, tasks, out: join(dir, "out") };
}

function setReposDir(repos: string): () => void {
    const old = process.env["INSPECT_REPOS_DIR"];
    process.env["INSPECT_REPOS_DIR"] = repos;
    return () => {
        if (old === undefined) delete process.env["INSPECT_REPOS_DIR"];
        else process.env["INSPECT_REPOS_DIR"] = old;
    };
}

function launchArgs(fixture: LaunchFixture, maxTurns: number, timeoutMs: number) {
    return { tasks: fixture.tasks, split: "pilot" as const, arms: ["off"], replicates: 1, maxTurns, model: "provider/model-v2",
        thinking: "high", timeoutMs, out: fixture.out, dryRun: false, taskIds: null, limit: null,
        openHoldout: false, freezeFile: null, piBin: "pi" };
}

function readManifest(manifestPath: string): { sessions: Array<Record<string, unknown>> } {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as { sessions: Array<Record<string, unknown>> };
}

/**
 * Minimal stderr emitter delivering the surface-identity line
 * synchronously on attach, so fast-kill paths (turn-limit) cannot
 * outrun async stream delivery before the runner closes its log.
 */
function fakeSurfaceStderr(): NodeJS.ReadableStream {
    const text = surfaceIdentityStderr();
    return { on: (event: string, listener: (...args: never[]) => void): unknown => {
        if (event === "data") (listener as (chunk: string) => void)(text);
        return undefined;
    } } as unknown as NodeJS.ReadableStream;
}

/**
 * Fake pi whose stdout yields the given chunks then stalls: the process
 * never exits on its own but reports exit (code null, signal SIGKILL)
 * once killed, like a group SIGKILL in production. Stderr carries a
 * valid `off`-arm surface identity so identity checks pass.
 */
function fakeSettledSpawn(chunks: string[]): PiSpawnFn {
    return () => {
        let exitListener: ((code: number | null, sig: string | null) => void) | null = null;
        let releaseStdout: () => void = () => {};
        const stdoutStalled = new Promise<void>((resolve) => { releaseStdout = resolve; });
        return {
            stdout: (async function* () {
                for (const chunk of chunks) yield chunk;
                await stdoutStalled;
            })(),
            stderr: fakeSurfaceStderr(),
            pid: undefined,
            on: (event: string, listener: (...args: never[]) => void) => {
                if (event === "exit") exitListener = listener as unknown as (code: number | null, sig: string | null) => void;
            },
            kill: () => {
                releaseStdout();
                const exit = exitListener;
                exitListener = null;
                if (exit) queueMicrotask(() => exit(null, "SIGKILL"));
                return true;
            },
        };
    };
}
