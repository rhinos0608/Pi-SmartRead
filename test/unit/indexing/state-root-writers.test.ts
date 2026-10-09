/**
 * F4 writer guard — every persisting writer from the state-root fix brief
 * runs memory-only / no-op unless its root IS a canonical state root.
 *
 * A canonical state root is the git top level or, outside git, the outermost
 * project-marker directory (`src/workspace/state-root.ts`). "Nested non-root"
 * below means a directory inside a marker root but not itself a root; writes
 * there must create nothing.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCoverage, recordCoverage } from "../../../src/indexing/index-coverage.js";
import { readSnapshot, verifySnapshot, writeSnapshot } from "../../../src/indexing/index-snapshot.js";
import { getIndexLockStatus, withIndexLockSync } from "../../../src/indexing/index-lock.js";
import { EdgeStore } from "../../../src/context-graph.js";
import { buildCache, createIncrementalIndex, invalidateCache } from "../../../src/indexing/incremental-index.js";
import { SemanticIndex } from "../../../src/indexing/semantic-index.js";
import { PersistentEmbeddingCache } from "../../../src/indexing/persistent-embedding-cache.js";
import { handleJudgeCommand, type JudgeCommandDeps } from "../../../src/judge/judge-command.js";
import { resolveMcpJudge } from "../../../src/judge/judge-runtime.js";
import { CloudJudge, CLOUD_JUDGE_DEFAULT_BASE_URL, CLOUD_JUDGE_DEFAULT_MODEL } from "../../../src/judge/cloud-judge.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";
import type { FetchFn } from "../../../src/judge/systemone-client.js";
import type { JudgeNoulInput } from "../../../src/judge/types.js";
import type { EmbedRequest } from "../../../src/indexing/embedding.js";

let projectRoot: string; // canonical (non-git marker) state root
let nested: string; // dir inside the root, not a root itself

/** Marker project root: package.json makes it the outermost (canonical) root. */
function makeProjectRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "package.json"), "{}\n");
  return dir;
}

beforeEach(() => {
  projectRoot = makeProjectRoot("smartread-writers-");
  nested = join(projectRoot, "nested");
  mkdirSync(nested, { recursive: true });
});

afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

// ── index-coverage ───────────────────────────────────────────────────

describe("index-coverage writer guard", () => {
  it("no-ops at a nested non-root and persists at a real state root", () => {
    recordCoverage(nested, { file: "a.ts", phase: "tags", status: "indexed" });
    expect(existsSync(join(nested, ".pi-smartread"))).toBe(false);
    expect(readCoverage(nested)).toEqual([]);

    recordCoverage(projectRoot, { file: "a.ts", phase: "tags", status: "indexed" });
    expect(readCoverage(projectRoot)).toHaveLength(1);
    expect(existsSync(join(projectRoot, ".pi-smartread", "index-coverage.json"))).toBe(true);
  });
});

// ── index-snapshot ───────────────────────────────────────────────────

describe("index-snapshot writer guard", () => {
  it("returns empty string and writes nothing at a nested non-root", () => {
    const written = writeSnapshot(nested, "graph", { nodes: ["a"] }, { fileCount: 1, tagCount: 1, sourceHash: "x" });
    expect(written).toBe("");
    expect(existsSync(join(nested, ".pi-smartread"))).toBe(false);
    expect(readSnapshot(nested, "graph")).toBeNull();
  });

  it("round-trips at a real state root", () => {
    const written = writeSnapshot(projectRoot, "graph", { nodes: ["a"] }, { fileCount: 1, tagCount: 1, sourceHash: "x" });
    expect(written).not.toBe("");
    expect(verifySnapshot(projectRoot, "graph").status).toBe("ok");
  });
});

// ── index-lock ───────────────────────────────────────────────────────

describe("index-lock writer guard", () => {
  it("runs the work unlocked and creates no lock state at a nested non-root", () => {
    let statusDuring: boolean | undefined;
    const result = withIndexLockSync(nested, "file-hashes", () => {
      statusDuring = getIndexLockStatus(nested, "file-hashes").locked;
      return 42;
    });
    expect(result).toBe(42);
    expect(statusDuring).toBe(false);
    expect(existsSync(join(nested, ".pi-smartread"))).toBe(false);
  });

  it("creates and releases a real lock at a state root", () => {
    let statusDuring: boolean | undefined;
    withIndexLockSync(projectRoot, "file-hashes", () => {
      statusDuring = getIndexLockStatus(projectRoot, "file-hashes").locked;
    });
    expect(statusDuring).toBe(true);
    expect(getIndexLockStatus(projectRoot, "file-hashes").locked).toBe(false);
  });
});

// ── edge-store ───────────────────────────────────────────────────────

describe("edge-store writer guard", () => {
  it("refuses to persist at a nested non-root (no mkdir, no log file)", () => {
    const ok = EdgeStore.recordBreakage(nested, join(nested, "a.ts"), join(nested, "b.ts"), "broke", 0.9);
    expect(ok).toBe(false);
    expect(existsSync(join(nested, ".pi-smartread"))).toBe(false);
    expect(EdgeStore.readEdges(nested)).toEqual([]);
  });

  it("persists at a real git root", () => {
    execFileSync("git", ["init"], { cwd: projectRoot, stdio: "ignore" });
    writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(projectRoot, "b.ts"), "export const b = 1;\n");
    const ok = EdgeStore.recordBreakage(projectRoot, join(projectRoot, "a.ts"), join(projectRoot, "b.ts"), "broke", 0.9);
    expect(ok).toBe(true);
    const edges = EdgeStore.readEdges(projectRoot);
    expect(edges).toHaveLength(1);
    expect(existsSync(join(projectRoot, ".pi-smartread", "graph-mutations.jsonl"))).toBe(true);
  });
});

// ── incremental-index (file-hashes) + HARD_SKIP_DIRS ────────────────

describe("incremental-index writer guard", () => {
  it("buildCache/invalidateCache/createIncrementalIndex write nothing at a nested non-root", async () => {
    writeFileSync(join(nested, "a.ts"), "export const a = 1;\n");
    const changes = buildCache(nested);
    expect(changes.added).toContain("a.ts");
    expect(existsSync(join(nested, ".pi-smartread"))).toBe(false);

    invalidateCache(nested);
    expect(existsSync(join(nested, ".pi-smartread"))).toBe(false);

    const inc = createIncrementalIndex(nested);
    await inc.getChanges();
    expect(inc.hasCache()).toBe(false);
    expect(existsSync(join(nested, ".pi-smartread"))).toBe(false);
  });

  it("persists file-hashes.json at a real state root", () => {
    writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
    buildCache(projectRoot);
    expect(existsSync(join(projectRoot, ".pi-smartread", "file-hashes.json"))).toBe(true);
  });

  it("HARD_SKIP_DIRS now skips .pi-smartread.tags.cache and .pi-smartread.embeddings.cache", () => {
    writeFileSync(join(projectRoot, "a.ts"), "export const a = 1;\n");
    mkdirSync(join(projectRoot, ".pi-smartread.tags.cache"), { recursive: true });
    writeFileSync(join(projectRoot, ".pi-smartread.tags.cache", "cached.ts"), "export const cached = 1;\n");
    mkdirSync(join(projectRoot, ".pi-smartread.embeddings.cache"), { recursive: true });
    writeFileSync(join(projectRoot, ".pi-smartread.embeddings.cache", "entry.ts"), "export const entry = 1;\n");

    const changes = buildCache(projectRoot);
    expect(changes.added).toContain("a.ts");
    expect(changes.added.some((f) => f.includes(".pi-smartread"))).toBe(false);
    expect(changes.added.some((f) => f.includes("cached.ts") || f.includes("entry.ts"))).toBe(false);
  });
});

// ── semantic index ───────────────────────────────────────────────────

function vectorFor(_text: string): number[] {
  return [1, 0, 0, 0, 0, 0, 0];
}

function fakeStore() {
  let count = 0;
  return {
    get chunkCount() {
      return count;
    },
    replaceFileChunks(_filePath: string, chunks: Array<{ id: number }>) {
      count += chunks.length;
    },
    deleteByFilePath() {},
    getAllChunks() {
      return [];
    },
    search() {
      return [];
    },
    close() {},
  };
}

const semanticConfig = {
  baseUrl: "http://localhost:11434/v1",
  model: "test-model",
  chunkSizeChars: 60,
  chunkOverlapChars: 0,
  maxChunksPerFile: 20,
};

describe("semantic-index writer guard", () => {
  it("stays memory-only at a nested non-root and never touches pre-existing litter", async () => {
    const aPath = join(nested, "a.ts");
    writeFileSync(aPath, "export const auth = true;\n");
    const litterDir = join(nested, ".pi-smartread");
    mkdirSync(litterDir, { recursive: true });
    writeFileSync(join(litterDir, "file-hashes.json"), "{}");

    const storePaths: string[] = [];
    const index = new SemanticIndex(nested, {
      config: semanticConfig,
      discoverFiles: (() => Promise.resolve({ files: [aPath], diagnostics: {} as never })) as never,
      fetchEmbeddings: (async (request: EmbedRequest) => ({
        vectors: request.inputs.map(() => vectorFor("")),
      })) as never,
      storeFactory: ((p: string) => {
        storePaths.push(p);
        return fakeStore();
      }) as never,
    });

    await index.updateIndex();
    expect(storePaths).toEqual([":memory:"]);
    expect(index.getStats()).toMatchObject({ ready: true });
    // Litter directory untouched: no metadata, no db, no new entries.
    expect(readdirSync(litterDir)).toEqual(["file-hashes.json"]);
    expect(existsSync(join(nested, ".pi-smartread", "semantic-index.json"))).toBe(false);
    index.dispose();
  });

  it("persists metadata at a real state root", async () => {
    const aPath = join(projectRoot, "a.ts");
    writeFileSync(aPath, "export const auth = true;\n");
    const storePaths: string[] = [];
    const index = new SemanticIndex(projectRoot, {
      config: semanticConfig,
      discoverFiles: (() => Promise.resolve({ files: [aPath], diagnostics: {} as never })) as never,
      fetchEmbeddings: (async (request: EmbedRequest) => ({
        vectors: request.inputs.map(() => vectorFor("")),
      })) as never,
      storeFactory: ((p: string) => {
        storePaths.push(p);
        return fakeStore();
      }) as never,
    });

    await index.updateIndex();
    expect(storePaths[0]).toContain(join(projectRoot, ".pi-smartread"));
    const names = readdirSync(join(projectRoot, ".pi-smartread"));
    expect(names.some((n) => /^semantic-index-[0-9a-f]{16}\.json$/.test(n))).toBe(true);
    index.dispose();
  });
});

// ── judge cache dir (judge-runtime / judge-command) ──────────────────

function judgeInput(): JudgeNoulInput {
  const query = "where do we retry failed requests";
  return {
    shared: { query },
    items: [
      {
        id: "u0",
        state: { path: "src/a.ts", symbol: "fn", text: "src/a.ts lines 1-3 symbol fn\n1 | export function fn() {\n2 |   retry();\n3 | }" },
        question: (ref: string) => unitRelevanceQuestion(query, ref),
      },
    ],
  };
}

/** Seeding helper: writes verdicts through a fake transport, no network. */
async function seedVerdictCache(cacheDir: string): Promise<void> {
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String((init as Record<string, unknown> | undefined)?.body ?? "{}")) as {
      questions?: Record<string, unknown>;
    };
    const answers: Record<string, number> = {};
    for (const key of Object.keys(body.questions ?? {})) answers[key] = 0.66;
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchFn;
  const seeder = new CloudJudge({
    apiKey: "test-key",
    baseUrl: CLOUD_JUDGE_DEFAULT_BASE_URL,
    model: CLOUD_JUDGE_DEFAULT_MODEL,
    cacheDir,
    fetchFn,
  });
  await seeder.judgeNouls(judgeInput());
}

function makeStatusCtx(cwd: string, notified: string[]) {
  return {
    cwd,
    modelRegistry: { getApiKeyForProvider: async (_p: string) => undefined },
    ui: {
      notify: (message: string) => {
        notified.push(message);
      },
      confirm: async () => false,
    },
  };
}

function makeStatusDeps(): JudgeCommandDeps {
  return {
    readSettings: () => ({ mode: "off" as const }),
    writeSettings: () => {},
    sidecar: () => undefined as never,
    isInstalled: () => true,
    sidecarDeps: { runCmd: async () => ({ code: 0, stdout: "", stderr: "" }) },
    cacheDir: undefined,
    env: {},
  };
}

describe("judge cache-dir root guard", () => {
  it("/judge status reports no verdict cache at a non-root cwd, reports it at a state root", async () => {
    const atNonRoot: string[] = [];
    await handleJudgeCommand("status", makeStatusCtx(nested, atNonRoot), makeStatusDeps());
    expect(atNonRoot.join("\n")).not.toContain("verdict cache");

    const atRoot: string[] = [];
    await handleJudgeCommand("status", makeStatusCtx(projectRoot, atRoot), makeStatusDeps());
    expect(atRoot.join("\n")).toContain("verdict cache: 0 entries");
  });

  it("resolveMcpJudge uses the workspace cache at a state root (seeded hit, aborted transport)", async () => {
    const savedMode = process.env.PI_SMARTREAD_JUDGE_MODE;
    const savedKey = process.env.PI_SMARTREAD_JUDGE_API_KEY;
    process.env.PI_SMARTREAD_JUDGE_MODE = "cloud";
    process.env.PI_SMARTREAD_JUDGE_API_KEY = "test-key";
    try {
      const cacheDir = join(projectRoot, ".pi-smartread", "judge-cache");
      await seedVerdictCache(cacheDir);

      const resolved = await resolveMcpJudge(projectRoot);
      expect("judge" in resolved).toBe(true);
      if (!("judge" in resolved)) return;
      const aborted = new AbortController();
      aborted.abort();
      const r = await resolved.judge.judgeNouls(judgeInput(), aborted.signal);
      expect(r.p.get("u0")).toBe(0.66);
      expect(r.cacheHits).toBe(1);
    } finally {
      if (savedMode === undefined) delete process.env.PI_SMARTREAD_JUDGE_MODE;
      else process.env.PI_SMARTREAD_JUDGE_MODE = savedMode;
      if (savedKey === undefined) delete process.env.PI_SMARTREAD_JUDGE_API_KEY;
      else process.env.PI_SMARTREAD_JUDGE_API_KEY = savedKey;
    }
  });

  it("resolveMcpJudge ignores a seeded cache at a nested non-root (F4: no cache dir)", async () => {
    const savedMode = process.env.PI_SMARTREAD_JUDGE_MODE;
    const savedKey = process.env.PI_SMARTREAD_JUDGE_API_KEY;
    process.env.PI_SMARTREAD_JUDGE_MODE = "cloud";
    process.env.PI_SMARTREAD_JUDGE_API_KEY = "test-key";
    try {
      // Litter an already-seeded cache into the nested dir: pre-fix this hit,
      // post-fix the runtime must not derive a cache dir there at all.
      await seedVerdictCache(join(nested, ".pi-smartread", "judge-cache"));

      const resolved = await resolveMcpJudge(nested);
      expect("judge" in resolved).toBe(true);
      if (!("judge" in resolved)) return;
      const aborted = new AbortController();
      aborted.abort();
      // Miss → aborted transport throws; the seeded verdict is not consulted.
      await expect(resolved.judge.judgeNouls(judgeInput(), aborted.signal)).rejects.toThrow();
    } finally {
      if (savedMode === undefined) delete process.env.PI_SMARTREAD_JUDGE_MODE;
      else process.env.PI_SMARTREAD_JUDGE_MODE = savedMode;
      if (savedKey === undefined) delete process.env.PI_SMARTREAD_JUDGE_API_KEY;
      else process.env.PI_SMARTREAD_JUDGE_API_KEY = savedKey;
    }
  });
});

// ── persistent embedding cache ───────────────────────────────────────

describe("persistent-embedding-cache writer guard", () => {
  it("stays memory-only at a nested non-root", () => {
    const cache = new PersistentEmbeddingCache(nested);
    expect(cache.hasPersistence).toBe(false);
    cache.set("entry", { vectors: [[1, 2, 3]] });
    expect(existsSync(join(nested, ".pi-smartread.embeddings.cache"))).toBe(false);
    expect(cache.diskEntries).toBe(0);
    expect(cache.get("entry")!.vectors).toEqual([[1, 2, 3]]);
  });

  it("persists at a real state root", () => {
    const cache = new PersistentEmbeddingCache(projectRoot);
    expect(cache.hasPersistence).toBe(true);
    expect(existsSync(join(projectRoot, ".pi-smartread.embeddings.cache"))).toBe(true);
    cache.set("entry", { vectors: [[1, 2, 3]] });
    const reopened = new PersistentEmbeddingCache(projectRoot);
    expect(reopened.get("entry")!.vectors).toEqual([[1, 2, 3]]);
    expect(reopened.diskEntries).toBe(1);
  });
});
