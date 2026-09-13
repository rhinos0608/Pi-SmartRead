import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

import {
    RPC_CHANNELS,
    LANGUAGE_INTELLIGENCE_RPC_METHODS,
} from "@rhinos0608/pi-workspace-protocol";
import { createRpcClient } from "@rhinos0608/pi-workspace-protocol";
import { createLanguageIntelligenceProvider } from "../../src/language-intelligence-provider.js";

// mock lsp-bridge
const mockGetFresh = vi.fn();
vi.mock("../../src/lsp-bridge.js", () => ({
    getLSPBridge: vi.fn(),
}));

import { getLSPBridge } from "../../src/lsp-bridge.js";

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
let canonical: string;
let sha: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "li-prov-"));
    file = join(dir, "sample.ts");
    writeFileSync(file, "const x = 1;\n");
    canonical = realpathSync(file);
    sha = createHash("sha256").update(readFileSync(file)).digest("hex");
    vi.mocked(getLSPBridge).mockReset();
    mockGetFresh.mockReset();
});

afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    vi.resetAllMocks();
});

function bridgeWith(outcome: unknown) {
    mockGetFresh.mockResolvedValue(outcome);
    vi.mocked(getLSPBridge).mockResolvedValue({ getFreshDiagnosticsOutcome: mockGetFresh } as unknown as ReturnType<typeof getLSPBridge> extends Promise<infer T> ? T : never);
}

describe("language-intelligence-provider", () => {
    it("capabilities response never touches LSP bridge", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });

        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities, {});
        expect(reply.ok).toBe(true);
        expect(reply.payload).toEqual({ provider: "pi-smartread", capabilities: ["post-edit-diagnostics"] });
        expect(getLSPBridge).not.toHaveBeenCalled();

        client.dispose();
        provider.dispose();
    });

    it("happy path confirmed with diagnostics", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });

        bridgeWith({
            status: "confirmed",
            diagnostics: [
                { message: "oops", severity: 1, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, source: "ts" },
            ],
        });

        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; diagnostics: unknown[]; truncated: boolean };
        expect(p.status).toBe("confirmed");
        expect(p.diagnostics.length).toBe(1);
        expect(mockGetFresh).toHaveBeenCalledTimes(1);

        client.dispose();
        provider.dispose();
    });

    it("empty maps to empty not confirmed", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        bridgeWith({ status: "empty", diagnostics: [] });

        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        expect((reply.payload as { status: string }).status).toBe("empty");

        client.dispose();
        provider.dispose();
    });

    it("unavailable maps to unavailable/no-server", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        bridgeWith({ status: "unavailable", diagnostics: [] });

        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; reason: string };
        expect(p.status).toBe("unavailable");
        expect(p.reason).toBe("no-server");

        client.dispose();
        provider.dispose();
    });

    it("SHA mismatch before LSP returns degraded/content-mismatch without calling LSP", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        bridgeWith({ status: "confirmed", diagnostics: [{ message: "x", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: "ts" }] });

        const badSha = "a".repeat(64);
        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: badSha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; reason: string };
        expect(p.status).toBe("degraded");
        expect(p.reason).toBe("content-mismatch");
        expect(getLSPBridge).not.toHaveBeenCalled();
        expect(mockGetFresh).not.toHaveBeenCalled();

        client.dispose();
        provider.dispose();
    });

    it("SHA mismatch after LSP also degraded/content-mismatch", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });

        // First call captures pre-hash, then we mutate file before post-hash check: mock readFileSync? Easier: make getFreshDiagnostics mutate file
        bridgeWith({
            status: "confirmed",
            diagnostics: [{ message: "x", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: "ts" }],
        });
        mockGetFresh.mockImplementation(async () => {
            writeFileSync(canonical, "changed content\n");
            return { status: "confirmed", diagnostics: [{ message: "x", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: "ts" }] };
        });

        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; reason: string };
        expect(p.status).toBe("degraded");
        expect(p.reason).toBe("content-mismatch");

        client.dispose();
        provider.dispose();
        // restore file for cleanup
        try { writeFileSync(canonical, "const x = 1;\n"); } catch {}
    });

    it("malformed request rejected", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });

        // missing canonicalPath
        const req = { canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 } as unknown as Record<string, unknown>;
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(false);

        client.dispose();
        provider.dispose();
    });

    it("truncates at maxDiagnostics with truncated:true", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });

        const diags = Array.from({ length: 5 }, (_, i) => ({
            message: `msg ${i}`,
            severity: 1,
            range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } },
            source: "ts",
        }));
        bridgeWith({ status: "confirmed", diagnostics: diags });

        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 2 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; diagnostics: unknown[]; truncated: boolean };
        expect(p.status).toBe("confirmed");
        expect(p.diagnostics.length).toBe(2);
        expect(p.truncated).toBe(true);

        client.dispose();
        provider.dispose();
    });

    it("cross-root path still processed (no containment)", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });

        // create file outside workspace root
        const outsideDir = mkdtempSync(join(tmpdir(), "li-outside-"));
        const outsideFile = join(outsideDir, "out.ts");
        writeFileSync(outsideFile, "let y=2;\n");
        const outCanon = realpathSync(outsideFile);
        const outSha = createHash("sha256").update(readFileSync(outsideFile)).digest("hex");

        bridgeWith({ status: "empty", diagnostics: [] });

        const req = { canonicalPath: outCanon, canonicalWorkspaceRoot: dir, expectedContentSha256: outSha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        expect((reply.payload as { status: string }).status).toBe("empty");
        expect(mockGetFresh).toHaveBeenCalledWith(outCanon, dir, expect.anything());

        client.dispose();
        provider.dispose();
        rmSync(outsideDir, { recursive: true, force: true });
    });

    it("confirmed with all dropped diagnostics due to negative range becomes empty", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        bridgeWith({
            status: "confirmed",
            diagnostics: [
                { message: "bad", severity: 1, range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } }, source: "ts" },
            ],
        });
        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        expect((reply.payload as { status: string }).status).toBe("empty");
        client.dispose();
        provider.dispose();
    });

    it("normalizes missing severity to 3 and missing source to lsp, truncates long fields", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        const longMsg = "x".repeat(20000);
        const longSrc = "y".repeat(500);
        bridgeWith({
            status: "confirmed",
            diagnostics: [
                { message: longMsg, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: longSrc } as unknown as Record<string, unknown>,
            ],
        });
        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; diagnostics: Array<{ message: string; severity: number; source: string }> };
        expect(p.status).toBe("confirmed");
        expect(p.diagnostics[0]!.severity).toBe(3);
        expect(p.diagnostics[0]!.message.length).toBe(16384);
        expect(p.diagnostics[0]!.source.length).toBe(256);
        client.dispose();
        provider.dispose();
    });

    it("missing source defaults to lsp", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        bridgeWith({
            status: "confirmed",
            diagnostics: [
                { message: "no source", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } as unknown as Record<string, unknown>,
            ],
        });
        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; diagnostics: Array<{ source: string }> };
        expect(p.status).toBe("confirmed");
        expect(p.diagnostics[0]!.source).toBe("lsp");
        client.dispose();
        provider.dispose();
    });

    it("invalid severity defaults to 3", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        bridgeWith({
            status: "confirmed",
            diagnostics: [
                { message: "bad sev", severity: 99, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: "ts" } as unknown as Record<string, unknown>,
                { message: "no sev", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, source: "ts" } as unknown as Record<string, unknown>,
                { message: "str sev", severity: "high", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } }, source: "ts" } as unknown as Record<string, unknown>,
            ],
        });
        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; diagnostics: Array<{ severity: number }> };
        expect(p.status).toBe("confirmed");
        expect(p.diagnostics.every((d) => d.severity === 3)).toBe(true);
        client.dispose();
        provider.dispose();
    });

    it("ambiguous degraded status maps to degraded/unconfirmed", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        bridgeWith({ status: "degraded", diagnostics: [] });
        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; reason: string; diagnostics: unknown[]; truncated: boolean };
        expect(p.status).toBe("degraded");
        expect(p.reason).toBe("unconfirmed");
        expect(p.diagnostics).toEqual([]);
        expect(p.truncated).toBe(false);
        // also test another unknown status
        bridgeWith({ status: "stale", diagnostics: [] } as unknown as Record<string, unknown>);
        const reply2 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply2.ok).toBe(true);
        expect((reply2.payload as { status: string; reason: string }).status).toBe("degraded");
        expect((reply2.payload as { status: string; reason: string }).reason).toBe("unconfirmed");
        client.dispose();
        provider.dispose();
    });

    it("file-unreadable when file does not exist", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        bridgeWith({ status: "empty", diagnostics: [] });
        const req = { canonicalPath: "/no/such/file.ts", canonicalWorkspaceRoot: dir, expectedContentSha256: "a".repeat(64), waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { reason: string };
        expect(p.reason).toBe("file-unreadable");
        client.dispose();
        provider.dispose();
    });
});
