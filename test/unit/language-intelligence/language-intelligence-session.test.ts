import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
    RPC_CHANNELS,
    LANGUAGE_INTELLIGENCE_RPC_METHODS,
    createRpcClient,
    createRpcServer,
    validateStageWorkspaceEditRequest,
    validateRenamePreviewResponse,
} from "@rhinos0608/pi-workspace-protocol";
import {
    createLanguageIntelligenceProvider,
    noteLanguageIntelligenceSession,
    noteLanguageIntelligenceSessionFromContext,
    __setLanguageIntelligenceProducersForTests,
    __resetLanguageIntelligenceProducersForTests,
} from "../../../src/language-intelligence/language-intelligence-provider.js";
import type { executeBoundSemanticEdit } from "../../../src/lsp/lsp-semantic-edit-origin.js";

// D-81 review notes: the module-captured staging identity must fail closed.
// A missing/nullish session context clears it (never reuses a prior
// session), and provider.dispose() resets it (a recreated provider cannot
// stage under the prior session).

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

let dir: string;
let canon: string;
let fileSha: string;
let sessionFile: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "li-session-"));
    writeFileSync(join(dir, "sample.ts"), "const x = 1;\n");
    canon = realpathSync(join(dir, "sample.ts"));
    fileSha = createHash("sha256").update(readFileSync(canon)).digest("hex");
    void fileSha;
    sessionFile = join(dir, "session.jsonl");
});

afterEach(() => {
    __resetLanguageIntelligenceProducersForTests();
    noteLanguageIntelligenceSession(null);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

// No per-instance session options: the provider falls back to the
// module-captured session identity (or its absence).
function capturedIdentityHarness(stageReply: unknown) {
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
        getStageBus: () => editBus as never,
    });
    const client = createRpcClient({ bus: liBus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 5000 });
    return {
        client, provider, stageServer, stageCalls,
        dispose: () => { client.dispose(); provider.dispose(); stageServer.dispose(); },
    };
}

function noteTestSession(): void {
    noteLanguageIntelligenceSessionFromContext({
        cwd: dir,
        sessionManager: { getSessionFile: () => sessionFile },
    });
}

function stagedRenameFake(onCall: () => void): typeof executeBoundSemanticEdit {
    return (async () => {
        onCall();
        return {
            kind: "result",
            envelope: {
                status: "ok" as const,
                operation: "rename" as const,
                method: "textDocument/rename",
                server: { ...SERVER },
                result: null,
                meta: { truncated: false },
            },
            proposal: { proposalId: "proposal-1", files: [canon], diff: "@@ fake diff" },
            cleanup: releasedCleanup(),
        };
    }) as typeof executeBoundSemanticEdit;
}

const STAGED_REPLY = { ok: true, proposalId: "proposal-1", files: [] as string[], diff: "@@ fake diff" };

describe("session-identity lifecycle fails closed", () => {
    it("nullish session context clears the captured identity (no prior-session reuse)", async () => {
        noteTestSession();
        const h = capturedIdentityHarness({ ...STAGED_REPLY, files: [canon] });
        try {
            let producerCalls = 0;
            __setLanguageIntelligenceProducersForTests({
                executeSemanticEdit: stagedRenameFake(() => { producerCalls++; }),
            });

            // Sanity: the captured identity stages.
            const first = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
                filePath: canon, line: 1, character: 1, newName: "y",
            });
            expect((first.payload as { ok: boolean }).ok).toBe(true);
            expect(producerCalls).toBe(1);

            // A missing/nullish context must clear the identity — never throw
            // out of the capture hook, never leave the prior session behind.
            expect(() => noteLanguageIntelligenceSessionFromContext(null as never)).not.toThrow();
            expect(() => noteLanguageIntelligenceSessionFromContext(undefined as never)).not.toThrow();

            const second = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
                filePath: canon, line: 1, character: 1, newName: "y",
            });
            expect(second.payload).toEqual({ ok: false, error: "staging-unavailable" });
            expect(producerCalls).toBe(1);
            expect(validateRenamePreviewResponse(second.payload).ok).toBe(true);
        } finally {
            h.dispose();
        }
    });

    it("provider dispose resets the captured identity (recreated provider cannot reuse it)", async () => {
        noteTestSession();
        const stale = capturedIdentityHarness({ ...STAGED_REPLY, files: [canon] });
        stale.dispose();

        const h = capturedIdentityHarness({ ...STAGED_REPLY, files: [canon] });
        try {
            let producerCalls = 0;
            __setLanguageIntelligenceProducersForTests({
                executeSemanticEdit: stagedRenameFake(() => { producerCalls++; }),
            });

            const reply = await h.client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, {
                filePath: canon, line: 1, character: 1, newName: "y",
            });
            expect(reply.payload).toEqual({ ok: false, error: "staging-unavailable" });
            expect(producerCalls).toBe(0);
            expect(validateRenamePreviewResponse(reply.payload).ok).toBe(true);
        } finally {
            h.dispose();
        }
    });
});
