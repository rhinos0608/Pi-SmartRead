/**
 * Campaign budget ledger and private file writes for the judge
 * model-comparison campaign.
 *
 * Two responsibilities, both fail-closed:
 *
 * 1. `writePrivateFileExclusive` — creates an artifact plus its `.sha256`
 *    sidecar with mode 0600 via exclusive create (`wx`). An existing path
 *    (including symlinks) is rejected, never overwritten; chmod failures
 *    throw and remove only files this call created. No swallowed errors.
 *
 * 2. Campaign ledger — a persistent JSON ledger under a private 0700 root
 *    recording EVERY actual HTTP attempt across invocations. Admission is
 *    atomic and happens BEFORE the fetch is sent, so failures, retries, and
 *    crashes keep their reservation.
 *
 * Spend model (exact contract):
 *
 * - `campaignUsedUsd = seed.actualCostUsd + Σ settled-known actuals
 *   + Σ UNKNOWN-settled reserves + Σ in-flight reserves`.
 * - `actualSpentUsd = seed.actualCostUsd + Σ settled-known actuals`
 *   (monotonic reported spend, tracked separately).
 * - Known settlement REFUNDS the unused reserve: the used contribution of
 *   the attempt changes from `reserve` to `actual` (delta `actual-reserve`,
 *   negative when the actual is cheaper). UNKNOWN/crashed attempts never
 *   refund: the full reserve stays on the books and `costComplete` flips
 *   to `false`.
 * - `settleCampaignAttempt` returns the persisted ledger with a
 *   `reserveBreached` marker when an actual exceeds its reserve; the
 *   caller (owned by a later stage) must halt on that marker. The charge
 *   is never buried by throwing or double-settling: unknown ids throw,
 *   and each admission settles or voids at most once.
 *
 * Request-cost reserve: `contextWindowTokens(model) x advertised
 * inputRate(model)` — the cost of filling the model's whole context
 * window. This deliberately over-bounds the chars/4 estimation heuristic
 * (which is not a token bound). Pinned from the official model pages
 * verified 2026-10-07/08 and recorded in the protocol doc; re-verify
 * against current official sources before any future paid stage. Output
 * cost is NOT modelled (advertised $0.00 on all three arms); any future
 * billed output token would surface as actual-over-reserve and halt the
 * campaign via `reserveBreached`. No cap, default, provider-pricing, or
 * advertised-rate compliance assumption is lowered here.
 *
 * Concurrency: every whole ledger transaction (seed/admit/settle/void,
 * including initialization) runs under a fail-fast exclusive cross-process
 * lock (`<root>/campaign-ledger.lock`, created with `wx`). The lock is
 * never held during network I/O: admission/settlement are local ledger
 * operations performed strictly before/after the fetch by the caller. A
 * busy, stale, or otherwise unrecognized lock BLOCKS (throws) — this
 * implementation never deletes another process's lock, never kills, and
 * never sleep-polls. Only the owner nonce releases its own lock.
 *
 * Durability: ledger writes use a unique exclusive-0600 temp file in the
 * same directory (`fsync` file, atomic `rename`, then directory `fsync`).
 * Directory open/fsync failure propagates fail-closed BEFORE any fetch is
 * sent: the already-renamed ledger file is retained conservatively (the
 * reservation stays on the books) while the admission throws, so the
 * caller never treats it as a successful admission and never reaches the
 * wire. No best-effort durability is claimed. Symlinked roots/ledger
 * files are rejected, and the nearest existing ancestor of every created
 * path must itself be a genuine directory: anything created below it
 * cannot be redirected through a link, while stable platform aliases
 * above it (macOS /var->/private/var) are not ours to judge. Only the
 * ledger root itself is permission-managed (0700) — unrelated existing
 * parents are never chmodded and no recursive deletion is performed.
 * Callers on macOS should still pass canonical (realpath) roots.
 *
 * Validation: loaded JSON is validated at the trust boundary (the ledger
 * file is operator-writable state, not a security boundary against its own
 * owner — no cryptographic protection against deliberate owner edits is
 * attempted). Malformed shapes (bad version, `capUsd` not equal to
 * `CAMPAIGN_TOTAL_CAP_USD`, non-finite or negative costs, duplicate ids,
 * inconsistent attempt/total counters) throw fail-closed before any
 * admission decision. A persisted ledger carrying any other cap (e.g. the
 * pre-amendment cap) is refused with an explicit mismatch error. An
 * explicitly authorized cap-only migration is available for a documented
 * raise, and is serialized under the same cross-process lock.
 *
 * Platform: developed and tested on POSIX (darwin/linux). Windows is NOT
 * supported: ledger transactions throw fail-closed on `win32` rather than
 * running under unverified rename/lock/mode semantics. This is an honest
 * untested-platform refusal, not a silent fallback.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, chmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Owner-approved aggregate HARD cap (USD) for probe + all full warmups,
 * retries, and failures. This is the only cap admission, settlement, and
 * ledger validation enforce.
 */
export const CAMPAIGN_TOTAL_CAP_USD = 10;

/**
 * Advisory planning target (USD) for cost estimation and documentation.
 * NEVER used for admission, settlement, or ledger validation: a persisted
 * ledger records only `CAMPAIGN_TOTAL_CAP_USD`.
 */
export const CAMPAIGN_PLANNING_TARGET_USD = 2;

export const CAMPAIGN_LEDGER_DIRNAME = "pi-smartread-judge-campaign";
export const CAMPAIGN_LEDGER_FILENAME = "campaign-ledger.json";
const CAMPAIGN_LOCK_FILENAME = "campaign-ledger.lock";

export function defaultCampaignRoot(): string {
    return join(homedir(), ".cache", CAMPAIGN_LEDGER_DIRNAME);
}

export function campaignLedgerPath(root: string = defaultCampaignRoot()): string {
    return join(root, CAMPAIGN_LEDGER_FILENAME);
}

/**
 * Pinned official model facts (OpenRouter model pages, verified
 * 2026-10-07/08; the PPLX arm re-verified 2026-10-09 under protocol
 * Amendment A2 when v1 was withdrawn). Re-verify before any paid stage.
 */
export const MODEL_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
    "~typesafe/jev-latest": 32_000,
    "perplexity/pplx-decider-v1.1-27b": 262_144,
    "openai/gpt-6-luna-decisions": 1_050_000,
};

/** Advertised input price (USD per 1M tokens). The PPLX entry is the
 * v1.1 catalog price ($0.00000002/token) re-verified 2026-10-09. */
export const MODEL_INPUT_RATE_PER_M_USD: Record<string, number> = {
    "~typesafe/jev-latest": 0.042,
    "perplexity/pplx-decider-v1.1-27b": 0.02,
    "openai/gpt-6-luna-decisions": 0.1,
};

/**
 * Conservative reserve-rate floors (USD per 1M input tokens) for
 * `requestReserveUsd`. The PPLX arm keeps the withdrawn v1 rate (0.04,
 * higher than v1.1's real 0.02) as a deliberately conservative reserve
 * bound under Amendment A2 (2026-10-09): the per-attempt reservation on
 * the campaign ledger stays `(262_144 x 0.04) / 1e6` exactly as before the
 * switch. Arms without a floor reserve at their advertised rate.
 */
const MODEL_RESERVE_RATE_FLOOR_PER_M_USD: Record<string, number> = {
    "perplexity/pplx-decider-v1.1-27b": 0.04,
};

/**
 * Worst-case reservation for one request on `model`: the cost of a full
 * context window at the reserve rate (the advertised rate, or the
 * Amendment A2 floor where one is pinned). Unknown models fail closed.
 */
export function requestReserveUsd(model: string): number {
    const window = MODEL_CONTEXT_WINDOW_TOKENS[model];
    const rate = MODEL_INPUT_RATE_PER_M_USD[model];
    if (window === undefined || rate === undefined) {
        throw new Error(`Cannot bound reserve for unknown model: ${model}`);
    }
    const reserveRate = Math.max(rate, MODEL_RESERVE_RATE_FLOOR_PER_M_USD[model] ?? 0);
    return (window * reserveRate) / 1_000_000;
}

export interface CampaignSeedProvenance {
    /** Seeded paid attempts carried over from verified prior artifacts. */
    attempts: number;
    /** Seeded actual cost (USD) summed from those artifacts. */
    actualCostUsd: number;
    /** SHA-256 over the concatenated canonical artifact bytes, for audit. */
    artifactBytesHash?: string;
    note: string;
}

/**
 * Verified seed: the two 2026-10-07 probe artifacts (3 attempts and
 * $0.000127738 each: 6 attempts, $0.000255476 total). Run 2 was a
 * redundant re-capture by the operator; the parent additionally discloses
 * a stage call-cap breach and forbids any further probes in this stage.
 */
export const VERIFIED_PRIOR_SEED: CampaignSeedProvenance = {
    attempts: 6,
    actualCostUsd: 0.000255476,
    note: "Seeded from the two verified 2026-10-07 probe artifacts (3 attempts each). " +
        "Run 2 was a redundant re-capture; stage call-cap breach disclosed by parent; no further probes authorised.",
};

export interface CampaignAttemptRecord {
    id: string;
    model: string;
    reserveUsd: number;
    /** Reported actual; `undefined` while in-flight or UNKNOWN. */
    actualCostUsd?: number;
    status: "in_flight" | "settled" | "unknown";
    admittedAt: string;
    settledAt?: string;
}

export interface CampaignLedger {
    version: 1;
    capUsd: number;
    /**
     * Planned/reserved spend: seed actuals + settled-known actuals + full
     * UNKNOWN-settled reserves + full in-flight reserves. Decreases on
     * known settlement below reserve (refund) and on void.
     */
    campaignUsedUsd: number;
    /**
     * Monotonic reported spend: seed actuals + settled-known actuals.
     * Never decreases except via void accounting correction before wire.
     */
    actualSpentUsd: number;
    /** Summed reported actuals; `false` while any attempt is UNKNOWN. */
    costComplete: boolean;
    attempts: number;
    perModelAttempts: Record<string, number>;
    seed: CampaignSeedProvenance;
    inFlight: CampaignAttemptRecord[];
    settled: CampaignAttemptRecord[];
    /** Set when an actual exceeds its reserve; further admissions fail closed. */
    reserveBreached: boolean;
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf-8").digest("hex");
}

function assertPosixLedgerPlatform(): void {
    if (process.platform === "win32") {
        throw new Error(
            "Campaign ledger unsupported on Windows: atomic rename/exclusive-lock/mode semantics are unverified there; refusing fail-closed",
        );
    }
}

function rejectSymlink(path: string, what: string): void {
    let st;
    try {
        st = lstatSync(path);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
    }
    if (st.isSymbolicLink()) {
        throw new Error(`Refusing symlinked ${what}: ${path}`);
    }
}

function rejectRedirectedBase(path: string, what: string): void {
    rejectSymlink(path, what); // Leaf itself, when it already exists.
    // EVERY existing ancestor up to the filesystem root must be a genuine
    // directory. Missing components are skipped (they cannot be links) but
    // the walk continues above them, so a higher link is never masked by a
    // nearer regular directory. Callers pass already-canonical roots so
    // stable platform aliases (macOS /var->/private/var) are resolved at
    // the caller boundary, never treated as adversary links here. Node20:
    // lstatSync / isSymbolicLink / isDirectory are long-stable fs
    // signatures. No claim against an active same-UID mover (TOCTOU).
    let cur = path;
    for (;;) {
        const parent = dirname(cur);
        if (parent === cur) return; // Filesystem root: nothing above to judge.
        cur = parent;
        let st;
        try {
            st = lstatSync(cur);
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
            throw err;
        }
        if (st.isSymbolicLink()) {
            throw new Error(`Refusing symlinked ${what} ancestor: ${cur}`);
        }
        if (!st.isDirectory()) {
            throw new Error(`Refusing non-directory ${what} ancestor: ${cur}`);
        }
    }
}

function ensurePrivateRoot(root: string): void {
    rejectRedirectedBase(root, "ledger root");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    rejectSymlink(root, "ledger root");
    // Manage only the ledger root itself; never chmod unrelated parents.
    chmodSync(root, 0o700);
}

function ledgerFile(root: string): string {
    return join(root, CAMPAIGN_LEDGER_FILENAME);
}

function lockFile(root: string): string {
    return join(root, CAMPAIGN_LOCK_FILENAME);
}

/** Acquire the cross-process ledger lock. Throws (BLOCKS) when held by anyone else. */
function acquireLedgerLock(root: string): string {
    ensurePrivateRoot(root);
    const path = lockFile(root);
    rejectSymlink(path, "ledger lock");
    const nonce = `${process.pid}:${Date.now()}:${randomBytes(16).toString("hex")}`;
    let fd: number | undefined;
    try {
        fd = openSync(path, "wx", 0o600);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(`Campaign ledger busy (lock held at ${path}); refusing to proceed concurrently`);
        }
        throw err;
    }
    try {
        writeSync(fd, nonce, null, "utf-8");
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    return nonce;
}

/** Release only a lock carrying our own nonce. Never touches another owner's lock. */
function releaseLedgerLock(root: string, nonce: string): void {
    const path = lockFile(root);
    let current: string;
    try {
        current = readFileSync(path, "utf-8");
    } catch {
        throw new Error(`Campaign ledger lock vanished while owned; refusing silent unlock (${path})`);
    }
    if (current !== nonce) {
        throw new Error(`Campaign ledger lock owned by another process; refusing to release it (${path})`);
    }
    unlinkSync(path);
}

/** Run `fn` under the exclusive cross-process lock. Never held across network I/O. */
function withLedgerLock<T>(root: string, fn: () => T): T {
    assertPosixLedgerPlatform();
    rejectRedirectedBase(root, "ledger root");
    const nonce = acquireLedgerLock(root);
    try {
        return fn();
    } finally {
        releaseLedgerLock(root, nonce);
    }
}

function isFiniteNonNegative(n: unknown): n is number {
    return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function expectedUsedUsd(seed: CampaignSeedProvenance, settled: CampaignAttemptRecord[], inFlight: CampaignAttemptRecord[]): number {
    let used = seed.actualCostUsd;
    for (const r of settled) {
        used += r.status === "settled" && r.actualCostUsd !== undefined ? r.actualCostUsd : r.reserveUsd;
    }
    for (const r of inFlight) {
        used += r.reserveUsd;
    }
    return used;
}

function expectedActualSpentUsd(seed: CampaignSeedProvenance, settled: CampaignAttemptRecord[]): number {
    let spent = seed.actualCostUsd;
    for (const r of settled) {
        if (r.status === "settled" && r.actualCostUsd !== undefined) spent += r.actualCostUsd;
    }
    return spent;
}

/**
 * Validate untrusted ledger JSON at the trust boundary. Throws fail-closed
 * on any malformed version, cap, cost, id, or totals inconsistency.
 */
function validateLedger(value: unknown, requiredCapUsd: number = CAMPAIGN_TOTAL_CAP_USD): CampaignLedger {
    const fail = (why: string): never => {
        throw new Error(`Corrupt campaign ledger: ${why}`);
    };
    if (typeof value !== "object" || value === null) fail("not an object");
    const v = value as Record<string, unknown>;
    if (v["version"] !== 1) fail("unsupported version");
    if (v["capUsd"] !== requiredCapUsd) {
        fail(`capUsd ${String(v["capUsd"])} != required ${requiredCapUsd}`);
    }
    const ledger = value as CampaignLedger;
    if (!isFiniteNonNegative(ledger.campaignUsedUsd)) fail("non-finite/negative campaignUsedUsd");
    if (!isFiniteNonNegative(ledger.actualSpentUsd)) fail("non-finite/negative actualSpentUsd");
    if (typeof ledger.costComplete !== "boolean") fail("costComplete not boolean");
    if (!Number.isInteger(ledger.attempts) || ledger.attempts < 0) fail("attempts not a non-negative integer");
    if (typeof ledger.perModelAttempts !== "object" || ledger.perModelAttempts === null) fail("perModelAttempts not an object");
    if (!Array.isArray(ledger.inFlight) || !Array.isArray(ledger.settled)) fail("inFlight/settled not arrays");
    if (typeof ledger.reserveBreached !== "boolean") fail("reserveBreached not boolean");
    const seed = ledger.seed;
    if (typeof seed !== "object" || seed === null) fail("seed not an object");
    if (!Number.isInteger(seed.attempts) || seed.attempts < 0) fail("seed.attempts invalid");
    if (!isFiniteNonNegative(seed.actualCostUsd)) fail("seed.actualCostUsd invalid");
    if (typeof seed.note !== "string") fail("seed.note invalid");
    if (seed.artifactBytesHash !== undefined && typeof seed.artifactBytesHash !== "string") fail("seed.artifactBytesHash invalid");
    const ids = new Set<string>();
    const checkRecord = (r: CampaignAttemptRecord, where: string): void => {
        if (typeof r.id !== "string" || r.id.length === 0) fail(`${where} record with bad id`);
        if (ids.has(r.id)) fail(`duplicate attempt id ${r.id}`);
        ids.add(r.id);
        if (typeof r.model !== "string" || r.model.length === 0) fail(`${where} record with bad model`);
        if (!isFiniteNonNegative(r.reserveUsd) || r.reserveUsd <= 0) fail(`${where} record with bad reserveUsd`);
        if (r.actualCostUsd !== undefined && !isFiniteNonNegative(r.actualCostUsd)) fail(`${where} record with bad actualCostUsd`);
        if (r.status !== "in_flight" && r.status !== "settled" && r.status !== "unknown") fail(`${where} record with bad status`);
        if (typeof r.admittedAt !== "string") fail(`${where} record with bad admittedAt`);
        if (r.settledAt !== undefined && typeof r.settledAt !== "string") fail(`${where} record with bad settledAt`);
        if (where === "inFlight" && r.status !== "in_flight") fail("inFlight record not in_flight");
        if (where === "settled" && r.status !== "settled" && r.status !== "unknown") fail("settled record with bad status");
        if (r.status === "settled" && r.actualCostUsd === undefined) fail("settled record missing actual");
        if (r.status === "unknown" && r.actualCostUsd !== undefined) fail("unknown record carries actual");
    };
    for (const r of ledger.inFlight) checkRecord(r, "inFlight");
    for (const r of ledger.settled) checkRecord(r, "settled");
    // Totals consistency.
    const expectedAttempts = seed.attempts + ledger.inFlight.length + ledger.settled.length;
    if (ledger.attempts !== expectedAttempts) fail(`attempts ${ledger.attempts} != seed+records ${expectedAttempts}`);
    const counts: Record<string, number> = {};
    for (const r of [...ledger.inFlight, ...ledger.settled]) {
        counts[r.model] = (counts[r.model] ?? 0) + 1;
    }
    for (const [model, n] of Object.entries(ledger.perModelAttempts)) {
        if (!Number.isInteger(n) || n < 0) fail(`perModelAttempts[${model}] invalid`);
        if ((counts[model] ?? 0) !== n) fail(`perModelAttempts[${model}] inconsistent`);
    }
    for (const model of Object.keys(counts)) {
        if (ledger.perModelAttempts[model] === undefined) fail(`perModelAttempts missing ${model}`);
    }
    const TOL = 1e-9;
    if (Math.abs(ledger.campaignUsedUsd - expectedUsedUsd(seed, ledger.settled, ledger.inFlight)) > TOL) {
        fail("campaignUsedUsd inconsistent with records");
    }
    if (Math.abs(ledger.actualSpentUsd - expectedActualSpentUsd(seed, ledger.settled)) > TOL) {
        fail("actualSpentUsd inconsistent with records");
    }
    const hasUnknown = ledger.settled.some((r) => r.status === "unknown") || ledger.inFlight.length > 0;
    if (hasUnknown && ledger.costComplete) fail("costComplete true while UNKNOWN/in-flight outstanding");
    if (!ledger.reserveBreached && ledger.settled.some((r) => r.status === "settled" && r.actualCostUsd! > r.reserveUsd)) {
        fail("over-reserve settlement without reserveBreached");
    }
    return ledger;
}

function readLedgerValidated(root: string): CampaignLedger | undefined {
    rejectSymlink(ledgerFile(root), "ledger file");
    let raw: string;
    try {
        raw = readFileSync(ledgerFile(root), "utf-8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("Corrupt campaign ledger: invalid JSON");
    }
    if (typeof parsed === "number" && Number.isNaN(parsed)) throw new Error("Corrupt campaign ledger: NaN");
    return validateLedger(parsed);
}

/** Atomic durable write: unique exclusive-0600 tmp file in the same directory + rename. */
function writeLedgerAtomic(root: string, ledger: CampaignLedger): void {
    ensurePrivateRoot(root);
    rejectSymlink(ledgerFile(root), "ledger file");
    const target = ledgerFile(root);
    const tmp = join(root, `.${CAMPAIGN_LEDGER_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    rejectSymlink(tmp, "ledger tmp");
    let fd: number | undefined;
    try {
        fd = openSync(tmp, "wx", 0o600);
        const st = fstatSync(fd);
        if (!st.isFile() || (st.mode & 0o777) !== 0o600) {
            throw new Error(`Fail-closed: cannot prove 0600 on ledger tmp ${tmp}`);
        }
        writeSync(fd, `${JSON.stringify(ledger, null, 2)}\n`, null, "utf-8");
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(tmp, target);
        // Directory entry durability is load-bearing for the pre-fetch cap:
        // propagate open/fsync failure fail-closed (already-renamed ledger
        // stays on the books conservatively; no best-effort claim is made).
        // Node20: openSync(path, flags) + fsyncSync(fd) signatures below.
        let dirFd: number | undefined;
        try {
            dirFd = openSync(root, "r");
            fsyncSync(dirFd);
        } finally {
            if (dirFd !== undefined) closeSync(dirFd);
        }
    } finally {
        if (fd !== undefined) {
            try { closeSync(fd); } catch { /* ignore close error during cleanup */ }
        }
        // Remove ONLY our own uniquely-named tmp on failure.
        try { unlinkSync(tmp); } catch { /* ours alone; ignore when renamed */ }
    }
}

export interface CampaignLedgerCapMigrationOptions {
    fromCapUsd: number;
    toCapUsd: number;
    authorization: string;
}

/** Raise a validated campaign ledger cap once, preserving all non-cap values. */
export function migrateCampaignLedgerCap(root: string, options: CampaignLedgerCapMigrationOptions): CampaignLedger {
    const { fromCapUsd, toCapUsd, authorization } = options;
    if (!(toCapUsd > fromCapUsd)) throw new Error("Cap migration must raise the cap");
    if (toCapUsd !== CAMPAIGN_TOTAL_CAP_USD) throw new Error(`Cap migration target must equal ${CAMPAIGN_TOTAL_CAP_USD}`);
    if (typeof authorization !== "string" || authorization.trim().length === 0) throw new Error("Cap migration requires authorization");
    return withLedgerLock(root, () => {
        const target = ledgerFile(root);
        rejectSymlink(target, "ledger file");
        const raw = readFileSync(target, "utf-8");
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { throw new Error("Corrupt campaign ledger: invalid JSON"); }
        const ledger = validateLedger(parsed, fromCapUsd);
        if (ledger.capUsd !== fromCapUsd) throw new Error(`Persisted cap ${ledger.capUsd} != migration source ${fromCapUsd}`);
        if (ledger.inFlight.length > 0) throw new Error("Cannot migrate campaign cap with in-flight attempts");
        if (ledger.reserveBreached) throw new Error("Cannot migrate campaign cap after reserve breach");
        const backupPath = join(root, "campaign-ledger.pre-cap-migration.json");
        const receiptPath = join(root, "campaign-ledger.cap-migration.json");
        for (const path of [backupPath, receiptPath]) {
            rejectSymlink(path, "migration artifact");
            try { lstatSync(path); throw new Error(`Refusing to overwrite migration artifact: ${path}`); }
            catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
        }
        const next = { ...(parsed as Record<string, unknown>), capUsd: toCapUsd };
        const postBytes = `${JSON.stringify(next, null, 2)}\n`;
        const receipt = {
            from: fromCapUsd,
            to: toCapUsd,
            authorization,
            timestamp: new Date().toISOString(),
            preSha256: sha256Hex(raw),
            postSha256: sha256Hex(postBytes),
            campaignUsedUsd: ledger.campaignUsedUsd,
            actualSpentUsd: ledger.actualSpentUsd,
        };
        writePrivateFileExclusive(backupPath, raw);
        writeLedgerAtomic(root, next as CampaignLedger);
        writePrivateFileExclusive(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        return validateLedger(next);
    });
}

function validateSeedArg(seed: CampaignSeedProvenance): void {
    if (typeof seed !== "object" || seed === null) throw new Error("Invalid seed: not an object");
    if (!Number.isInteger(seed.attempts) || seed.attempts < 0) throw new Error("Invalid seed: attempts");
    if (!isFiniteNonNegative(seed.actualCostUsd)) throw new Error("Invalid seed: actualCostUsd");
    if (typeof seed.note !== "string") throw new Error("Invalid seed: note");
}

export function seedCampaignLedger(root: string, seed: CampaignSeedProvenance = VERIFIED_PRIOR_SEED): CampaignLedger {
    validateSeedArg(seed);
    return withLedgerLock(root, () => {
        const existing = readLedgerValidated(root);
        // Seeded charges are never reset: an existing ledger is returned as-is.
        if (existing !== undefined) return existing;
        const ledger: CampaignLedger = {
            version: 1,
            capUsd: CAMPAIGN_TOTAL_CAP_USD,
            campaignUsedUsd: seed.attempts > 0 ? seed.actualCostUsd : 0,
            actualSpentUsd: seed.attempts > 0 ? seed.actualCostUsd : 0,
            costComplete: true,
            attempts: seed.attempts,
            perModelAttempts: {},
            seed,
            inFlight: [],
            settled: [],
            reserveBreached: false,
        };
        writeLedgerAtomic(root, ledger);
        return ledger;
    });
}

export function loadCampaignLedger(root: string): CampaignLedger {
    assertPosixLedgerPlatform();
    const existing = readLedgerValidated(root);
    if (existing === undefined) throw new Error(`Campaign ledger absent at ${ledgerFile(root)}; seed it first`);
    return existing;
}

/**
 * Admit one actual HTTP attempt BEFORE it is sent. Reserves
 * `requestReserveUsd(model)` against the $10 campaign hard cap. Throws
 * fail-closed when the cap would be exceeded, when a prior actual
 * exceeded its reserve, when the model cannot be bounded, or when the
 * ledger is busy/corrupt. The whole read-modify-write runs under the
 * exclusive cross-process lock; the lock is never held during fetch.
 */
export function admitCampaignAttempt(root: string, model: string): { ledger: CampaignLedger; attemptId: string } {
    return withLedgerLock(root, () => {
        const ledger = readLedgerValidated(root);
        if (ledger === undefined) throw new Error(`Campaign ledger absent at ${ledgerFile(root)}; seed it first`);
        if (ledger.reserveBreached) {
            throw new Error("Campaign halted: a reported actual exceeded its reserve (reserveBreached)");
        }
        const reserve = requestReserveUsd(model);
        if (!isFiniteNonNegative(reserve) || reserve <= 0) {
            throw new Error(`Cannot bound reserve for model: ${model}`);
        }
        if (ledger.campaignUsedUsd + reserve > ledger.capUsd) {
            throw new Error(
                `Campaign cap exceeded: used $${ledger.campaignUsedUsd.toFixed(6)} + reserve $${reserve.toFixed(6)} > cap $${ledger.capUsd}`,
            );
        }
        let attemptId = sha256Hex(`${Date.now()}:${process.pid}:${randomBytes(8).toString("hex")}:${ledger.attempts}:${model}`).slice(0, 16);
        while (ledger.inFlight.some((a) => a.id === attemptId) || ledger.settled.some((a) => a.id === attemptId)) {
            attemptId = sha256Hex(`${attemptId}:${randomBytes(8).toString("hex")}`).slice(0, 16);
        }
        ledger.campaignUsedUsd += reserve;
        ledger.attempts += 1;
        ledger.perModelAttempts[model] = (ledger.perModelAttempts[model] ?? 0) + 1;
        ledger.inFlight.push({ id: attemptId, model, reserveUsd: reserve, status: "in_flight", admittedAt: new Date().toISOString() });
        // An in-flight attempt has no known actual yet: totals are incomplete.
        ledger.costComplete = false;
        writeLedgerAtomic(root, ledger);
        return { ledger, attemptId };
    });
}

/**
 * Settle an admitted attempt after the fetch completes. A reported known
 * actual REFUNDS the unused reserve (used delta `actual - reserve`,
 * negative when cheaper); UNKNOWN actuals retain the full reserve and flip
 * `costComplete` to `false`. An actual above its reserve sets
 * `reserveBreached` (further admissions halt) while keeping the charge on
 * the books. Returns the persisted ledger — the caller must halt on
 * `reserveBreached`. Unknown ids throw; each admission settles at most
 * once (no double settlement).
 */
export function settleCampaignAttempt(
    root: string,
    attemptId: string,
    actualCostUsd: number | undefined,
): CampaignLedger {
    if (actualCostUsd !== undefined && !isFiniteNonNegative(actualCostUsd)) {
        throw new Error(`Invalid actual cost: ${String(actualCostUsd)}`);
    }
    return withLedgerLock(root, () => {
        const ledger = readLedgerValidated(root);
        if (ledger === undefined) throw new Error(`Campaign ledger absent at ${ledgerFile(root)}; seed it first`);
        const index = ledger.inFlight.findIndex((a) => a.id === attemptId);
        if (index === -1) throw new Error(`Unknown campaign attempt: ${attemptId}`);
        const record = ledger.inFlight[index]!;
        ledger.inFlight.splice(index, 1);
        if (actualCostUsd === undefined) {
            ledger.costComplete = false;
            ledger.settled.push({ ...record, status: "unknown", settledAt: new Date().toISOString() });
        } else {
            if (actualCostUsd > record.reserveUsd) {
                ledger.reserveBreached = true;
            }
            // True-up: refund unused reserve when cheaper, charge excess when over.
            ledger.campaignUsedUsd += actualCostUsd - record.reserveUsd;
            ledger.actualSpentUsd += actualCostUsd;
            ledger.settled.push({ ...record, actualCostUsd, status: "settled", settledAt: new Date().toISOString() });
            ledger.costComplete = ledger.inFlight.length === 0 && ledger.settled.every((r) => r.status === "settled");
        }
        writeLedgerAtomic(root, ledger);
        return ledger;
    });
}

/**
 * Void an admitted attempt that never reached the wire (e.g. a local
 * fail-closed refusal after admission). Removes the in-flight record and
 * refunds its reserve. Never call after a fetch was sent — settle instead.
 */
export function voidCampaignAttempt(root: string, attemptId: string): CampaignLedger {
    return withLedgerLock(root, () => {
        const ledger = readLedgerValidated(root);
        if (ledger === undefined) throw new Error(`Campaign ledger absent at ${ledgerFile(root)}; seed it first`);
        const index = ledger.inFlight.findIndex((a) => a.id === attemptId);
        if (index === -1) throw new Error(`Unknown campaign attempt: ${attemptId}`);
        const record = ledger.inFlight[index]!;
        ledger.inFlight.splice(index, 1);
        ledger.campaignUsedUsd -= record.reserveUsd;
        ledger.attempts -= 1;
        ledger.perModelAttempts[record.model] = Math.max(0, (ledger.perModelAttempts[record.model] ?? 1) - 1);
        ledger.costComplete = ledger.inFlight.length === 0 && ledger.settled.every((r) => r.status === "settled");
        writeLedgerAtomic(root, ledger);
        return ledger;
    });
}

/** Remaining budget under the campaign cap (USD). */
export function campaignRemainingUsd(ledger: CampaignLedger): number {
    return ledger.capUsd - ledger.campaignUsedUsd;
}

/**
 * Create a file with mode 0600 via exclusive create. Rejects existing
 * paths (including symlinks) instead of overwriting; verifies the created
 * file's mode with fstat before writing; chmod failures throw and remove
 * only files this call created. Never touches files it did not create.
 */
export function writePrivateFileExclusive(path: string, body: string): void {
    rejectRedirectedBase(path, "output");
    let fd: number | undefined;
    try {
        fd = openSync(path, "wx", 0o600);
    } catch (err) {
        throw new Error(`Refusing to overwrite existing path: ${path} (${(err as NodeJS.ErrnoException).code ?? err})`);
    }
    let created = true;
    try {
        const st = fstatSync(fd);
        if (!st.isFile()) {
            throw new Error(`Refusing non-regular file: ${path}`);
        }
        // Prove restrictive permissions on the created file (mask to 0777).
        if ((st.mode & 0o777) !== 0o600) {
            try {
                chmodSync(path, 0o600);
            } catch (err) {
                throw new Error(`Fail-closed chmod on ${path}: ${(err as Error).message}`);
            }
            const rest = fstatSync(fd);
            if ((rest.mode & 0o777) !== 0o600) {
                throw new Error(`Fail-closed: cannot prove 0600 on ${path}`);
            }
        }
        writeSync(fd, body, null, "utf-8");
        try {
            chmodSync(path, 0o600);
        } catch (err) {
            throw new Error(`Fail-closed chmod on ${path}: ${(err as Error).message}`);
        }
        closeSync(fd);
        fd = undefined;
        created = false;
    } finally {
        if (fd !== undefined) {
            try { closeSync(fd); } catch { /* ignore close error during cleanup */ }
        }
        if (created) {
            try { unlinkSync(path); } catch { /* cleanup best effort on our own file */ }
        }
    }
}

export function ephemeralCampaignRoot(): string {
    // Canonical caller-boundary tmp base: resolves stable platform aliases
    // (macOS /var->/private/var) so the all-ancestor rejection judges only
    // real adversary links. Node20: realpathSync(tmpdir()) is stable.
    return join(realpathSync(tmpdir()), `judge-campaign-ephemeral-p${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`);
}

/**
 * Write a report artifact plus its `.sha256` sidecar (sha256 of the exact
 * bytes written) using exclusive private creates. Returns the artifact
 * path, sidecar path, and byte hash.
 */
export function writePrivateArtifact(outPath: string, body: string): { outPath: string; sidecarPath: string; byteHash: string } {
    rejectRedirectedBase(outPath, "artifact");
    mkdirSync(dirname(outPath), { recursive: true });
    writePrivateFileExclusive(outPath, body);
    const byteHash = sha256Hex(body);
    const sidecarPath = `${outPath}.sha256`;
    writePrivateFileExclusive(sidecarPath, `${byteHash}  ${outPath}\n`);
    return { outPath, sidecarPath, byteHash };
}

/**
 * Verify a historical sidecar written by the pre-fix algorithm, which
 * hashed the compact canonical JSON (`SHA256(JSON.stringify(parsed))`)
 * instead of the pretty-printed file bytes. Returns the canonical digest
 * when it matches the sidecar WITHOUT claiming the file bytes are
 * verified, plus the independent byte hash for provenance. Old sidecars
 * are never modified here.
 */
export function verifyLegacyCanonicalSidecar(artifactPath: string, sidecarPath: string): {
    sidecarMatchesCanonical: boolean;
    canonicalDigest: string;
    byteDigest: string;
} {
    const bytes = readFileSync(artifactPath, "utf-8");
    const sidecar = readFileSync(sidecarPath, "utf-8").trim().split(/\s+/)[0] ?? "";
    const canonicalDigest = sha256Hex(JSON.stringify(JSON.parse(bytes)));
    const byteDigest = sha256Hex(bytes);
    return { sidecarMatchesCanonical: sidecar === canonicalDigest, canonicalDigest, byteDigest };
}
