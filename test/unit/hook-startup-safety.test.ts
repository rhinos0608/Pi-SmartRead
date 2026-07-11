import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

vi.mock("../../lsp-bridge.js", () => ({
  getLSPBridge: vi.fn(() => new Promise(() => {})),
}));

import { registerSessionHooks, resetSessionState } from "../../hook.js";

function makeMockAPI(): {
  api: ExtensionAPI;
  handlers: Record<string, (...args: any[]) => unknown>;
} {
  const handlers: Record<string, (...args: any[]) => unknown> = {};
  return {
    api: {
      on: (event: string, handler: (...args: any[]) => unknown) => {
        handlers[event] = handler;
      },
    } as unknown as ExtensionAPI,
    handlers,
  };
}

function makeContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

describe("startup repo-map safety", () => {
  const roots: string[] = [];

  afterEach(() => {
    resetSessionState();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not depend on LSP augmentation before first prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-startup-repo-"));
    roots.push(root);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(root, "index.js"), "export const value = 1;\n");

    const { api, handlers } = makeMockAPI();
    registerSessionHooks(api);
    await handlers.session_start?.(
      { type: "session_start", reason: "startup" },
      makeContext(root),
    );

    const result = await handlers.before_agent_start?.(
      { type: "before_agent_start", systemPrompt: "base", prompt: "hi" },
      makeContext(root),
    ) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toContain("Repository Map");
  }, 1_000);

  it("recognizes a non-git project from a parent manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-startup-nongit-project-"));
    roots.push(root);
    const sourceDir = join(root, "src");
    mkdirSync(sourceDir);
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(sourceDir, "index.js"), "export const value = 1;\n");

    const { api, handlers } = makeMockAPI();
    registerSessionHooks(api);
    await handlers.session_start?.(
      { type: "session_start", reason: "startup" },
      makeContext(sourceDir),
    );

    const result = await handlers.before_agent_start?.(
      { type: "before_agent_start", systemPrompt: "base", prompt: "hi" },
      makeContext(sourceDir),
    ) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toContain("Repository Map");
  });

  it("does not scan a directory without project markers", async () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-startup-nonproject-"));
    roots.push(root);
    writeFileSync(join(root, "loose.js"), "export const value = 1;\n");

    const { api, handlers } = makeMockAPI();
    registerSessionHooks(api);
    await handlers.session_start?.(
      { type: "session_start", reason: "startup" },
      makeContext(root),
    );

    const result = await handlers.before_agent_start?.(
      { type: "before_agent_start", systemPrompt: "base", prompt: "hi" },
      makeContext(root),
    ) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).not.toContain("Repository Map");
    expect(result?.systemPrompt).toContain("SmartRead Tool Guide");
  });
});
