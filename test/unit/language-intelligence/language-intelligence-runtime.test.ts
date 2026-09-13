import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { resolveLanguageServer, detectLanguageId } from "../../src/language-intelligence-runtime.js";
import { resetLanguageIntelligenceCaches as resetConfigCaches, __paths } from "../../src/language-intelligence-config.js";

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-li-rt-"));
  return dir;
}

describe("language-intelligence-runtime", () => {
  let home: string;
  let cwd: string;
  beforeEach(() => { home = makeHome(); cwd = mkdtempSync(join(tmpdir(), "pi-rt-cwd-")); resetConfigCaches(); mkdirSync(join(home, ".pi", "agent"), { recursive: true }); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch {} try { rmSync(cwd, { recursive: true, force: true }); } catch {} resetConfigCaches(); });

  it("tier 1 override resolution", () => {
    writeFileSync(__paths.configPath(home), JSON.stringify({ overrides: { python: { command: "my-pyright", args: ["--stdio"] } } }), "utf-8");
    const file = join(cwd, "a.py");
    writeFileSync(file, "x=1");
    const res = resolveLanguageServer(file, cwd, { homedir: home, checkExecutable: (c) => c === "my-pyright" });
    expect(res.status).toBe("available");
    if (res.status === "available") {
      expect(res.tier).toBe("override");
      expect(res.executable).toBe("my-pyright");
      expect(res.args).toEqual(["--stdio"]);
    }
  });

  it("tier 2 skipped-when-untrusted asserts zero filesystem check", () => {
    const proj = mkdtempSync(join(tmpdir(), "pi-proj-"));
    const pkg = join(proj, "pyproject.toml");
    writeFileSync(pkg, "");
    const bin = join(proj, "node_modules", ".bin", "pyright");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\necho hi");
    const file = join(proj, "sub", "a.py");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "x=1");
    const checkCalls: string[] = [];
    const check = (c: string) => { checkCalls.push(c); return false; };
    const fileExistsCalls: string[] = [];
    const fileExists = (p: string) => { fileExistsCalls.push(p); return false; };
    const res = resolveLanguageServer(file, cwd, { homedir: home, checkExecutable: check, fileExists });
    expect(res.status).toBe("degraded");
    if (res.status === "degraded") expect(res.reasonCode).toBe("project-local-untrusted");
    // system tier still attempted via checkExecutable — ensure local bin not leaked into checkCalls as absolute path
    expect(checkCalls.every((c) => !c.includes("node_modules"))).toBe(true);
    // project-local filesystem existence check must NOT have been called when untrusted
    expect(fileExistsCalls.length).toBe(0);
    try { rmSync(proj, { recursive: true, force: true }); } catch {}
  });

  it("tier 2 works when trusted", () => {
    const proj = mkdtempSync(join(tmpdir(), "pi-proj2-"));
    writeFileSync(join(proj, "pyproject.toml"), "");
    const bin = join(proj, "node_modules", ".bin", "pyright");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "x");
    // trust root
    const canonical = realpathSync(proj);
    mkdirSync(join(home, ".pi", "agent", "language-intelligence"), { recursive: true });
    writeFileSync(__paths.trustPath(home), JSON.stringify({ trustedRoots: [canonical] }), "utf-8");
    resetConfigCaches();
    const file = join(proj, "a.py");
    writeFileSync(file, "x");
    const res = resolveLanguageServer(file, proj, { homedir: home, checkExecutable: () => false });
    expect(res.status).toBe("available");
    if (res.status === "available") expect(res.tier).toBe("project-local");
    try { rmSync(proj, { recursive: true, force: true }); } catch {}
  });

  it("tier 3 PATH fallback", () => {
    const file = join(cwd, "a.py");
    writeFileSync(file, "x");
    const res = resolveLanguageServer(file, cwd, { homedir: home, checkExecutable: (c) => c === "pyright" });
    expect(res.status).toBe("available");
    if (res.status === "available") { expect(res.tier).toBe("system"); expect(res.executable).toBe("pyright"); }
  });

  it("full degradation to ast/text when nothing resolves", () => {
    const file = join(cwd, "a.py");
    writeFileSync(file, "x");
    const res = resolveLanguageServer(file, cwd, { homedir: home, checkExecutable: () => false });
    expect(res.status).toBe("degraded");
    if (res.status === "degraded") expect(res.fallback).toBe("ast");
    // unknown extension → text fallback
    const unknown = join(cwd, "file.unknownext123");
    writeFileSync(unknown, "x");
    const r2 = resolveLanguageServer(unknown, cwd, { homedir: home, checkExecutable: () => false });
    expect(r2.status).toBe("degraded");
    if (r2.status === "degraded") { expect(r2.fallback).toBe("text"); expect(r2.reasonCode).toBe("unsupported-language"); }
  });

  it("lua degraded fallback is text (no ast grammar)", () => {
    const file = join(cwd, "a.lua");
    writeFileSync(file, "x");
    const res = resolveLanguageServer(file, cwd, { homedir: home, checkExecutable: () => false });
    expect(res.status).toBe("degraded");
    if (res.status === "degraded") expect(res.fallback).toBe("text");
  });

  it("default checkExecutable does not spawn", async () => {
    // Verify runtime module has no exec/spawn import
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/language-intelligence-runtime.ts", "utf-8");
    expect(src).not.toMatch(/execFileSync/);
    expect(src).not.toMatch(/child_process/);
    expect(src).toMatch(/process\.env\.PATH/);
  });

  it("root detection nearest-marker-wins", () => {
    const top = mkdtempSync(join(tmpdir(), "pi-root-top-"));
    const inner = join(top, "inner");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(top, ".git"), "");
    writeFileSync(join(inner, "package.json"), "{}");
    const file = join(inner, "a.ts");
    writeFileSync(file, "");
    // trust both possible roots to allow project-local path; but we test root selection via tier2 trusted check
    // Instead verify resolve picks inner as root (nearest) by inspecting returned root for project-local case
    const bin = join(inner, "node_modules", ".bin", "typescript-language-server");
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, "x");
    const canonicalInner = realpathSync(inner);
    mkdirSync(join(home, ".pi", "agent", "language-intelligence"), { recursive: true });
    writeFileSync(__paths.trustPath(home), JSON.stringify({ trustedRoots: [canonicalInner] }), "utf-8");
    resetConfigCaches();
    const res = resolveLanguageServer(file, top, { homedir: home, checkExecutable: () => false });
    expect(res.status).toBe("available");
    if (res.status === "available") expect(res.root).toBe(canonicalInner);
    try { rmSync(top, { recursive: true, force: true }); } catch {}
  });

  it("language-id-from-extension round trip", () => {
    expect(detectLanguageId("foo.ts")).toBe("typescript");
    expect(detectLanguageId("foo.py")).toBe("python");
    expect(detectLanguageId("foo.rs")).toBe("rust");
    expect(detectLanguageId("foo.json")).toBe("json");
    expect(detectLanguageId("FOO.TS")).toBe("typescript");
  });
});
