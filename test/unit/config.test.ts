import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache, validateEmbeddingConfig } from "../../config.js";

describe("config: validateEmbeddingConfig", () => {
  beforeEach(() => {
    resetConfigCache();
    delete process.env.PI_SMARTREAD_EMBEDDING_BASE_URL;
    delete process.env.PI_SMARTREAD_EMBEDDING_MODEL;
    delete process.env.PI_SMARTREAD_EMBEDDING_API_KEY;
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
  });

  afterEach(() => resetConfigCache());

  it("throws when baseUrl is missing", () => {
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "text-embedding-3-small";
    expect(() => validateEmbeddingConfig()).toThrow(/baseUrl/);
  });

  it("throws when model is missing", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    expect(() => validateEmbeddingConfig()).toThrow(/model/);
  });

  it("reads PI_SMARTREAD_EMBEDDING_BASE_URL and PI_SMARTREAD_EMBEDDING_MODEL", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    const cfg = validateEmbeddingConfig();
    expect(cfg.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg.model).toBe("nomic-embed-text");
    expect(cfg.apiKey).toBeUndefined();
  });

  it("reads API key from PI_SMARTREAD_EMBEDDING_API_KEY", () => {
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://localhost:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "nomic-embed-text";
    process.env.PI_SMARTREAD_EMBEDDING_API_KEY = "sk-test";
    const cfg = validateEmbeddingConfig();
    expect(cfg.apiKey).toBe("sk-test");
  });

  it("falls back to legacy EMBEDDING_BASE_URL and EMBEDDING_MODEL", () => {
    process.env.EMBEDDING_BASE_URL = "http://legacy:11434/v1";
    process.env.EMBEDDING_MODEL = "legacy-model";
    const cfg = validateEmbeddingConfig();
    expect(cfg.baseUrl).toBe("http://legacy:11434/v1");
    expect(cfg.model).toBe("legacy-model");
  });

  it("PI_SMARTREAD_ variables take precedence over legacy EMBEDDING_ variables", () => {
    process.env.EMBEDDING_BASE_URL = "http://legacy:11434/v1";
    process.env.EMBEDDING_MODEL = "legacy-model";
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL = "http://primary:11434/v1";
    process.env.PI_SMARTREAD_EMBEDDING_MODEL = "primary-model";
    const cfg = validateEmbeddingConfig();
    expect(cfg.baseUrl).toBe("http://primary:11434/v1");
    expect(cfg.model).toBe("primary-model");
  });

  it("error message points to both config file and env var names", () => {
    try {
      validateEmbeddingConfig();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("pi-smartread.config.json");
      expect(msg).toContain("PI_SMARTREAD_EMBEDDING_BASE_URL");
    }
  });
});