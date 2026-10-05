import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleGrep } from "../../../src/search/search-tool.js";

function writeProjectFile(root: string, path: string, content: string): void {
  mkdirSync(join(root, path.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, path), content);
}

function buildFixture(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeProjectFile(
    root,
    "a.ts",
    `export function alpha() {\n  const x = "NEEDLE_123 here";\n  return x;\n}\n`,
  );
  writeProjectFile(root, "b.json", `{"token":"NEEDLE_123"}\n`);
  writeProjectFile(root, "c.md", `# docs\nnothing relevant here\n`);
  // Filler files with parseable definitions but no text match: these must not
  // affect output, and post-optimization they skip definition extraction.
  for (let i = 0; i < 30; i++) {
    writeProjectFile(
      root,
      `fill/f${i}.ts`,
      `export function filler${i}() {\n  return ${i};\n}\n// filler line\n`,
    );
  }
  return root;
}

type Match = Record<string, unknown>;

function normalizeMatches(matches: Match[], root: string): unknown[] {
  return matches.map((m) => ({ ...m, file: String(m["file"]).replace(root, "<root>") }));
}

describe("deferred definition extraction equivalence", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    while (cleanupRoots.length > 0) {
      rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("returns byte-identical ordered hits, metadata, and snippets vs the pre-change baseline", async () => {
    const root = buildFixture("pi-smartread-grep-equiv-");
    cleanupRoots.push(root);

    const result = await handleGrep(
      "grep-equiv",
      { query: "NEEDLE_123", maxResults: 10 },
      root,
      undefined,
    );
    const details = result.details as unknown as { matches: Match[]; total: number };

    // Baseline captured on the pre-change implementation (same fixture).
    expect(details.total).toBe(2);
    expect(normalizeMatches(details.matches, root)).toEqual([
      {
        group: "definition",
        file: "<root>/a.ts",
        relFile: "a.ts",
        line: 2,
        endLine: 5,
        kind: "function",
        name: "alpha",
        lineText: `  const x = "NEEDLE_123 here";`,
        snippet:
          `       1 | export function alpha() {\n` +
          `       2 |   const x = "NEEDLE_123 here";\n` +
          `       3 |   return x;\n` +
          `       4 | }\n` +
          `       5 | `,
      },
      {
        group: "text",
        file: "<root>/b.json",
        relFile: "b.json",
        line: 1,
        endLine: 2,
        kind: "text",
        name: `{"token":"NEEDLE_123"}`,
        lineText: `{"token":"NEEDLE_123"}`,
        snippet: `       1 | {"token":"NEEDLE_123"}\n       2 | `,
      },
    ]);
  });

  it("honors maxResults identically, including the already-capped path", async () => {
    const root = buildFixture("pi-smartread-grep-equiv-cap-");
    cleanupRoots.push(root);

    const result = await handleGrep(
      "grep-equiv-cap",
      { query: "NEEDLE_123", maxResults: 1 },
      root,
      undefined,
    );
    const details = result.details as unknown as { matches: Match[]; total: number };
    expect(details.matches).toHaveLength(1);
    expect(details.matches[0]?.["relFile"]).toBe("a.ts");
    expect(details.total).toBe(1);
  });

  it("regex queries keep identical owner attribution", async () => {
    const root = buildFixture("pi-smartread-grep-equiv-regex-");
    cleanupRoots.push(root);

    const result = await handleGrep(
      "grep-equiv-regex",
      { query: "NEEDLE_\\d+", matchMode: "regex" },
      root,
      undefined,
    );
    const details = result.details as unknown as { matches: Match[]; total: number };
    expect(details.total).toBe(2);
    expect(details.matches.map((m) => `${m["relFile"]}:${m["line"]}:${m["name"]}`)).toEqual([
      "a.ts:2:alpha",
      `b.json:1:{"token":"NEEDLE_123"}`,
    ]);
  });
});
