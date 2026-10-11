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
import {
    createLanguageIntelligenceProvider,
    __setLanguageIntelligenceProducersForTests,
    __resetLanguageIntelligenceProducersForTests,
} from "../../../src/language-intelligence/language-intelligence-provider.js";
import type { executeBoundSemanticEdit } from "../../../src/lsp/lsp-semantic-edit-origin.js";
import type { executeBoundAction } from "../../../src/lsp/lsp-action-adapter.js";

// executor seam (provider sources post-edit diagnostics from executeLspOperation;
// proposals go through the bound producers via __setLanguageIntelligenceProducersForTests)
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

describe("language-intelligence-provider bound-producer sourcing", () => {
    let pdir: string;
    let pfile: string;
    let pcanon: string;
    let sessionFile: string;
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
    function serverInfo() {
        return { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: pdir, positionEncoding: "utf-16" as const };
    }
    function resultEnvelope(operation: "rename" | "formatDocument" | "codeActions", status: "ok" | "unsupported" | "empty", result: unknown) {
        return { status, operation, method: "m", server: serverInfo(), result, meta: { truncated: false } };
    }
    function releasedCleanup() {
        return Promise.resolve(Object.freeze({ state: "released" as const }));
    }
    // Provider with a staging identity; the injected fakes return staged
    // outcomes directly (exact stage-RPC assertions live in
    // language-intelligence-proposals.test.ts).
    function rpcHarness() {
        const bus = makeBus2();
        const stageBus = makeBus2();
        const provider = createLanguageIntelligenceProvider(bus as never, {
            getSessionFilePath: () => sessionFile,
            getCwd: () => pdir,
            getStageBus: () => stageBus as never,
        });
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        return { provider, client, dispose: () => { client.dispose(); provider.dispose(); } };
    }
    beforeEach(() => {
        pdir = mkdtempSync(join(tmpdir(), "li-exec-"));
        pfile = join(pdir, "sample.ts");
        writeFileSync(pfile, "const x = 1;\n");
        pcanon = realpathSync(pfile);
        sessionFile = join(pdir, "session.jsonl");
        mockExecutor.mockReset();
        __resetLanguageIntelligenceProducersForTests();
    });
    afterEach(() => {
        __resetLanguageIntelligenceProducersForTests();
        try { rmSync(pdir, { recursive: true, force: true }); } catch {}
        vi.resetAllMocks();
    });
    it("rename proposal sourced from bound semantic producer, 0-based coords, validated", async () => {
        const { dispose, client } = rpcHarness();
        const seen: Array<{ req: unknown; route: unknown; hasStage: boolean }> = [];
        const fakeSemantic: typeof executeBoundSemanticEdit = async (req, route, deps) => {
            seen.push({ req, route, hasStage: !!deps.stage });
            return {
                kind: "result",
                envelope: resultEnvelope("rename", "ok", null),
                proposal: { proposalId: "p-rename", files: [pcanon], diff: "@@ rename" },
                cleanup: releasedCleanup(),
            };
        };
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: pcanon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        const payload = reply.payload as { ok: boolean; proposalId?: string; files?: string[] };
        expect(payload.ok).toBe(true);
        expect(reply.payload).not.toHaveProperty("workspaceEdit");
        expect(payload.proposalId).toBe("p-rename");
        expect(payload.files).toEqual([pcanon]);
        expect(seen).toHaveLength(1);
        expect(seen[0]!.req).toMatchObject({ operation: "rename", position: { line: 0, character: 0 }, newName: "y" });
        expect(seen[0]!.route).toMatchObject({ languageId: "typescript" });
        expect(seen[0]!.hasStage).toBe(true);
        expect(readFileSync(pcanon, "utf-8")).toBe("const x = 1;\n");
        dispose();
    });
    it("bound refusal not_ready surfaces unconfirmed (stale source, no proposal)", async () => {
        const { dispose, client } = rpcHarness();
        const fakeSemantic: typeof executeBoundSemanticEdit = async () => ({
            kind: "refusal", status: "not_ready", cleanup: releasedCleanup(),
        });
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: pcanon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        expect(reply.payload).toEqual({ ok: false, error: "unconfirmed" });
        dispose();
    });

    it("bound producer throw surfaces rename failed", async () => {
        const { dispose, client } = rpcHarness();
        const fakeSemantic: typeof executeBoundSemanticEdit = async () => { throw new Error("boom"); };
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: pcanon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        expect((reply.payload as { ok: boolean }).ok).toBe(false);
        expect((reply.payload as { error?: string }).error).toBe("rename failed");
        dispose();
    });
    it("reversed codeAction range rejected as caller error before bound producer call", async () => {
        const { dispose, client } = rpcHarness();
        let calls = 0;
        const fakeAction: typeof executeBoundAction = async () => {
            calls++;
            return { kind: "refusal", status: "unavailable", cleanup: releasedCleanup() };
        };
        __setLanguageIntelligenceProducersForTests({ executeAction: fakeAction });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, { filePath: pcanon, line: 5, character: 1, endLine: 2, endCharacter: 1 });
        expect(reply.ok).toBe(false);
        expect(calls).toBe(0);
        const reply2 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, { filePath: pcanon, line: 1, character: 5, endLine: 1, endCharacter: 2 });
        expect(reply2.ok).toBe(false);
        expect(calls).toBe(0);
        dispose();
    });
    it("zero-length codeAction range passes validation and reaches bound producer", async () => {
        const { dispose, client } = rpcHarness();
        const seen: unknown[] = [];
        const fakeAction: typeof executeBoundAction = async (req) => {
            seen.push(req);
            return { kind: "result", envelope: resultEnvelope("codeActions", "empty", []), cleanup: releasedCleanup() };
        };
        __setLanguageIntelligenceProducersForTests({ executeAction: fakeAction });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, { filePath: pcanon, line: 1, character: 1, endLine: 1, endCharacter: 1 });
        expect(reply.ok).toBe(true);
        expect(reply.payload).toEqual({ ok: true, actions: [], serverDescriptorId: "ts" });
        expect(seen).toHaveLength(1);
        expect((seen[0] as { range: unknown }).range).toEqual({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
        dispose();
    });
    it("result unsupported → no-edits empty shape; refusal unavailable → no-server", async () => {
        const { dispose, client } = rpcHarness();
        let calls = 0;
        const fakeSemantic: typeof executeBoundSemanticEdit = async () => {
            calls++;
            if (calls === 1) {
                return { kind: "result", envelope: resultEnvelope("rename", "unsupported", null), cleanup: releasedCleanup() };
            }
            return { kind: "refusal", status: "unavailable", cleanup: releasedCleanup() };
        };
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const r1 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: pcanon, line: 1, character: 1, newName: "y" });
        expect(r1.payload).toEqual({ ok: false, error: "no edits" });
        const r2 = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, { filePath: pcanon });
        expect(r2.payload).toEqual({ ok: false, error: "no-server" });
        dispose();
    });
    it("formatting sourced from bound semantic producer with tabSize passthrough", async () => {
        const { dispose, client } = rpcHarness();
        const seen: unknown[] = [];
        const fakeSemantic: typeof executeBoundSemanticEdit = async (req) => {
            seen.push(req);
            return {
                kind: "result",
                envelope: resultEnvelope("formatDocument", "ok", null),
                proposal: { proposalId: "p-format", files: [pcanon], diff: "@@ format" },
                cleanup: releasedCleanup(),
            };
        };
        __setLanguageIntelligenceProducersForTests({ executeSemanticEdit: fakeSemantic });
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, { filePath: pcanon, tabSize: 4, insertSpaces: false });
        expect((reply.payload as { ok: boolean }).ok).toBe(true);
        expect((reply.payload as { proposalId?: string }).proposalId).toBe("p-format");
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ operation: "formatDocument", formatting: { tabSize: 4, insertSpaces: false } });
        dispose();
    });
});
