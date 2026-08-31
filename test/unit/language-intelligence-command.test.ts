import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lsp-bridge.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    detectProjectLanguages: vi.fn(),
    invalidateResolvedServerCacheForRoot: vi.fn(),
    evictManagerForRoot: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../../src/language-intelligence-runtime.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, resolveLanguageServer: vi.fn() };
});
vi.mock("../../src/language-intelligence-config.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    isRootTrusted: vi.fn().mockReturnValue(false),
    trustRoot: vi.fn(),
    loadConfig: vi.fn().mockReturnValue({}),
    setInstallMode: vi.fn(),
  };
});
vi.mock("../../src/language-server-catalog.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, getDescriptorsForLanguage: vi.fn().mockReturnValue([]) };
});
vi.mock("../../src/language-intelligence-installer.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return {
    ...orig,
    installServer: vi.fn(),
    updateServer: vi.fn(),
    uninstallServer: vi.fn(),
    isServerInstalled: vi.fn().mockReturnValue(false),
  };
});

import { registerLanguageIntelligenceCommand } from "../../src/language-intelligence-command.js";
import { detectProjectLanguages, invalidateResolvedServerCacheForRoot, evictManagerForRoot } from "../../src/lsp-bridge.js";
import { resolveLanguageServer } from "../../src/language-intelligence-runtime.js";
import { isRootTrusted, trustRoot, loadConfig, setInstallMode } from "../../src/language-intelligence-config.js";
import { getDescriptorsForLanguage } from "../../src/language-server-catalog.js";
import { installServer, updateServer, uninstallServer, isServerInstalled } from "../../src/language-intelligence-installer.js";

function makeCtx(cwd = "/tmp/ws") {
  const notify = vi.fn();
  return { ctx: { cwd, ui: { notify } } as any, notify };
}
function getHandler() {
  let captured: any = null;
  const pi: any = { registerCommand: vi.fn((_name: string, opts: any) => { captured = opts; }) };
  registerLanguageIntelligenceCommand(pi as any);
  expect(pi.registerCommand).toHaveBeenCalledWith("lsp", expect.any(Object));
  return captured.handler as (args: string, ctx: any) => Promise<void>;
}

function getRegisteredDescription(): string {
  let captured: any = null;
  const pi: any = { registerCommand: vi.fn((_name: string, opts: any) => { captured = opts; }) };
  registerLanguageIntelligenceCommand(pi as any);
  return captured.description as string;
}

beforeEach(() => vi.clearAllMocks());

describe("language-intelligence-command", () => {
  it("status with no detected languages", async () => {
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: [], availableLanguages: [], supportedLanguages: [] } as any);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("", ctx);
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("Language Intelligence");
    expect(msg).toContain("(no languages detected)");
    expect(msg).toContain("warmup: enabled");
    expect(msg).toContain("install mode: off");
  });

  it("status with a resolved language", async () => {
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: ["typescript"], availableLanguages: ["typescript"], supportedLanguages: [] } as any);
    vi.mocked(resolveLanguageServer).mockReturnValue({ status: "available", languageId: "typescript", root: "/ws", descriptorId: "typescript", executable: "typescript-language-server", args: ["--stdio"], tier: "system" } as any);
    vi.mocked(getDescriptorsForLanguage).mockReturnValue([{ id: "typescript" } as any]);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("status", ctx);
    const msg = (notify.mock.calls[0]![0] as string);
    expect(msg).toContain("typescript");
    expect(msg).toContain("available");
    expect(msg).toContain("system");
  });

  it("doctor output structure", async () => {
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: ["python"], availableLanguages: [], supportedLanguages: [] } as any);
    vi.mocked(getDescriptorsForLanguage).mockReturnValue([{ id: "python" } as any, { id: "py2" } as any]);
    vi.mocked(resolveLanguageServer).mockReturnValue({ status: "degraded", languageId: "python", reasonCode: "executable-missing", message: "no executable", attemptedDescriptorIds: ["python"], fallback: "ast" } as any);
    vi.mocked(isRootTrusted).mockReturnValue(true);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("doctor", ctx);
    const msg = (notify.mock.calls[0]![0] as string);
    expect(msg).toContain("Doctor");
    expect(msg).toContain("trusted: true");
    expect(msg).toContain("descriptors:");
    expect(msg).toContain("tier: degraded");
    expect(msg).toContain("reason:");
  });

  it("trust calls trustRoot and invalidates cache", async () => {
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("trust", ctx);
    expect(trustRoot).toHaveBeenCalledWith("/ws");
    expect(invalidateResolvedServerCacheForRoot).toHaveBeenCalled();
    expect(evictManagerForRoot).toHaveBeenCalledWith("/ws");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("re-resolved on next use"), expect.anything());
  });

  it("restart doesn't throw when no manager exists", async () => {
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await expect(h("restart", ctx)).resolves.not.toThrow();
    expect(evictManagerForRoot).toHaveBeenCalledWith("/ws");
    expect(notify).toHaveBeenCalled();
  });

  // ── install ──────────────────────────────────────────────────────────

  it("install <server> with managedInstall — success", async () => {
    vi.mocked(installServer).mockResolvedValue({ ok: true, binPath: "/home/.pi/agent/language-intelligence/packages/typescript-language-server/node_modules/.bin/typescript-language-server" } as any);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("install typescript", ctx);
    expect(installServer).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(installServer).mock.calls[0]![0] as any;
    expect(spec.packageName).toBe("typescript-language-server");
    expect(spec.version).toBe("6.0.0");
    expect(spec.bin).toBe("typescript-language-server");
    expect(invalidateResolvedServerCacheForRoot).toHaveBeenCalledWith("/ws");
    expect(evictManagerForRoot).toHaveBeenCalledWith("/ws");
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("Installed typescript");
    expect(msg).toContain("/home/.pi/agent/language-intelligence/packages/typescript-language-server");
  });

  it("install <server> with managedInstall — failure", async () => {
    vi.mocked(installServer).mockResolvedValue({ ok: false, error: "npm install failed" } as any);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("install typescript", ctx);
    expect(installServer).toHaveBeenCalledTimes(1);
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("Failed to install typescript");
    expect(msg).toContain("npm install failed");
  });

  it("install <server> with no managedInstall — notifies and does not call installServer", async () => {
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("install rust-analyzer", ctx);
    expect(installServer).not.toHaveBeenCalled();
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toMatch(/No managed install available/i);
    expect(msg).toContain("rust-analyzer");
  });

  it("install with no arg shows usage and does not call installServer", async () => {
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("install", ctx);
    expect(installServer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /lsp install"), expect.anything());
  });

  it("install auto — scans degraded-with-managed ones, summarizes installed vs skipped", async () => {
    vi.mocked(loadConfig).mockReturnValue({ installMode: "off" } as any);
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: ["typescript", "rust"], availableLanguages: [], supportedLanguages: [] } as any);
    // typescript degraded, rust degraded — so both are candidates for auto scanning
    vi.mocked(resolveLanguageServer).mockImplementation((filePath: string) => {
      if (filePath.includes("__probe__.ts")) return { status: "degraded", languageId: "typescript", reasonCode: "executable-missing", message: "no bin", attemptedDescriptorIds: ["typescript"], fallback: "ast" } as any;
      if (filePath.includes("__probe__.rs")) return { status: "degraded", languageId: "rust", reasonCode: "executable-missing", message: "no bin", attemptedDescriptorIds: ["rust-analyzer"], fallback: "ast" } as any;
      return { status: "degraded", languageId: "unknown", reasonCode: "executable-missing", message: "", attemptedDescriptorIds: [], fallback: "text" } as any;
    });
    // getDescriptorsForLanguage for rust should return no-managed descriptor; typescript uses catalog byId path so mock not needed
    vi.mocked(getDescriptorsForLanguage).mockImplementation((lang: string) => {
      if (lang === "rust") return [{ id: "rust-analyzer", commandCandidates: [{ command: "rust-analyzer", args: [] }] } as any];
      if (lang === "typescript") return [{ id: "typescript", commandCandidates: [{ command: "typescript-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "typescript-language-server", version: "6.0.0", bin: "typescript-language-server" } }] } as any];
      return [];
    });
    vi.mocked(installServer).mockResolvedValue({ ok: true, binPath: "/tmp/bin/typescript-language-server" } as any);

    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("install auto", ctx);

    expect(setInstallMode).toHaveBeenCalledWith("auto");
    // only typescript should have triggered installServer
    expect(installServer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installServer).mock.calls[0]![0].packageName).toBe("typescript-language-server");
    expect(invalidateResolvedServerCacheForRoot).toHaveBeenCalledWith("/ws");
    expect(evictManagerForRoot).toHaveBeenCalledWith("/ws");
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("Enabled auto-install mode");
    expect(msg).toContain("Installed: typescript");
    expect(msg).toContain("Skipped (no managed install available): rust");
  });

  it("install auto skips already-available languages", async () => {
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: ["typescript", "python"], availableLanguages: [], supportedLanguages: [] } as any);
    vi.mocked(resolveLanguageServer).mockImplementation((filePath: string) => {
      if (filePath.includes("__probe__.ts")) return { status: "available", languageId: "typescript", root: "/ws", descriptorId: "typescript", executable: "typescript-language-server", args: ["--stdio"], tier: "system" } as any;
      return { status: "degraded", languageId: "python", reasonCode: "executable-missing", message: "", attemptedDescriptorIds: ["python"], fallback: "ast" } as any;
    });
    vi.mocked(getDescriptorsForLanguage).mockImplementation((lang: string) => {
      if (lang === "python") return [{ id: "python", commandCandidates: [{ command: "pyright", args: ["--stdio"], managedInstall: { type: "npm", packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" } }] } as any];
      return [{ id: "typescript", commandCandidates: [{ command: "typescript-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "typescript-language-server", version: "6.0.0", bin: "typescript-language-server" } }] } as any];
    });
    vi.mocked(installServer).mockResolvedValue({ ok: true, binPath: "/tmp/bin/pyright" } as any);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("install auto", ctx);
    expect(installServer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(installServer).mock.calls[0]![0].packageName).toBe("pyright");
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("Installed: python");
    // typescript was available so not installed nor skipped
    expect(msg).not.toContain("typescript");
  });

  // ── update ───────────────────────────────────────────────────────────

  it("update <server> — success", async () => {
    vi.mocked(updateServer).mockResolvedValue({ ok: true, binPath: "/tmp/bin/typescript-language-server" } as any);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("update typescript", ctx);
    expect(updateServer).toHaveBeenCalledTimes(1);
    const spec = vi.mocked(updateServer).mock.calls[0]![0] as any;
    expect(spec.packageName).toBe("typescript-language-server");
    expect(invalidateResolvedServerCacheForRoot).toHaveBeenCalledWith("/ws");
    expect(evictManagerForRoot).toHaveBeenCalledWith("/ws");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Updated typescript"), expect.anything());
    expect(notify.mock.calls[0]![0] as string).toContain("/tmp/bin/typescript-language-server");
  });

  it("update <server> — failure", async () => {
    vi.mocked(updateServer).mockResolvedValue({ ok: false, error: "network error" } as any);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("update typescript", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Failed to update typescript"), expect.anything());
    expect((notify.mock.calls[0]![0] as string)).toContain("network error");
  });

  it("update <server> with no managedInstall — notifies and does not call updateServer", async () => {
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("update rust-analyzer", ctx);
    expect(updateServer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No managed install available"), expect.anything());
  });

  it("update --all — iterates only installed managed servers", async () => {
    // Only typescript-language-server is considered installed
    vi.mocked(isServerInstalled).mockImplementation((pkg: string) => pkg === "typescript-language-server");
    vi.mocked(updateServer).mockResolvedValue({ ok: true, binPath: "/tmp/bin/updated" } as any);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("update --all", ctx);
    // updateServer called once for the single installed managed server
    expect(updateServer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateServer).mock.calls[0]![0].packageName).toBe("typescript-language-server");
    expect(invalidateResolvedServerCacheForRoot).toHaveBeenCalledWith("/ws");
    expect(evictManagerForRoot).toHaveBeenCalledWith("/ws");
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("typescript: updated");
  });

  it("update --all — no managed servers installed", async () => {
    vi.mocked(isServerInstalled).mockReturnValue(false);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("update --all", ctx);
    expect(updateServer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No managed servers installed"), expect.anything());
  });

  it("update --all — per-server summary includes failures", async () => {
    vi.mocked(isServerInstalled).mockImplementation((pkg: string) => pkg === "typescript-language-server" || pkg === "pyright");
    vi.mocked(updateServer).mockImplementation(async (spec: any) => {
      if (spec.packageName === "typescript-language-server") return { ok: true, binPath: "/tmp/bin/ts" } as any;
      return { ok: false, error: "boom" } as any;
    });
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("update --all", ctx);
    expect(updateServer).toHaveBeenCalledTimes(2);
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("typescript: updated");
    expect(msg).toContain("python: failed");
    expect(msg).toContain("boom");
  });

  // ── uninstall ────────────────────────────────────────────────────────

  it("uninstall <server> — success and invalidates cache + evicts manager", async () => {
    vi.mocked(uninstallServer).mockResolvedValue({ ok: true } as any);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("uninstall typescript", ctx);
    expect(uninstallServer).toHaveBeenCalledWith("typescript-language-server");
    expect(invalidateResolvedServerCacheForRoot).toHaveBeenCalledWith("/ws");
    expect(evictManagerForRoot).toHaveBeenCalledWith("/ws");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Uninstalled typescript"), expect.anything());
  });

  it("uninstall <server> on never-installed server — still reports success no throw", async () => {
    vi.mocked(uninstallServer).mockResolvedValue({ ok: true } as any);
    const h = getHandler();
    const { ctx } = makeCtx("/ws");
    await expect(h("uninstall typescript", ctx)).resolves.not.toThrow();
    expect(uninstallServer).toHaveBeenCalledWith("typescript-language-server");
    const notify = ctx.ui.notify as any;
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Uninstalled"), expect.anything());
  });

  it("uninstall <server> with no managedInstall — notifies and does not call uninstallServer", async () => {
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("uninstall rust-analyzer", ctx);
    expect(uninstallServer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No managed install found"), expect.anything());
  });

  it("uninstall with no arg shows usage", async () => {
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("uninstall", ctx);
    expect(uninstallServer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /lsp uninstall"), expect.anything());
  });

  // ── help text ────────────────────────────────────────────────────────

  it("unknown subcommand message mentions new subcommands", async () => {
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("foobar", ctx);
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("Unknown subcommand: foobar");
    expect(msg).toContain("install");
    expect(msg).toContain("update");
    expect(msg).toContain("uninstall");
    expect(msg).toContain("status, doctor, trust, restart, install, update, uninstall");
  });

  it("command description mentions new subcommands", () => {
    const desc = getRegisteredDescription();
    expect(desc).toContain("install");
    expect(desc).toContain("update");
    expect(desc).toContain("uninstall");
  });

  // ── status/doctor installMode + managed hint ─────────────────────────

  it("status reflects REAL installMode off vs auto", async () => {
    const h = getHandler();
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: [], availableLanguages: [], supportedLanguages: [] } as any);

    vi.mocked(loadConfig).mockReturnValue({ installMode: "off" } as any);
    const { ctx: ctxOff, notify: notifyOff } = makeCtx("/ws");
    await h("status", ctxOff);
    expect((notifyOff.mock.calls[0]![0] as string)).toContain("install mode: off");

    vi.mocked(loadConfig).mockReturnValue({ installMode: "auto" } as any);
    const { ctx: ctxAuto, notify: notifyAuto } = makeCtx("/ws");
    await h("status", ctxAuto);
    expect((notifyAuto.mock.calls[0]![0] as string)).toContain("install mode: auto");
  });

  it("doctor reflects REAL installMode off vs auto", async () => {
    const h = getHandler();
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: [], availableLanguages: [], supportedLanguages: [] } as any);
    vi.mocked(isRootTrusted).mockReturnValue(false);

    vi.mocked(loadConfig).mockReturnValue({ installMode: "off" } as any);
    const { ctx: ctxOff, notify: notifyOff } = makeCtx("/ws");
    await h("doctor", ctxOff);
    expect((notifyOff.mock.calls[0]![0] as string)).toContain("install mode: off");

    vi.mocked(loadConfig).mockReturnValue({ installMode: "auto" } as any);
    const { ctx: ctxAuto, notify: notifyAuto } = makeCtx("/ws");
    await h("doctor", ctxAuto);
    expect((notifyAuto.mock.calls[0]![0] as string)).toContain("install mode: auto");
  });

  it("missing-with-managed shows install hint, missing-without does not", async () => {
    vi.mocked(loadConfig).mockReturnValue({ installMode: "off" } as any);
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: ["typescript", "rust"], availableLanguages: [], supportedLanguages: [] } as any);
    vi.mocked(resolveLanguageServer).mockReturnValue({ status: "degraded", languageId: "typescript", reasonCode: "executable-missing", message: "no bin", attemptedDescriptorIds: ["typescript"], fallback: "ast" } as any);
    // For status, hasManagedCandidate uses getDescriptorsForLanguage
    vi.mocked(getDescriptorsForLanguage).mockImplementation((lang: string) => {
      if (lang === "typescript") return [{ id: "typescript", commandCandidates: [{ command: "typescript-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "typescript-language-server", version: "6.0.0", bin: "typescript-language-server" } }] } as any];
      if (lang === "rust") return [{ id: "rust-analyzer", commandCandidates: [{ command: "rust-analyzer", args: [] }] } as any];
      return [];
    });
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("status", ctx);
    const msg = notify.mock.calls[0]![0] as string;
    // typescript missing should have hint
    expect(msg).toContain("run /lsp install typescript to install");
    // rust missing should NOT have hint — verify no rust hint
    expect(msg).not.toContain("run /lsp install rust-analyzer to install");
  });

  it("doctor missing-with-managed shows hint, missing-without does not", async () => {
    vi.mocked(loadConfig).mockReturnValue({ installMode: "off" } as any);
    vi.mocked(detectProjectLanguages).mockReturnValue({ detectedLanguages: ["typescript", "rust"], availableLanguages: [], supportedLanguages: [] } as any);
    vi.mocked(resolveLanguageServer).mockReturnValue({ status: "degraded", languageId: "typescript", reasonCode: "executable-missing", message: "no bin", attemptedDescriptorIds: ["typescript"], fallback: "ast" } as any);
    vi.mocked(getDescriptorsForLanguage).mockImplementation((lang: string) => {
      if (lang === "typescript") return [{ id: "typescript", commandCandidates: [{ command: "typescript-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "typescript-language-server", version: "6.0.0", bin: "typescript-language-server" } }] } as any];
      if (lang === "rust") return [{ id: "rust-analyzer", commandCandidates: [{ command: "rust-analyzer", args: [] }] } as any];
      return [];
    });
    vi.mocked(isRootTrusted).mockReturnValue(false);
    const h = getHandler();
    const { ctx, notify } = makeCtx("/ws");
    await h("doctor", ctx);
    const msg = notify.mock.calls[0]![0] as string;
    expect(msg).toContain("hint: run /lsp install typescript to install");
    // should only have one hint (for typescript)
    const hintCount = (msg.match(/hint: run \/lsp install/g) || []).length;
    expect(hintCount).toBe(1);
  });
});
