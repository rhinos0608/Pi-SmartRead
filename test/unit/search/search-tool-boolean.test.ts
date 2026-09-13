import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import createSearchTool from "../../src/search-tool.js";
import {
  parseBooleanQuery,
  evaluateBooleanExpression,
} from "../../src/search-tool.js";

const ml = (query: string, line: string, caseSensitive = false): boolean =>
  evaluateBooleanExpression(parseBooleanQuery(query), line, caseSensitive);

function getMatchLocations(result: unknown): string[] {
  const details = (
    result as {
      details?: { matches?: Array<{ relFile: string; line: number }> };
    }
  ).details;
  return (details?.matches ?? [])
    .map((match) => `${match.relFile}:${match.line}`)
    .sort();
}

describe("boolean query parser", () => {
  describe("parseBooleanQuery", () => {
    it("parses AND expression", () => {
      const expr = parseBooleanQuery("foo AND bar");
      expect(expr).toMatchObject({
        kind: "and",
        left: { kind: "term", value: "foo" },
        right: { kind: "term", value: "bar" },
      });
    });

    it("parses OR expression", () => {
      const expr = parseBooleanQuery("foo OR bar");
      expect(expr).toMatchObject({
        kind: "or",
        left: { kind: "term", value: "foo" },
        right: { kind: "term", value: "bar" },
      });
    });

    it("parses NOT expression", () => {
      const expr = parseBooleanQuery("NOT foo");
      expect(expr).toMatchObject({
        kind: "not",
        expr: { kind: "term", value: "foo" },
      });
    });

    it("parses implicit AND between space-separated terms", () => {
      const expr = parseBooleanQuery("foo bar baz");
      expect(expr).toMatchObject({
        kind: "and",
        left: { kind: "and", left: { kind: "term", value: "foo" }, right: { kind: "term", value: "bar" } },
        right: { kind: "term", value: "baz" },
      });
    });

    it("parses parenthesized grouping", () => {
      const expr = parseBooleanQuery("(a OR b) AND c");
      expect(expr).toMatchObject({
        kind: "and",
        left: {
          kind: "or",
          left: { kind: "term", value: "a" },
          right: { kind: "term", value: "b" },
        },
        right: { kind: "term", value: "c" },
      });
    });

    it("parses quoted phrase", () => {
      const expr = parseBooleanQuery('"hello world"');
      expect(expr).toMatchObject({
        kind: "phrase",
        value: "hello world",
      });
    });

    it("parses AND with quoted phrase", () => {
      const expr = parseBooleanQuery('foo AND "bar baz"');
      expect(expr).toMatchObject({
        kind: "and",
        left: { kind: "term", value: "foo" },
        right: { kind: "phrase", value: "bar baz" },
      });
    });

    it("respects NOT > AND > OR precedence", () => {
      // NOT binds tighter than AND
      const notAnd = parseBooleanQuery("NOT a AND b");
      expect(notAnd).toMatchObject({
        kind: "and",
        left: { kind: "not", expr: { kind: "term", value: "a" } },
        right: { kind: "term", value: "b" },
      });

      // AND binds tighter than OR
      const orAnd = parseBooleanQuery("a OR b AND c");
      expect(orAnd).toMatchObject({
        kind: "or",
        left: { kind: "term", value: "a" },
        right: {
          kind: "and",
          left: { kind: "term", value: "b" },
          right: { kind: "term", value: "c" },
        },
      });
    });

    it("handles empty query", () => {
      const expr = parseBooleanQuery("");
      expect(expr).toMatchObject({ kind: "term", value: "" });
    });

    it("handles whitespace-only query", () => {
      const expr = parseBooleanQuery("   ");
      expect(expr).toMatchObject({ kind: "term", value: "" });
    });

    it("handles unmatched quotes as phrase", () => {
      // Unterminated quote: treated as phrase up to end
      const expr = parseBooleanQuery('"unclosed');
      expect(expr).toMatchObject({
        kind: "phrase",
        value: "unclosed",
      });
    });

    it("handles unmatched opening paren gracefully", () => {
      const expr = parseBooleanQuery("(foo");
      expect(expr).toMatchObject({ kind: "term", value: "foo" });
    });
  });

  describe("evaluateBooleanExpression", () => {
    it("matches AND terms", () => {
      expect(ml("foo AND bar", "contains foo and bar")).toBe(true);
      expect(ml("foo AND bar", "only foo")).toBe(false);
      expect(ml("foo AND bar", "only bar")).toBe(false);
      expect(ml("foo AND bar", "neither")).toBe(false);
    });

    it("matches OR terms", () => {
      expect(ml("foo OR bar", "only foo")).toBe(true);
      expect(ml("foo OR bar", "only bar")).toBe(true);
      expect(ml("foo OR bar", "contains both foo and bar")).toBe(true);
      expect(ml("foo OR bar", "neither")).toBe(false);
    });

    it("matches NOT terms", () => {
      expect(ml("NOT foo", "contains only bar")).toBe(true);
      expect(ml("NOT foo", "contains foo")).toBe(false);
      expect(ml("NOT foo", "foo is here")).toBe(false);
    });

    it("matches AND NOT combination", () => {
      expect(ml("foo AND NOT bar", "contains foo only")).toBe(true);
      expect(ml("foo AND NOT bar", "contains both foo and bar")).toBe(false);
      expect(ml("foo AND NOT bar", "only bar")).toBe(false);
    });

    it("matches implicit AND", () => {
      expect(ml("foo bar", "contains foo and bar")).toBe(true);
      expect(ml("foo bar", "only foo")).toBe(false);
    });

    it("matches quoted phrases", () => {
      expect(ml('"exact phrase"', "line with exact phrase here")).toBe(true);
      expect(ml('"exact phrase"', "line with phrase only")).toBe(false);
      expect(ml('"exact phrase"', "no match")).toBe(false);
    });

    it("matches parenthesized grouping", () => {
      expect(ml("(a OR b) AND c", "a c")).toBe(true);
      expect(ml("(a OR b) AND c", "b c")).toBe(true);
      expect(ml("(a OR b) AND c", "a only")).toBe(false);
      expect(ml("(a OR b) AND c", "c only")).toBe(false);
    });

    it("respects precedence: NOT > AND > OR", () => {
      expect(ml("NOT foo AND bar", "contains bar only")).toBe(true);
      expect(ml("NOT foo AND bar", "contains foo and bar")).toBe(false);
      expect(ml("NOT foo AND bar", "contains foo only")).toBe(false);

      expect(ml("a OR b AND c", "a")).toBe(true);
      expect(ml("a OR b AND c", "b c")).toBe(true);
      expect(ml("a OR b AND c", "b only")).toBe(false);
    });

    it("handles case sensitivity", () => {
      expect(ml("foo", "FOO", false)).toBe(true);
      expect(ml("foo", "FOO", true)).toBe(false);
      expect(ml("FOO", "foo", true)).toBe(false);
      expect(ml("FOO", "FOO", true)).toBe(true);
    });

    it("handles case sensitivity with AND", () => {
      expect(ml("foo AND bar", "FOO BAR", false)).toBe(true);
      expect(ml("foo AND bar", "FOO BAR", true)).toBe(false);
    });

    it("handles case sensitivity with NOT", () => {
      expect(ml("NOT foo", "FOO", false)).toBe(false);
      expect(ml("NOT foo", "FOO", true)).toBe(true);
    });

    it("handles empty query — matches nothing", () => {
      expect(ml("", "anything")).toBe(false);
    });

    it("handles whitespace-only query — matches nothing", () => {
      expect(ml("   ", "anything")).toBe(false);
    });

    it("handles multiple AND terms", () => {
      expect(ml("a AND b AND c", "a b c")).toBe(true);
      expect(ml("a AND b AND c", "a b")).toBe(false);
      expect(ml("a AND b AND c", "b c")).toBe(false);
    });

    it("handles multiple OR terms", () => {
      expect(ml("a OR b OR c", "a")).toBe(true);
      expect(ml("a OR b OR c", "b")).toBe(true);
      expect(ml("a OR b OR c", "c")).toBe(true);
      expect(ml("a OR b OR c", "d")).toBe(false);
    });

    it("handles complex nested expressions", () => {
      // (a OR b) AND (c OR d) AND NOT e
      const expr = "(a OR b) AND (c OR d) AND NOT e";
      expect(ml(expr, "a c")).toBe(true);
      expect(ml(expr, "b d")).toBe(true);
      expect(ml(expr, "a c e")).toBe(false);
      expect(ml(expr, "a e")).toBe(false);
      expect(ml(expr, "e only")).toBe(false);
    });
  });
});

describe("search tool boolean grep integration", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    while (cleanupRoots.length > 0) {
      rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
    }
  });

  function withTempDir(): string {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-boolean-"));
    cleanupRoots.push(root);
    return root;
  }

  it("finds lines matching AND query in boolean mode", async () => {
    const root = withTempDir();
    writeFileSync(join(root, "test.txt"), [
      "line contains both apple and banana",
      "line with apple only",
      "line with banana only",
      "line with neither",
    ].join("\n"));

    const tool = createSearchTool();
    const result = await tool.execute(
      "boolean-and",
      { query: "apple AND banana", matchMode: "boolean", maxResults: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    expect(getMatchLocations(result)).toEqual(["test.txt:1"]);
  });

  it("finds lines matching OR query in boolean mode", async () => {
    const root = withTempDir();
    writeFileSync(join(root, "test.txt"), [
      "line with apple",
      "line with banana",
      "line with neither",
    ].join("\n"));

    const tool = createSearchTool();
    const result = await tool.execute(
      "boolean-or",
      { query: "apple OR banana", matchMode: "boolean", maxResults: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    expect(getMatchLocations(result)).toEqual(["test.txt:1", "test.txt:2"]);
  });

  it("finds lines matching NOT query in boolean mode", async () => {
    const root = withTempDir();
    writeFileSync(join(root, "test.txt"), [
      "line with apple",
      "line with banana",
      "line with neither",
    ].join("\n"));

    const tool = createSearchTool();
    const result = await tool.execute(
      "boolean-not",
      { query: "NOT apple", matchMode: "boolean", maxResults: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    expect(getMatchLocations(result)).toEqual(["test.txt:2", "test.txt:3"]);
  });

  it("finds lines matching AND NOT combination", async () => {
    const root = withTempDir();
    writeFileSync(join(root, "test.txt"), [
      "both error and warning message",
      "only error message",
      "only warning message",
      "neither message",
    ].join("\n"));

    const tool = createSearchTool();
    const result = await tool.execute(
      "boolean-andnot",
      { query: "error AND NOT warning", matchMode: "boolean", maxResults: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    expect(getMatchLocations(result)).toEqual(["test.txt:2"]);
  });

  it("supports parenthesized boolean expressions", async () => {
    const root = withTempDir();
    writeFileSync(join(root, "test.txt"), [
      "line has apple and cat",
      "line has banana and cat",
      "line has apple only",
      "line has cat only",
      "line has neither",
    ].join("\n"));

    const tool = createSearchTool();
    const result = await tool.execute(
      "boolean-parens",
      { query: "(apple OR banana) AND cat", matchMode: "boolean", maxResults: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    expect(getMatchLocations(result)).toEqual(["test.txt:1", "test.txt:2"]);
  });

  it("supports quoted phrases in boolean mode", async () => {
    const root = withTempDir();
    writeFileSync(join(root, "test.txt"), [
      "line has exact phrase here",
      "line has exact but not the whole phrasehere",
      "nothing",
    ].join("\n"));

    const tool = createSearchTool();
    const result = await tool.execute(
      "boolean-phrase",
      { query: '"exact phrase"', matchMode: "boolean", maxResults: 10 },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    expect(getMatchLocations(result)).toEqual(["test.txt:1"]);
  });

  it("handles case sensitivity in boolean mode", async () => {
    const root = withTempDir();
    writeFileSync(join(root, "test.txt"), [
      "line with APPLE and BANANA",
      "line with apple and banana",
      "line with apple only",
    ].join("\n"));

    const tool = createSearchTool();
    const result = await tool.execute(
      "boolean-case",
      {
        query: "APPLE AND BANANA",
        matchMode: "boolean",
        caseSensitive: true,
        maxResults: 10,
      },
      undefined,
      undefined,
      { cwd: root } as any,
    );

    // Only line 3 has both in exact case, but line 3 is "line with APPLE and BANANA"
    // Wait, that's line 1. Let me re-check.
    // Line 1: APPLE and BANANA (both uppercase)
    // Line 3: apple and banana (both lowercase)
    // Query: APPLE AND BANANA (case-sensitive)
    expect(getMatchLocations(result)).toEqual(["test.txt:1"]);
  });

  it("throws on empty query in boolean mode", async () => {
    const root = withTempDir();
    writeFileSync(join(root, "test.txt"), "line with content\n");

    const tool = createSearchTool();
    await expect(
      tool.execute(
        "boolean-empty",
        { query: "", matchMode: "boolean", maxResults: 10 },
        undefined,
        undefined,
        { cwd: root } as any,
      ),
    ).rejects.toThrow(/requires a non-empty "query"/);
  });
});
