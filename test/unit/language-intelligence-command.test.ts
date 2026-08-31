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
  return { ...orig, isRootTrusted: vi.fn().mockReturnValue(false), trustRoot: vi.fn() };
});
vi.mock("../../src/language-server-catalog.js", async (importOriginal) => {
  const orig: any = await importOriginal();
  return { ...orig, getDescriptorsForLanguage: vi.fn().mockReturnValue([]) };
});

import { registerLanguageIntelligenceCommand } from "../../src/language-intelligence-command.js";
import { detectProjectLanguages, invalidateResolvedServerCacheForRoot, evictManagerForRoot } from "../../src/lsp-bridge.js";
import { resolveLanguageServer } from "../../src/language-intelligence-runtime.js";
import { isRootTrusted, trustRoot } from "../../src/language-intelligence-config.js";
import { getDescriptorsForLanguage } from "../../src/language-server-catalog.js";

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
});
