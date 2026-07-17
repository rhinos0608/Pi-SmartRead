import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectMonorepo, expandToMonorepoRoots, detectServiceBoundaries } from "../../src/monorepo-detector.js";

function writeProjectFile(root: string, path: string, content: string): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), content, "utf-8");
}

const cleanupRoots: string[] = [];

describe("monorepo detector", () => {

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

describe("detectServiceBoundaries", () => {
  it("detects boundaries from package.json workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-boundary-"));
    cleanupRoots.push(root);

    writeProjectFile(
      root,
      "package.json",
      JSON.stringify({ workspaces: ["packages/*"] }),
    );
    writeProjectFile(root, "packages/auth/package.json", JSON.stringify({
      name: "@acme/auth",
      dependencies: { "@acme/db": "*" },
    }));
    writeProjectFile(root, "packages/db/package.json", JSON.stringify({
      name: "@acme/db",
      dependencies: {},
    }));

    const result = detectServiceBoundaries(root);
    expect(result.source).toBe("package.json");
    expect(result.services).toHaveLength(2);
    const auth = result.services.find((s) => s.name === "@acme/auth");
    expect(auth).toBeDefined();
    expect(auth!.dependencies).toContain("@acme/db");
    const db = result.services.find((s) => s.name === "@acme/db");
    expect(db).toBeDefined();
    expect(db!.dependencies).toHaveLength(0);
  });

  it("returns empty for non-monorepo", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-boundary-empty-"));
    cleanupRoots.push(root);
    writeProjectFile(root, "package.json", JSON.stringify({ name: "solo" }));

    const result = detectServiceBoundaries(root);
    expect(result.services).toHaveLength(0);
    expect(result.source).toBe("none");
  });

  it("detects docker-compose services when no package.json workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-boundary-dc-"));
    cleanupRoots.push(root);
    writeProjectFile(root, "docker-compose.yml",
      "services:\n  api:\n    build: ./api\n  worker:\n    build: ./worker\n");

    const result = detectServiceBoundaries(root);
    expect(result.source).toBe("docker-compose");
    expect(result.services).toHaveLength(2);
    expect(result.services.map((s) => s.name).sort()).toEqual(["api", "worker"]);
  });
});
