import { describe, it, expect, beforeAll } from "vitest";
import { computeLineHashSync, computeLineHash, initHashline } from "../../src/hashline.js";

// Parity approach: (b) hardcoded ground truth from Pi-SmartEdit's real computeLineHashSync.
// Chosen over (a) live cross-repo import because it keeps the test hermetic — no dependency
// on sibling checkout path or SmartEdit build state in CI. Ground truth was derived by
// importing Pi-SmartEdit/src/core/hashline.ts and calling computeLineHashSync on each fixture.
// See regeneration note below.

type Fixture = { label: string; lineNumber: number; line: string; expected: string };

// Ground truth derived from Pi-SmartEdit/src/core/hashline.ts computeLineHashSync
// Date: 2026-05-13
// Regenerate: node --input-type=module -e 'import * as m from "../Pi-SmartEdit/src/core/hashline.ts"; await m.initHashline(); console.log(m.computeLineHashSync(n, line))' for each fixture,
// or re-run the script in Pi-SmartRead: node --input-type=module < gen-script.js>
// If either repo's algorithm/bigram table changes, update these literals and date.
const fixtures: Fixture[] = [
  { label: "ascii simple", lineNumber: 1, line: "function hello() {", expected: "na" },
  { label: "ascii empty", lineNumber: 2, line: "", expected: "nd" },
  { label: "ascii spaces", lineNumber: 3, line: "   ", expected: "rd" },
  { label: "ascii digits", lineNumber: 4, line: "const x = 42;", expected: "av" },
  { label: "accented café", lineNumber: 5, line: "café", expected: "tu" },
  { label: "accented résumé", lineNumber: 6, line: "résumé naïve", expected: "yi" },
  { label: "accented über", lineNumber: 10, line: "übermäßig", expected: "xr" },
  { label: "cjk hello world", lineNumber: 7, line: "你好世界", expected: "xh" },
  { label: "cjk mixed ascii", lineNumber: 8, line: "hello 你好 world", expected: "rn" },
  { label: "cjk japanese", lineNumber: 20, line: "こんにちは", expected: "as" },
  { label: "unicode digits arabic-indic", lineNumber: 9, line: "٠١٢٣", expected: "qt" },
  { label: "unicode digits devanagari", lineNumber: 11, line: "०१२", expected: "un" },
  { label: "unicode digits fullwidth", lineNumber: 12, line: "０１２３", expected: "et" },
  { label: "structural braces", lineNumber: 1, line: "{", expected: "st" },
  { label: "structural braces with spaces", lineNumber: 2, line: "  {  ", expected: "nd" },
  { label: "structural closing", lineNumber: 3, line: "}", expected: "rd" },
  { label: "punct only dashes", lineNumber: 13, line: "---", expected: "au" },
  { label: "punct only slashes", lineNumber: 14, line: "// ---", expected: "gq" },
  { label: "punct only separators", lineNumber: 42, line: "=====", expected: "nb" },
  { label: "crlf ascii", lineNumber: 15, line: "hello\r", expected: "pt" },
  { label: "crlf cjk", lineNumber: 16, line: "你好\r", expected: "sl" },
  { label: "crlf with content", lineNumber: 17, line: "café\r", expected: "tu" },
  { label: "trailing spaces ascii", lineNumber: 18, line: "hello   ", expected: "pt" },
  { label: "trailing spaces cjk", lineNumber: 19, line: "你好世界   ", expected: "xh" },
  { label: "trailing tab", lineNumber: 21, line: "café\t  ", expected: "tu" },
  { label: "trailing whitespace + crlf", lineNumber: 22, line: "hello   \r", expected: "pt" },
  { label: "bom ascii", lineNumber: 23, line: "\uFEFFhello", expected: "pt" },
  { label: "bom cjk", lineNumber: 24, line: "\uFEFF你好", expected: "sl" },
];

describe("hashline", () => {
  beforeAll(async () => {
    await initHashline();
  });

  it("normalizes: strips BOM, \\r, trailing whitespace before hashing", async () => {
    expect(computeLineHashSync(1, "hello   ")).toBe(computeLineHashSync(1, "hello"));
    expect(computeLineHashSync(1, "hello   \r")).toBe(computeLineHashSync(1, "hello"));
    expect(computeLineHashSync(1, "hello\r")).toBe(computeLineHashSync(1, "hello"));
    expect(computeLineHashSync(1, "\uFEFFhello")).toBe(computeLineHashSync(1, "hello"));
  });

  it("structural lines use ordinal bigrams", () => {
    expect(computeLineHashSync(1, "")).toBe("st");
    expect(computeLineHashSync(2, "")).toBe("nd");
    expect(computeLineHashSync(3, "")).toBe("rd");
    expect(computeLineHashSync(4, "")).toBe("th");
    expect(computeLineHashSync(11, "")).toBe("th");
    expect(computeLineHashSync(12, "{")).toBe("th");
    expect(computeLineHashSync(21, "  {  ")).toBe("st");
  });

  it("unicode significant chars affect seed (not structural/seed collision)", () => {
    const a = computeLineHashSync(10, "---");
    const b = computeLineHashSync(11, "---");
    expect(a).not.toBe(b);

    const cjk10 = computeLineHashSync(10, "你好");
    const cjk99 = computeLineHashSync(99, "你好");
    expect(cjk10).toBe(cjk99);
  });

  it("cross-repo parity: each fixture matches SmartEdit ground truth (sync)", () => {
    for (const f of fixtures) {
      const actual = computeLineHashSync(f.lineNumber, f.line);
      expect(actual, `parity sync: ${f.label} (line ${f.lineNumber}: ${JSON.stringify(f.line)})`).toBe(f.expected);
    }
  });

  it("cross-repo parity: each fixture matches SmartEdit ground truth (async)", async () => {
    for (const f of fixtures) {
      const actual = await computeLineHash(f.lineNumber, f.line);
      expect(actual, `parity async: ${f.label}`).toBe(f.expected);
    }
  });

  it("regression: non-ASCII letters are significant (would fail with ASCII-only detection)", () => {
    // CJK / accented / non-ASCII digits must hash identically across different line numbers (seed 0).
    // ASCII-only /[\w]/ would treat them as insignificant (seed=lineNumber) and diverge.
    expect(computeLineHashSync(5, "你好世界")).toBe(computeLineHashSync(99, "你好世界"));
    expect(computeLineHashSync(5, "é")).toBe(computeLineHashSync(99, "é"));
    expect(computeLineHashSync(5, "٠١٢")).toBe(computeLineHashSync(99, "٠١٢"));
  });
});
