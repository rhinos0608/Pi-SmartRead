import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectMonorepo, expandToMonorepoRoots } from "../../src/monorepo-detector.js";

function writeProjectFile(root: string, path: string, content: string): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), content, "utf-8");
}

describe("monorepo detector", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    while (cleanupRoots.length > 0) {
      rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("supports object-form package.json workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-monorepo-obj-"));
    cleanupRoots.push(root);

    writeProjectFile(
      root,
      "package.json",
      JSON.stringify({ workspaces: { packages: ["packages/*"] } }),
    );
    writeProjectFile(root, "packages/a/package.json", JSON.stringify({ name: "a" }));
    writeProjectFile(root, "packages/b/package.json", JSON.stringify({ name: "b" }));

    const mono = detectMonorepo(root);
    expect(mono?.packages.map((path) => path.replace(`${root}/`, "")).sort()).toEqual([
      "packages/a",
      "packages/b",
    ]);
  });

  it("expands prefix and nested workspace globs to package roots", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-monorepo-glob-"));
    cleanupRoots.push(root);

    writeProjectFile(
      root,
      "package.json",
      JSON.stringify({ workspaces: ["plugin-*", "packages/*/src"] }),
    );
    writeProjectFile(root, "plugin-auth/package.json", JSON.stringify({ name: "plugin-auth" }));
    writeProjectFile(root, "plugin-ui/package.json", JSON.stringify({ name: "plugin-ui" }));
    writeProjectFile(root, "packages/core/package.json", JSON.stringify({ name: "core" }));
    writeProjectFile(root, "packages/core/src/index.ts", "export const core = true;\n");

    const mono = detectMonorepo(root);
    expect(mono?.packages.map((path) => path.replace(`${root}/`, "")).sort()).toEqual([
      "packages/core",
      "plugin-auth",
      "plugin-ui",
    ]);

    const expanded = expandToMonorepoRoots(join(root, "packages/core"));
    expect(expanded.map((path) => path.replace(`${root}/`, "")).sort()).toEqual([
      "packages/core",
      "plugin-auth",
      "plugin-ui",
    ]);
  });
});
