/**
 * W2 (state-root fix): scan scope vs cache root split for the
 * inspect / RepoMap / resolveSymbol / TagsCache cluster.
 *
 * Contract under test:
 * - The scan scope stays the caller-supplied path (map/symbol results are
 *   relative to it, unchanged).
 * - The tags cache persists ONLY at the canonical state root (git top
 *   level here), never at a nested scan dir. No state root → memory-only.
 * - Cache entries are keyed by (canonical scan root, absolute file path),
 *   so two scanDirs sharing one state-root cache dir never read each
 *   other's relFname-relative entries.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoMap } from "../../../src/repomap.js";
import { resolveSymbol } from "../../../src/structural/symbol-resolver.js";
import { CACHE_VERSION, TagsCache, type Tag } from "../../../src/structural/cache.js";
import { executeDirectoryInspect } from "../../../src/inspect/inspect-directory.js";

const cleanupRoots: string[] = [];
afterEach(() => {
  while (cleanupRoots.length > 0) {
    rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
  }
});

/** Realpathed mkdtemp root so expectations match canonical state-root paths. */
function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupRoots.push(root);
  return root;
}

/** Git fixture with a nested scan dir: <repo>/src/lsp/{foo,bar}.ts */
function makeGitRepo(prefix: string, withGitMarker = true): string {
  const repo = tempRoot(prefix);
  if (withGitMarker) mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "src", "lsp"), { recursive: true });
  writeFileSync(join(repo, "src", "lsp", "foo.ts"), "export function fooFn() { return 1; }\n");
  writeFileSync(
    join(repo, "src", "lsp", "bar.ts"),
    "import { fooFn } from './foo';\nexport const bar = fooFn();\n",
  );
  return repo;
}

const TAGS_CACHE_DIR = ".pi-smartread.tags.cache";

describe("RepoMap — scan scope vs state-root cache", () => {
  it("maps a nested scan dir unchanged but writes the tags cache only at the repo root", async () => {
    const repo = makeGitRepo("repomap-scope-");
    const scanDir = join(repo, "src", "lsp");

    const rm = new RepoMap(scanDir);
    const result = await rm.getRepoMap({ forceRefresh: true });

    // Scan scope unchanged: relFnames are relative to the scan dir.
    expect(result.map).toContain("foo.ts");
    expect(result.stats.totalFiles).toBe(2);

    // Cache at the state root only — never under the scan dir or its parents.
    expect(existsSync(join(repo, TAGS_CACHE_DIR))).toBe(true);
    expect(existsSync(join(repo, "src", TAGS_CACHE_DIR))).toBe(false);
    expect(existsSync(join(scanDir, TAGS_CACHE_DIR))).toBe(false);
  });

  it("reuses the state-root cache: a fresh RepoMap instance over the same scan dir returns the same map", async () => {
    const repo = makeGitRepo("repomap-warm-");
    const scanDir = join(repo, "src", "lsp");

    const cold = await new RepoMap(scanDir).getRepoMap({ forceRefresh: true });
    // New instance → new TagsCache → entries must come off the shared
    // state-root disk cache with relFname still relative to scanDir.
    const warm = await new RepoMap(scanDir).getRepoMap({ forceRefresh: true });

    expect(warm.map).toBe(cold.map);
    expect(existsSync(join(repo, TAGS_CACHE_DIR))).toBe(true);
    expect(existsSync(join(scanDir, TAGS_CACHE_DIR))).toBe(false);
  });

  it("scan scope is unchanged: an identical tree with no state root (memory-only) yields the identical map", async () => {
    const gitRepo = makeGitRepo("repomap-eq-git-");
    const plainDir = makeGitRepo("repomap-eq-plain-", false); // no .git, no marker → no state root

    const gitMap = await new RepoMap(join(gitRepo, "src", "lsp")).getRepoMap({ forceRefresh: true });
    const plainMap = await new RepoMap(join(plainDir, "src", "lsp")).getRepoMap({ forceRefresh: true });

    expect(gitMap.map).toBe(plainMap.map);
    expect(gitMap.stats.totalFiles).toBe(plainMap.stats.totalFiles);
    expect(gitMap.stats.totalTags).toBe(plainMap.stats.totalTags);
    // Same post-scan cache population on both sides of the split.
    expect(gitMap.stats.cacheSize).toBe(plainMap.stats.cacheSize);
    // Memory-only side persists nothing; git side persists at its root.
    expect(existsSync(join(plainDir, TAGS_CACHE_DIR))).toBe(false);
    expect(existsSync(join(gitRepo, TAGS_CACHE_DIR))).toBe(true);
  });

  it("keeps cache keys correct across scanDirs sharing one state root (root scan then subdir scan)", async () => {
    const repo = makeGitRepo("repomap-collide-a-");

    const rootMap = await new RepoMap(repo).getRepoMap({ forceRefresh: true });
    // Root scan sees the file relative to the repo root.
    expect(rootMap.map).toContain("src/lsp/foo.ts");

    const subMap = await new RepoMap(join(repo, "src", "lsp")).getRepoMap({ forceRefresh: true });
    // Same absolute file, other scanDir: must NOT inherit the root scan's
    // relFname from the shared cache dir.
    expect(subMap.map).toContain("foo.ts");
    expect(subMap.map).not.toContain("src/lsp/foo.ts");
  });

  it("keeps cache keys correct across scanDirs sharing one state root (subdir scan then root scan)", async () => {
    const repo = makeGitRepo("repomap-collide-b-");

    const subMap = await new RepoMap(join(repo, "src", "lsp")).getRepoMap({ forceRefresh: true });
    expect(subMap.map).toContain("foo.ts");
    expect(subMap.map).not.toContain("src/lsp/foo.ts");

    const rootMap = await new RepoMap(repo).getRepoMap({ forceRefresh: true });
    expect(rootMap.map).toContain("src/lsp/foo.ts");
  });
});

describe("inspect directory mode — state-root cache", () => {
  it("inspect {mode:directory} on repo/src/lsp maps the subdir but caches only at the repo root", async () => {
    const repo = makeGitRepo("inspect-dir-");

    const res: any = await executeDirectoryInspect({
      cwd: repo,
      path: "src/lsp",
      sessionFilePath: join(repo, "session.json"),
    } as any);

    expect(res.mode).toBe("directory");
    expect(res.contentText).toContain("foo.ts");
    expect(existsSync(join(repo, TAGS_CACHE_DIR))).toBe(true);
    expect(existsSync(join(repo, "src", TAGS_CACHE_DIR))).toBe(false);
    expect(existsSync(join(repo, "src", "lsp", TAGS_CACHE_DIR))).toBe(false);
  });
});

describe("resolveSymbol — state-root cache", () => {
  it("resolveSymbol(repo/src) writes nothing under src/", async () => {
    const repo = makeGitRepo("resolve-symbol-");
    const srcDir = join(repo, "src");

    const resolution = await resolveSymbol(srcDir, "fooFn", undefined, undefined, 5);

    // Scan scope unchanged: resolution works and paths are src-relative.
    expect(resolution.definitions.length).toBeGreaterThan(0);
    expect(resolution.definitions[0]!.file).toBe(join("lsp", "foo.ts"));

    expect(existsSync(join(srcDir, TAGS_CACHE_DIR))).toBe(false);
    expect(existsSync(join(repo, TAGS_CACHE_DIR))).toBe(true);
  });
});

describe("TagsCache — version bump", () => {
  it("CACHE_VERSION 4: init wipes a stale v3 cache dir at the state root", async () => {
    const repo = makeGitRepo("tagscache-v3-");
    const cacheDir = join(repo, TAGS_CACHE_DIR);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "version.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(cacheDir, "stale-entry.json"), "{}");

    const cache = new TagsCache(repo);
    await cache.init();

    expect(CACHE_VERSION).toBe(4);
    // v3 entries are gone; the dir is re-versioned to the current format.
    expect(existsSync(join(cacheDir, "stale-entry.json"))).toBe(false);
    const ver = JSON.parse(readFileSync(join(cacheDir, "version.json"), "utf-8"));
    expect(ver.version).toBe(4);
    expect(cache.hasDiskPersistence).toBe(true);
  });
});

describe("TagsCache — state-root guard", () => {
  it("is memory-only with no canonical state root: no dir created, tags still cached in memory", async () => {
    const plain = tempRoot("tagscache-noroot-");
    const file = join(plain, "a.ts");
    writeFileSync(file, "export const a = 1;\n");

    const cache = new TagsCache(plain);
    await cache.init();
    expect(cache.hasDiskPersistence).toBe(false);

    const tags: Tag[] = [{ relFname: "a.ts", fname: file, line: 1, name: "a", kind: "def" }];
    await cache.set(file, tags);

    expect(await cache.get(file)).toEqual(tags);
    expect(existsSync(join(plain, TAGS_CACHE_DIR))).toBe(false);
  });

  it("persists at the state root when the scan dir is a nested subdir", async () => {
    const repo = makeGitRepo("tagscache-root-");
    const file = join(repo, "src", "lsp", "foo.ts");

    const cache = new TagsCache(join(repo, "src", "lsp"));
    await cache.init();
    expect(cache.hasDiskPersistence).toBe(true);

    const tags: Tag[] = [{ relFname: "foo.ts", fname: file, line: 1, name: "fooFn", kind: "def" }];
    await cache.set(file, tags);

    expect(existsSync(join(repo, TAGS_CACHE_DIR))).toBe(true);
    expect(existsSync(join(repo, "src", TAGS_CACHE_DIR))).toBe(false);
    expect(existsSync(join(repo, "src", "lsp", TAGS_CACHE_DIR))).toBe(false);
  });

  it("does not collide when two scanDirs share one state-root cache dir", async () => {
    const repo = makeGitRepo("tagscache-collide-");
    const file = join(repo, "src", "lsp", "foo.ts");

    const rootCache = new TagsCache(repo);
    const subCache = new TagsCache(join(repo, "src", "lsp"));
    await rootCache.init();
    await subCache.init();

    const rootTags: Tag[] = [{ relFname: join("src", "lsp", "foo.ts"), fname: file, line: 1, name: "fooFn", kind: "def" }];
    const subTags: Tag[] = [{ relFname: "foo.ts", fname: file, line: 1, name: "fooFn", kind: "def" }];
    await rootCache.set(file, rootTags);
    await subCache.set(file, subTags);

    // Each scanDir reads back exactly what it wrote — keys are namespaced
    // by scan root even though both entries live in the same cache dir.
    expect(await rootCache.get(file)).toEqual(rootTags);
    expect(await subCache.get(file)).toEqual(subTags);
  });

  it("a cold TagsCache instance misses entries written by a different scanDir", async () => {
    const repo = makeGitRepo("tagscache-coldmiss-");
    const file = join(repo, "src", "lsp", "foo.ts");

    const writer = new TagsCache(repo);
    await writer.init();
    await writer.set(file, [
      { relFname: join("src", "lsp", "foo.ts"), fname: file, line: 1, name: "fooFn", kind: "def" },
    ]);

    // New instance for a DIFFERENT scanDir: must not return the other
    // scanDir's relFname-relative entry (which would corrupt its map).
    const reader = new TagsCache(join(repo, "src", "lsp"));
    await reader.init();
    expect(await reader.get(file)).toBeNull();

    // ...but an instance for the SAME scanDir gets a disk hit.
    const sameRoot = new TagsCache(repo);
    await sameRoot.init();
    expect((await sameRoot.get(file))?.[0]?.relFname).toBe(join("src", "lsp", "foo.ts"));
  });
});
