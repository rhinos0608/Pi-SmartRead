import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocumentSymbols: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock("../../src/lsp-bridge.js", () => ({
  getLSPBridge: vi.fn(async () => ({
    getDocumentSymbols: mocks.getDocumentSymbols,
  })),
}));

import { RepoMap } from "../../src/repomap.js";

describe("RepoMap LSP fallback", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    mocks.getDocumentSymbols.mockClear();
  });

  it("does not query LSP for every sparse file in an unfocused repository map", async () => {
    root = mkdtempSync(join(tmpdir(), "repomap-lsp-fallback-"));
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n", "utf8");

    const result = await new RepoMap(root).getRepoMap({ compact: true });

    expect(result.map).toContain("index.ts");
    expect(mocks.getDocumentSymbols).not.toHaveBeenCalled();
  }, 2_000);

  it("bounds LSP fallback latency for an explicitly focused sparse file", async () => {
    root = mkdtempSync(join(tmpdir(), "repomap-lsp-focused-"));
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n", "utf8");

    const started = performance.now();
    const result = await new RepoMap(root).getRepoMap({
      compact: true,
      focusFiles: ["index.ts"],
      allowLspFallback: true,
    });

    expect(result.map).toContain("index.ts");
    expect(mocks.getDocumentSymbols).toHaveBeenCalledTimes(1);
    expect(performance.now() - started).toBeLessThan(1_800);
  }, 2_000);
});
