import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { TagsCache, type Tag } from "../../cache.js";

describe("TagsCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-smartread-cache-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caches tags for a file", async () => {
    const cache = new TagsCache(tmpDir);
    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "const x = 1;");

    const tags: Tag[] = [
      { relFname: "test.ts", fname: testFile, line: 1, name: "x", kind: "def" },
    ];

    await cache.init();
    await cache.set(testFile, tags);
    const retrieved = await cache.get(testFile);
    expect(retrieved).toEqual(tags);
  });

  it("returns null for uncached files", async () => {
    const cache = new TagsCache(tmpDir);
    const result = await cache.get("/nonexistent/file.ts");
    expect(result).toBeNull();
  });

  it("returns null for deleted files", async () => {
    const cache = new TagsCache(tmpDir);
    const testFile = join(tmpDir, "temp.ts");
    writeFileSync(testFile, "content");

    const tags: Tag[] = [
      { relFname: "temp.ts", fname: testFile, line: 1, name: "x", kind: "def" },
    ];
    await cache.init();
    await cache.set(testFile, tags);

    // Delete the file and verify cache invalidates
    rmSync(testFile);
    const retrieved = await cache.get(testFile);
    expect(retrieved).toBeNull();
  });

  it("invalidates cache when mtime changes", async () => {
    const cache = new TagsCache(tmpDir);
    const testFile = join(tmpDir, "versioned.ts");
    writeFileSync(testFile, "v1");

    const tags1: Tag[] = [
      { relFname: "versioned.ts", fname: testFile, line: 1, name: "v1", kind: "def" },
    ];
    await cache.init();
    await cache.set(testFile, tags1);

    // Modify the file (new content = new mtime)
    writeFileSync(testFile, "v2");
    const nextMtime = new Date(Date.now() + 2000);
    utimesSync(testFile, nextMtime, nextMtime);

    const retrieved = await cache.get(testFile);
    expect(retrieved).toBeNull();
  });

  it("handles rapid set/get without error", async () => {
    const cache = new TagsCache(tmpDir);
    await cache.init();
    for (let i = 0; i < 100; i++) {
      const f = join(tmpDir, `f${i}.ts`);
      writeFileSync(f, `const x${i} = ${i};`);
      await cache.set(f, [
        { relFname: `f${i}.ts`, fname: f, line: 1, name: `x${i}`, kind: "def" },
      ]);
      await cache.get(f);
    }
  });

  it("tracks cache size", async () => {
    const cache = new TagsCache(tmpDir);
    expect(cache.size).toBe(0);

    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "content");
    await cache.init();
    await cache.set(testFile, []);

    expect(cache.size).toBeGreaterThanOrEqual(1);
  });

  it("clear removes memory entries but disk persists", async () => {
    const cache = new TagsCache(tmpDir);
    const testFile = join(tmpDir, "test.ts");
    writeFileSync(testFile, "content");
    await cache.init();
    await cache.set(testFile, []);

    cache.clear();
    expect(cache.size).toBe(0);
    // Disk cache persists, so get still returns from disk
    const result = await cache.get(testFile);
    expect(result).not.toBeNull();
    expect(result).toEqual([]);
  });
});
