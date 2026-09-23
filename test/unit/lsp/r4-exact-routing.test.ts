import { describe, it, expect, vi, afterEach } from "vitest";
import { sessionStore } from "../../../src/lsp/lsp-manager.js";
import { canonicalProjectRoot } from "../../../src/lsp/lsp-session-key.js";
import { executeLspOperation, type ExecutorConnection } from "../../../src/lsp/lsp-executor.js";

const ROOT = "/repo";

function conn(over: Partial<ExecutorConnection> & { requestImpl?: (m: string, p: unknown) => Promise<unknown> } = {}): ExecutorConnection {
  const { requestImpl, ...rest } = over;
  const languageId = (rest as { languageId?: string }).languageId ?? "typescript";
  const languageIds = (rest as { languageIds?: string[] }).languageIds ?? [languageId];
  return {
    descriptorId: "ts",
    name: "ts-server",
    languageId,
    languageIds,
    projectRoot: "/repo",
    getNegotiatedEncoding: () => "utf-16",
    prepareDocument: async () => {},
    request: (m, p) => (requestImpl ? requestImpl(m, p) : Promise.resolve(null)),
    ...rest,
  };
}

const testSessionKeys: string[] = [];
function liveSession(descriptorId: string, c: ExecutorConnection): string {
  const key = `test::${descriptorId}::${testSessionKeys.length}`;
  sessionStore.set(key, { conn: c as never, fingerprint: "test", descriptorId, root: canonicalProjectRoot(ROOT), leases: 0, lastUsed: Date.now() });
  testSessionKeys.push(key);
  return key;
}
afterEach(() => {
  for (const k of testSessionKeys.splice(0)) sessionStore.delete(k);
});

describe("R4 exact routing", () => {
  it("pathful two-server selects exactly B never attempts A", async () => {
    const attempted: string[] = [];
    const connB = conn({ descriptorId: "py-linter", name: "linter", requestImpl: async () => ({ contents: "x" }) });
    const acquire = vi.fn(async (_root: string, _lang: string | null, opts: Record<string, unknown>) => {
      attempted.push((opts?.descriptorId as string | undefined) ?? "?");
      expect(opts?.descriptorId).toBe("py-linter");
      return { conn: connB, key: "k-b" };
    });
    const env = await executeLspOperation(
      { operation: "hover", path: "a.py", position: { line: 0, character: 0 }, server: "py-linter" },
      { getManager: () => ({ getServer: vi.fn(async () => { throw new Error("must not spawn"); }) }), acquire, cwd: ROOT },
    );
    expect(env.status).toBe("ok");
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(attempted).toEqual(["py-linter"]);
    expect(env.server.descriptorId).toBe("py-linter");
  });

  it("pathless descriptorId selects matching live session", async () => {
    const c = conn({ descriptorId: "live-b", name: "other-name", requestImpl: async () => null });
    liveSession("live-b", c);
    const env = await executeLspOperation(
      { operation: "capabilities", server: "live-b" },
      { getManager: () => ({ getServer: vi.fn(async () => { throw new Error("must not spawn"); }) }), acquire: vi.fn(async () => { throw new Error("must not acquire"); }), cwd: ROOT },
    );
    expect(env.status).not.toBe("unavailable");
    expect(env.server.descriptorId).toBe("live-b");
  });

  it("pathless connection-name differing from descriptorId does NOT select", async () => {
    const c = conn({ descriptorId: "real-desc", name: "alias-name", requestImpl: async () => { throw new Error("must not run"); } });
    liveSession("real-desc", c);
    const env = await executeLspOperation(
      { operation: "capabilities", server: "alias-name" },
      { getManager: () => ({ getServer: vi.fn(async () => { throw new Error("must not spawn"); }) }), acquire: vi.fn(async () => { throw new Error("must not acquire"); }), cwd: ROOT },
    );
    expect(env.status).toBe("unavailable");
  });

  it("missing descriptor never spawns/falls back", async () => {
    const getServer = vi.fn(async () => { throw new Error("must not spawn"); });
    const acquire = vi.fn(async () => { throw new Error("must not acquire"); });
    const workspaceSymbol = vi.fn(async () => { throw new Error("must not fan out"); });
    const env = await executeLspOperation(
      { operation: "workspaceSymbols", query: "foo", server: "missing-desc" },
      { getManager: () => ({ getServer, workspaceSymbol }), acquire, cwd: ROOT },
    );
    expect(env.status).toBe("unavailable");
    expect(getServer).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(workspaceSymbol).not.toHaveBeenCalled();
  });

  it("two live fingerprint sessions same descriptor → ambiguous not first-match", async () => {
    const c1 = conn({ descriptorId: "dup-desc", name: "n1", requestImpl: async () => { throw new Error("must not run first-match"); } });
    const c2 = conn({ descriptorId: "dup-desc", name: "n2", requestImpl: async () => { throw new Error("must not run first-match"); } });
    liveSession("dup-desc", c1);
    liveSession("dup-desc", c2);
    const env = await executeLspOperation(
      { operation: "capabilities", server: "dup-desc" },
      { getManager: () => ({ getServer: vi.fn(async () => { throw new Error("must not spawn"); }) }), acquire: vi.fn(async () => { throw new Error("must not acquire"); }), cwd: ROOT },
    );
    expect(env.status).toBe("ambiguous");
    expect(env.error?.code).toBe("ambiguous");
  });

  it("selected lease held for op", async () => {
    const c = conn({ descriptorId: "leased-r4", requestImpl: async () => {
      const leases = [...sessionStore.values()].find((e) => e.descriptorId === "leased-r4")?.leases;
      return { observedLeases: leases };
    } });
    const k = liveSession("leased-r4", c);
    const env = await executeLspOperation(
      { operation: "request", server: "leased-r4", method: "workspace/symbol", params: { query: "x" } },
      { getManager: () => ({ getServer: vi.fn(async () => { throw new Error("must not spawn"); }) }), cwd: ROOT },
    );
    expect(env.status).toBe("ok");
    expect((env.result as { observedLeases: unknown }).observedLeases).toBe(1);
    expect(sessionStore.get(k)?.leases).toBe(0);
  });

  it("provenance returns selected descriptorId exactly", async () => {
    const c = conn({ descriptorId: "exact-desc", name: "different-conn-name", requestImpl: async () => null });
    liveSession("exact-desc", c);
    const env = await executeLspOperation(
      { operation: "capabilities", server: "exact-desc" },
      { getManager: () => ({ getServer: vi.fn(async () => { throw new Error("must not spawn"); }) }), acquire: vi.fn(async () => { throw new Error("must not acquire"); }), cwd: ROOT },
    );
    expect(env.server.descriptorId).toBe("exact-desc");
  });
});
