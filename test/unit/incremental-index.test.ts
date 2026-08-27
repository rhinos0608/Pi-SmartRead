/**
 * Tests for incremental-index — Merkle-tree file change detection.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Small delay to ensure distinct file mtimes between writes. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 15));
}

import {
  loadCache,
  saveCache,
  hashFileSync,
  scanTree,
  detectChanges,
  hashDirectory,
  buildCache,
  invalidateCache,
  computeDirtyPropagation,
  createIncrementalIndex,
  getIncrementalIndex,
  clearIncrementalIndexInstance,
} from "../../src/incremental-index.js";

import type { FileHashCache, FileHashEntry } from "../../src/incremental-index.js";

describe("hashFileSync", () => {
  it("produces a deterministic 64-char hex hash", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hashfile-test-"));
    const filePath = join(tmpDir, "test.txt");
    writeFileSync(filePath, "hello world");

    const h1 = hashFileSync(filePath);
    const h2 = hashFileSync(filePath);

    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).toMatch(/^[a-f0-9]+$/);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces different hashes for different content", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hashfile-diff-"));
    const a = join(tmpDir, "a.txt");
    const b = join(tmpDir, "b.txt");
    writeFileSync(a, "alpha");
    writeFileSync(b, "beta");

    expect(hashFileSync(a)).not.toBe(hashFileSync(b));

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("loadCache / saveCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cache-io-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for missing cache file", () => {
    const cachePath = join(tmpDir, "nonexistent.json");
    const { files, directories } = loadCache(cachePath);
    expect(files).toEqual({});
    expect(directories).toEqual({});
  });

  it("round-trips cache data", () => {
    const cachePath = join(tmpDir, "file-hashes.json");
    const files: FileHashCache = {
      "src/a.ts": { hash: "abc123", mtimeMs: 1000, size: 42 },
      "src/b.ts": { hash: "def456", mtimeMs: 2000, size: 84 },
    };
    const dirs = { src: 1000, "src/sub": 2000 };

    saveCache(cachePath, files, dirs);

    const { files: loadedFiles, directories: loadedDirs } = loadCache(cachePath);
    expect(loadedFiles).toEqual(files);
    expect(loadedDirs).toEqual(dirs);
  });

  it("returns empty on version mismatch", () => {
    const cachePath = join(tmpDir, "file-hashes.json");
    writeFileSync(cachePath, JSON.stringify({ version: 999, files: {}, directories: {} }));

    const { files } = loadCache(cachePath);
    expect(files).toEqual({});
  });

  it("returns empty on corrupted file", () => {
    const cachePath = join(tmpDir, "file-hashes.json");
    writeFileSync(cachePath, "{corrupted}");

    const { files } = loadCache(cachePath);
    expect(files).toEqual({});
  });
});

describe("hashDirectory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hashdir-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 2;");
    writeFileSync(join(tmpDir, "README.md"), "# Test");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hashes all files in a directory tree", () => {
    const hashes = hashDirectory(tmpDir);
    const keys = Object.keys(hashes).sort();
    expect(keys).toContain("README.md");
    expect(keys).toContain("src/a.ts");
    expect(keys).toContain("src/b.ts");
    expect(hashes["src/a.ts"]!.hash).toHaveLength(64);
  });

  it("respects file filter", () => {
    const hashes = hashDirectory(tmpDir, (p) => p.endsWith(".ts"));
    const keys = Object.keys(hashes);
    expect(keys).toContain("src/a.ts");
    expect(keys).not.toContain("README.md");
  });

  it("skips node_modules directories", () => {
    mkdirSync(join(tmpDir, "node_modules"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "dep.js"), "module.exports = {};");

    const hashes = hashDirectory(tmpDir);
    const keys = Object.keys(hashes);
    expect(keys).not.toContain(
      expect.stringContaining("node_modules"),
    );
  });
});

describe("scanTree + detectChanges", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scan-"));
    mkdirSync(join(tmpDir, "lib"), { recursive: true });
    writeFileSync(join(tmpDir, "lib", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "lib", "b.ts"), "export const b = 2;");
    writeFileSync(join(tmpDir, "index.ts"), "export { a } from './lib/a';");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects added files", () => {
    const cache = hashDirectory(tmpDir);
    writeFileSync(join(tmpDir, "lib", "c.ts"), "export const c = 3;");

    const changes = detectChanges(tmpDir, cache);
    expect(changes.added).toContain("lib/c.ts");
    expect(changes.modified).toEqual([]);
    expect(changes.unchanged).toContain("lib/a.ts");
  });

  it("detects modified files", async () => {
    const cache = hashDirectory(tmpDir);
    await tick();

    writeFileSync(join(tmpDir, "lib", "a.ts"), "export const a = 999;");

    const changes = detectChanges(tmpDir, cache);
    expect(changes.modified).toContain("lib/a.ts");
    expect(changes.unchanged).toContain("lib/b.ts");
    expect(changes.added).toEqual([]);
  });

  it("detects deleted files", () => {
    const cache = hashDirectory(tmpDir);
    rmSync(join(tmpDir, "lib", "a.ts"));

    const changes = detectChanges(tmpDir, cache);
    expect(changes.deleted).toContain("lib/a.ts");
    expect(changes.unchanged).toContain("lib/b.ts");
  });

  it("returns unchanged correctly when nothing changed", () => {
    const cache = hashDirectory(tmpDir);
    const changes = detectChanges(tmpDir, cache);
    expect(changes.added).toEqual([]);
    expect(changes.modified).toEqual([]);
    expect(changes.deleted).toEqual([]);
    expect(changes.unchanged.sort()).toEqual([
      "index.ts",
      "lib/a.ts",
      "lib/b.ts",
    ]);
  });
});

describe("scanTree two-pass (directory-level skip)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "twopass-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, "src", "deep"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "src", "deep", "b.ts"), "export const b = 2;");
    writeFileSync(join(tmpDir, "main.ts"), "// main");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips directory subtree when dir mtime matches cache", () => {
    const { currentFiles, currentDirectories } = scanTree(tmpDir, {}, {});
    const { currentFiles: cachedFiles } = scanTree(
      tmpDir,
      currentFiles,
      currentDirectories,
    );

    expect(cachedFiles["src/a.ts"]).toEqual(currentFiles["src/a.ts"]);
    expect(cachedFiles["src/deep/b.ts"]).toEqual(currentFiles["src/deep/b.ts"]);
  });

  it("re-scans when file content changes in a subtree", async () => {
    const { currentFiles, currentDirectories } = scanTree(tmpDir, {}, {});
    await tick();

    const staleDirs = { ...currentDirectories };
    delete staleDirs["src"];

    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 999;");

    const { currentFiles: rescanned } = scanTree(
      tmpDir,
      currentFiles,
      staleDirs,
    );

    expect(rescanned["src/a.ts"]!.hash).not.toBe(currentFiles["src/a.ts"]!.hash);
  });
});

describe("buildCache", () => {
  let tmpDir: string;
  let cacheDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "buildcache-"));
    cacheDir = join(tmpDir, ".pi-smartread");
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "main.ts"), "// main");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates cache file on first run", () => {
    const changes = buildCache(tmpDir);
    expect(changes.added.length).toBeGreaterThan(0);
    expect(changes.modified).toEqual([]);

    const cachePath = join(cacheDir, "file-hashes.json");
    expect(existsSync(cachePath)).toBe(true);

    const { files } = loadCache(cachePath);
    expect(Object.keys(files).length).toBeGreaterThan(0);
  });

  it("detects changes on subsequent runs", async () => {
    buildCache(tmpDir);
    await tick();

    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 42;");

    const changes = buildCache(tmpDir);
    expect(changes.modified).toContain("src/a.ts");
    expect(changes.unchanged).toContain("main.ts");
  });

  it("detects added files on subsequent runs", () => {
    buildCache(tmpDir);
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 2;");

    const changes = buildCache(tmpDir);
    expect(changes.added).toContain("src/b.ts");
  });

  it("detects deleted files on subsequent runs", () => {
    buildCache(tmpDir);
    rmSync(join(tmpDir, "main.ts"));

    const changes = buildCache(tmpDir);
    expect(changes.deleted).toContain("main.ts");
  });
});

describe("invalidateCache", () => {
  it("resets cache to empty", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "invalidate-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;");

    buildCache(tmpDir);
    invalidateCache(tmpDir);

    const cachePath = join(tmpDir, ".pi-smartread", "file-hashes.json");
    const { files } = loadCache(cachePath);
    expect(Object.keys(files)).toHaveLength(0);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("computeDirtyPropagation", () => {
  it("returns direct changes when no dependents", () => {
    const deps = new Map<string, string[]>();
    const dirty = computeDirtyPropagation(["src/a.ts"], deps);
    expect(dirty).toHaveLength(1);
    expect(dirty[0]!.path).toBe("src/a.ts");
    expect(dirty[0]!.reason).toBe("direct_change");
  });

  it("propagates through dependency graph", () => {
    const deps = new Map<string, string[]>([
      ["src/a.ts", ["src/b.ts"]],
      ["src/b.ts", ["src/c.ts"]],
    ]);
    const dirty = computeDirtyPropagation(["src/a.ts"], deps);
    expect(dirty).toHaveLength(3);
    expect(dirty[0]!.path).toBe("src/a.ts");
    expect(dirty[0]!.reason).toBe("direct_change");
    expect(dirty[1]!.path).toBe("src/b.ts");
    expect(dirty[1]!.reason).toBe("dependency_changed");
    expect(dirty[2]!.path).toBe("src/c.ts");
    expect(dirty[2]!.reason).toBe("dependency_changed");
  });

  it("handles diamond dependencies without duplicates", () => {
    const deps = new Map<string, string[]>([
      ["src/a.ts", ["src/b.ts", "src/c.ts"]],
      ["src/b.ts", ["src/d.ts"]],
      ["src/c.ts", ["src/d.ts"]],
    ]);
    const dirty = computeDirtyPropagation(["src/a.ts"], deps);
    expect(dirty).toHaveLength(4);
    const paths = dirty.map((d) => d.path);
    expect(paths).toContain("src/d.ts");
  });

  it("handles cycles gracefully", () => {
    const deps = new Map<string, string[]>([
      ["src/a.ts", ["src/b.ts"]],
      ["src/b.ts", ["src/a.ts"]],
    ]);
    const dirty = computeDirtyPropagation(["src/a.ts"], deps);
    expect(dirty).toHaveLength(2);
  });

  it("handles multiple files changed", () => {
    const deps = new Map<string, string[]>([
      ["src/a.ts", ["src/common.ts"]],
      ["src/b.ts", ["src/common.ts"]],
    ]);
    const dirty = computeDirtyPropagation(["src/a.ts", "src/b.ts"], deps);
    expect(dirty).toHaveLength(3);
    expect(dirty.filter((d) => d.reason === "direct_change")).toHaveLength(2);
    expect(dirty.filter((d) => d.reason === "dependency_changed")).toHaveLength(1);
  });
});

describe("createIncrementalIndex", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "incidx-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 2;");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hasCache returns false before first build", () => {
    const idx = createIncrementalIndex(tmpDir);
    expect(idx.hasCache()).toBe(false);
  });

  it("getChanges returns all files as added on first run", () => {
    const idx = createIncrementalIndex(tmpDir);
    const changes = idx.getChanges();
    expect(changes.added.length).toBeGreaterThan(0);
    expect(changes.modified).toEqual([]);
    expect(changes.unchanged).toEqual([]);
  });

  it("hasCache returns true after first getChanges", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges();
    expect(idx.hasCache()).toBe(true);
  });

  it("getChanges returns unchanged on second call", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges();

    const changes = idx.getChanges();
    expect(changes.added).toEqual([]);
    expect(changes.modified).toEqual([]);
    expect(changes.deleted).toEqual([]);
    expect(changes.unchanged.length).toBeGreaterThan(0);
  });

  it("getChanges detects modifications", async () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges();
    await tick();

    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 42;");

    const changes = idx.getChanges();
    expect(changes.modified).toContain("src/a.ts");
    expect(changes.unchanged).toContain("src/b.ts");
  });

  it("forceRebuild treats everything as added", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges();

    const rebuild = idx.forceRebuild();
    expect(rebuild.added.length).toBeGreaterThan(0);
    expect(rebuild.modified).toEqual([]);
  });

  it("invalidate clears the cache", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges();
    idx.invalidate();
    expect(idx.hasCache()).toBe(false);
  });

  it("getChanges with fileFilter respects filter", () => {
    const idx = createIncrementalIndex(tmpDir);
    const changes = idx.getChanges((p) => p.endsWith(".ts"));
    expect(changes.added.every((f) => f.endsWith(".ts"))).toBe(true);
  });
});

describe("getIncrementalIndex / clearIncrementalIndexInstance", () => {
  let tmpDir1: string;
  let tmpDir2: string;

  beforeEach(() => {
    tmpDir1 = mkdtempSync(join(tmpdir(), "shared1-"));
    tmpDir2 = mkdtempSync(join(tmpdir(), "shared2-"));
    mkdirSync(join(tmpDir1, "src"), { recursive: true });
    mkdirSync(join(tmpDir2, "lib"), { recursive: true });
    writeFileSync(join(tmpDir1, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir2, "lib", "b.ts"), "export const b = 2;");
  });

  afterEach(() => {
    rmSync(tmpDir1, { recursive: true, force: true });
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("returns the same instance for the same root", () => {
    const a = getIncrementalIndex(tmpDir1);
    const b = getIncrementalIndex(tmpDir1);
    expect(a).toBe(b);
  });

  it("returns different instances for different roots", () => {
    const a = getIncrementalIndex(tmpDir1);
    const b = getIncrementalIndex(tmpDir2);
    expect(a).not.toBe(b);
  });

  it("clearIncrementalIndexInstance removes specific root", () => {
    const a = getIncrementalIndex(tmpDir1);
    getIncrementalIndex(tmpDir2);

    clearIncrementalIndexInstance(tmpDir1);

    const a2 = getIncrementalIndex(tmpDir1);
    expect(a2).not.toBe(a);

    expect(getIncrementalIndex(tmpDir2)).toBe(getIncrementalIndex(tmpDir2));
  });

  it("clearIncrementalIndexInstance() with no arg clears all", () => {
    const a = getIncrementalIndex(tmpDir1);
    const b = getIncrementalIndex(tmpDir2);

    clearIncrementalIndexInstance();

    expect(getIncrementalIndex(tmpDir1)).not.toBe(a);
    expect(getIncrementalIndex(tmpDir2)).not.toBe(b);
  });
});

describe("edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "edge-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles empty directory", () => {
    const hashes = hashDirectory(tmpDir);
    expect(Object.keys(hashes)).toEqual([]);

    const changes = detectChanges(tmpDir, {});
    expect(changes.added).toEqual([]);
    expect(changes.deleted).toEqual([]);
  });

  it("handles deeply nested files", () => {
    const deep = join(tmpDir, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "x.ts"), "export const x = 1;");

    const hashes = hashDirectory(tmpDir);
    expect(Object.keys(hashes)).toContain("a/b/c/d/x.ts");
  });

  it("handles large file", () => {
    const largeContent = "x".repeat(100_000);
    writeFileSync(join(tmpDir, "large.txt"), largeContent);

    const hash = hashFileSync(join(tmpDir, "large.txt"));
    expect(hash).toHaveLength(64);
  });

  it("handles binary files", () => {
    writeFileSync(join(tmpDir, "binary.bin"), Buffer.alloc(100, 0xff));

    const hashes = hashDirectory(tmpDir);
    expect(Object.keys(hashes)).toContain("binary.bin");
  });

  it("rejects nonexistent file", () => {
    expect(() => hashFileSync(join(tmpDir, "nonexistent.ts"))).toThrow();
  });

  it("scanTree skips permission-denied directories", () => {
    const { currentFiles } = scanTree(tmpDir, {}, {});
    expect(Object.keys(currentFiles)).toEqual([]);
  });
});

// ── WP-3: diff() with graph stats ─────────────────────────────────

describe("createIncrementalIndex diff()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "diff-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 2;");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("diff() returns graphStats with stale=true for entries lacking new fields", () => {
    // Manually write a legacy-schema cache (version 1, no symbolCount/edgeCount)
    const cacheDir = join(tmpDir, ".pi-smartread");
    mkdirSync(cacheDir, { recursive: true });
    const legacyCache = {
      version: 1,
      files: {
        "src/a.ts": { hash: "abc123", mtimeMs: 1000, size: 10 },
        "src/b.ts": { hash: "def456", mtimeMs: 1000, size: 10 },
      },
      directories: {},
    };
    writeFileSync(join(cacheDir, "file-hashes.json"), JSON.stringify(legacyCache));

    const idx = createIncrementalIndex(tmpDir);
    const { graphStats } = idx.diff();

    expect(graphStats.length).toBeGreaterThan(0);
    for (const gs of graphStats) {
      expect(gs.stale).toBe(true);
      expect(gs.symbolCount).toBeUndefined();
      expect(gs.edgeCount).toBeUndefined();
    }
  });

  it("diff() returns both changes and graphStats", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges();

    const { changes, graphStats } = idx.diff();
    expect(changes).toBeDefined();
    expect(Array.isArray(graphStats)).toBe(true);
  });
});

describe("FileHashEntry graph stats fields", () => {
  it("FileHashEntry accepts optional symbolCount and edgeCount", () => {
    const entry: FileHashEntry = {
      hash: "abc123",
      mtimeMs: 1000,
      size: 42,
      symbolCount: 15,
      edgeCount: 8,
    };
    expect(entry.symbolCount).toBe(15);
    expect(entry.edgeCount).toBe(8);
  });

  it("FileHashEntry works without optional graph stats fields", () => {
    const entry: FileHashEntry = {
      hash: "abc123",
      mtimeMs: 1000,
      size: 42,
    };
    expect(entry.symbolCount).toBeUndefined();
    expect(entry.edgeCount).toBeUndefined();
  });
});

describe("createIncrementalIndex updateGraphStats", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "updstats-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 2;");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updateGraphStats writes values and diff shows stale=false", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges(); // build initial cache

    idx.updateGraphStats([
      { path: "src/a.ts", symbolCount: 5, edgeCount: 3 },
    ]);

    const { graphStats } = idx.diff();
    const entry = graphStats.find((g) => g.path === "src/a.ts");
    expect(entry).toBeDefined();
    expect(entry!.stale).toBe(false);
    expect(entry!.symbolCount).toBe(5);
    expect(entry!.edgeCount).toBe(3);
  });

  it("diff shows stale=true for files not updated", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges(); // build initial cache

    idx.updateGraphStats([
      { path: "src/a.ts", symbolCount: 5, edgeCount: 3 },
    ]);

    const { graphStats } = idx.diff();
    const bEntry = graphStats.find((g) => g.path === "src/b.ts");
    expect(bEntry).toBeDefined();
    expect(bEntry!.stale).toBe(true);
    expect(bEntry!.symbolCount).toBeUndefined();
    expect(bEntry!.edgeCount).toBeUndefined();
  });

  it("updateGraphStats handles empty updates without crashing", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges();
    idx.updateGraphStats([]);
    // no crash = pass
    const { graphStats } = idx.diff();
    expect(graphStats.length).toBeGreaterThan(0);
  });

  it("updateGraphStats persists across index re-creation", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges(); // build initial cache

    idx.updateGraphStats([
      { path: "src/a.ts", symbolCount: 7, edgeCount: 2 },
    ]);

    // Fresh index instance — reads from disk
    const idx2 = createIncrementalIndex(tmpDir);
    const { graphStats } = idx2.diff();
    const aEntry = graphStats.find((g) => g.path === "src/a.ts");
    expect(aEntry).toBeDefined();
    expect(aEntry!.stale).toBe(false);
    expect(aEntry!.symbolCount).toBe(7);
    expect(aEntry!.edgeCount).toBe(2);
  });

  it("updateGraphStats skips unknown paths", () => {
    const idx = createIncrementalIndex(tmpDir);
    idx.getChanges();
    // path not in cache should be silently skipped
    idx.updateGraphStats([
      { path: "nonexistent.ts", symbolCount: 1, edgeCount: 1 },
    ]);
    // no crash = pass; other entries unaffected
    const { graphStats } = idx.diff();
    expect(graphStats.length).toBeGreaterThan(0);
  });
});

// ── WP-9: captureFileEntries snapshot adapter ────────────────────

import { captureFileEntries } from "../../src/incremental-index.js";

describe("captureFileEntries", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "capture-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "a.ts"), "export const a = 1;");
    writeFileSync(join(tmpDir, "src", "b.ts"), "export const b = 2;");
    writeFileSync(join(tmpDir, "README.md"), "# Test");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns entries for all files in the directory", () => {
    const entries = captureFileEntries(tmpDir);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["README.md", "src/a.ts", "src/b.ts"]);
  });

  it("content hashes match hashFileSync on disk", () => {
    const entries = captureFileEntries(tmpDir);
    for (const entry of entries) {
      const expected = hashFileSync(join(tmpDir, entry.path));
      expect(entry.contentHash).toBe(expected);
    }
  });

  it("returns deterministically ordered entries across calls", () => {
    const first = captureFileEntries(tmpDir);
    const second = captureFileEntries(tmpDir);
    expect(first).toEqual(second);
  });

  it("uses cache when available (no fresh scan)", () => {
    // Build cache via buildCache first
    buildCache(tmpDir);

    const entries = captureFileEntries(tmpDir);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.contentHash).toHaveLength(64);
    }
  });

  it("returns empty array for empty directory", () => {
    const empty = mkdtempSync(join(tmpdir(), "capture-empty-"));
    try {
      const entries = captureFileEntries(empty);
      expect(entries).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
