import { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
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
    validateOrganizeImportsRequest,
    validateFormattingRequest,
    validateCodeActionRequest,
    type CheckPostEditDiagnosticsResponse,
    type LanguageDiagnostic,
} from "@rhinos0608/pi-workspace-protocol";
import { createRpcServer, type BusLike, type RequestEvent } from "@rhinos0608/pi-workspace-protocol";
import type { StrictEnvelope, StrictRequest } from "../lsp/lsp-strict-contract.js";
import { resolveLanguageServer, detectProjectRoot } from "./language-intelligence-runtime.js";
import { validateWorkspaceEdit } from "../workspace/workspace-edit-validator.js";
import type { RenamePreviewResponse, LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";

export interface LanguageIntelligenceProviderBus extends BusLike {}

type ExecutorFn = (req: unknown, deps?: Record<string, unknown>) => Promise<StrictEnvelope>;

// Test seam: unit tests inject a fake executor; production dynamically
// imports the canonical executor. All proposal/diagnostic sourcing below
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

function envelopeIsFresh(e: { meta?: { freshness?: { state?: string } } }): boolean {
    return e.meta?.freshness?.state === "fresh";
}

/**
 * RPC proposal-path encoding guard (fail-closed).
 *
 * RPC edit DTOs carry no encoding and the SmartEdit planner assumes UTF-16
 * coordinates, so proposal paths (rename/format/organizeImports/codeAction)
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

/** Ambiguous-server envelope passthrough: preserve candidates/message so the
 * caller can disambiguate. No DTO selector field (out of scope) — the
 * candidates ride in the free-form error string. */
function envelopeAmbiguityMessage(env: StrictEnvelope): string {
    const raw = (env.error as { message?: unknown } | undefined)?.message;
    const detail = typeof raw === "string" && raw.length > 0 ? raw : "ambiguous server selection";
    return detail.startsWith("ambiguous") ? detail : `ambiguous: ${detail}`;
}

/** Executor normalized WorkspaceEdit ({changes:[{uri,edits}]}) → validator input ({fileEdits:[{filePath,edits}]}). URIs resolved to absolute paths; returns null when nothing actionable. */
function normalizedTextEditsToFileEdits(
    result: unknown,
    filePath: string,
): { fileEdits: Array<{ filePath: string; edits: unknown[] }> } | null {
    if (!Array.isArray(result) || result.length === 0) return null;
    return { fileEdits: [{ filePath, edits: result }] };
}

function normalizedEditToFileEdits(result: unknown): { fileEdits: Array<{ filePath: string; edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }> }> } | null {
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const changes = (result as Record<string, unknown>).changes;
    if (!Array.isArray(changes) || changes.length === 0) return null;
    const fileEdits: Array<{ filePath: string; edits: unknown }> = [];
    for (const c of changes) {
        if (!c || typeof c !== "object") return null;
        const uri = (c as Record<string, unknown>).uri;
        const edits = (c as Record<string, unknown>).edits;
        if (typeof uri !== "string" || uri.length === 0 || !Array.isArray(edits)) return null;
        let filePath: string;
        try {
            filePath = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
        } catch {
            return null;
        }
        fileEdits.push({ filePath, edits });
    }
    if (fileEdits.length === 0) return null;
    return { fileEdits } as { fileEdits: Array<{ filePath: string; edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }> }> };
}

export function createLanguageIntelligenceProvider(bus: LanguageIntelligenceProviderBus): { dispose(): void } {
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
                const resolution = resolveLanguageServer(req.filePath, process.cwd());
                const workspaceRoot = resolution.status === "available" ? resolution.root : detectProjectRoot(req.filePath, process.cwd());
                const line0 = (req.line ?? 1) - 1;
                const char0 = (req.character ?? 1) - 1;
                if (line0 < 0 || char0 < 0) {
                    const resp: RenamePreviewResponse = { ok: false, error: "position-out-of-range" };
                    return resp;
                }
                let rawEdit: LspWorkspaceEdit | null = null;
                try {
                    // Sourced from executeLspOperation (rename op, 0-based protocol coords). Zero disk writes.
                    const timeoutMs = clampLanguageIntelligenceTimeout(req.timeoutMs, PROPOSAL_TIMEOUT_MS);
                    const env = await runExecutor({ operation: "rename", path: req.filePath, position: { line: line0, character: char0 }, newName: req.newName, workspace: workspaceRoot, timeoutMs } as unknown as StrictRequest, { cwd: workspaceRoot });
                    if (env.status === "unavailable") {
                        const resp: RenamePreviewResponse = { ok: false, error: "no-server" };
                        return resp;
                    }
                    if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(env))) {
                        const resp: RenamePreviewResponse = { ok: false, error: rpcProposalEncodingError(rpcProposalEncodingOf(env)) };
                        return resp;
                    }
                    if (env.status === "ambiguous") {
                        const resp: RenamePreviewResponse = { ok: false, error: envelopeAmbiguityMessage(env) };
                        return resp;
                    }
                    if (env.status === "unsupported" || env.status === "empty" || env.result == null) {
                        const resp: RenamePreviewResponse = { ok: false, error: "no edits" };
                        return resp;
                    }
                    if (env.status !== "ok") {
                        const resp: RenamePreviewResponse = { ok: false, error: "rename failed" };
                        return resp;
                    }
                    if (!envelopeIsFresh(env)) {
                        const resp: RenamePreviewResponse = { ok: false, error: "unconfirmed" };
                        return resp;
                    }
                    rawEdit = normalizedEditToFileEdits(env.result) as unknown as LspWorkspaceEdit | null;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    const resp: RenamePreviewResponse = { ok: false, error: msg.includes("timed out") ? "timeout" : "rename failed" };
                    return resp;
                }
                if (!rawEdit) {
                    const resp: RenamePreviewResponse = { ok: false, error: "no edits" };
                    return resp;
                }
                const validated = validateWorkspaceEdit(rawEdit);
                if (!validated.ok) {
                    const resp: RenamePreviewResponse = { ok: false, error: validated.errors[0]?.message ?? "validation failed" };
                    return resp;
                }
                const resp: RenamePreviewResponse = { ok: true, workspaceEdit: { positionEncoding: RPC_PROPOSAL_POSITION_ENCODING, ...validated.value } as unknown as LspWorkspaceEdit };
                return resp;
            }

            if (rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.organizeImports) {
                const v = validateOrganizeImportsRequest(payload);
                if (!v.ok) throw new Error(v.error);
                const req = v.value;
                const resolution = resolveLanguageServer(req.filePath, process.cwd());
                const workspaceRoot = resolution.status === "available" ? resolution.root : detectProjectRoot(req.filePath, process.cwd());
                let rawEdit: LspWorkspaceEdit | null = null;
                try {
                    // organizeImports has no dedicated executor op: sourced from the
                    // codeActions op filtered to source.organizeImports (same wire
                    // shape the connection uses), first edit wins. Zero disk writes.
                    const timeoutMs = clampLanguageIntelligenceTimeout(req.timeoutMs, PROPOSAL_TIMEOUT_MS);
                    const env = await runExecutor({ operation: "codeActions", path: req.filePath, range: { start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER, character: 0 } }, context: { only: ["source.organizeImports"] }, workspace: workspaceRoot, timeoutMs } as unknown as StrictRequest, { cwd: workspaceRoot });
                    if (env.status === "unavailable") return { ok: false, error: "no-server" };
                    if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(env))) return { ok: false, error: rpcProposalEncodingError(rpcProposalEncodingOf(env)) };
                    if (env.status === "ambiguous") return { ok: false, error: envelopeAmbiguityMessage(env) };
                    if (env.status === "unsupported" || env.status === "empty" || env.result == null) return { ok: false, error: "no edits" };
                    if (env.status !== "ok") return { ok: false, error: "organize imports failed" };
                    if (!envelopeIsFresh(env)) return { ok: false, error: "unconfirmed" };
                    const actions = Array.isArray(env.result) ? env.result as Array<{ edit?: unknown }> : [];
                    const firstEdit = actions.find((a) => a && typeof a === "object" && (a as Record<string, unknown>).edit)?.edit ?? null;
                    rawEdit = normalizedEditToFileEdits(firstEdit) as unknown as LspWorkspaceEdit | null;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return { ok: false, error: msg.includes("timed out") ? "timeout" : "organize imports failed" };
                }
                if (!rawEdit) return { ok: false, error: "no edits" };
                const validated = validateWorkspaceEdit(rawEdit);
                if (!validated.ok) return { ok: false, error: validated.errors[0]?.message ?? "validation failed" };
                return { ok: true, workspaceEdit: { positionEncoding: RPC_PROPOSAL_POSITION_ENCODING, ...validated.value } as unknown as LspWorkspaceEdit };
            }

            if (rpc === LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting) {
                const v = validateFormattingRequest(payload);
                if (!v.ok) throw new Error(v.error);
                const req = v.value;
                const resolution = resolveLanguageServer(req.filePath, process.cwd());
                const workspaceRoot = resolution.status === "available" ? resolution.root : detectProjectRoot(req.filePath, process.cwd());
                let rawEdit: LspWorkspaceEdit | null = null;
                try {
                    // Sourced from executeLspOperation (formatDocument op). Zero disk writes.
                    const timeoutMs = clampLanguageIntelligenceTimeout(req.timeoutMs, PROPOSAL_TIMEOUT_MS);
                    const env = await runExecutor({ operation: "formatDocument", path: req.filePath, formatting: { tabSize: req.tabSize ?? 2, insertSpaces: req.insertSpaces ?? true }, workspace: workspaceRoot, timeoutMs } as unknown as StrictRequest, { cwd: workspaceRoot });
                    if (env.status === "unavailable") return { ok: false, error: "no-server" };
                    if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(env))) return { ok: false, error: rpcProposalEncodingError(rpcProposalEncodingOf(env)) };
                    if (env.status === "ambiguous") return { ok: false, error: envelopeAmbiguityMessage(env) };
                    if (env.status === "unsupported" || env.status === "empty" || env.result == null) return { ok: false, error: "no edits" };
                    if (env.status !== "ok") return { ok: false, error: "formatting failed" };
                    if (!envelopeIsFresh(env)) return { ok: false, error: "unconfirmed" };
                    rawEdit = normalizedTextEditsToFileEdits(env.result, req.filePath) as unknown as LspWorkspaceEdit | null;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return { ok: false, error: msg.includes("timed out") ? "timeout" : "formatting failed" };
                }
                if (!rawEdit) return { ok: false, error: "no edits" };
                const validated = validateWorkspaceEdit(rawEdit);
                if (!validated.ok) return { ok: false, error: validated.errors[0]?.message ?? "validation failed" };
                return { ok: true, workspaceEdit: { positionEncoding: RPC_PROPOSAL_POSITION_ENCODING, ...validated.value } as unknown as LspWorkspaceEdit };
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
                const resolution = resolveLanguageServer(req.filePath, process.cwd());
                const workspaceRoot = resolution.status === "available" ? resolution.root : detectProjectRoot(req.filePath, process.cwd());
                const line0 = Math.max(0, req.line - 1);
                const char0 = Math.max(0, req.character - 1);
                const endLine0 = req.endLine !== undefined ? Math.max(0, req.endLine - 1) : line0;
                const endChar0 = req.endCharacter !== undefined ? Math.max(0, req.endCharacter - 1) : char0;
                const range = { start: { line: line0, character: char0 }, end: { line: endLine0, character: endChar0 } };
                const context: { diagnostics?: unknown[]; only?: string[] } = {};
                if (req.diagnostics !== undefined) context.diagnostics = req.diagnostics as unknown as unknown[];
                if (req.only !== undefined) context.only = req.only as unknown as string[];
                // Sourced from executeLspOperation (codeActions op, 0-based protocol coords). Zero disk writes.
                let actionsRaw: Array<{ title: string; kind?: string; edit?: unknown; isPreferred?: boolean }> = [];
                try {
                    const timeoutMs = clampLanguageIntelligenceTimeout(req.timeoutMs, PROPOSAL_TIMEOUT_MS);
                    const env = await runExecutor({ operation: "codeActions", path: req.filePath, range, context, workspace: workspaceRoot, timeoutMs } as unknown as StrictRequest, { cwd: workspaceRoot });
                    if (env.status === "unavailable") return { ok: false, error: "no-server" };
                    if (!isRpcProposalEncodingSupported(rpcProposalEncodingOf(env))) return { ok: false, error: rpcProposalEncodingError(rpcProposalEncodingOf(env)) };
                    if (env.status === "ambiguous") return { ok: false, error: envelopeAmbiguityMessage(env) };
                    if (env.status === "unsupported" || env.status === "empty" || env.result == null) return { ok: true, actions: [] };
                    if (env.status !== "ok") return { ok: false, error: "code action failed" };
                    if (!envelopeIsFresh(env)) return { ok: false, error: "unconfirmed" };
                    actionsRaw = (Array.isArray(env.result) ? env.result : []) as typeof actionsRaw;
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    return { ok: false, error: msg.includes("timed out") ? "timeout" : "code action failed" };
                }
                if (!actionsRaw || actionsRaw.length === 0) return { ok: true, actions: [] };
                const actions: Array<{ title: string; kind?: string; workspaceEdit?: LspWorkspaceEdit; isPreferred?: boolean }> = [];
                for (const a of actionsRaw) {
                    let workspaceEdit: LspWorkspaceEdit | undefined;
                    if (a.edit) {
                        // Executor edits are normalized ({changes:[{uri,edits}]});
                        // convert to validator input ({fileEdits}) before validation.
                        const converted = normalizedEditToFileEdits(a.edit);
                        if (!converted) continue;
                        const vEdit = validateWorkspaceEdit(converted);
                        if (vEdit.ok) workspaceEdit = { positionEncoding: RPC_PROPOSAL_POSITION_ENCODING, ...vEdit.value } as unknown as LspWorkspaceEdit;
                        else continue;
                    }
                    actions.push({ title: a.title, kind: a.kind, workspaceEdit, isPreferred: a.isPreferred });
                }
                return { ok: true, actions };
            }

            throw new Error(`unknown rpc method: ${String(rpc)}`);
        },
    });

    return { dispose: () => server.dispose() };
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
