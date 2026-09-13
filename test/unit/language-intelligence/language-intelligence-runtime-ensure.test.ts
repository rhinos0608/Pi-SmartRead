import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/language-intelligence-installer.js", async () => {
  const actual: any = await vi.importActual("../../src/language-intelligence-installer.js");
  return { ...actual, installServer: vi.fn(), isServerInstalled: actual.isServerInstalled, getInstalledBinPath: actual.getInstalledBinPath, readLockfile: actual.readLockfile };
});

import { ensureLanguageServerAvailable, _clearFailedInstallAttempts, _clearInFlightInstalls, resolveLanguageServer } from "../../src/language-intelligence-runtime.js";
import { installServer } from "../../src/language-intelligence-installer.js";
import { __paths, resetLanguageIntelligenceCaches } from "../../src/language-intelligence-config.js";

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ensure-home-"));
  mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
  return dir;
}

describe("ensureLanguageServerAvailable", () => {
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = makeTempHome();
    cwd = mkdtempSync(join(tmpdir(), "pi-ensure-cwd-"));
    _clearFailedInstallAttempts();
    _clearInFlightInstalls();
    resetLanguageIntelligenceCaches();
    vi.mocked(installServer).mockReset();
  });

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    _clearFailedInstallAttempts();
    _clearInFlightInstalls();
    resetLanguageIntelligenceCaches();
    vi.restoreAllMocks();
  });

  it("warmup purpose does not trigger install", async () => {
    const file = join(cwd, "a.py");
    writeFileSync(file, "x");
    writeFileSync(__paths.configPath(home), JSON.stringify({ installMode: "auto" }), "utf-8");
    resetLanguageIntelligenceCaches();
    vi.mocked(installServer).mockResolvedValue({ ok: true, binPath: "/tmp/fake" } as any);
    const res = await ensureLanguageServerAvailable(file, cwd, { purpose: "warmup", homedir: home });
    expect(vi.mocked(installServer)).not.toHaveBeenCalled();
    expect(res.status).toBe("degraded");
  });

  it("request purpose with auto mode triggers install when degraded", async () => {
    const file = join(cwd, "a.py");
    writeFileSync(file, "x");
    writeFileSync(__paths.configPath(home), JSON.stringify({ installMode: "auto" }), "utf-8");
    resetLanguageIntelligenceCaches();
    vi.mocked(installServer).mockResolvedValue({ ok: true, binPath: "/tmp/fake" } as any);
    const res = await ensureLanguageServerAvailable(file, cwd, { purpose: "request", homedir: home, checkExecutable: () => false });
    expect(vi.mocked(installServer)).toHaveBeenCalledTimes(1);
    const spec = (vi.mocked(installServer).mock.calls[0]![0] as any);
    expect(spec.packageName).toBe("pyright");
    expect(spec.bin).toBe("pyright-langserver");
    expect(res.status).toBeDefined();
  });

  it("already-failed-this-session is not retried on second call", async () => {
    const file = join(cwd, "a.py");
    writeFileSync(file, "x");
    writeFileSync(__paths.configPath(home), JSON.stringify({ installMode: "auto" }), "utf-8");
    resetLanguageIntelligenceCaches();
    vi.mocked(installServer).mockResolvedValue({ ok: false, error: "network failure" } as any);
    const r1 = await ensureLanguageServerAvailable(file, cwd, { purpose: "request", homedir: home });
    expect(vi.mocked(installServer)).toHaveBeenCalledTimes(1);
    expect(r1.status).toBe("degraded");
    const r2 = await ensureLanguageServerAvailable(file, cwd, { purpose: "request", homedir: home });
    expect(vi.mocked(installServer)).toHaveBeenCalledTimes(1); // not retried
    expect(r2.status).toBe("degraded");
  });

  it("config-disabled language even with installMode auto does NOT trigger install", async () => {
    const file = join(cwd, "a.py");
    writeFileSync(file, "x");
    writeFileSync(__paths.configPath(home), JSON.stringify({ installMode: "auto", disabled: ["python"] }), "utf-8");
    resetLanguageIntelligenceCaches();
    const before = resolveLanguageServer(file, cwd, { homedir: home, checkExecutable: () => false });
    expect(before.status).toBe("degraded");
    if (before.status === "degraded") {
      expect(before.reasonCode).toBe("language-disabled");
      expect(before.message).toMatch(/language disabled via config/);
    }
    vi.mocked(installServer).mockResolvedValue({ ok: true, binPath: "/tmp/fake" } as any);
    const res = await ensureLanguageServerAvailable(file, cwd, { purpose: "request", homedir: home });
    expect(vi.mocked(installServer)).not.toHaveBeenCalled();
    expect(res.status).toBe("degraded");
    expect(res).toEqual(before);
  });
});
