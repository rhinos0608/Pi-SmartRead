import { describe, expect, it } from "vitest";
import {
  embeddingProfileId,
  formatEmbeddingInputs,
  isEmbeddingGemmaModel,
} from "../../src/embedding-profile.js";

describe("EmbeddingGemma profile", () => {
  it("detects Hugging Face and OpenAI-server aliases", () => {
    expect(isEmbeddingGemmaModel("google/embeddinggemma-300m")).toBe(true);
    expect(isEmbeddingGemmaModel("text-embedding-embeddinggemma-300m")).toBe(true);
    expect(isEmbeddingGemmaModel("google/embeddinggemma-300m-qat-q4_0")).toBe(true);
    expect(isEmbeddingGemmaModel("nomic-embed-text")).toBe(false);
  });

  it("formats code queries and documents with documented asymmetric prompts", () => {
    expect(formatEmbeddingInputs({
      model: "google/embeddinggemma-300m",
      inputs: ["find auth middleware", "export function authenticate() {}"],
      inputTypes: ["query", "document"],
      inputTitles: [undefined, "src/auth.ts"],
    })).toEqual([
      "task: code retrieval | query: find auth middleware",
      "title: src/auth.ts | text: export function authenticate() {}",
    ]);
  });

  it("uses none when document title is unavailable", () => {
    expect(formatEmbeddingInputs({
      model: "embeddinggemma-300m",
      inputs: ["const value = 1;"],
      inputTypes: ["document"],
    })).toEqual(["title: none | text: const value = 1;"]);
  });

  it("leaves other models and untyped requests unchanged", () => {
    const inputs = ["query", "document"];
    expect(formatEmbeddingInputs({ model: "nomic-embed-text", inputs, inputTypes: ["query", "document"] })).toEqual(inputs);
    expect(formatEmbeddingInputs({ model: "google/embeddinggemma-300m", inputs })).toEqual(inputs);
  });

  it("rejects positional metadata with mismatched lengths", () => {
    expect(() => formatEmbeddingInputs({
      model: "google/embeddinggemma-300m",
      inputs: ["query", "document"],
      inputTypes: ["query"],
    })).toThrow(/inputTypes.*inputs/i);

    expect(() => formatEmbeddingInputs({
      model: "google/embeddinggemma-300m",
      inputs: ["document"],
      inputTypes: ["document"],
      inputTitles: [],
    })).toThrow(/inputTitles.*inputs/i);
  });

  it("versions Gemma behavior separately for cache invalidation", () => {
    expect(embeddingProfileId("google/embeddinggemma-300m")).toContain("embeddinggemma");
    expect(embeddingProfileId("google/embeddinggemma-300m")).not.toBe(embeddingProfileId("nomic-embed-text"));
  });
});
