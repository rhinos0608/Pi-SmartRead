/**
 * TEB (Tool Ergonomics Bench) scorer (E13.3): the single scoring entry
 * point consuming runner run records + tasks.
 *
 * Session validity is enforced HERE, not just recorded: ordinary
 * timeouts and contaminated sessions are graded failures in the primary
 * denominator (E10.5, E11a); identity mismatches and predeclared
 * infrastructure failures are excluded from paired analysis, listed in
 * the report, and rerun. Usage:
 *
 *   node --import tsx scripts/eval/teb/score.ts \
 *     --run-dir <runner out/run-id> --tasks <tasks.jsonl> \
 *     [--out <dir>] [--draws N] [--seed N] [--gate-values <json>]
 *
 * Pure per-session pieces are exported for unit tests; only scoreTebRun
 * and main() touch the filesystem.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractRunFromText, type TebExtractedRun } from "./extract.js";
import { gradeTebTask, type TebGradeResult } from "./grade.js";
import {
    aggregateRunMetrics,
    scoreRunMetrics,
    type TebAggregateMetrics,
    type TebRunMetrics,
} from "./metrics.js";
import {
    buildTebReport,
    sensitivityFor,
    type TebArmSummary,
    type TebValidityRow,
    type TebValiditySummary,
} from "./report.js";
import type { TebManifest, TebSessionRecord } from "./run.js";
import { parseTebJsonl, type TebTask } from "./schema.js";
import {
    evaluateGates,
    majorityPass,
    pairedBootstrap,
    taskDiffs,
    type TebBootstrapResult,
    type TebGateReport,
    type TebGateValues,
    type TebPairedTask,
} from "./stats.js";

/** E6 promotion-gate proposal; frozen values are set at sealing and passed via --gate-values. */
export const TEB_DEFAULT_GATE_VALUES: TebGateValues = {
    minSuccessGainPp: 5,
    minRecallGainPp: 15,
    minSpecialistPrecision: 0.8,
    maxNegativeDeteriorationPp: 3,
    maxLostPriorSuccessRate: 0.05,
};

export type TebSessionValidity = "valid" | "forced-failure" | "excluded";

export interface TebSessionScore {
    taskId: string;
    family: string;
    arm: string;
    replicate: number;
    pairId: string;
    validity: TebSessionValidity;
    /** Machine-readable validity detail (timeout, contamination hit, exclusion reason). */
    validityReason: string | null;
    /** Final session pass after validity enforcement. */
    pass: boolean;
    /** Grader binary pass before validity enforcement. */
    gradePass: boolean;
    gradeReason: TebGradeResult["reason"];
    secondary: number;
    metrics: TebRunMetrics;
}

export interface TebScoredArm {
    armId: string;
    sessions: TebSessionScore[];
    aggregates: TebAggregateMetrics;
    paired: TebPairedTask[];
    primaryBootstrap: TebBootstrapResult;
}

export interface TebScoreOutput {
    runDir: string;
    baselineArm: string;
    sessions: TebSessionScore[];
    validity: TebValiditySummary;
    arms: TebScoredArm[];
    gateValues: TebGateValues;
    gateValuesSource: string;
    gateReports: Record<string, TebGateReport>;
    warnings: string[];
    reportMarkdown: string;
    /** Latest-attempt bookkeeping per task x arm x replicate key. */
    attempts: Array<{ key: string; runDir: string; attempt: number }>;
}

/**
 * Validity classification from the runner record (E13.3). Classified
 * infrastructure failures and identity mismatches exclude the session
 * from paired analysis; timeouts, turn-limit kills and contamination
 * force failure but stay in the denominator.
 *
 * Precedence: a commit that never verified excludes first (the gold is
 * meaningless), then our own kills (timeout / turn-limit) and
 * contamination force failure AHEAD of any infra exclusion — the
 * runner only records `timedOut`/`turnLimitHit` for kills it fired
 * itself, and `classifyInfraFailure` already returns null for those,
 * so this ordering is belt and suspenders against misordered inputs.
 */
export function classifySessionValidity(session: TebSessionRecord): {
    validity: TebSessionValidity;
    reason: string | null;
} {
    if (!session.commitVerified) {
        return {
            validity: "excluded",
            reason: `commit not verified${session.error ? `: ${session.error}` : ""}`,
        };
    }
    if (session.timedOut || session.turnLimitHit) {
        return {
            validity: "forced-failure",
            reason: session.turnLimitHit
                ? "turn limit hit (counts as a failure like a timeout)"
                : "timeout (ordinary timeouts stay in the denominator)",
        };
    }
    if (session.contaminated) {
        return {
            validity: "forced-failure",
            reason: `contamination: tool-call args reference ${session.contaminationHit ?? "bench files"}`,
        };
    }
    if (session.infraFailure) {
        return {
            validity: "excluded",
            reason: `infrastructure failure (${session.infraFailure.kind}): ${session.infraFailure.detail}`,
        };
    }
    if (!session.identityOk) {
        return {
            validity: "excluded",
            reason: `identity mismatch: ${session.identityReason ?? "unresolved model identity"}`,
        };
    }
    return { validity: "valid", reason: null };
}

/**
 * Grades + scores one session record against its task. Takes the
 * session's event-log text (`null` when unreadable — an unreadable log
 * excludes the session, since its evidence cannot be trusted). The
 * extracted run is returned alongside for metric aggregation so callers
 * never re-read the log.
 */
export function scoreSession(
    session: TebSessionRecord,
    task: TebTask | undefined,
    logText: string | null,
): { score: TebSessionScore; run: TebExtractedRun } {
    const base = {
        taskId: session.taskId,
        family: session.family,
        arm: session.arm,
        replicate: session.replicate,
        pairId: session.pairId,
    };
    if (!task) {
        const empty = extractRunFromText("");
        // scoreRunMetrics indexes FAMILY_TABLE by family, so the
        // fallback carries a real negative-control family.
        const fallback = {
            id: session.taskId,
            family: "config-value",
            answerType: "scalar",
            gold: { kind: "scalar", value: "none" },
        } as unknown as TebTask;
        return {
            score: {
                ...base,
                validity: "excluded",
                validityReason: `unknown task ${session.taskId}`,
                pass: false,
                gradePass: false,
                gradeReason: "malformed",
                secondary: 0,
                metrics: scoreRunMetrics(fallback, empty),
            },
            run: empty,
        };
    }
    const classification = classifySessionValidity(session);
    if (logText === null) {
        const empty = extractRunFromText("");
        return {
            score: {
                ...base,
                validity: "excluded",
                validityReason: `unreadable event log: ${session.eventLog}`,
                pass: false,
                gradePass: false,
                gradeReason: "malformed",
                secondary: 0,
                metrics: scoreRunMetrics(task, empty),
            },
            run: empty,
        };
    }
    const run = extractRunFromText(logText);
    const transcript = run.assistantTexts.join("\n");
    const grade = gradeTebTask(task, transcript);
    const metrics = scoreRunMetrics(task, run);
    const pass =
        classification.validity === "excluded"
            ? false
            : classification.validity === "forced-failure"
              ? false
              : grade.pass;
    return {
        score: {
            ...base,
            validity: classification.validity,
            validityReason: classification.reason,
            pass,
            gradePass: grade.pass,
            gradeReason: grade.reason,
            secondary: grade.secondary,
            metrics,
        },
        run,
    };
}

function groupByTask(sessions: TebSessionScore[]): Map<string, TebSessionScore[]> {
    const groups = new Map<string, TebSessionScore[]>();
    for (const s of sessions) {
        const list = groups.get(s.taskId) ?? [];
        list.push(s);
        groups.set(s.taskId, list);
    }
    return groups;
}

/**
 * Builds paired task outcomes for arm vs baseline from included
 * (non-excluded) sessions. Replicates pair by shared logical
 * task + replicate AFTER attempt resolution and exclusion filtering:
 * each side votes by majority over the replicates present on BOTH
 * sides only (pairId is runId-dependent and may change on rerun, so
 * it is never the pairing key). A task with no common included
 * replicate is not paired. Duplicate attempts for one replicate
 * contribute a single vote (latest attempt wins, matching the
 * --merge-run-dirs resolution in scoreTebRun). Timeouts, turn-limit
 * kills and contamination arrive as included pass=false votes via
 * forced-failure, so they stay in the denominator here.
 */
export function pairArmVsBaseline(
    baseline: TebSessionScore[],
    arm: TebSessionScore[],
    tasksById: Map<string, TebTask>,
): TebPairedTask[] {
    const baseByTask = groupByTask(baseline);
    const armByTask = groupByTask(arm);
    const paired: TebPairedTask[] = [];
    const votesByReplicate = (sessions: TebSessionScore[]): Map<number, boolean> => {
        const votes = new Map<number, boolean>();
        for (const s of sessions) votes.set(s.replicate, s.pass);
        return votes;
    };
    for (const [taskId, baseSessions] of baseByTask) {
        const armSessions = armByTask.get(taskId);
        if (!armSessions) continue;
        const task = tasksById.get(taskId);
        if (!task) continue;
        const baseVotes = votesByReplicate(baseSessions);
        const armVotes = votesByReplicate(armSessions);
        const common = [...baseVotes.keys()].filter((replicate) => armVotes.has(replicate));
        if (common.length === 0) {
            continue;
        }
        paired.push({
            taskId,
            repo: task.repo,
            family: task.family,
            negativeControl: task.negativeControl,
            basePass: majorityPass(common.map((replicate) => baseVotes.get(replicate)!)),
            armPass: majorityPass(common.map((replicate) => armVotes.get(replicate)!)),
        });
    }
    return paired.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
}

export interface TebScoreOptions {
    runDir: string;
    tasksFile: string;
    outDir?: string;
    draws?: number;
    seed?: number;
    gateValues?: TebGateValues;
    gateValuesSource?: string;
    /**
     * Prior run dirs (e.g. `--rerun-excluded` outputs) to merge: for
     * each task x arm x replicate key the latest non-excluded attempt
     * wins; attempts are reported in the payload and report.
     */
    mergeRunDirs?: string[];
}

/** Resolves the manifest path: --run-dir holds manifest.json directly. */
export function manifestPathForRunDir(runDir: string): string {
    return join(resolve(runDir), "manifest.json");
}

/**
 * Full pipeline: manifest + tasks → per-session graded results with
 * validity enforcement → per-arm metric aggregates → paired task
 * outcomes vs baseline with bootstrap CIs → gate reports → markdown
 * report. Writes scored.json + report.md into outDir (default: runDir).
 */
export function scoreTebRun(options: TebScoreOptions): TebScoreOutput {
    const manifestPath = manifestPathForRunDir(options.runDir);
    if (!existsSync(manifestPath)) {
        throw new Error(`no manifest.json in --run-dir ${resolve(options.runDir)}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TebManifest;
    const tasksText = readFileSync(resolve(options.tasksFile), "utf8");
    const parsed = parseTebJsonl(tasksText);
    if (parsed.errors.length > 0) {
        throw new Error(`invalid task file: ${parsed.errors.slice(0, 5).join("; ")}`);
    }
    const tasksById = new Map<string, TebTask>(parsed.tasks.map((t) => [t.id, t]));
    // Rerun workflow (E13): gather attempts from the primary run plus
    // any merged prior runs, score every attempt, then keep the latest
    // non-excluded attempt per task x arm x replicate.
    const attemptSources: Array<{ runDir: string; session: TebSessionRecord }> = manifest.sessions.map(
        (session) => ({ runDir: resolve(options.runDir), session }),
    );
    for (const extraDir of options.mergeRunDirs ?? []) {
        const extraPath = manifestPathForRunDir(extraDir);
        if (!existsSync(extraPath)) {
            throw new Error(`no manifest.json in --merge-run-dirs entry ${resolve(extraDir)}`);
        }
        const extra = JSON.parse(readFileSync(extraPath, "utf8")) as TebManifest;
        for (const session of extra.sessions) attemptSources.push({ runDir: resolve(extraDir), session });
    }
    const readLog = (eventLog: string): string | null => {
        try {
            return readFileSync(eventLog, "utf8");
        } catch {
            return null;
        }
    };

    const attempts = attemptSources.map(({ runDir, session }) => ({
        task: tasksById.get(session.taskId),
        runDir,
        session,
        scored: scoreSession(session, tasksById.get(session.taskId), readLog(session.eventLog)),
    }));
    // Latest non-excluded attempt wins per task x arm x replicate
    // (argument order = attempt order); when every attempt is
    // excluded the latest attempt is kept so it stays listed.
    const byKey = new Map<string, (typeof attempts)[number][]>();
    for (const attempt of attempts) {
        const key = `${attempt.session.taskId} ${attempt.session.arm} r${attempt.session.replicate}`;
        const list = byKey.get(key) ?? [];
        list.push(attempt);
        byKey.set(key, list);
    }
    const full: Array<{ task: TebTask | undefined; score: TebSessionScore; run: TebExtractedRun }> = [];
    const attemptReport: Array<{ key: string; runDir: string; attempt: number }> = [];
    for (const [key, list] of [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const nonExcluded = list.filter((entry) => entry.scored.score.validity !== "excluded");
        const pool = nonExcluded.length > 0 ? nonExcluded : list;
        const winner = pool[pool.length - 1];
        if (!winner) continue;
        full.push({ task: winner.task, score: winner.scored.score, run: winner.scored.run });
        attemptReport.push({
            key,
            runDir: winner.runDir,
            attempt: typeof winner.session.attempt === "number" ? winner.session.attempt : list.indexOf(winner) + 1,
        });
    }
    const sessions = full.map((f) => f.score);
    const excludedRows: TebValidityRow[] = sessions
        .filter((s) => s.validity === "excluded")
        .map((s) => ({
            taskId: s.taskId,
            arm: s.arm,
            replicate: s.replicate,
            reason: s.validityReason ?? "excluded",
        }));
    const forcedRows: TebValidityRow[] = sessions
        .filter((s) => s.validity === "forced-failure")
        .map((s) => ({
            taskId: s.taskId,
            arm: s.arm,
            replicate: s.replicate,
            reason: s.validityReason ?? "forced failure",
        }));
    const validity: TebValiditySummary = {
        excluded: excludedRows,
        forcedFailures: forcedRows,
        excludedRate: sessions.length === 0 ? null : excludedRows.length / sessions.length,
    };

    const warnings: string[] = [];
    if (validity.excludedRate !== null && validity.excludedRate > 0.05) {
        warnings.push(
            `INVALID: excluded ${(validity.excludedRate * 100).toFixed(1)}% of sessions — batch invalid per protocol §10 (rerun exclusions with --rerun-excluded)`,
        );
    }

    const armIds = [...new Set(manifest.sessions.map((s) => s.arm))];
    const baselineArm = armIds.includes("baseline") ? "baseline" : (armIds[0] ?? "baseline");
    if (!armIds.includes("baseline")) {
        warnings.push(`no baseline arm in manifest; pairing against ${baselineArm}`);
    }
    const draws = options.draws ?? 10000;
    const seed = options.seed ?? 20261007;
    const gateValues = options.gateValues ?? TEB_DEFAULT_GATE_VALUES;

    const arms: TebScoredArm[] = [];
    for (const armId of armIds) {
        const armFull = full.filter(
            (f) => f.score.validity !== "excluded" && f.score.arm === armId && f.task,
        );
        const scored = armFull.map((f) => ({
            task: f.task as TebTask,
            run: f.run,
            metrics: f.score.metrics,
        }));
        const aggregates = aggregateRunMetrics(scored);
        const baseFull = full.filter((f) => f.score.validity !== "excluded" && f.score.arm === baselineArm);
        const paired = pairArmVsBaseline(
            baseFull.map((f) => f.score),
            armId === baselineArm ? baseFull.map((f) => f.score) : armFull.map((f) => f.score),
            tasksById,
        );
        // Unmatched-pair accounting: tasks on either side with no common
        // included replicate (or present on one side only) are dropped
        // from the paired denominator — reported here, never silently.
        const pairedIds = new Set(paired.map((p) => p.taskId));
        const candidateIds = new Set<string>();
        for (const f of armId === baselineArm ? baseFull : [...baseFull, ...armFull]) {
            if (f.task) candidateIds.add(f.score.taskId);
        }
        const unpaired = [...candidateIds].filter((id) => !pairedIds.has(id)).sort();
        if (unpaired.length > 0) {
            warnings.push(
                `${armId}: ${unpaired.length} task(s) with no common included replicate dropped from paired analysis: ${unpaired.join(", ")}`,
            );
        }
        arms.push({
            armId,
            sessions: armFull.map((f) => f.score),
            aggregates,
            paired,
            primaryBootstrap: pairedBootstrap(taskDiffs(paired), draws, seed),
        });
    }

    // Gate evaluation per non-baseline arm (baseline self-comparison is trivially empty).
    const gateReports: Record<string, TebGateReport> = {};
    const baselineSummary = arms.find((a) => a.armId === baselineArm);
    for (const arm of arms) {
        if (arm.armId === baselineArm) continue;
        const baseRecall = baselineSummary?.aggregates.opportunityRecall ?? null;
        const armRecall = arm.aggregates.opportunityRecall;
        let recallGainPp = 0;
        if (baseRecall === null || armRecall === null) {
            warnings.push(`opportunity recall unavailable for ${arm.armId} vs ${baselineArm}; recall gate evaluated as 0 gain`);
        } else {
            recallGainPp = (armRecall - baseRecall) * 100;
        }
        gateReports[arm.armId] = evaluateGates(
            { paired: arm.paired, recallGainPp, armPrecision: arm.aggregates.specialistPrecision },
            gateValues,
            draws,
            seed,
        );
    }

    const firstArmed = arms.find((a) => a.armId !== baselineArm) ?? baselineSummary;
    const gateEntries = Object.values(gateReports);
    const championGates: TebGateReport =
        gateEntries[0] ??
        ({
            gates: [],
            passed: true,
            lostPriorSuccesses: [],
            lostPriorSuccessRate: null,
            negativeMcNemar: { b: 0, c: 0, p: 1 },
            primaryBootstrap: pairedBootstrap([], draws, seed),
        } as TebGateReport);
    const summaries: TebArmSummary[] = arms.map((a) => ({
        armId: a.armId,
        paired: a.paired,
        aggregates: a.aggregates,
        primaryBootstrap: a.primaryBootstrap,
    }));
    // Baseline first for the report builder.
    summaries.sort((a, b) => (a.armId === baselineArm ? -1 : b.armId === baselineArm ? 1 : 0));
    const report = buildTebReport({
        arms: summaries,
        gateValues,
        gateReport: championGates,
        sensitivity: sensitivityFor(firstArmed?.paired ?? []),
        validity,
    });
    // Attempts section (rerun workflow): appended here (not in the
    // report builder) so the builder contract stays untouched.
    const mergedExtra = (options.mergeRunDirs ?? []).length > 0 || attemptReport.some((a) => a.attempt > 1);
    const attemptLines = [
        "",
        "## Attempts",
        ...attemptReport.map((a) => `- ${a.key}: attempt ${a.attempt} (${a.runDir})`),
    ];
    const reportMarkdown =
        report.markdown + (mergedExtra ? `${attemptLines.join("\n")}\n` : "");

    const outDir = resolve(options.outDir ?? options.runDir);
    mkdirSync(outDir, { recursive: true });
    const payload = {
        runDir: resolve(options.runDir),
        baselineArm,
        validity,
        gateValues,
        gateValuesSource: options.gateValuesSource ?? "default-e6-proposal",
        warnings,
        mergeRunDirs: (options.mergeRunDirs ?? []).map((d) => resolve(d)),
        attempts: attemptReport,
        sessions: sessions.map((s) => ({
            taskId: s.taskId,
            arm: s.arm,
            replicate: s.replicate,
            pairId: s.pairId,
            validity: s.validity,
            validityReason: s.validityReason,
            pass: s.pass,
            gradePass: s.gradePass,
            gradeReason: s.gradeReason,
            secondary: s.secondary,
            metrics: s.metrics,
        })),
        arms: arms.map((a) => ({
            armId: a.armId,
            sessions: a.sessions.length,
            aggregates: a.aggregates,
            paired: a.paired,
            primaryBootstrap: a.primaryBootstrap,
            gateReport: gateReports[a.armId] ?? null,
        })),
    };
    writeFileSync(join(outDir, "scored.json"), `${JSON.stringify(payload, null, 2)}\n`);
    writeFileSync(join(outDir, "report.md"), `${reportMarkdown}\n`);

    return {
        runDir: resolve(options.runDir),
        baselineArm,
        sessions,
        validity,
        arms,
        gateValues,
        gateValuesSource: options.gateValuesSource ?? "default-e6-proposal",
        gateReports,
        warnings,
        reportMarkdown,
        attempts: attemptReport,
    };
}

function parseScoreArgs(argv: string[]): TebScoreOptions {
    const get = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const runDir = get("--run-dir");
    if (!runDir) throw new Error("missing required --run-dir <runner out>");
    const tasksFile = get("--tasks");
    if (!tasksFile) throw new Error("missing required --tasks <jsonl>");
    const drawsRaw = get("--draws");
    const draws = drawsRaw === undefined ? undefined : Number(drawsRaw);
    if (draws !== undefined && (!Number.isInteger(draws) || draws < 1)) {
        throw new Error("--draws must be a positive integer");
    }
    const seedRaw = get("--seed");
    const seed = seedRaw === undefined ? undefined : Number(seedRaw);
    if (seed !== undefined && !Number.isInteger(seed)) throw new Error("--seed must be an integer");
    const gateValuesFile = get("--gate-values");
    const mergeRaw = get("--merge-run-dirs");
    const mergeRunDirs = mergeRaw === undefined ? undefined : mergeRaw.split(",").map((d) => d.trim()).filter((d) => d.length > 0);
    let gateValues: TebGateValues | undefined;
    if (gateValuesFile) {
        gateValues = JSON.parse(readFileSync(resolve(gateValuesFile), "utf8")) as TebGateValues;
    }
    return {
        runDir,
        tasksFile,
        outDir: get("--out"),
        draws,
        seed,
        gateValues,
        gateValuesSource: gateValuesFile ?? "default-e6-proposal",
        mergeRunDirs,
    };
}

function main(): void {
    try {
        const output = scoreTebRun(parseScoreArgs(process.argv.slice(2)));
        console.log(`scored ${output.sessions.length} sessions (${output.validity.excluded.length} excluded)`);
        console.log(`baseline: ${output.baselineArm}; gates: ${Object.keys(output.gateReports).join(", ") || "none"}`);
        if (output.warnings.length > 0) {
            for (const warning of output.warnings) console.log(`warning: ${warning}`);
        }
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}

const invokedAsCli = (() => {
    try {
        return resolve(process.argv[1] ?? "") === new URL(import.meta.url).pathname;
    } catch {
        return false;
    }
})();
if (invokedAsCli) main();
