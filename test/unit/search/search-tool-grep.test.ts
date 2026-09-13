import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import createSearchTool from "../../src/search-tool.js";

function writeProjectFile(root: string, path: string, content: string | Buffer): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function getMatchLocations(result: unknown): string[] {
  const details = (result as { details?: { matches?: Array<{ relFile: string; line: number }> } }).details;
  return (details?.matches ?? []).map((match) => `${match.relFile}:${match.line}`).sort();
}

describe("search tool combined search", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    while (cleanupRoots.length > 0) {
      rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("finds literals in code bodies even when no definition name matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-grep-body-"));
    cleanupRoots.push(root);
    writeProjectFile(
      root,
      "service.ts",
      `export function calculateTotal(items: number[]): number {
  const marker = "body-only-literal";
  return items.length + marker.length;
}
`,
    );

    const tool = createSearchTool();
    const result = await tool.execute(
      "grep-body",
      { query: "body-only-literal" },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const details = (result as any).details;
    // Combined search: code finds the definition, grep finds the literal text
    expect(details.total).toBeGreaterThanOrEqual(1);
    expect(details.definitionHits).toBeGreaterThanOrEqual(1);
    expect(details.matches[0].name).toBe("calculateTotal");
    expect(details.matches[0].relFile).toBe("service.ts");
  });

  it("searches config, docs, and extensionless text files", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-grep-text-"));
    cleanupRoots.push(root);

    writeProjectFile(root, "config/app.json", `{"token":"SEARCH_TOKEN"}`);
    writeProjectFile(root, "docs/guide.md", `# Guide\nSEARCH_TOKEN in docs\n`);
    writeProjectFile(root, "Procfile", `web: echo SEARCH_TOKEN\n`);

    const tool = createSearchTool();
    const result = await tool.execute(
      "grep-text",
      { query: "SEARCH_TOKEN", maxResults: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    expect(getMatchLocations(result)).toEqual([
      "Procfile:1",
      "config/app.json:1",
      "docs/guide.md:2",
    ]);
  });

  it("respects .gitignore, .ignore, .rgignore, and context-mode include overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-grep-ignore-"));
    cleanupRoots.push(root);

    writeProjectFile(
      root,
      ".gitignore",
      ["ignored.txt", "hidden/", "!restored.txt"].join("\n"),
    );
    writeProjectFile(root, ".ignore", "notes.md\n");
    writeProjectFile(root, ".rgignore", "config.yaml\n");
    writeProjectFile(root, ".context-mode-ignore", "context-off.txt\n");
    writeProjectFile(root, ".context-mode-include", "hidden/keep.txt\n");

    writeProjectFile(root, "ignored.txt", "NEEDLE\n");
    writeProjectFile(root, "restored.txt", "NEEDLE\n");
    writeProjectFile(root, "notes.md", "NEEDLE\n");
    writeProjectFile(root, "config.yaml", "value: NEEDLE\n");
    writeProjectFile(root, "context-off.txt", "NEEDLE\n");
    writeProjectFile(root, "hidden/drop.txt", "NEEDLE\n");
    writeProjectFile(root, "hidden/keep.txt", "NEEDLE\n");

    const tool = createSearchTool();
    const result = await tool.execute(
      "grep-ignore",
      { query: "NEEDLE", maxResults: 20 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    expect(getMatchLocations(result)).toEqual([
      "hidden/keep.txt:1",
      "restored.txt:1",
    ]);
  });

  it("matches rg -n for exact literal hits in fixture repos", async () => {
    try {
      execFileSync("rg", ["--version"], { stdio: "ignore" });
    } catch {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "pi-smartread-grep-rg-"));
    cleanupRoots.push(root);

    mkdirSync(join(root, ".git"), { recursive: true });
    writeProjectFile(root, ".gitignore", "ignored.txt\n");
    writeProjectFile(root, "src/main.ts", `export const one = "EXACT_NEEDLE_123";\n`);
    writeProjectFile(root, "docs/guide.md", `EXACT_NEEDLE_123\n`);
    writeProjectFile(root, "config/app.json", `{"value":"EXACT_NEEDLE_123"}\n`);
    writeProjectFile(root, "Procfile", `web: echo EXACT_NEEDLE_123\n`);
    writeProjectFile(root, "ignored.txt", `EXACT_NEEDLE_123\n`);
    writeProjectFile(root, "binary.bin", Buffer.from([0, 159, 146, 150, 0]));

    const tool = createSearchTool();
    const result = await tool.execute(
      "grep-rg-parity",
      { query: "EXACT_NEEDLE_123", maxResults: 20 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    const searchMatches = getMatchLocations(result);
    const rgMatches = execFileSync(
      "rg",
      ["-n", "--no-heading", "--fixed-strings", "EXACT_NEEDLE_123", "."],
      { cwd: root, encoding: "utf-8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(":").slice(0, 2).join(":").replace(/^\.\//, ""))
      .sort();

    expect(searchMatches).toEqual(rgMatches);
  });
});
