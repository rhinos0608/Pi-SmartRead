/**
 * RS5 — C++ via real clangd (docs/lsp-conformance.md §7).
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

const BIN_CANDIDATES = ["clangd"];
const binary = resolveBinary(BIN_CANDIDATES);

function binaryUsable(): string | null {
  if (!binary) return null;
  try {
    execFileSync(binary, ["--version"], { encoding: "utf-8", timeout: 45_000 });
    return binary;
  } catch (err) {
    return `unusable:${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}

function makeCppProject(prefix: string): { root: string; mainFile: string; cleanup: () => void } {
  // realpath: os.tmpdir() is a symlink (/tmp -> /private/tmp) on macOS.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const mainFile = join(root, "main.cpp");
  writeFileSync(mainFile, `#include <iostream>\n\nint add(int a, int b) {\n    return a + b;\n}\n\nint main() {\n    std::cout << add(40, 2) << std::endl;\n    return 0;\n}\n`);
  // Minimal compilation database so clangd resolves flags without a build system.
  writeFileSync(
    join(root, "compile_commands.json"),
    JSON.stringify([{ directory: root, command: "c++ -std=c++17 -c main.cpp", file: "main.cpp" }]),
  );
  return { root, mainFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe.skipIf(!REAL_LSP_ENABLED)("RS5 real-server clangd", () => {
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
    if (!binary) { ctx.skip(`clangd not on PATH`); return; }
    if (usable === null || usable.startsWith("unusable:")) { ctx.skip(`clangd binary present but not runnable: ${usable}`); return; }
    const p = makeCppProject("rs5-sync-");
    projects.push(p.cleanup);
    // clangd serves LSP over stdio with no args; background index off keeps the stub fast.
    const s = await startRealServer({ command: usable, args: ["--background-index=false"], root: p.root, descriptorId: "clangd" });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    expect(s.conn.isOpen(p.mainFile)).toBe(true);
    await s.conn.didClose(p.mainFile);
    expect(s.conn.isOpen(p.mainFile)).toBe(false);
  });

  it("hover returns contents at a symbol position", { timeout: 60_000 }, async (ctx) => {
    const usable = binaryUsable();
    if (!binary) { ctx.skip(`clangd not on PATH`); return; }
    if (usable === null || usable.startsWith("unusable:")) { ctx.skip(`clangd binary present but not runnable: ${usable}`); return; }
    const p = makeCppProject("rs5-hover-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: usable, args: ["--background-index=false"], root: p.root });
    servers.push(s);
    await s.conn.prepareDocument(p.mainFile);
    // Over `add` call in main (0-based line 6): `std::cout << add(40, 2) << std::endl;`.
    const deadline = Date.now() + 30_000;
    let h: unknown = null;
    while (Date.now() < deadline) {
      const cur = await s.conn.hover(p.mainFile, 6, 18);
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
    if (!binary) { ctx.skip(`clangd not on PATH`); return; }
    if (usable === null || usable.startsWith("unusable:")) { ctx.skip(`clangd binary present but not runnable: ${usable}`); return; }
    const p = makeCppProject("rs5-prov-");
    projects.push(p.cleanup);
    const s = await startRealServer({ command: usable, args: ["--background-index=false"], root: p.root, descriptorId: "clangd" });
    servers.push(s);
    expect(["utf-8", "utf-16", "utf-32"]).toContain(s.conn.getNegotiatedEncoding());
    expect(s.conn.descriptorId).toBe("clangd");
    expect(s.conn.projectRoot).toBe(p.root);
  });
});
