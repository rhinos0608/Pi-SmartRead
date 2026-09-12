import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveImportPath,
  resolvePythonImportPath,
  extractDependencies,
  findImportDependents,
  findBarrelReExports,
} from "../../src/structural-imports.js";

function fixtureDir(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `si-${name}-`)));
}

describe("structural-imports", () => {
  describe("resolveImportPath .js->TS", () => {
    let dir: string;
    beforeAll(() => {
      dir = fixtureDir("js-ts");
      writeFileSync(join(dir, "math.ts"), `export const x = 1;\n`);
      writeFileSync(join(dir, "app.ts"), `import "./math.js";\n`);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("maps ./math.js to math.ts", () => {
      expect(resolveImportPath(join(dir, "app.ts"), "./math.js")).toBe(
        join(dir, "math.ts"),
      );
    });

    it("returns undefined for bare third-party specifiers", () => {
      expect(resolveImportPath(join(dir, "app.ts"), "react")).toBeUndefined();
      expect(resolveImportPath(join(dir, "app.ts"), "lodash/fp")).toBeUndefined();
    });
  });

  describe("resolvePythonImportPath dot-only", () => {
    let pkgDir: string;
    let subDir: string;
    beforeAll(() => {
      pkgDir = fixtureDir("py-dot");
      subDir = join(pkgDir, "sub");
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, "__init__.py"), `def helper(): ...\n`);
      writeFileSync(join(pkgDir, "top.py"), `def top(): ...\n`);
    });
    afterAll(() => rmSync(pkgDir, { recursive: true, force: true }));

    it("resolves dot-only to package __init__.py", () => {
      const modFile = join(subDir, "mod.py");
      writeFileSync(modFile, "from . import helper\n");
      expect(resolvePythonImportPath(modFile, ".", "helper")).toBe(
        join(subDir, "__init__.py"),
      );
    });

    it("prefers concrete sibling module for dot-dot import", () => {
      const modFile = join(subDir, "mod.py");
      expect(resolvePythonImportPath(modFile, "..", "top")).toBe(
        join(pkgDir, "top.py"),
      );
    });

    it("leaves absolute stdlib/third-party unresolved", () => {
      const modFile = join(subDir, "mod.py");
      expect(resolvePythonImportPath(modFile, "os")).toBeUndefined();
      expect(resolvePythonImportPath(modFile, "django.db")).toBeUndefined();
    });
  });

  describe("extractDependencies unresolved 3P", () => {
    let dir: string;
    beforeAll(() => {
      dir = fixtureDir("deps");
      writeFileSync(join(dir, "utils.py"), `def helper(): ...\n`);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("TS: skips bare imports, keeps relative", () => {
      const code = `import React from "react";\nimport { x } from "./utils.js";\n`;
      writeFileSync(join(dir, "utils.ts"), `export const x = 1;\n`);
      const deps = extractDependencies(code, join(dir, "a.ts"), "typescript");
      expect(deps.map((d) => d.specifier)).not.toContain("react");
      expect(deps.map((d) => d.specifier)).toContain("./utils.js");
    });

    it("Python: skips absolute, keeps relative", () => {
      const code = `import os\nfrom .utils import helper\n`;
      const deps = extractDependencies(code, join(dir, "main.py"), "python");
      expect(deps.map((d) => d.specifier)).not.toContain("os");
      const rel = deps.find((d) => d.specifier === ".utils");
      expect(rel).toBeDefined();
      expect(rel!.resolvedPath).toBe(join(dir, "utils.py"));
    });
  });

  describe("findBarrelReExports same-dir scan + depth 5", () => {
    let dir: string;
    beforeAll(() => {
      dir = fixtureDir("barrel");
      writeFileSync(join(dir, "internal.ts"), `export const SECRET = 42;\n`);
      writeFileSync(join(dir, "mid.ts"), `export { SECRET } from "./internal.js";\n`);
      writeFileSync(join(dir, "index.ts"), `export { SECRET } from "./mid.js";\n`);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("finds multi-level barrel chain", () => {
      const found = findBarrelReExports(join(dir, "internal.ts"), "typescript", new Set(), 0);
      const paths = found.map((r) => r.barrelFile);
      expect(paths).toContain(join(dir, "mid.ts"));
      expect(paths).toContain(join(dir, "index.ts"));
    });

    it("stops past max depth", () => {
      const found = findBarrelReExports(join(dir, "internal.ts"), "typescript", new Set(), 6);
      expect(found).toEqual([]);
    });
  });

  describe("findImportDependents dedupe", () => {
    let dir: string;
    beforeAll(() => {
      dir = fixtureDir("dependents");
      writeFileSync(join(dir, "target.ts"), `export const x = 1;\n`);
      writeFileSync(
        join(dir, "importer.ts"),
        `import { x } from "./target.js";\nimport { x } from "./target.js";\n`,
      );
      writeFileSync(join(dir, "stdlib.ts"), `import React from "react";\n`);
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("dedupes by file and excludes third-party-only files", async () => {
      const deps = await findImportDependents(join(dir, "target.ts"), dir, "typescript");
      const files = deps.map((d) => d.file);
      expect(files).toContain(join(dir, "importer.ts"));
      expect(files).not.toContain(join(dir, "stdlib.ts"));
      expect(files.filter((f) => f === join(dir, "importer.ts")).length).toBe(1);
    });
  });
});
