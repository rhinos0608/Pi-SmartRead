/**
 * Tests for import-based dependency mapping fallback.
 * Uses temp directories with JS/TS/Python fixtures to verify
 * import extraction, path resolution, and in-degree ranking.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepoMap } from "../../repomap.js";

describe("RepoMap — import-based fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "repomap-import-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty map for empty directory", async () => {
    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });
    expect(result.map).toBe("");
    expect(result.stats!.totalFiles).toBe(0);
    expect(result.stats!.rankMethod).toBe("import-based");
  });

  it("ranks files by import in-degree", async () => {
    // 3 files: utils.ts ← main.ts, helper.ts ← main.ts
    // utils.ts has in-degree 2 (imported by main.ts and helper.ts)
    // helper.ts has in-degree 1 (imported by main.ts)
    // main.ts has in-degree 0
    writeFileSync(
      join(tmpDir, "utils.ts"),
      "export function helper() { return 1; }\n",
    );
    writeFileSync(
      join(tmpDir, "helper.ts"),
      "import { helper } from './utils';\nexport function process() { return helper() * 2; }\n",
    );
    writeFileSync(
      join(tmpDir, "main.ts"),
      "import { helper } from './utils';\nimport { process } from './helper';\nconsole.log(helper(), process());\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });

    // Should have found 3 files
    expect(result.stats!.totalFiles).toBe(3);
    expect(result.stats!.rankMethod).toBe("import-based");
    expect(result.stats!.importEdges).toBeGreaterThanOrEqual(2);

    // rankedTags should be sorted by in-degree descending
    // utils.ts has in-degree 2 (imported by main.ts and helper.ts) → rank 1
    // helper.ts has in-degree 1 (imported by main.ts) → rank 0.5
    // main.ts has in-degree 0 → rank 0
    expect(result.rankedTags.length).toBe(3);
    expect(result.rankedTags[0]!.tag.relFname).toBe("utils.ts");
    expect(result.rankedTags[0]!.rank).toBeGreaterThan(
      result.rankedTags[1]!.rank,
    );
    expect(result.rankedTags[1]!.tag.relFname).toBe("helper.ts");
    expect(result.rankedTags[1]!.rank).toBeGreaterThan(
      result.rankedTags[2]!.rank,
    );
  });

  it("handles CJS require() imports", async () => {
    writeFileSync(
      join(tmpDir, "config.js"),
      "module.exports = { port: 3000 };\n",
    );
    writeFileSync(
      join(tmpDir, "app.js"),
      "const config = require('./config');\nconsole.log(config.port);\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });

    expect(result.stats!.totalFiles).toBe(2);
    // config.js should have in-degree 1
    expect(result.rankedTags[0]!.tag.relFname).toBe("config.js");
  });

  it("handles Python imports", async () => {
    writeFileSync(
      join(tmpDir, "utils.py"),
      "def helper(): pass\n",
    );
    writeFileSync(
      join(tmpDir, "main.py"),
      "from utils import helper\nhelper()\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });

    expect(result.stats!.totalFiles).toBe(2);
    // utils.py should rank higher (imported by main.py)
    expect(result.rankedTags[0]!.tag.relFname).toBe("utils.py");
  });

  it("ignores bare package imports (node_modules)", async () => {
    writeFileSync(
      join(tmpDir, "utils.ts"),
      "export function helper() { return 1; }\n",
    );
    writeFileSync(join(tmpDir, "main.ts"), [
      "import { helper } from './utils';",
      "import express from 'express';",
      "console.log(helper());",
    ].join("\n"));

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });

    // main.ts imports express (bare) and ./utils (resolved)
    // Bare imports should be ignored — they don't affect in-degree
    expect(result.stats!.totalFiles).toBe(2);
    expect(result.rankedTags[0]!.tag.relFname).toBe("utils.ts");
  });

  it("respects excludeUnranked option", async () => {
    writeFileSync(
      join(tmpDir, "utils.ts"),
      "export function helper() { return 1; }\n",
    );
    writeFileSync(
      join(tmpDir, "main.ts"),
      "import { helper } from './utils';\nconsole.log(helper());\n",
    );
    writeFileSync(
      join(tmpDir, "orphan.ts"),
      "// no imports in or out\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({
      useImportBased: true,
      excludeUnranked: true,
    });

    // orphan.ts has in-degree 0 and should be excluded
    const relFiles = result.rankedTags.map((rt) => rt.tag.relFname);
    expect(relFiles).toContain("utils.ts");
    expect(relFiles).not.toContain("orphan.ts");
  });

  it("focusFiles boost target file ranks", async () => {
    writeFileSync(
      join(tmpDir, "core.ts"),
      "export function core() { return 1; }\n",
    );
    writeFileSync(
      join(tmpDir, "plugin.ts"),
      "import { core } from './core';\nexport function plugin() { return core() * 2; }\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({
      useImportBased: true,
      // Without focus — plugin.ts is lower-ranked (in-degree 0)
      // With focus on plugin.ts — it should be boosted
      focusFiles: ["plugin.ts"],
    });

    // plugin.ts should be boosted by focus personalization
    const pluginRank = result.rankedTags.find(
      (rt) => rt.tag.relFname === "plugin.ts",
    );
    expect(pluginRank).toBeDefined();
    const coreRank = result.rankedTags.find(
      (rt) => rt.tag.relFname === "core.ts",
    );
    expect(coreRank).toBeDefined();

    // With focus boost, plugin.ts should be ranked higher than core.ts
    const pluginIdx = result.rankedTags.findIndex(
      (rt) => rt.tag.relFname === "plugin.ts",
    );
    const coreIdx = result.rankedTags.findIndex(
      (rt) => rt.tag.relFname === "core.ts",
    );
    expect(pluginIdx).toBeLessThan(coreIdx);
  });

  it("respects mapTokens budget in output", async () => {
    // Create many files so the map exceeds a tiny budget
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(tmpDir, `file${i}.ts`), `export const x${i} = ${i};\n`);
    }
    // Add imports to create ranking
    writeFileSync(
      join(tmpDir, "importer.ts"),
      Array.from({ length: 19 }, (_, i) => `import { x${i} } from './file${i}';`).join("\n"),
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({
      useImportBased: true,
      mapTokens: 100, // Small budget
    });

    expect(result.map.length).toBeGreaterThan(0);
    // Token count should be within budget (rough estimate)
    expect(result.tokenCount).toBeLessThanOrEqual(120); // allow some slop
  });

  it("reports importEdges stat correctly", async () => {
    writeFileSync(
      join(tmpDir, "a.ts"),
      "export const a = 1;\n",
    );
    writeFileSync(
      join(tmpDir, "b.ts"),
      "import { a } from './a';\nexport const b = a + 1;\n",
    );
    writeFileSync(
      join(tmpDir, "c.ts"),
      "import { b } from './b';\nexport const c = b + 1;\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });

    // Edges: b.ts → a.ts, c.ts → b.ts = 2 edges
    // But c.ts also transitively... no, only direct imports
    expect(result.stats!.importEdges).toBe(2);
  });

  it("handles TypeScript triple-slash reference directives", async () => {
    writeFileSync(
      join(tmpDir, "types.d.ts"),
      "export interface User { name: string; }\n",
    );
    writeFileSync(
      join(tmpDir, "app.ts"),
      '/// <reference path="./types.d.ts" />\nconst user: User = { name: "test" };\n',
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });

    // types.d.ts should be imported by app.ts
    expect(result.stats!.totalFiles).toBe(2);
    const typeRank = result.rankedTags.find(
      (rt) => rt.tag.relFname === "types.d.ts",
    );
    expect(typeRank).toBeDefined();
    expect(typeRank!.rank).toBeGreaterThan(0);
  });

  it("does not produce self-import edges", async () => {
    writeFileSync(
      join(tmpDir, "self.ts"),
      "import { something } from './self';\nexport const something = 1;\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });

    // Self-import edge should not count — in-degree of self.ts should be 0
    expect(result.stats!.importEdges).toBe(0);
    expect(result.rankedTags[0]!.rank).toBe(0);
  });

  it("resolves tsconfig path aliases (e.g. @/utils → ./src/utils)", async () => {
    // Create a src directory with aliased modules
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "core.ts"), "export function core() { return 1; };\n");
    writeFileSync(
      join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
          },
        },
      }),
    );
    // main.ts uses the @ alias
    writeFileSync(
      join(tmpDir, "main.ts"),
      "import { core } from '@/core';\nconsole.log(core());\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({ useImportBased: true });

    // core.ts should have in-degree 1 (imported by main.ts via @ alias)
    expect(result.stats!.totalFiles).toBe(2); // src/core.ts, main.ts
    const coreEntry = result.rankedTags.find(
      (rt) => rt.tag.relFname === "src/core.ts",
    );
    expect(coreEntry).toBeDefined();
    expect(coreEntry!.rank).toBeGreaterThan(0);
  });

  it("compact output uses single-line summaries", async () => {
    writeFileSync(
      join(tmpDir, "utils.ts"),
      "export function helper() { return 1; }\nexport function format() { return ''; }\n",
    );
    writeFileSync(
      join(tmpDir, "main.ts"),
      "import { helper, format } from './utils';\nconsole.log(helper());\n",
    );

    const rm = new RepoMap(tmpDir);
    const result = await rm.getRepoMap({
      useImportBased: true,
      compact: true,
    });

    // Compact output should NOT contain code blocks
    expect(result.map).not.toContain("export function");
    expect(result.map).not.toContain("{");
    // Compact output should have one line per file
    const lines = result.map.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(result.rankedTags.length);
    // Each line should match the compact format
    for (const line of lines) {
      expect(line).toMatch(/\(refs: \d+\)/);
    }
  });
});
