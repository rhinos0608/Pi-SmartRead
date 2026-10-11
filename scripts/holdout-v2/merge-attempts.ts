#!/usr/bin/env node
/** Merge whole-run retries for one frozen external-grep arm. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { summarizeMetrics, type InstanceMetrics } from "../eval/external/grep/metrics.js";

export interface AttemptInput {
    path: string;
    report?: unknown;
}

export interface MergeAttemptOptions {
    attempts: AttemptInput[];
    expectedInstanceIds: string[];
    outputPath: string;
}

interface Outcome extends Record<string, unknown> {
    instanceId: string;
    formulation: string;
    status: string;
}

interface ExternalReport extends Record<string, unknown> {
    judge: string;
    split: string;
    formulations: string[];
    manifestSha256: string;
    rankingKnobs: Record<string, unknown>;
    engineSourceHash: string;
    summary: Record<string, unknown> & { errors: number };
    outcomes: Outcome[];
}

interface LoadedAttempt {
    path: string;
    suppliedPath: string;
    bytes: Buffer;
    sha256: string;
    report: ExternalReport;
    errors: Array<{ instanceId: string; formulation: string; status: string }>;
    byPair: Map<string, Outcome>;
}

const pairKey = (instanceId: string, formulation: string): string => JSON.stringify([instanceId, formulation]);
const stable = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
};

function object(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
    return value as Record<string, unknown>;
}

/** Attempt reports are read through their canonical path, which provenance records. */
function readAttemptFile(path: string): { canonicalPath: string; bytes: Buffer } {
    const canonicalPath = realpathSync(path);
    if (!lstatSync(canonicalPath).isFile()) throw new Error(`attempt report is not a regular file: ${path}`);
    return { canonicalPath, bytes: readFileSync(canonicalPath) };
}

/**
 * The output must be an absolute path whose parent already exists with no
 * symlinked ancestor, and nothing (not even a dangling symlink) may occupy it;
 * otherwise the merged report could be written outside the intended directory.
 */
function checkOutputPath(outputPath: string): void {
    if (!isAbsolute(outputPath)) throw new Error(`output path must be absolute: ${outputPath}`);
    const parent = resolve(dirname(outputPath));
    let canonicalParent: string;
    try { canonicalParent = realpathSync(parent); }
    catch { throw new Error(`output directory does not exist: ${parent}`); }
    if (canonicalParent !== parent) throw new Error(`refusing output path with a symlinked ancestor: ${parent} -> ${canonicalParent}`);
    let occupied = true;
    try { lstatSync(outputPath); } catch { occupied = false; }
    if (occupied) throw new Error(`refusing to overwrite existing file: ${outputPath}`);
}

function loadAttempt(input: AttemptInput, expectedPairs: Set<string>): LoadedAttempt {
    let canonicalPath = input.path;
    let bytes: Buffer;
    if (input.report === undefined) ({ canonicalPath, bytes } = readAttemptFile(input.path));
    else bytes = Buffer.from(JSON.stringify(input.report));
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); }
    catch (error) { throw new Error(`unparseable attempt report ${input.path}: ${error instanceof Error ? error.message : String(error)}`); }
    const raw = object(parsed, `attempt report ${input.path}`);
    if (raw.judge !== "off") throw new Error(`attempt ${input.path} lacks judge-off evidence`);
    if (typeof raw.split !== "string" || !raw.split || typeof raw.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.manifestSha256)) {
        throw new Error(`attempt ${input.path} has invalid split or manifest sha`);
    }
    if (!Array.isArray(raw.formulations) || raw.formulations.length === 0 || !raw.formulations.every((f) => typeof f === "string" && f.length > 0)) {
        throw new Error(`attempt ${input.path} has invalid formulations`);
    }
    if (typeof raw.engineSourceHash !== "string" || raw.engineSourceHash.startsWith("unknown:")) throw new Error(`attempt ${input.path} has unknown engine source hash`);
    const knobs = object(raw.rankingKnobs, `attempt ${input.path} rankingKnobs`);
    const summary = object(raw.summary, `attempt ${input.path} summary`);
    if (!Number.isInteger(summary.errors) || (summary.errors as number) < 0) throw new Error(`attempt ${input.path} summary.errors must be a non-negative integer`);
    if (!Array.isArray(raw.outcomes)) throw new Error(`attempt ${input.path} outcomes must be an array`);
    const byPair = new Map<string, Outcome>();
    const errors: LoadedAttempt["errors"] = [];
    for (const item of raw.outcomes) {
        const outcome = object(item, `attempt ${input.path} outcome`) as Outcome;
        if (typeof outcome.instanceId !== "string" || typeof outcome.formulation !== "string" || typeof outcome.status !== "string") {
            throw new Error(`attempt ${input.path} has malformed outcome identity/status`);
        }
        const key = pairKey(outcome.instanceId, outcome.formulation);
        if (!expectedPairs.has(key)) throw new Error(`attempt ${input.path} contains unexpected pair ${outcome.instanceId}/${outcome.formulation}`);
        if (byPair.has(key)) throw new Error(`attempt ${input.path} contains duplicate pair ${outcome.instanceId}/${outcome.formulation}`);
        byPair.set(key, outcome);
        if (outcome.status.startsWith("error:") || outcome.status.startsWith("timeout:")) {
            errors.push({ instanceId: outcome.instanceId, formulation: outcome.formulation, status: outcome.status });
        }
    }
    if (byPair.size !== expectedPairs.size || [...expectedPairs].some((key) => !byPair.has(key))) {
        throw new Error(`attempt ${input.path} is missing one or more expected instance/formulation pairs`);
    }
    if (summary.errors !== errors.length) throw new Error(`attempt ${input.path} summary.errors does not match error outcome count`);
    return {
        path: canonicalPath, suppliedPath: input.path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"),
        report: { ...raw, judge: raw.judge, split: raw.split, formulations: raw.formulations as string[], manifestSha256: raw.manifestSha256,
            rankingKnobs: knobs, engineSourceHash: raw.engineSourceHash, summary: summary as ExternalReport["summary"], outcomes: raw.outcomes as Outcome[] },
        errors, byPair,
    };
}

/** Merge one to three ordered whole-run attempts without inspecting result scores. */
export function mergeAttemptReports(options: MergeAttemptOptions): { report: Record<string, unknown>; outputPath: string; sha256: string } {
    const { attempts, expectedInstanceIds, outputPath } = options;
    if (attempts.length < 1 || attempts.length > 3) throw new Error("requires one to three ordered attempts");
    checkOutputPath(outputPath);
    if (expectedInstanceIds.length === 0 || new Set(expectedInstanceIds).size !== expectedInstanceIds.length || expectedInstanceIds.some((id) => !id)) {
        throw new Error("expectedInstanceIds must be a non-empty unique list");
    }
    const firstReport = attempts[0]?.report;
    let formulations: string[];
    if (firstReport !== undefined) {
        formulations = object(firstReport, "first report").formulations as string[];
    } else {
        const { bytes } = readAttemptFile(attempts[0]!.path);
        formulations = object(JSON.parse(bytes.toString("utf8")), "first report").formulations as string[];
    }
    if (!Array.isArray(formulations) || formulations.length === 0 || new Set(formulations).size !== formulations.length) throw new Error("first report has invalid formulations");
    const expectedPairs = new Set(expectedInstanceIds.flatMap((id) => formulations.map((f) => pairKey(id, f))));
    const loaded = attempts.map((attempt) => loadAttempt(attempt, expectedPairs));
    const identity = (r: ExternalReport): string => stable({ split: r.split, formulations: r.formulations, manifestSha256: r.manifestSha256, rankingKnobs: r.rankingKnobs, judge: r.judge, engineSourceHash: r.engineSourceHash });
    const baselineIdentity = identity(loaded[0]!.report);
    for (let i = 1; i < loaded.length; i++) {
        if (identity(loaded[i]!.report) !== baselineIdentity) throw new Error(`attempt ${i + 1} identity mismatch (arm, split, manifest, ranking knobs, judge, or engine hash)`);
        if (loaded[i - 1]!.report.summary.errors === 0) throw new Error(`attempt ${i + 1} exists although the preceding attempt had no errors`);
    }
    const selected: Outcome[] = [];
    const taken = loaded.map(() => 0);
    const exclusions: Array<{ instanceId: string; formulation: string; status: string }> = [];
    for (const [instanceId, formulation] of expectedInstanceIds.flatMap((id) => formulations.map((f) => [id, f] as const))) {
        const key = pairKey(instanceId, formulation);
        let winner = -1;
        for (let i = 0; i < loaded.length; i++) {
            const outcome = loaded[i]!.byPair.get(key)!;
            if (!outcome.status.startsWith("error:") && !outcome.status.startsWith("timeout:")) { winner = i; selected.push(outcome); taken[i] = (taken[i] ?? 0) + 1; break; }
        }
        if (winner < 0) exclusions.push({ instanceId, formulation, status: loaded[loaded.length - 1]!.byPair.get(key)!.status });
    }
    const source = loaded[0]!.report;
    const chosenMetrics = selected as unknown as InstanceMetrics[];
    const report: Record<string, unknown> = {
        ...source,
        summary: summarizeMetrics(chosenMetrics),
        outcomes: selected,
        attemptMerge: {
            attempts: loaded.map((entry) => ({ path: entry.path, suppliedPath: entry.suppliedPath, sha256: entry.sha256, summaryErrors: entry.report.summary.errors, errors: entry.errors })),
            pairsTakenFromEachAttempt: taken,
            exclusions,
        },
    };
    const bytes = Buffer.from(JSON.stringify(report, null, 2), "utf8");
    // "wx" is O_CREAT|O_EXCL: it also refuses a symlink created at the path after the check.
    writeFileSync(outputPath, bytes, { flag: "wx", mode: 0o600 });
    return { report, outputPath, sha256: createHash("sha256").update(bytes).digest("hex") };
}
