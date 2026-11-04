/**
 * Unit + end-to-end tests for the TEB scorer (E13.3). Session validity is
 * enforced in scoring: timeout/contamination force failure, identity
 * mismatch and infrastructure failure exclude + list. The end-to-end test
 * builds a synthetic run dir in tmp (never a live cache) and scores the
 * whole pipeline: per-session results, paired outcomes vs baseline,
 * aggregates, gates, and the report.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TebExtractedRun } from "../../../scripts/eval/teb/extract.js";
import type { TebSessionRecord } from "../../../scripts/eval/teb/run.js";
import type { TebTask } from "../../../scripts/eval/teb/schema.js";
import {
    classifySessionValidity,
    pairArmVsBaseline,
    scoreSession,
    scoreTebRun,
    type TebSessionScore,
} from "../../../scripts/eval/teb/score.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function definitionTask(id: string, repo: string): TebTask {
    return {
        id,
        split: "pilot",
        repo,
        commit: SHA,
        subpath: "src",
        family: "definition",
        prompt: "Where is symbol `build`, as spelled at src/cli-main.ts:154:13, defined?",
        useSite: { path: "src/cli-main.ts", line: 154, character: 13 },
        anchorKind: "use",
        scope: "",
        answerType: "single-location",
        gold: {
            kind: "single-location",
            location: { path: "src/index.ts", line: 167, character: 23 },
        },
        opportunity: {
            tools: ["LSP"],
            rationale: "Exact jump in one call.",
            calls: ["LSP {operation: goToDefinition, path, position}"],
        },
        negativeControl: false,
        derivation: "lsp-probe.py v1",
        agreement: "agree",
        labelers: ["alice", "bob"],
        adjudication: "agree",
    };
}

const CORRECT = 'done\n```json\n{"answer": {"path": "src/index.ts", "line": 167, "character": 23}}\n```';
const WRONG = 'done\n```json\n{"answer": {"path": "src/nope.ts", "line": 1, "character": 1}}\n```';

function messageEnd(text: string): string {
    return JSON.stringify({
        type: "message_end",
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } },
        },
    });
}

function sessionRecord(overrides: Partial<TebSessionRecord> & { taskId: string }): TebSessionRecord {
    const { attempt = 1, ...rest } = overrides;
    return {
        attempt,
        runId: "teb-test",
        pairId: `teb-test:${overrides.taskId}:r${overrides.replicate ?? 0}`,
        family: "definition",
        arm: "baseline",
        replicate: 0,
        order: ["baseline"],
        cwd: "/tmp/teb-test",
        eventLog: "/tmp/teb-test/missing.jsonl",
        stderrLog: "/tmp/teb-test/stderr.txt",
        timedOut: false,
        turnLimitHit: false,
        turns: 0,
        exitCode: 0,
        signal: null,
        elapsedMs: 1000,
        spawnError: null,
        infraFailure: null,
        provider: "opencode-go",
        modelRequested: "opencode-go/deepseek-v4-flash",
        resolvedModel: "opencode-go/deepseek-v4-flash",
        thinkingRequested: "medium",
        thinkingResolved: "medium",
        identityOk: true,
        identityReason: null,
        checkoutSha: SHA,
        commitVerified: true,
        contaminated: false,
        contaminationHit: null,
        error: null,
        ...rest,
    };
}

describe("classifySessionValidity", () => {
    const task = "teb-pilot-definition-001";
    it("excludes infrastructure failures", () => {
        const { validity, reason } = classifySessionValidity(
            sessionRecord({
                taskId: task,
                infraFailure: { kind: "spawn", detail: "spawn failure: ENOENT pi" },
                spawnError: "ENOENT pi",
            }),
        );
        expect(validity).toBe("excluded");
        expect(reason).toContain("ENOENT");
    });
    it("excludes identity mismatches", () => {
        const { validity } = classifySessionValidity(
            sessionRecord({ taskId: task, identityOk: false, identityReason: "model mismatch" }),
        );
        expect(validity).toBe("excluded");
    });
    it("excludes unverified commits", () => {
        const { validity } = classifySessionValidity(
            sessionRecord({ taskId: task, commitVerified: false, error: "commit mismatch" }),
        );
        expect(validity).toBe("excluded");
    });
    it("forces timeouts, turn-limit kills and contamination to failure, not exclusion", () => {
        expect(classifySessionValidity(sessionRecord({ taskId: task, timedOut: true })).validity).toBe(
            "forced-failure",
        );
        expect(
            classifySessionValidity(sessionRecord({ taskId: task, turnLimitHit: true, turns: 40 })).validity,
        ).toBe("forced-failure");
        expect(
            classifySessionValidity(sessionRecord({ taskId: task, contaminated: true, contaminationHit: "x" }))
                .validity,
        ).toBe("forced-failure");
    });
    it("accepts clean sessions", () => {
        expect(classifySessionValidity(sessionRecord({ taskId: task })).validity).toBe("valid");
    });
    it("puts our own kills and contamination ahead of infra exclusion", () => {
        // A turn-limit kill explains the SIGKILL exit: graded failure,
        // never an exclusion, even with an infra record present.
        expect(
            classifySessionValidity(
                sessionRecord({
                    taskId: task,
                    timedOut: true,
                    turnLimitHit: true,
                    infraFailure: { kind: "runner", detail: "runner crash: signal SIGKILL before grading" },
                }),
            ).validity,
        ).toBe("forced-failure");
        expect(
            classifySessionValidity(
                sessionRecord({
                    taskId: task,
                    contaminated: true,
                    contaminationHit: "pi-smartread-bench",
                    infraFailure: { kind: "provider-auth", detail: "late auth blip" },
                }),
            ).validity,
        ).toBe("forced-failure");
    });
});

describe("scoreSession", () => {
    const task = definitionTask("teb-pilot-definition-001", "egoist__tsup");
    it("excludes sessions with unreadable logs", () => {
        const { score } = scoreSession(sessionRecord({ taskId: task.id }), task, null);
        expect(score.validity).toBe("excluded");
        expect(score.pass).toBe(false);
    });
    it("excludes sessions for unknown tasks", () => {
        const { score } = scoreSession(sessionRecord({ taskId: "nope" }), undefined, messageEnd(CORRECT));
        expect(score.validity).toBe("excluded");
    });
    it("forces a correct-but-timed-out answer to failure while keeping the grade", () => {
        const { score } = scoreSession(
            sessionRecord({ taskId: task.id, timedOut: true }),
            task,
            messageEnd(CORRECT),
        );
        expect(score.gradePass).toBe(true);
        expect(score.pass).toBe(false);
        expect(score.validity).toBe("forced-failure");
    });
});

describe("pairArmVsBaseline", () => {
    it("ties fail: a 1-1 split over the SAME replicates on both sides fails both votes", () => {
        // This test replaces a mislabeled predecessor that held baseline
        // replicates r0+r1 against an arm holding r0 only: with different
        // replicate sets per side it exercised mismatched-set voting, not
        // tie logic (baseline {pass, fail} tied -> false while the arm's
        // lone r0 passed). A genuine tie test needs identical replicate
        // sets on both sides: 1-1 on {r0, r1} must fail both votes.
        const tasksById = new Map([[ "t1", definitionTask("t1", "r") ]]);
        const run = { calls: [] } as unknown as TebExtractedRun;
        void run;
        const base = [
            { taskId: "t1", arm: "baseline", pass: true },
            { taskId: "t1", arm: "baseline", pass: false },
        ];
        const armed = [
            { taskId: "t1", arm: "instructed", pass: true },
            { taskId: "t1", arm: "instructed", pass: false },
        ];
        const paired = pairArmVsBaseline(
            base.map((b, i) => ({ ...sessionRecord({ taskId: "t1", replicate: i }), ...b, validity: "valid" as const, validityReason: null, gradePass: b.pass, gradeReason: "pass" as const, secondary: 1, metrics: {} as never })),
            armed.map((b, i) => ({ ...sessionRecord({ taskId: "t1", arm: "instructed", replicate: i }), ...b, validity: "valid" as const, validityReason: null, gradePass: b.pass, gradeReason: "pass" as const, secondary: 1, metrics: {} as never })),
            tasksById,
        );
        expect(paired).toHaveLength(1);
        expect(paired[0]!.basePass).toBe(false);
        expect(paired[0]!.armPass).toBe(false);
    });
});

function scoredSide(taskId: string, arm: string, replicate: number, pass: boolean): TebSessionScore {
    return {
        ...sessionRecord({ taskId, arm, replicate }),
        taskId,
        arm,
        replicate,
        validity: "valid" as const,
        validityReason: null,
        pass,
        gradePass: pass,
        gradeReason: "pass" as const,
        secondary: 1,
        metrics: {} as never,
    };
}

describe("matched-replicate pairing regression (P1)", () => {
    it("votes baseline and arm from the SAME shared replicates, not different surviving sets", () => {
        // Baseline kept replicates r0 (pass) + r1 (fail); the arm side
        // lost r1 (excluded) so only r0 (pass) survived there. The only
        // matching replica passes on both sides, so both votes must be
        // true. Current code votes baseline over {r0, r1} (tie -> false)
        // while voting the arm over {r0} — different denominators.
        const tasksById = new Map([["t1", definitionTask("t1", "r")]]);
        const paired = pairArmVsBaseline(
            [scoredSide("t1", "baseline", 0, true), scoredSide("t1", "baseline", 1, false)],
            [scoredSide("t1", "instructed", 0, true)],
            tasksById,
        );
        expect(paired).toHaveLength(1);
        expect(paired[0]!.basePass).toBe(true);
        expect(paired[0]!.armPass).toBe(true);
    });

    it("votes over partially overlapping sets using only the shared replicates", () => {
        // Baseline survived r0 (fail) + r1 (pass); the arm survived r1
        // (pass) + r2 (pass). Shared replicate is r1 only: both votes
        // must be true even though an all-survivors baseline majority
        // would tie (1-1 -> false).
        const tasksById = new Map([["t1", definitionTask("t1", "r")]]);
        const paired = pairArmVsBaseline(
            [scoredSide("t1", "baseline", 0, false), scoredSide("t1", "baseline", 1, true)],
            [scoredSide("t1", "instructed", 1, true), scoredSide("t1", "instructed", 2, true)],
            tasksById,
        );
        expect(paired).toHaveLength(1);
        expect(paired[0]!.basePass).toBe(true);
        expect(paired[0]!.armPass).toBe(true);
    });

    it("drops a task with no common included replicate (disjoint sets)", () => {
        // Baseline kept r0 only, the arm kept r1 only: no shared
        // replicate, so the task is not paired rather than voted from
        // disjoint denominators.
        const tasksById = new Map([["t1", definitionTask("t1", "r")]]);
        const paired = pairArmVsBaseline(
            [scoredSide("t1", "baseline", 0, true)],
            [scoredSide("t1", "instructed", 1, true)],
            tasksById,
        );
        expect(paired).toHaveLength(0);
    });

    it("pairs an infrastructure-excluded counterpart's surviving replicate only", () => {
        // scoreTebRun filters validity !== "excluded" before pairing, so
        // an excluded baseline r1 never reaches this function: pairing
        // sees baseline {r0 pass} against arm {r0 fail, r1 pass} and must
        // vote over the shared r0 (base true, arm false), not over the
        // arm's extra r1.
        const tasksById = new Map([["t1", definitionTask("t1", "r")]]);
        const paired = pairArmVsBaseline(
            [scoredSide("t1", "baseline", 0, true)],
            [scoredSide("t1", "instructed", 0, false), scoredSide("t1", "instructed", 1, true)],
            tasksById,
        );
        expect(paired).toHaveLength(1);
        expect(paired[0]!.basePass).toBe(true);
        expect(paired[0]!.armPass).toBe(false);
    });

    it("keeps forced failures (timeout/contamination) in the denominator", () => {
        // Forced-failure sessions stay included as pass=false votes: arm
        // r0 timed out (fail) while r1 passed, baseline passed r0 only.
        // Shared r0 decides both votes: base true, arm false.
        const tasksById = new Map([["t1", definitionTask("t1", "r")]]);
        const paired = pairArmVsBaseline(
            [scoredSide("t1", "baseline", 0, true)],
            [
                { ...scoredSide("t1", "instructed", 0, false), validity: "forced-failure", validityReason: "timeout" },
                scoredSide("t1", "instructed", 1, true),
            ],
            tasksById,
        );
        expect(paired).toHaveLength(1);
        expect(paired[0]!.basePass).toBe(true);
        expect(paired[0]!.armPass).toBe(false);
    });

    it("pairs legitimate reruns by replicate, never by runId-dependent pairId", () => {
        // A --rerun-excluded relaunch carries a new runId (hence a new
        // pairId) for the same logical task x arm x replicate. Pairing
        // must follow the replicate number; divergent pairIds pair fine.
        const tasksById = new Map([["t1", definitionTask("t1", "r")]]);
        const paired = pairArmVsBaseline(
            [{ ...scoredSide("t1", "baseline", 0, true), pairId: "teb-first:t1:r0" }],
            [{ ...scoredSide("t1", "instructed", 0, true), pairId: "teb-rerun:t1:r0" }],
            tasksById,
        );
        expect(paired).toHaveLength(1);
        expect(paired[0]!.basePass).toBe(true);
        expect(paired[0]!.armPass).toBe(true);
    });

    it("counts duplicate attempts for one replicate as a single vote (latest wins)", () => {
        // Attempt resolution normally dedupes in scoreTebRun, but a
        // retried replicate reaching pairing twice must still cast one
        // vote: latest attempt wins, no duplicate weight.
        const tasksById = new Map([["t1", definitionTask("t1", "r")]]);
        const paired = pairArmVsBaseline(
            [
                scoredSide("t1", "baseline", 0, false),
                scoredSide("t1", "baseline", 0, true),
                scoredSide("t1", "baseline", 1, true),
            ],
            [scoredSide("t1", "instructed", 0, true), scoredSide("t1", "instructed", 1, true)],
            tasksById,
        );
        expect(paired).toHaveLength(1);
        expect(paired[0]!.basePass).toBe(true);
        expect(paired[0]!.armPass).toBe(true);
    });
});
describe("scoreTebRun end to end on a synthetic run dir", () => {
    function buildRunDir(): { runDir: string; tasksFile: string } {
        const dir = mkdtempSync(join(tmpdir(), "teb-score-"));
        const tasks = [definitionTask("teb-pilot-definition-001", "egoist__tsup"), definitionTask("teb-pilot-definition-002", "egoist__tsup")];
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
        const logFor = (name: string, text: string): string => {
            const p = join(dir, `${name}.jsonl`);
            writeFileSync(p, `${messageEnd(text)}\n`);
            return p;
        };
        const sessions: TebSessionRecord[] = [
            sessionRecord({ taskId: tasks[0]!.id, arm: "baseline", eventLog: logFor("base-t1", CORRECT) }),
            sessionRecord({ taskId: tasks[1]!.id, arm: "baseline", eventLog: logFor("base-t2", WRONG) }),
            sessionRecord({ taskId: tasks[0]!.id, arm: "instructed", eventLog: logFor("arm-t1", CORRECT) }),
            sessionRecord({
                taskId: tasks[1]!.id,
                arm: "instructed",
                timedOut: true,
                eventLog: logFor("arm-t2-timeout", CORRECT),
            }),
            sessionRecord({
                taskId: tasks[1]!.id,
                arm: "instructed",
                replicate: 1,
                pairId: "teb-test:teb-pilot-definition-002:r1",
                contaminated: true,
                contaminationHit: ".cache/pi-smartread-bench",
                eventLog: logFor("arm-t2-contam", CORRECT),
            }),
            sessionRecord({
                taskId: tasks[0]!.id,
                arm: "baseline",
                replicate: 1,
                pairId: "teb-test:teb-pilot-definition-001:r1",
                identityOk: false,
                identityReason: "model mismatch",
                eventLog: logFor("base-t1-identity", CORRECT),
            }),
            sessionRecord({
                taskId: tasks[0]!.id,
                arm: "instructed",
                replicate: 1,
                pairId: "teb-test:teb-pilot-definition-001:r1",
                infraFailure: { kind: "spawn", detail: "spawn failure: spawn pi ENOENT" },
                spawnError: "spawn pi ENOENT",
                eventLog: logFor("arm-t1-infra", CORRECT),
            }),
        ];
        const manifest = {
            runnerVersion: 1,
            runId: "teb-test",
            taskFileSha256: "x",
            arms: ["baseline", "instructed"],
            sessions,
        };
        const runDir = join(dir, "run");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
        return { runDir, tasksFile };
    }

    it("enforces validity, pairs vs baseline, and writes scored.json + report.md", () => {
        const { runDir, tasksFile } = buildRunDir();
        const output = scoreTebRun({ runDir, tasksFile, draws: 200, seed: 7 });
        expect(output.sessions).toHaveLength(7);
        expect(output.baselineArm).toBe("baseline");

        const by = (arm: string, taskSuffix: string, replicate = 0): (typeof output.sessions)[number] =>
            output.sessions.find(
                (s) => s.arm === arm && s.taskId.endsWith(taskSuffix) && s.replicate === replicate,
            )!;
        // Valid sessions grade normally.
        expect(by("baseline", "001").pass).toBe(true);
        expect(by("baseline", "002").pass).toBe(false);
        // Timeout/contamination: correct answers forced to failure.
        const timedOut = by("instructed", "002");
        expect(timedOut.gradePass).toBe(true);
        expect(timedOut.pass).toBe(false);
        expect(timedOut.validity).toBe("forced-failure");
        const contam = by("instructed", "002", 1);
        expect(contam.validity).toBe("forced-failure");
        expect(contam.pass).toBe(false);
        // Identity/infra: excluded and listed.
        expect(by("baseline", "001", 1).validity).toBe("excluded");
        expect(by("instructed", "001", 1).validity).toBe("excluded");
        expect(output.validity.excluded).toHaveLength(2);
        expect(output.validity.forcedFailures).toHaveLength(2);
        expect(output.reportMarkdown).toContain("## Session validity");
        expect(output.reportMarkdown).toContain("identity mismatch");
        expect(output.reportMarkdown).toContain("spawn pi ENOENT");

        // Paired analysis excludes the bad sessions: baseline t1 pairs on
        // replicate 0 only (valid pass); instructed t1 replicate 0 passes.
        const instructed = output.arms.find((a) => a.armId === "instructed")!;
        expect(instructed.paired).toHaveLength(2);
        expect(output.gateReports["instructed"]).toBeDefined();
        // 2/7 excluded trips the >5% INVALID batch flag.
        expect(output.warnings.some((w) => w.includes("INVALID"))).toBe(true);

        expect(existsSync(join(runDir, "scored.json"))).toBe(true);
        expect(existsSync(join(runDir, "report.md"))).toBe(true);
        const scored = JSON.parse(readFileSync(join(runDir, "scored.json"), "utf8")) as {
            sessions: unknown[];
            validity: { excluded: unknown[]; forcedFailures: unknown[] };
        };
        expect(scored.sessions).toHaveLength(7);
        expect(scored.validity.excluded).toHaveLength(2);
        expect(scored.validity.forcedFailures).toHaveLength(2);
    });

    it("rejects a run dir without a manifest", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-score-empty-"));
        expect(() => scoreTebRun({ runDir: dir, tasksFile: join(dir, "t.jsonl") })).toThrow();
    });

    it("warns on tasks with no common included replicate instead of implying full coverage", () => {
        const dir = mkdtempSync(join(tmpdir(), "teb-score-unpaired-"));
        const tasks = [definitionTask("teb-pilot-definition-001", "egoist__tsup"), definitionTask("teb-pilot-definition-002", "egoist__tsup")];
        const tasksFile = join(dir, "tasks.jsonl");
        writeFileSync(tasksFile, `${tasks.map((t) => JSON.stringify(t)).join("\n")}\n`);
        const logFor = (name: string, text: string): string => {
            const p = join(dir, `${name}.jsonl`);
            writeFileSync(p, `${messageEnd(text)}\n`);
            return p;
        };
        const sessions: TebSessionRecord[] = [
            sessionRecord({ taskId: tasks[0]!.id, arm: "baseline", eventLog: logFor("base-t1", CORRECT) }),
            sessionRecord({ taskId: tasks[1]!.id, arm: "baseline", eventLog: logFor("base-t2", CORRECT) }),
            sessionRecord({ taskId: tasks[0]!.id, arm: "instructed", eventLog: logFor("arm-t1", CORRECT) }),
        ];
        const runDir = join(dir, "run");
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
            join(runDir, "manifest.json"),
            `${JSON.stringify({ runnerVersion: 1, runId: "teb-unpaired", taskFileSha256: "x", arms: ["baseline", "instructed"], sessions })}\n`,
        );
        const output = scoreTebRun({ runDir, tasksFile, draws: 200, seed: 7 });
        const instructed = output.arms.find((a) => a.armId === "instructed")!;
        expect(instructed.paired.map((p) => p.taskId)).toEqual([tasks[0]!.id]);
        expect(output.warnings.some((w) => w.includes("instructed") && w.includes(tasks[1]!.id))).toBe(true);
        const baseline = output.arms.find((a) => a.armId === "baseline")!;
        expect(baseline.paired).toHaveLength(2);
    });

    it("merges rerun attempts keeping the latest non-excluded attempt", () => {
        const { runDir, tasksFile } = buildRunDir();
        // Prior attempt for the infra-excluded key
        // (teb-pilot-definition-001 instructed r1): valid and passing.
        const priorDir = mkdtempSync(join(tmpdir(), "teb-score-prior-"));
        const priorLog = join(priorDir, "prior.jsonl");
        writeFileSync(priorLog, `${messageEnd(CORRECT)}\n`);
        const priorSessions = [
            sessionRecord({
                taskId: "teb-pilot-definition-001",
                arm: "instructed",
                replicate: 1,
                pairId: "teb-prior:teb-pilot-definition-001:r1",
                attempt: 1,
                eventLog: priorLog,
            }),
        ];
        writeFileSync(
            join(priorDir, "manifest.json"),
            `${JSON.stringify({ runnerVersion: 1, runId: "teb-prior", taskFileSha256: "x", arms: ["instructed"], sessions: priorSessions })}\n`,
        );
        const output = scoreTebRun({ runDir, tasksFile, draws: 200, seed: 7, mergeRunDirs: [priorDir] });
        const rescued = output.sessions.find(
            (s) => s.arm === "instructed" && s.taskId.endsWith("001") && s.replicate === 1,
        )!;
        expect(rescued.validity).toBe("valid");
        expect(rescued.pass).toBe(true);
        // Still 7 keys: the rerun replaced the excluded attempt.
        expect(output.sessions).toHaveLength(7);
        expect(output.validity.excluded).toHaveLength(1);
        expect(
            output.attempts.find((a) => a.key === "teb-pilot-definition-001 instructed r1"),
        ).toMatchObject({ attempt: 1 });
        expect(output.reportMarkdown).toContain("## Attempts");
    });
});
