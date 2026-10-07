/**
 * Equivalence coverage for the symbol-channel scan (src/search/find-symbol-tool.ts).
 *
 * Latency step 2 (D32) reuses one tree-sitter Parser + compiled Query per
 * language instead of constructing both per file. Behaviour must be
 * identical: same ordered hits, metadata, snippets, limits, provenance.
 * These tests pin the full ordered match objects for representative
 * queries over a mixed-language fixture, plus run-twice determinism and
 * the maxResults/includeBody contract.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lsp/lsp-bridge.js", () => ({ getLSPBridge: vi.fn(async () => null) }));

type HandleSymbol = (
  query: string,
  maxResults: number,
  includeBody: boolean,
  root: string,
  cwd: string,
  signal?: AbortSignal,
  fileGlob?: string,
) => Promise<{ matches: any[]; totalDefs: number; filesScanned: number }>;

let workdir: string;

beforeEach(async () => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "find-symbol-equiv-")));
  const files: Record<string, string> = {
    "a.ts": `export function alphaOne() {\n  return 1;\n}\n\nexport class Outer {\n  inner() {\n    return 2;\n  }\n}\n`,
    "b.ts": `export function sharedName() {\n  return "b";\n}\n\nexport function betaTwo() {\n  return 3;\n}\n`,
    "c.ts": `export function sharedName() {\n  return "c";\n}\n`,
    "d.js": `function jsHelper() {\n  return 1;\n}\n`,
    "notes.txt": `alphaOne sharedName Outer`,
  };
  mkdirSync(join(workdir, "sub"), { recursive: true });
  files["sub/e.ts"] = `export function subFn() {\n  return 4;\n}\n`;
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(workdir, rel), content, "utf-8");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

async function load(): Promise<HandleSymbol> {
  vi.resetModules();
  const { getLSPBridge } = await import("../../../src/lsp/lsp-bridge.js");
  (getLSPBridge as unknown as { mockResolvedValue: (v: null) => void }).mockResolvedValue(null);
  const mod = await import("../../../src/search/find-symbol-tool.js");
  return mod.handleSymbol as HandleSymbol;
}

describe("symbol scan equivalence", () => {
  it("pins the full ordered hit for an exact match, body included", async () => {
    const handleSymbol = await load();
    const result = await handleSymbol("alphaOne", 30, true, workdir, workdir);
    expect(result.matches).toEqual([
      {
        name: "alphaOne",
        kind: "function",
        relative_path: "a.ts",
        line: 1,
        end_line: 3,
        name_path: "alphaOne",
        body: "function alphaOne() {\n  return 1;\n}",
      },
    ]);
    expect(result.totalDefs).toBeGreaterThanOrEqual(6);
    // Second run over the same fixture is byte-identical (no scan-state leaks).
    const again = await handleSymbol("alphaOne", 30, true, workdir, workdir);
    expect(again).toEqual(result);
  });

  it("returns same-file-ordered hits for a name defined in two files", async () => {
    const handleSymbol = await load();
    const result = await handleSymbol("sharedName", 30, false, workdir, workdir);
    expect(result.matches).toEqual([
      {
        name: "sharedName",
        kind: "function",
        relative_path: "b.ts",
        line: 1,
        end_line: 3,
        name_path: "sharedName",
        body: undefined,
      },
      {
        name: "sharedName",
        kind: "function",
        relative_path: "c.ts",
        line: 1,
        end_line: 3,
        name_path: "sharedName",
        body: undefined,
      },
    ]);
    const again = await handleSymbol("sharedName", 30, false, workdir, workdir);
    expect(again).toEqual(result);
  });

  it("matches a dotted query against the container-qualified name path", async () => {
    const handleSymbol = await load();
    const result = await handleSymbol("Outer.inner", 30, false, workdir, workdir);
    expect(result.matches).toEqual([
      {
        name: "inner",
        kind: "method",
        relative_path: "a.ts",
        line: 6,
        end_line: 8,
        name_path: "Outer.inner",
        body: undefined,
      },
    ]);
  });

  it("extracts JavaScript symbols now that the bundled query compiles", async () => {
    // The bundled javascript query previously used aider-only predicates
    // (#strip!) that the installed tree-sitter binding rejects, so .js
    // files contributed nothing. With the query fixed, d.js contributes
    // its definition; .txt still has no language and stays empty.
    const handleSymbol = await load();
    const js = await handleSymbol("jsHelper", 30, false, workdir, workdir);
    expect(js.matches).toHaveLength(1);
    expect(js.matches[0]).toMatchObject({ name: "jsHelper", relative_path: "d.js", line: 1 });
    // Unsupported .txt contributes no definitions.
    const txt = await handleSymbol("notes", 30, false, workdir, workdir);
    expect(txt.matches).toEqual([]);
  });

  it("honors maxResults and omits the body unless requested", async () => {
    const handleSymbol = await load();
    const capped = await handleSymbol("sharedName", 1, false, workdir, workdir);
    expect(capped.matches).toHaveLength(1);
    expect(capped.matches[0]).toHaveProperty("body", undefined);
    const full = await handleSymbol("betaTwo", 30, false, workdir, workdir);
    expect(full.matches[0]).toHaveProperty("body", undefined);
    const withBody = await handleSymbol("betaTwo", 30, true, workdir, workdir);
    expect(withBody.matches[0]?.body).toContain("betaTwo");
  });
});
