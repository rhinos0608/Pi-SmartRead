/**
 * Tests for TagsCache.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TagsCache, type Tag } from "../../cache.js";

describe("TagsCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tags-cache-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches and retrieves tags for a file", () => {
    const cache = new TagsCache(tmpDir);
    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "const x = 1;");

    const tags: Tag[] = [
      { relFname: "test.ts", fname: testFile, line: 1, name: "x", kind: "def" },
    ];

    cache.set(testFile, tags);
    const retrieved = cache.get(testFile);
    expect(retrieved).toEqual(tags);
  });

  it("returns null for uncached files", () => {
    const cache = new TagsCache(tmpDir);
    const result = cache.get("/nonexistent/file.ts");
    expect(result).toBeNull();
  });

  it("returns null for deleted files", () => {
    const cache = new TagsCache(tmpDir);
    const testFile = join(tmpDir, "temp.ts");
    writeFileSync(testFile, "content");

    const tags: Tag[] = [
      { relFname: "temp.ts", fname: testFile, line: 1, name: "x", kind: "def" },
    ];
    cache.set(testFile, tags);

    // Delete the file and verify cache invalidates
    rmSync(testFile);
    const retrieved = cache.get(testFile);
    expect(retrieved).toBeNull();
  });

  it("invalidates cache when mtime changes", () => {
    const cache = new TagsCache(tmpDir);
    const testFile = join(tmpDir, "versioned.ts");
    writeFileSync(testFile, "v1");

    const tags1: Tag[] = [
      { relFname: "versioned.ts", fname: testFile, line: 1, name: "v1", kind: "def" },
    ];
    cache.set(testFile, tags1);

    // Modify the file (new content = new mtime)
    writeFileSync(testFile, "v2");
    const nextMtime = new Date(Date.now() + 2000);
    utimesSync(testFile, nextMtime, nextMtime);

    const retrieved = cache.get(testFile);
    expect(retrieved).toBeNull();
  });

  it("handles rapid set/get without error", () => {
    const cache = new TagsCache(tmpDir);
    expect(() => {
      for (let i = 0; i < 100; i++) {
        const f = join(tmpDir, `f${i}.ts`);
        writeFileSync(f, `const x${i} = ${i};`);
        cache.set(f, [
          { relFname: `f${i}.ts`, fname: f, line: 1, name: `x${i}`, kind: "def" },
        ]);
        cache.get(f);
      }
    }).not.toThrow();
  });

  it("tracks cache size", () => {
    const cache = new TagsCache(tmpDir);
    expect(cache.size).toBe(0);

    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "content");
    cache.set(testFile, []);

    expect(cache.size).toBeGreaterThanOrEqual(1);
  });

  it("clear removes memory entries but disk persists", () => {
    const cache = new TagsCache(tmpDir);
    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "content");
    cache.set(testFile, []);

    cache.clear();
    expect(cache.size).toBe(0);
    // Disk cache persists, so get still returns from disk
    const result = cache.get(testFile);
    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });
});
