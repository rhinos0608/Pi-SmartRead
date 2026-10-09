/**
 * TEB (Tool Ergonomics Bench) durable runner: launches isolated `pi`
 * sessions per task x arm x replicate with JSON-event capture.
 *
 * Binding inputs: protocol §9 (E6/E7/E10 as amended by the E10
 * resolutions in the decision log). The prompt is built from the
 * RunnerTaskView only (id/prompt/answer-shape); gold, opportunity,
 * thresholds, adjudication, derivation, and agreement never enter it.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    accessSync,
    constants as fsConstants,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { FAMILY_TABLE, parseTebJsonl, toRunnerView, type RunnerTaskView, type TebSplit, type TebTask } from "./schema.js";
// Static import is cycle-safe: score.ts imports run.ts type-only
// (erased at runtime), and both CLI mains are argv-guarded.
import { classifySessionValidity } from "./score.js";
import { parseSurfaceIdentity, SurfaceIdentityError } from "../surface-identity.js";
import {
    buildPiArgs,
    killActivePiGroups,
    launchPiSession,
    type PiSpawnFn,
    type TebArm,
} from "./launch.js";

export const TEB_TOOL_ALLOWLIST = "read,bash,grep,find,inspect,LSP";

export const TEB_RUNNER_VERSION = 1;

/** Frozen instructed-arm (D) substitution table, §9.1: tool name only. */
export const TEB_INSTRUCTED_TOOL_TABLE: Record<string, { tool: string; gloss: string }> = {
    definition: { tool: "LSP", gloss: "a language server that resolves exact definitions and references" },
    "all-references": { tool: "LSP", gloss: "a language server that resolves exact definitions and references" },
    implementations: { tool: "LSP", gloss: "a language server that resolves exact definitions and references" },
    callers: { tool: "LSP", gloss: "a language server that resolves exact definitions and references" },
    "type-of-symbol": { tool: "LSP", gloss: "a language server that resolves exact definitions and references" },
    "direct-importers": { tool: "grep", gloss: "text search that finds import statements" },
    "package-exports": { tool: "inspect", gloss: "a structural map of a package's files" },
    "http-routes": { tool: "inspect", gloss: "a structural scan of HTTP route registrations" },
};

export function instructedSuffixFor(family: string): string | null {
    const entry = TEB_INSTRUCTED_TOOL_TABLE[family];
    if (!entry) return null;
    return (
        `\n\nFor this task you MUST call the \`${entry.tool}\` tool at least once before ` +
        `giving your final answer. \`${entry.tool}\` is ${entry.gloss}. If the task ` +
        `turns out to be solvable without it, still call it once, then answer normally.`
    );
}

function effectiveAffordanceSelectors(armEnv: Record<string, string>): { general: boolean; inspect: boolean; invalid?: string[] } {
    const env = { ...process.env, ...armEnv };
    const raw = [env["PI_SMARTREAD_AFFORDANCES"] ?? "0", env["PI_SMARTREAD_INSPECT_AFFORDANCES"] ?? "0"];
    const invalid = raw.flatMap((value, index) => (value === "0" || value === "1" ? [] : [index === 0 ? "PI_SMARTREAD_AFFORDANCES" : "PI_SMARTREAD_INSPECT_AFFORDANCES"]));
    return { general: raw[0] === "1", inspect: raw[1] === "1", ...(invalid.length > 0 ? { invalid } : {}) };
}

export interface TebRunArgs {
    tasks: string;
    split: TebSplit;
    arms: string[];
    armsConfig: string | null;
    replicates: number;
    maxTurns: number;
    model: string;
    thinking: string;
    timeoutMs: number;
    out: string;
    dryRun: boolean;
    limit: number | null;
    taskIds: string[] | null;
    openHoldout: boolean;
    freezeFile: string | null;
    piBin: string;
    /**
     * Prior run dir whose excluded (identity/infra) sessions are
     * relaunched with fresh attempt numbers. Originals stay in the
     * prior dir for audit; scoring merges via --merge-run-dirs.
     */
    rerunExcluded: string | null;
}

export function parseTebRunArgs(argv: string[]): TebRunArgs {
    const get = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const has = (flag: string): boolean => argv.includes(flag);
    const tasks = get("--tasks");
    if (!tasks) throw new Error("missing required --tasks <jsonl>");
    const split = get("--split") ?? "pilot";
    if (split !== "pilot" && split !== "dev" && split !== "holdout") {
        throw new Error(`unknown --split ${JSON.stringify(split)}`);
    }
    const armsRaw = get("--arms") ?? "baseline";
    const arms = armsRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    if (arms.length === 0) throw new Error("--arms must name at least one arm");
    const replicates = Number(get("--replicates") ?? "3");
    if (!Number.isInteger(replicates) || replicates < 1) throw new Error("--replicates must be a positive integer");
    const maxTurnsRaw = get("--max-turns");
    const maxTurns = Number(maxTurnsRaw ?? "25");
    if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("--max-turns must be a positive integer");
    const model = get("--model") ?? "opencode-go/deepseek-v4-flash";
    // Default thinking is "high": the primary bench provider
    // (opencode-go/deepseek-v4-flash) resolves every requested level to
    // high, so requesting "medium" fails session identity on every run.
    const thinking = get("--thinking") ?? "high";
    const timeoutMs = Number(get("--timeout-ms") ?? "240000");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
    const out = get("--out");
    if (!out) throw new Error("missing required --out <dir>");
    const limitRaw = get("--limit");
    const limit = limitRaw === undefined ? null : Number(limitRaw);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
    const taskIdsRaw = get("--task-ids");
    const taskIds = taskIdsRaw === undefined ? null : taskIdsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const rerunExcluded = get("--rerun-excluded") ?? null;
    if (rerunExcluded !== null && rerunExcluded.length === 0) throw new Error("--rerun-excluded needs a prior run dir");
    return {
        tasks,
        split: split as TebSplit,
        arms,
        armsConfig: get("--arms-config") ?? null,
        replicates,
        maxTurns,
        model,
        thinking,
        timeoutMs,
        out,
        dryRun: has("--dry-run"),
        limit,
        taskIds,
        openHoldout: has("--open-holdout"),
        freezeFile: get("--freeze-file") ?? null,
        piBin: get("--pi-bin") ?? defaultPiBin(),
        rerunExcluded,
    };
}

/**
 * Holdout guard: the sealed split opens exactly once, only with
 * --open-holdout plus a freeze file recording the opening. Returns the
 * refusal reason, or null when the run may proceed.
 *
 * The freeze file must be predeclared JSON carrying the champion id and
 * the sealed task-file sha256; the opening itself is claimed atomically
 * (see claimHoldoutOpening) after the task sha is verified.
 */
export interface TebFreezeFile {
    champion: string;
    taskSha256: string;
    /** Pinned pi release (E13.6): required — the holdout opens fail-closed without it. */
    piVersion: string;
    /** sha256 of the pinned pi binary (E13.6): required — the holdout opens fail-closed without it. */
    piBinarySha256: string;
}

export function parseFreezeFile(text: string): TebFreezeFile {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        throw new Error("freeze file is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error("freeze file must be a JSON object with champion + taskSha256");
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record["champion"] !== "string" || (record["champion"] as string).length === 0) {
        throw new Error("freeze file must carry a non-empty champion id");
    }
    if (typeof record["taskSha256"] !== "string" || !/^[0-9a-f]{64}$/.test(record["taskSha256"] as string)) {
        throw new Error("freeze file must carry the sealed task-file sha256");
    }
    const freeze: TebFreezeFile = { champion: record["champion"] as string, taskSha256: record["taskSha256"] as string, piVersion: "", piBinarySha256: "" };
    // E13.6 + protocol §10: the freeze records PATH, VERSION and SHA256
    // and a version mismatch is rejected at opening — so both pins are
    // required here (fail closed when absent), not merely checked when present.
    if (typeof record["piVersion"] !== "string" || record["piVersion"].length === 0) {
        throw new Error("freeze file must carry the pinned piVersion (fail closed: refusing to open the holdout without it)");
    }
    freeze.piVersion = record["piVersion"];
    if (typeof record["piBinarySha256"] !== "string" || !/^[0-9a-f]{64}$/.test(record["piBinarySha256"])) {
        throw new Error("freeze file must carry the pinned piBinarySha256 hex (fail closed: refusing to open the holdout without it)");
    }
    freeze.piBinarySha256 = record["piBinarySha256"];
    return freeze;
}

export function checkHoldoutGuard(args: TebRunArgs): string | null {
    if (args.split !== "holdout") return null;
    if (!args.openHoldout) return "holdout split requires --open-holdout (single sealed opening)";
    if (!args.freezeFile) return "holdout split requires --freeze-file <path> recording the single opening";
    if (!existsSync(args.freezeFile)) return `freeze file not found: ${args.freezeFile}`;
    try {
        parseFreezeFile(readFileSync(args.freezeFile, "utf8"));
    } catch (error) {
        return `invalid freeze file: ${error instanceof Error ? error.message : String(error)}`;
    }
    return null;
}

/**
 * Opening-record path for a sealed holdout opening (E13.6). The record
 * is keyed to the sealed task-file sha256 — not to the freeze filename
 * alone — so a freeze file can never be repointed at a different sealed
 * set while reusing a prior opening.
 */
export function openingPathFor(freezeFile: string, taskSha256: string): string {
    return `${freezeFile}.${taskSha256}.opening.json`;
}

/**
 * Atomically claim the single sealed opening. The record is written
 * with `wx` at openingPathFor(freezeFile, taskSha256); a second claim
 * fails because the record already exists. Returns the opening-record path.
 */
export function claimHoldoutOpening(
    freezeFile: string,
    opening: { champion: string; taskSha256: string; runId: string; openedAt: string },
): string {
    const openingPath = openingPathFor(freezeFile, opening.taskSha256);
    try {
        writeFileSync(openingPath, `${JSON.stringify(opening, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
            throw new Error(`holdout already opened (opening record exists: ${openingPath})`);
        }
        throw error;
    }
    return openingPath;
}

export function sha256Hex(text: string | Buffer): string {
    return createHash("sha256").update(text).digest("hex");
}

export function sha256File(path: string): string {
    return sha256Hex(readFileSync(path));
}

/**
 * sha256 of the pinned `pi` binary (E13.6), or `"unknown"` when the
 * binary cannot be read (missing file, permission error, directory).
 */
export function getPiBinarySha256(piBin: string): string {
    try {
        return sha256File(piBin);
    } catch {
        return "unknown";
    }
}

/** Prompt from the RunnerTaskView only, plus an arm suffix for D arms. */
export function buildTaskPrompt(view: RunnerTaskView, arm: TebArm): string {
    const shapeBlock =
        `End your run with exactly one fenced json block as the last substantive output, ` +
        `with this shape and no extra keys:\n\`\`\`json\n${view.answerShape}\n\`\`\``;
    const suffix = arm.promptSuffix ?? "";
    return `${view.prompt}\n\n${shapeBlock}${suffix}`;
}

/** Built-in arm names. Anything else must come from --arms-config. */
export const TEB_BUILTIN_ARMS: readonly string[] = ["baseline", "instructed"] as const;

/** Per-arm overrides from a --arms-config JSON file. */
export type TebArmsConfig = Record<string, Partial<Pick<TebArm, "extensionPath" | "env" | "promptSuffix">> & { expectedIdentity?: { general: boolean; inspect: false } }>;

/** Load a --arms-config JSON file: {"<arm>": {extensionPath?, env?, promptSuffix?}}. */
export function loadArmsConfig(path: string): TebArmsConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
        throw new Error(`cannot read --arms-config ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`--arms-config ${path} must be a JSON object keyed by arm name`);
    }
    return parsed as TebArmsConfig;
}

/**
 * Resolve the arm list. `baseline` runs the frozen post-E1 setup;
 * `instructed` (D) adds the frozen per-family tool-only suffix on
 * non-negative tasks. Unknown names are rejected: a typo must never
 * silently run the baseline. Extra intervention arms come from
 * --arms-config as an explicit {name, extensionPath, env, promptSuffix}
 * registry.
 */
export function resolveArms(
    names: string[],
    extensionPath: string,
    taskFamily?: string,
    armConfigs: TebArmsConfig = {},
): TebArm[] {
    const known = [...TEB_BUILTIN_ARMS, ...Object.keys(armConfigs)];
    return names.map((name) => {
        const configured = armConfigs[name] ?? {};
        if (name === "instructed") {
            const suffix = taskFamily ? (instructedSuffixFor(taskFamily) ?? undefined) : undefined;
            return {
                name,
                promptSuffix: suffix ?? configured.promptSuffix,
                extensionPath: configured.extensionPath ?? extensionPath,
                env: configured.env,
            };
        }
        if (
            name === "baseline" ||
            configured.extensionPath !== undefined ||
            configured.env !== undefined ||
            configured.promptSuffix !== undefined
        ) {
            return {
                name,
                extensionPath: configured.extensionPath ?? extensionPath,
                env: configured.env,
                promptSuffix: configured.promptSuffix,
            };
        }
        throw new Error(`unknown --arms ${JSON.stringify(name)} (known: ${known.join(", ")})`);
    });
}

/**
 * Paired AB/BA alternation keyed by the stable task id hash (§9.3).
 * A numeric index keeps the legacy parity behavior; task ids hash so
 * reruns with --task-ids/--limit keep the same arm order per task.
 */
export function orderForTask<T>(arms: T[], key: number | string): T[] {
    const parity = typeof key === "number" ? key : stableTaskParity(key);
    if (parity % 2 === 0) return [...arms];
    return [...arms].reverse();
}

/** 0/1 parity from the sha256 of a stable task id. */
export function stableTaskParity(taskId: string): number {
    const digest = createHash("sha256").update(taskId, "utf8").digest();
    return (digest[0] ?? 0) % 2;
}

/** Model/provider/thinking identity resolved from one session event log. */
export interface TebSessionIdentity {
    provider: string | null;
    model: string | null;
    thinking: string | null;
}

/**
 * First assistant identity seen in the log. `launchPiSession` wraps
 * every stdout line as `{rt, event}`; bare session lines are accepted
 * too. Collects provider + model + thinkingLevel from message
 * envelopes and the legacy responseModel/model keys.
 */
export function extractSessionIdentity(logText: string): TebSessionIdentity {
    const identity: TebSessionIdentity = { provider: null, model: null, thinking: null };
    for (const line of logText.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: unknown;
        try {
            const record = JSON.parse(trimmed) as { event?: unknown };
            event = record !== null && typeof record === "object" && "event" in record ? record.event : record;
        } catch {
            continue;
        }
        if (event === null || typeof event !== "object") continue;
        const envelope = event as Record<string, unknown>;
        const message = envelope["message"];
        const messageRecord = message !== null && typeof message === "object" ? (message as Record<string, unknown>) : null;
        if (identity.provider === null) {
            const provider = messageRecord?.["provider"] ?? envelope["provider"];
            if (typeof provider === "string" && provider.length > 0) identity.provider = provider;
        }
        if (identity.model === null) {
            const model =
                messageRecord?.["model"] ??
                envelope["responseModel"] ??
                envelope["model"] ??
                envelope["resolvedModel"];
            if (typeof model === "string" && model.length > 0) identity.model = model;
        }
        if (identity.thinking === null) {
            const thinking = messageRecord?.["thinkingLevel"] ?? envelope["thinkingLevel"] ?? envelope["providerThinkingLevel"];
            if (typeof thinking === "string" && thinking.length > 0) identity.thinking = thinking;
        }
        if (identity.provider !== null && identity.model !== null && identity.thinking !== null) break;
    }
    return identity;
}

export interface TebIdentityCheck {
    ok: boolean;
    reason: string | null;
}

/**
 * Identity check (§9.2, E13.6): the resolved provider, model and
 * thinking level must match the request. A bare resolved id
 * (`deepseek-v4-flash`) matches a qualified request
 * (`opencode-go/deepseek-v4-flash`); anything else fails the pair.
 * A missing provider or thinking level also counts as a mismatch
 * (E13.6): the session is recorded with `identityOk: false` plus a
 * reason, and scoring excludes it from the paired analysis.
 */
export function checkSessionIdentity(
    identity: TebSessionIdentity,
    requested: { model: string; thinking: string },
): TebIdentityCheck {
    if (identity.model === null) return { ok: false, reason: "no resolved model in the event log" };
    const slash = requested.model.indexOf("/");
    const wantProvider = slash >= 0 ? requested.model.slice(0, slash) : null;
    const wantModel = slash >= 0 ? requested.model.slice(slash + 1) : requested.model;
    const resolvedSlash = identity.model.indexOf("/");
    const gotBare = resolvedSlash >= 0 ? identity.model.slice(resolvedSlash + 1) : identity.model;
    if (gotBare !== wantModel) {
        return { ok: false, reason: `model mismatch: requested ${requested.model}, resolved ${identity.model}` };
    }
    const gotProvider = resolvedSlash >= 0 ? identity.model.slice(0, resolvedSlash) : identity.provider;
    if (wantProvider !== null && gotProvider === null) {
        return { ok: false, reason: `provider mismatch: requested ${wantProvider}, resolved none (no provider in the event log)` };
    }
    if (wantProvider !== null && gotProvider !== null && gotProvider !== wantProvider) {
        return { ok: false, reason: `provider mismatch: requested ${wantProvider}, resolved ${gotProvider}` };
    }
    if (identity.thinking === null) {
        return { ok: false, reason: `thinking mismatch: requested ${requested.thinking}, resolved none (no thinking level in the event log)` };
    }
    if (identity.thinking !== requested.thinking) {
        return { ok: false, reason: `thinking mismatch: requested ${requested.thinking}, resolved ${identity.thinking}` };
    }
    return { ok: true, reason: null };
}

/** Predeclared infrastructure-failure kind (§9.3, E13.6). */
export type TebInfraKind = "provider-auth" | "extension-load" | "spawn" | "runner";

/** Classified infrastructure failure: predeclared exclusion cause + detail for the report. */
export interface TebInfraFailure {
    kind: TebInfraKind;
    detail: string;
}

const TEB_AUTH_PATTERN = /(401|403|unauthorized|unauthorised|auth[^a-z]*fail|invalid[^a-z]*api[^a-z]*key|api key|provider[^a-z]*error|rate[- ]?limit|429|ECONNREFUSED|ENOTFOUND|fetch failed)/i;
const TEB_EXT_PATTERN = /(failed to load extension|extension[^\n]{0,80}fail|error[ \w-]*registering tools|could not load extension|ERR.*extension)/i;

/** True when a parsed session event is an assistant message (identity-bearing). */
function isAssistantMessageEvent(event: unknown): boolean {
    if (event === null || typeof event !== "object") return false;
    const envelope = event as Record<string, unknown>;
    const message = envelope["message"];
    if (message !== null && typeof message === "object") {
        if ((message as Record<string, unknown>)["role"] === "assistant") return true;
    }
    if (envelope["role"] === "assistant") return true;
    const type = envelope["type"];
    if ((type === "message_end" || type === "message_start") && envelope["role"] === "assistant") return true;
    return false;
}

/**
 * True when a parsed session event carries an error signal (an
 * `error`-typed event or an explicit error flag). Transcript prose —
 * including the pi system prompt, which itself names API keys — is
 * never an error signal on its own.
 */
function isErrorEvent(event: unknown): boolean {
    if (event === null || typeof event !== "object") return false;
    const envelope = event as Record<string, unknown>;
    if (envelope["type"] === "error" || envelope["isError"] === true) return true;
    const message = envelope["message"];
    if (message !== null && typeof message === "object") {
        const record = message as Record<string, unknown>;
        if (record["type"] === "error" || record["isError"] === true) return true;
    }
    return false;
}

/** Raw text of one log line's event for signal matching (never used for identity). */
function eventTextForSignal(event: unknown): string {
    try {
        return JSON.stringify(event);
    } catch {
        return "";
    }
}

/**
 * Classify a session into one of the three predeclared infrastructure
 * exclusions (§9.3): provider/auth failure before the first assistant
 * message, extension load failure, or spawn/runner crash. Returns null
 * when the session ran normally (timeouts, turn-limit kills, tool
 * errors and malformed answers are graded, never excluded).
 *
 * Signal scope matters: stderr is runner/provider output and is
 * matched in full, but stdout transcript prose is only matched inside
 * error-typed events. The pi system prompt itself contains "API keys"
 * guidance text, so matching bare prose misclassifies every healthy
 * session whose prompt precedes its first assistant message.
 */
export function classifyInfraFailure(input: {
    logText: string;
    stderrText: string;
    spawnError: string | null;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    /** True when our turn-limit kill fired: the signal/exit it caused is expected, never a crash. */
    turnLimitHit?: boolean;
}): TebInfraFailure | null {
    if (input.spawnError !== null) {
        return { kind: "spawn", detail: `spawn failure: ${input.spawnError}` };
    }
    // Our own kills (wall-clock timeout, turn-limit kill) explain any
    // signal/nonzero exit: the session counts as a failure downstream,
    // never as an infrastructure exclusion.
    if (input.timedOut || input.turnLimitHit === true) return null;
    const authInStderr = input.stderrText.match(TEB_AUTH_PATTERN);
    if (authInStderr !== null) {
        return { kind: "provider-auth", detail: `provider/auth failure before the first assistant message: ${authInStderr[0]}` };
    }
    const extInStderr = input.stderrText.match(TEB_EXT_PATTERN);
    if (extInStderr !== null) {
        return { kind: "extension-load", detail: `extension load failure: ${extInStderr[0].slice(0, 160)}` };
    }
    // Error-typed stdout events before the first assistant message.
    let sawAssistant = false;
    for (const line of input.logText.split("\n")) {
        if (line.trim().length === 0) continue;
        let event: unknown;
        try {
            const record = JSON.parse(line) as { event?: unknown };
            event = record !== null && typeof record === "object" && "event" in record ? record.event : record;
        } catch {
            continue;
        }
        if (!sawAssistant && isAssistantMessageEvent(event)) {
            sawAssistant = true;
            continue;
        }
        if (!sawAssistant && isErrorEvent(event)) {
            const text = eventTextForSignal(event);
            const authHit = text.match(TEB_AUTH_PATTERN);
            if (authHit !== null) {
                return { kind: "provider-auth", detail: `provider/auth failure before the first assistant message: ${authHit[0]}` };
            }
            const extHit = text.match(TEB_EXT_PATTERN);
            if (extHit !== null) {
                return { kind: "extension-load", detail: `extension load failure: ${extHit[0].slice(0, 160)}` };
            }
        }
    }
    if (input.signal !== null || (input.exitCode !== null && input.exitCode !== 0)) {
        const cause = input.signal !== null ? `signal ${input.signal}` : `exit code ${input.exitCode}`;
        return { kind: "runner", detail: `runner crash: ${cause} before grading` };
    }
    return null;
}

/** HEAD sha of the pinned checkout (P1-3: must equal task.commit). */
export function readCheckoutHead(repoDir: string): string {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
}

export interface TebCheckoutCleanliness {
    clean: boolean;
    /** Offending entries from `git status --porcelain --ignored` (repo-relative paths). */
    paths: string[];
    /** Set when the git command itself failed: never treated as clean (fail closed). */
    error: string | null;
}

/**
 * Root-cleanliness preflight (fail closed): before a pinned checkout
 * is copied into a session scratch dir, `git -C <checkout> status
 * --porcelain --ignored` must be EMPTY. Modified-tracked, untracked,
 * and ignored entries all refuse the task with the offending paths
 * listed; the checkout itself is never modified or auto-deleted.
 */
export function checkCheckoutCleanliness(repoDir: string): TebCheckoutCleanliness {
    let output: string;
    try {
        output = execFileSync("git", ["-C", repoDir, "status", "--porcelain", "--ignored"], {
            encoding: "utf8",
        });
    } catch (error) {
        return {
            clean: false,
            paths: [],
            error: `cannot run git status --porcelain --ignored in ${repoDir}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const paths = output
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0)
        .map((line) => (line.length > 3 ? line.slice(3) : line));
    return { clean: paths.length === 0, paths, error: null };
}

/**
 * `.pi-smartread*` entries (files or dirs, any depth) under `rootDir`,
 * sorted — used to verify a session scratch copy carries no SmartRead
 * state before a session runs in it. Symlinked directories are not
 * traversed (the name check still applies to the link itself), which
 * also makes the walk cycle-safe.
 */
export function findStateEntries(rootDir: string): string[] {
    const hits: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.name.startsWith(".pi-smartread")) {
                hits.push(full);
            } else if (entry.isDirectory()) {
                walk(full);
            }
        }
    };
    walk(rootDir);
    return hits.sort();
}

/** Bench cache root holding gold task files and the shared repos dir. */
export function benchCacheDir(homeDir: string = process.env["HOME"] ?? tmpdir()): string {
    return join(homeDir, ".cache", "pi-smartread-bench");
}

/**
 * Distinctive bench marker matched regardless of spelling: any tool
 * argument or bash command naming the bench cache is contamination,
 * however the path is written.
 */
export const TEB_CONTAMINATION_BENCH_MARKER = "pi-smartread-bench";

/**
 * Expand home-relative and environment-expanded shell spellings to the
 * absolute home form: `~`, `$HOME`, `${HOME}` (quoted and escaped
 * variants included). Backslash escapes and single/double quotes are
 * stripped first so quoted/escaped spellings match too.
 */
export function expandHomeSpelling(text: string, homeDir: string): string {
    const home = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
    // On Windows a backslash is a path separator, so only unescape escaped
    // backslashes and quotes; elsewhere keep full shell-escape unescaping.
    const unescaped = (process.platform === "win32"
        ? text.replace(/\\([\\'"])/g, "$1")
        : text.replace(/\\(.)/g, "$1")).replace(/['"]/g, "");
    return unescaped
        .replace(/\$\{HOME\}/g, home)
        .replace(/\$HOME(?![A-Za-z0-9_])/g, home)
        .replace(/(^|[\s=:])~(\/)?/g, `$1${home}$2`);
}

/** One model-typed tool call: name plus the argument object the model supplied. */
export interface TebToolCallArgs {
    name: string;
    args: unknown;
}

/**
 * Extract model-typed tool-call arguments from a session event:
 * `tool_execution_start` (toolName + args) and assistant-message
 * `toolCall` content entries (name + arguments). Result payloads
 * are never returned — only what the model typed is scanned.
 */
export function toolCallArgsIn(event: unknown): TebToolCallArgs[] {
    if (event === null || typeof event !== "object") return [];
    const envelope = event as Record<string, unknown>;
    if (envelope["type"] === "tool_execution_start" && typeof envelope["toolName"] === "string") {
        return [{ name: envelope["toolName"], args: envelope["args"] ?? {} }];
    }
    const message = envelope["message"];
    if (message === null || typeof message !== "object") return [];
    const content = (message as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) return [];
    const calls: TebToolCallArgs[] = [];
    for (const entry of content) {
        if (entry === null || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        if (record["type"] !== "toolCall" || typeof record["name"] !== "string") continue;
        calls.push({ name: record["name"], args: record["arguments"] ?? {} });
    }
    return calls;
}

/**
 * Extra markers derived from the absolute cache/task markers: the
 * bench-cache distinctive string plus every marker's file basename
 * (catches `../` escapes from the scratch cwd and bare `cat
 * <tasks>.jsonl` reads that omit the directory).
 */
export function extraContaminationMarkers(markers: string[]): string[] {
    const extra = new Set<string>([TEB_CONTAMINATION_BENCH_MARKER]);
    for (const marker of markers) {
        const base = marker.split(/[\\/]/).pop() ?? "";
        if (base.length > 0) extra.add(base);
    }
    return [...extra];
}

/**
 * Contamination scan (E11a): flag sessions whose tool-call arguments
 * reference the bench cache dir or the task file path. Tool results
 * and transcripts are not scanned, only `tool_execution_start` args
 * and assistant `toolCall` arguments (incl. bash commands).
 *
 * Detection is spelling-insensitive: home-relative (`~`),
 * env-expanded (`$HOME`, `${HOME}`), quoted/escaped, and `../`
 * spellings all match, because the distinctive bench marker and the
 * task-file basenames are matched against the home-expanded,
 * unquoted line text.
 *
 * NOTE (accepted residual risk): matching is still textual. A model
 * that exfiltrates gold through a renamed copy stays undetected;
 * restrict filesystem access for a stronger control.
 */
export function scanLogForContamination(logText: string, markers: string[]): { contaminated: boolean; hit: string | null } {
    const homeDir = process.env["HOME"] ?? "/root";
    const active = [...markers, ...extraContaminationMarkers(markers)]
        .filter((marker) => marker.length > 0)
        .map((marker) => expandHomeSpelling(marker, homeDir));
    if (active.length === 0) return { contaminated: false, hit: null };
    for (const rawLine of logText.split("\n")) {
        let event: unknown = null;
        try {
            const record = JSON.parse(rawLine) as { event?: unknown };
            event = record !== null && typeof record === "object" && "event" in record ? record.event : record;
        } catch {
            continue;
        }
        // Only tool-call ARGUMENTS count (name + args JSON, incl.
        // bash commands the model typed). Tool RESULT text is excluded:
        // SmartRead's own enrichment echoes the checkout's absolute
        // cache path, which the model never typed.
        const calls = toolCallArgsIn(event);
        if (calls.length === 0) continue;
        for (const call of calls) {
            const haystack = expandHomeSpelling(`${call.name} ${JSON.stringify(call.args)}`, homeDir);
            // Windows paths are case-insensitive and JSON.stringify escapes each
            // backslash, so collapse backslash runs before comparing.
            const normalizeForMatch = (value: string): string =>
                process.platform === "win32" ? value.replace(/\\+/g, "/").toLowerCase() : value;
            const normalizedHaystack = normalizeForMatch(haystack);
            const hit = active.find((marker) => normalizedHaystack.includes(normalizeForMatch(marker)));
            if (hit !== undefined) return { contaminated: true, hit };
        }
    }
    return { contaminated: false, hit: null };
}

/**
 * Default `pi` binary: the global `pi` on PATH, never a repo-local
 * `node_modules/.bin` shim (E11b). Falls back to bare `"pi"`.
 */
export function defaultPiBin(pathEnv: string = process.env["PATH"] ?? ""): string {
    const suffixes = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
    for (const dir of pathEnv.split(delimiter)) {
        if (dir.length === 0 || dir.includes("node_modules")) continue;
        for (const base of suffixes) {
            const candidate = join(dir, base);
            try {
                accessSync(candidate, fsConstants.X_OK);
                return candidate;
            } catch {
                // Not executable here; keep looking.
            }
        }
    }
    return "pi";
}

/** `pi --version` for the run manifest; `"unknown"` when it cannot run. */
export function getPiVersion(piBin: string): string {
    try {
        const version = execFileSync(piBin, ["--version"], { encoding: "utf8" }).trim();
        return version.length > 0 ? version : "unknown";
    } catch {
        return "unknown";
    }
}

/** Scratch dirs of in-flight sessions, removed on SIGINT/SIGTERM (P1-4). */
const activeScratchDirs = new Set<string>();

export function trackScratchDir(dir: string): void {
    activeScratchDirs.add(dir);
}

export function untrackScratchDir(dir: string): void {
    activeScratchDirs.delete(dir);
}

export function activeScratchDirsList(): string[] {
    return [...activeScratchDirs];
}

/** Kill live pi groups and remove scratch dirs (P1-4 shutdown path). */
export function runTebShutdown(): void {
    killActivePiGroups();
    for (const dir of activeScratchDirs) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // Best effort during shutdown.
        }
    }
    activeScratchDirs.clear();
}

let tebShutdownInstalled = false;

export function isTebShutdownInstalled(): boolean {
    return tebShutdownInstalled;
}

/** Install the SIGINT/SIGTERM handler once per process (P1-4). */
export function installTebShutdownHandlers(): void {
    if (tebShutdownInstalled) return;
    tebShutdownInstalled = true;
    const onSignal = (signal: NodeJS.Signals): void => {
        runTebShutdown();
        process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
}

/**
 * One row of the run manifest (E13.3/E13.6).
 *
 * Stable run-record contract for the scoring worker (`score.ts`):
 * `identityOk`/`identityReason` (missing provider or thinking level is a
 * mismatch, `identityOk: false` + reason; scoring excludes the session
 * from the paired analysis), `infraFailure` (typed
 * `{kind, detail} | null` with
 * `kind: "provider-auth" | "extension-load" | "spawn" | "runner"`;
 * scoring excludes predeclared infra failures), `contaminated` /
 * `contaminationHit` (contaminated sessions grade as failures per
 * E10.5/E11a), `timedOut` / `turnLimitHit` (both count as failures in
 * the primary denominator like ordinary timeouts), `turns` (observed
 * `turn_start` count), `commitVerified`, `checkoutSha`, `error`,
 * `spawnError`, `exitCode`, `signal`, `elapsedMs`. Field names are
 * stable; `infraFailure` changed from `boolean` to
 * `{kind, detail} | null` in E13.6 (a `true` under the old schema means
 * non-null here; the kind must be re-derived via
 * `classifyInfraFailure`). New E13.6 fields: `infraFailure` (typed),
 * `turnLimitHit`, `turns`.
 */
export interface TebSessionRecord {
    runId: string;
    /** Shared across the arms of one task x replicate (protocol §9.2). */
    pairId: string;
    taskId: string;
    family: string;
    arm: string;
    replicate: number;
    order: string[];
    cwd: string;
    eventLog: string;
    stderrLog: string;
    timedOut: boolean;
    /** True when the turn limit fired (kill on exceeding --max-turns). Counts as a failure like a timeout (E13.6). */
    turnLimitHit: boolean;
    /** Observed `turn_start` event count for the session. */
    turns: number;
    exitCode: number | null;
    signal: string | null;
    elapsedMs: number;
    /** Spawn-level failure (e.g. ENOENT): predeclared infrastructure exclusion. */
    spawnError: string | null;
    /** Classified predeclared infrastructure failure (null when the session ran normally). */
    infraFailure: TebInfraFailure | null;
    provider: string | null;
    modelRequested: string;
    resolvedModel: string | null;
    thinkingRequested: string;
    thinkingResolved: string | null;
    /** False on provider/model/thinking mismatch (incl. missing provider/thinking): scoring excludes the session. */
    identityOk: boolean;
    identityReason: string | null;
    /** HEAD of the pinned checkout the session ran against. */
    checkoutSha: string | null;
    /** False when HEAD != task.commit (gold lines would be meaningless). */
    commitVerified: boolean;
    /** True when tool-call args reference the bench cache or task file (E11a). */
    contaminated: boolean;
    contaminationHit: string | null;
    /** Runner-side per-session error (missing repo, commit mismatch, ...). */
    error: string | null;
    /**
     * Attempt number for this task x arm x replicate key (E13
     * rerun workflow): 1 for first runs, 2+ for `--rerun-excluded`
     * relaunches. Scoring keeps the latest non-excluded attempt.
     */
    attempt: number;
    /** Effective selector values supplied to this arm (unset selectors are off). */
    selectors?: { general: boolean; inspect: boolean; invalid?: string[] };
    /** Canonical product identity reported by an opted-in session. */
    surfaceIdentity?: string;
}

export interface TebManifest {
    runnerVersion: number;
    runId: string;
    startedAt: string;
    worktreeGitSha: string;
    extensionPath: string;
    taskFile: string;
    taskFileSha256: string;
    split: TebSplit;
    /** Full arm registry: every arm's name, extensionPath, env, promptSuffix. */
    arms: TebArm[];
    /** Raw --arms-config content (null when no config file was given). */
    armsConfig: TebArmsConfig | null;
    modelRequested: string;
    thinkingRequested: string;
    timeoutMs: number;
    maxTurns: number;
    dryRun: boolean;
    piBin: string;
    piVersion: string;
    /** sha256 of the pi binary, or "unknown" when it cannot be hashed. */
    piBinarySha256: string;
    freeze: { champion: string; taskSha256: string; openingRecord: string; piVersion: string | null; piBinarySha256: string | null } | null;
    /** Prior run this batch reruns exclusions from (`--rerun-excluded`); null for first runs. Originals stay in the prior dir for audit. */
    rerunOf: { runDir: string; runId: string } | null;
    sessions: TebSessionRecord[];
}

export function worktreeGitSha(worktree: string): string {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
}

function defaultExtensionPath(): string {
    // scripts/eval/teb/run.ts -> <worktree>/src/index.ts
    return resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..", "src", "index.ts");
}

function reposDir(): string {
    const home = process.env["HOME"] ?? tmpdir();
    return process.env["TEB_REPOS_DIR"] ?? join(home, ".cache", "pi-smartread-bench", "teb", "repos");
}

export interface RunTebOptions {
    spawnFn?: PiSpawnFn;
    piBin?: string;
    /** Override `pi --version` (keeps unit tests hermetic). */
    piVersion?: string;
    /** Override the pi binary sha256 (keeps unit tests hermetic). */
    piBinarySha256?: string;
    extensionPath?: string;
    keepTempDirs?: boolean;
}

export async function runTebCli(args: TebRunArgs, opts: RunTebOptions = {}): Promise<{ runDir: string; manifestPath: string }> {
    const guard = checkHoldoutGuard(args);
    if (guard) throw new Error(guard);

    const taskFileText = readFileSync(args.tasks, "utf8");
    const taskFileSha = sha256Hex(taskFileText);
    const parsed = parseTebJsonl(taskFileText);
    if (parsed.errors.length > 0) {
        throw new Error(`invalid task file: ${parsed.errors.slice(0, 5).join("; ")}`);
    }
    let tasks: TebTask[] = parsed.tasks.filter((t) => t.split === args.split);
    if (args.taskIds) {
        const wanted = new Set(args.taskIds);
        tasks = tasks.filter((t) => wanted.has(t.id));
    }
    if (args.limit !== null) tasks = tasks.slice(0, args.limit);

    const extensionPath = opts.extensionPath ?? defaultExtensionPath();
    const worktree = resolve(dirname(extensionPath), "..");
    let gitSha = "unknown";
    try {
        gitSha = worktreeGitSha(worktree);
    } catch {
        gitSha = "unknown";
    }

    const runId = `teb-${Date.now()}-pid${process.pid}`;
    const runDir = join(resolve(args.out), runId);
    mkdirSync(runDir, { recursive: true });

    const armConfigs = args.armsConfig ? loadArmsConfig(args.armsConfig) : {};
    const expectedIdentityArms = args.arms.filter((name) => armConfigs[name]?.expectedIdentity !== undefined);
    if (expectedIdentityArms.length > 0 && expectedIdentityArms.length !== args.arms.length) {
        throw new Error("surface identity expectations must be configured for every arm or none");
    }
    const piBin = opts.piBin ?? args.piBin;
    // E11b: the resolved binary and its version are part of the record.
    const piVersion = opts.piVersion ?? (args.dryRun ? "unknown" : getPiVersion(piBin));
    // E13.6: the pinned binary's sha256 is part of the record; holdout
    // opening rejects a version/sha different from the freeze file.
    const piBinarySha256 = opts.piBinarySha256 ?? (args.dryRun ? "unknown" : getPiBinarySha256(piBin));

    // E13 exclusions rerun: relaunch exactly the prior sessions
    // scored as excluded (identity/infra). Originals stay in the prior
    // dir for audit; this manifest records attempt numbers so scoring
    // merges the latest non-excluded attempt per key.
    let rerunKeys: Map<string, number> | null = null;
    let rerunOf: TebManifest["rerunOf"] = null;
    if (args.rerunExcluded !== null) {
        const priorDir = resolve(args.rerunExcluded);
        const priorPath = join(priorDir, "manifest.json");
        if (!existsSync(priorPath)) throw new Error(`--rerun-excluded: no manifest.json in ${priorDir}`);
        const prior = JSON.parse(readFileSync(priorPath, "utf8")) as TebManifest;
        rerunOf = { runDir: priorDir, runId: prior.runId };
        rerunKeys = new Map();
        for (const priorSession of prior.sessions) {
            const { validity } = classifySessionValidity(priorSession);
            if (validity !== "excluded") continue;
            const key = `${priorSession.taskId} ${priorSession.arm} r${priorSession.replicate}`;
            const attempt = (typeof priorSession.attempt === "number" ? priorSession.attempt : 1) + 1;
            rerunKeys.set(key, Math.max(rerunKeys.get(key) ?? 0, attempt));
        }
        if (rerunKeys.size === 0) {
            throw new Error(`--rerun-excluded: no excluded sessions in ${priorDir} (nothing to relaunch)`);
        }
    }

    const manifest: TebManifest = {
        runnerVersion: TEB_RUNNER_VERSION,
        runId,
        startedAt: new Date().toISOString(),
        worktreeGitSha: gitSha,
        extensionPath,
        taskFile: resolve(args.tasks),
        taskFileSha256: taskFileSha,
        split: args.split,
        arms: resolveArms(args.arms, extensionPath, undefined, armConfigs),
        armsConfig: args.armsConfig ? armConfigs : null,
        modelRequested: args.model,
        thinkingRequested: args.thinking,
        timeoutMs: args.timeoutMs,
        maxTurns: args.maxTurns,
        dryRun: args.dryRun,
        piBin,
        piVersion,
        piBinarySha256,
        freeze: null,
        rerunOf,
        sessions: [],
    };

    const manifestPath = join(runDir, "manifest.json");
    const flushManifest = (): void => {
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    };
    flushManifest();

    // P1-1: claim the single sealed opening after the task sha matches
    // the predeclared freeze file. A racing second opener loses on the
    // atomic `wx` write inside claimHoldoutOpening. Dry runs send no
    // prompt to any model, so they never consume the opening.
    if (args.split === "holdout" && !args.dryRun) {
        const freezeFile = args.freezeFile ?? "";
        const freeze = parseFreezeFile(readFileSync(freezeFile, "utf8"));
        if (freeze.taskSha256 !== taskFileSha) {
            throw new Error(
                `freeze taskSha256 ${freeze.taskSha256} does not match task file sha ${taskFileSha} (${resolve(args.tasks)})`,
            );
        }
        // E13.6: only baseline + the frozen champion arm may run on the
        // sealed holdout; any other arm is rejected before the opening.
        const allowedHoldoutArms = new Set(["baseline", freeze.champion]);
        const forbidden = args.arms.filter((name) => !allowedHoldoutArms.has(name));
        if (forbidden.length > 0) {
            throw new Error(
                `holdout runs are restricted to baseline + the frozen champion "${freeze.champion}": forbidden --arms ${forbidden.join(",")}`,
            );
        }
        // E13.6: a pi version/sha different from the freeze file is
        // rejected at holdout opening. Both pins are required freeze
        // fields (parseFreezeFile throws when absent), so these always run.
        if (freeze.piVersion !== piVersion) {
            throw new Error(
                `pi version ${piVersion} does not match the frozen ${freeze.piVersion} (${piBin})`,
            );
        }
        if (freeze.piBinarySha256 !== piBinarySha256) {
            throw new Error(
                `pi binary sha256 ${piBinarySha256} does not match the frozen ${freeze.piBinarySha256} (${piBin})`,
            );
        }
        const openingRecord = claimHoldoutOpening(freezeFile, {
            champion: freeze.champion,
            taskSha256: freeze.taskSha256,
            runId,
            openedAt: new Date().toISOString(),
        });
        manifest.freeze = { ...freeze, openingRecord, piVersion: freeze.piVersion ?? null, piBinarySha256: freeze.piBinarySha256 ?? null };
        flushManifest();
    }

    // E11a: tool-call args referencing these mark the session contaminated.
    const contaminationMarkers = [benchCacheDir(), resolve(args.tasks)];

    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
        const task = tasks[taskIndex]!;
        const arms = resolveArms(args.arms, extensionPath, task.family, armConfigs);
        // P2: alternation is keyed by the stable task id, so reruns with
        // --task-ids/--limit keep the same arm order per task.
        const ordered = orderForTask(arms, task.id);
        const view = toRunnerView(task);
        for (const arm of ordered) {
            // P1-6: the instructed arm never applies to negative controls.
            if (arm.name === "instructed" && task.negativeControl) continue;
            for (let replicate = 0; replicate < args.replicates; replicate += 1) {
                // --rerun-excluded: relaunch exactly the excluded
                // triples; every other session is skipped.
                const rerunAttempt = rerunKeys?.get(`${task.id} ${arm.name} r${replicate}`);
                if (rerunKeys !== null && rerunAttempt === undefined) continue;
                const sessionDir = join(runDir, task.id, `${arm.name}-r${replicate}`);
                mkdirSync(sessionDir, { recursive: true });
                const eventLog = join(sessionDir, `${arm.name}-r${replicate}.jsonl`);
                const stderrLog = join(sessionDir, ".stderr.txt");
                const prompt = buildTaskPrompt(view, arm);

                // Gold-isolation audit: no gold path/line/value string may
                // appear in any user-role transcript message. The prompt is
                // the only user-role message the runner sends, and it is
                // built from the RunnerTaskView (prompt + answer shape).
                void FAMILY_TABLE;

                const pairId = `${runId}:${task.id}:r${replicate}`;
                const record: TebSessionRecord = {
                    runId,
                    pairId,
                    taskId: task.id,
                    family: task.family,
                    arm: arm.name,
                    replicate,
                    order: ordered.map((a) => a.name),
                    cwd: sessionDir,
                    eventLog,
                    stderrLog,
                    timedOut: false,
                    turnLimitHit: false,
                    turns: 0,
                    exitCode: null,
                    signal: null,
                    elapsedMs: 0,
                    spawnError: null,
                    infraFailure: null,
                    provider: null,
                    modelRequested: args.model,
                    resolvedModel: null,
                    thinkingRequested: args.thinking,
                    thinkingResolved: null,
                    identityOk: false,
                    identityReason: "session not run",

                    checkoutSha: null,
                    commitVerified: false,
                    contaminated: false,
                    contaminationHit: null,
                    error: null,
                    attempt: rerunAttempt ?? 1,
                    selectors: effectiveAffordanceSelectors(arm.env ?? {}),
                    ...(armConfigs[arm.name]?.expectedIdentity ? { surfaceIdentity: "missing" } : {}),
                };

                if (args.dryRun) {
                    writeFileSync(eventLog, "");
                    writeFileSync(stderrLog, "");
                    writeFileSync(join(sessionDir, "prompt.txt"), prompt);
                    manifest.sessions.push(record);
                    flushManifest();
                    continue;
                }

                // Fresh per-run copy of the pinned repo under a
                // PID-suffixed temp dir; the agent works inside it.
                const repoSrc = join(reposDir(), task.repo);
                const scratch = mkdtempSync(join(tmpdir(), `teb-${process.pid}-`));
                trackScratchDir(scratch);
                const runCwd = join(scratch, task.repo);
                try {
                    if (!existsSync(repoSrc)) {
                        throw new Error(`pinned repo checkout not found: ${repoSrc}`);
                    }
                    // P1-3: the checkout HEAD must equal the pinned commit;
                    // a wrong checkout would grade as a model failure.
                    let head: string;
                    try {
                        head = readCheckoutHead(repoSrc);
                    } catch (error) {
                        throw new Error(
                            `cannot verify pinned commit for ${task.repo}: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                    record.checkoutSha = head;
                    if (head !== task.commit) {
                        record.error = `commit mismatch: checkout HEAD ${head} != task.commit ${task.commit}`;
                        writeFileSync(join(sessionDir, "commit-mismatch.txt"), `${record.error}\n`);
                    } else {
                        // Root-cleanliness preflight (fail closed): in
                        // addition to the HEAD pin, `git status
                        // --porcelain --ignored` on the pinned checkout
                        // must be EMPTY before it is copied into the
                        // scratch dir; offenders are listed, never deleted.
                        const cleanliness = checkCheckoutCleanliness(repoSrc);
                        if (!cleanliness.clean) {
                            throw new Error(
                                `pinned checkout not clean for ${task.repo}: ${cleanliness.error ?? cleanliness.paths.join(", ")}`,
                            );
                        }
                        record.commitVerified = true;
                        cpSync(repoSrc, runCwd, { recursive: true });
                        // Post-copy verify: the scratch copy must carry no
                        // SmartRead state (a committed .pi-smartread* entry
                        // passes git status above but must not reach the
                        // session cwd).
                        const leaked = findStateEntries(runCwd);
                        if (leaked.length > 0) {
                            throw new Error(
                                `scratch copy contains .pi-smartread* state entries: ${leaked.join(", ")}`,
                            );
                        }
                        try {
                            copyFileSync(extensionPath, join(sessionDir, "extension-path.txt"));
                        } catch {
                            writeFileSync(join(sessionDir, "extension-path.txt"), extensionPath);
                        }

                        const piArgs = buildPiArgs({
                            extensionPath: arm.extensionPath ?? extensionPath,
                            model: args.model,
                            thinking: args.thinking,
                            tools: TEB_TOOL_ALLOWLIST,
                            prompt,
                        });
                        const env: Record<string, string> = {
                            ...(process.env as Record<string, string>),
                            PI_SMARTREAD_SKILL_SYNC: "0",
                            ...(arm.env ?? {}),
                            ...(armConfigs[arm.name]?.expectedIdentity ? { PI_SMARTREAD_SURFACE_IDENTITY_LOG: "1" } : {}),
                        };
                        const result = await launchPiSession({
                            piBin,
                            args: piArgs,
                            cwd: runCwd,
                            env,
                            timeoutMs: args.timeoutMs,
                            maxTurns: args.maxTurns,
                            outJsonl: eventLog,
                            outStderr: stderrLog,
                            spawnFn: opts.spawnFn,
                        });
                        record.timedOut = result.timedOut;
                        record.turnLimitHit = result.turnLimitHit;
                        record.turns = result.turns;
                        record.exitCode = result.exitCode;
                        record.signal = result.signal;
                        record.elapsedMs = result.elapsedMs;
                        record.cwd = runCwd;
                        // P2: spawn errors and signals are infrastructure
                        // failures with artifacts, never silent non-runs.
                        record.spawnError = result.spawnError;
                        // P1-2: provider/requested/resolved model + thinking.
                        let logText = "";
                        try {
                            logText = readFileSync(eventLog, "utf8");
                        } catch {
                            logText = "";
                        }
                        let stderrText = "";
                        try {
                            stderrText = readFileSync(stderrLog, "utf8");
                        } catch {
                            stderrText = "";
                        }
                        // E13.6: classify the predeclared infrastructure
                        // exclusions (provider/auth before the first
                        // assistant message, extension load failure,
                        // spawn/runner crash). Timeouts, turn-limit hits,
                        // tool errors and malformed answers are graded,
                        // never excluded.
                        record.infraFailure = classifyInfraFailure({
                            logText,
                            stderrText,
                            spawnError: result.spawnError,
                            exitCode: result.exitCode,
                            signal: result.signal,
                            timedOut: result.timedOut,
                            // Our turn-limit kill explains the SIGKILL/
                            // nonzero exit: it grades as a failure
                            // downstream, never as an exclusion.
                            turnLimitHit: result.turnLimitHit,
                        });
                        if (record.infraFailure !== null) {
                            writeFileSync(
                                join(sessionDir, "infra-exclusion.txt"),
                                `${record.infraFailure.kind}: ${record.infraFailure.detail}
`,
                            );
                        }
                        if (result.turnLimitHit) {
                            writeFileSync(
                                join(sessionDir, "turn-limit.txt"),
                                `turn limit ${args.maxTurns} exceeded (${result.turns} turn_start events)
`,
                            );
                        }
                        // P1-2: provider/requested/resolved model + thinking.
                        const identity = extractSessionIdentity(logText);
                        record.provider = identity.provider;
                        record.resolvedModel = identity.model;
                        record.thinkingResolved = identity.thinking;
                        const identityCheck = checkSessionIdentity(identity, {
                            model: args.model,
                            thinking: args.thinking,
                        });
                        record.identityOk = identityCheck.ok && record.selectors?.invalid === undefined;
                        record.identityReason = record.selectors?.invalid === undefined
                            ? identityCheck.reason
                            : `invalid affordance selector value(s): ${record.selectors.invalid.join(", ")}`;
                        const expectedIdentity = armConfigs[arm.name]?.expectedIdentity;
                        if (expectedIdentity) {
                            try {
                                const surface = parseSurfaceIdentity(stderrText);
                                record.surfaceIdentity = surface.surfaceIdentity;
                                const mismatch = surface.selectors.general !== expectedIdentity.general ||
                                    surface.selectors.inspect !== expectedIdentity.inspect ||
                                    surface.selectors.invalid !== undefined;
                                if (mismatch) throw new Error("surface identity selectors do not match frozen arm expectation");
                            } catch (error) {
                                const reason = error instanceof SurfaceIdentityError ? `surface identity ${error.code}` : error instanceof Error ? error.message : String(error);
                                record.identityOk = false;
                                record.identityReason = reason;
                            }
                        }
                        // E11a: bench-cache/task-file references in tool args.
                        const contamination = scanLogForContamination(logText, contaminationMarkers);
                        record.contaminated = contamination.contaminated;
                        record.contaminationHit = contamination.hit;
                    }
                } catch (error) {
                    // P2: a failed session is recorded with artifacts and the
                    // run continues; it never aborts the whole run.
                    const message = error instanceof Error ? error.message : String(error);
                    record.error = message;
                    // A synchronous spawn throw surfaces here (launch
                    // reports async spawn errors via spawnError above).
                    record.infraFailure = /spawn/i.test(message)
                        ? { kind: "spawn", detail: `spawn failure: ${message}` }
                        : { kind: "runner", detail: `runner error: ${message}` };
                    try {
                        writeFileSync(join(sessionDir, "error.txt"), `${message}\n`);
                    } catch {
                        // Artifact write is best effort.
                    }
                } finally {
                    untrackScratchDir(scratch);
                    if (!opts.keepTempDirs) {
                        rmSync(scratch, { recursive: true, force: true });
                        record.cwd = sessionDir;
                    }
                }
                manifest.sessions.push(record);
                flushManifest();
            }
        }
    }
    flushManifest();
    return { runDir, manifestPath };
}

function main(): void {
    // P1-4: Ctrl-C kills live pi process groups and removes scratch dirs.
    installTebShutdownHandlers();
    const args = parseTebRunArgs(process.argv.slice(2));
    runTebCli(args)
        .then(({ runDir }) => {
            console.log(runDir);
        })
        .catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
            process.exit(1);
        });
}

const invokedAsCli = (() => {
    try {
        return resolve(process.argv[1] ?? "") === new URL(import.meta.url).pathname;
    } catch {
        return false;
    }
})();
if (invokedAsCli) main();
