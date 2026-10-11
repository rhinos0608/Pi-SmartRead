#!/usr/bin/env node
/**
 * Tiny 3-model judge metering probe (owner-authorised, capped).
 *
 * Compares `~typesafe/jev-latest`, `perplexity/pplx-decider-v1.1-27b`, and
 * `openai/gpt-6-luna-decisions` on ONE fixed input built with the normal
 * state/question builders (1 unit + 1 unit, no fixture scores consulted).
 * Hard stops: at most 1 actual HTTP attempt per model (3 total — the
 * cloud client's retry ceiling is disabled in-probe so retries cannot
 * silently exceed the budget), at most 3000 estimated input tokens per
 * request, total spend <= $0.01 within the owner's $10 aggregate hard cap
 * ($2 advisory planning target; Amendment A1).
 *
 * Full scored comparison is NOT authorised in this stage: `--mode full`
 * exits non-zero before any request. Cache is disabled, models are probed
 * strictly sequentially, and no application concurrency is changed.
 *
 * Auth: `PI_SMARTREAD_JUDGE_API_KEY` first, else the normal Pi SDK
 * `AuthStorage` OpenRouter credential (API-key only; OAuth-only stops with
 * `oauth_only`), else `OPENROUTER_API_KEY`. Keys stay in memory, are sent
 * only to the pinned https OpenRouter decisions origin with redirects
 * refused, and never appear in diagnostics or artifacts. Missing
 * `usage.cost` stays UNKNOWN (never 0): totals go incomplete and the
 * pre-request reservation is kept, not refunded.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudJudge, estimateTokens } from "../../../src/judge/cloud-judge.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";
import { type FetchFn, type SleepFn } from "../../../src/judge/systemone-client.js";
import { JudgeError, answerProbability, type JudgeNoulItem } from "../../../src/judge/types.js";
import {
    MODEL_INPUT_RATE_PER_M_USD,
    admitCampaignAttempt,
    campaignRemainingUsd,
    defaultCampaignRoot,
    loadCampaignLedger,
    seedCampaignLedger,
    settleCampaignAttempt,
    voidCampaignAttempt,
    writePrivateArtifact,
    type CampaignLedger,
} from "./model-comparison-budget.js";

export const COMPARISON_MODELS = [
    "~typesafe/jev-latest",
    "perplexity/pplx-decider-v1.1-27b",
    "openai/gpt-6-luna-decisions",
] as const;
export type ComparisonModel = (typeof COMPARISON_MODELS)[number];

export const TRUSTED_DECISIONS_ORIGIN = "https://openrouter.ai";
export const MAX_REQUESTS_PER_MODEL = 1;
export const MAX_TOTAL_REQUESTS = 3;
export const MAX_INPUT_TOKENS_PER_REQUEST = 3000;
export const TOTAL_BUDGET_USD = 0.01;
export const JUDGE_KEY_ENV = "PI_SMARTREAD_JUDGE_API_KEY";
export const FULL_RUN_NOT_AUTHORISED =
    "Full comparison is NOT authorised in this stage (owner sign-off required). No request was sent.";

/** Advertised input rates (USD per 1M tokens) from the frozen protocol.
 * Single-sourced from the campaign budget module (pinned official pages). */
export const ADVERTISED_INPUT_RATE_PER_M = MODEL_INPUT_RATE_PER_M_USD as Record<ComparisonModel, number>;

/** Fixed probe query (protocol q01 wording, no fixture scores consulted). */
export const PROBE_QUERY = "How does text search fall back through engines when no semantic index is available?";

export interface ProbeUnitSpec {
    id: string;
    label: "gold" | "hard_negative";
    path: string;
    symbol: string;
    text: string;
}

export interface ProbeInput {
    query: string;
    items: ProbeUnitSpec[];
    candidateHash: string;
    criterionHash: string;
    sharedHash: string;
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf-8").digest("hex");
}

const GOLD_TEXT = [
    "async function runNoIndexCascade(pattern, dir) {",
    "  const engines = [searchSymbolIndex, searchAstGrep, searchBm25, searchPlainText];",
    "  for (const engine of engines) {",
    "    const hits = await engine(pattern, dir);",
    "    if (hits.length > 0) return hits;",
    "  }",
    "  return [];",
    "}",
].join("\n");

const HARD_NEG_TEXT = [
    "async function handleSymbol(pattern, limit, dir) {",
    "  const matches = await symbolIndex.lookup(pattern, { limit });",
    "  return { matches: matches.slice(0, limit) };",
    "}",
].join("\n");

export function buildProbeInput(): ProbeInput {
    const items: ProbeUnitSpec[] = [
        { id: "u0", label: "gold", path: "src/search/grep-cascade.ts", symbol: "runNoIndexCascade", text: GOLD_TEXT },
        { id: "u1", label: "hard_negative", path: "src/search/find-symbol-tool.ts", symbol: "handleSymbol", text: HARD_NEG_TEXT },
    ];
    const candidateHash = sha256Hex(JSON.stringify(items.map((u) => ({ id: u.id, path: u.path, symbol: u.symbol, text: u.text }))));
    // Bind the EXACT submitted wire shape: shared plus every question object
    // with its real state ref (`units.<id>`), as CloudJudge submits them.
    // Labels live only in this local spec; they never enter the payload.
    const shared = { query: PROBE_QUERY };
    const questions: Record<string, unknown> = {};
    for (const u of items) questions[u.id] = unitRelevanceQuestion(PROBE_QUERY, `units.${u.id}`);
    const criterionHash = sha256Hex(JSON.stringify({ shared, questions }));
    const sharedHash = sha256Hex(JSON.stringify(shared));
    return { query: PROBE_QUERY, items, candidateHash, criterionHash, sharedHash };
}

export function hasJudgeKey(env: NodeJS.ProcessEnv = process.env): boolean {
    return typeof env[JUDGE_KEY_ENV] === "string" && env[JUDGE_KEY_ENV]!.trim() !== "";
}

export type ProbeApiKey =
    | { ok: true; key: string; source: "env:PI_SMARTREAD_JUDGE_API_KEY" | "env:OPENROUTER_API_KEY" | "pi-auth-store:openrouter" }
    | { ok: false; reason: "absent" | "oauth_only" };

/**
 * Normal Pi auth fallback (OpenRouter provider ONLY). Order: explicit
 * judge key, `OPENROUTER_API_KEY`, then the Pi SDK `AuthStorage`
 * OpenRouter credential via its exported API (default path, so
 * `PI_CODING_AGENT_DIR`/`HOME` resolution is preserved and nothing is
 * copied). OAuth-only storage stops with `oauth_only` — it is not a
 * substitute bearer for the Decisions API. Never throws for missing auth.
 */
export async function resolveProbeApiKey(env: NodeJS.ProcessEnv = process.env): Promise<ProbeApiKey> {
    const explicit = env[JUDGE_KEY_ENV];
    if (typeof explicit === "string" && explicit.trim() !== "") {
        return { ok: true, key: explicit, source: "env:PI_SMARTREAD_JUDGE_API_KEY" };
    }
    const ambient = env.OPENROUTER_API_KEY;
    if (typeof ambient === "string" && ambient.trim() !== "") {
        return { ok: true, key: ambient, source: "env:OPENROUTER_API_KEY" };
    }
    try {
        const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
        const store = AuthStorage.create();
        const stored = store.get("openrouter");
        if (stored?.type === "oauth") return { ok: false, reason: "oauth_only" };
        const key = await store.getApiKey("openrouter", { includeFallback: false });
        if (typeof key === "string" && key.trim() !== "") {
            if (stored?.type !== "api_key") return { ok: false, reason: "oauth_only" };
            return { ok: true, key, source: "pi-auth-store:openrouter" };
        }
    } catch {
        // SDK store unavailable; fall through to absent.
    }
    return { ok: false, reason: "absent" };
}

export function validateProbability(value: unknown): { ok: true; p: number } | { ok: false } {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return { ok: false };
    return { ok: true, p: value };
}

export interface ComparisonArgs {
    mode: "probe" | "full";
    models: ComparisonModel[];
    out: string;
}

function defaultOutPath(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    // Canonical caller-boundary tmp base (macOS /var->/private/var) so the
    // campaign all-ancestor rejection judges only adversary links.
    return join(realpathSync(tmpdir()), `judge-model-comparison-${stamp}.json`);
}

/**
 * Caller-boundary normalization for `--out`: rewrite ONLY trusted, fixed
 * platform tmp aliases (the literal `/tmp` string and the exact `tmpdir()`
 * value) to their canonical targets. The `realpathSync` calls resolve
 * fixed OS-known strings, never the caller-supplied path, so an arbitrary
 * nested hostile symlink or user alias ancestor is NOT resolved away and
 * stays fail-closed under the writer's all-ancestor rejection. Leaf
 * symlinks are never approved here either. Node20: `tmpdir()` +
 * `realpathSync` are long-stable os/fs signatures.
 */
export function normalizeCallerOutPath(raw: string): string {
    const resolved = resolve(raw);
    const aliases: Array<{ alias: string; canonical: string }> = [];
    try {
        const canonicalTmp = realpathSync("/tmp");
        if (canonicalTmp !== "/tmp") aliases.push({ alias: "/tmp", canonical: canonicalTmp });
    } catch {
        // No /tmp alias to normalize; the writer judges the path as-is.
    }
    try {
        const aliasBase = resolve(tmpdir());
        const canonicalBase = realpathSync(tmpdir());
        if (canonicalBase !== aliasBase) aliases.push({ alias: aliasBase, canonical: canonicalBase });
    } catch {
        // tmpdir unavailable; the writer judges the path as-is.
    }
    // Longest alias prefix first so nested tmp bases match precisely.
    aliases.sort((a, b) => b.alias.length - a.alias.length);
    for (const { alias, canonical } of aliases) {
        if (resolved === alias) return canonical;
        if (resolved.startsWith(`${alias}${sep}`)) return join(canonical, resolved.slice(alias.length + 1));
    }
    return resolved;
}

/** Fail-closed caller binding before any fetch: normalized path, an
 * exclusive-create precheck (leaf or sidecar already present, including
 * symlinks, is refused), and the same all-ancestor walk the writer
 * performs (every existing ancestor must be a genuine directory). No file
 * is created here; the writer still owns exclusive creation. */
function bindOutPathExclusive(raw: string | undefined): string {
    const outPath = normalizeCallerOutPath(raw ?? defaultOutPath());
    for (const candidate of [outPath, `${outPath}.sha256`]) {
        let exists = false;
        try {
            lstatSync(candidate);
            exists = true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        if (exists) throw new Error(`Refusing to overwrite existing path: ${candidate}`);
    }
    // Caller-side mirror of the writer's all-ancestor rejection so a bad
    // --out fails before any fetch is admitted. Missing components are
    // skipped but the walk continues above them; user links are never
    // resolved away.
    let cur = outPath;
    for (;;) {
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
        let st;
        try {
            st = lstatSync(cur);
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
            throw err;
        }
        if (st.isSymbolicLink()) throw new Error(`Refusing symlinked artifact ancestor: ${cur}`);
        if (!st.isDirectory()) throw new Error(`Refusing non-directory artifact ancestor: ${cur}`);
    }
    return outPath;
}

function isComparisonModel(value: string): value is ComparisonModel {
    return (COMPARISON_MODELS as readonly string[]).includes(value);
}

function parseModelList(raw: string | undefined): ComparisonModel[] {
    const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) throw new Error("--models must list at least one model slug");
    for (const m of list) {
        if (!isComparisonModel(m)) throw new Error(`Unknown model: ${m}`);
    }
    return list as ComparisonModel[];
}

export function parseComparisonArgs(argv: string[]): ComparisonArgs {
    let mode: ComparisonArgs["mode"] = "probe";
    let models: ComparisonModel[] | undefined;
    let out: string | undefined;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--mode") {
            const v = argv[++i] ?? "";
            if (v !== "probe" && v !== "full") throw new Error("--mode must be probe or full");
            mode = v;
        } else if (arg === "--models") {
            models = parseModelList(argv[++i]);
        } else if (arg === "--out") {
            out = argv[++i];
            if (!out) throw new Error("--out requires a path");
        } else if (arg === "--help" || arg === "-h") {
            console.log("Usage: npx tsx scripts/eval/judge/model-comparison.ts [--mode probe|full] [--models a,b] [--out PATH]");
            console.log(`Models: ${COMPARISON_MODELS.join(", ")}`);
            console.log("Stops: <=1 request/model (3 total), <=3000 input tokens/request, <=$0.01 total.");
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return { mode, models: models ?? [...COMPARISON_MODELS], out: out ?? defaultOutPath() };
}

export type ProbeStatus = "ok" | "bad_response" | "over_token_budget" | "stopped_budget" | JudgeError["code"];

export interface ModelProbeResult {
    requestedModel: ComparisonModel;
    resolvedIdentity: string;
    provider: string;
    status: ProbeStatus;
    scores: Record<string, number>;
    unjudged: Array<{ id: string; code: string }>;
    inputTokens: number;
    costUsd: number | undefined;
    requestTimestamp: string;
    latencyMs: number;
    candidateHash: string;
    criterionHash: string;
    sharedHash: string;
    httpAttempts: number;
}

export interface ComparisonReport {
    protocol: "docs/plans/2026-10-08-judge-decider-protocol.md";
    mode: "probe";
    query: string;
    results: ModelProbeResult[];
    requestCount: number;
    httpAttempts: number;
    totalCostUsd: number | undefined;
    costComplete: boolean;
    reservedUsd: number;
    totalInputTokens: number;
    stoppedEarly: boolean;
    validCoverage: { judged: number; unjudged: number };
    fullRunEstimate: FullRunEstimate;
    /** Durable handoff: global campaign books for the next stage/worker. */
    campaignLedgerPath: string;
    campaignUsedUsd: number;
    campaignRemainingUsd: number;
    campaignCostComplete: boolean;
}

export interface FullRunEstimate {
    corpusUnits: number;
    corpusQueries: number;
    queryGroupsPerArm: number;
    plannedCallsPerArm: number;
    callUpperBoundPerArm: number;
    plannedCalls: number;
    callUpperBound: number;
    fiveReplicatePlannedCalls: number;
    fiveReplicateUpperBound: number;
    maxInputTokensPerRequest: number;
    perModelCostUsd: Record<ComparisonModel, number>;
    totalCostUsd: number;
    fiveReplicateTotalUsd: number;
    conservativeUpperUsd: number;
    uncertainty: string;
}

/**
 * Heuristic full-run estimate from the exact corpus: 314 units in 44
 * query groups (78 gold / 148 hard_negative / 88 easy_negative). It ASSUMES
 * the scored runner (`scripts/eval/judge/run.ts`) issues 1 warmup + 1
 * request per query group per model arm (each group packing into one
 * <=24k-token batch), so 45 planned calls/arm. That one-batch-per-group
 * packing is measured — not assumed — by `deriveFullRunPlan()` in
 * `model-comparison-plan.ts`, which exercises the actual `CloudJudge`
 * batching offline (see the cost-probe doc); treat the numbers here as
 * the heuristic form of that measured plan. The scored
 * bounds each at 135. Costs scale the measured Jev single-run baseline
 * (170,832 input tokens incl. 1,078 warmup) at advertised input rates.
 */
export function estimateFullRun(): FullRunEstimate {
    const corpusUnits = 314;
    const corpusQueries = 44;
    const queryGroupsPerArm = 44;
    const measuredTokensPerJudgment = 170832 / 314;
    const plannedCallsPerArm = 1 + queryGroupsPerArm;
    const callUpperBoundPerArm = plannedCallsPerArm * 3;
    const plannedCalls = plannedCallsPerArm * COMPARISON_MODELS.length;
    const callUpperBound = callUpperBoundPerArm * COMPARISON_MODELS.length;
    const fiveReplicatePlannedCalls = plannedCalls * 5;
    const fiveReplicateUpperBound = callUpperBound * 5;
    const perModelCostUsd = {
        "~typesafe/jev-latest": (corpusUnits * measuredTokensPerJudgment * ADVERTISED_INPUT_RATE_PER_M["~typesafe/jev-latest"]) / 1_000_000,
        "perplexity/pplx-decider-v1.1-27b": (corpusUnits * measuredTokensPerJudgment * ADVERTISED_INPUT_RATE_PER_M["perplexity/pplx-decider-v1.1-27b"]) / 1_000_000,
        "openai/gpt-6-luna-decisions": (corpusUnits * measuredTokensPerJudgment * ADVERTISED_INPUT_RATE_PER_M["openai/gpt-6-luna-decisions"]) / 1_000_000,
    } as Record<ComparisonModel, number>;
    const totalCostUsd = perModelCostUsd["~typesafe/jev-latest"] + perModelCostUsd["perplexity/pplx-decider-v1.1-27b"] + perModelCostUsd["openai/gpt-6-luna-decisions"];
    const fiveReplicateTotalUsd = totalCostUsd * 5;
    const conservativeUpperUsd = fiveReplicateTotalUsd * 3;
    return {
        corpusUnits,
        corpusQueries,
        queryGroupsPerArm,
        plannedCallsPerArm,
        callUpperBoundPerArm,
        plannedCalls,
        callUpperBound,
        fiveReplicatePlannedCalls,
        fiveReplicateUpperBound,
        maxInputTokensPerRequest: MAX_INPUT_TOKENS_PER_REQUEST,
        perModelCostUsd,
        totalCostUsd,
        fiveReplicateTotalUsd,
        conservativeUpperUsd,
        uncertainty:
            "Estimated (not measured): advertised input rates only (output free); per-arm calls assume " +
            "each 44 query group packs into one <=24k-token batch plus 1 warmup (45/arm); retry ceiling 3 " +
            "attempts/call bounds the upper counts; chars/4 is an estimation heuristic, not a token bound, " +
            "so the conservative upper triples the 5-replicate total. Server-side score noise (+/-0.04 observed) " +
            "means single-shot probe scores are a sample of one, not a quality claim.",
    };
}

export interface RunProbeOptions {
    apiKey: string;
    models: ComparisonModel[];
    fetchFn?: FetchFn;
    writeArtifact?: boolean;
    outPath?: string;
    /**
     * Campaign ledger placement. Defaults to the persistent global ledger
     * (`~/.cache/pi-smartread-judge-campaign/`). Unit tests MUST pass
     * `{ ephemeral: true }` so fake stub costs never touch the real books.
     */
    campaign?: { root: string } | { ephemeral: true };
}

function toItems(input: ProbeInput): JudgeNoulItem[] {
    return input.items.map((u) => ({
        id: u.id,
        state: { path: u.path, symbol: u.symbol, text: u.text },
        question: (stateRef: string) => unitRelevanceQuestion(input.query, stateRef),
    }));
}

/**
 * Actual-attempt ledger: EVERY fetch invocation is admitted here before it
 * is sent, so failures and client retries are counted, not just answered
 * requests. Admission is synchronous (increment before the first await),
 * capping the probe at 1 actual attempt per model, 3 total.
 */
export interface AttemptLedger {
    total: number;
    perModel: Map<string, number>;
    firstStatusByModel: Map<string, number>;
}

export function createAttemptLedger(): AttemptLedger {
    return { total: 0, perModel: new Map(), firstStatusByModel: new Map() };
}

function unadmitAttempt(ledger: AttemptLedger, model: string): void {
    const used = ledger.perModel.get(model) ?? 0;
    if (used > 0) ledger.perModel.set(model, used - 1);
    ledger.total = Math.max(0, ledger.total - 1);
}

function admitAttempt(ledger: AttemptLedger, model: string): void {
    const used = ledger.perModel.get(model) ?? 0;
    if (used >= 1 || ledger.total >= MAX_TOTAL_REQUESTS) {
        throw new JudgeError("aborted", "probe_attempt_budget_exhausted");
    }
    ledger.perModel.set(model, used + 1);
    ledger.total += 1;
}

export const PROBE_NO_RETRY = "probe_no_retry_single_attempt";

/** Sleep that refuses cloud-client retries so one probe model can never
 *  turn into up to 3 HTTP attempts behind the budget ledger. The per-model
 *  handler maps the refusal back to the first attempt's status. */
const noRetrySleep: SleepFn = async () => {
    throw new JudgeError("aborted", PROBE_NO_RETRY);
};

/** Fetch wrapper capturing the served model/provider via a cloned body,
 *  origin-pinned to the https OpenRouter decisions origin with redirects
 *  refused (fail-closed) so the bearer can never follow a redirect to
 *  another origin. Every invocation is ledger-admitted first (probe cap),
 *  then campaign-admitted (global $10 hard cap) BEFORE the fetch is sent; local
 *  refusals after admission void both admissions, never leaving a charge
 *  for an attempt that did not reach the wire. */
function capturingFetch(
    inner: FetchFn,
    captured: ProbeFetchCapture,
    ledger: AttemptLedger,
    model: string,
    campaignRoot: string,
): FetchFn {
    return async (url: string, init?: RequestInit) => {
        admitAttempt(ledger, model);
        let campaignAttemptId: string;
        try {
            ({ attemptId: campaignAttemptId } = admitCampaignAttempt(campaignRoot, model));
        } catch (err) {
            unadmitAttempt(ledger, model);
            captured.campaignHalt = err;
            throw err;
        }
        captured.campaignAttemptId = campaignAttemptId;
        const failClosed = (code: "probe_invalid_url" | "endpoint_not_allowed"): never => {
            unadmitAttempt(ledger, model);
            voidCampaignAttempt(campaignRoot, campaignAttemptId);
            captured.campaignAttemptId = undefined;
            throw new JudgeError("aborted", code);
        };
        let target: URL | undefined;
        try {
            target = new URL(url);
        } catch {
            failClosed("probe_invalid_url");
        }
        if (target === undefined || target.protocol !== "https:" || target.origin !== TRUSTED_DECISIONS_ORIGIN) {
            failClosed("endpoint_not_allowed");
        }
        captured.fetchSent = true;
        const res = await inner(url, { ...init, redirect: "error" });
        if (!ledger.firstStatusByModel.has(model)) ledger.firstStatusByModel.set(model, res.status);
        try {
            const clone = res.clone();
            const parsed = (await clone.json()) as { model?: unknown; provider?: unknown };
            if (typeof parsed.model === "string") captured.model = parsed.model;
            if (typeof parsed.provider === "string") captured.provider = parsed.provider;
        } catch {
            // Served identity unavailable; caller records "unavailable".
        }
        return res;
    };
}

/** Wire identity captured from a cloned response body, plus the campaign
 *  admission handle for the attempt that produced it. */
interface ProbeFetchCapture {
    model?: string;
    provider?: string;
    campaignAttemptId?: string;
    /** Admission error that must fail the probe loudly (never per-model). */
    campaignHalt?: unknown;
    /** True once a fetch was actually sent (settle, never void). */
    fetchSent?: boolean;
    /** True once a settlement was attempted (exactly one settle per attempt). */
    settleAttempted?: boolean;
}

interface ProbeLoopState {
    actualCostUsd: number;
    costComplete: boolean;
    reservedUsd: number;
    totalInputTokens: number;
    stoppedEarly: boolean;
}

/**
 * Projected worst-case reservation for one probe request: estimated tokens
 * at the dearest advertised rate with a 4x safety margin. chars/4 is an
 * estimation heuristic, not a token bound, so the margin — not the raw
 * estimate — is what the pre-request stop enforces. Missing actual cost
 * never refunds the reservation.
 */
function projectedCostUsd(estimatedTokens: number): number {
    const dearest = Math.max(...Object.values(ADVERTISED_INPUT_RATE_PER_M));
    return (estimatedTokens * dearest * 4) / 1_000_000;
}

function budgetExceeded(state: ProbeLoopState, estimatedTokens: number): boolean {
    return state.reservedUsd >= TOTAL_BUDGET_USD
        || state.reservedUsd + projectedCostUsd(estimatedTokens) > TOTAL_BUDGET_USD;
}

/** Settle the campaign admission for one probe attempt: reported actuals
 * true the campaign up, UNKNOWN retains the reserve. Exactly one settlement
 * is attempted per admission: the flag is set BEFORE the ledger write, and
 * the handle is cleared only on success, so a post-rename durability (EIO)
 * failure cannot trigger a second UNKNOWN settlement that would mask the
 * original error. Any settlement I/O error must halt loudly via the
 * campaignHalt channel — financial I/O is never converted into a per-model
 * network result. Returns the persisted ledger so the caller can halt on
 * the `reserveBreached` marker. */
function settleProbeCampaignAttempt(campaignRoot: string, captured: ProbeFetchCapture, actualCostUsd: number | undefined): CampaignLedger {
    const attemptId = captured.campaignAttemptId;
    if (attemptId === undefined) throw new Error("Cannot settle probe attempt without a campaign admission");
    captured.settleAttempted = true;
    const ledger = settleCampaignAttempt(campaignRoot, attemptId, actualCostUsd);
    captured.campaignAttemptId = undefined;
    return ledger;
}

async function probeOneModel(
    model: ComparisonModel,
    input: ProbeInput,
    items: JudgeNoulItem[],
    shared: Record<string, string>,
    apiKey: string,
    fetchFn: FetchFn | undefined,
    state: ProbeLoopState,
    ledger: AttemptLedger,
    campaignRoot: string,
): Promise<ModelProbeResult> {
    const inner: FetchFn = fetchFn ?? ((fetch as unknown) as FetchFn);
    const captured: ProbeFetchCapture = {};
    const before = ledger.perModel.get(model) ?? 0;
    const judge = new CloudJudge({
        apiKey,
        model,
        cache: null,
        fetchFn: capturingFetch(inner, captured, ledger, model, campaignRoot),
        sleepFn: noRetrySleep,
    });
    const requestTimestamp = new Date().toISOString();
    const start = performance.now();
    const base = {
        requestedModel: model,
        requestTimestamp,
        candidateHash: input.candidateHash,
        criterionHash: input.criterionHash,
    } as const;
    try {
        const res = await judge.judgeNouls({ shared, items });
        const latencyMs = performance.now() - start;
        // Persist the charge FIRST, then halt loudly on an over-reserve
        // actual — even for the final model with no subsequent admission.
        // The halt rides the existing campaignHalt channel so the catch
        // below rethrows it instead of recording a per-model outcome; the
        // admission is already settled exactly once, never voided or retried.
        // Settlement I/O failure also halts loudly with its ORIGINAL error
        // identity (no second settlement, no next model/fetch) since the
        // persisted known actual is already retained by the atomic rename.
        let settledLedger: CampaignLedger;
        try {
            settledLedger = settleProbeCampaignAttempt(campaignRoot, captured, res.usage.costUsd);
        } catch (err) {
            captured.campaignHalt = err;
            throw err;
        }
        if (settledLedger.reserveBreached) {
            captured.campaignHalt = new JudgeError("aborted", "campaign_halted_reserve_breached");
            throw captured.campaignHalt;
        }
        // Missing usage.cost stays UNKNOWN: it contributes nothing to the
        // actual total, flips costComplete, and keeps its reservation.
        if (res.usage.costUsd === undefined) {
            state.costComplete = false;
        } else {
            state.actualCostUsd += res.usage.costUsd;
        }
        state.totalInputTokens += res.usage.inputTokens;
        const scores: Record<string, number> = {};
        for (const [id, answer] of res.p) {
            const checked = validateProbability(answerProbability(answer, false));
            if (checked.ok) scores[id] = checked.p;
            else res.unjudged.push({ id, code: "bad_response" });
        }
        // Refusals and missing answers stay unjudged; never defaulted.
        if (state.reservedUsd > TOTAL_BUDGET_USD) state.stoppedEarly = true;
        return {
            ...base,
            resolvedIdentity: captured.model ?? "unavailable",
            provider: captured.provider ?? "unavailable",
            status: res.unjudged.length > 0 ? "bad_response" : "ok",
            scores,
            unjudged: res.unjudged.map((u) => ({ id: u.id, code: u.code })),
            inputTokens: res.usage.inputTokens,
            costUsd: res.usage.costUsd,
            latencyMs,
            sharedHash: input.sharedHash,
            httpAttempts: (ledger.perModel.get(model) ?? before) - before,
        };
    } catch (err) {
        // Campaign-halt errors fail the probe loudly: they are campaign
        // budget state, not per-model transport outcomes, and must never
        // be recorded as just another "aborted" model.
        if (err === captured.campaignHalt) throw err;
        // A fetch that reached the wire keeps its campaign reservation:
        // UNKNOWN actuals retain the reserve. Pre-wire refusals already
        // voided both admissions inside the fetch wrapper. Settlement is
        // attempted at most once: if the success-path settle already ran
        // (even when its I/O threw), a second UNKNOWN settle would mask
        // the original error, so halt with the original instead. A failed
        // UNKNOWN settle (pre-persistence: reserve retained in-flight;
        // post-persistence: known actual retained by the rename) likewise
        // halts loudly — never a per-model outcome, never a next model.
        if (captured.fetchSent && !captured.settleAttempted) {
            try {
                settleProbeCampaignAttempt(campaignRoot, captured, undefined);
            } catch (settleErr) {
                captured.campaignHalt = settleErr;
                throw settleErr;
            }
        } else if (captured.fetchSent && captured.settleAttempted && captured.campaignHalt !== undefined) {
            throw captured.campaignHalt;
        }
        let code: ProbeStatus = err instanceof JudgeError ? err.code : "network";
        // The no-retry refusal fires after a real first attempt; report the
        // attempt's own status instead of the refusal.
        if (err instanceof JudgeError && err.message === PROBE_NO_RETRY) {
            const first = ledger.firstStatusByModel.get(model);
            if (first !== undefined) code = `http_${first}`;
        }
        return {
            ...base,
            resolvedIdentity: captured.model ?? "unavailable",
            provider: captured.provider ?? "unavailable",
            status: code,
            scores: {},
            unjudged: items.map((u) => ({ id: u.id, code })),
            inputTokens: 0,
            costUsd: undefined,
            latencyMs: performance.now() - start,
            sharedHash: input.sharedHash,
            httpAttempts: (ledger.perModel.get(model) ?? before) - before,
        };
    }
    // Sequential probe: one request per model, no concurrency changes.
}

export async function runModelComparisonProbe(opts: RunProbeOptions): Promise<ComparisonReport> {
    const input = buildProbeInput();
    const items = toItems(input);
    const shared = { query: input.query };
    const results: ModelProbeResult[] = [];
    const state: ProbeLoopState = { actualCostUsd: 0, costComplete: true, reservedUsd: 0, totalInputTokens: 0, stoppedEarly: false };
    const ledger = createAttemptLedger();
    // Global campaign ledger: seeded once (verified prior 6 attempts +
    // breach note), then admission-before-fetch for EVERY actual attempt.
    // Unit tests pass `{ ephemeral: true }` so stub costs stay off the books.
    const campaignRoot = opts.campaign !== undefined && "ephemeral" in opts.campaign && opts.campaign.ephemeral
        ? mkdtempSync(join(realpathSync(tmpdir()), "judge-campaign-ephemeral-"))
        : (opts.campaign !== undefined && "root" in opts.campaign ? opts.campaign.root : defaultCampaignRoot());
    seedCampaignLedger(campaignRoot);

    // Duplicate slugs are rejected BEFORE any fetch is admitted.
    const seenModels = new Set<string>();
    for (const model of opts.models) {
        if (seenModels.has(model)) {
            throw new Error(`duplicate model slug rejected before any fetch: ${model}`);
        }
        seenModels.add(model);
    }
    // Caller path binding BEFORE any fetch: a bad --out (existing leaf or
    // sidecar, hostile ancestor) fails here with zero outgoing requests.
    // No artifact is reserved; the writer still owns exclusive creation.
    const boundOutPath = opts.writeArtifact === false ? undefined : bindOutPathExclusive(opts.outPath);

    const models = (opts.models.length > 0 ? opts.models : [...COMPARISON_MODELS]).slice(0, MAX_TOTAL_REQUESTS);
    if (opts.models.length > MAX_TOTAL_REQUESTS) state.stoppedEarly = true;

    for (const model of models) {
        if (results.length >= MAX_TOTAL_REQUESTS) {
            state.stoppedEarly = true;
            break;
        }
        // Hard pre-request stops: token budget and spend budget.
        const estimated = estimateTokens({ shared, items: items.map((u) => ({ [u.id]: u.state })) });
        if (estimated > MAX_INPUT_TOKENS_PER_REQUEST) {
            results.push({
                requestedModel: model, resolvedIdentity: "unavailable", provider: "unavailable",
                status: "over_token_budget", scores: {}, unjudged: items.map((u) => ({ id: u.id, code: "over_token_budget" })),
                inputTokens: 0, costUsd: undefined, requestTimestamp: new Date().toISOString(),
                latencyMs: 0, candidateHash: input.candidateHash, criterionHash: input.criterionHash,
                sharedHash: input.sharedHash, httpAttempts: 0,
            });
            state.stoppedEarly = true;
            break;
        }
        if (budgetExceeded(state, estimated)) {
            state.stoppedEarly = true;
            break;
        }
        // Reserve the worst case BEFORE the fetch; actuals true it up after.
        state.reservedUsd += projectedCostUsd(estimated);
        results.push(await probeOneModel(model, input, items, shared, opts.apiKey, opts.fetchFn, state, ledger, campaignRoot));
        const last = results[results.length - 1]!;
        if (last.costUsd !== undefined) {
            // True-up only upward; missing cost never refunds the reservation.
            state.reservedUsd += Math.max(0, last.costUsd - projectedCostUsd(estimated));
        }
    }

    const judged = results.reduce((n, r) => n + Object.keys(r.scores).length, 0);
    const unjudged = results.reduce((n, r) => n + r.unjudged.length, 0);
    const campaign = loadCampaignLedger(campaignRoot);
    const report: ComparisonReport = {
        protocol: "docs/plans/2026-10-08-judge-decider-protocol.md",
        mode: "probe",
        query: input.query,
        results,
        requestCount: results.filter((r) => r.status === "ok" || r.status === "bad_response").length,
        httpAttempts: ledger.total,
        totalCostUsd: state.costComplete ? state.actualCostUsd : undefined,
        costComplete: state.costComplete,
        reservedUsd: state.reservedUsd,
        totalInputTokens: state.totalInputTokens,
        stoppedEarly: state.stoppedEarly,
        validCoverage: { judged, unjudged },
        fullRunEstimate: estimateFullRun(),
        campaignLedgerPath: campaignRoot,
        campaignUsedUsd: campaign.campaignUsedUsd,
        campaignRemainingUsd: campaignRemainingUsd(campaign),
        campaignCostComplete: campaign.costComplete,
    };

    if (opts.writeArtifact !== false) {
        const outPath = boundOutPath as string;
        const body = `${JSON.stringify(report, null, 2)}\n`;
        // Exclusive 0600 create + exact-bytes sidecar; existing paths are
        // rejected and chmod failures are fail-closed (never swallowed).
        writePrivateArtifact(outPath, body);
    }
    return report;
}

async function main(): Promise<void> {
    let args: ComparisonArgs;
    try {
        args = parseComparisonArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`error: ${(err as Error).message}`);
        process.exit(2);
    }
    if (args!.mode === "full") {
        console.error(`error: ${FULL_RUN_NOT_AUTHORISED}`);
        process.exit(3);
    }
    const resolved = await resolveProbeApiKey();
    if (!resolved.ok) {
        if (resolved.reason === "oauth_only") {
            console.error("error: OpenRouter stored credential is OAuth-only (oauth_only); Decisions needs an API key. Add one via pi auth or set PI_SMARTREAD_JUDGE_API_KEY.");
        } else {
            console.error("error: judge API key absent (presence=false). Set PI_SMARTREAD_JUDGE_API_KEY or add an OpenRouter API key to pi auth; not scraping credentials.");
        }
        process.exit(2);
    }
    const apiKey = resolved.key;
    const report = await runModelComparisonProbe({ apiKey, models: args!.models, outPath: args!.out });
    console.log(JSON.stringify({
        requestCount: report.requestCount,
        httpAttempts: report.httpAttempts,
        totalCostUsd: report.costComplete ? report.totalCostUsd : "UNKNOWN",
        costComplete: report.costComplete,
        reservedUsd: report.reservedUsd,
        authSource: resolved.source,
        totalInputTokens: report.totalInputTokens,
        validCoverage: report.validCoverage,
        fullRunEstimate: report.fullRunEstimate,
        results: report.results.map((r) => ({
            requestedModel: r.requestedModel,
            resolvedIdentity: r.resolvedIdentity,
            provider: r.provider,
            status: r.status,
            scores: r.scores,
            inputTokens: r.inputTokens,
            costUsd: r.costUsd,
            latencyMs: Math.round(r.latencyMs),
            requestTimestamp: r.requestTimestamp,
        })),
    }, null, 2));
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
    await main();
}
