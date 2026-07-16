import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPath, resolveWorkspaceDirectory, resolveWorkspaceFile, resolveWorkspacePath } from "../../src/workspace-boundary.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace boundary", () => {
  it("does not restrict paths unless an allowed root env var is set", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-boundary-root-"));
    const outside = mkdtempSync(join(tmpdir(), "smartread-boundary-outside-"));
    roots.push(root, outside);
    const file = join(outside, "note.txt");
    writeFileSync(file, "outside");

    expect(resolveWorkspacePath(root, file)).toBe(canonicalPath(file));
  });

  it("enforces requested file and directory kinds even without an allowed root", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-boundary-kind-"));
    roots.push(root);
    const file = join(root, "note.txt");
    const directory = join(root, "src");
    writeFileSync(file, "note");
    mkdirSync(directory);

    expect(resolveWorkspaceFile(root, file)).toBe(canonicalPath(file));
    expect(resolveWorkspaceDirectory(root, directory)).toBe(canonicalPath(directory));
    expect(() => resolveWorkspaceFile(root, directory)).toThrow(/regular file/);
    expect(() => resolveWorkspaceDirectory(root, file)).toThrow(/directory/);
    expect(resolveWorkspacePath(root, "future.txt", { mustExist: false, kind: "file" })).toBe(join(root, "future.txt"));
  });

  it("no longer rejects outside paths (allowed-root gating removed from explicit operations)", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-boundary-root-"));
    const outside = mkdtempSync(join(tmpdir(), "smartread-boundary-outside-"));
    roots.push(root, outside);
    mkdirSync(join(root, "src"), { recursive: true });
    const inside = join(root, "src", "main.ts");
    const external = join(outside, "secret.txt");
    writeFileSync(inside, "export const ok = true;");
    writeFileSync(external, "secret");

    const env = { PI_SMARTREAD_ALLOWED_ROOT: root } as NodeJS.ProcessEnv;
    // Allowed-root env var is no longer enforced by resolveWorkspacePath;
    // it only gates automatic background indexing via effectiveSemanticRoot.
    expect(resolveWorkspacePath(root, inside, { env })).toBe(canonicalPath(inside));
    expect(resolveWorkspacePath(root, external, { env })).toBe(canonicalPath(external));
  });
});
