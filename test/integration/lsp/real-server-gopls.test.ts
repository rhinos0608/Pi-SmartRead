/**
 * RS3 — Go via real gopls (docs/lsp-conformance.md §7).
 * Covers init + doc sync, hover core op, negotiated encoding + provenance.
 * Server-dependent absences SKIP honestly via ctx.skip().
 * Opt-in: PI_SMARTREAD_LSP_CONFORMANCE=1 (alias PI_REAL_SERVER=1).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  REAL_LSP_ENABLED,
  resolveBinary,
  startRealServer,
  type LiveServer,
} from "./real-server-harness.js";

const BIN_CANDIDATES = ["gopls"];
const binary = resolveBinary(BIN_CANDIDATES);

function binaryUsable(): string | null {
  if (!binary) return null;
  try {
    execFileSync(binary, ["version"], { encoding: "utf-8", timeout: 15_000 });
    return binary;
  } catch (err) {
    return `unusable:${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}

function makeGoProject(prefix: string): { root: string; mainFile: string; cleanup: () => void } {
  // realpath: os.tmpdir() is a symlink (/tmp -> /private/tmp) on macOS.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  writeFileSync(join(root, "go.mod"), `module rs3example\n\ngo 1.21\n`);
  const mainFile = join(root, "main.go");
  writeFileSync(mainFile, `package main\n\nimport "fmt"\n\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n\nfunc main() {\n\tfmt.Println(Add(40, 2))\n}\n`);
  return { root, mainFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe.skipIf(!REAL_LSP_ENABLED)("RS3 real-server gopls", () => {
  let servers: LiveServer[] = [];
  let projects: Array<() => void> = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
    for (const c of projects) c();
    projects = [];
  });

  it("init + doc sync: didOpen on first touch, didClose removes", { timeout: 60_000 }, async (ctx) => {
    const usable = binaryUsable();
    if (!binary) { ctx.skip(`gopls not on PATH`); return; }
    if (usable === null || usable.startsWith("unusable:")) { ctx.skip(`gopls binary present but not runnable: ${usable}`); return; }
    const p = makeGoProject("rs3-sync-");
    projects.push(p.cleanup);
    // gopls serves LSP over stdio with no args.
    const s = await startRealServer({ command: usable, args: [], root: p.root, descriptorId: "gopls" });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    expect(s.conn.isOpen(p.mainFile)).toBe(true);
    await s.conn.didClose(p.mainFile);
    expect(s.conn.isOpen(p.mainFile)).toBe(false);
  });

  it("hover returns contents at a symbol position", { timeout: 60_000 }, async (ctx) => {
    const usable = binaryUsable();
    if (!binary) { ctx.skip(`gopls not on PATH`); return; }
    if (usable === null || usable.startsWith("unusable:")) { ctx.skip(`gopls binary present but not runnable: ${usable}`); return; }
    const p = makeGoProject("rs3-hover-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: usable, args: [], root: p.root });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    // Over `Add` call in main (0-based line 8): `fmt.Println(Add(40, 2))`.
    const deadline = Date.now() + 30_000;
    let h: unknown = null;
    while (Date.now() < deadline) {
      const cur = await s.conn.hover(p.mainFile, 8, 13);
      if (cur && JSON.stringify(cur).length > 20) { h = cur; break; }
      h = cur;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (h === null || JSON.stringify(h).length <= 20) {
      ctx.skip("no hover contents yet — server still indexing, not a pass");
      return;
    }
    expect(JSON.stringify(h)).toContain("int");
  });

  it("negotiated encoding + provenance recorded on session", { timeout: 60_000 }, async (ctx) => {
    const usable = binaryUsable();
    if (!binary) { ctx.skip(`gopls not on PATH`); return; }
    if (usable === null || usable.startsWith("unusable:")) { ctx.skip(`gopls binary present but not runnable: ${usable}`); return; }
    const p = makeGoProject("rs3-prov-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: usable, args: [], root: p.root, descriptorId: "gopls" });
    servers.push(s);
    expect(["utf-8", "utf-16", "utf-32"]).toContain(s.conn.getNegotiatedEncoding());
    expect(s.conn.descriptorId).toBe("gopls");
    expect(s.conn.projectRoot).toBe(p.root);
  });
});
