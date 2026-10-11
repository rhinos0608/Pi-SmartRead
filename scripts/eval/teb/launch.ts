/**
 * TEB runner process launcher: spawns one isolated `pi` session per
 * task x arm x replicate, streams stdout JSONL to disk with a runner
 * receipt timestamp, and enforces a wall-clock timeout.
 *
 * The spawn function is injectable so unit tests use a fake `pi`
 * (no network in unit tests). Production passes Node's
 * `child_process.spawn`.
 */

import { createWriteStream } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";

/** One experimental arm: env toggles + optional prompt suffix/extension. */
export interface TebArm {
    name: string;
    env?: Record<string, string>;
    promptSuffix?: string;
    extensionPath?: string;
}

export interface PiSpawnOptions {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    /** Detached so a timeout can kill the whole process tree. */
    detached?: boolean;
}

export interface PiSpawnHandle {
    stdout: AsyncIterable<string | Buffer> | NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
    pid?: number;
    on: (event: string, listener: (...args: never[]) => void) => void;
    kill: (signal?: NodeJS.Signals) => boolean;
}

export type PiSpawnFn = (opts: PiSpawnOptions) => PiSpawnHandle;

export function defaultSpawnFn(opts: PiSpawnOptions): PiSpawnHandle {
    const child: ChildProcess = nodeSpawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: opts.detached ?? true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    return child as unknown as PiSpawnHandle;
}

export interface LaunchPiSessionOptions {
    /** Usually "pi". */
    piBin?: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    /** Kill the process group after this many `turn_start` events (E13.6). Defaults to 25 (protocol §9.3). */
    maxTurns?: number;
    outJsonl: string;
    outStderr: string;
    spawnFn?: PiSpawnFn;
}

export interface LaunchPiSessionResult {
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    /** True when the turn limit fired (counts as a failure like a timeout). */
    turnLimitHit: boolean;
    /** Observed `turn_start` event count. */
    turns: number;
    /** stdout lines captured (raw text per line). */
    lines: number;
    elapsedMs: number;
    /** Spawn-level failure (e.g. ENOENT); null on a normal spawn. */
    spawnError: string | null;
}

/** Pids of currently running pi process groups (detached leaders). */
const activeGroupPids = new Set<number>();

/** Pids of live pi groups for the run.ts SIGINT/SIGTERM handler. */
export function activePiGroupPids(): number[] {
    return [...activeGroupPids];
}

/** SIGKILL every tracked process group (best effort; used on shutdown). */
export function killActivePiGroups(): void {
    for (const pid of activeGroupPids) {
        try {
            process.kill(-pid, "SIGKILL");
        } catch {
            // Already gone; nothing to reap.
        }
    }
}

/**
 * Spawn `piBin args`, wrap every stdout line as `{rt, event}` JSONL
 * (`rt` = wall-clock receipt ms since launch), and mirror stderr bytes
 * to `outStderr`. On `timeoutMs` the whole process tree is killed.
 */
export async function launchPiSession(opts: LaunchPiSessionOptions): Promise<LaunchPiSessionResult> {
    const piBin = opts.piBin ?? "pi";
    const timeoutMs = opts.timeoutMs;
    const spawnFn = opts.spawnFn ?? defaultSpawnFn;
    const startedAt = Date.now();
    const rt = (): number => Date.now() - startedAt;

    const out = createWriteStream(opts.outJsonl, { flags: "w" });
    const err = createWriteStream(opts.outStderr, { flags: "w" });
    const wroteOut = new Promise<void>((resolve, reject) => {
        out.on("error", reject);
        err.on("error", reject);
        out.on("open", () => resolve());
    });
    await wroteOut;

    const child = spawnFn({ command: piBin, args: opts.args, cwd: opts.cwd, env: opts.env, detached: true });
    if (child.pid !== undefined) activeGroupPids.add(child.pid);

    let stdoutBuffer = "";
    let lines = 0;
    let turns = 0;
    let turnLimitHit = false;
    const maxTurns = opts.maxTurns ?? 25;
    const isTurnStart = (event: unknown): boolean =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "turn_start";
    const recordLine = (line: string): void => {
        if (line.length === 0) return;
        let event: unknown;
        try {
            event = JSON.parse(line) as unknown;
        } catch {
            event = { type: "raw", text: line };
        }
        out.write(`${JSON.stringify({ rt: rt(), event })}\n`);
        lines += 1;
        // E13.6: count `turn_start` events and kill the process group
        // when the session exceeds --max-turns.
        if (isTurnStart(event)) {
            turns += 1;
            if (!turnLimitHit && turns > maxTurns) {
                turnLimitHit = true;
                killTree(child);
            }
        }
    };

    child.stderr?.on("data", (chunk: Buffer | string) => {
        err.write(chunk as string);
    });

    const stdoutDone = (async (): Promise<void> => {
        if (!child.stdout) return;
        for await (const chunk of child.stdout as AsyncIterable<string | Buffer>) {
            stdoutBuffer += chunk.toString();
            let index = stdoutBuffer.indexOf("\n");
            while (index >= 0) {
                recordLine(stdoutBuffer.slice(0, index).trimEnd());
                stdoutBuffer = stdoutBuffer.slice(index + 1);
                index = stdoutBuffer.indexOf("\n");
            }
        }
        if (stdoutBuffer.trimEnd().length > 0) recordLine(stdoutBuffer.trimEnd());
    })();

    let timedOut = false;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let spawnError: string | null = null;
    const exit = new Promise<void>((resolve) => {
        child.on("exit", (code: unknown, sig: unknown) => {
            exitCode = typeof code === "number" ? code : null;
            signal = typeof sig === "string" ? sig : null;
            resolve();
        });
        child.on("error", (cause: unknown) => {
            spawnError = cause instanceof Error ? cause.message : String(cause);
            resolve();
        });
    });

    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, timeoutMs);
        timer.unref?.();
    }

    await exit;
    if (timer) clearTimeout(timer);
    // A killed process normally closes stdio, ending stdoutDone. If it
    // does not (wedged pipe), do not wait forever: proceed after a
    // short grace so the timeout outcome is still recorded.
    await Promise.race([stdoutDone, new Promise((resolve) => setTimeout(resolve, 2000))]);
    // Reap descendants that outlive pi and still hold the group alive
    // (otherwise they keep paid sessions running and truncate output).
    reapGroupIfAlive(child);
    if (child.pid !== undefined) activeGroupPids.delete(child.pid);
    await new Promise<void>((resolve) => {
        let pending = 2;
        const done = (): void => {
            pending -= 1;
            if (pending <= 0) resolve();
        };
        out.end(done);
        err.end(done);
    });

    return { exitCode, signal, timedOut, turnLimitHit, turns, lines, elapsedMs: rt(), spawnError };
}

/** SIGKILL the group when grandchildren survive the pi exit. */
function reapGroupIfAlive(child: PiSpawnHandle): void {
    if (child.pid === undefined) return;
    let alive = false;
    try {
        process.kill(-child.pid, 0);
        alive = true;
    } catch {
        alive = false;
    }
    if (alive) killTree(child);
}

export function killTree(child: PiSpawnHandle): void {
    try {
        if (child.pid !== undefined) {
            // Negative pid targets the detached process group.
            process.kill(-child.pid, "SIGKILL");
            return;
        }
    } catch {
        // Fall through to direct kill.
    }
    try {
        child.kill("SIGKILL");
    } catch {
        // Process already gone; timeout flag still records the outcome.
    }
}

/**
 * Exact `pi` argv for one TEB session (flag spellings per `pi --help`).
 * `-p` is a boolean print flag and the prompt is a positional message,
 * so it is passed after `--`: a prompt starting with `-` or `@` must
 * never be parsed as a flag or `@file` reference.
 */
export function buildPiArgs(input: {
    extensionPath: string;
    model: string;
    thinking: string;
    tools: string;
    prompt: string;
}): string[] {
    return [
        "-ne",
        "-e",
        input.extensionPath,
        "--mode",
        "json",
        "--no-session",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--model",
        input.model,
        "--thinking",
        input.thinking,
        "--tools",
        input.tools,
        "-p",
        "--",
        input.prompt,
    ];
}
