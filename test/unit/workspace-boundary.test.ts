import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalPath,
  getAllowedRoot,
  isWithinRoot,
  resolveWorkspaceDirectory,
  resolveWorkspaceFile,
  resolveWorkspacePath,
} from "../../src/workspace-boundary.js";

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

describe("getAllowedRoot", () => {
  it("returns null when no env var is set", () => {
    expect(getAllowedRoot("/", {})).toBeNull();
  });

  it("resolves relative env value against cwd", () => {
    const tmp = mkdtempSync(join(tmpdir(), "smartread-allowed-"));
    roots.push(tmp);
    mkdirSync(join(tmp, "project"), { recursive: true });
    const env = { PI_SMARTREAD_ALLOWED_ROOT: "project" } as NodeJS.ProcessEnv;
    const result = getAllowedRoot(tmp, env);
    expect(result).toBe(canonicalPath(join(tmp, "project")));
  });

  it("accepts absolute env value as-is", () => {
    const tmp = mkdtempSync(join(tmpdir(), "smartread-allowed-"));
    roots.push(tmp);
    const env = { PI_SMARTREAD_ALLOWED_ROOT: tmp } as NodeJS.ProcessEnv;
    const result = getAllowedRoot("/", env);
    expect(result).toBe(canonicalPath(tmp));
  });

  it("throws when env path does not exist", () => {
    const env = { PI_SMARTREAD_ALLOWED_ROOT: "/nonexistent/" + Date.now() } as NodeJS.ProcessEnv;
    expect(() => getAllowedRoot("/", env)).toThrow(/does not exist/);
  });

  it("falls back to CBM_ALLOWED_ROOT when PI_SMARTREAD_ALLOWED_ROOT is not set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "smartread-allowed-"));
    roots.push(tmp);
    const env = { CBM_ALLOWED_ROOT: tmp } as NodeJS.ProcessEnv;
    const result = getAllowedRoot("/", env);
    expect(result).toBe(canonicalPath(tmp));
  });
});

describe("isWithinRoot", () => {
  it("returns true when target is inside root", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-iswithin-"));
    roots.push(root);
    mkdirSync(join(root, "sub", "deep"), { recursive: true });
    expect(isWithinRoot(root, join(root, "sub"))).toBe(true);
    expect(isWithinRoot(root, join(root, "sub", "deep"))).toBe(true);
  });

  it("returns true for root itself", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-iswithin-"));
    roots.push(root);
    expect(isWithinRoot(root, root)).toBe(true);
  });

  it("returns false for path traversal attempts", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-iswithin-"));
    roots.push(root);
    const malicious = join(root, "..", "..", "etc", "passwd");
    expect(isWithinRoot(root, malicious)).toBe(false);
  });

  it("returns false for completely outside path", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-iswithin-"));
    const outside = mkdtempSync(join(tmpdir(), "smartread-outside-"));
    roots.push(root, outside);
    expect(isWithinRoot(root, outside)).toBe(false);
  });

  it("handles symlinked paths correctly (resolves canonical before comparison)", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-iswithin-"));
    const inner = join(root, "target");
    const outside = mkdtempSync(join(tmpdir(), "smartread-symlink-"));
    roots.push(root, outside);
    mkdirSync(inner, { recursive: true });
    const link = join(root, "link_to_outside");
    symlinkSync(outside, link);
    // Symlink points outside root, so after resolution it should be outside
    expect(isWithinRoot(root, link)).toBe(false);
  });
});
