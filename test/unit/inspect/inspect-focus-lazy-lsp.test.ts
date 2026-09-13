/**
 * Reviewer finding: directory-mode inspect with `focus` must not spawn LSP
 * via repomap fallback unless navigation/diagnostics was explicitly requested.
 * Lazy-start contract: only navigation/diagnostics params may trigger LSP spawn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  getLSPBridge: vi.fn(async () => ({
    getDocumentSymbols: vi.fn(async () => []),
    isAvailable: () => true,
  })),
  spawn: vi.fn((..._args: unknown[]) => {
    throw new Error("spawn should not be called - lazy LSP contract violated");
  }),
}));

vi.mock("node:child_process", async () => {
  const actual: any = await vi.importActual("node:child_process");
  return { ...actual, spawn: mocks.spawn };
});

vi.mock("../../src/lsp-bridge.js", () => ({
  getLSPBridge: mocks.getLSPBridge,
  getProjectLSPInfo: vi.fn(() => ({ supportedLanguages: [], servers: [] })),
  resetLSPBridge: vi.fn(),
}));

import { executeDirectoryInspect } from "../../src/inspect.js";

let workdir: string;

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "inspect-focus-lazy-")));
  mkdirSync(join(workdir, "src"), { recursive: true });
  // sparse file (<5 tags) so repomap fallback would have triggered LSP if allowed
  writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(workdir, "src", "b.ts"), "export const b = 2;\n", "utf8");
  mocks.getLSPBridge.mockClear();
  mocks.spawn.mockClear();
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("directory inspect focus lazy LSP", () => {
  it("with focus and no navigation/diagnostics does NOT spawn LSP (no getLSPBridge + no spawn)", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/abc.jsonl",
      focus: ["src/a.ts"],
    });
    expect(result.mode).toBe("directory");
    expect(mocks.getLSPBridge).not.toHaveBeenCalled();
    // real spawn-spy: would fail if any code path slipped through to child_process.spawn
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("with focus AND navigation DOES allow LSP fallback (gate opens)", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/abc.jsonl",
      focus: ["src/a.ts"],
      navigation: { operation: "workspaceSymbols", query: "a" },
    } as any);
    expect(result.mode).toBe("directory");
    // navigation triggers inspector path; repomap LSP fallback is now gated behind this flag so getLSPBridge should have been attempted
    expect(mocks.getLSPBridge).toHaveBeenCalled();
  });

  it("with focus AND diagnostics DOES allow LSP fallback", async () => {
    mocks.getLSPBridge.mockClear();
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/abc.jsonl",
      focus: ["src/a.ts"],
      diagnostics: { waitMs: 10, maxPerFile: 1 },
    } as any);
    expect(result.mode).toBe("directory");
    expect(mocks.getLSPBridge).toHaveBeenCalled();
  });
});
