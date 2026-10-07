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
import { createLanguageIntelligenceProvider } from "../../../src/language-intelligence/language-intelligence-provider.js";

// executor seam (provider sources proposals/diagnostics from executeLspOperation)
const mockExecutor = vi.fn();
vi.mock("../../../src/lsp/lsp-executor.js", () => ({
    executeLspOperation: (...args: unknown[]) => mockExecutor(...args),
}));

function execEnv(status: string, result: unknown, freshness: string = "fresh") {
    return { status, operation: "diagnostics", method: "m", server: { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: "/repo", positionEncoding: "utf-16" }, result, meta: { truncated: false, freshness: { state: freshness } } };
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
let canonical: string;
let sha: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "li-prov-"));
    file = join(dir, "sample.ts");
    writeFileSync(file, "const x = 1;\n");
    canonical = realpathSync(file);
    sha = createHash("sha256").update(readFileSync(file)).digest("hex");
    mockExecutor.mockReset();
});

afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    vi.resetAllMocks();
});

function diagResult(diagnostics: unknown[]) {
    return diagnostics;
}
function bridgeWith(outcome: { status: string; diagnostics: unknown[] }) {
    // Map legacy bridge outcome shapes onto executor envelopes.
    if (outcome.status === "confirmed") mockExecutor.mockResolvedValue(execEnv("ok", diagResult(outcome.diagnostics)));
    else if (outcome.status === "empty") mockExecutor.mockResolvedValue(execEnv("empty", []));
    else if (outcome.status === "unavailable") mockExecutor.mockResolvedValue(execEnv("unavailable", null));
    else mockExecutor.mockResolvedValue(execEnv("error", null));
}

describe("language-intelligence-provider", () => {
    it("capabilities response never touches LSP bridge", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });

        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.capabilities, {});
        expect(reply.ok).toBe(true);
        expect(reply.payload).toEqual({ provider: "pi-smartread", capabilities: ["post-edit-diagnostics"] });
        expect(mockExecutor).not.toHaveBeenCalled();

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
        expect(mockExecutor).toHaveBeenCalledTimes(1);

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

    it("executor ok with unknown freshness degrades to unconfirmed (false-clean regression)", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockResolvedValueOnce(execEnv("ok", [{ message: "x", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: "ts" }], "unknown"));

        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; reason: string };
        expect(p.status).toBe("degraded");
        expect(p.reason).toBe("unconfirmed");

        client.dispose();
        provider.dispose();
    });

    it("executor empty with unknown freshness degrades to unconfirmed", async () => {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as any);
        const client = createRpcClient({ bus: bus as any, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockResolvedValueOnce(execEnv("empty", [], "unknown"));

        const req = { canonicalPath: canonical, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 };
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, req);
        expect(reply.ok).toBe(true);
        const p = reply.payload as { status: string; reason: string };
        expect(p.status).toBe("degraded");
        expect(p.reason).toBe("unconfirmed");

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
        expect(mockExecutor).not.toHaveBeenCalled();
        expect(mockExecutor).not.toHaveBeenCalled();

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
        mockExecutor.mockImplementation(async () => {
            writeFileSync(canonical, "changed content\n");
            return execEnv("ok", [{ message: "x", severity: 1, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, source: "ts" }]);
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
        expect(mockExecutor).toHaveBeenCalledTimes(1);
        expect((mockExecutor.mock.calls[0]![0] as { operation: string }).operation).toBe("diagnostics");

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
        bridgeWith({ status: "stale", diagnostics: [] });
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

describe("language-intelligence-provider executor sourcing", () => {
    let pdir: string;
    let pfile: string;
    let pcanon: string;
    let _psha = "";
    function makeBus2() {
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
    beforeEach(() => {
        pdir = mkdtempSync(join(tmpdir(), "li-exec-"));
        pfile = join(pdir, "sample.ts");
        writeFileSync(pfile, "const x = 1;\n");
        pcanon = realpathSync(pfile);
        _psha = createHash("sha256").update(readFileSync(pfile)).digest("hex");
        void _psha;
        mockExecutor.mockReset();
    });
    afterEach(() => {
        try { rmSync(pdir, { recursive: true, force: true }); } catch {}
        vi.resetAllMocks();
    });
    function fileUri(canon: string) {
        return "file://" + canon;
    }
    it("rename proposal sourced from executor rename op, 0-based coords, validation passes", async () => {
        const bus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockImplementationOnce(async (req: unknown) => {
            const r = req as { operation: string; position: { line: number; character: number } };
            expect(r.operation).toBe("rename");
            expect(r.position).toEqual({ line: 0, character: 0 });
            return execEnv("ok", { changes: [{ uri: fileUri(pcanon), edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "y" }] }] });
        });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: pcanon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        const payload = reply.payload as { ok: boolean; workspaceEdit?: { fileEdits: Array<{ filePath: string }> } };
        expect(payload.ok).toBe(true);
        expect(payload.workspaceEdit!.fileEdits[0]!.filePath).toBe(pcanon);
        expect(readFileSync(pcanon, "utf-8")).toBe("const x = 1;\n");
        client.dispose();
        provider.dispose();
    });
    it("stale proposal envelope is rejected before returning a WorkspaceEdit", async () => {
        const bus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockResolvedValueOnce(execEnv("ok", {
            changes: [{ uri: fileUri(pcanon), edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "y" }] }],
        }, "stale"));
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: pcanon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        expect(reply.payload).toEqual({ ok: false, error: "unconfirmed" });
        client.dispose();
        provider.dispose();
    });

    it("malformed executor proposal still rejected by validation", async () => {
        const bus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockResolvedValueOnce(execEnv("ok", { changes: [{ uri: fileUri(pcanon), edits: [{ range: { start: { line: 5, character: 0 }, end: { line: 1, character: 0 } }, newText: "y" }] }] }));
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: pcanon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        expect((reply.payload as { ok: boolean }).ok).toBe(false);
        client.dispose();
        provider.dispose();
    });
    it("reversed codeAction range rejected as caller error before executor call", async () => {
        const bus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, { filePath: pcanon, line: 5, character: 1, endLine: 2, endCharacter: 1 });
        expect(reply.ok).toBe(false);
        expect(mockExecutor).not.toHaveBeenCalled();
        const reply2 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, { filePath: pcanon, line: 1, character: 5, endLine: 1, endCharacter: 2 });
        expect(reply2.ok).toBe(false);
        expect(mockExecutor).not.toHaveBeenCalled();
        client.dispose();
        provider.dispose();
    });
    it("zero-length codeAction range passes validation and reaches executor", async () => {
        const bus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockResolvedValueOnce(execEnv("ok", []));
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, { filePath: pcanon, line: 1, character: 1, endLine: 1, endCharacter: 1 });
        expect(reply.ok).toBe(true);
        expect(mockExecutor).toHaveBeenCalledTimes(1);
        client.dispose();
        provider.dispose();
    });
    it("executor unsupported → no-edits empty shape; unavailable → no-server", async () => {
        const bus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockResolvedValueOnce(execEnv("unsupported", null));
        const r1 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: pcanon, line: 1, character: 1, newName: "y" });
        expect(r1.payload).toEqual({ ok: false, error: "no edits" });
        mockExecutor.mockResolvedValueOnce(execEnv("unavailable", null));
        const r2 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, { filePath: pcanon });
        expect(r2.payload).toEqual({ ok: false, error: "no-server" });
        client.dispose();
        provider.dispose();
    });
    it("formatting sourced from executor formatDocument op with tabSize passthrough", async () => {
        const bus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockImplementationOnce(async (req: unknown) => {
            const r = req as { operation: string; formatting: { tabSize: number; insertSpaces: boolean } };
            expect(r.operation).toBe("formatDocument");
            expect(r.formatting).toEqual({ tabSize: 4, insertSpaces: false });
            return execEnv("ok", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "const" }]);
        });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, { filePath: pcanon, tabSize: 4, insertSpaces: false });
        expect((reply.payload as { ok: boolean }).ok).toBe(true);
        client.dispose();
        provider.dispose();
    });
    it("organizeImports sourced from executor codeActions op filtered to source.organizeImports", async () => {
        const bus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        mockExecutor.mockImplementationOnce(async (req: unknown) => {
            const r = req as { operation: string; context: { only: string[] }; range: { start: { line: number; character: number }; end: { line: number; character: number } } };
            expect(r.operation).toBe("codeActions");
            expect(r.context).toEqual({ only: ["source.organizeImports"] });
            expect(r.range).toEqual({ start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER, character: 0 } });
            return execEnv("ok", [{ title: "Organize imports", kind: "source.organizeImports", edit: { changes: [{ uri: fileUri(pcanon), edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "const" }] }] } }]);
        });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.organizeImports, { filePath: pcanon });
        expect((reply.payload as { ok: boolean }).ok).toBe(true);
        client.dispose();
        provider.dispose();
    });
});
