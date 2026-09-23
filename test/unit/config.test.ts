import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach as _afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateEmbeddingConfig } from "../../src/config.js";

/** A cwd that has no pi-smartread.config.json in any ancestor directory. */
const SAFE_CWD = "/tmp";

describe("config: validateEmbeddingConfig", () => {
  beforeEach(() => {
    delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
    delete process.env.PI_SMARTREAD_EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.PI_SMARTREAD_CHUNK_SIZE;
    delete process.env.PI_SMARTREAD_CHUNK_OVERLAP;
    delete process.env.PI_SMARTREAD_MAX_CHUNKS;
    delete process.env.PI_SMARTREAD_RERANKER_BASE_URL;
    delete process.env.PI_SMARTREAD_RERANKER_API_KEY;
  });

  it("returns null when baseUrl is missing", () => {
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "text-embedding-3-small";
    expect(validateEmbeddingConfig(SAFE_CWD)).toBeNull();
  });

  it("returns null when model is missing", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    expect(validateEmbeddingConfig(SAFE_CWD)).toBeNull();
  });

  it("returns null when both are missing", () => {
    expect(validateEmbeddingConfig(SAFE_CWD)).toBeNull();
  });

  it("reads PI_SMARTREAD_EMBEDDING_BASE_URL and PI_SMARTREAD_EMBEDDING_MODEL", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    const cfg = validateEmbeddingConfig(SAFE_CWD);
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg!.model).toBe("nomic-embed-text");
    expect(cfg!.apiKey).toBeUndefined();
  });

  it("reads API key from PI_SMARTREAD_EMBEDDING_API_KEY", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.PI_SMARTREAD_EMBEDDING_API_KEY = "sk-test";
    const cfg = validateEmbeddingConfig(SAFE_CWD);
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe("sk-test");
  });

  it("falls back to legacy EMBEDDING_BASE_URL and EMBEDDING_MODEL", () => {
    process.env.EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.EMBEDDING_MODEL = "legacy-model";
    const cfg = validateEmbeddingConfig(SAFE_CWD);
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg!.model).toBe("legacy-model");
  });

  it("PI_SMARTREAD_ variables take precedence over legacy EMBEDDING_ variables", () => {
    process.env.EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.EMBEDDING_MODEL = "legacy-model";
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11435/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "primary-model";
    const cfg = validateEmbeddingConfig(SAFE_CWD);
    expect(cfg).not.toBeNull();
    expect(cfg!.baseUrl).toBe("http://localhost:11435/v1");
    expect(cfg!.model).toBe("primary-model");
  });

  it("returns null when config is missing (no env vars set)", () => {
    expect(validateEmbeddingConfig(SAFE_CWD)).toBeNull();
  });

  it("throws when chunkSizeChars is not positive", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.PI_SMARTREAD_CHUNK_SIZE = "0";
    expect(() => validateEmbeddingConfig(SAFE_CWD)).toThrow(/chunkSizeChars/);
  });

  it("throws when chunkOverlapChars is negative", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.PI_SMARTREAD_CHUNK_OVERLAP = "-1";
    expect(() => validateEmbeddingConfig(SAFE_CWD)).toThrow(/chunkOverlapChars/);
  });

  it("throws when maxChunksPerFile is not positive", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.PI_SMARTREAD_MAX_CHUNKS = "-5";
    expect(() => validateEmbeddingConfig(SAFE_CWD)).toThrow(/maxChunksPerFile/);
  });

  it("allows valid chunk config values", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.PI_SMARTREAD_CHUNK_SIZE = "1024";
    process.env.PI_SMARTREAD_CHUNK_OVERLAP = "128";
    process.env.PI_SMARTREAD_MAX_CHUNKS = "8";
    const cfg = validateEmbeddingConfig(SAFE_CWD);
    expect(cfg).not.toBeNull();
    expect(cfg!.chunkSizeChars).toBe(1024);
    expect(cfg!.chunkOverlapChars).toBe(128);
    expect(cfg!.maxChunksPerFile).toBe(8);
  });

  it("loads HyDE and reranker knobs while keeping reranker endpoint credentials env-only", () => {
    const root = mkdtempSync(join(tmpdir(), "smartread-config-"));
    try {
      writeFileSync(join(root, "pi-smartread.config.json"), JSON.stringify({
        model: "nomic-embed-text",
        hydeEnabled: true,
        rerankEnabled: true,
        externalReranker: {
          baseUrl: "https://repo-controlled.invalid/v1",
          apiKey: "repo-secret",
          model: "rerank-test",
          timeoutMs: 1234,
          maxDocuments: 7,
        },
      }));
      process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
      process.env.PI_SMARTREAD_RERANKER_BASE_URL = "http://localhost:11435/v1";
      process.env.PI_SMARTREAD_RERANKER_API_KEY = "env-secret";

      const cfg = validateEmbeddingConfig(root);
      expect(cfg).not.toBeNull();
      expect(cfg!.hydeEnabled).toBe(true);
      expect(cfg!.rerankEnabled).toBe(true);
      expect(cfg!.externalReranker).toEqual({
        baseUrl: "http://localhost:11435/v1",
        apiKey: "env-secret",
        model: "rerank-test",
        timeoutMs: 1234,
        maxDocuments: 7,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
