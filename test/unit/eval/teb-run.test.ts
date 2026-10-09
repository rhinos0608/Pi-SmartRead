/**
 * Unit tests for the TEB runner (run.ts) and launcher (launch.ts).
 * No network, no real `pi`: all process spawns use a fake pi.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    TEB_TOOL_ALLOWLIST,
    benchCacheDir,
    buildTaskPrompt,
    checkHoldoutGuard,
    checkSessionIdentity,
    claimHoldoutOpening,
    classifyInfraFailure,
    defaultPiBin,
    expandHomeSpelling,
    extractSessionIdentity,
    getPiBinarySha256,
    getPiVersion,
    installTebShutdownHandlers,
    instructedSuffixFor,
    isTebShutdownInstalled,
    loadArmsConfig,
    openingPathFor,
    orderForTask,
    parseFreezeFile,
    parseTebRunArgs,
    readCheckoutHead,
    resolveArms,
    runTebCli,
    runTebShutdown,
    scanLogForContamination,
    stableTaskParity,
    trackScratchDir,
    untrackScratchDir,
    type TebManifest,
} from "../../../scripts/eval/teb/run.js";
import { activePiGroupPids, buildPiArgs, killActivePiGroups, launchPiSession, type PiSpawnFn } from "../../../scripts/eval/teb/launch.js";
import { toRunnerView, type TebTask } from "../../../scripts/eval/teb/schema.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function definitionTask(overrides: Partial<TebTask> = {}): TebTask {
    return {
        id: "teb-pilot-definition-001",
        split: "pilot",
        repo: "fake__repo",
        commit: SHA,
        subpath: "src",
        family: "definition",
        prompt: "Where is symbol `foo`, as spelled at src/a.ts:3:7, defined?",
        useSite: { path: "src/a.ts", line: 3, character: 7 },
        anchorKind: "use",
        scope: "",
        answerType: "single-location",
        gold: { kind: "single-location", location: { path: "src/b.ts", line: 42, character: 9 } },
        opportunity: { tools: ["LSP"], rationale: "Exact jump in one call." },
        negativeControl: false,
        derivation: "probe v1",
        agreement: "agree",
        labelers: ["alice", "bob"],
        adjudication: "agree",
        ...overrides,
    };
}

function negativeTask(overrides: Partial<TebTask> = {}): TebTask {
    return {
        id: "teb-pilot-file-by-name-001",
        split: "pilot",
        repo: "fake__repo",
        commit: SHA,
        subpath: "src",
        family: "file-by-name",
        prompt: "Which file defines the `Widget` component?",
        scope: "",
        answerType: "file",
        gold: { kind: "file", path: "src/widget.ts" },
        opportunity: { tools: [], rationale: "Finder suffices; no specialist needed." },
        negativeControl: true,
        derivation: "probe v1",
        agreement: "agree",
        labelers: ["alice", "bob"],
        adjudication: "agree",
        ...overrides,
    };
}

/** Real git checkout under dir/name; returns its HEAD sha. */
function makeGitRepo(dir: string, name: string): { path: string; sha: string } {
    const repoPath = join(dir, name);
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "a.ts"), "const x = 1;\n");
    const git = (args: string[]): string =>
        execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
    git(["init", "--quiet"]);
    git(["add", "."]);
    git(["-c", "user.email=teb@test", "-c", "user.name=teb", "commit", "-m", "init", "--quiet"]);
    return { path: repoPath, sha: git(["rev-parse", "HEAD"]) };
}

function freezeFile(dir: string, taskSha256: string, champion = "champion-a"): string {
    const path = join(dir, "freeze.json");
    // Pins are required freeze fields (fail closed when absent).
    writeFileSync(path, JSON.stringify({ champion, taskSha256, piVersion: "test", piBinarySha256: "c".repeat(64) }));
    return path;
}

function tasksSha256(tasksFile: string): string {
    return createHash("sha256").update(readFileSync(tasksFile)).digest("hex");
}

function fakeSpawn(lines: string[], opts?: { hang?: boolean; onKill?: () => void }): PiSpawnFn {
    return () => {
        let pendingExit: (() => void) | null = null;
        let killed = false;
        void killed;
        return {
            stdout: (async function* () {
                if (opts?.hang) {
                    await new Promise(() => {});
                    return;
                }
                for (const line of lines) yield line + "\n";
            })(),
            stderr: null,
            pid: undefined,
            on: (event: string, listener: (...args: never[]) => void) => {
                if (event === "exit") {
                    if (opts?.hang) {
                        pendingExit = listener as () => void;
                    } else {
                        queueMicrotask(() => (listener as () => void)());
                    }
                }
            },
            kill: () => {
                killed = true;
                opts?.onKill?.();
                if (pendingExit) queueMicrotask(() => pendingExit?.());
                return true;
            },
        };
    };
}

describe("parseTebRunArgs", () => {
    it("parses the full CLI surface", () => {
        const args = parseTebRunArgs([
            "--tasks", "t.jsonl",
            "--split", "dev",
            "--arms", "baseline,instructed",
            "--arms-config", "arms.json",
            "--replicates", "3",
            "--model", "opencode-go/deepseek-v4-flash",
            "--thinking", "low",
            "--timeout-ms", "5000",
            "--out", "outdir",
            "--limit", "2",
            "--task-ids", "a,b",
        ]);
        expect(args).toMatchObject({
            tasks: "t.jsonl",
            split: "dev",
            arms: ["baseline", "instructed"],
            armsConfig: "arms.json",
            replicates: 3,
            model: "opencode-go/deepseek-v4-flash",
            thinking: "low",
            timeoutMs: 5000,
            out: "outdir",
            limit: 2,
            taskIds: ["a", "b"],
            dryRun: false,
        });
    });

    it("accepts an explicit --pi-bin", () => {
        const args = parseTebRunArgs(["--tasks", "t", "--out", "o", "--pi-bin", "/opt/homebrew/bin/pi"]);
        expect(args.piBin).toBe("/opt/homebrew/bin/pi");
    });

    it("defaults --pi-bin outside node_modules/.bin (E11b)", () => {
        const args = parseTebRunArgs(["--tasks", "t", "--out", "o"]);
        expect(args.piBin).not.toContain("node_modules");
    });

    it("defaults --replicates to 3 and --max-turns to 25 (E13.6)", () => {
        const args = parseTebRunArgs(["--tasks", "t", "--out", "o"]);
        expect(args.replicates).toBe(3);
        expect(args.maxTurns).toBe(25);
    });
    it("rejects unknown splits and bad replicates", () => {
        expect(() => parseTebRunArgs(["--tasks", "t", "--split", "nope", "--out", "o"])).toThrow();
        expect(() => parseTebRunArgs(["--tasks", "t", "--out", "o", "--replicates", "0"])).toThrow();
        expect(() => parseTebRunArgs(["--tasks", "t", "--out", "o"])).not.toThrow();
    });
});

describe("defaultPiBin (E11b)", () => {
    it("skips node_modules/.bin entries", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-pibin-"));
        const shimDir = join(dir, "node_modules", ".bin");
        mkdirSync(shimDir, { recursive: true });
        expect(defaultPiBin(`${shimDir}:/nonexistent-xyz`)).toBe("pi");
    });

    it("returns bare pi when nothing on PATH matches", () => {
        expect(defaultPiBin("/nonexistent-xyz")).toBe("pi");
    });

    it("getPiVersion reports unknown for a missing binary", () => {
        expect(getPiVersion(join(tmpdir(), "no-such-pi-binary-xyz"))).toBe("unknown");
    });
});

describe("checkHoldoutGuard (P1-1)", () => {
    const base = parseTebRunArgs(["--tasks", "t.jsonl", "--out", "o"]);
    it("passes non-holdout splits unconditionally", () => {
        expect(checkHoldoutGuard({ ...base, split: "pilot" })).toBeNull();
    });
    it("refuses holdout without --open-holdout plus a freeze file", () => {
        expect(checkHoldoutGuard({ ...base, split: "holdout" })).not.toBeNull();
        expect(checkHoldoutGuard({ ...base, split: "holdout", openHoldout: true })).not.toBeNull();
        expect(
            checkHoldoutGuard({ ...base, split: "holdout", openHoldout: true, freezeFile: "/nonexistent-freeze.json" }),
        ).not.toBeNull();
    });
    it("rejects freeze files without champion id and task sha", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-freeze-"));
        const legacy = join(dir, "legacy.json");
        writeFileSync(legacy, '{"opening":"single"}');
        expect(checkHoldoutGuard({ ...base, split: "holdout", openHoldout: true, freezeFile: legacy })).toMatch(
            /champion|taskSha256|task-file sha/,
        );
        const noSha = join(dir, "nosha.json");
        writeFileSync(noSha, '{"champion":"c"}');
        expect(checkHoldoutGuard({ ...base, split: "holdout", openHoldout: true, freezeFile: noSha })).not.toBeNull();
        expect(() => parseFreezeFile('{"champion":"c"}')).toThrow();
        expect(() => parseFreezeFile("not json")).toThrow();
    });
    it("accepts a freeze file with champion id and task sha", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-freeze-"));
        const freeze = freezeFile(dir, "a".repeat(64));
        expect(checkHoldoutGuard({ ...base, split: "holdout", openHoldout: true, freezeFile: freeze })).toBeNull();
        expect(parseFreezeFile(readFileSync(freeze, "utf8"))).toEqual({
            champion: "champion-a",
            taskSha256: "a".repeat(64),
            piVersion: "test",
            piBinarySha256: "c".repeat(64),
        });
    });
    it("requires the pi pin fields and rejects malformed ones (fail closed)", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-freeze-"));
        const pinned = join(dir, "pinned.json");
        writeFileSync(
            pinned,
            JSON.stringify({ champion: "c", taskSha256: "a".repeat(64), piVersion: "1.2.3", piBinarySha256: "b".repeat(64) }),
        );
        expect(parseFreezeFile(readFileSync(pinned, "utf8"))).toEqual({
            champion: "c",
            taskSha256: "a".repeat(64),
            piVersion: "1.2.3",
            piBinarySha256: "b".repeat(64),
        });
        expect(() => parseFreezeFile(JSON.stringify({ champion: "c", taskSha256: "a".repeat(64), piVersion: "1.2.3", piBinarySha256: "zz" }))).toThrow(
            /piBinarySha256/,
        );
        // Absent pins fail closed: the holdout must not open.
        expect(() => parseFreezeFile(JSON.stringify({ champion: "c", taskSha256: "a".repeat(64) }))).toThrow(
            /piVersion/,
        );
        expect(() =>
            parseFreezeFile(JSON.stringify({ champion: "c", taskSha256: "a".repeat(64), piVersion: "1.2.3" })),
        ).toThrow(/piBinarySha256/);
    });
});

describe("claimHoldoutOpening (P1-1)", () => {
    it("writes the opening record once; a second claim fails", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-open-"));
        const freeze = freezeFile(dir, SHA);
        const opening = { champion: "champion-a", taskSha256: SHA, runId: "r1", openedAt: "2026-10-08T00:00:00.000Z" };
        const record = claimHoldoutOpening(freeze, opening);
        expect(record).toBe(openingPathFor(freeze, SHA));
        expect(existsSync(record)).toBe(true);
        expect(JSON.parse(readFileSync(record, "utf8"))).toMatchObject({ champion: "champion-a", runId: "r1" });
        expect(() => claimHoldoutOpening(freeze, { ...opening, runId: "r2" })).toThrow(/already opened/);
    });
    it("keys the opening record to the sealed task-file sha256, not the freeze filename (E13.6)", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-open-"));
        const freeze = freezeFile(dir, SHA);
        expect(openingPathFor(freeze, SHA)).toContain(SHA);
        expect(openingPathFor(freeze, SHA)).not.toBe(`${freeze}.opening.json`);
        // A different sealed set keys a different record: the first
        // opening cannot authorize it.
        expect(openingPathFor(freeze, "c".repeat(64))).not.toBe(openingPathFor(freeze, SHA));
    });
});

describe("session identity (P1-2)", () => {
    const fixture = new URL("../../fixtures/eval/teb/sample-session.jsonl", import.meta.url);
    it("extracts provider/model from a real pi session log", () => {
        const identity = extractSessionIdentity(readFileSync(fixture, "utf8"));
        expect(identity.provider).toBe("opencode-go");
        expect(identity.model).toBe("deepseek-v4-flash");
    });
    it("accepts the requested provider/model/thinking when all resolve (E13.6: explicit thinking)", () => {
        // The shared fixture carries no resolved thinking level, so the
        // accepted case uses a synthetic identity with thinking present.
        const check = checkSessionIdentity(
            { provider: "opencode-go", model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
            { model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
        );
        expect(check).toEqual({ ok: true, reason: null });
    });
    it("treats a missing provider as a mismatch (E13.6)", () => {
        const check = checkSessionIdentity(
            { provider: null, model: "deepseek-v4-flash", thinking: "medium" },
            { model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
        );
        expect(check).toMatchObject({ ok: false });
        expect(check.reason ?? "").toMatch(/provider/);
    });
    it("treats a missing thinking level as a mismatch (E13.6)", () => {
        const identity = extractSessionIdentity(readFileSync(fixture, "utf8"));
        expect(identity.thinking).toBeNull();
        const check = checkSessionIdentity(identity, {
            model: "opencode-go/deepseek-v4-flash",
            thinking: "medium",
        });
        expect(check).toMatchObject({ ok: false });
        expect(check.reason ?? "").toMatch(/thinking/);
    });
    it("fails on model substitution", () => {
        expect(
            checkSessionIdentity(
                { provider: "opencode-go", model: "other-model", thinking: null },
                { model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
            ).ok,
        ).toBe(false);
    });
    it("fails on provider substitution", () => {
        expect(
            checkSessionIdentity(
                { provider: "other-provider", model: "other-provider/deepseek-v4-flash", thinking: null },
                { model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
            ).ok,
        ).toBe(false);
    });
    it("fails on thinking substitution", () => {
        expect(
            checkSessionIdentity(
                { provider: "opencode-go", model: "deepseek-v4-flash", thinking: "high" },
                { model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
            ),
        ).toMatchObject({ ok: false, reason: expect.stringContaining("thinking") });
    });
    it("fails when the log carries no model", () => {
        expect(
            checkSessionIdentity(
                { provider: null, model: null, thinking: null },
                { model: "opencode-go/deepseek-v4-flash", thinking: "medium" },
            ).ok,
        ).toBe(false);
    });
});

describe("readCheckoutHead (P1-3)", () => {
    it("reads HEAD of a checkout", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-head-"));
        const { path, sha } = makeGitRepo(dir, "fake__repo");
        expect(readCheckoutHead(path)).toBe(sha);
    });
});

describe("prompt construction", () => {
    it("builds the prompt from the RunnerTaskView only (no gold leak)", () => {
        const task = definitionTask();
        const prompt = buildTaskPrompt(toRunnerView(task), { name: "baseline" });
        expect(prompt).toContain(task.prompt);
        expect(prompt).toContain('{"answer"');
        expect(prompt).not.toContain("src/b.ts");
        expect(prompt).not.toContain("Exact jump");
    });

    it("instructed suffix names the tool only, never for negatives", () => {
        const suffix = instructedSuffixFor("definition");
        expect(suffix).toContain("`LSP`");
        expect(suffix).not.toContain("goToDefinition");
        expect(instructedSuffixFor("literal-location")).toBeNull();
        expect(instructedSuffixFor("config-value")).toBeNull();
        const prompt = buildTaskPrompt(toRunnerView(definitionTask()), {
            name: "instructed",
            promptSuffix: suffix ?? undefined,
        });
        expect(prompt).toContain("MUST call");
    });

    it("resolveArms wires the instructed suffix per family", () => {
        const [arm] = resolveArms(["instructed"], "/ext/src/index.ts", "definition");
        expect(arm?.promptSuffix).toContain("`LSP`");
        const [neg] = resolveArms(["instructed"], "/ext/src/index.ts", "literal-location");
        expect(neg?.promptSuffix).toBeUndefined();
    });
    it("names grep or LSP (never inspect) for direct-importers (E13.5)", () => {
        const [arm] = resolveArms(["instructed"], "/ext/src/index.ts", "direct-importers");
        expect(arm?.promptSuffix).toBeDefined();
        expect(arm?.promptSuffix ?? "").not.toContain("`inspect`");
        expect(arm?.promptSuffix ?? "").toMatch(/`(grep|LSP)`/);
    });
});

describe("resolveArms registry (P1-7)", () => {
    it("rejects unknown arm names instead of silently running baseline", () => {
        expect(() => resolveArms(["baseline", "instructd"], "/ext/src/index.ts")).toThrow(/unknown --arms/);
    });
    it("resolves configured intervention arms with env and promptSuffix", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-arms-"));
        const configPath = join(dir, "arms.json");
        writeFileSync(
            configPath,
            JSON.stringify({ gamma: { extensionPath: "/g/index.ts", env: { TEB_G: "1" }, promptSuffix: "Try X." } }),
        );
        const config = loadArmsConfig(configPath);
        const [gamma] = resolveArms(["gamma"], "/ext/src/index.ts", "definition", config);
        expect(gamma).toMatchObject({ name: "gamma", extensionPath: "/g/index.ts", promptSuffix: "Try X." });
        expect(gamma?.env).toEqual({ TEB_G: "1" });
    });
    it("rejects malformed arms-config files", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-arms-"));
        const bad = join(dir, "bad.json");
        writeFileSync(bad, "[1,2]");
        expect(() => loadArmsConfig(bad)).toThrow();
        expect(() => loadArmsConfig(join(dir, "missing.json"))).toThrow();
    });
});

describe("orderForTask (P2 stable alternation)", () => {
    it("alternates AB/BA by numeric index (legacy behavior)", () => {
        expect(orderForTask(["a", "b"], 0)).toEqual(["a", "b"]);
        expect(orderForTask(["a", "b"], 1)).toEqual(["b", "a"]);
        expect(orderForTask(["a", "b"], 2)).toEqual(["a", "b"]);
    });
    it("keys string order by the stable task id hash, not the filtered index", () => {
        const id = "teb-pilot-definition-001";
        const expected = stableTaskParity(id) % 2 === 0 ? ["a", "b"] : ["b", "a"];
        expect(orderForTask(["a", "b"], id)).toEqual(expected);
        // Deterministic across calls: reruns with --task-ids/--limit agree.
        expect(orderForTask(["a", "b"], id)).toEqual(orderForTask(["a", "b"], id));
    });
});

describe("scanLogForContamination (E11a)", () => {
    const cache = benchCacheDir("/home/tester");
    it("flags tool-call args referencing the bench cache dir", () => {
        const line = JSON.stringify({
            rt: 1,
            event: {
                type: "tool_execution_start",
                toolName: "bash",
                args: { command: `cat ${cache}/teb/pilot.jsonl` },
            },
        });
        expect(scanLogForContamination(line, [cache, "/tasks.jsonl"])).toEqual({
            contaminated: true,
            hit: cache,
        });
    });
    it("flags assistant toolCall arguments referencing the task file", () => {
        const line = JSON.stringify({
            rt: 2,
            event: {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [
                        { type: "toolCall", name: "read", arguments: { path: "/tasks.jsonl" } },
                    ],
                },
            },
        });
        expect(scanLogForContamination(line, [cache, "/tasks.jsonl"])).toEqual({
            contaminated: true,
            hit: "/tasks.jsonl",
        });
    });
    it("ignores marker text in tool results and transcripts", () => {
        const result = JSON.stringify({
            rt: 3,
            event: { type: "tool_execution_end", toolName: "bash", result: { content: cache } },
        });
        expect(scanLogForContamination(result, [cache])).toEqual({ contaminated: false, hit: null });
        expect(scanLogForContamination("unrelated text", [cache])).toEqual({ contaminated: false, hit: null });
        expect(scanLogForContamination("", [])).toEqual({ contaminated: false, hit: null });
    });
    it.each([
        ["home-relative ~/", `cat ~/.cache/pi-smartread-bench/teb/pilot.jsonl`],
        ["$HOME expansion", `cat $HOME/.cache/pi-smartread-bench/teb/pilot.jsonl`],
        ["${HOME} expansion", `cat ${"${HOME}"}/.cache/pi-smartread-bench/teb/pilot.jsonl`],
        ["quoted ~/", `cat "~/.cache/pi-smartread-bench/teb/pilot.jsonl"`],
        ["single-quoted $HOME", `cat '$HOME/.cache/pi-smartread-bench/teb/pilot.jsonl'`],
        ["escaped ~/", `cat \\~/.cache/pi-smartread-bench/teb/pilot.jsonl`],
        ["relative ../ escape", `cat ../../.cache/pi-smartread-bench/teb/pilot.jsonl`],
        ["bare task basename", `cat pilot.jsonl`],
    ])("flags spelling variant %s", (_label, command) => {
        const line = JSON.stringify({
            rt: 4,
            event: { type: "tool_execution_start", toolName: "bash", args: { command } },
        });
        const markers = [`${cache}/teb/pilot.jsonl`];
        const { contaminated } = scanLogForContamination(line, markers);
        expect(contaminated).toBe(true);
    });
    it("expands home spellings for matching", () => {
        expect(expandHomeSpelling("~/a", "/home/u")).toBe("/home/u/a");
        expect(expandHomeSpelling("$HOME/a", "/home/u")).toBe("/home/u/a");
        expect(expandHomeSpelling("${HOME}/a", "/home/u")).toBe("/home/u/a");
        expect(expandHomeSpelling("'$HOME/a'", "/home/u")).toBe("/home/u/a");
    });
    it("never treats our turn-limit kill as an infrastructure exclusion", () => {
        expect(
            classifyInfraFailure({
                logText: "",
                stderrText: "",
                spawnError: null,
                exitCode: null,
                signal: "SIGKILL",
                timedOut: false,
                turnLimitHit: true,
            }),
        ).toBeNull();
    });
    it("ignores API-key prose in the system prompt (no pre-assistant error event)", () => {
        const logText = JSON.stringify({
            rt: 1,
            event: {
                type: "message_start",
                message: { role: "system", content: "Never hardcode secrets, API keys, or credentials." },
            },
        });
        expect(
            classifyInfraFailure({ logText, stderrText: "", spawnError: null, exitCode: 0, signal: null, timedOut: false }),
        ).toBeNull();
    });
});

describe("buildPiArgs", () => {
    it("uses the frozen isolation flags and allowlist", () => {
        const args = buildPiArgs({
            extensionPath: "/w/src/index.ts",
            model: "opencode-go/deepseek-v4-flash",
            thinking: "low",
            tools: TEB_TOOL_ALLOWLIST,
            prompt: "hello",
        });
        for (const flag of ["-ne", "--mode", "json", "--no-session", "--no-skills", "--no-context-files", "--no-prompt-templates"]) {
            expect(args).toContain(flag);
        }
        expect(args).toContain("read,bash,grep,find,inspect,LSP");
        // P2: -p is a boolean flag; the prompt is positional after `--`
        // so prompts starting with `-` or `@` cannot be misparsed.
        expect(args.slice(-3)).toEqual(["-p", "--", "hello"]);
    });

    it("keeps dash-led prompts positional after --", () => {
        const args = buildPiArgs({
            extensionPath: "/w/src/index.ts",
            model: "m",
            thinking: "low",
            tools: TEB_TOOL_ALLOWLIST,
            prompt: "--evil --flag",
        });
        expect(args.slice(-3)).toEqual(["-p", "--", "--evil --flag"]);
    });
});

describe("launchPiSession", () => {
    it("wraps each stdout line with a receipt timestamp", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-launch-"));
        const result = await launchPiSession({
            args: ["x"],
            cwd: dir,
            env: { PATH: process.env["PATH"] ?? "" },
            timeoutMs: 5000,
            outJsonl: join(dir, "out.jsonl"),
            outStderr: join(dir, "err.txt"),
            spawnFn: fakeSpawn(['{"type":"a"}', "not json"]),
        });
        expect(result.timedOut).toBe(false);
        expect(result.spawnError).toBeNull();
        expect(result.lines).toBe(2);
        const lines = readFileSync(join(dir, "out.jsonl"), "utf8").trim().split("\n");
        expect(lines).toHaveLength(2);
        const first = JSON.parse(lines[0]!) as { rt: number; event: unknown };
        expect(typeof first.rt).toBe("number");
        expect(first.event).toEqual({ type: "a" });
        const second = JSON.parse(lines[1]!) as { event: unknown };
        expect(second.event).toEqual({ type: "raw", text: "not json" });
    });

    it("kills a hanging process on timeout", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-launch-"));
        let killed = false;
        const result = await launchPiSession({
            args: ["x"],
            cwd: dir,
            env: {},
            timeoutMs: 50,
            outJsonl: join(dir, "out.jsonl"),
            outStderr: join(dir, "err.txt"),
            spawnFn: fakeSpawn([], { hang: true, onKill: () => { killed = true; } }),
        });
        expect(result.timedOut).toBe(true);
        expect(killed).toBe(true);
    });

    it("records spawn errors instead of misreporting a normal session", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-launch-"));
        const failing: PiSpawnFn = () => ({
            stdout: (async function* () {})(),
            stderr: null,
            pid: undefined,
            on: (event: string, listener: (...args: never[]) => void) => {
                if (event === "error") {
                    queueMicrotask(() => (listener as unknown as (cause: Error) => void)(new Error("spawn ENOENT")));
                }
            },
            kill: () => true,
        });
        const result = await launchPiSession({
            args: ["x"],
            cwd: dir,
            env: {},
            timeoutMs: 5000,
            outJsonl: join(dir, "out.jsonl"),
            outStderr: join(dir, "err.txt"),
            spawnFn: failing,
        });
        expect(result.exitCode).toBeNull();
        expect(result.timedOut).toBe(false);
        expect(result.spawnError).toContain("ENOENT");
    });

    it("unregisters the process group after exit (P1-4)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-launch-"));
        const before = new Set(activePiGroupPids());
        await launchPiSession({
            args: ["x"],
            cwd: dir,
            env: {},
            timeoutMs: 5000,
            outJsonl: join(dir, "out.jsonl"),
            outStderr: join(dir, "err.txt"),
            spawnFn: fakeSpawn(['{"type":"a"}']),
        });
        expect(activePiGroupPids().filter((pid) => !before.has(pid))).toEqual([]);
    });
});

describe("teb shutdown (P1-4)", () => {
    it("runTebShutdown removes tracked scratch dirs", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-shutdown-"));
        trackScratchDir(dir);
        runTebShutdown();
        expect(existsSync(dir)).toBe(false);
        untrackScratchDir(dir);
    });
    it("killActivePiGroups is safe with no live groups", () => {
        expect(() => killActivePiGroups()).not.toThrow();
    });
    it("installs SIGINT/SIGTERM handlers once", () => {
        installTebShutdownHandlers();
        installTebShutdownHandlers();
        expect(isTebShutdownInstalled()).toBe(true);
    });
});

describe("runTebCli dry-run", () => {
    it("writes prompts and a manifest without spawning", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask())}\n`);
        const out = join(dir, "out");
        let spawned = 0;
        const spawnFn: PiSpawnFn = () => {
            spawned += 1;
            return fakeSpawn([])({ command: "pi", args: [], cwd: dir, env: {} });
        };
        const { runDir, manifestPath } = await runTebCli(
            parseTebRunArgs(["--tasks", tasksFile, "--split", "pilot", "--out", out, "--dry-run", "--replicates", "1"]),
            { spawnFn, extensionPath: join(dir, "index.ts"), piVersion: "test" },
        );
        expect(spawned).toBe(0);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8") as string) as {
            sessions: Array<{ eventLog: string; pairId: string; runId: string }>;
            piVersion: string;
        };
        expect(manifest.sessions).toHaveLength(1);
        expect(manifest.piVersion).toBe("test");
        expect(manifest.sessions[0]?.pairId).toContain("teb-pilot-definition-001");
        expect(manifest.sessions[0]?.runId.length).toBeGreaterThan(0);
        expect(existsSync(join(runDir, "teb-pilot-definition-001", "baseline-r0", "prompt.txt"))).toBe(true);
        const prompt = readFileSync(join(runDir, "teb-pilot-definition-001", "baseline-r0", "prompt.txt"), "utf8");
        expect(prompt).not.toContain("src/b.ts");
    });

    it("refuses holdout without the single-opening guard", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ split: "holdout", id: "teb-holdout-definition-001" }))}\n`);
        await expect(
            runTebCli(parseTebRunArgs(["--tasks", tasksFile, "--split", "holdout", "--out", join(dir, "out")])),
        ).rejects.toThrow();
    });

    it("dry-run holdout never consumes the sealed opening (P1-1)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ split: "holdout", id: "teb-holdout-definition-001" }))}\n`);
        const freeze = freezeFile(dir, tasksSha256(tasksFile));
        await runTebCli(
            parseTebRunArgs([
                "--tasks", tasksFile, "--split", "holdout", "--out", join(dir, "out"),
                "--open-holdout", "--freeze-file", freeze, "--dry-run",
            ]),
            { piVersion: "test" },
        );
        expect(existsSync(openingPathFor(freeze, tasksSha256(tasksFile)))).toBe(false);
    });

    it("records AB/BA order and replicates with a fake pi", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.jsonl");
        const t2 = definitionTask({ id: "teb-pilot-definition-002", commit: sha });
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ commit: sha }))}\n${JSON.stringify(t2)}\n`);
        const seen: string[][] = [];
        const spawnFn: PiSpawnFn = (opts) => {
            const prompt = opts.args[opts.args.length - 1] ?? "";
            seen.push([opts.cwd, prompt.slice(0, 20)]);
            return fakeSpawn(['{"type":"message_end","message":{"responseModel":"m"}}'])({
                command: "pi", args: [], cwd: opts.cwd, env: {},
            });
        };
        const { manifestPath } = await runTebCli(
            parseTebRunArgs([
                "--tasks", tasksFile, "--split", "pilot",
                "--arms", "baseline,instructed", "--replicates", "1",
                "--out", join(dir, "out"),
            ]),
            { spawnFn, extensionPath: join(dir, "index.ts"), piVersion: "test" },
        );
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8") as string) as {
                sessions: Array<{
                    order: string[];
                    resolvedModel: string | null;
                    taskId: string;
                    pairId: string;
                    commitVerified: boolean;
                    identityOk: boolean;
                    contaminated: boolean;
                }>;
                taskFileSha256: string;
            };
            expect(manifest.sessions).toHaveLength(4);
            expect(manifest.taskFileSha256).toMatch(/^[0-9a-f]{64}$/);
            // P2: order follows the stable task id, and pairs share a pair id.
            for (const taskId of ["teb-pilot-definition-001", "teb-pilot-definition-002"]) {
                const pair = manifest.sessions.filter((s) => s.taskId === taskId);
                expect(pair).toHaveLength(2);
                expect(pair[0]?.order).toEqual(orderForTask(["baseline", "instructed"], taskId));
                expect(pair[1]?.order).toEqual(orderForTask(["baseline", "instructed"], taskId));
                expect(pair[0]?.pairId).toBe(pair[1]?.pairId);
                for (const session of pair) {
                    // P1-3 commit verified against the real checkout HEAD.
                    expect(session.commitVerified).toBe(true);
                    // P1-2 identity recorded (fake pi resolves "m": mismatch, recorded not hidden).
                    expect(session.identityOk).toBe(false);
                    expect(session.contaminated).toBe(false);
                }
            }
            expect(seen.length).toBe(4);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });

    it("fails the session on commit mismatch without spawning (P1-3)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.jsonl");
        const wrong = definitionTask({ id: "teb-pilot-definition-001", commit: SHA });
        const right = definitionTask({ id: "teb-pilot-definition-002", commit: sha });
        writeFileSync(tasksFile, `${JSON.stringify(wrong)}\n${JSON.stringify(right)}\n`);
        let spawned = 0;
        const spawnFn: PiSpawnFn = (opts) => {
            spawned += 1;
            return fakeSpawn(['{"type":"message_end","message":{"responseModel":"m"}}'])({
                command: "pi", args: [], cwd: opts.cwd, env: {},
            });
        };
        const { runDir } = await runTebCli(
            parseTebRunArgs(["--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"), "--replicates", "1"]),
            { spawnFn, extensionPath: join(dir, "index.ts"), piVersion: "test" },
        );
        try {
            // The mismatched session is recorded and the run continues.
            expect(spawned).toBe(1);
            const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8") as string) as {
                sessions: Array<{ taskId: string; commitVerified: boolean; error: string | null; checkoutSha: string | null }>;
            };
            const bad = manifest.sessions.find((s) => s.taskId === "teb-pilot-definition-001");
            expect(bad?.commitVerified).toBe(false);
            expect(bad?.checkoutSha).toBe(sha);
            expect(bad?.error).toContain("commit mismatch");
            expect(existsSync(join(runDir, "teb-pilot-definition-001", "baseline-r0", "commit-mismatch.txt"))).toBe(true);
            const good = manifest.sessions.find((s) => s.taskId === "teb-pilot-definition-002");
            expect(good?.commitVerified).toBe(true);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });

    it("skips the instructed arm on negative controls (P1-6)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(negativeTask({ commit: sha }))}\n`);
        let spawned = 0;
        const spawnFn: PiSpawnFn = (opts) => {
            spawned += 1;
            return fakeSpawn(['{"type":"message_end","message":{"responseModel":"m"}}'])({
                command: "pi", args: [], cwd: opts.cwd, env: {},
            });
        };
        const { manifestPath } = await runTebCli(
            parseTebRunArgs([
                "--tasks", tasksFile, "--split", "pilot",
                "--arms", "baseline,instructed", "--out", join(dir, "out"),
                "--replicates", "1",
            ]),
            { spawnFn, extensionPath: join(dir, "index.ts"), piVersion: "test" },
        );
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8") as string) as {
                sessions: Array<{ arm: string }>;
            };
            expect(manifest.sessions).toHaveLength(1);
            expect(manifest.sessions[0]?.arm).toBe("baseline");
            expect(spawned).toBe(1);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });

    it("records spawn failures with artifacts and continues (P2)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.jsonl");
        const t2 = definitionTask({ id: "teb-pilot-definition-002", commit: sha });
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ commit: sha }))}\n${JSON.stringify(t2)}\n`);
        const spawnFn: PiSpawnFn = () => {
            throw new Error("spawn test-pi ENOENT");
        };
        const { runDir } = await runTebCli(
            parseTebRunArgs(["--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"), "--replicates", "1"]),
            { spawnFn, extensionPath: join(dir, "index.ts"), piVersion: "test" },
        );
        try {
            const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8") as string) as {
                sessions: Array<{ infraFailure: { kind: string; detail: string } | null; error: string | null; spawnError: string | null }>;
            };
            expect(manifest.sessions).toHaveLength(2);
            for (const session of manifest.sessions) {
                expect(session.infraFailure).toMatchObject({ kind: "spawn" });
                expect(session.error).toContain("ENOENT");
            }
            expect(existsSync(join(runDir, "teb-pilot-definition-001", "baseline-r0", "error.txt"))).toBe(true);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });

    it("records effective affordance selectors and a surface identity for each configured arm", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-selector-"));
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask())}\n`);
        const extensionPath = join(dir, "index.ts");
        writeFileSync(extensionPath, "export {};\n");
        const configPath = join(dir, "arms.json");
        writeFileSync(configPath, JSON.stringify({ baseline: { env: { PI_SMARTREAD_AFFORDANCES: "0" } }, "lsp-affordance": { env: { PI_SMARTREAD_AFFORDANCES: "1" } } }));
        const { manifestPath } = await runTebCli(
            parseTebRunArgs(["--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"), "--dry-run", "--arms", "baseline,lsp-affordance", "--arms-config", configPath, "--limit", "1"]),
            { extensionPath, piVersion: "test" },
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { sessions: Array<{ arm: string; selectors: { general: boolean; inspect: boolean }; surfaceIdentity: string }> };
        expect(manifest.sessions.filter(({ arm }) => arm === "baseline").every(({ selectors }) => selectors.general === false && selectors.inspect === false)).toBe(true);
        expect(manifest.sessions.filter(({ arm }) => arm === "lsp-affordance").every(({ selectors }) => selectors.general === true && selectors.inspect === false)).toBe(true);
        expect(manifest.sessions.every((session) => /^[0-9a-f]{64}$/.test(session.surfaceIdentity))).toBe(true);
    });

    it("stores the full arm registry and arms config in the manifest (P1-7)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask())}\n`);
        const configPath = join(dir, "arms.json");
        writeFileSync(configPath, JSON.stringify({ gamma: { env: { TEB_G: "1" }, promptSuffix: "Try X." } }));
        const { manifestPath } = await runTebCli(
            parseTebRunArgs([
                "--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"),
                "--arms", "baseline,gamma", "--arms-config", configPath, "--dry-run",
            ]),
            { extensionPath: join(dir, "index.ts"), piVersion: "test" },
        );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8") as string) as {
            arms: Array<{ name: string; extensionPath?: string; env?: Record<string, string>; promptSuffix?: string }>;
            armsConfig: Record<string, unknown> | null;
        };
        expect(manifest.armsConfig).toEqual({ gamma: { env: { TEB_G: "1" }, promptSuffix: "Try X." } });
        const gamma = manifest.arms.find((a) => a.name === "gamma");
        expect(gamma?.env).toEqual({ TEB_G: "1" });
        expect(gamma?.promptSuffix).toBe("Try X.");
    });

    it("rejects unknown arm names before running (P1-7)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask())}\n`);
        await expect(
            runTebCli(
                parseTebRunArgs([
                    "--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"),
                    "--arms", "baseline,instructd",
                ]),
                { extensionPath: join(dir, "index.ts"), piVersion: "test" },
            ),
        ).rejects.toThrow(/unknown --arms/);
    });

    it("claims the sealed opening once for holdout runs (P1-1)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(
            tasksFile,
            `${JSON.stringify(definitionTask({ split: "holdout", id: "teb-holdout-definition-001", commit: sha }))}\n`,
        );
        const freeze = freezeFile(dir, tasksSha256(tasksFile));
        const fake: PiSpawnFn = (opts) =>
            fakeSpawn(['{"type":"message_end","message":{"responseModel":"m"}}'])({
                command: "pi", args: [], cwd: opts.cwd, env: {},
            });
        try {
            const baseArgs = [
                "--tasks", tasksFile, "--split", "holdout", "--out", join(dir, "out"),
                "--open-holdout", "--freeze-file", freeze,
            ];
            const first = await runTebCli(parseTebRunArgs(baseArgs), {
                spawnFn: fake, extensionPath: join(dir, "index.ts"), piVersion: "test", piBinarySha256: "c".repeat(64),
            });
            const manifest = JSON.parse(readFileSync(first.manifestPath, "utf8") as string) as {
                freeze: { champion: string; taskSha256: string; openingRecord: string } | null;
            };
            expect(manifest.freeze?.champion).toBe("champion-a");
            expect(existsSync(openingPathFor(freeze, tasksSha256(tasksFile)))).toBe(true);
            await expect(
                runTebCli(parseTebRunArgs(baseArgs), {
                    spawnFn: fake, extensionPath: join(dir, "index.ts"), piVersion: "test", piBinarySha256: "c".repeat(64),
                }),
            ).rejects.toThrow(/already opened/);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });

    it("rejects a holdout run whose freeze sha does not match the task file (P1-1)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ split: "holdout", id: "teb-holdout-definition-001" }))}\n`);
        const freeze = freezeFile(dir, "f".repeat(64));
        await expect(
            runTebCli(
                parseTebRunArgs([
                    "--tasks", tasksFile, "--split", "holdout", "--out", join(dir, "out"),
                    "--open-holdout", "--freeze-file", freeze,
                ]),
                { piVersion: "test" },
            ),
        ).rejects.toThrow(/does not match task file/);
    });

    it("flags contaminated sessions in the run record (E11a)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-run-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ commit: sha }))}\n`);
        const cache = benchCacheDir();
        const evil = JSON.stringify({
            type: "tool_execution_start",
            toolName: "bash",
            args: { command: `ls ${cache}/teb` },
        });
        const spawnFn: PiSpawnFn = (opts) =>
            fakeSpawn([evil])({ command: "pi", args: [], cwd: opts.cwd, env: {} });
        const { manifestPath } = await runTebCli(
            parseTebRunArgs(["--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"), "--replicates", "1"]),
            { spawnFn, extensionPath: join(dir, "index.ts"), piVersion: "test" },
        );
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8") as string) as {
                sessions: Array<{ contaminated: boolean; contaminationHit: string | null }>;
            };
            expect(manifest.sessions).toHaveLength(1);
            expect(manifest.sessions[0]?.contaminated).toBe(true);
            expect(manifest.sessions[0]?.contaminationHit).toBe(cache);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });
});
describe("classifyInfraFailure (E13.6)", () => {
    const fixture = new URL("../../fixtures/eval/teb/sample-session.jsonl", import.meta.url);
    const base = { logText: "", stderrText: "", spawnError: null as string | null, exitCode: 0 as number | null, signal: null as string | null, timedOut: false };
    it("returns null for a normally completed session", () => {
        expect(classifyInfraFailure({ ...base, logText: readFileSync(fixture, "utf8") })).toBeNull();
    });
    it("classifies spawn errors as spawn failures", () => {
        expect(classifyInfraFailure({ ...base, spawnError: "spawn pi ENOENT" })).toMatchObject({ kind: "spawn" });
    });
    it("classifies provider/auth errors before the first assistant message", () => {
        expect(
            classifyInfraFailure({ ...base, stderrText: "ERROR 401 Unauthorized: invalid API key", exitCode: 1 }),
        ).toMatchObject({ kind: "provider-auth" });
    });
    it("does not exclude provider errors that arrive after the first assistant message", () => {
        // After the first assistant token the session is graded, never excluded.
        const failure = classifyInfraFailure({
            ...base,
            logText: `{"type":"message_end","message":{"role":"assistant"}}\n{"type":"error","message":"rate limit 429"}`,
            exitCode: 1,
        });
        expect(failure === null || failure.kind !== "provider-auth").toBe(true);
    });
    it("classifies extension load failures", () => {
        expect(
            classifyInfraFailure({ ...base, stderrText: "Failed to load extension /ext/src/index.ts", exitCode: 1 }),
        ).toMatchObject({ kind: "extension-load" });
    });
    it("classifies non-timeout signals and nonzero exits as runner crashes", () => {
        expect(classifyInfraFailure({ ...base, signal: "SIGSEGV", exitCode: null })).toMatchObject({ kind: "runner" });
        expect(classifyInfraFailure({ ...base, exitCode: 2 })).toMatchObject({ kind: "runner" });
    });
    it("never classifies ordinary timeouts as infrastructure failures", () => {
        expect(classifyInfraFailure({ ...base, timedOut: true, signal: "SIGTERM", exitCode: null })).toBeNull();
    });
});

describe("turn limit (E13.6)", () => {
    it("launchPiSession kills the process group after --max-turns turn_start events", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-turns-"));
        const lines = [
            JSON.stringify({ type: "turn_start" }),
            JSON.stringify({ type: "turn_start" }),
            JSON.stringify({ type: "turn_start" }),
        ];
        let kills = 0;
        const spawnFn = fakeSpawn(lines, { onKill: () => { kills += 1; } });
        const result = await launchPiSession({
            piBin: "pi",
            args: [],
            cwd: dir,
            env: {},
            timeoutMs: 5_000,
            maxTurns: 2,
            outJsonl: join(dir, "events.jsonl"),
            outStderr: join(dir, "stderr.txt"),
            spawnFn,
        });
        expect(kills).toBeGreaterThan(0);
        expect(result.turnLimitHit).toBe(true);
        expect(result.turns).toBe(3);
    });
    it("records turn counts on the run record without firing under the limit", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-turns-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.json");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ commit: sha }))}
`);
        const events = [
            JSON.stringify({ type: "turn_start" }),
            JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
            JSON.stringify({ type: "turn_end" }),
        ];
        try {
            const { manifestPath } = await runTebCli(
                parseTebRunArgs([
                    "--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"),
                    "--replicates", "1", "--max-turns", "25",
                ]),
                { spawnFn: fakeSpawn(events), extensionPath: join(dir, "index.ts"), piVersion: "test" },
            );
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8") as string) as {
            maxTurns: number;
            sessions: Array<{ turnLimitHit: boolean; turns: number; infraFailure: null }>;
        };
        expect(manifest.maxTurns).toBe(25);
        expect(manifest.sessions).toHaveLength(1);
        expect(manifest.sessions[0]?.turnLimitHit).toBe(false);
        expect(manifest.sessions[0]?.turns).toBe(1);
        expect(manifest.sessions[0]?.infraFailure).toBeNull();
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });
});

describe("pi pin and holdout restrictions (E13.6)", () => {
    it("hashes the binary and reports unknown when it cannot be read", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-pi-"));
        const bin = join(dir, "pi");
        writeFileSync(bin, "pi-binary-bytes");
        expect(getPiBinarySha256(bin)).toBe(createHash("sha256").update(readFileSync(bin)).digest("hex"));
        expect(getPiBinarySha256(join(dir, "missing"))).toBe("unknown");
    });
    it("rejects a holdout opening whose pi version/sha differ from the freeze file", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-pi-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.json");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ commit: sha }))}
`);
        const freeze = join(dir, "freeze.json");
        writeFileSync(
            freeze,
            JSON.stringify({ champion: "baseline", taskSha256: tasksSha256(tasksFile), piVersion: "0.0.0", piBinarySha256: "f".repeat(64) }),
        );
        try {
            await expect(
                runTebCli(
                    parseTebRunArgs([
                        "--tasks", tasksFile,
                        "--out", join(dir, "out"),
                        "--arms", "baseline",
                        "--replicates", "1",
                        "--split", "holdout",
                        "--freeze-file", freeze,
                        "--open-holdout",
                    ]),
                    { spawnFn: fakeSpawn([]), extensionPath: join(dir, "index.ts"), piVersion: "test" },
                ),
            ).rejects.toThrow(/pi (version|binary sha256)/);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });
    it("rejects holdout arms beyond baseline + the frozen champion", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-holdout-arms-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.json");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ commit: sha }))}
`);
        const freeze = join(dir, "freeze.json");
        writeFileSync(
            freeze,
            JSON.stringify({ champion: "baseline", taskSha256: tasksSha256(tasksFile), piVersion: "test", piBinarySha256: "c".repeat(64) }),
        );
        try {
            await expect(
                runTebCli(
                    parseTebRunArgs([
                        "--tasks", tasksFile,
                        "--out", join(dir, "out"),
                        "--arms", "baseline,instructed",
                        "--replicates", "1",
                        "--split", "holdout",
                        "--freeze-file", freeze,
                        "--open-holdout",
                    ]),
                    { spawnFn: fakeSpawn([]), extensionPath: join(dir, "index.ts"), piVersion: "test", piBinarySha256: "c".repeat(64) },
                ),
            ).rejects.toThrow(/restricted to baseline/);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });
});
/* end of teb-run tests */

describe("--rerun-excluded (E13)", () => {
    it("relaunches exactly the excluded sessions with fresh attempt numbers", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-rerun-"));
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.jsonl");
        const t2 = definitionTask({ id: "teb-pilot-definition-002", commit: sha });
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ commit: sha }))}\n${JSON.stringify(t2)}\n`);
        try {
            // Prior batch: dry-run sessions are identity-excluded ("session
            // not run"), so both triples qualify for relaunch.
            const prior = await runTebCli(
                parseTebRunArgs(["--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "prior"), "--dry-run", "--replicates", "1"]),
                { extensionPath: join(dir, "index.ts"), piVersion: "test", piBinarySha256: "c".repeat(64) },
            );
            const priorManifest = JSON.parse(readFileSync(prior.manifestPath, "utf8") as string) as TebManifest;
            expect(priorManifest.sessions).toHaveLength(2);
            const rerun = await runTebCli(
                parseTebRunArgs([
                    "--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"),
                    "--dry-run", "--replicates", "1", "--rerun-excluded", prior.runDir,
                ]),
                { extensionPath: join(dir, "index.ts"), piVersion: "test", piBinarySha256: "c".repeat(64) },
            );
            const manifest = JSON.parse(readFileSync(rerun.manifestPath, "utf8") as string) as TebManifest;
            expect(manifest.rerunOf).toEqual({ runDir: prior.runDir, runId: priorManifest.runId });
            expect(manifest.sessions).toHaveLength(2);
            expect(manifest.sessions.map((s) => s.attempt)).toEqual([2, 2]);
            expect(manifest.runId).not.toBe(priorManifest.runId);
            // Originals stay untouched for audit.
            const untouched = JSON.parse(readFileSync(prior.manifestPath, "utf8") as string) as TebManifest;
            expect(untouched.sessions.map((s) => s.attempt)).toEqual([1, 1]);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });
    it("refuses a prior run with no excluded sessions", async () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-rerun-"));
        const priorDir = join(dir, "prior");
        mkdirSync(priorDir, { recursive: true });
        writeFileSync(
            join(priorDir, "manifest.json"),
            JSON.stringify({ runId: "old", sessions: [] }),
        );
        const repos = join(dir, "repos");
        const { sha } = makeGitRepo(repos, "fake__repo");
        process.env["TEB_REPOS_DIR"] = repos;
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${JSON.stringify(definitionTask({ commit: sha }))}\n`);
        try {
            await expect(
                runTebCli(
                    parseTebRunArgs([
                        "--tasks", tasksFile, "--split", "pilot", "--out", join(dir, "out"),
                        "--dry-run", "--rerun-excluded", priorDir,
                    ]),
                    { extensionPath: join(dir, "index.ts"), piVersion: "test" },
                ),
            ).rejects.toThrow(/no excluded sessions/);
        } finally {
            delete process.env["TEB_REPOS_DIR"];
        }
    });
});
