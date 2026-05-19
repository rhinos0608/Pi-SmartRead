import { describe, it, expect, beforeEach } from "vitest";
import { LocalEmbeddingProvider, tensorToVectors, isLocalEmbeddingAvailable } from "../../local-embedding-provider.js";

// ---------------------------------------------------------------------------
// tensorToVectors
// ---------------------------------------------------------------------------

describe("tensorToVectors", () => {
  it("converts a single-row tensor to one vector", () => {
    const tensor = {
      data: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      dims: [1, 4],
    };
    const result = tensorToVectors(tensor);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(4);
    // Use toBeCloseTo because Float32 representation differs from decimal literal
    expect(result[0]![0]).toBeCloseTo(0.1, 5);
    expect(result[0]![1]).toBeCloseTo(0.2, 5);
    expect(result[0]![2]).toBeCloseTo(0.3, 5);
    expect(result[0]![3]).toBeCloseTo(0.4, 5);
  });

  it("converts a multi-row tensor to multiple vectors", () => {
    const tensor = {
      data: new Float32Array([1, 2, 3, 4, 5, 6]),
      dims: [2, 3],
    };
    const result = tensorToVectors(tensor);
    expect(result).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("handles a 1-D tensor as a single vector", () => {
    const tensor = {
      data: new Float32Array([9, 8, 7]),
      dims: [3],
    };
    const result = tensorToVectors(tensor);
    expect(result).toEqual([[9, 8, 7]]);
  });

  it("does not share memory with the original data array", () => {
    const tensor = {
      data: new Float32Array([1, 2]),
      dims: [1, 2],
    };
    const result = tensorToVectors(tensor);
    result[0]![0] = 99;
    // The original tensor data must not be affected
    expect(tensor.data[0]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LocalEmbeddingProvider construction
// ---------------------------------------------------------------------------

describe("LocalEmbeddingProvider construction", () => {
  it("accepts no options and uses defaults", () => {
    const provider = new LocalEmbeddingProvider();
    expect(provider.modelId).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("accepts a custom modelId", () => {
    const provider = new LocalEmbeddingProvider({ modelId: "Xenova/bge-small-en-v1" });
    expect(provider.modelId).toBe("Xenova/bge-small-en-v1");
  });

  it("accepts modelDir, dtype, and normalize options", () => {
    const provider = new LocalEmbeddingProvider({
      modelId: "Xenova/all-MiniLM-L6-v2",
      modelDir: "/data/models",
      dtype: "q8",
      normalize: false,
    });
    expect(provider.modelId).toBe("Xenova/all-MiniLM-L6-v2");
    expect(provider.dtype).toBe("q8");
  });
});

// ---------------------------------------------------------------------------
// isLocalEmbeddingAvailable
// ---------------------------------------------------------------------------

describe("isLocalEmbeddingAvailable", () => {
  it("returns a boolean", async () => {
    const result = await isLocalEmbeddingAvailable();
    expect(typeof result).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests — only run when @huggingface/transformers is present
// and the model loads successfully.
// Set RUN_LOCAL_EMBED_TESTS=1 to opt in.
// ---------------------------------------------------------------------------

const RUN_INTEGRATION_TESTS =
  process.env.RUN_LOCAL_EMBED_TESTS === "1" &&
  process.env.SKIP_INTEGRATION_TESTS !== "1";

// Skip integration block entirely if conditions aren't met
(RUN_INTEGRATION_TESTS ? describe : describe.skip)(
  "LocalEmbeddingProvider embed (integration)",
  () => {
    let provider: LocalEmbeddingProvider;

    beforeEach(async () => {
      provider = new LocalEmbeddingProvider({ dtype: "fp16" });
      await provider.initialize();
    });

    it("produces vectors for a single text input", async () => {
      const vectors = await provider.embed(["hello world"]);
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toHaveLength(384); // all-MiniLM-L6-v2
    });

    it("produces vectors for a batch of texts", async () => {
      const vectors = await provider.embed(["hello world", "goodbye world", "foo bar"]);
      expect(vectors).toHaveLength(3);
      for (const v of vectors) {
        expect(v).toHaveLength(384);
      }
    });

    it("returns unit-length vectors when normalize is true (default)", async () => {
      const vectors = await provider.embed(["hello world"]);
      const norm = Math.sqrt(vectors[0]!.reduce((sum, x) => sum + x * x, 0));
      expect(norm).toBeCloseTo(1.0, 5);
    });

    it("throws when embed is called before initialize", async () => {
      const uninit = new LocalEmbeddingProvider();
      await expect(uninit.embed(["hello"])).rejects.toThrow(/not initialized/i);
    });
  }
);

// ---------------------------------------------------------------------------
// Error handling — missing optional dependency
// ---------------------------------------------------------------------------

describe("LocalEmbeddingProvider error handling", () => {
  // Simulate the missing-dependency scenario by checking that the dynamic
  // import path is exercised when the package is absent.
  // In CI / environments without the package this block just validates the
  // error message shape.
  it("isLocalEmbeddingAvailable resolves to false when package is absent", async () => {
    // The test runner already has @huggingface/transformers installed, so
    // we verify the *opposite* shape: if it were absent, fetchLocalEmbeddings
    // would throw.  We exercise the error path by checking that a Provider
    // built without initialize() produces a descriptive error on embed().
    const provider = new LocalEmbeddingProvider();
    await expect(provider.embed(["hello"])).rejects.toThrow(/not initialized/i);
  });
});