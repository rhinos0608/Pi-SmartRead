/**
 * Checkpoint journal for the §9.16 kill-and-resume driver.
 *
 * One JSONL record per completed pair, appended with fsync before the next
 * pair starts. Restart rebuilds state from this file: deterministic pair
 * keys, duplicate rejection, and tolerance for exactly one torn final line
 * (a crash mid-write). Anything else malformed fails closed.
 */

import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";

export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Deterministic pair key (same JSON form as merge-attempts.ts). */
export function pairKey(instanceId: string, formulation: string): string {
    return JSON.stringify([instanceId, formulation]);
}

export type CheckpointRecord =
    | { v: 1; kind: "outcome"; pair: string; outcome: Record<string, unknown> }
    | { v: 1; kind: "excluded"; instanceId: string; exclusion: Record<string, unknown> }
    | { v: 1; kind: "attempt"; attempt: Record<string, unknown> }
    | { v: 1; kind: "dataset-failure"; datasetFailure: Record<string, unknown> }
    | { v: 1; kind: "setup-kill"; instanceId: string; at: string; elapsedMs: number };

export interface CheckpointState {
    outcomes: Map<string, Record<string, unknown>>;
    exclusions: Array<Record<string, unknown>>;
    attempts: Array<Record<string, unknown>>;
    datasetFailures: Array<Record<string, unknown>>;
    /** Killed-setup count per instance (§9.16: retry once, then record both). */
    setupKills: Map<string, number>;
    /** True when a torn final line was discarded on load. */
    tornLineDropped: boolean;
}

function parseRecord(value: unknown, lineNumber: number): CheckpointRecord {
    if (typeof value !== "object" || value === null) throw new Error(`checkpoint line ${lineNumber} is not an object`);
    const record = value as Record<string, unknown>;
    if (record.v !== CHECKPOINT_SCHEMA_VERSION) {
        throw new Error(`checkpoint line ${lineNumber} has unsupported version ${JSON.stringify(record.v)}`);
    }
    if (record.kind !== "outcome" && record.kind !== "excluded" && record.kind !== "attempt" && record.kind !== "dataset-failure" && record.kind !== "setup-kill") {
        throw new Error(`checkpoint line ${lineNumber} has unknown kind ${JSON.stringify(record.kind)}`);
    }
    return record as CheckpointRecord;
}

/**
 * Append one record and fsync before returning, so a kill or crash can lose
 * at most the in-flight pair. New files are created mode 0600.
 *
 * A trailing torn tail (a crash between write and fsync left bytes without
 * the terminating newline; checkpoint lines never contain bare newlines) is
 * truncated before appending, so a resumed writer can never bury a torn
 * line mid-file where the loader would rightly refuse it.
 */
export function appendCheckpointRecord(path: string, record: CheckpointRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    let existing: string | null = null;
    try {
        existing = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    if (existing !== null && existing !== "" && !existing.endsWith("\n")) {
        const idx = existing.lastIndexOf("\n");
        const repaired = idx === -1 ? "" : existing.slice(0, idx + 1);
        // Truncating rewrite, fsync'd like a normal append so the repair is
        // as durable as the record it carries.
        const fd = openSync(path, "w");
        try {
            writeSync(fd, repaired + line);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        return;
    }
    const fd = openSync(path, "a", 0o600);
    try {
        writeSync(fd, line);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

/** Load checkpoint state. A missing file is empty state, not an error. */
export function loadCheckpoint(path: string): CheckpointState {
    const state: CheckpointState = { outcomes: new Map(), exclusions: [], attempts: [], datasetFailures: [], setupKills: new Map(), tornLineDropped: false };
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return state;
        throw error;
    }
    const lines = text.split("\n");
    // A trailing newline yields a final empty element, which is not a record.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const lineNumber = i + 1;
        const isLast = i === lines.length - 1;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            // Crash mid-write tears only the final line; a corrupt
            // non-final line means history is untrustworthy — fail closed.
            if (isLast) {
                state.tornLineDropped = true;
                continue;
            }
            throw new Error(`checkpoint line ${lineNumber} is unparseable; refusing to guess`);
        }
        // A well-formed line with a bad version or kind is a foreign
        // record, never a torn write — fail closed even when last.
        const record = parseRecord(parsed, lineNumber);
        if (record.kind === "outcome") {
            if (state.outcomes.has(record.pair)) throw new Error(`checkpoint has a duplicate record for pair ${record.pair}`);
            state.outcomes.set(record.pair, record.outcome);
        } else if (record.kind === "excluded") {
            state.exclusions.push(record.exclusion);
        } else if (record.kind === "attempt") {
            state.attempts.push(record.attempt);
        } else if (record.kind === "dataset-failure") {
            state.datasetFailures.push(record.datasetFailure);
        } else {
            state.setupKills.set(record.instanceId, (state.setupKills.get(record.instanceId) ?? 0) + 1);
        }
    }
    return state;
}
