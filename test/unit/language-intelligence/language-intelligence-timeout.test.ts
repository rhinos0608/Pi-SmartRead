import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
    RPC_CHANNELS,
    LANGUAGE_INTELLIGENCE_RPC_METHODS,
} from "@rhinos0608/pi-workspace-protocol";
import { createRpcClient, type RpcMethod } from "@rhinos0608/pi-workspace-protocol";
import {
    createLanguageIntelligenceProvider,
    clampLanguageIntelligenceTimeout,
    LANGUAGE_INTELLIGENCE_TIMEOUT_MIN,
    LANGUAGE_INTELLIGENCE_TIMEOUT_DEFAULT,
    LANGUAGE_INTELLIGENCE_TIMEOUT_MAX,
    POST_EDIT_DIAGNOSTICS_TIMEOUT_MS,
    PROPOSAL_TIMEOUT_MS,
    __setLanguageIntelligenceExecutorForTests,
    __resetLanguageIntelligenceExecutorForTests,
} from "../../../src/language-intelligence/language-intelligence-provider.js";
import { executeLspOperation } from "../../../src/lsp/lsp-executor.js";

// Wave B Round 2: timeout threading (clamp 250..30000, per-branch defaults,
// exact provider→executor propagation) + positionEncoding:"utf-16" on proposals.

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

function execEnv(status: string, result: unknown) {
    return {
        status,
        operation: "diagnostics",
        method: "m",
        server: { descriptorId: "ts", name: "ts", languageId: "typescript", projectRoot: "/repo", positionEncoding: "utf-16" },
        result,
        meta: { truncated: false, freshness: { state: "fresh" } },
    };
}

describe("clampLanguageIntelligenceTimeout", () => {
    it("defaults when missing", () => {
        expect(clampLanguageIntelligenceTimeout(undefined)).toBe(LANGUAGE_INTELLIGENCE_TIMEOUT_DEFAULT);
        expect(clampLanguageIntelligenceTimeout(undefined)).toBe(10_000);
    });
    it("clamps below min to 250", () => {
        expect(clampLanguageIntelligenceTimeout(0)).toBe(250);
        expect(clampLanguageIntelligenceTimeout(100)).toBe(250);
        expect(clampLanguageIntelligenceTimeout(LANGUAGE_INTELLIGENCE_TIMEOUT_MIN)).toBe(250);
    });
    it("clamps huge to 30000", () => {
        expect(clampLanguageIntelligenceTimeout(999_999)).toBe(30_000);
        expect(clampLanguageIntelligenceTimeout(Number.MAX_SAFE_INTEGER)).toBe(LANGUAGE_INTELLIGENCE_TIMEOUT_MAX);
    });
    it("passes valid values through exactly", () => {
        expect(clampLanguageIntelligenceTimeout(5000)).toBe(5000);
        expect(clampLanguageIntelligenceTimeout(250)).toBe(250);
        expect(clampLanguageIntelligenceTimeout(30_000)).toBe(30_000);
    });
    it("falls back on non-integer / non-number", () => {
        expect(clampLanguageIntelligenceTimeout(1.5)).toBe(LANGUAGE_INTELLIGENCE_TIMEOUT_DEFAULT);
        expect(clampLanguageIntelligenceTimeout("5000")).toBe(LANGUAGE_INTELLIGENCE_TIMEOUT_DEFAULT);
        expect(clampLanguageIntelligenceTimeout(NaN)).toBe(LANGUAGE_INTELLIGENCE_TIMEOUT_DEFAULT);
        expect(clampLanguageIntelligenceTimeout(null, 4000)).toBe(4000);
    });
    it("honors explicit fallback (diagnostics 4s budget)", () => {
        expect(POST_EDIT_DIAGNOSTICS_TIMEOUT_MS).toBe(4_000);
        expect(PROPOSAL_TIMEOUT_MS).toBe(10_000);
        expect(clampLanguageIntelligenceTimeout(undefined, POST_EDIT_DIAGNOSTICS_TIMEOUT_MS)).toBe(4_000);
    });
});

describe("provider→executor timeout propagation", () => {
    let dir: string;
    let file: string;
    let canon: string;
    let sha: string;
    let seen: unknown[];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "li-timeout-"));
        file = join(dir, "sample.ts");
        writeFileSync(file, "const x = 1;\n");
        canon = realpathSync(file);
        sha = createHash("sha256").update(readFileSync(file)).digest("hex");
        seen = [];
        __setLanguageIntelligenceExecutorForTests(async (req: unknown) => {
            seen.push(req);
            const op = (req as { operation: string }).operation;
            if (op === "diagnostics") {
                return execEnv("empty", []) as never;
            }
            if (op === "rename") {
                return execEnv("ok", {
                    changes: [{ uri: "file://" + canon, edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "y" }] }],
                }) as never;
            }
            if (op === "formatDocument") {
                return execEnv("ok", [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "const" }]) as never;
            }
            return execEnv("ok", []) as never;
        });
    });

    afterEach(() => {
        __resetLanguageIntelligenceExecutorForTests();
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
        vi.resetAllMocks();
    });

    async function rpc() {
        const bus = makeBus();
        const provider = createLanguageIntelligenceProvider(bus as never);
        const client = createRpcClient({ bus: bus as never, channel: RPC_CHANNELS.languageIntelligence, timeoutMs: 2000 });
        return { provider, client, dispose: () => { client.dispose(); provider.dispose(); } };
    }

    it("rename defaults to 10s and threads exact value", async () => {
        const { client, dispose } = await rpc();
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        expect(seen).toHaveLength(1);
        expect((seen[0] as { timeoutMs: number }).timeoutMs).toBe(10_000);
        dispose();
    });

    it("rename explicit 5000 propagates exactly", async () => {
        const { client, dispose } = await rpc();
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y", timeoutMs: 5000 });
        expect(reply.ok).toBe(true);
        expect((seen[0] as { timeoutMs: number }).timeoutMs).toBe(5000);
        dispose();
    });

    it("diagnostics defaults to 4s service budget", async () => {
        const { client, dispose } = await rpc();
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, {
            canonicalPath: canon, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10,
        });
        expect(reply.ok).toBe(true);
        expect(seen).toHaveLength(1);
        expect((seen[0] as { timeoutMs: number }).timeoutMs).toBe(4_000);
        dispose();
    });

    it("diagnostics explicit timeoutMs passes through clamped", async () => {
        const { client, dispose } = await rpc();
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, {
            canonicalPath: canon, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10, timeoutMs: 2000,
        });
        expect(reply.ok).toBe(true);
        expect((seen[0] as { timeoutMs: number }).timeoutMs).toBe(2000);
        dispose();
    });

    it("formatting defaults to 10s", async () => {
        const { client, dispose } = await rpc();
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, { filePath: canon });
        expect(reply.ok).toBe(true);
        expect((seen[0] as { timeoutMs: number }).timeoutMs).toBe(10_000);
        dispose();
    });

    it("invalid timeoutMs rejected before executor on every method (protocol envelope)", async () => {
        const { client, dispose } = await rpc();
        const cases: Array<{ method: RpcMethod; payload: Record<string, unknown> }> = [
            { method: LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, payload: { filePath: canon, line: 1, character: 1, newName: "y" } },
            { method: LANGUAGE_INTELLIGENCE_RPC_METHODS.organizeImports, payload: { filePath: canon } },
            { method: LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, payload: { filePath: canon } },
            { method: LANGUAGE_INTELLIGENCE_RPC_METHODS.codeAction, payload: { filePath: canon, line: 1, character: 1 } },
            { method: LANGUAGE_INTELLIGENCE_RPC_METHODS.checkPostEditDiagnostics, payload: { canonicalPath: canon, canonicalWorkspaceRoot: dir, expectedContentSha256: sha, waitMs: 10, maxDiagnostics: 10 } },
        ];
        for (const { method, payload } of cases) {
            for (const bad of [100, 1.5, 99_999_999, "5000"]) {
                const reply = await client.request(method, { ...payload, timeoutMs: bad });
                expect(reply.ok).toBe(false);
            }
        }
        expect(seen).toHaveLength(0);
        dispose();
    });

    it("rename proposal emits positionEncoding utf-16 (protocol v0.6 wire)", async () => {
        const { client, dispose } = await rpc();
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.renamePreview, { filePath: canon, line: 1, character: 1, newName: "y" });
        expect(reply.ok).toBe(true);
        const payload = reply.payload as { ok: boolean; workspaceEdit?: { positionEncoding?: string; fileEdits?: unknown[] } };
        expect(payload.ok).toBe(true);
        // Required by protocol validateLspWorkspaceEdit (v0.6): must be 'utf-16'.
        expect(payload.workspaceEdit?.positionEncoding).toBe("utf-16");
        expect(Array.isArray(payload.workspaceEdit?.fileEdits)).toBe(true);
        dispose();
    });

    it("formatting proposal emits positionEncoding utf-16", async () => {
        const { client, dispose } = await rpc();
        const reply = await client.request(LANGUAGE_INTELLIGENCE_RPC_METHODS.formatting, { filePath: canon });
        expect(reply.ok).toBe(true);
        expect((reply.payload as { workspaceEdit?: { positionEncoding?: string } }).workspaceEdit?.positionEncoding).toBe("utf-16");
        dispose();
    });
});

describe("strict direct lsp({timeoutMs}) no regression", () => {
    it("executeLspOperation honors explicit timeoutMs", async () => {
        let gotParams: unknown = null;
        const conn = {
            descriptorId: "ts",
            name: "ts-server",
            languageId: "typescript",
            languageIds: ["typescript"],
            projectRoot: "/repo",
            getNegotiatedEncoding: () => "utf-16",
            prepareDocument: async () => {},
            request: async (_m: string, p: unknown) => { gotParams = p; return null; },
            getCapabilityRegistry: () => ({ can: () => true }),
        };
        const env = await executeLspOperation(
            { operation: "hover", path: "a.ts", position: { line: 0, character: 0 }, timeoutMs: 5000 },
            { acquire: async () => ({ conn: conn as never, key: null }), cwd: "/repo" },
        );
        expect(env.status).toBe("empty");
        expect(gotParams).not.toBeNull();
    });

    it("executeLspOperation works without timeoutMs (default path)", async () => {
        const conn = {
            descriptorId: "ts",
            name: "ts-server",
            languageId: "typescript",
            languageIds: ["typescript"],
            projectRoot: "/repo",
            getNegotiatedEncoding: () => "utf-16",
            prepareDocument: async () => {},
            request: async () => null,
            getCapabilityRegistry: () => ({ can: () => true }),
        };
        const env = await executeLspOperation(
            { operation: "hover", path: "a.ts", position: { line: 0, character: 0 } },
            { acquire: async () => ({ conn: conn as never, key: null }), cwd: "/repo" },
        );
        expect(env.status).toBe("empty");
    });
});
