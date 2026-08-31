import { realpathSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
    RPC_CHANNELS,
    LANGUAGE_INTELLIGENCE_RPC_METHODS,
    validateLanguageIntelligenceCapabilitiesRequest,
    validateCheckPostEditDiagnosticsRequest,
    validateCheckPostEditDiagnosticsResponse,
    type CheckPostEditDiagnosticsResponse,
    type LanguageDiagnostic,
} from "@rhinos0608/pi-workspace-protocol";
import { createRpcServer, type BusLike, type RequestEvent } from "@rhinos0608/pi-workspace-protocol";
import { getLSPBridge } from "./lsp-bridge.js";
import { validateWorkspaceEdit } from "./workspace-edit-validator.js";
import type { RenamePreviewRequest, RenamePreviewResponse, LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";

export interface LanguageIntelligenceProviderBus extends BusLike {}

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

                // c. LSP call
                const bridge = await getLSPBridge();
                let outcome: { status: string; diagnostics: Array<{ message?: unknown; severity?: unknown; source?: unknown; range?: unknown }> };
                if (!bridge || typeof (bridge as unknown as { getFreshDiagnosticsOutcome?: unknown }).getFreshDiagnosticsOutcome !== "function") {
                    // No bridge at all -> unavailable
                    const resp: CheckPostEditDiagnosticsResponse = { status: "unavailable", reason: "no-server", diagnostics: [], truncated: false };
                    return validatedOrDegraded(resp);
                }
                try {
                    outcome = await (bridge as unknown as { getFreshDiagnosticsOutcome: (p: string, r: string, o: unknown) => Promise<{ status: string; diagnostics: unknown[] }> }).getFreshDiagnosticsOutcome(
                        request.canonicalPath,
                        request.canonicalWorkspaceRoot,
                        { waitMs: request.waitMs },
                    ) as typeof outcome;
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
                const bridge = await getLSPBridge();
                if (!bridge || typeof (bridge as unknown as { rename?: unknown }).rename !== "function") {
                    const resp: RenamePreviewResponse = { ok: false, error: "no-server" };
                    return resp;
                }
                const workspaceRoot = req.filePath.includes("/") ? req.filePath.slice(0, req.filePath.lastIndexOf("/")) || "/" : "/";
                let rawEdit: LspWorkspaceEdit | null = null;
                try {
                    rawEdit = await withBudget(
                        (bridge as unknown as { rename: (f: string, l: number, c: number, n: string, r: string) => Promise<LspWorkspaceEdit | null> }).rename(req.filePath, req.line, req.character, req.newName, workspaceRoot),
                        10_000,
                    );
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
                const resp: RenamePreviewResponse = { ok: true, workspaceEdit: validated.value as unknown as LspWorkspaceEdit };
                return resp;
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

function validateRenamePreviewRequest(v: unknown): { ok: true; value: RenamePreviewRequest } | { ok: false; error: string } {
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "RenamePreviewRequest must be object" };
    const o = v as Record<string, unknown>;
    const { filePath, line, character, newName } = o;
    if (typeof filePath !== "string" || filePath.length === 0) return { ok: false, error: "RenamePreviewRequest.filePath must be non-empty string" };
    if (filePath.includes("\0")) return { ok: false, error: "RenamePreviewRequest.filePath must not contain NUL" };
    if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return { ok: false, error: "RenamePreviewRequest.line must be integer >=1" };
    if (typeof character !== "number" || !Number.isInteger(character) || character < 1) return { ok: false, error: "RenamePreviewRequest.character must be integer >=1" };
    if (typeof newName !== "string" || newName.length === 0) return { ok: false, error: "RenamePreviewRequest.newName must be non-empty string" };
    if (newName.length > 256) return { ok: false, error: "RenamePreviewRequest.newName must be <=256 chars" };
    return { ok: true, value: v as RenamePreviewRequest };
}

function withBudget<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
        promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}
