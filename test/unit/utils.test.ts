import { DEFAULT_MAX_BYTES } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildPartialSection,
  buildPlan,
  createPathHash,
  formatContentBlock,
  measureText,
  pickDelimiter,
} from "../../utils.js";

function makeCandidate(path: string, text: string, ok: boolean, index: number, body?: string) {
  return { index, path, ok, fullText: text, fullMetrics: measureText(text), body };
}

describe("utils: measureText", () => {
  it("counts bytes and lines", () => {
    expect(measureText("a\nb")).toEqual({ bytes: 3, lines: 2 });
    expect(measureText("")).toEqual({ bytes: 0, lines: 0 });
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
});

describe("utils: buildPartialSection", () => {
  it("fits within remaining budget", () => {
    const body = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(20)}`).join("\n");
    const candidate = makeCandidate("/tmp/large.txt", "ignored", true, 0, body);
    const partial = buildPartialSection(candidate, 40, 1500);
    expect(partial).toBeDefined();
    const m = measureText(partial!);
    expect(m.lines).toBeLessThanOrEqual(40);
    expect(m.bytes).toBeLessThanOrEqual(1500);
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
