/** Symlinked-cwd regression: deep-search relative display paths must stay workspace-relative. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let realDir = "";
let linkDir = "";

beforeEach(() => {
  realDir = realpathSync(mkdtempSync(join(tmpdir(), "deep-symlink-real-")));
  mkdirSync(join(realDir, "src"), { recursive: true });
  writeFileSync(join(realDir, "src", "a.ts"), "export const x = 1;\n");
  linkDir = `${realDir}-link`;
  try { rmSync(linkDir, { recursive: true, force: true }); } catch { /* ignore */ }
  symlinkSync(realDir, linkDir, "dir");
});

afterEach(() => {
  rmSync(linkDir, { recursive: true, force: true });
  rmSync(realDir, { recursive: true, force: true });
});

describe("deep-search symlinked cwd", () => {
  it("normalizes canonical candidate paths against a symlinked cwd", async () => {
    const lsp = await import("../../../src/search/deep-search-lsp.js") as unknown as Record<string, (cwd: string, p: string) => string>;
    const core = await import("../../../src/search/deep-search.js") as unknown as Record<string, (cwd: string, p: string) => string>;
    const semantic = await import("../../../src/search/deep-search-semantic.js") as unknown as Record<string, (cwd: string, p: string) => string>;
    const graph = await import("../../../src/search/deep-search-graph.js") as unknown as Record<string, (cwd: string, p: string) => string>;
    // Canonical candidate path as produced by LSP URIs / discovery (real path).
    const canonical = join(realDir, "src", "a.ts");
    for (const [label, fn] of Object.entries({ lsp: lsp.toRelativePath, core: core.toRelativePath, semantic: semantic.toRelativePath, graph: graph.toRelativePath })) {
      expect(typeof fn, `${label} exports toRelativePath`).toBe("function");
      expect(fn?.(linkDir, canonical), `${label}`).toBe("src/a.ts");
    }
  });
});
