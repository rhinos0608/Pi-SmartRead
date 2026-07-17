import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SemanticIndex,
  SemanticUnavailableError,
  type SemanticIndexOptions,
} from "../../src/semantic-index.js";
import { SqliteVecStore, type Chunk } from "../../src/sqlite-vec-store.js";

class FakeStore {
  chunks = new Map<number, Chunk>();
  getAllChunksCalls = 0;
  closed = false;

  get chunkCount(): number { return this.chunks.size; }

  replaceFileChunks(filePath: string, chunks: Chunk[]): void {
    this.deleteByFilePath(filePath);
    for (const chunk of chunks) {
      if (this.chunks.has(chunk.id)) throw new Error(`duplicate id ${chunk.id}`);
      this.chunks.set(chunk.id, chunk);
    }
  }

  deleteByFilePath(filePath: string): void {
    for (const [id, chunk] of this.chunks) if (chunk.filePath === filePath) this.chunks.delete(id);
  }

  getAllChunks() {
    this.getAllChunksCalls++;
    return [...this.chunks.values()].map((chunk) => ({
      id: chunk.id,
      filePath: chunk.filePath,
      symbolKind: chunk.symbolKind,
      language: chunk.language,
      codeSnippet: chunk.codeSnippet,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
    }));
  }

  search(query: Float32Array, k: number, filters?: { filePathPrefix?: string }) {
    const rows = [...this.chunks.values()]
      .filter((chunk) => !filters?.filePathPrefix || chunk.filePath === filters.filePathPrefix || chunk.filePath.startsWith(`${filters.filePathPrefix}/`))
      .map((chunk) => ({
        id: chunk.id,
        filePath: chunk.filePath,
        symbolKind: chunk.symbolKind,
        language: chunk.language,
        codeSnippet: chunk.codeSnippet,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        distance: 1 - cosine(query, chunk.embedding),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
    return rows;
  }

  close(): void { this.closed = true; }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

const config = {
  baseUrl: "http://localhost:11434/v1",
  model: "test-model",
  chunkSizeChars: 60,
  chunkOverlapChars: 0,
  maxChunksPerFile: 20,
};

function discover(root: string) {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".pi-smartread") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts") || path.endsWith(".txt")) files.push(path);
    }
  };
  walk(root);
  return Promise.resolve({ files, diagnostics: {} as never });
}

function vectorFor(text: string, dimension = 7): number[] {
  const vector = Array.from({ length: dimension }, () => 0);
  if (/auth|token/i.test(text)) vector[0] = 1;
  else if (/database|schema/i.test(text)) vector[1] = 1;
  else vector[2] = 1;
  return vector;
}

function makeIndex(root: string, overrides: Partial<SemanticIndexOptions> = {}) {
  const stores: FakeStore[] = [];
  const embed = vi.fn(async (request: { inputs: string[] }) => ({
    vectors: request.inputs.map((input) => vectorFor(input)),
  }));
  const index = new SemanticIndex(root, {
    config,
    discoverFiles: discover as never,
    fetchEmbeddings: embed as never,
    storeFactory: ((_path: string, _dimension: number) => {
      const store = new FakeStore();
      stores.push(store);
      return store;
    }) as never,
    ...overrides,
  });
  return { index, stores, embed };
}

describe("SemanticIndex", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "semantic-index-"));
    writeFileSync(join(root, "package.json"), "{}\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("builds independently of the generic incremental hash cache and derives non-384 dimension", async () => {
    mkdirSync(join(root, ".pi-smartread"), { recursive: true });
    writeFileSync(join(root, ".pi-smartread", "file-hashes.json"), JSON.stringify({ version: 1, files: { "a.ts": { hash: "old", mtimeMs: 1, size: 1 } }, directories: {} }));
    writeFileSync(join(root, "a.ts"), "export function authenticateToken(token: string) { return token.length > 0; }\n".repeat(8));
    writeFileSync(join(root, "b.ts"), "export function validateSession(token: string) { return token.length > 1; }\n".repeat(8));
    const { index, stores } = makeIndex(root);

    await index.initialize();
    await index.updateIndex();

    expect(index.getStats()).toMatchObject({ ready: true, dimension: 7, indexedFileCount: 2 });
    expect(stores[0]!.chunkCount).toBeGreaterThan(2);
    const ids = [...stores[0]!.chunks.keys()];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => Number.isSafeInteger(id) && id >= 0)).toBe(true);
  });

  it("reopens matching persisted dimension metadata and isolates model fingerprints", async () => {
    writeFileSync(join(root, "a.ts"), "export const auth = true;\n");
    const embed = (async (request: { inputs: string[] }) => ({ vectors: request.inputs.map((input) => vectorFor(input)) })) as never;
    const first = new SemanticIndex(root, { config, discoverFiles: discover as never, fetchEmbeddings: embed });
    await first.updateIndex();
    expect(first.getStats().dimension).toBe(7);
    first.dispose();

    const reopened = new SemanticIndex(root, { config, discoverFiles: discover as never, fetchEmbeddings: embed });
    await reopened.initialize();
    expect(reopened.getStats()).toMatchObject({ ready: true, dimension: 7, indexedFileCount: 1 });
    reopened.dispose();

    const changedModel = new SemanticIndex(root, {
      config: { ...config, model: "different-model" },
      discoverFiles: discover as never,
      fetchEmbeddings: embed,
    });
    await changedModel.initialize();
    expect(changedModel.isAvailable()).toBe(false);
    changedModel.dispose();
  });

  it("drops orphaned chunks when metadata is missing during a full rebuild", async () => {
    const aPath = join(root, "a.ts");
    const cPath = join(root, "c.ts");
    writeFileSync(aPath, "export const auth = true;\n");
    writeFileSync(cPath, "export const database = true;\n");
    const embed = (async (request: { inputs: string[] }) => ({ vectors: request.inputs.map((input) => vectorFor(input)) })) as never;

    const first = new SemanticIndex(root, { config, discoverFiles: discover as never, fetchEmbeddings: embed });
    await first.updateIndex();
    expect(first.getStats().indexedFileCount).toBe(2);
    first.dispose();

    const cacheDir = join(root, ".pi-smartread");
    const metadataPath = readdirSync(cacheDir).map((name) => join(cacheDir, name)).find((path) => path.endsWith(".json"));
    expect(metadataPath).toBeDefined();
    unlinkSync(metadataPath!);
    unlinkSync(cPath);

    const rebuilt = new SemanticIndex(root, { config, discoverFiles: discover as never, fetchEmbeddings: embed });
    await rebuilt.updateIndex();
    expect(rebuilt.getStats()).toMatchObject({ ready: true, indexedFileCount: 1 });
    const results = await rebuilt.search("database", { topK: 10 });
    expect(results.map((result) => result.filePath)).toEqual(["a.ts"]);
    rebuilt.dispose();

    const dbPath = readdirSync(cacheDir).map((name) => join(cacheDir, name)).find((path) => path.endsWith(".db"));
    expect(dbPath).toBeDefined();
    const store = new SqliteVecStore(dbPath!, 7);
    expect(store.getAllChunks().map((chunk) => chunk.filePath)).not.toContain("c.ts");
    store.close();
  });

  it("retries failed files, replaces modified files, and removes deleted files", async () => {
    writeFileSync(join(root, "a.ts"), "export const auth = true;\n");
    writeFileSync(join(root, "b.ts"), "export const database = true;\n");
    let failB = true;
    const embed = vi.fn(async (request: { inputs: string[] }) => {
      if (failB && request.inputs.some((input) => input.includes("database"))) throw new Error("offline");
      return { vectors: request.inputs.map((input) => vectorFor(input)) };
    });
    const { index, stores } = makeIndex(root, { fetchEmbeddings: embed as never });

    await index.updateIndex();
    expect(index.getStats().indexedFileCount).toBe(1);
    failB = false;
    await index.updateIndex();
    expect(index.getStats().indexedFileCount).toBe(2);

    writeFileSync(join(root, "a.ts"), "export const auth = false; // changed\n");
    unlinkSync(join(root, "b.ts"));
    await index.updateIndex();
    expect(index.getStats().indexedFileCount).toBe(1);
    expect([...stores.at(-1)!.chunks.values()].every((chunk) => chunk.filePath === "a.ts")).toBe(true);
  });

  it("coalesces concurrent startup updates", async () => {
    writeFileSync(join(root, "a.ts"), "export const auth = true;\n");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const embed = vi.fn(async (request: { inputs: string[] }) => {
      await gate;
      return { vectors: request.inputs.map((input) => vectorFor(input)) };
    });
    const { index } = makeIndex(root, { fetchEmbeddings: embed as never });
    const first = index.updateIndex();
    const second = index.updateIndex();
    expect(index.isAvailable()).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("uses whole-corpus BM25 plus semantic RRF and supports directory zero hits", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "auth.ts"), "export const exactNeedle = 'authentication token';\n");
    writeFileSync(join(root, "database.ts"), "export const schema = 'database schema';\n");
    const { index, stores } = makeIndex(root);
    await index.updateIndex();

    const results = await index.search("exactNeedle authentication", { topK: 2 });
    expect(results.map((result) => result.filePath)).toContain("src/auth.ts");
    expect(stores[0]!.getAllChunksCalls).toBeGreaterThan(0);
    await expect(index.search("anything", { pathPrefix: "missing" })).resolves.toEqual([]);
  });

  it("distinguishes query embedding failure from valid zero results", async () => {
    writeFileSync(join(root, "a.ts"), "export const auth = true;\n");
    let failQuery = false;
    const embed = vi.fn(async (request: { inputs: string[] }) => {
      if (failQuery && request.inputs.length === 1 && request.inputs[0] === "query") throw new Error("offline");
      return { vectors: request.inputs.map((input) => vectorFor(input)) };
    });
    const { index } = makeIndex(root, { fetchEmbeddings: embed as never });
    await index.updateIndex();

    await expect(index.search("query", { pathPrefix: "missing" })).resolves.toEqual([]);
    failQuery = true;
    await expect(index.search("query")).rejects.toBeInstanceOf(SemanticUnavailableError);
  });

  it("markFilesStale removes file entries, cleans backing store, and sets completed=false", async () => {
    writeFileSync(join(root, "a.ts"), "export const auth = true;\n");
    writeFileSync(join(root, "b.ts"), "export const database = true;\n");
    const { index, stores } = makeIndex(root);
    await index.updateIndex();

    expect(index.getStats().indexedFileCount).toBe(2);
    expect(stores[0]!.chunkCount).toBeGreaterThan(0);

    const cacheDir = join(root, ".pi-smartread");
    const metaPath = readdirSync(cacheDir)
      .map((name) => join(cacheDir, name))
      .find((p) => p.endsWith(".json"));
    expect(metaPath).toBeDefined();
    expect(JSON.parse(readFileSync(metaPath!, "utf-8")).completed).toBe(true);

    index.markFilesStale(["a.ts"]);

    expect(index.getStats().indexedFileCount).toBe(1);
    expect(JSON.parse(readFileSync(metaPath!, "utf-8")).completed).toBe(false);

    // Backing store: a.ts vectors gone, b.ts vectors remain.
    const remainingChunks = [...stores[0]!.chunks.values()];
    expect(remainingChunks.every((c) => c.filePath !== "a.ts")).toBe(true);
    expect(remainingChunks.some((c) => c.filePath === "b.ts")).toBe(true);

    index.dispose();
  });
});
