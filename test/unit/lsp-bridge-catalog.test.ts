import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALL_SERVER_CONFIGS, detectLanguageFromExtension, detectProjectLanguages } from "../../src/lsp-bridge.js";

function findCfg(cmd: string) {
  return ALL_SERVER_CONFIGS.find((c) => c.command === cmd);
}

describe("LSP catalog expansion", () => {
  it("contains clangd with empty args", () => {
    const cfg = findCfg("clangd");
    expect(cfg).toBeDefined();
    expect(cfg!.args).toEqual([]);
    expect(cfg!.languageIds).toEqual(expect.arrayContaining(["c", "cpp"]));
  });

  it("contains omnisharp with --languageserver flag", () => {
    const cfg = findCfg("omnisharp");
    expect(cfg).toBeDefined();
    expect(cfg!.args).toEqual(["--languageserver"]);
    expect(cfg!.languageIds).toEqual(expect.arrayContaining(["csharp"]));
  });

  it("contains csharp-ls fallback with no flags (stdio by default)", () => {
    const cfg = findCfg("csharp-ls");
    expect(cfg).toBeDefined();
    expect(cfg!.args).toEqual([]);
    expect(cfg!.languageIds).toEqual(expect.arrayContaining(["csharp"]));
  });

  it("contains bash-language-server with start flag", () => {
    const cfg = findCfg("bash-language-server");
    expect(cfg).toBeDefined();
    expect(cfg!.args).toEqual(["start"]);
    expect(cfg!.languageIds).toEqual(expect.arrayContaining(["bash"]));
  });

  it("contains intelephense with --stdio flag", () => {
    const cfg = findCfg("intelephense");
    expect(cfg).toBeDefined();
    expect(cfg!.args).toEqual(["--stdio"]);
    expect(cfg!.languageIds).toEqual(expect.arrayContaining(["php"]));
  });

  it("contains phpactor with language-server flag", () => {
    const cfg = findCfg("phpactor");
    expect(cfg).toBeDefined();
    expect(cfg!.args).toEqual(["language-server"]);
    expect(cfg!.languageIds).toEqual(expect.arrayContaining(["php"]));
  });

  it("routing: C/C++ extensions map to c/cpp", () => {
    expect(detectLanguageFromExtension("foo.c")).toBe("c");
    expect(detectLanguageFromExtension("foo.h")).toBe("c");
    expect(detectLanguageFromExtension("foo.cpp")).toBe("cpp");
    expect(detectLanguageFromExtension("foo.hpp")).toBe("cpp");
    expect(detectLanguageFromExtension("foo.cc")).toBe("cpp");
    expect(detectLanguageFromExtension("foo.cxx")).toBe("cpp");
    expect(detectLanguageFromExtension("foo.hh")).toBe("cpp");
    expect(detectLanguageFromExtension("foo.hxx")).toBe("cpp");
  });

  it("routing: C# .cs -> csharp", () => {
    expect(detectLanguageFromExtension("Foo.cs")).toBe("csharp");
    expect(detectLanguageFromExtension("foo.CS")).toBe("csharp");
  });

  it("routing: PHP .php -> php", () => {
    expect(detectLanguageFromExtension("index.php")).toBe("php");
  });

  it("routing: Bash .sh/.bash -> bash", () => {
    expect(detectLanguageFromExtension("script.sh")).toBe("bash");
    expect(detectLanguageFromExtension("script.bash")).toBe("bash");
  });

  it("routing: existing languages still route correctly", () => {
    expect(detectLanguageFromExtension("a.ts")).toBe("typescript");
    expect(detectLanguageFromExtension("a.py")).toBe("python");
    expect(detectLanguageFromExtension("a.rs")).toBe("rust");
    expect(detectLanguageFromExtension("a.go")).toBe("go");
    expect(detectLanguageFromExtension("a.java")).toBe("java");
  });

  describe("project marker detection", () => {
    let root: string;
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "lsp-catalog-"));
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("detects c/cpp via CMakeLists.txt", () => {
      writeFileSync(join(root, "CMakeLists.txt"), "cmake", "utf8");
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["c", "cpp"]));
    });

    it("detects c/cpp via Makefile", () => {
      writeFileSync(join(root, "Makefile"), "all:", "utf8");
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["c", "cpp"]));
    });

    it("detects c/cpp via compile_commands.json", () => {
      writeFileSync(join(root, "compile_commands.json"), "[]", "utf8");
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["c", "cpp"]));
    });

    it("detects csharp via .csproj", () => {
      writeFileSync(join(root, "App.csproj"), "<Project/>", "utf8");
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["csharp"]));
    });

    it("detects csharp via .sln", () => {
      writeFileSync(join(root, "My.sln"), "", "utf8");
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["csharp"]));
    });

    it("detects php via composer.json", () => {
      writeFileSync(join(root, "composer.json"), "{}", "utf8");
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["php"]));
    });

    it("detects languages via file extension sampling when no markers", () => {
      // sampleSourceExtensions only scans top-level entries (not recursive)
      writeFileSync(join(root, "main.cpp"), "int main(){}", "utf8");
      writeFileSync(join(root, "app.cs"), "class A{}", "utf8");
      writeFileSync(join(root, "index.php"), "<?php", "utf8");
      writeFileSync(join(root, "run.sh"), "#!/bin/bash", "utf8");
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["cpp", "csharp", "php", "bash"]));
    });
  });

  it("regression guard: no bare-java entry exists in ALL_SERVER_CONFIGS", () => {
    const bareJava = ALL_SERVER_CONFIGS.find((c) => c.command === "java" && c.args.length === 0);
    expect(bareJava, "bare java with no args must not exist — use jdtls only").toBeUndefined();
    const jdtls = ALL_SERVER_CONFIGS.find((c) => c.command === "jdtls");
    expect(jdtls).toBeDefined();
    expect(jdtls!.languageIds).toEqual(expect.arrayContaining(["java"]));
  });

  it("routing: 6 new languages map correctly", () => {
    expect(detectLanguageFromExtension("a.json")).toBe("json");
    expect(detectLanguageFromExtension("a.jsonc")).toBe("json");
    expect(detectLanguageFromExtension("a.yaml")).toBe("yaml");
    expect(detectLanguageFromExtension("a.yml")).toBe("yaml");
    expect(detectLanguageFromExtension("a.html")).toBe("html");
    expect(detectLanguageFromExtension("a.htm")).toBe("html");
    expect(detectLanguageFromExtension("a.css")).toBe("css");
    expect(detectLanguageFromExtension("a.scss")).toBe("css");
    expect(detectLanguageFromExtension("a.less")).toBe("css");
    expect(detectLanguageFromExtension("a.lua")).toBe("lua");
    expect(detectLanguageFromExtension("a.rb")).toBe("ruby");
    expect(detectLanguageFromExtension("A.RB")).toBe("ruby");
  });

  it("catalog sync: 6 new language server configs present", () => {
    expect(findCfg("vscode-json-language-server")).toBeDefined();
    expect(findCfg("yaml-language-server")).toBeDefined();
    expect(findCfg("vscode-html-language-server")).toBeDefined();
    expect(findCfg("vscode-css-language-server")).toBeDefined();
    expect(findCfg("lua-language-server")).toBeDefined();
    expect(findCfg("solargraph")).toBeDefined();
  });

  it("ruby detected via Gemfile marker", () => {
    const r = mkdtempSync(join(tmpdir(), "lsp-catalog-ruby-"));
    try {
      writeFileSync(join(r, "Gemfile"), "source 'https://rubygems.org'", "utf8");
      const info = detectProjectLanguages(r);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["ruby"]));
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it("resolution goes through runtime (lsp-bridge imports resolveLanguageServer)", async () => {
    const src = readFileSync("src/lsp-bridge.ts", "utf-8");
    expect(src).toContain("resolveLanguageServer");
    expect(src).toContain("language-intelligence-runtime");
    // Must not still use execFileSync for which/where
    expect(src).not.toMatch(/execFileSync.*which/);
  });

  it("does not duplicate existing servers (omnisharp/csharp-ls preserved exactly)", () => {
    const omnisharps = ALL_SERVER_CONFIGS.filter((c) => c.command === "omnisharp");
    expect(omnisharps.length).toBe(1);
    expect(omnisharps[0]!.args).toEqual(["--languageserver"]);
    const csharpLs = ALL_SERVER_CONFIGS.filter((c) => c.command === "csharp-ls");
    expect(csharpLs.length).toBe(1);
  });

  // ── P1 regression guards ──────────────────────────────────────────
  it("P1-1: supportedLanguages reflects resolved languageIds, not command basenames", () => {
    // Create temp bin with fake yaml-language-server on PATH and a yaml file in project
    const binDir = mkdtempSync(join(tmpdir(), "lsp-bin-"));
    const root = mkdtempSync(join(tmpdir(), "lsp-p1-1-"));
    const origPath = process.env.PATH ?? "";
    try {
      // minimal project with yaml file (no marker) — detection via sampling
      writeFileSync(join(root, "a.yaml"), "key: value", "utf8");
      // fake binary
      writeFileSync(join(binDir, "yaml-language-server"), "#!/bin/sh\nexit 0", "utf8");
      try { require("node:fs").chmodSync(join(binDir, "yaml-language-server"), 0o755); } catch {}
      process.env.PATH = `${binDir}${require("node:path").delimiter}${origPath}`;
      // Re-import fresh to pick up new PATH (resolveLanguageServer reads PATH at call time)
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["yaml"]));
      // Before fix: supportedLanguages always empty due to command-vs-languageId intersection
      expect(info.supportedLanguages).toEqual(expect.arrayContaining(["yaml"]));
      expect(info.availableServers).toEqual(expect.arrayContaining(["yaml-language-server"]));
      // supported must be subset of detected, and derived from languageIds
      for (const lang of info.supportedLanguages) expect(info.detectedLanguages).toContain(lang);
    } finally {
      process.env.PATH = origPath;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("P1-3: extension sampling runs unconditionally (unions with marker detection)", () => {
    const root = mkdtempSync(join(tmpdir(), "lsp-p1-3-"));
    try {
      // JS marker + yaml file in same project — before fix yaml never detected
      writeFileSync(join(root, "package.json"), "{}", "utf8");
      writeFileSync(join(root, "docker-compose.yaml"), "version: '3'", "utf8");
      writeFileSync(join(root, "styles.css"), "a{}", "utf8");
      const info = detectProjectLanguages(root);
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["typescript", "javascript"]));
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["yaml"]));
      expect(info.detectedLanguages).toEqual(expect.arrayContaining(["css"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("P1-2: resolver/legacy merge dedupes by languageId, not command string", () => {
    const src = readFileSync("src/lsp-bridge.ts", "utf-8");
    // Must dedupe legacy by languageId coverage
    expect(src).toContain("coveredLanguages");
    expect(src).toContain("languageIds.some");
    expect(src).toContain("flatMap");
    // Must not still use seen-basename dedup for legacy filter
    expect(src).not.toMatch(/availableSet\.has\(cfg\.command\) && !seen\.has\(cfg\.command\) && !seen\.has\(basename/);
  });

  it("P2-4: binaryExists dead export removed", () => {
    const src = readFileSync("src/lsp-bridge.ts", "utf-8");
    expect(src).not.toMatch(/export function binaryExists/);
    expect(src).not.toMatch(/function binaryExists/);
  });

  // ── Behavioral regression: same executable for multiple languages must merge languageIds ──
  it("behavioral regression: TS and JS sharing same executable merge into one config", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "lsp-bin-tsjs-"));
    const root = mkdtempSync(join(tmpdir(), "lsp-tsjs-"));
    const origPath = process.env.PATH ?? "";
    try {
      writeFileSync(join(root, "package.json"), "{}", "utf8");
      writeFileSync(join(binDir, "typescript-language-server"), "#!/bin/sh\nexit 0", "utf8");
      try { (await import("node:fs")).chmodSync(join(binDir, "typescript-language-server"), 0o755); } catch {}
      process.env.PATH = `${binDir}${require("node:path").delimiter}${origPath}`;
      const { LSPManager, resolvedServerCache } = await import("../../src/lsp-bridge.js");
      // Clear any stale cache for this root
      for (const k of [...resolvedServerCache.keys()]) if (k.startsWith(`${root}:`)) resolvedServerCache.delete(k);
      const mgr = new LSPManager(root);
      const configs = mgr.getAvailableConfigs();
      const tsConfigs = configs.filter((c: any) => c.command.includes("typescript-language-server"));
      expect(tsConfigs.length).toBe(1);
      const langs = tsConfigs[0]!.languageIds;
      expect(langs).toEqual(expect.arrayContaining(["typescript", "javascript"]));
      // Ensure not two separate single-language configs
      expect(configs.filter((c: any) => c.languageIds.includes("typescript") && c.command.includes("typescript-language-server")).length).toBe(1);
      expect(configs.filter((c: any) => c.languageIds.includes("javascript") && c.command.includes("typescript-language-server")).length).toBe(1);
      // Cleanup cache
      for (const k of [...resolvedServerCache.keys()]) if (k.startsWith(`${root}:`)) resolvedServerCache.delete(k);
    } finally {
      process.env.PATH = origPath;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("behavioral regression: C and CPP sharing clangd merge into one config", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "lsp-bin-clangd-"));
    const root = mkdtempSync(join(tmpdir(), "lsp-clangd-"));
    const origPath = process.env.PATH ?? "";
    try {
      writeFileSync(join(root, "CMakeLists.txt"), "cmake", "utf8");
      writeFileSync(join(binDir, "clangd"), "#!/bin/sh\nexit 0", "utf8");
      try { (await import("node:fs")).chmodSync(join(binDir, "clangd"), 0o755); } catch {}
      process.env.PATH = `${binDir}${require("node:path").delimiter}${origPath}`;
      const { LSPManager, resolvedServerCache } = await import("../../src/lsp-bridge.js");
      for (const k of [...resolvedServerCache.keys()]) if (k.startsWith(`${root}:`)) resolvedServerCache.delete(k);
      const mgr = new LSPManager(root);
      const configs = mgr.getAvailableConfigs();
      const clangConfigs = configs.filter((c: any) => c.command === "clangd" || c.command.endsWith("/clangd"));
      expect(clangConfigs.length).toBe(1);
      const langs = clangConfigs[0]!.languageIds;
      expect(langs).toEqual(expect.arrayContaining(["c", "cpp"]));
      for (const k of [...resolvedServerCache.keys()]) if (k.startsWith(`${root}:`)) resolvedServerCache.delete(k);
    } finally {
      process.env.PATH = origPath;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
