import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("language-intelligence warmup", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "li-warmup-")); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

  it("warmup path never throws and never blocks on missing servers — pure degradation", async () => {
    const { detectProjectLanguages, detectLanguageFromExtension } = await import("../../src/lsp-bridge.js");
    // Empty project with missing servers should degrade gracefully, not throw or hang
    const start = Date.now();
    const info = detectProjectLanguages(root);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // not blocking
    expect(Array.isArray(info.detectedLanguages)).toBe(true);
    expect(Array.isArray(info.availableServers)).toBe(true);
    expect(Array.isArray(info.supportedLanguages)).toBe(true);
    // availableServers should be empty when no binaries on PATH match (or at most contain real system binaries)
    // The key assertion: call did not throw and did not trigger install/prompt
    expect(detectLanguageFromExtension(join(root, "a.json"))).toBe("json");
    expect(detectLanguageFromExtension(join(root, "a.rb"))).toBe("ruby");
  });

  it("openFile fire-and-forget does not throw when server missing", async () => {
    const { getLSPBridge, resetLSPBridge, shutdownAllManagers } = await import("../../src/lsp-bridge.js");
    const bridge = await getLSPBridge();
    // Write a file with new language extension — warm hook would call openFile
    const file = join(root, "a.lua");
    writeFileSync(file, "print('hi')");
    // openFile should not throw even though lua server likely missing; it degrades via resolver
    await expect(bridge!.openFile(file, root)).resolves.not.toThrow();
    await shutdownAllManagers();
    resetLSPBridge();
  });

  it("resolver never executes untrusted project-local binary during warmup", async () => {
    // Verify runtime never stats project-local bin when root untrusted (checked in runtime tests, but warmup must also respect it)
    const src = readFileSync("src/language-intelligence-runtime.ts", "utf-8");
    expect(src).toContain("isRootTrusted");
    // lsp-bridge must call resolveLanguageServer which internally checks trust gate — ensure no direct existsSync on node_modules/.bin without trust check
    const bridgeSrc = readFileSync("src/lsp-bridge.ts", "utf-8");
    expect(bridgeSrc).toContain("resolveLanguageServer");
    expect(bridgeSrc).not.toMatch(/node_modules.*\\.bin.*existsSync/);
  });

  it("no install/prompt code in Phase 1 warmup path", async () => {
    const bridgeSrc = readFileSync("src/lsp-bridge.ts", "utf-8");
    const indexSrc = readFileSync("src/index.ts", "utf-8");
    // Phase 1 must be degradation-only; no network install, no prompt strings
    expect(bridgeSrc.toLowerCase()).not.toMatch(/install.*language.*server/);
    expect(indexSrc).toContain("getLSPBridge");
    expect(indexSrc).toContain("openFile");
    // Warm hook is fire-and-forget .catch(()=>{}) — never blocks
    expect(indexSrc).toMatch(/getLSPBridge\(\)[\s\S]*openFile[\s\S]*\.catch/);
  });
});
