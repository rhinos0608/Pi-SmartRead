import { describe, expect, it } from "vitest";
import { chunkText } from "../../chunking.js";

describe("chunkText", () => {
  it("returns empty array for empty string", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  it("returns single chunk for short text (under chunk size)", () => {
    const short = "hello world";
    const result = chunkText(short);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(short);
    expect(result[0].chunkIndex).toBe(0);
    expect(result[0].startChar).toBe(0);
    expect(result[0].endChar).toBe(short.length);
    expect(result[0].wasHardSplit).toBe(false);
    expect(result[0].estimatedTokens).toBe(Math.ceil(short.length / 4));
  });

  it("splits on double newlines when available", () => {
    // With chunkSize=30, this text should split on double newline
    const text = "aaa\n\naaa\naaa\n\naaa\naaa\naaa\naaa\naaa\naaa\naaa\naaa";
    const result = chunkText(text, { chunkSizeChars: 30 });
    expect(result.length).toBeGreaterThan(1);
    // First chunk should end after the double newline
    expect(result[0].text).toContain("aaa\n\naaa");
    expect(result[0].wasHardSplit).toBe(false);
  });

  it("splits on single newline when double newline not available", () => {
    const text = "aaa\naaaa\naaaa\naaaa\naaaa\naaaa\naaaa\naaaa\naaaa\naaaa\naaaa";
    const result = chunkText(text, { chunkSizeChars: 30 });
    expect(result.length).toBeGreaterThan(1);
    expect(result[0].wasHardSplit).toBe(false);
  });

  it("does hard split when no natural boundary near target position", () => {
    // A very long continuous string with no newlines
    const text = "a".repeat(500) + "b".repeat(500) + "c".repeat(500);
    const result = chunkText(text, { chunkSizeChars: 500 });
    expect(result[0].wasHardSplit).toBe(true);
  });

  it("respects maxChunksPerFile", () => {
    const text = "line\n".repeat(100);
    // Explicit chunkOverlapChars=0 and minChunkChars=1 so small chunks are not skipped
    const result = chunkText(text, { chunkSizeChars: 50, chunkOverlapChars: 0, maxChunksPerFile: 3, minChunkChars: 1 });
    expect(result).toHaveLength(3);
  });

  it("includes overlap between chunks when configured", () => {
    const text = "a b c d e f g h i j";
    // chunkSize small enough to force a split, overlap large enough to carry content
    const result = chunkText(text, { chunkSizeChars: 10, chunkOverlapChars: 6, minChunkChars: 1 });
    expect(result.length).toBeGreaterThan(1);
    // Second chunk should start before the first chunk's end (overlap)
    const gap = result[0].endChar - result[1].startChar;
    expect(gap).toBeGreaterThan(0);
  });

  it("estimates tokens correctly", () => {
    const text = "1234567890123456"; // 16 chars
    const result = chunkText(text);
    expect(result[0].estimatedTokens).toBe(4); // 16/4 = 4
  });

  it("ensures chunk text content matches reported start/end positions", () => {
    const text = "0123456789".repeat(20);
    const result = chunkText(text, { chunkSizeChars: 50 });
    for (const chunk of result) {
      const extracted = text.slice(chunk.startChar, chunk.endChar);
      expect(chunk.text).toBe(extracted);
    }
  });

  it("skips chunks smaller than minChunkChars (after first)", () => {
    // Two parts: first big, second tiny
    const text = "x".repeat(200) + "\n\n" + "y".repeat(10);
    const result = chunkText(text, { chunkSizeChars: 100, minChunkChars: 50 });
    // The tiny remainder at the end should be skipped (unless it's the only chunk)
    const lastChunk = result[result.length - 1];
    if (result.length > 1) {
      expect(lastChunk.text.length).toBeGreaterThanOrEqual(50);
    }
  });

  it("always includes the final chunk even if it's small", () => {
    const text = "x".repeat(1000) + "y".repeat(5);
    const result = chunkText(text, { chunkSizeChars: 500, chunkOverlapChars: 400, maxChunksPerFile: 20, minChunkChars: 200 });
    const lastChunk = result[result.length - 1];
    expect(lastChunk.text).toContain("y".repeat(5));
  });

  it("updates chunkIndex after creation", () => {
    const text = "line\n".repeat(50);
    const result = chunkText(text, { chunkSizeChars: 50 });
    for (let i = 0; i < result.length; i++) {
      expect(result[i].chunkIndex).toBe(i);
    }
  });

  it("handles single character split at hard boundary", () => {
    const text = "a";
    const result = chunkText(text);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("a");
    expect(result[0].startChar).toBe(0);
    expect(result[0].endChar).toBe(1);
  });
});