import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, isRootTrusted, trustRoot, listTrustedRoots, resetLanguageIntelligenceCaches, __paths } from "../../src/language-intelligence-config.js";

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-li-config-"));
  return dir;
}

describe("language-intelligence-config", () => {
  let home: string;
  beforeEach(() => { home = makeHome(); resetLanguageIntelligenceCaches(); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch {} resetLanguageIntelligenceCaches(); });

  it("malformed config → empty no throw", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(__paths.configPath(home), "not json", "utf-8");
    expect(loadConfig(home)).toEqual({});
    writeFileSync(__paths.configPath(home), JSON.stringify([]), "utf-8");
    expect(loadConfig(home)).toEqual({});
    writeFileSync(__paths.configPath(home), JSON.stringify({ overrides: "bad" }), "utf-8");
    expect(loadConfig(home)).toEqual({});
  });

  it("override parsing", () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(__paths.configPath(home), JSON.stringify({ overrides: { python: { command: "my-pyright", args: ["--stdio"] } }, disabled: ["go"] }), "utf-8");
    const cfg = loadConfig(home);
    expect(cfg.overrides?.python?.command).toBe("my-pyright");
    expect(cfg.overrides?.python?.args).toEqual(["--stdio"]);
    expect(cfg.disabled).toEqual(["go"]);
  });

  it("trust store round-trip + canonicalization via realpath", () => {
    const realDir = mkdtempSync(join(tmpdir(), "pi-trust-real-"));
    const linkDir = join(tmpdir(), `pi-trust-link-${Date.now()}`);
    try { symlinkSync(realDir, linkDir); } catch { /* skip symlink test if unsupported */ }
    trustRoot(realDir, home);
    expect(isRootTrusted(realDir, home)).toBe(true);
    if (existsSync(linkDir)) {
      // realpath of link should equal realDir canonical
      expect(isRootTrusted(linkDir, home)).toBe(true);
      const listed = listTrustedRoots(home);
      // list should contain canonical path, not link path
      expect(listed).toContain(realpathSync(realDir));
    }
    // dedup
    trustRoot(realDir, home);
    expect(listTrustedRoots(home).length).toBe(1);
    try { rmSync(realDir, { recursive: true, force: true }); } catch {}
    try { rmSync(linkDir, { force: true }); } catch {}
  });

  it("atomic write leaves no .tmp files on success", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-trust-atomic-"));
    trustRoot(dir, home);
    const trustDir = join(home, ".pi", "agent", "language-intelligence");
    const files = existsSync(trustDir) ? readdirSync(trustDir) : [];
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("missing trust file → empty list no throw", () => {
    expect(listTrustedRoots(home)).toEqual([]);
    expect(isRootTrusted("/nonexistent", home)).toBe(false);
  });
});
