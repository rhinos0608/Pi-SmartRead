/**
 * F5 semantic-index fingerprint GC.
 *
 * After the CURRENT fingerprint's index opens successfully, stale index files
 * in `<stateRoot>/.pi-smartread/` are deleted — keeping the current
 * fingerprint plus the single most recently modified other fingerprint.
 * Only exact `semantic-index-*` patterns are ever touched; everything else
 * in the directory must survive. Best-effort: errors are logged, never thrown.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SemanticIndex } from "../../../src/indexing/semantic-index.js";
import type { EmbedRequest } from "../../../src/indexing/embedding.js";

const config = {
  baseUrl: "http://localhost:11434/v1",
  model: "gc-test-model",
  chunkSizeChars: 60,
  chunkOverlapChars: 0,
  maxChunksPerFile: 20,
};

/** Same shapes the GC treats as candidate index files (mirrors src patterns). */
const SUFFIXED_CANDIDATE = /^semantic-index-([0-9a-f]{16})(?:\.db(?:-wal|-shm)?|\.json)$/;
const LEGACY_CANDIDATE = /^semantic-index(?:\.db(?:-wal|-shm)?|\.json)$/;

let root: string;
let cacheDir: string;

function makeStateRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "package.json"), "{}\n");
  return dir;
}

const fetchEmbeddings = (async (request: EmbedRequest) => ({
  vectors: request.inputs.map(() => [1, 0, 0, 0, 0, 0, 0]),
})) as never;

function makeIndex(target: string, overrides: Record<string, unknown> = {}) {
  return new SemanticIndex(target, {
    config,
    fetchEmbeddings,
    ...overrides,
  } as never);
}

/** Build the current fingerprint's index once (real store, real metadata). */
async function buildCurrentIndex(target: string): Promise<string> {
  writeFileSync(join(target, "a.ts"), "export const auth = true;\n");
  const index = makeIndex(target);
  await index.updateIndex();
  index.dispose();
  const json = readdirSync(join(target, ".pi-smartread")).find((n) =>
    /^semantic-index-[0-9a-f]{16}\.json$/.test(n),
  );
  expect(json).toBeDefined();
  return json!.slice("semantic-index-".length, -".json".length);
}

function setMtime(path: string, year: number): void {
  const t = new Date(`${year}-01-02T03:04:05.000Z`);
  utimesSync(path, t, t);
}

function createGroup(dir: string, suffix: string, year: number, opts: { wal?: boolean; shm?: boolean } = {}): void {
  const db = join(dir, `semantic-index-${suffix}.db`);
  const json = join(dir, `semantic-index-${suffix}.json`);
  writeFileSync(db, `stale db ${suffix}`);
  writeFileSync(json, `{"stale": "${suffix}"}`);
  setMtime(db, year);
  setMtime(json, year);
  if (opts.wal) {
    const wal = join(dir, `semantic-index-${suffix}.db-wal`);
    writeFileSync(wal, "");
    setMtime(wal, year);
  }
  if (opts.shm) {
    const shm = join(dir, `semantic-index-${suffix}.db-shm`);
    writeFileSync(shm, "");
    setMtime(shm, year);
  }
}

function createLegacy(dir: string, year: number): void {
  for (const name of ["semantic-index.db", "semantic-index.json", "semantic-index.db-wal"]) {
    const path = join(dir, name);
    writeFileSync(path, "legacy");
    setMtime(path, year);
  }
}

/** Decoy files that must NEVER be touched by the GC. */
function createUnrelated(dir: string): string[] {
  const names = [
    "file-hashes.json",
    "index-coverage.json",
    "graph-snapshot.json.gz",
    "graph-mutations.jsonl",
    "README.md",
    "semantic-index-zzzzzzzzzzzzzzzz.db", // not hex
    "semantic-index-000000000000000g.db", // not hex
    "semantic-index-000000000000000.db", // 15 chars
    "semantic-index-00000000000000000.db", // 17 chars
    "semantic-index-notes.txt",
  ];
  for (const name of names) writeFileSync(join(dir, name), `keep ${name}`);
  return names;
}

/**
 * Every file the GC is allowed to consider must belong to one of the two
 * allowed fingerprints — i.e. exactly the right files remain.
 */
function expectOnlyGroupsRemain(remaining: string[], allowedSuffixes: string[]): void {
  const candidates = remaining.filter((n) => SUFFIXED_CANDIDATE.test(n) || LEGACY_CANDIDATE.test(n));
  for (const name of candidates) {
    const suffix = LEGACY_CANDIDATE.test(name) ? "" : SUFFIXED_CANDIDATE.exec(name)![1]!;
    expect(allowedSuffixes).toContain(suffix);
  }
}

beforeEach(() => {
  root = makeStateRoot("semantic-gc-");
  cacheDir = join(root, ".pi-smartread");
  mkdirSync(cacheDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("semantic-index fingerprint GC", () => {
  it("on initialize: keeps current + most recent other, deletes the rest, never touches unrelated files", async () => {
    const current = await buildCurrentIndex(root);
    expect(current === "0000000000000001" || current === "0000000000000002").toBe(false);

    createGroup(cacheDir, "0000000000000001", 2020, { wal: true, shm: true }); // stale
    createGroup(cacheDir, "0000000000000002", 2021); // most recent other → keep
    createLegacy(cacheDir, 2019); // legacy → stale
    const unrelated = createUnrelated(cacheDir);

    const index = makeIndex(root);
    await index.initialize();
    expect(index.isAvailable()).toBe(true);
    index.dispose();

    const remaining = readdirSync(cacheDir);
    // Kept: current fingerprint group + newest other fingerprint.
    expect(remaining).toContain(`semantic-index-${current}.db`);
    expect(remaining).toContain(`semantic-index-${current}.json`);
    expect(remaining).toContain("semantic-index-0000000000000002.db");
    expect(remaining).toContain("semantic-index-0000000000000002.json");
    // Deleted: older other fingerprint incl. -wal/-shm siblings, legacy group.
    for (const gone of [
      "semantic-index-0000000000000001.db",
      "semantic-index-0000000000000001.json",
      "semantic-index-0000000000000001.db-wal",
      "semantic-index-0000000000000001.db-shm",
      "semantic-index.db",
      "semantic-index.json",
      "semantic-index.db-wal",
    ]) {
      expect(remaining).not.toContain(gone);
    }
    // Exactness: no GC-candidate file outside the two allowed groups remains …
    expectOnlyGroupsRemain(remaining, [current, "0000000000000002"]);
    // … and every unrelated file survived.
    for (const name of unrelated) expect(remaining).toContain(name);
  });

  it("on first successful open during updateIndex: same retention, stale pre-existing groups removed", async () => {
    createGroup(cacheDir, "0000000000000001", 2020, { wal: true });
    createGroup(cacheDir, "0000000000000002", 2021);
    createLegacy(cacheDir, 2019);
    const unrelated = createUnrelated(cacheDir);

    writeFileSync(join(root, "a.ts"), "export const auth = true;\n");
    const index = makeIndex(root);
    await index.updateIndex();
    index.dispose();

    const remaining = readdirSync(cacheDir);
    const staleSuffixes = ["0000000000000001", "0000000000000002"];
    const currentMatch = remaining
      .map((n) => SUFFIXED_CANDIDATE.exec(n))
      .find((m) => m !== null && !staleSuffixes.includes(m[1]!));
    expect(currentMatch).not.toBeNull();
    const current = currentMatch![1]!;
    expect(staleSuffixes).not.toContain(current);
    expect(remaining).toContain("semantic-index-0000000000000002.db");
    expect(remaining).not.toContain("semantic-index-0000000000000001.db");
    expect(remaining).not.toContain("semantic-index-0000000000000001.db-wal");
    expect(remaining).not.toContain("semantic-index.db");
    expect(remaining).not.toContain("semantic-index.json");
    expect(remaining).not.toContain("semantic-index.db-wal");
    expectOnlyGroupsRemain(remaining, [current, "0000000000000002"]);
    for (const name of unrelated) expect(remaining).toContain(name);
  });

  it("best-effort: a directory squatting on a stale pattern never throws and does not block other deletions", async () => {
    const current = await buildCurrentIndex(root);

    // 0003 is a DIRECTORY named like a stale db (must be attempted, fails,
    // logged); 0004 is a normal stale file (must still be deleted);
    // 0005 is the most recent other fingerprint → kept.
    const dirGroup = join(cacheDir, "semantic-index-0000000000000003.db");
    mkdirSync(dirGroup);
    writeFileSync(join(dirGroup, "inner.txt"), "x");
    setMtime(dirGroup, 2019);
    createGroup(cacheDir, "0000000000000004", 2018);
    createGroup(cacheDir, "0000000000000005", 2021);

    const index = makeIndex(root);
    await expect(index.initialize()).resolves.toBeUndefined();
    expect(index.isAvailable()).toBe(true);
    index.dispose();

    const remaining = readdirSync(cacheDir);
    expect(remaining).toContain("semantic-index-0000000000000005.db"); // newest other kept
    expect(remaining).toContain(`semantic-index-${current}.db`); // current kept
    expect(remaining).not.toContain("semantic-index-0000000000000004.db"); // stale removed
    expect(existsSync(dirGroup)).toBe(true); // rmSync without recursive failed → logged, kept
    expect(readdirSync(join(dirGroup))).toEqual(["inner.txt"]); // contents untouched
  });

  it("does not run when the current fingerprint's store fails to open (GC happens only after a successful open)", async () => {
    const current = await buildCurrentIndex(root);
    createGroup(cacheDir, "0000000000000001", 2020, { wal: true });
    createGroup(cacheDir, "0000000000000002", 2021);
    createLegacy(cacheDir, 2019);
    const unrelated = createUnrelated(cacheDir);

    const failing = makeIndex(root, {
      storeFactory: (() => {
        throw new Error("open failed");
      }) as never,
    });
    await failing.initialize();
    expect(failing.isAvailable()).toBe(false);

    const remaining = readdirSync(cacheDir);
    expect(remaining).toContain(`semantic-index-${current}.json`); // state unchanged
    expect(remaining).toContain("semantic-index-0000000000000001.db");
    expect(remaining).toContain("semantic-index-0000000000000002.db");
    expect(remaining).toContain("semantic-index.db");
    for (const name of unrelated) expect(remaining).toContain(name);
  });

  it("F4 fail-closed: no GC at a nested non-state root, even with littered index files", async () => {
    // Seed real, current-fingerprint artifacts at the state root, then copy
    // them (plus stale groups) into a nested non-root.
    await buildCurrentIndex(root);
    const nested = join(root, "nested");
    const nestedCache = join(nested, ".pi-smartread");
    mkdirSync(nestedCache, { recursive: true });
    cpSync(cacheDir, nestedCache, { recursive: true });
    createGroup(nestedCache, "0000000000000001", 2020, { wal: true });
    createGroup(nestedCache, "0000000000000002", 2021);
    createLegacy(nestedCache, 2019);
    const before = readdirSync(nestedCache).sort();

    const index = makeIndex(nested);
    await index.initialize();
    // Fail-closed: the copied on-disk index is not reopened at a non-root.
    expect(index.isAvailable()).toBe(false);
    index.dispose();
    expect(readdirSync(nestedCache).sort()).toEqual(before);
  });
});
