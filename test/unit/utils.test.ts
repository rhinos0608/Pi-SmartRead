import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type FileCandidate,
  buildPartialSection,
  buildPlan,
  coerceText,
  createPathHash,
  ensureHashlineReady,
  formatContentBlock,
  measureText,
  parseMultiRangeSelector,
  pickDelimiter,
  resolveMultiRangeContent,
  resolveWorkspacePath,
  resolveDirectoryParam,
  selectorToOffsetLimit,
  selectorToStartLine,
  splitPathAndSelector,
} from "../../src/utils.js";

beforeAll(async () => {
  await ensureHashlineReady();
});

function makeCandidate(path: string, text: string, ok: boolean, index: number, body?: string): FileCandidate {
  return { index, path, ok, fullText: text, fullMetrics: measureText(text), body };
}

describe("utils: measureText", () => {
  it("counts bytes and lines", () => {
    expect(measureText("a\nb")).toEqual({ bytes: 3, lines: 2 });
    expect(measureText("")).toEqual({ bytes: 0, lines: 0 });
  });
});

describe("utils: coerceText", () => {
  it("preserves strings and turns non-string text block payloads into strings", () => {
    expect(coerceText("hello")).toBe("hello");
    expect(coerceText(null)).toBe("");
    expect(coerceText(undefined)).toBe("");
    expect(coerceText({ nested: "value" })).toBe('{"nested":"value"}');
    expect(coerceText(42)).toBe("42");
  });
});

describe("utils: createPathHash", () => {
  it("is deterministic and produces 6 hex chars", () => {
    expect(createPathHash("/tmp/a.txt")).toBe(createPathHash("/tmp/a.txt"));
    expect(createPathHash("/tmp/a.txt")).not.toBe(createPathHash("/tmp/b.txt"));
    expect(createPathHash("/tmp/a.txt")).toMatch(/^[0-9A-F]{6}$/);
  });
});

describe("utils: pickDelimiter", () => {
  it("adds suffix when base collides with content", () => {
    const path = "/tmp/collide.txt";
    const base = `PINE_1_${createPathHash(path)}`;
    const picked = pickDelimiter(path, 1, `hello\n${base}\nworld`);
    expect(picked).toBe(`${base}_1`);
  });

  it("falls back after 256 suffix collisions", () => {
    const path = "/tmp/deep-collide.txt";
    const base = `PINE_1_${createPathHash(path)}`;
    const collisions = [base, ...Array.from({ length: 256 }, (_, i) => `${base}_${i + 1}`)];
    const picked = pickDelimiter(path, 1, collisions.join("\n"));
    expect(new Set(collisions).has(picked)).toBe(false);
  });
});

describe("utils: formatContentBlock", () => {
  it("wraps body in heredoc with matching delimiter", () => {
    const block = formatContentBlock("/tmp/file.txt", "line 1\nline 2", 3);
    const lines = block.split("\n");
    expect(lines[0]).toBe("@/tmp/file.txt");
    expect(lines[1]).toMatch(/^<<'ORBIT_3_[0-9A-F]{6}(?:_.*)?'$/);
    const delimiter = lines[1]!.slice(3, -1);
    expect(lines.at(-1)).toBe(delimiter);
  });

  it("supports absolute hashline offsets for partial content", () => {
    const block = formatContentBlock("/tmp/file.txt", "line 20\nline 21", 3, { startLine: 20 });
    const bodyLines = block.split("\n").slice(2, -1);
    expect(bodyLines[0]).toMatch(/^20[a-z]{2}\|line 20$/);
    expect(bodyLines[1]).toMatch(/^21[a-z]{2}\|line 21$/);
  });
});

describe("utils: selector parsing", () => {
  it("splits file selectors from local paths", () => {
    expect(splitPathAndSelector("/tmp/file.ts:2-4")).toEqual({ path: "/tmp/file.ts", selector: "2-4" });
    expect(splitPathAndSelector("/tmp/file.ts:raw")).toEqual({ path: "/tmp/file.ts", selector: "raw" });
  });

  it("leaves URL-like paths untouched", () => {
    expect(splitPathAndSelector("https://example.com/file.ts:2-4")).toEqual({
      path: "https://example.com/file.ts:2-4",
    });
  });

  it("converts selectors to offset and limit", () => {
    expect(selectorToOffsetLimit("2-4")).toEqual({ offset: 2, limit: 3, raw: false });
    expect(selectorToOffsetLimit("5")).toEqual({ offset: 5, limit: 1, raw: false });
    expect(selectorToOffsetLimit("raw")).toEqual({ raw: true });
  });

  it("returns the selector start line with fallback", () => {
    expect(selectorToStartLine("7-9")).toBe(7);
    expect(selectorToStartLine(undefined, 3)).toBe(3);
  });
});

describe("utils: parseMultiRangeSelector", () => {
  it("parses single range", () => {
    const result = parseMultiRangeSelector("1-50");
    expect(result).toEqual({ ranges: [{ start: 1, end: 50 }], raw: false });
  });

  it("parses multiple comma-separated ranges", () => {
    const result = parseMultiRangeSelector("1-50,960-973");
    expect(result).toEqual({
      ranges: [
        { start: 1, end: 50 },
        { start: 960, end: 973 },
      ],
      raw: false,
    });
  });

  it("parses compound raw+range selector", () => {
    const result = parseMultiRangeSelector("1-50:raw");
    expect(result).toEqual({ ranges: [{ start: 1, end: 50 }], raw: true });
  });

  it("parses compound range+raw selector", () => {
    const result = parseMultiRangeSelector("raw:1-50");
    expect(result).toEqual({ ranges: [{ start: 1, end: 50 }], raw: true });
  });

  it("parses raw mode without range", () => {
    expect(parseMultiRangeSelector("raw")).toEqual({ ranges: [], raw: true });
  });

  it("parses open-ended range (start to EOF)", () => {
    const result = parseMultiRangeSelector("100-");
    expect(result).toEqual({ ranges: [{ start: 100, end: Infinity }], raw: false });
  });

  it("parses count-based range (start+count)", () => {
    const result = parseMultiRangeSelector("10+5");
    expect(result).toEqual({ ranges: [{ start: 10, end: 14 }], raw: false });
  });

  it("parses single line as range", () => {
    const result = parseMultiRangeSelector("42");
    expect(result).toEqual({ ranges: [{ start: 42, end: 42 }], raw: false });
  });

  it("parses multiple ranges with different formats", () => {
    const result = parseMultiRangeSelector("1-10,20+5,30,100-");
    expect(result).toEqual({
      ranges: [
        { start: 1, end: 10 },
        { start: 20, end: 24 },
        { start: 30, end: 30 },
        { start: 100, end: Infinity },
      ],
      raw: false,
    });
  });

  it("merges overlapping ranges", () => {
    const result = parseMultiRangeSelector("1-50,40-100");
    expect(result).toEqual({ ranges: [{ start: 1, end: 100 }], raw: false });
  });

  it("merges adjacent ranges", () => {
    const result = parseMultiRangeSelector("1-50,51-100");
    expect(result).toEqual({ ranges: [{ start: 1, end: 100 }], raw: false });
  });

  it("returns empty ranges for invalid input", () => {
    expect(parseMultiRangeSelector("")).toEqual({ ranges: [] });
    expect(parseMultiRangeSelector(undefined)).toEqual({ ranges: [] });
  });

  it("ignores invalid range specs", () => {
    const result = parseMultiRangeSelector("1-50,invalid,100-200");
    expect(result).toEqual({
      ranges: [
        { start: 1, end: 50 },
        { start: 100, end: 200 },
      ],
      raw: false,
    });
  });

  it("rejects ranges with end < start", () => {
    const result = parseMultiRangeSelector("50-10");
    expect(result).toEqual({ ranges: [], raw: false });
  });

  it("rejects ranges starting with 0 or negative", () => {
    const result = parseMultiRangeSelector("0-50,-5-10");
    expect(result).toEqual({ ranges: [], raw: false });
  });
});

describe("utils: resolveMultiRangeContent", () => {
  const tenLines = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";

  it("returns full text when no ranges specified", () => {
    const result = resolveMultiRangeContent(tenLines, { ranges: [] });
    expect(result).toBe(tenLines);
  });

  it("extracts a single range", () => {
    const result = resolveMultiRangeContent(tenLines, { ranges: [{ start: 2, end: 4 }] });
    // Includes elision marker for lines before the range
    expect(result).toContain("line2");
    expect(result).toContain("line3");
    expect(result).toContain("line4");
    expect(result).toContain("1 line omitted");
  });

  it("extracts multiple ranges with elision markers", () => {
    const result = resolveMultiRangeContent(tenLines, {
      ranges: [
        { start: 1, end: 2 },
        { start: 9, end: 10 },
      ],
    });
    // Should show first 2 lines, elision marker, last 2 lines
    expect(result).toContain("line1");
    expect(result).toContain("line2");
    expect(result).toContain("line9");
    expect(result).toContain("line10");
    expect(result).toContain("lines omitted");
  });

  it("handles open-ended range to EOF", () => {
    const result = resolveMultiRangeContent(tenLines, { ranges: [{ start: 8, end: Infinity }] });
    // Includes elision marker for lines before the range
    expect(result).toContain("line8");
    expect(result).toContain("line9");
    expect(result).toContain("line10");
    expect(result).toContain("7 lines omitted");
  });

  it("handles range beyond file length", () => {
    const result = resolveMultiRangeContent(tenLines, { ranges: [{ start: 1, end: 100 }] });
    expect(result).toBe(tenLines);
  });

  it("returns empty string for empty file with ranges", () => {
    const result = resolveMultiRangeContent("", { ranges: [{ start: 1, end: 10 }] });
    expect(result).toBe("");
  });

  it("marks single omitted line correctly", () => {
    const result = resolveMultiRangeContent(tenLines, {
      ranges: [{ start: 1, end: 1 }, { start: 3, end: 3 }],
    });
    expect(result).toContain("1 line omitted");
  });

  it("marks multiple omitted lines correctly", () => {
    const result = resolveMultiRangeContent(tenLines, {
      ranges: [{ start: 1, end: 1 }, { start: 5, end: 5 }],
    });
    expect(result).toContain("3 lines omitted");
  });
});

describe("utils: multi-range selector via selectorToOffsetLimit", () => {
  it("uses first range for backward compatibility", () => {
    const result = selectorToOffsetLimit("1-50,960-973");
    expect(result).toEqual({ offset: 1, limit: 50, raw: false });
  });

  it("captures raw flag from compound selectors", () => {
    expect(selectorToOffsetLimit("1-50:raw")).toEqual({ offset: 1, limit: 50, raw: true });
    expect(selectorToOffsetLimit("raw:1-50")).toEqual({ offset: 1, limit: 50, raw: true });
  });
});

describe("utils: buildPartialSection", () => {
  it("fits within remaining budget", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n");
    const candidate = makeCandidate("/tmp/large.txt", "ignored", true, 0, body);
    candidate.startLine = 12;
    const partial = buildPartialSection(candidate, 40, 1500);
    expect(partial).toBeDefined();
    const m = measureText(partial!);
    expect(m.lines).toBeLessThanOrEqual(40);
    expect(m.bytes).toBeLessThanOrEqual(1500);
    expect(partial?.split("\n")[2]).toMatch(/^12[a-z]{2}\|line-0-/);
  });
});

describe("utils: resolveWorkspacePath (opt-in boundary)", () => {
  it("resolves paths without restriction when no env is set", () => {
    const result = resolveWorkspacePath("/tmp", "file.ts");
    expect(result).toBe(require("node:path").resolve("/tmp", "file.ts"));
  });

  it("throws for empty path", () => {
    expect(() => resolveWorkspacePath("/tmp", "")).toThrow();
  });
});

describe("utils: resolveDirectoryParam (opt-in boundary)", () => {
  it("resolves directory without restriction when no env is set", () => {
    const result = resolveDirectoryParam("/tmp", undefined);
    // canonicalPath resolves symlinks (e.g. /tmp -> /private/tmp on macOS)
    const expected = require("node:fs").realpathSync("/tmp");
    expect(result).toBe(expected);
  });

  it("resolves explicit directory", () => {
    const dir = require("node:path").resolve("/tmp", "sub");
    require("node:fs").mkdirSync(dir, { recursive: true });
    try {
      const result = resolveDirectoryParam("/tmp", "sub");
      // canonicalPath resolves symlinks (e.g. /tmp -> /private/tmp on macOS)
      const expected = require("node:fs").realpathSync(dir);
      expect(result).toBe(expected);
    } finally {
      require("node:fs").rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("utils: buildPlan", () => {
  it("request-order stops on first non-fitting block", () => {
    const huge = "H".repeat(DEFAULT_MAX_BYTES + 128);
    const candidates = [
      makeCandidate("/a", "small-a", true, 0),
      makeCandidate("/b", huge, true, 1),
      makeCandidate("/c", "small-c", true, 2),
    ];
    const plan = buildPlan("request-order", [0, 1, 2], candidates);
    expect(plan.fullIncluded.has(0)).toBe(true);
    expect(plan.fullIncluded.has(2)).toBe(false);
  });

  it("counts successful full blocks separately", () => {
    const candidates = [
      makeCandidate("/ok-1", "x", true, 0),
      makeCandidate("/err", "y", false, 1),
      makeCandidate("/ok-2", "z", true, 2),
    ];
    const plan = buildPlan("request-order", [0, 1, 2], candidates);
    expect(plan.fullCount).toBe(3);
    expect(plan.fullSuccessCount).toBe(2);
  });
});
