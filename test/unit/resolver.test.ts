import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDirectory } from "../../resolver.js";

let tmpDir: string;

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "intent-read-test-")); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

function touch(name: string) { writeFileSync(join(tmpDir, name), `content of ${name}`); }

describe("resolveDirectory", () => {
  it("returns paths of regular files in the directory", () => {
    touch("a.ts");
    touch("b.ts");
    const result = resolveDirectory(tmpDir);
    expect(result.paths).toHaveLength(2);
    expect(result.paths.every((p) => p.endsWith(".ts"))).toBe(true);
  });

  it("returns paths sorted lexicographically", () => {
    touch("c.ts");
    touch("a.ts");
    touch("b.ts");
    const { paths } = resolveDirectory(tmpDir);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });

  it("is not recursive — ignores files in subdirectories", () => {
    touch("top.ts");
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "sub", "nested.ts"), "nested");
    const { paths } = resolveDirectory(tmpDir);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("top.ts");
  });

  it("does not follow symlinks", () => {
    touch("real.ts");
    symlinkSync(join(tmpDir, "real.ts"), join(tmpDir, "link.ts"));
    const { paths } = resolveDirectory(tmpDir);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("real.ts");
  });

  it("caps at 20 files and reports capped status", () => {
    for (let i = 0; i < 25; i++) touch(`file-${i}.ts`);
    const result = resolveDirectory(tmpDir, 20);
    expect(result.paths).toHaveLength(20);
    expect(result.capped).toBe(true);
    expect(result.countBeforeCap).toBe(25);
  });

  it("reports capped false when files are within limit", () => {
    touch("a.ts");
    touch("b.ts");
    const result = resolveDirectory(tmpDir, 20);
    expect(result.capped).toBe(false);
    expect(result.countBeforeCap).toBe(2);
  });

  it("returns empty array for empty directory", () => {
    const result = resolveDirectory(tmpDir);
    expect(result.paths).toEqual([]);
    expect(result.capped).toBe(false);
  });
});