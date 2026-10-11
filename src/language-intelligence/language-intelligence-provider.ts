import { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
    RPC_CHANNELS,
    LANGUAGE_INTELLIGENCE_RPC_METHODS,
    LSP_TIMEOUT_MS_MIN,
    LSP_TIMEOUT_MS_DEFAULT,
    LSP_TIMEOUT_MS_MAX,
    validateLanguageIntelligenceCapabilitiesRequest,
    validateCheckPostEditDiagnosticsRequest,
    validateCheckPostEditDiagnosticsResponse,
    validateRenamePreviewRequest,
    validateFormattingRequest,
    validateCodeActionRequest,
    validateRenamePreviewResponse,
    validateFormattingResponse,
    validateCodeActionResponse,
    type CheckPostEditDiagnosticsResponse,
    type LanguageDiagnostic,
    type RenamePreviewResponse,
    type FormattingResponse,
    type CodeActionResponse,
} from "@rhinos0608/pi-workspace-protocol";
import { createRpcServer, type BusLike, type RequestEvent } from "@rhinos0608/pi-workspace-protocol";
import type { StrictEnvelope, StrictRequest } from "../lsp/lsp-strict-contract.js";
import { resolveLanguageServer, detectProjectRoot, detectLanguageId } from "./language-intelligence-runtime.js";
import { createBoundActionStageRequester } from "../lsp/lsp-action-stage-rpc.js";
import { getWorkspaceEditBus } from "../lsp/lsp-workspace-edit.js";
import type { BoundActionRequest } from "../lsp/lsp-action-origin.js";
import type {
    BoundSemanticEditDependencies,
    BoundSemanticEditRoute,
    executeBoundSemanticEdit as ExecuteBoundSemanticEdit,
} from "../lsp/lsp-semantic-edit-origin.js";
import type {
    BoundActionAdapterDependencies,
    BoundActionRoute,
    executeBoundAction as ExecuteBoundAction,
} from "../lsp/lsp-action-adapter.js";

export interface LanguageIntelligenceProviderBus extends BusLike {}

type ExecutorFn = (req: unknown, deps?: Record<string, unknown>) => Promise<StrictEnvelope>;

// Test seam: unit tests inject a fake executor; production dynamically
// imports the canonical executor. Post-edit diagnostics sourcing below
// goes through executeLspOperation — zero disk writes (proposals only).
let executorOverride: ExecutorFn | null = null;

export function __setLanguageIntelligenceExecutorForTests(fn: ExecutorFn | null): void {
    executorOverride = fn;
}

export function __resetLanguageIntelligenceExecutorForTests(): void {
    executorOverride = null;
}

async function runExecutor(req: StrictRequest, opts: { cwd: string }): Promise<StrictEnvelope> {
    // NOTE (Wave B Round 2): the broker AbortSignal seam is proposal-only —
    // these RPC handlers carry no caller signal, so none is threaded here.
    // The executor supports deps.signal for deeper cancellation; wiring a
    // caller signal through is future work (don't boil the ocean).
    if (executorOverride) return executorOverride(req, { cwd: opts.cwd });
    const { executeLspOperation } = await import("../lsp/lsp-executor.js");
    return executeLspOperation(req, { cwd: opts.cwd });
}

// ── D-81 bound producers (staged proposals, never raw edits) ─────────
// rename_preview/formatting go through executeBoundSemanticEdit; code_action
// discovery and selection go through executeBoundAction. Both stage via
// SmartEdit's stage_workspace_edit RPC with the producer-held
// source-document precondition; the provider only supplies the request,
// route, deadline, and a stage requester wired with this session's identity.

export interface LanguageIntelligenceProducers {
    readonly executeSemanticEdit: typeof ExecuteBoundSemanticEdit;
    readonly executeAction: typeof ExecuteBoundAction;
}

let producerOverride: LanguageIntelligenceProducers | null = null;

/** Test seam: inject fake bound producers. Production dynamically imports the canonical modules. */
export function __setLanguageIntelligenceProducersForTests(producers: Partial<LanguageIntelligenceProducers> | null): void {
    producerOverride = producers === null ? null : { ...producerOverride, ...producers } as LanguageIntelligenceProducers;
}

export function __resetLanguageIntelligenceProducersForTests(): void {
    producerOverride = null;
}

async function runSemanticEdit(
    request: StrictRequest,
    route: BoundSemanticEditRoute,
    dependencies: BoundSemanticEditDependencies,
): Promise<Awaited<ReturnType<typeof ExecuteBoundSemanticEdit>>> {
    const fn = producerOverride?.executeSemanticEdit;
    if (fn) return fn(request, route, dependencies);
    const { executeBoundSemanticEdit } = await import("../lsp/lsp-semantic-edit-origin.js");
    return executeBoundSemanticEdit(request, route, dependencies);
}

async function runBoundAction(
    request: BoundActionRequest,
    route: BoundActionRoute,
    dependencies: BoundActionAdapterDependencies,
): Promise<Awaited<ReturnType<typeof ExecuteBoundAction>>> {
    const fn = producerOverride?.executeAction;
    if (fn) return fn(request, route, dependencies);
    const { executeBoundAction } = await import("../lsp/lsp-action-adapter.js");
    return executeBoundAction(request, route, dependencies);
}

// ── Staging session identity ─────────────────────────────────────────
// The shared rename/formatting/code_action DTOs carry no session fields,
// but stage_workspace_edit requires sessionFilePath + cwd. The provider
// cannot invent the caller's session: it stages under SmartRead's own
// current session (the same Pi process/session SmartEdit serves), captured
// from the live extension context at session_start / before_agent_start
// and refreshed per run. Per-instance options (tests, alternate hosts)
// override the captured identity. Without an identity the proposal paths
// refuse fail-closed; discovery (which never stages) still runs.

export interface LanguageIntelligenceSessionIdentity {
    readonly sessionFilePath: string | null;
    readonly cwd: string;
}

let capturedIdentity: LanguageIntelligenceSessionIdentity | null = null;

export function noteLanguageIntelligenceSession(identity: LanguageIntelligenceSessionIdentity | null): void {
    capturedIdentity = identity;
}

/** Registration hook: capture the staging identity from the live extension context. */
export function noteLanguageIntelligenceSessionFromContext(ctx: {
    readonly cwd?: unknown;
    readonly sessionManager?: { getSessionFile?: () => string | undefined };
} | null | undefined): void {
    if (!ctx || typeof ctx !== "object") {
        // A missing context carries no session identity: clear any prior
        // capture so proposal staging fails closed (staging-unavailable)
        // instead of reusing a stale session.
        noteLanguageIntelligenceSession(null);
        return;
    }
    let sessionFilePath: string | null = null;
    try {
        const file = ctx.sessionManager?.getSessionFile?.();
        if (typeof file === "string" && file.length > 0) sessionFilePath = file;
    } catch {
        /* ephemeral identity: proposal staging stays unavailable */
    }
    const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    noteLanguageIntelligenceSession({ sessionFilePath, cwd });
}

export interface LanguageIntelligenceProviderOptions {
    readonly getSessionFilePath?: () => string | null;
    readonly getCwd?: () => string;
    readonly getStageBus?: () => BusLike | null;
}

function resolveStagingIdentity(options?: LanguageIntelligenceProviderOptions): {
    readonly sessionFilePath: string | null;
    readonly cwd: string;
    readonly stageBus: BusLike | null;
} {
    let sessionFilePath: string | null = null;
    try {
        sessionFilePath = options?.getSessionFilePath?.() ?? capturedIdentity?.sessionFilePath ?? null;
    } catch {
        sessionFilePath = null;
    }
    let cwd = process.cwd();
    try {
        cwd = options?.getCwd?.() ?? capturedIdentity?.cwd ?? process.cwd();
    } catch {
        /* keep process.cwd() */
    }
    let stageBus: BusLike | null = null;
    try {
        stageBus = options?.getStageBus?.() ?? getWorkspaceEditBus();
    } catch {
        stageBus = null;
    }
    return { sessionFilePath, cwd, stageBus };
}

type StageRequester = ReturnType<typeof createBoundActionStageRequester>;

function stageRequesterFor(identity: {
    readonly sessionFilePath: string | null;
    readonly cwd: string;
    readonly stageBus: BusLike | null;
}): StageRequester | null {
    const { sessionFilePath, cwd, stageBus } = identity;
    if (!stageBus || !sessionFilePath) return null;
    return createBoundActionStageRequester({ bus: stageBus, sessionFilePath, cwd });
}

function envelopeIsFresh(e: { meta?: { freshness?: { state?: string } } }): boolean {
    return e.meta?.freshness?.state === "fresh";
}

/**
 * RPC proposal-path encoding guard (fail-closed).
 *
 * RPC edit DTOs carry no encoding and the SmartEdit planner assumes UTF-16
 * coordinates, so proposal paths (rename/format/codeAction)
 * must not forward or return coordinates negotiated in any other encoding.
 * Non-UTF-16 negotiated encoding rejects with an `unsupported-encoding`
 * error — never converts. Missing encoding defaults to utf-16 (LSP default).
 * The direct strict tool path is unaffected: it keeps negotiated encoding
 * surfaced via envelope server.positionEncoding.
 */
/**
 * LSP timeout envelope (ms) — sourced from protocol v0.6.0 LSP_TIMEOUT_MS_*.
 * Deadline semantics: timeoutMs is a relative service-work budget for the
 * SmartRead executor (owns timeout + $/cancelRequest). The SmartEdit
 * transport deadline is service + 1-2s slack — transport side owns that
 * slack, never this provider.
 */
export const LANGUAGE_INTELLIGENCE_TIMEOUT_MIN = LSP_TIMEOUT_MS_MIN;
export const LANGUAGE_INTELLIGENCE_TIMEOUT_DEFAULT = LSP_TIMEOUT_MS_DEFAULT;
export const LANGUAGE_INTELLIGENCE_TIMEOUT_MAX = LSP_TIMEOUT_MS_MAX;
/** Shorter service-work budget for the post-edit diagnostics path. */
export const POST_EDIT_DIAGNOSTICS_TIMEOUT_MS = 4_000 as const;
/** Default service-work budget for proposal ops (rename/format/organize/codeAction). */
export const PROPOSAL_TIMEOUT_MS = LSP_TIMEOUT_MS_DEFAULT;

/**
 * Clamp a caller-supplied timeoutMs into the protocol envelope [250, 30000].
 * Non-integer / non-finite / missing values fall back to `fallback`.
 */
export function clampLanguageIntelligenceTimeout(requested: unknown, fallback: number = LANGUAGE_INTELLIGENCE_TIMEOUT_DEFAULT): number {
    if (typeof requested !== "number" || !Number.isInteger(requested) || !Number.isFinite(requested)) return fallback;
    if (requested < LANGUAGE_INTELLIGENCE_TIMEOUT_MIN) return LANGUAGE_INTELLIGENCE_TIMEOUT_MIN;
    if (requested > LANGUAGE_INTELLIGENCE_TIMEOUT_MAX) return LANGUAGE_INTELLIGENCE_TIMEOUT_MAX;
    return requested;
}

export const RPC_PROPOSAL_POSITION_ENCODING = "utf-16" as const;

export function isRpcProposalEncodingSupported(encoding: string | undefined): boolean {
    return (encoding ?? RPC_PROPOSAL_POSITION_ENCODING) === RPC_PROPOSAL_POSITION_ENCODING;
}

export function rpcProposalEncodingError(encoding: string | undefined): string {
    return `unsupported-encoding: server negotiated ${encoding ?? "unknown"}, RPC proposal path requires utf-16`;
}

function rpcProposalEncodingOf(env: StrictEnvelope): string | undefined {
    return (env.server as { positionEncoding?: string } | undefined)?.positionEncoding;
}

/** D-81: bound producers never emit ambiguous envelopes (exact lease-bound
 * routing, no candidate selection), so the old ambiguous passthrough is gone
 * with the executor-sourced proposal paths. */

/** D-81 discovery narrowing: candidates carry exactly
 * {title, kind?, isPreferred?, actionId, sourceSha256}. The bound layer
 * spreads the normalized action (which may carry edit/command/data) into
 * the discovery envelope, so the provider must NOT forward it verbatim. */
const HEX64 = /^[0-9a-f]{64}$/;

function narrowDiscoveryItem(raw: unknown): {
    readonly title: string;
    readonly kind?: string;
    readonly isPreferred?: boolean;
    readonly actionId: string;
    readonly sourceSha256: string;
} | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.title !== "string" || r.title.length === 0) return null;
    if (typeof r.actionId !== "string" || !HEX64.test(r.actionId)) return null;
    if (typeof r.sourceSha256 !== "string" || !HEX64.test(r.sourceSha256)) return null;
    return {
        title: r.title,
        ...(typeof r.kind === "string" ? { kind: r.kind } : {}),
        ...(typeof r.isPreferred === "boolean" ? { isPreferred: r.isPreferred } : {}),
        actionId: r.actionId,
        sourceSha256: r.sourceSha256,
    };
}

/** Bound result/refusal statuses mapped onto the RPC error vocabulary.
 * ok/empty/unsupported keep the legacy shapes (proposals vs no-edits vs
 * empty discovery); unavailable/not_ready/timeout/cancelled are honest
 * refusals; everything else (error, stale envelopes) is an op failure. */
type ProposalStatusClass = "proceed" | "empty" | "unavailable" | "not_ready" | "timeout" | "cancelled" | "failed";

function classifyProposalStatus(status: string): ProposalStatusClass {
    if (status === "ok") return "proceed";
    if (status === "empty" || status === "unsupported") return "empty";
    if (status === "unavailable") return "unavailable";
    if (status === "not_ready" || status === "stale") return "not_ready";
    if (status === "timeout") return "timeout";
    if (status === "cancelled") return "cancelled";
    return "failed";
}

/** Bound refusal → RPC error vocabulary. Refusals never take the
 * empty-shaped branch (that is reserved for result envelopes). */
function refusalReplyText(status: string, opFailed: string, staleWord: "unconfirmed" | "stale"): string {
    const cls = classifyProposalStatus(status);
    if (cls === "unavailable") return "no-server";
    if (cls === "not_ready") return staleWord;
    if (cls === "timeout") return "timeout";
    if (cls === "cancelled") return "cancelled";
    return opFailed;
}

/** Result envelope without a staged proposal → RPC error vocabulary.
 * An ok preview with no proposal means the producer would not (over-cap,
 * unsupported semantics) or could not (refused stage) stage. */
function proposalMissText(status: string, opFailed: string, staleWord: "unconfirmed" | "stale"): string {
    const cls = classifyProposalStatus(status);
    if (cls === "proceed") return "staging-unavailable";
    if (cls === "empty") return "no edits";
    return refusalReplyText(status, opFailed, staleWord);
}

function routeForProposal(filePath: string, cwd: string): BoundSemanticEditRoute | null {
    const resolution = resolveLanguageServer(filePath, cwd);
    if (resolution.status === "available") {
        return { projectRoot: resolution.root, languageId: resolution.languageId };
    }
    const languageId = detectLanguageId(filePath);
    if (!languageId) return null;
    return { projectRoot: detectProjectRoot(filePath, cwd), languageId };
}

function renameReply(resp: RenamePreviewResponse): RenamePreviewResponse {
    const v = validateRenamePreviewResponse(resp);
    if (v.ok) return resp;
    return { ok: false, error: v.error };
}

function formattingReply(resp: FormattingResponse): FormattingResponse {
    const v = validateFormattingResponse(resp);
    if (v.ok) return resp;
    return { ok: false, error: v.error };
}

function codeActionReply(resp: CodeActionResponse): CodeActionResponse {
    const v = validateCodeActionResponse(resp);
    if (v.ok) return resp;
    return { ok: false, error: v.error };
}

export function createLanguageIntelligenceProvider(bus: LanguageIntelligenceProviderBus, options?: LanguageIntelligenceProviderOptions): { dispose(): void } {
    const server = createRpcServer({
        bus,
        channel: RPC_CHANNELS.languageIntelligence,
        handler: async (req: RequestEvent) => {
            const rpc = req.rpc;
            const payload = req.payload;

            if (rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities) {
                const v = validateLanguageIntelligenceCapabilitiesRequest(payload);
                if (!v.ok) throw new Error(v.error);
                return { provider: "pi-smartread", capabilities: ["post-edit-diagnostics"] };
            }

            if (rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics) {
                const v = validateCheckPostEditDiagnosticsRequest(payload);
                if (!v.ok) throw new Error(v.error);
                const request = v.value;

                // a. realpathSync check
                let resolved: string;
                try {
                    resolved = realpathSync(request.canonicalPath);
                } catch {
                    return validatedOrDegraded(degraded("file-unreadable"));
                }
                if (resolved !== request.canonicalPath) {
                    return validatedOrDegraded(degraded("file-unreadable"));
                }

                // b. hash before LSP
                let preHash: string;
                try {
                    const content = readFileSync(resolved);
                    preHash = createHash("sha256").update(content).digest("hex");
                } catch {
                    return validatedOrDegraded(degraded("file-unreadable"));
                }
                if (preHash !== request.expectedContentSha256) {
                    return validatedOrDegraded(degraded("content-mismatch"));
                }

                // Freshness honesty gate: executor ok/empty only count as
                // confirmed/clean when meta.freshness.state === "fresh".
                // Unknown/stale answers degrade to unconfirmed (never false-clean).
                // c. LSP call — sourced from executeLspOperation (diagnostics op). Zero disk writes.
                let outcome: { status: string; diagnostics: Array<{ message?: unknown; severity?: unknown; source?: unknown; range?: unknown }> };
                try {
                    const timeoutMs = clampLanguageIntelligenceTimeout(request.timeoutMs, POST_EDIT_DIAGNOSTICS_TIMEOUT_MS);
                    const env = await runExecutor({ operation: "diagnostics", path: request.canonicalPath, workspace: request.canonicalWorkspaceRoot, timeoutMs } as unknown as StrictRequest, { cwd: request.canonicalWorkspaceRoot });
                    if (env.status === "unavailable") {
                        const resp: CheckPostEditDiagnosticsResponse = { status: "unavailable", reason: "no-server", diagnostics: [], truncated: false };
                        return validatedOrDegraded(resp);
                    }
                    // Fail-closed encoding guard (mirrors RPC_PROPOSAL_POSITION_ENCODING):
                    // RPC diagnostic ranges carry no encoding and callers assume
                    // UTF-16, so non-UTF-16 negotiated coordinates never surface
                    // as confirmed/empty — they degrade to unconfirmed.
                    if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(env))) {
                        return validatedOrDegraded(degraded("unconfirmed"));
                    }
                    if (env.status === "unsupported") {
                        return validatedOrDegraded(degraded("unconfirmed"));
                    }
                    if (env.status === "ok") {
                        if (!envelopeIsFresh(env)) return validatedOrDegraded(degraded("unconfirmed"));
                        outcome = { status: "confirmed", diagnostics: (Array.isArray(env.result) ? env.result : []) as typeof outcome.diagnostics };
                    } else if (env.status === "empty") {
                        if (!envelopeIsFresh(env)) return validatedOrDegraded(degraded("unconfirmed"));
                        outcome = { status: "empty", diagnostics: [] };
                    } else {
                        return validatedOrDegraded(degraded("unconfirmed"));
                    }
                } catch {
                    return validatedOrDegraded(degraded("unconfirmed"));
                }

                // d. re-hash after LSP
                let postHash: string;
                try {
                    const content2 = readFileSync(resolved);
                    postHash = createHash("sha256").update(content2).digest("hex");
                } catch {
                    return validatedOrDegraded(degraded("file-unreadable"));
                }
                if (postHash !== request.expectedContentSha256) {
                    return validatedOrDegraded(degraded("content-mismatch"));
                }

                // e. map status
                const status = outcome.status;
                if (status === "unavailable") {
                    return validatedOrDegraded({ status: "unavailable", reason: "no-server", diagnostics: [], truncated: false });
                }
                if (status === "empty") {
                    return validatedOrDegraded({ status: "empty", diagnostics: [], truncated: false });
                }
                if (status === "confirmed") {
                    const raw = Array.isArray(outcome.diagnostics) ? outcome.diagnostics : [];
                    const normalized: LanguageDiagnostic[] = [];
                    for (const d of raw as Array<Record<string, unknown>>) {
                        if (!d || typeof d !== "object") continue;
                        const rangeRaw = (d as Record<string, unknown>).range as Record<string, unknown> | undefined;
                        let lineNeg = false;
                        let range: LanguageDiagnostic["range"] | null = null;
                        if (rangeRaw && typeof rangeRaw === "object" && (rangeRaw as Record<string, unknown>).start && (rangeRaw as Record<string, unknown>).end) {
                            const s = (rangeRaw as Record<string, unknown>).start as Record<string, unknown>;
                            const e = (rangeRaw as Record<string, unknown>).end as Record<string, unknown>;
                            const sl = s.line as unknown;
                            const sc = s.character as unknown;
                            const el = e.line as unknown;
                            const ec = e.character as unknown;
                            if (
                                typeof sl === "number" && typeof sc === "number" && typeof el === "number" && typeof ec === "number" &&
                                Number.isInteger(sl) && Number.isInteger(sc) && Number.isInteger(el) && Number.isInteger(ec)
                            ) {
                                if (sl < 0 || sc < 0 || el < 0 || ec < 0) {
                                    lineNeg = true;
                                } else {
                                    range = { start: { line: sl, character: sc }, end: { line: el, character: ec } };
                                }
                            } else {
                                // malformed numbers -> treat as zero range (don't drop) to preserve diagnostic
                                range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
                            }
                        } else {
                            range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
                        }
                        if (lineNeg) continue;

                        const sevRaw = (d as Record<string, unknown>).severity;
                        let severity: 1 | 2 | 3 | 4 = 3;
                        if (sevRaw === 1 || sevRaw === 2 || sevRaw === 3 || sevRaw === 4) severity = sevRaw;

                        const srcRaw = (d as Record<string, unknown>).source;
                        let source = typeof srcRaw === "string" && srcRaw.length > 0 ? srcRaw : "lsp";
                        if (source.length > 256) source = source.slice(0, 256);

                        const msgRaw = (d as Record<string, unknown>).message;
                        let message = typeof msgRaw === "string" ? msgRaw : String(msgRaw ?? "");
                        if (message.length > 16384) message = message.slice(0, 16384);

                        // Ensure message non-empty? Validator requires string (empty allowed? message is string max 16384, no min). Allow empty.
                        normalized.push({ message, severity, range: range!, source });
                    }

                    // cap
                    const max = request.maxDiagnostics;
                    const truncated = normalized.length > max;
                    const sliced = truncated ? normalized.slice(0, max) : normalized;

                    if (sliced.length === 0) {
                        return validatedOrDegraded({ status: "empty", diagnostics: [], truncated: false });
                    }
                    const resp: CheckPostEditDiagnosticsResponse = { status: "confirmed", diagnostics: sliced as unknown as [LanguageDiagnostic, ...LanguageDiagnostic[]], truncated };
                    return validatedOrDegraded(resp);
                }

                // anything else degraded -> unconfirmed
                return validatedOrDegraded({ status: "degraded", reason: "unconfirmed", diagnostics: [], truncated: false });
            }

            if (rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview) {
                const v = validateRenamePreviewRequest(payload);
                if (!v.ok) throw new Error(v.error);
                const req = v.value;
                // D-81: staged proposal via the bound semantic producer. Never raw edits.
                const line0 = req.line - 1;
                const char0 = req.character - 1;
                if (line0 < 0 || char0 < 0) return renameReply({ ok: false, error: "position-out-of-range" });
                const identity = resolveStagingIdentity(options);
                const route = routeForProposal(req.filePath, identity.cwd);
                if (!route) return renameReply({ ok: false, error: "no-server" });
                const stage = stageRequesterFor(identity);
                if (!stage) return renameReply({ ok: false, error: "staging-unavailable" });
                const timeoutMs = clampLanguageIntelligenceTimeout(req.timeoutMs, PROPOSAL_TIMEOUT_MS);
                let outcome: Awaited<ReturnType<typeof runSemanticEdit>>;
                try {
                    outcome = await runSemanticEdit(
                        { operation: "rename", path: req.filePath, position: { line: line0, character: char0 }, newName: req.newName },
                        route,
                        { deadlineMs: Date.now() + timeoutMs, now: Date.now, stage },
                    );
                } catch {
                    return renameReply({ ok: false, error: "rename failed" });
                }
                void outcome.cleanup.catch(() => undefined);
                if (outcome.kind === "refusal") {
                    return renameReply({ ok: false, error: refusalReplyText(outcome.status, "rename failed", "unconfirmed") });
                }
                const envelope = outcome.envelope;
                if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(envelope))) {
                    return renameReply({ ok: false, error: rpcProposalEncodingError(rpcProposalEncodingOf(envelope)) });
                }
                if (outcome.proposal) {
                    const serverId = envelope.server?.descriptorId;
                    return renameReply({
                        ok: true,
                        proposalId: outcome.proposal.proposalId,
                        files: [...outcome.proposal.files],
                        diff: outcome.proposal.diff,
                        ...(serverId ? { serverDescriptorId: serverId } : {}),
                    });
                }
                return renameReply({ ok: false, error: proposalMissText(envelope.status, "rename failed", "unconfirmed") });
            }

            if (rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting) {
                const v = validateFormattingRequest(payload);
                if (!v.ok) throw new Error(v.error);
                const req = v.value;
                // D-81: staged proposal via the bound semantic producer. Never raw edits.
                const identity = resolveStagingIdentity(options);
                const route = routeForProposal(req.filePath, identity.cwd);
                if (!route) return formattingReply({ ok: false, error: "no-server" });
                const stage = stageRequesterFor(identity);
                if (!stage) return formattingReply({ ok: false, error: "staging-unavailable" });
                const timeoutMs = clampLanguageIntelligenceTimeout(req.timeoutMs, PROPOSAL_TIMEOUT_MS);
                let outcome: Awaited<ReturnType<typeof runSemanticEdit>>;
                try {
                    outcome = await runSemanticEdit(
                        { operation: "formatDocument", path: req.filePath, formatting: { tabSize: req.tabSize ?? 2, insertSpaces: req.insertSpaces ?? true } },
                        route,
                        { deadlineMs: Date.now() + timeoutMs, now: Date.now, stage },
                    );
                } catch {
                    return formattingReply({ ok: false, error: "formatting failed" });
                }
                void outcome.cleanup.catch(() => undefined);
                if (outcome.kind === "refusal") {
                    return formattingReply({ ok: false, error: refusalReplyText(outcome.status, "formatting failed", "unconfirmed") });
                }
                const envelope = outcome.envelope;
                if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(envelope))) {
                    return formattingReply({ ok: false, error: rpcProposalEncodingError(rpcProposalEncodingOf(envelope)) });
                }
                if (outcome.proposal) {
                    const serverId = envelope.server?.descriptorId;
                    return formattingReply({
                        ok: true,
                        proposalId: outcome.proposal.proposalId,
                        files: [...outcome.proposal.files],
                        diff: outcome.proposal.diff,
                        ...(serverId ? { serverDescriptorId: serverId } : {}),
                    });
                }
                return formattingReply({ ok: false, error: proposalMissText(envelope.status, "formatting failed", "unconfirmed") });
            }

            if (rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction) {
                const v = validateCodeActionRequest(payload);
                if (!v.ok) throw new Error(v.error);
                const req = v.value;
                // Range-order guard (protocol envelope allows any non-negative
                // end; a strictly backwards range is a caller error). Zero-length legal.
                if (req.endLine !== undefined || req.endCharacter !== undefined) {
                    const effEndLine = req.endLine ?? req.line;
                    const effEndChar = req.endCharacter ?? req.character;
                    if (effEndLine < req.line || (effEndLine === req.line && effEndChar < req.character)) {
                        throw new Error("CodeActionRequest range end must not precede start");
                    }
                }
                // D-81: discovery narrows bound candidates to exactly
                // {title, kind?, isPreferred?, actionId, sourceSha256}; an
                // explicit selection resolves to a staged proposal. Never raw edits.
                const identity = resolveStagingIdentity(options);
                const route = routeForProposal(req.filePath, identity.cwd);
                if (!route) return codeActionReply({ ok: false, error: "no-server" });
                const line0 = Math.max(0, req.line - 1);
                const char0 = Math.max(0, req.character - 1);
                const endLine0 = req.endLine !== undefined ? Math.max(0, req.endLine - 1) : line0;
                const endChar0 = req.endCharacter !== undefined ? Math.max(0, req.endCharacter - 1) : char0;
                const range = { start: { line: line0, character: char0 }, end: { line: endLine0, character: endChar0 } };
                const context: { diagnostics?: unknown[]; only?: string[] } = {};
                if (req.diagnostics !== undefined) context.diagnostics = req.diagnostics as unknown as unknown[];
                if (req.only !== undefined) context.only = req.only as unknown as string[];
                const timeoutMs = clampLanguageIntelligenceTimeout(req.timeoutMs, PROPOSAL_TIMEOUT_MS);
                if (req.selection !== undefined) {
                    const stage = stageRequesterFor(identity);
                    if (!stage) return codeActionReply({ ok: false, error: "staging-unavailable" });
                    let outcome: Awaited<ReturnType<typeof runBoundAction>>;
                    try {
                        outcome = await runBoundAction(
                            {
                                operation: "resolveCodeAction",
                                path: req.filePath,
                                range,
                                context,
                                selection: { actionId: req.selection.actionId, sourceSha256: req.selection.sourceSha256 },
                            },
                            route,
                            { deadlineMs: Date.now() + timeoutMs, now: Date.now, stage },
                        );
                    } catch {
                        return codeActionReply({ ok: false, error: "code action failed" });
                    }
                    void outcome.cleanup.catch(() => undefined);
                    if (outcome.kind === "refusal") {
                        return codeActionReply({ ok: false, error: refusalReplyText(outcome.status, "code action failed", "stale") });
                    }
                    const envelope = outcome.envelope;
                    if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(envelope))) {
                        return codeActionReply({ ok: false, error: rpcProposalEncodingError(rpcProposalEncodingOf(envelope)) });
                    }
                    if (outcome.proposal) {
                        const serverId = envelope.server?.descriptorId;
                        return codeActionReply({
                            ok: true,
                            proposalId: outcome.proposal.proposalId,
                            files: [...outcome.proposal.files],
                            diff: outcome.proposal.diff,
                            ...(serverId ? { serverDescriptorId: serverId } : {}),
                        });
                    }
                    const cls = classifyProposalStatus(envelope.status);
                    if (cls === "empty") return codeActionReply({ ok: false, error: "no edits" });
                    if (cls === "proceed") return codeActionReply({ ok: false, error: "staging-unavailable" });
                    return codeActionReply({ ok: false, error: refusalReplyText(envelope.status, "code action failed", "stale") });
                }
                // Discovery never stages: no stage dependency is supplied, so no
                // selection can be made implicitly. Freshness is structural — the
                // bound producer holds the session lease and revalidates source
                // + receipt around the query, refusing stale instead.
                let outcome: Awaited<ReturnType<typeof runBoundAction>>;
                try {
                    outcome = await runBoundAction(
                        { operation: "codeActions", path: req.filePath, range, context },
                        route,
                        { deadlineMs: Date.now() + timeoutMs, now: Date.now },
                    );
                } catch {
                    return codeActionReply({ ok: false, error: "code action failed" });
                }
                void outcome.cleanup.catch(() => undefined);
                if (outcome.kind === "refusal") {
                    return codeActionReply({ ok: false, error: refusalReplyText(outcome.status, "code action failed", "unconfirmed") });
                }
                const envelope = outcome.envelope;
                if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(envelope))) {
                    return codeActionReply({ ok: false, error: rpcProposalEncodingError(rpcProposalEncodingOf(envelope)) });
                }
                const serverId = envelope.server?.descriptorId;
                const withServer = serverId ? { serverDescriptorId: serverId } : {};
                const cls = classifyProposalStatus(envelope.status);
                if (cls === "empty") return codeActionReply({ ok: true, actions: [], ...withServer });
                if (cls !== "proceed") {
                    return codeActionReply({ ok: false, error: refusalReplyText(envelope.status, "code action failed", "unconfirmed") });
                }
                const rawItems = Array.isArray(envelope.result) ? envelope.result : [];
                const actions = [];
                for (const raw of rawItems) {
                    const item = narrowDiscoveryItem(raw);
                    if (item) actions.push(item);
                }
                return codeActionReply({ ok: true, actions, ...withServer });
            }

            throw new Error(`unknown rpc method: ${String(rpc)}`);
        },
    });

    return { dispose: () => { server.dispose(); noteLanguageIntelligenceSession(null); } };
}

function degraded(reason: "file-unreadable" | "content-mismatch" | "unconfirmed"): CheckPostEditDiagnosticsResponse {
    return { status: "degraded", reason, diagnostics: [], truncated: false };
}

function validatedOrDegraded(resp: CheckPostEditDiagnosticsResponse): CheckPostEditDiagnosticsResponse {
    const v = validateCheckPostEditDiagnosticsResponse(resp);
    if (v.ok) return resp;
    return { status: "degraded", reason: "unconfirmed", diagnostics: [], truncated: false };
}





// withBudget() removed (Wave B Round 2): the executor owns the service-work
// timeout plus $/cancelRequest on deadline. A non-cancelling race here would
// report timeout while leaving in-flight work running.
