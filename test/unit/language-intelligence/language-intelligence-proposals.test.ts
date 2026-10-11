import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
    RPC_CHANNELS,
    LANGUAGE_INTELLIGENCE_RPC_METHODS,
    PROTOCOL_SCHEMA_VERSION,
    createRpcClient,
    createRpcServer,
    validateStageWorkspaceEditRequest,
    validateEventMessage,
    validateRenamePreviewResponse,
    validateFormattingResponse,
    validateCodeActionResponse,
} from "@rhinos0608/pi-workspace-protocol";
import {
    createLanguageIntelligenceProvider,
    noteLanguageIntelligenceSession,
    __setLanguageIntelligenceProducersForTests,
    __resetLanguageIntelligenceProducersForTests,
} from "../../../src/language-intelligence/language-intelligence-provider.js";
import type { executeBoundSemanticEdit } from "../../../src/lsp/lsp-semantic-edit-origin.js";
import type { executeBoundAction } from "../../../src/lsp/lsp-action-adapter.js";

// D-81: language-intelligence RPCs never return raw edits. rename_preview /
// formatting stage through the bound semantic producer; code_action discovery
// narrows to five fields and selection resolves through the bound action path.

function makeBus() {
    const handlers = new Map<string, Array<(d: unknown) => void>>();
    return {
        emit(channel: string, data: unknown) {
            for (const h of [...(handlers.get(channel) ?? [])]) h(data);
        },
        on(channel: string, handler: (d: unknown) => void) {
            let list = handlers.get(channel);
            if (!list) { list = []; handlers.set(channel, list); }
            list.push(handler);
            return () => {
                const l = handlers.get(channel);
                if (!l) return;
                const idx = l.indexOf(handler);
                if (idx !== -1) l.splice(idx, 1);
            };
        },
    };
}

const SERVER = {
    descriptorId: "ts-test",
    name: "ts-test-server",
    languageId: "typescript",
    projectRoot: "/repo",
    positionEncoding: "utf-16",
} as const;

const releasedCleanup = () => Promise.resolve(Object.freeze({ state: "released" as const }));

function okEnvelope(operation: "rename" | "formatDocument" | "codeActions" | "resolveCodeAction", result: unknown) {
    return {
        status: "ok" as const,
        operation,
        method: "test-method",
        server: { ...SERVER },
        result,
        meta: { truncated: false },
    };
}

let dir: string;
let canon: string;
let fileSha: string;
let sessionFile: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "li-proposals-"));
    writeFileSync(join(dir, "sample.ts"), "const x = 1;\n");
    canon = realpathSync(join(dir, "sample.ts"));
    fileSha = createHash("sha256").update(readFileSync(canon)).digest("hex");
    sessionFile = join(dir, "session.jsonl");
});

afterEach(() => {
    __resetLanguageIntelligenceProducersForTests();
    noteLanguageIntelligenceSession(null);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

interface Harness {
    liBus: ReturnType<typeof makeBus>;
    client: ReturnType<typeof createRpcClient>;
    provider: { dispose(): void };
    stageServer: { dispose(): void };
    stageCalls: unknown[];
    dispose: () => void;
}

function harness(stageReply: unknown): Harness {
    const liBus = makeBus();
    const editBus = makeBus();
    const stageCalls: unknown[] = [];
    const stageServer = createRpcServer({
        bus: editBus as never,
        channel: RPC_CHANNELS.workspaceEdit,
        handler: async (req) => {
            stageCalls.push(req.payload);
            const v = validateStageWorkspaceEditRequest(req.payload);
            if (!v.ok) throw new Error(v.error);
            return stageReply;
        },
    });
    const provider = createLanguageIntelligenceProvider(liBus as never, {
        getSessionFilePath: () => sessionFile,
        getCwd: () => dir,
        getStageBus: () => editBus as never,
    });
    const client = createRpcClient({ bus: liBus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 5000 });
    return {
        liBus, client, provider, stageServer, stageCalls,
        dispose: () => { client.dispose(); provider.dispose(); stageServer.dispose(); },
    };
}

const STAGED = { ok: true, proposalId: "proposal-1", files: [] as string[], diff: "@@ fake diff" };

describe("D-81 rename_preview stages a proposal (never raw edits)", () => {
    it("returns proposalId/files/diff, stages exactly once with the source-document precondition", async () => {
        const h = harness({ ...STAGED, files: [canon] });
        try {
            const producerCalls: Array<{ req: unknown; route: unknown }> = [];
            const fakeSemantic: typeof executeBoundSemanticEdit = async (req, route, deps) => {
                producerCalls.push({ req, route });
                const packet = {
                    prepared: {
                        positionEncoding: "utf-16" as const,
                        fileEdits: [{
                            filePath: canon,
                            edits: [{ filePath: canon, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "y" }],
                        }],
                    },
                    document: { canonicalPath: canon, sha256: fileSha },
                    serverDescriptor: { ...SERVER },
                    operation: "rename" as const,
                    deadlineMs: deps.deadlineMs,
                    now: Date.now,
                    ownedSignal: new AbortController().signal,
                };
                const staged = await deps.stage!(packet);
                if (staged.kind !== "staged") {
                    return { kind: "result", envelope: okEnvelope("rename", null), cleanup: releasedCleanup() };
                }
                return { kind: "result", envelope: okEnvelope("rename", null), proposal: staged.proposal, cleanup: releasedCleanup() };
            };
            __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });

            const reply = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
                filePath: canon, line: 1, character: 1, newName: "y",
            });
            expect(reply.ok).toBe(true);
            const payload = reply.payload as Record<string, unknown>;
            expect(payload.ok).toBe(true);
            expect(payload).not.toHaveProperty("workspaceEdit");
            expect(payload.proposalId).toBe("proposal-1");
            expect(payload.files).toEqual([canon]);
            expect(typeof payload.diff).toBe("string");
            expect(validateRenamePreviewResponse(payload).ok).toBe(true);

            // Exactly one semantic request with 0-based coords and explicit route.
            expect(producerCalls).toHaveLength(1);
            expect(producerCalls[0]!.req).toMatchObject({
                operation: "rename",
                position: { line: 0, character: 0 },
                newName: "y",
            });
            expect(producerCalls[0]!.route).toMatchObject({ languageId: "typescript" });

            // Exactly one stage call carrying the source-document precondition.
            expect(h.stageCalls).toHaveLength(1);
            const stage = h.stageCalls[0] as Record<string, unknown>;
            const source = (stage.source as Record<string, Record<string, string>>);
            expect(source.document).toEqual({ canonicalPath: canon, sha256: fileSha });
            expect(stage.sessionFilePath).toBe(sessionFile);
            expect(stage.cwd).toBe(dir);

            // Zero disk writes: the source file is untouched.
            expect(readFileSync(canon, "utf-8")).toBe("const x = 1;\n");
        } finally {
            h.dispose();
        }
    });

    it("staging refusal surfaces ok:false without a proposal", async () => {
        const h = harness({ ok: false, reason: "stale" });
        try {
            const fakeSemantic: typeof executeBoundSemanticEdit = async (_req, _route, deps) => {
                const packet = {
                    prepared: { positionEncoding: "utf-16" as const, fileEdits: [] },
                    document: { canonicalPath: canon, sha256: fileSha },
                    serverDescriptor: { ...SERVER },
                    operation: "rename" as const,
                    deadlineMs: deps.deadlineMs,
                    now: Date.now,
                    ownedSignal: new AbortController().signal,
                };
                const staged = await deps.stage!(packet);
                expect(staged.kind).toBe("refused");
                return { kind: "result", envelope: okEnvelope("rename", null), cleanup: releasedCleanup() };
            };
            __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });

            const reply = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
                filePath: canon, line: 1, character: 1, newName: "y",
            });
            expect(reply.ok).toBe(true);
            const payload = reply.payload as Record<string, unknown>;
            expect(payload.ok).toBe(false);
            expect(payload).not.toHaveProperty("proposalId");
            expect(validateRenamePreviewResponse(payload).ok).toBe(true);
            expect(h.stageCalls).toHaveLength(1);
        } finally {
            h.dispose();
        }
    });

    it("missing session identity refuses before touching the producer", async () => {
        const liBus = makeBus();
        const provider = createLanguageIntelligenceProvider(liBus as never, {
            getSessionFilePath: () => null,
            getCwd: () => dir,
            getStageBus: () => makeBus() as never,
        });
        const client = createRpcClient({ bus: liBus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 5000 });
        try {
            let producerCalled = false;
            const fakeSemantic: typeof executeBoundSemanticEdit = async () => {
                producerCalled = true;
                return { kind: "refusal", status: "unavailable", cleanup: releasedCleanup() };
            };
            __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });

            const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
                filePath: canon, line: 1, character: 1, newName: "y",
            });
            expect(reply.ok).toBe(true);
            expect((reply.payload as { ok: boolean }).ok).toBe(false);
            expect(producerCalled).toBe(false);
            expect(validateRenamePreviewResponse(reply.payload).ok).toBe(true);
        } finally {
            client.dispose();
            provider.dispose();
        }
    });
});

describe("D-81 formatting stages a proposal (never raw edits)", () => {
    it("returns proposalId/files/diff with tabSize passthrough and no workspaceEdit", async () => {
        const h = harness({ ...STAGED, files: [canon] });
        try {
            const seen: unknown[] = [];
            const fakeSemantic: typeof executeBoundSemanticEdit = async (req, _route, deps) => {
                seen.push(req);
                const packet = {
                    prepared: {
                        positionEncoding: "utf-16" as const,
                        fileEdits: [{
                            filePath: canon,
                            edits: [{ filePath: canon, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "const" }],
                        }],
                    },
                    document: { canonicalPath: canon, sha256: fileSha },
                    serverDescriptor: { ...SERVER },
                    operation: "formatDocument" as const,
                    deadlineMs: deps.deadlineMs,
                    now: Date.now,
                    ownedSignal: new AbortController().signal,
                };
                const staged = await deps.stage!(packet);
                if (staged.kind !== "staged") {
                    return { kind: "result", envelope: okEnvelope("formatDocument", null), cleanup: releasedCleanup() };
                }
                return { kind: "result", envelope: okEnvelope("formatDocument", null), proposal: staged.proposal, cleanup: releasedCleanup() };
            };
            __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });

            const reply = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, {
                filePath: canon, tabSize: 4, insertSpaces: false,
            });
            expect(reply.ok).toBe(true);
            const payload = reply.payload as Record<string, unknown>;
            expect(payload.ok).toBe(true);
            expect(payload).not.toHaveProperty("workspaceEdit");
            expect(payload.proposalId).toBe("proposal-1");
            expect(validateFormattingResponse(payload).ok).toBe(true);
            expect(seen).toHaveLength(1);
            expect(seen[0]).toMatchObject({
                operation: "formatDocument",
                formatting: { tabSize: 4, insertSpaces: false },
            });
            expect(h.stageCalls).toHaveLength(1);
            expect(readFileSync(canon, "utf-8")).toBe("const x = 1;\n");
        } finally {
            h.dispose();
        }
    });
});

describe("D-81 code_action discovery narrows to five fields", () => {
    it("candidates carry only title/kind/isPreferred/actionId/sourceSha256 (no edit/data)", async () => {
        const h = harness({ ...STAGED, files: [canon] });
        try {
            const actionId = "a".repeat(64);
            const rawItems = [
                {
                    title: "Fix it",
                    kind: "quickfix",
                    isPreferred: true,
                    edit: { changes: [{ uri: "file://" + canon, edits: [] }] },
                    data: { secret: "must-not-leak" },
                    command: { title: "Fix it", command: "do.it" },
                    actionId,
                    sourceSha256: fileSha,
                },
                { title: "Plain", actionId: "b".repeat(64), sourceSha256: fileSha },
            ];
            const seen: unknown[] = [];
            const fakeAction: typeof executeBoundAction = async (req, _route, _deps) => {
                seen.push(req);
                return { kind: "result", envelope: okEnvelope("codeActions", rawItems), cleanup: releasedCleanup() };
            };
            __setLanguageIntelligenceProducersForTests({ executeAction: fakeAction });

            const reply = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, {
                filePath: canon, line: 1, character: 1,
            });
            expect(reply.ok).toBe(true);
            const payload = reply.payload as { ok: boolean; actions: Array<Record<string, unknown>> };
            expect(payload.ok).toBe(true);
            expect(payload.actions).toHaveLength(2);
            const allowed = new Set(["title", "kind", "isPreferred", "actionId", "sourceSha256"]);
            for (const item of payload.actions) {
                for (const key of Object.keys(item)) expect(allowed.has(key)).toBe(true);
                expect(typeof item.title).toBe("string");
                expect(item.actionId).toMatch(/^[0-9a-f]{64}$/);
                expect(item.sourceSha256).toBe(fileSha);
            }
            expect(payload.actions[0]).toEqual({
                title: "Fix it", kind: "quickfix", isPreferred: true, actionId, sourceSha256: fileSha,
            });
            expect(payload.actions[1]).toEqual({
                title: "Plain", actionId: "b".repeat(64), sourceSha256: fileSha,
            });
            expect(JSON.stringify(payload)).not.toContain("must-not-leak");
            expect(validateCodeActionResponse(payload).ok).toBe(true);
            // Discovery never stages.
            expect(h.stageCalls).toHaveLength(0);
            expect(seen).toHaveLength(1);
            expect(seen[0]).toMatchObject({ operation: "codeActions" });
        } finally {
            h.dispose();
        }
    });
});

describe("D-81 code_action selection resolves to a staged proposal", () => {
    it("stale sourceSha256 refuses without staging", async () => {
        const h = harness({ ...STAGED, files: [canon] });
        try {
            const seen: unknown[] = [];
            const fakeAction: typeof executeBoundAction = async (req, _route, _deps) => {
                seen.push(req);
                return { kind: "refusal", status: "not_ready", cleanup: releasedCleanup() };
            };
            __setLanguageIntelligenceProducersForTests({ executeAction: fakeAction });

            const selection = { actionId: "a".repeat(64), sourceSha256: "0".repeat(64) };
            const reply = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, {
                filePath: canon, line: 1, character: 1, selection,
            });
            expect(reply.ok).toBe(true);
            const payload = reply.payload as Record<string, unknown>;
            expect(payload.ok).toBe(false);
            expect(payload).not.toHaveProperty("proposalId");
            expect(validateCodeActionResponse(payload).ok).toBe(true);
            // The selection reached the bound path verbatim; nothing staged.
            expect(seen).toHaveLength(1);
            expect((seen[0] as { selection: unknown }).selection).toEqual(selection);
            expect(h.stageCalls).toHaveLength(0);
        } finally {
            h.dispose();
        }
    });

    it("matching selection stages exactly once with the source precondition", async () => {
        const h = harness({ ...STAGED, files: [canon] });
        try {
            const actionId = "c".repeat(64);
            const fakeAction: typeof executeBoundAction = async (req, _route, deps) => {
                expect(req.operation).toBe("resolveCodeAction");
                const packet = {
                    prepared: {
                        positionEncoding: "utf-16" as const,
                        fileEdits: [{
                            filePath: canon,
                            edits: [{ filePath: canon, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "X" }],
                        }],
                    },
                    document: { canonicalPath: canon, sha256: fileSha },
                    serverDescriptor: { ...SERVER },
                    operation: "resolveCodeAction" as const,
                    deadlineMs: deps.deadlineMs,
                    now: Date.now,
                    ownedSignal: new AbortController().signal,
                };
                const staged = await deps.stage!(packet);
                if (staged.kind !== "staged") {
                    return { kind: "result", envelope: okEnvelope("resolveCodeAction", null), cleanup: releasedCleanup() };
                }
                return { kind: "result", envelope: okEnvelope("resolveCodeAction", null), proposal: staged.proposal, cleanup: releasedCleanup() };
            };
            __setLanguageIntelligenceProducersForTests({ executeAction: fakeAction });

            const reply = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, {
                filePath: canon, line: 1, character: 1,
                selection: { actionId, sourceSha256: fileSha },
            });
            expect(reply.ok).toBe(true);
            const payload = reply.payload as Record<string, unknown>;
            expect(payload.ok).toBe(true);
            expect(payload.proposalId).toBe("proposal-1");
            expect(payload).not.toHaveProperty("actions");
            expect(payload).not.toHaveProperty("workspaceEdit");
            expect(validateCodeActionResponse(payload).ok).toBe(true);
            expect(h.stageCalls).toHaveLength(1);
            const stage = h.stageCalls[0] as { source: { operation: string; document: unknown } };
            expect(stage.source.operation).toBe("resolveCodeAction");
            expect(stage.source.document).toEqual({ canonicalPath: canon, sha256: fileSha });
        } finally {
            h.dispose();
        }
    });
});

describe("D-81 organize_imports is gone", () => {
    it("provider does not register it and the protocol rejects it", async () => {
        const h = harness({ ...STAGED, files: [canon] });
        try {
            expect((LANGUAGE_INTELLIGENCE_RPC_METHODS as Record<string, unknown>).organizeImports).toBeUndefined();
            // The server drops the unknown method: no proposal ever comes back.
            const shortClient = createRpcClient({ bus: h.liBus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 300 });
            try {
                await expect(shortClient.request("organize_imports" as never, { filePath: canon })).rejects.toThrow();
            } finally {
                shortClient.dispose();
            }
            const rejected = validateEventMessage({
                schemaVersion: PROTOCOL_SCHEMA_VERSION,
                kind: "request",
                requestId: "r1",
                rpc: "organize_imports",
                payload: { filePath: canon },
            });
            expect(rejected.ok).toBe(false);
        } finally {
            h.dispose();
        }
    });
});
