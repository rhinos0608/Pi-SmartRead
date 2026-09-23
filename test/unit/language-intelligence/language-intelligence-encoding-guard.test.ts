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
} from "../../../src/language-intelligence/language-intelligence-provider.js";

// executor seam (provider sources proposals from executeLspOperation)
const mockExecutor = vi.fn();
vi.mock("../../../src/lsp/lsp-executor.js", () => ({
    executeLspOperation: (...args: unknown[]) => mockExecutor(...args),
}));

function execEnv(status: string, result: unknown, encoding = "utf-16") {
    return { status, operation: "rename", method: "m", server: { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: "/repo", positionEncoding: encoding }, result, meta: { truncated: false, freshness: { state: "fresh" } } };
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
function fileUri(c: string) { return "file://" + c; }
function renameResult() {
    return { changes: [{ uri: fileUri(canon), edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "y" }] }] };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "li-enc-"));
    file = join(dir, "sample.ts");
    writeFileSync(file, "const x = 1;\n");
    canon = realpathSync(file);
    mockExecutor.mockReset();
});

afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    vi.resetAllMocks();
});

async function rpcClient() {
    const bus = makeBus();
    const provider = createLanguageIntelligenceProvider(bus as never);
    const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
    return { bus, provider, client };
}

describe("rpc proposal encoding guard (fail-closed)", () => {
    it("utf-16 passes on renamePreview", async () => {
        const { provider, client } = await rpcClient();
        mockExecutor.mockResolvedValueOnce(execEnv("ok", renameResult(), "utf-16"));
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        expect((reply.payload as { ok: boolean }).ok).toBe(true);
        client.dispose();
        provider.dispose();
    });

    it("utf-8 rejected on renamePreview with unsupported-encoding", async () => {
        const { provider, client } = await rpcClient();
        mockExecutor.mockResolvedValueOnce(execEnv("ok", renameResult(), "utf-8"));
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
        mockExecutor.mockResolvedValueOnce(execEnv("ok", [], "utf-32"));
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, { filePath: canon, line: 1, character: 1, endLine: 1, endCharacter: 1 });
        expect(reply.ok).toBe(true);
        const p = reply.payload as { ok: boolean; error?: string };
        expect(p.ok).toBe(false);
        expect(p.error).toMatch(/^unsupported-encoding/);
        client.dispose();
        provider.dispose();
    });

    it("utf-8 rejected on formatting and organizeImports", async () => {
        const { provider, client } = await rpcClient();
        mockExecutor.mockResolvedValueOnce(execEnv("ok", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "const" }], "utf-8"));
        const r1 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, { filePath: canon });
        expect((r1.payload as { ok: boolean }).ok).toBe(false);
        expect((r1.payload as { error?: string }).error).toMatch(/^unsupported-encoding/);
        mockExecutor.mockResolvedValueOnce(execEnv("ok", [{ title: "Organize imports", kind: "source.organizeImports", edit: renameResult() }], "utf-8"));
        const r2 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.organizeImports, { filePath: canon });
        expect((r2.payload as { ok: boolean }).ok).toBe(false);
        expect((r2.payload as { error?: string }).error).toMatch(/^unsupported-encoding/);
        client.dispose();
        provider.dispose();
    });

    it("strict path unaffected: utf-8 envelope still reaches executor unconverted", async () => {
        // Direct strict executor path retains negotiated encoding — the guard
        // lives only in the RPC proposal layer, never in lsp-executor/lsp-tool.
        const { provider, client } = await rpcClient();
        mockExecutor.mockImplementationOnce(async (req: unknown) => {
            const r = req as { position: { line: number; character: number } };
            // 1-based RPC input forwarded as 0-based with no conversion
            expect(r.position).toEqual({ line: 0, character: 0 });
            return execEnv("ok", renameResult(), "utf-16");
        });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y" });
        expect((reply.payload as { ok: boolean }).ok).toBe(true);
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

    it("ambiguous-server envelope preserved with candidates (no generic rename failed)", async () => {
        const { provider, client } = await rpcClient();
        const msg = "ambiguous server selection: typescript and eslint both match (candidates: ts-server, eslint-server)";
        mockExecutor.mockResolvedValueOnce({
            status: "ambiguous", operation: "rename", method: "m",
            server: { descriptorId: "unknown", name: "unknown", languageId: "typescript", projectRoot: "/repo", positionEncoding: "utf-16" },
            result: null,
            meta: { truncated: false },
            error: { code: "ambiguous", message: msg },
        });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        const p = reply.payload as { ok: boolean; error?: string };
        expect(p.ok).toBe(false);
        expect(p.error).toContain("ambiguous");
        expect(p.error).toContain("ts-server");
        expect(p.error).toContain("eslint-server");
        expect(p.error).not.toBe("rename failed");
        client.dispose();
        provider.dispose();
    });
});
