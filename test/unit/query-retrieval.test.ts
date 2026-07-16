import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retrieveQuery } from "../../src/query-retrieval.js";
import {
  disposeSemanticIndexes,
  effectiveSemanticRoot,
  getOrCreateSemanticIndex,
  getSemanticIndex,
  semanticIndexRegistrySize,
} from "../../src/semantic-index-registry.js";

const config = { baseUrl: "http://localhost:11434/v1", model: "test", chunkSizeChars: 100, chunkOverlapChars: 0 };

function discover(root: string) {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".pi-smartread" || name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(root);
  return Promise.resolve({ files, diagnostics: {} as never });
}

function vector(text: string): number[] {
  return /auth|token|needle/i.test(text) ? [1, 0, 0, 0, 0] : [0, 1, 0, 0, 0];
}

describe("shared query retrieval", () => {
  let root: string;
  let previousAllowedRoot: string | undefined;
  let previousCbmAllowedRoot: string | undefined;

  beforeEach(() => {
    previousAllowedRoot = process.env.PI_SMARTREAD_ALLOWED_ROOT;
    previousCbmAllowedRoot = process.env.CBM_ALLOWED_ROOT;
    delete process.env.PI_SMARTREAD_ALLOWED_ROOT;
    delete process.env.CBM_ALLOWED_ROOT;
    disposeSemanticIndexes();
    root = mkdtempSync(join(tmpdir(), "query-retrieval-"));
    writeFileSync(join(root, "package.json"), "{}\n");
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "src", "auth.ts"), "export const semanticNeedle = 'auth token';\n");
    writeFileSync(join(root, "other", "db.ts"), "export const databaseSchema = true;\n");
  });

  afterEach(() => {
    disposeSemanticIndexes();
    if (previousAllowedRoot === undefined) delete process.env.PI_SMARTREAD_ALLOWED_ROOT;
    else process.env.PI_SMARTREAD_ALLOWED_ROOT = previousAllowedRoot;
    if (previousCbmAllowedRoot === undefined) delete process.env.CBM_ALLOWED_ROOT;
    else process.env.CBM_ALLOWED_ROOT = previousCbmAllowedRoot;
    rmSync(root, { recursive: true, force: true });
  });

  async function warm(failQueries = false) {
    const index = getOrCreateSemanticIndex(root, {
      config,
      discoverFiles: discover as never,
      fetchEmbeddings: (async (request: { inputs: string[] }) => {
        if (failQueries && request.inputs.length === 1 && request.inputs[0] === "semanticNeedle") throw new Error("query offline");
        return { vectors: request.inputs.map(vector) };
      }) as never,
    });
    await index.initialize();
    await index.updateIndex();
    return index;
  }

  it("uses registered hybrid index, scopes by directory, and keeps valid zero hits hybrid", async () => {
    await warm();
    const result = await retrieveQuery({ query: "semanticNeedle auth", cwd: root, directory: "src" });
    expect(result.strategy).toBe("hybrid");
    expect(result.hits.map((hit) => hit.relativePath)).toEqual(["src/auth.ts"]);

    mkdirSync(join(root, "empty"));
    const empty = await retrieveQuery({ query: "semanticNeedle", cwd: root, directory: "empty" });
    expect(empty).toEqual({ strategy: "hybrid", hits: [] });
  });

  it("falls back to grep+AST when index is unavailable or query embedding fails", async () => {
    const unavailable = await retrieveQuery({ query: "semanticNeedle", cwd: root, directory: "src" });
    expect(unavailable.strategy).toBe("fallback");
    expect(unavailable.hits.map((hit) => hit.relativePath)).toContain("src/auth.ts");

    await warm(true);
    const failed = await retrieveQuery({ query: "semanticNeedle", cwd: root, directory: "src" });
    expect(failed.strategy).toBe("fallback");
    if (failed.strategy === "fallback") expect(failed.reason).toBe("error");
  });

  it("clamps indexing and registry lookup to an allowed subroot", async () => {
    const allowed = join(root, "allowed");
    const nested = join(allowed, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(allowed, "inside.ts"), "export const semanticNeedle = 'auth token';\n");
    writeFileSync(join(root, "other", "outside.ts"), "export const semanticNeedle = 'auth token outside';\n");
    process.env.PI_SMARTREAD_ALLOWED_ROOT = allowed;

    const semanticRoot = effectiveSemanticRoot(allowed, root);
    expect(semanticRoot).toBe(realpathSync(allowed));
    const discoveredRoots: string[] = [];
    const index = getOrCreateSemanticIndex(semanticRoot!, {
      config,
      discoverFiles: ((indexRoot: string) => {
        discoveredRoots.push(indexRoot);
        return discover(indexRoot);
      }) as never,
      fetchEmbeddings: (async (request: { inputs: string[] }) => ({ vectors: request.inputs.map(vector) })) as never,
    });
    await index.initialize();
    await index.updateIndex();

    expect(discoveredRoots).toEqual([realpathSync(allowed)]);
    expect(index.getStats().indexedFileCount).toBe(1);
    expect(getSemanticIndex(nested)).toBe(index);
    expect(getSemanticIndex(join(root, "other"))).toBeNull();
    const result = await retrieveQuery({ query: "semanticNeedle auth", cwd: allowed, topK: 10 });
    expect(result.strategy).toBe("hybrid");
    expect(result.hits.map((hit) => hit.relativePath)).toEqual(["inside.ts"]);
  });

  it("reuses broader project index when allowed-root env is set (no gating)", async () => {
    const broadIndex = await warm();
    const allowed = join(root, "src");
    process.env.PI_SMARTREAD_ALLOWED_ROOT = allowed;

    expect(getSemanticIndex(allowed)).toBe(broadIndex);
    // Allowed-root env no longer gates explicit queries; broader index is reused.
    const result = await retrieveQuery({ query: "semanticNeedle", cwd: allowed });
    expect(result.strategy).toBe("hybrid");
    expect(result.hits.every((hit) => hit.absolutePath.startsWith(`${realpathSync(allowed)}/`))).toBe(true);
  });

  it("owns one nearest-project registry entry and disposes live handles", async () => {
    const index = await warm();
    expect(getSemanticIndex(join(root, "src"))).toBe(index);
    expect(semanticIndexRegistrySize()).toBe(1);
    disposeSemanticIndexes(root);
    expect(semanticIndexRegistrySize()).toBe(0);
    expect(index.isAvailable()).toBe(false);
  });
});
