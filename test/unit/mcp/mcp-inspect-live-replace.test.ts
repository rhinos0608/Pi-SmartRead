import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../../src/tool-registry.js";

function makeBus() {
    const subs = new Map<string, Set<(d: unknown) => void>>();
    return {
        emit(ch: string, d: unknown) { for (const h of subs.get(ch) ?? []) h(d); },
        on(ch: string, h: (d: unknown) => void) {
            if (!subs.has(ch)) subs.set(ch, new Set());
            subs.get(ch)!.add(h);
            return () => subs.get(ch)!.delete(h);
        },
    };
}

let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-live-")));
    writeFileSync(join(workdir, "hello.ts"), "export const hello = 'world';\n", "utf8");
});

afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function ctx() {
    return { cwd: workdir, sessionManager: { getSessionFile: () => "/sessions/live.jsonl" } } as any;
}

describe("mcp-registry live inspect replaces eager fallback", () => {
    it("fallback present pre-bus; registerInspectToolWithBus replaces and routes to live wiring", async () => {
        const mcp = await import("../../../src/mcp-registry.js");
        const reg = ToolRegistry.getInstance();
        expect(reg.has("inspect")).toBe(true);
        const fallbackExecute = reg.get("inspect")!.execute;

        const bus: any = makeBus();
        mcp.registerInspectToolWithBus(bus);

        const live = reg.get("inspect")!;
        expect(live.execute).not.toBe(fallbackExecute);

        const resolver = mcp.getSharedEvidenceResolver(bus);
        const spy = vi.spyOn(resolver, "publishInspection");
        const result = await live.execute("t-live", { path: "hello.ts" } as any, undefined, undefined, ctx());
        expect((result as any).details?.workspaceEvidence).toBeDefined();
        expect(spy).toHaveBeenCalled();
    });

    it("installInspectAndResolver replaces fallback and routes to live wiring", async () => {
        // Isolate modules so the eager fallback registration is restored:
        // the earlier test already replaced the shared singleton's entry.
        vi.resetModules();
        const { ToolRegistry: FreshRegistry } = await import("../../../src/tool-registry.js");
        const mcp = await import("../../../src/mcp-registry.js");
        const reg = FreshRegistry.getInstance();
        expect(reg.has("inspect")).toBe(true);
        const before = reg.get("inspect")!.execute;

        const bus: any = makeBus();
        const dispose = await mcp.installInspectAndResolver(bus);
        try {
            const live = reg.get("inspect")!;
            expect(live.execute).not.toBe(before);

            const resolver = mcp.getSharedEvidenceResolver(bus);
            const spy = vi.spyOn(resolver, "publishInspection");
            const result = await live.execute("t-live2", { path: "hello.ts" } as any, undefined, undefined, ctx());
            expect((result as any).details?.workspaceEvidence).toBeDefined();
            expect(spy).toHaveBeenCalled();
        } finally {
            dispose();
        }
    });
});
