/**
 * Characterization tests for handleSymbol (src/find-symbol-tool.ts).
 *
 * Covers live behavior relied on by grep-cascade.ts: basic name match,
 * LSP-available vs LSP-unavailable fallback, LSP-first ranking, dedup by
 * `relative_path:line`, maxResults cutoff, and fileGlob scoping.
 *
 * The lsp-bridge module is mocked per test (fresh module state via
 * resetModules, since find-symbol-tool caches the bridge instance).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../../../src/lsp/lsp-bridge.js", () => ({ getLSPBridge: vi.fn() }));

type HandleSymbol = (
  query: string,
  maxResults: number,
  includeBody: boolean,
  root: string,
  cwd: string,
  signal?: AbortSignal,
  fileGlob?: string,
) => Promise<{ matches: any[]; totalDefs: number; filesScanned: number }>;

async function loadHandleSymbol(
  workspaceSymbols: ((query: string, root: string) => Promise<any[]>) | null,
): Promise<HandleSymbol> {
  vi.resetModules();
  const lspMod = await import("../../../src/lsp/lsp-bridge.js");
  const mock = lspMod.getLSPBridge as unknown as Mock;
  mock.mockReset();
  mock.mockResolvedValue(workspaceSymbols ? { workspaceSymbol: workspaceSymbols } : null);
  const mod = await import("../../../src/search/find-symbol-tool.js");
  return mod.handleSymbol as HandleSymbol;
}

const noLsp = () => loadHandleSymbol(null);

let workdir: string;

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "find-symbol-")));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const full = join(workdir, rel);
  writeFileSync(full, content, "utf-8");
  return full;
}

describe("handleSymbol", () => {
  it("finds a basic name match via tree-sitter with body on request", async () => {
    write("a.ts", `export function validateToken(token: string) {\n  return token.length > 0;\n}\n\nexport function otherHelper() {\n  return 1;\n}\n`);
    const handleSymbol = await noLsp();

    const result = await handleSymbol("validateToken", 30, true, workdir, workdir);

    const hit = result.matches.find((m) => m.name === "validateToken");
    expect(hit).toBeDefined();
    expect(hit.relative_path).toBe("a.ts");
    expect(hit.line).toBe(1);
    expect(hit.kind).toBe("function");
    expect(hit.name_path).toContain("validateToken");
    expect(hit.body).toContain("validateToken");
    expect(result.totalDefs).toBeGreaterThanOrEqual(2);
    expect(result.filesScanned).toBeGreaterThanOrEqual(1);
  });

  it("falls back to tree-sitter results when LSP is unavailable", async () => {
    write("a.ts", `export function loneWolf() {\n  return 7;\n}\n`);
    const handleSymbol = await noLsp();

    const result = await handleSymbol("loneWolf", 30, false, workdir, workdir);

    expect(result.matches.some((m) => m.name === "loneWolf")).toBe(true);
  });

  it("ranks LSP results before tree-sitter results and dedups by relative_path:line", async () => {
    const fileA = write("a.ts", `export function alphaOne() {\n  return 1;\n}\n\nexport function betaTwo() {\n  return 2;\n}\n`);
    const handleSymbol = await loadHandleSymbol(async () => [
      {
        name: "alphaOne",
        kind: 12,
        location: { uri: `file://${fileA}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } },
        containerName: "NS",
      },
    ]);

    const result = await handleSymbol("alphaOne", 30, false, workdir, workdir);

    // LSP entry first, with container-qualified name path.
    expect(result.matches[0]?.name).toBe("alphaOne");
    expect(result.matches[0]?.name_path).toBe("NS.alphaOne");
    // Same file:line from tree-sitter merged away.
    const alphaHits = result.matches.filter((m) => m.name === "alphaOne");
    expect(alphaHits).toHaveLength(1);
  });

  it("honors the maxResults cutoff", async () => {
    write(
      "many.ts",
      [1, 2, 3, 4, 5].map((n) => `export function cappedFn${n}() {\n  return ${n};\n}`).join("\n"),
    );
    const handleSymbol = await noLsp();

    const result = await handleSymbol("cappedFn", 2, false, workdir, workdir);

    expect(result.matches).toHaveLength(2);
  });

  it("scopes candidates with a cwd-relative fileGlob", async () => {
    write("a.ts", `export function globFooA() {\n  return 1;\n}\n`);
    write("b.ts", `export function globFooB() {\n  return 2;\n}\n`);
    const handleSymbol = await noLsp();

    const result = await handleSymbol("globFoo", 30, false, workdir, workdir, undefined, "a.ts");

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.relative_path).toBe("a.ts");
  });
});
