import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPath, resolveWorkspacePath } from "../../workspace-boundary.js";

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

    expect(resolveWorkspacePath(root, file)).toBe(file);
  });

  it("rejects outside paths when user opts into allowed-root enforcement", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-boundary-root-"));
    const outside = mkdtempSync(join(tmpdir(), "smartread-boundary-outside-"));
    roots.push(root, outside);
    mkdirSync(join(root, "src"), { recursive: true });
    const inside = join(root, "src", "main.ts");
    const external = join(outside, "secret.txt");
    writeFileSync(inside, "export const ok = true;");
    writeFileSync(external, "secret");

    const env = { PI_SMARTREAD_ALLOWED_ROOT: root } as NodeJS.ProcessEnv;
    expect(resolveWorkspacePath(root, inside, { env })).toBe(canonicalPath(inside));
    expect(() => resolveWorkspacePath(root, external, { env })).toThrow(/outside allowed root/);
  });
});
