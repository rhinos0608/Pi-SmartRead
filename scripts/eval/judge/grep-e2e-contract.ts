/**
 * R1 review-remediation contract helpers for scripts/eval/judge/grep-e2e.ts.
 *
 * Pure and import-safe: stdlib only (node:crypto, node:fs), no grep/judge
 * tool imports, so unit tests can import this without engine side effects.
 * This module owns canonical identity, checkpoint validation, sanitized
 * error codes, private-file checks, and the symlink-safe checkpoint
 * append (appendCheckpointLine); the harness owns all other IO.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    constants,
    lstatSync,
    openSync,
    readFileSync,
    realpathSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { join } from "node:path";

/** Versioned checkpoint/identity schema. Old or qid-only rows fail closed. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

/** Labels accepted by the fixture contract. Unknown labels fail closed. */
export const ALLOWED_LABELS = ["gold", "hard_negative", "easy_negative"] as const;

export interface RunIdentityInput {
    /** Ordered query ids actually selected for this run. */
    orderedQids: string[];
    /** SHA-256 over raw fixture bytes (both sets, in order). */
    fixtureSha: string;
    /** Corpus content inventory hash (path:sha lines), never the temp path. */
    corpusInventoryHash: string;
    corpusInventoryFiles: number;
    corpusKind: string;
    /** Pinned source ref, or null for explicit mutable roots. */
    sourceRef: string | null;
    /** Content hash over actual engine source bytes under the git root. */
    engineSourceHash: string;
    nodeVersion: string;
    /** Configured judge model alias (never a key); "off" for no-judge runs. */
    modelAlias: string;
    /** Judge origin alias: "off" | "cloud-openrouter". */
    judgeOrigin: string;
    gateConstants: Record<string, number>;
    /** Applied keep-threshold override for this config, or null when off. */
    appliedKeepOverride: string | null;
    params: Record<string, unknown>;
    timeoutMs: number;
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
}

/** Full SHA-256 run identity. Temp absolute corpus paths must not feed this. */
export function computeRunFingerprint(input: RunIdentityInput): string {
    return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/**
 * Runtime source selection: tracked AND untracked-but-not-ignored
 * TypeScript under src/, eval scripts, and manifests/config. Everything
 * else (caches, generated reports, secrets, temp dirs) is excluded by
 * construction — never allowlisted.
 */
export function isWantedSourceFile(rel: string): boolean {
    if (rel === "package.json" || rel === "package-lock.json"
        || rel === "tsconfig.json" || rel === "pi-smartread.config.json") return true;
    if (!rel.endsWith(".ts")) return false;
    return rel.startsWith("src/") || rel.startsWith("scripts/eval/");
}

/**
 * Content hash over actual engine source bytes: tracked plus untracked
 * non-ignored files (a tracked-only listing misses untracked runtime
 * sources such as src/judge/*, leaving the resume key unchanged when they
 * change). Falls back to "unknown:<reason>" — never a fake hash — and
 * unknown identities must refuse compatible resume (see isKnownSourceHash).
 */
export function hashEngineSources(gitRoot: string): string {
    try {
        const raw: Buffer = execFileSync(
            "git",
            ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            { cwd: gitRoot, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
        );
        const wanted = raw.toString("utf8").split("\0")
            .filter((f) => f.length > 0)
            .filter(isWantedSourceFile)
            .sort();
        if (wanted.length === 0) return "unknown:no-sources";
        const hash = createHash("sha256");
        for (const rel of wanted) {
            hash.update(rel, "utf8");
            hash.update("\0");
            hash.update(readFileSync(join(gitRoot, rel)));
            hash.update("\0");
        }
        return `sha256:${hash.digest("hex")}:${wanted.length}-files`;
    } catch {
        return "unknown:hash-failed";
    }
}

/** Unknown code identity accepts no compatible resume: fail closed. */
export function isKnownSourceHash(hash: string): boolean {
    return !hash.startsWith("unknown:");
}

export interface CheckpointRow {
    v: number;
    fingerprint: string;
    trace: { qid: string };
    outcome: { status: string };
    [key: string]: unknown;
}

export type CheckpointRowVerdict =
    | { ok: true; row: CheckpointRow }
    | { ok: false; reason: string };

/**
 * Fail-closed row validation: versioned schema, fingerprint binding,
 * known qids only. Malformed rows, old/qid-only rows, unknown qids,
 * duplicate inconsistent entries, and fingerprint mismatches never reuse.
 */
export function validateCheckpointRow(
    line: string,
    expectedFingerprint: string,
    knownQids: Set<string>,
): CheckpointRowVerdict {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return { ok: false, reason: "malformed-json" };
    }
    if (!value || typeof value !== "object") return { ok: false, reason: "malformed-row" };
    const row = value as Record<string, unknown>;
    if (row.v !== CHECKPOINT_SCHEMA_VERSION) return { ok: false, reason: "incompatible-schema" };
    if (row.fingerprint !== expectedFingerprint) return { ok: false, reason: "stale-fingerprint" };
    const trace = row.trace as { qid?: unknown } | undefined;
    const outcome = row.outcome as { status?: unknown } | undefined;
    if (typeof trace?.qid !== "string" || !outcome || typeof outcome.status !== "string") {
        return { ok: false, reason: "malformed-row" };
    }
    if (!knownQids.has(trace.qid)) return { ok: false, reason: "unknown-qid" };
    return { ok: true, row: row as CheckpointRow };
}

/**
 * Duplicate policy: identical status+outcome rows dedupe; inconsistent
 * duplicates must rerun (never silently reuse either copy).
 */
export function isConsistentDuplicate(a: CheckpointRow, b: CheckpointRow): boolean {
    return stableStringify(a.outcome) === stableStringify(b.outcome);
}

const TRANSIENT_PATTERNS: Array<{ code: string; test: RegExp }> = [
    { code: "timeout", test: /timeout|timed out|abort/i },
    { code: "network", test: /econn|enotfound|eai_again|socket|network|fetch failed/i },
    { code: "auth", test: /401|403|unauthorized|forbidden|api key|apikey/i },
    { code: "rate_limited", test: /429|rate limit|too many requests/i },
];

/**
 * Stable sanitized error codes. Raw external messages (which may carry
 * prompts, paths, or credentials) never enter logs or private traces;
 * callers keep the raw text out of artifacts entirely.
 */
export function stableErrorCode(error: unknown): string {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    for (const { code, test } of TRANSIENT_PATTERNS) {
        if (test.test(message)) return code;
    }
    return "execution";
}

export function errorStatus(error: unknown): string {
    return `error:${stableErrorCode(error)}`;
}

export type PrivateFileVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Reader-side guard for existing checkpoints: reject symlinks and
 * non-private files rather than mutating arbitrary user files.
 * New files must use exclusive-create 0600; appends reuse an owned handle.
 */
export function checkPrivateExisting(stat: {
    isSymbolicLink(): boolean;
    mode: number;
    uid: number;
    nlink?: number;
}, ownerUid: number): PrivateFileVerdict {
    if (stat.isSymbolicLink()) return { ok: false, reason: "refuses-symlink" };
    if ((stat.mode & 0o777) !== 0o600) return { ok: false, reason: "refuses-non-private-mode" };
    if (stat.uid !== ownerUid) return { ok: false, reason: "refuses-unowned-file" };
    return { ok: true };
}

/**
 * Append one JSONL checkpoint line: exclusive-create 0600 for new files;
 * the append path refuses symlinks (lstat rejection, plus O_NOFOLLOW
 * where the platform supports it) so a pre-planted symlink at the
 * predictable checkpoint path can never redirect the write. New files keep
 * the documented 0600 mode; appends reuse the existing owned handle.
 */
export function appendCheckpointLine(path: string, line: string): void {
    try {
        writeFileSync(path, line, { flag: "wx", mode: 0o600 });
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    let stat;
    try {
        stat = lstatSync(path);
    } catch {
        throw new Error("refusing checkpoint append: checkpoint path is unstatable");
    }
    if (stat.isSymbolicLink()) throw new Error("refusing checkpoint append: checkpoint path is a symlink");
    const nofollow = (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW;
    if (typeof nofollow === "number") {
        let fd: number;
        try {
            fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | nofollow);
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ELOOP") {
                throw new Error("refusing checkpoint append: checkpoint path is a symlink");
            }
            throw error;
        }
        try {
            writeSync(fd, line);
        } finally {
            closeSync(fd);
        }
        return;
    }
    // Platforms without O_NOFOLLOW: best effort after the lstat rejection above.
    appendFileSync(path, line);
}

/** Completed judge_degraded runs keep measured coverage; only hard errors lose it. */
export function isHardError(status: string): boolean {
    return status.startsWith("error:");
}

/**
 * Canonical benchmark corpus root: mkdtemp roots (macOS /var ->
 * /private/var) and explicit --root values may contain symlinks. Hit
 * files are canonicalized via realpath, so the root they are made
 * relative to must be canonical too, or gold matching compares
 * '../../..' escapes against 'src/...' labels. Missing paths fall
 * through unchanged (the harness walk fails on those, not here).
 */
export function canonicalizeCorpusRoot(root: string): string {
    try {
        return realpathSync(root);
    } catch {
        return root;
    }
}
