/**
 * Unit tests for the external LSP benchmark pure functions.
 */
import { describe, expect, it } from "vitest";
import {
  checkHover,
  classifyDisagreement,
  dedupeByFile,
  definitionMatches,
  definitionMatchesStart,
  estimateTokens,
  isAnswered,
  isNonAnswer,
  locKey,
  percentile,
  setMetrics,
} from "../../../scripts/eval/external/lsp/metrics.js";
import { sampleCorpus, seededRng, STRATA } from "../../../scripts/eval/external/lsp/sample.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const loc = (file: string, sl: number, sc: number, el: number, ec: number) => ({
  file,
  start: { file, line: sl, character: sc },
  end: { file, line: el, character: ec },
});

describe("locKey/definitionMatches", () => {
  it("matches identical locations exactly", () => {
    const a = loc("/r/a.ts", 1, 2, 1, 5);
    expect(definitionMatches(a, { ...a })).toBe(true);
    expect(definitionMatchesStart(a, { ...a })).toBe(true);
  });
  it("rejects file and end drift for exact, tolerates end drift for start", () => {
    const a = loc("/r/a.ts", 1, 2, 1, 5);
    const driftEnd = loc("/r/a.ts", 1, 2, 1, 9);
    expect(definitionMatches(a, driftEnd)).toBe(false);
    expect(definitionMatchesStart(a, driftEnd)).toBe(true);
    expect(definitionMatches(a, loc("/r/b.ts", 1, 2, 1, 5))).toBe(false);
    expect(definitionMatchesStart(a, loc("/r/a.ts", 1, 3, 1, 5))).toBe(false);
  });
  it("produces stable keys", () => {
    expect(locKey(loc("/r/a.ts", 1, 2, 1, 5))).toBe("/r/a.ts:1:2:1:5");
  });
});

describe("setMetrics", () => {
  it("computes precision/recall/F1", () => {
    const m = setMetrics(["a", "b", "c"], ["b", "c", "d"]);
    expect(m.precision).toBeCloseTo(2 / 3);
    expect(m.recall).toBeCloseTo(2 / 3);
    expect(m.f1).toBeCloseTo(2 / 3);
  });
  it("scores empty/empty as 1 and empty/non-empty as 0", () => {
    expect(setMetrics([], []).f1).toBe(1);
    expect(setMetrics(["a"], []).recall).toBe(0);
    expect(setMetrics([], ["a"]).precision).toBe(0);
  });
});

describe("status categorization", () => {
  it("counts non-answers separately from wrong answers", () => {
    for (const s of ["unsupported", "unavailable", "not_ready", "timeout", "cancelled", "error", "ambiguous"]) {
      expect(isNonAnswer(s)).toBe(true);
      expect(isAnswered(s)).toBe(false);
    }
    expect(isNonAnswer("ok")).toBe(false);
    expect(isAnswered("ok")).toBe(true);
    expect(isAnswered("empty")).toBe(true);
  });
});

describe("checkHover", () => {
  it("flags empty and signature presence", () => {
    expect(checkHover("   ", "foo")).toEqual({ nonEmpty: false, signatureMatch: false });
    expect(checkHover("function foo(): void", "foo")).toEqual({ nonEmpty: true, signatureMatch: true });
    expect(checkHover("some docs", "foo")).toEqual({ nonEmpty: true, signatureMatch: false });
  });
});

describe("dedupeByFile", () => {
  it("keeps first appearance per file", () => {
    const a = loc("/r/a.ts", 1, 0, 1, 3);
    const a2 = loc("/r/a.ts", 9, 0, 9, 3);
    const b = loc("/r/b.ts", 2, 0, 2, 3);
    expect(dedupeByFile([a, a2, b])).toEqual([a, b]);
  });
});

describe("classifyDisagreement", () => {
  it("categorizes lib, alias, declaration drift", () => {
    expect(classifyDisagreement({ refFile: "/r/node_modules/x.d.ts", altFile: "/r/a.ts", refIsDeclaration: true, altIsDeclaration: false, nameInRefTarget: false })).toBe("lib-external-decl");
    expect(classifyDisagreement({ refFile: "/r/a.ts", altFile: "/r/b.ts", refIsDeclaration: false, altIsDeclaration: false, nameInRefTarget: false })).toBe("alias");
    expect(classifyDisagreement({ refFile: "/r/a.ts", altFile: "/r/b.ts", refIsDeclaration: true, altIsDeclaration: false, nameInRefTarget: true })).toBe("declaration-vs-definition");
    expect(classifyDisagreement({ refFile: "/r/a.ts", altFile: "/r/b.ts", refIsDeclaration: false, altIsDeclaration: false, nameInRefTarget: true })).toBe("other");
  });
});

describe("percentile/estimateTokens", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([5], 95)).toBe(5);
    expect(() => percentile([], 50)).toThrow();
  });
  it("estimates tokens from chars", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("sampler determinism", () => {
  const fixture = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-sample-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "a.ts"),
      `import { join } from "node:path";\nexport function greet(name: string): string {\n  return join("hi", name);\n}\nexport type Alias = string;\nconst v: Alias = greet("x");\nconsole.log(v.length);\n`,
    );
    return dir;
  };
  it("is deterministic and stratified across runs", () => {
    const dir = fixture();
    const a = sampleCorpus(dir, { seed: 7, perCorpus: 20 });
    const b = sampleCorpus(dir, { seed: 7, perCorpus: 20 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    for (const p of a) {
      expect(p.line).toBeGreaterThanOrEqual(0);
      expect(p.character).toBeGreaterThanOrEqual(0);
      expect(STRATA).toContain(p.stratum);
    }
  });
  it("seeded RNG is reproducible", () => {
    const r1 = seededRng(42);
    const r2 = seededRng(42);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});
