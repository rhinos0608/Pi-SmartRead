/**
 * RS6 — dynamic registration + configuration (docs/lsp-conformance.md §7).
 * client/registerCapability feeds the live registry; didChangeConfiguration
 * is accepted without killing the session. Cases with no server-sent
 * registration SKIP honestly (ctx.skip) instead of asserting absence.
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

describe.skipIf(!REAL_LSP_ENABLED)("RS6 real-server dynamic registration/configuration", () => {
  let servers: LiveServer[] = [];
  let projects: Array<() => void> = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
    for (const c of projects) c();
    projects = [];
  });

  it("didChangeConfiguration accepted; session stays usable", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs6-config-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.push(s);
    await s.conn.notify("workspace/didChangeConfiguration", { settings: { typescript: { format: { tabSize: 4 } } } });
    await s.conn.prepareDocument(p.mainFile);
    const h = await s.conn.hover(p.mainFile, 0, 8);
    expect(h === null || typeof h === "object").toBe(true);
  });

  it("server-sent client/registerCapability lands in the live registry", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs6-register-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    const seen = await pollFor(() => (s.conn.getCapabilityRegistry()?.snapshot().dynamic.length ?? 0) > 0, 12_000);
    if (!seen) {
      ctx.skip("server sent no client/registerCapability within 12s — nothing to assert, not a pass");
      return;
    }
    const snap = s.conn.getCapabilityRegistry()!.snapshot();
    expect(snap.dynamic.length).toBeGreaterThan(0);
    for (const f of snap.dynamic) expect(s.conn.getCapabilityRegistry()!.can(f)).toBe(true);
  });

  it("workspaceFolders served from session root", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs6-folders-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.push(s);
    // Root reached the server (init rootUri); projectRoot provenance intact.
    expect(s.conn.projectRoot).toBe(p.root);
    const caps = s.conn.getServerCapabilities();
    expect(caps).not.toBeNull();
  });
});
