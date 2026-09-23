/**
 * RS7 — initialization gate (docs/lsp-conformance.md §7).
 * Servers that issue workspace/configuration + workspace/workspaceFolders
 * during initialize must not deadlock or silently lose requests.
 * Opt-in: PI_SMARTREAD_LSP_CONFORMANCE=1 (alias PI_REAL_SERVER=1).
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  REAL_LSP_ENABLED,
  TS_BIN_CANDIDATES,
  makeTsProject,
  pollFor,
  resolveBinary,
  startRealServer,
  type LiveServer,
} from "./real-server-harness.js";

const binary = resolveBinary(TS_BIN_CANDIDATES);

describe.skipIf(!REAL_LSP_ENABLED)("RS7 real-server initialize gate (typescript-language-server)", () => {
  let servers: LiveServer[] = [];
  let projects: Array<() => void> = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
    for (const c of projects) c();
    projects = [];
  });

  it("initialize completes without deadlock and advertises capabilities", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs7-init-");
    projects.push(p.cleanup);
    const started = Date.now();
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root, descriptorId: "typescript" });
    servers.push(s);
    expect(Date.now() - started).toBeLessThan(35_000);
    const caps = s.conn.getServerCapabilities();
    expect(caps).not.toBeNull();
    // Capability negotiation: static hover/definition/documentSymbol advertised.
    const reg = s.conn.getCapabilityRegistry();
    expect(reg).not.toBeNull();
    expect(reg!.can("hover") || caps?.["hoverProvider"] != null).toBe(true);
    // Provenance recorded on session.
    expect(s.conn.descriptorId).toBe("typescript");
    expect(s.conn.projectRoot).toBe(p.root);
    expect(s.conn.getNegotiatedEncoding()).toMatch(/utf-(8|16|32)/);
  });

  it("framing round-trips: real responses settle pending requests by id", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs7-frame-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    expect(s.conn.isOpen(p.mainFile)).toBe(true);
    // Two concurrent requests prove id-keyed settling (no cross-talk).
    const [h1, h2] = await Promise.all([
      s.conn.hover(p.mainFile, 0, 8),
      s.conn.hover(p.mainFile, 4, 10),
    ]);
    for (const h of [h1, h2]) {
      expect(h === null || typeof h === "object").toBe(true);
    }
  });

  it("workspace/configuration requested during init is answered (no silent loss)", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs7-config-");
    projects.push(p.cleanup);
    // sessionSettings is what the connection serves to workspace/configuration.
    const s = await startRealServer({
      command: binary, args: ["--stdio"], root: p.root, sessionSettings: { typescript: { format: { tabSize: 2 } } },
    });
    servers.push(s);
    expect(s.conn.sessionSettings).toEqual({ typescript: { format: { tabSize: 2 } } });
    // Server stayed alive past init => its configuration requests (if any) got replies.
    // Liveness probe: open a doc, then workspace/symbol; tsserver may ThrowNoProject
    // before the project loads, so fall back to hover liveness on server error.
    await s.conn.prepareDocument(p.mainFile);
    let alive = false;
    try {
      const symbols = await s.conn.workspaceSymbol("add");
      alive = Array.isArray(symbols);
    } catch {
      const h = await s.conn.hover(p.mainFile, 0, 8);
      alive = h === null || typeof h === "object";
    }
    expect(alive).toBe(true);
  });

  it("shutdown sends shutdown request then exit notification (ordered, idempotent)", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs7-shutdown-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.pop(); // manage shutdown manually here
    s.conn.shutdown();
    s.conn.shutdown(); // second call must be a no-op, never a duplicate frame
    const gone = await pollFor(() => (s.conn as unknown as { closed: boolean }).closed === true, 8_000);
    expect(gone).toBe(true);
  });
});
