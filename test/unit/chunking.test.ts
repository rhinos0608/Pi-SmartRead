import { describe, expect, it } from "vitest";
import { chunkText, compressSnippet } from "../../chunking.js";

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

  it("adds context headers and compressed embedding text when filePath is provided", () => {
    const text = "import fs from 'node:fs';\n\nexport function readConfig() {\n  return true;\n}\n";
    const result = chunkText(text, { filePath: "src/config.ts", compressForEmbedding: true });

    expect(result).toHaveLength(1);
    expect(result[0].contextHeader).toBe("File: src/config.ts > Function: readConfig");
    expect(result[0].embeddingText).toContain("File: src/config.ts > Function: readConfig");
    expect(result[0].embeddingText).not.toContain("import fs");
  });
});

describe("compressSnippet", () => {
  it("strips import lines, collapses blank lines, and truncates long snippets", () => {
    const snippet = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "",
      "",
      "export function loadConfig() {",
      "  return '" + "x".repeat(80) + "';",
      "}",
    ].join("\n");

    const compressed = compressSnippet(snippet, { maxChars: 80 });

    expect(compressed).not.toContain("import fs");
    expect(compressed).not.toContain("import path");
    expect(compressed).not.toContain("\n\n\n");
    expect(compressed.length).toBeLessThanOrEqual(100);
    expect(compressed).toContain("truncated");
  });

  it("preserves both the start and end when truncating long snippets", () => {
    const compressed = compressSnippet(`start-${"x".repeat(200)}-importantTail`, { maxChars: 80 });

    expect(compressed).toContain("start-");
    expect(compressed).toContain("importantTail");
    expect(compressed).toContain("truncated");
  });
});

describe("symbol-boundary chunking", () => {
  it("chunks at function boundaries", () => {
    const code = `
function foo() {
  return 1;
}

function bar() {
  return 2;
}

function baz() {
  return 3;
}
`;
    const chunks = chunkText(code, { useSymbolBoundaries: true, chunkSizeChars: 30 });

    // Should get individual function chunks (chunkSizeChars is small enough)
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some((c) => c.text.includes("function foo"))).toBe(true);
    expect(chunks.some((c) => c.symbolBoundary?.name === "foo")).toBe(true);
    expect(chunks.some((c) => c.symbolBoundary?.name === "bar")).toBe(true);
    expect(chunks.some((c) => c.symbolBoundary?.name === "baz")).toBe(true);
  });

  it("chunks at class boundaries", () => {
    const code = `
class UserService {
  createUser() { return {}; }
}

class OrderService {
  createOrder() { return {}; }
}
`;
    const chunks = chunkText(code, { useSymbolBoundaries: true, chunkSizeChars: 40 });

    // Each class should produce a chunk
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some((c) => c.symbolBoundary?.name === "UserService")).toBe(true);
    expect(chunks.some((c) => c.symbolBoundary?.name === "OrderService")).toBe(true);
  });

  it("falls back to character-based when no symbols found", () => {
    const text = "Just some plain text.".repeat(200);
    const chunks = chunkText(text, { useSymbolBoundaries: true, maxChunksPerFile: 5 });

    expect(chunks.length).toBeGreaterThan(0);
    // No symbol boundaries since no function/class declarations
    expect(chunks.every((c) => c.symbolBoundary === undefined)).toBe(true);
  });

  it("includes line range in chunk metadata", () => {
    const code = "\n// preamble\n\nfunction myFunc() {\n  return 42;\n}\n\n// epilogue";
    const chunks = chunkText(code, { useSymbolBoundaries: true, chunkSizeChars: 500 });

    const funcChunk = chunks.find((c) => c.symbolBoundary?.name === "myFunc");
    expect(funcChunk).toBeDefined();
    expect(funcChunk!.symbolBoundary!.startLine).toBeGreaterThan(0);
    expect(funcChunk!.symbolBoundary!.endLine).toBeGreaterThan(funcChunk!.symbolBoundary!.startLine);
  });

  it("sub-splits very large symbols", () => {
    // Create a function larger than 2x chunkSizeChars
    const largeBody = "  console.log('line ' + i);\n".repeat(800);
    const code = `function bigFunction() {\n${largeBody}}\n`;
    const chunks = chunkText(code, {
      useSymbolBoundaries: true,
      chunkSizeChars: 200,
      maxChunksPerFile: 10,
    });

    // Should sub-split into multiple chunks from the same symbol
    expect(chunks.length).toBeGreaterThan(1);
    const bigFuncChunks = chunks.filter(
      (c) => c.symbolBoundary?.name === "bigFunction",
    );
    expect(bigFuncChunks.length).toBeGreaterThan(1);
  });

  it("merges small adjacent chunks", () => {
    const code = `
const x = 1;

const y = 2;

const z = 3;
`;
    const chunks = chunkText(code, {
      useSymbolBoundaries: true,
      chunkSizeChars: 2000,
      minChunkChars: 10,
    });

    // Small variable declarations should be merged together
    expect(chunks.length).toBeLessThanOrEqual(1);
  });

  it("handles empty input", () => {
    expect(chunkText("", { useSymbolBoundaries: true })).toEqual([]);
    expect(chunkText("   ", { useSymbolBoundaries: true })).toEqual([]);
  });
});