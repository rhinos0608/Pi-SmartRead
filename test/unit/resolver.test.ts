import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveDirectory, scorePathByQuery, presortPathsByQuery } from "../../resolver.js";

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
    expect(result.countBeforeCap).toBe(0);
  });
});

describe("scorePathByQuery", () => {
  it("returns 0 when no tokens overlap", () => {
    expect(scorePathByQuery("/src/utils/helper.ts", "database migration")).toBe(0);
  });

  it("returns positive score for basename token match", () => {
    const score = scorePathByQuery("/src/auth/middleware.ts", "auth");
    expect(score).toBeGreaterThan(0);
  });

  it("returns higher score for more token matches", () => {
    const low = scorePathByQuery("/src/auth/middleware.ts", "auth");
    const high = scorePathByQuery("/src/auth/middleware.ts", "auth middleware");
    expect(high).toBeGreaterThanOrEqual(low);
  });

  it("handles path components as separate tokens", () => {
    const score = scorePathByQuery("/src/utils/helper.ts", "utils");
    expect(score).toBeGreaterThan(0);
  });

  it("handles camelCase path tokens", () => {
    // "oAuthHelper" splits into sub-tokens: o, auth, helper
    const score = scorePathByQuery("/src/oAuthHelper.ts", "auth");
    expect(score).toBeGreaterThan(0);
  });
});

describe("presortPathsByQuery", () => {
  it("presorts matching files first", () => {
    const paths = ["/src/db.ts", "/src/auth.ts", "/src/utils.ts"];
    const reordered = presortPathsByQuery(paths, "auth");
    expect(reordered[0]).toBe("/src/auth.ts");
  });

  it("zero-score paths appear after positive-score paths", () => {
    const paths = ["/a.ts", "/b.ts", "/c.ts"];
    const reordered = presortPathsByQuery(paths, "x"); // no match
    // Original order preserved for zeros
    expect(reordered).toEqual(paths);
  });

  it("empty query returns original order", () => {
    const paths = ["/a.ts", "/b.ts"];
    expect(presortPathsByQuery(paths, "")).toEqual(paths);
    expect(presortPathsByQuery(paths, "   ")).toEqual(paths);
  });

  it("single file returns same array", () => {
    const paths = ["/a.ts"];
    expect(presortPathsByQuery(paths, "a")).toEqual(paths);
  });

  it("stable order for equal scores", () => {
    const paths = ["/a.ts", "/b.ts", "/c.ts"];
    const reordered = presortPathsByQuery(paths, "x");
    expect(reordered).toEqual(paths);
  });

  it("presorts by filename matching query in directory context", () => {
    // Simulate directory listing: all paths share a common prefix
    const paths = ["/dir/util.ts", "/dir/auth.ts", "/dir/main.ts"];
    const reordered = presortPathsByQuery(paths, "auth");
    expect(reordered[0]).toBe("/dir/auth.ts");
    // Others in original order
    expect(reordered.slice(1)).toEqual(["/dir/util.ts", "/dir/main.ts"]);
  });

  it("scorePathByQuery returns 0 for empty inputs", () => {
    expect(scorePathByQuery("", "auth")).toBe(0);
    expect(scorePathByQuery("/src/auth.ts", "")).toBe(0);
    expect(scorePathByQuery("", "")).toBe(0);
  });

  it("presortPathsByQuery returns empty array for empty paths", () => {
    expect(presortPathsByQuery([], "auth")).toEqual([]);
  });
});