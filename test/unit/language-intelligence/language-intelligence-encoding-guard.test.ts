import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
    RPC_CHANNELS,
    LANGUAGE_INTELLIGENCE_RPC_METHODS,
} from "@rhinos0608/pi-workspace-protocol";
import { createRpcClient } from "@rhinos0608/pi-workspace-protocol";
import {
    createLanguageIntelligenceProvider,
    isRpcProposalEncodingSupported,
    rpcProposalEncodingError,
    __setLanguageIntelligenceProducersForTests,
    __resetLanguageIntelligenceProducersForTests,
} from "../../../src/language-intelligence/language-intelligence-provider.js";
import type { executeBoundSemanticEdit } from "../../../src/lsp/lsp-semantic-edit-origin.js";
import type { executeBoundAction } from "../../../src/lsp/lsp-action-adapter.js";

// executor seam (provider sources proposals from executeLspOperation)
const mockExecutor = vi.fn();
vi.mock("../../../src/lsp/lsp-executor.js", () => ({
    executeLspOperation: (...args: unknown[]) => mockExecutor(...args),
}));

function serverFor(encoding: "utf-16" | "utf-8" | "utf-32") {
    return { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: "/repo", positionEncoding: encoding };
}

function releasedCleanup() {
    return Promise.resolve(Object.freeze({ state: "released" as const }));
}

function makeBus() {
    const handlers = new Map<string, Array<(d: unknown) => void>>();
    return {
        emit(channel: string, data: unknown) {
            const list = handlers.get(channel) ?? [];
            for (const h of [...list]) h(data);
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

let dir: string;
let file: string;
let canon: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "li-enc-"));
    file = join(dir, "sample.ts");
    writeFileSync(file, "const x = 1;\n");
    canon = realpathSync(file);
    mockExecutor.mockReset();
    __resetLanguageIntelligenceProducersForTests();
});

afterEach(() => {
    __resetLanguageIntelligenceProducersForTests();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    vi.resetAllMocks();
});

async function rpcClient() {
    const bus = makeBus();
    // Staging identity present; the injected bound-producer fakes below
    // return staged outcomes directly (exact stage-RPC assertions live in
    // language-intelligence-proposals.test.ts).
    const provider = createLanguageIntelligenceProvider(bus as never, {
        getSessionFilePath: () => join(dir, "session.jsonl"),
        getCwd: () => dir,
        getStageBus: () => makeBus() as never,
    });
    const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
    return { bus, provider, client };
}

describe("rpc proposal encoding guard (fail-closed)", () => {
    it("utf-16 passes on renamePreview", async () => {
        const { provider, client } = await rpcClient();
        const fakeSemantic: typeof executeBoundSemanticEdit = async () => ({
            kind: "result",
            envelope: { status: "ok", operation: "rename", method: "textDocument/rename", server: serverFor("utf-16"), result: null, meta: { truncated: false } },
            proposal: { proposalId: "p-enc", files: [canon], diff: "@@ enc" },
            cleanup: releasedCleanup(),
        });
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        expect((reply.payload as { ok: boolean }).ok).toBe(true);
        client.dispose();
        provider.dispose();
    });

    it("utf-8 rejected on renamePreview with unsupported-encoding", async () => {
        const { provider, client } = await rpcClient();
        const fakeSemantic: typeof executeBoundSemanticEdit = async () => ({
            kind: "result",
            envelope: { status: "ok", operation: "rename", method: "textDocument/rename", server: serverFor("utf-8"), result: null, meta: { truncated: false } },
            cleanup: releasedCleanup(),
        });
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        const p = reply.payload as { ok: boolean; error?: string };
        expect(p.ok).toBe(false);
        expect(p.error).toMatch(/^unsupported-encoding/);
        client.dispose();
        provider.dispose();
    });

    it("utf-32 rejected on codeAction with unsupported-encoding", async () => {
        const { provider, client } = await rpcClient();
        const fakeAction: typeof executeBoundAction = async () => ({
            kind: "result",
            envelope: { status: "ok", operation: "codeActions", method: "textDocument/codeAction", server: serverFor("utf-32"), result: [], meta: { truncated: false } },
            cleanup: releasedCleanup(),
        });
        __setLanguageIntelligenceProducersForTests({ executeAction: fakeAction });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, { filePath: canon, line: 1, character: 1, endLine: 1, endCharacter: 1 });
        expect(reply.ok).toBe(true);
        const p = reply.payload as { ok: boolean; error?: string };
        expect(p.ok).toBe(false);
        expect(p.error).toMatch(/^unsupported-encoding/);
        client.dispose();
        provider.dispose();
    });

    it("utf-8 rejected on formatting", async () => {
        const { provider, client } = await rpcClient();
        const fakeSemantic: typeof executeBoundSemanticEdit = async () => ({
            kind: "result",
            envelope: { status: "ok", operation: "formatDocument", method: "textDocument/formatting", server: serverFor("utf-8"), result: null, meta: { truncated: false } },
            cleanup: releasedCleanup(),
        });
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const r1 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, { filePath: canon });
        expect((r1.payload as { ok: boolean }).ok).toBe(false);
        expect((r1.payload as { error?: string }).error).toMatch(/^unsupported-encoding/);
        client.dispose();
        provider.dispose();
    });

    it("bound producer receives 0-based coords, no conversion on the RPC layer", async () => {
        // The guard lives only in the RPC proposal layer; the bound producer
        // receives the coordinates the provider derived from the DTO.
        const { provider, client } = await rpcClient();
        const seen: unknown[] = [];
        const fakeSemantic: typeof executeBoundSemanticEdit = async (req) => {
            seen.push(req);
            return {
                kind: "result",
                envelope: { status: "ok", operation: "rename", method: "textDocument/rename", server: serverFor("utf-16"), result: null, meta: { truncated: false } },
                proposal: { proposalId: "p-coords", files: [canon], diff: "@@ coords" },
                cleanup: releasedCleanup(),
            };
        };
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y" });
        expect((reply.payload as { ok: boolean }).ok).toBe(true);
        expect(seen).toHaveLength(1);
        // 1-based RPC input forwarded as 0-based with no conversion
        expect((seen[0] as { position: unknown }).position).toEqual({ line: 0, character: 0 });
        client.dispose();
        provider.dispose();
    });

    it("classifier unit: utf-16/undefined pass, utf-8/utf-32 reject, no conversion", () => {
        expect(isRpcProposalEncodingSupported("utf-16")).toBe(true);
        expect(isRpcProposalEncodingSupported(undefined)).toBe(true);
        expect(isRpcProposalEncodingSupported("utf-8")).toBe(false);
        expect(isRpcProposalEncodingSupported("utf-32")).toBe(false);
        expect(rpcProposalEncodingError("utf-8")).toMatch(/^unsupported-encoding/);
        expect(rpcProposalEncodingError("utf-32")).toContain("utf-32");
    });

    it("non-UTF-16 diagnostics after emoji fail closed to degraded/unconfirmed", async () => {
        const { createHash } = await import("node:crypto");
        const { readFileSync, writeFileSync } = await import("node:fs");
        const { provider, client } = await rpcClient();
        // Astral char on line 0: a utf-8 server character offset differs from
        // the UTF-16 offset the RPC caller assumes, so ranges are unusable.
        writeFileSync(canon, "const smile = \"\u{1F600}\";\nconst x = 1;\n");
        const sha = createHash("sha256").update(readFileSync(canon)).digest("hex");
        mockExecutor.mockResolvedValueOnce({
            status: "ok", operation: "diagnostics", method: "m",
            server: { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: "/repo", positionEncoding: "utf-8" },
            result: [{ message: "oops", severity: 1, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 13 } }, source: "ts" }],
            meta: { truncated: false, freshness: { state: "fresh" } },
        });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, {
            canonicalPath: canon, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10,
        });
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; reason: string; diagnostics: unknown[] };
        expect(p.status).toBe("degraded");
        expect(p.reason).toBe("unconfirmed");
        expect(p.diagnostics).toEqual([]);
        client.dispose();
        provider.dispose();
    });

    // D-81: bound producers use exact lease-bound routing and never emit
    // ambiguous envelopes, so there is no ambiguous passthrough to test.
});
