/**
 * RS1 — TypeScript via real typescript-language-server (docs/lsp-conformance.md §7).
 * Covers doc sync, hover, formatting, codeAction, push diagnostics, cancel,
 * shutdown, provenance. Server-dependent absences SKIP honestly via ctx.skip().
 * Opt-in: PI_SMARTREAD_LSP_CONFORMANCE=1 (alias PI_REAL_SERVER=1).
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { LspRequestCancelledError } from "../../../src/lsp/lsp-connection.js";
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

describe.skipIf(!REAL_LSP_ENABLED)("RS1 real-server TypeScript (typescript-language-server)", () => {
  let servers: LiveServer[] = [];
  let projects: Array<() => void> = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
    for (const c of projects) c();
    projects = [];
  });

  it("doc sync: didOpen on first touch, didChange on edit, didClose removes", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs1-sync-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root, descriptorId: "typescript" });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    expect(s.conn.isOpen(p.mainFile)).toBe(true);
    await s.conn.didChange(p.mainFile, `export const answer = 42;\n`);
    expect(s.conn.isOpen(p.mainFile)).toBe(true);
    await s.conn.didClose(p.mainFile);
    expect(s.conn.isOpen(p.mainFile)).toBe(false);
  });

  it("hover returns contents at a symbol position", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs1-hover-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    await s.conn.prepareDocument(p.errorFile);
    // tsserver answers hover with empty contents while the project loads; poll until real contents arrive.
    let h: unknown = null;
    const got = await pollFor(() => s.conn.hasDiagnostics(p.mainFile) || s.conn.hasDiagnostics(p.errorFile), 15_000);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const cur = await s.conn.hover(p.mainFile, 0, 16); // over `add`
      if (cur && JSON.stringify(cur).length > 20) { h = cur; break; }
      h = cur;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (h === null || JSON.stringify(h).length <= 20) {
      ctx.skip(`no hover contents yet (diagnostics seen: ${got}) — project load incomplete, not a pass`);
      return;
    }
    expect(JSON.stringify(h)).toContain("number");
  });

  it("formatting + codeAction shapes are protocol-faithful", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs1-format-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.push(s);
    // Seed content that triggers server responses: bad spacing (formatting) +
    // unsorted/unused imports (organizeImports). Written to disk because
    // prepareDocument re-syncs from disk (a didChange edit would be clobbered).
    writeFileSync(
      p.mainFile,
      `import { tmpdir } from "os";\nimport { join } from "path";\nexport   const    messy=1;\n`,
    );
    await s.conn.prepareDocument(p.mainFile);
    const fmt = await s.conn.formatting(p.mainFile, 2, true);
    if (fmt === null) {
      ctx.skip("server returned no formatting edits for mis-spaced file — shape unproven, not a pass");
      return;
    }
    const fileEdits = (fmt as unknown as { fileEdits: Array<{ filePath: string; edits: unknown[] }> }).fileEdits;
    expect(Array.isArray(fileEdits)).toBe(true);
    expect(fileEdits.length).toBeGreaterThan(0);
    expect(fileEdits[0]!.edits.length).toBeGreaterThan(0);
    const actions = await s.conn.codeActions(
      p.mainFile,
      { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
      { only: ["source.organizeImports"] },
    );
    expect(Array.isArray(actions)).toBe(true);
  });

  it("push diagnostics arrive for the file with a type error", { timeout: 45_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs1-diag-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.push(s);
    await s.conn.prepareDocument(p.errorFile);
    const arrived = await pollFor(() => s.conn.getDiagnostics(p.errorFile).length > 0, 25_000);
    if (!arrived) {
      ctx.skip("no push diagnostics within 25s — broker receipt unproven against this server");
      return;
    }
    expect(s.conn.hasDiagnostics(p.errorFile)).toBe(true);
    expect(s.conn.getDiagnostics(p.errorFile).length).toBeGreaterThan(0);
  });

  it("cancel: aborted request rejects AbortError and connection stays usable", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs1-cancel-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    const ctrl = new AbortController();
    const pending = s.conn.request("textDocument/hover", {
      textDocument: { uri: `file://${p.mainFile}` },
      position: { line: 0, character: 17 },
    }, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toThrowError(LspRequestCancelledError);
    // Connection still usable after cancel.
    const h = await s.conn.hover(p.mainFile, 0, 8);
    expect(h === null || typeof h === "object").toBe(true);
  });

  it("provenance: descriptor, root, languageIds recorded on session", { timeout: 40_000 }, async (ctx) => {
    if (!binary) { ctx.skip(`typescript-language-server not on PATH`); return; }
    const p = makeTsProject("rs1-prov-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: binary, args: ["--stdio"], root: p.root, descriptorId: "typescript" });
    servers.push(s);
    expect(s.conn.descriptorId).toBe("typescript");
    expect(s.conn.projectRoot).toBe(p.root);
    expect(s.conn.name).toContain("typescript-language-server");
  });
});
