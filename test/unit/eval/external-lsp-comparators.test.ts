/**
 * Unit tests for external LSP comparator output parsers (synthetic samples).
 */
import { describe, expect, it } from "vitest";
import {
  parseMcpDefinition,
  parseMcpHover,
  parseMcpReferences,
} from "../../../scripts/eval/external/lsp/comparators/parse-mcp-output.js";
import { pointLoc, startKey } from "../../../scripts/eval/external/lsp/comparators/types.js";

const ident = (f: string): ((file: string) => string | null) => (file: string) =>
  file === f ? f : null;

describe("parseMcpDefinition", () => {
  it("parses File + 1-indexed Range blocks into 0-based locations", () => {
    const text = [
      "---",
      "",
      "Symbol: myFunc",
      "File: /repo/src/a.ts",
      "Kind: Function",
      "Range: L10:C5 - L12:C1",
      "",
      "   10| function myFunc() {",
      "",
      "---",
      "",
      "Symbol: myFunc",
      "File: /repo/src/b.ts",
      "Range: L3:C1 - L3:C9",
      "",
      "   3| myFunc();",
      "",
    ].join("\n");
    const parsed = parseMcpDefinition(text, ident("/repo/src/a.ts"));
    // Only the canonicalizable file survives.
    expect(parsed.status).toBe("ok");
    expect(parsed.locations).toHaveLength(1);
    expect(parsed.locations[0]).toEqual({
      file: "/repo/src/a.ts",
      start: { file: "/repo/src/a.ts", line: 9, character: 4 },
      end: { file: "/repo/src/a.ts", line: 11, character: 0 },
    });
  });

  it("maps '<name> not found' to empty", () => {
    const parsed = parseMcpDefinition("nope not found", ident("/repo/src/a.ts"));
    expect(parsed.status).toBe("empty");
    expect(parsed.locations).toEqual([]);
  });

  it("maps output with no parseable blocks to empty", () => {
    const parsed = parseMcpDefinition("garbage output", ident("/repo/src/a.ts"));
    expect(parsed.status).toBe("empty");
  });

  it("ignores non-positive coordinates", () => {
    const text = "Symbol: x\nFile: /repo/src/a.ts\nRange: L0:C0 - L0:C0\n";
    const parsed = parseMcpDefinition(text, ident("/repo/src/a.ts"));
    expect(parsed.status).toBe("empty");
  });
});

describe("parseMcpReferences", () => {
  it("parses per-file At: starts as point locations", () => {
    const text = [
      "---",
      "",
      "/repo/src/a.ts",
      "References in File: 2",
      "At: L4:C7, L9:C3",
      "",
      "    4| const x = foo();",
      "---",
      "",
      "/repo/src/b.ts",
      "References in File: 1",
      "At: L2:C1",
      "",
      "    2| foo();",
      "",
    ].join("\n");
    const canon = (f: string): string | null => f;
    const parsed = parseMcpReferences(text, canon);
    expect(parsed.status).toBe("ok");
    expect(parsed.locations).toHaveLength(3);
    expect(parsed.locations[0]).toEqual(pointLoc("/repo/src/a.ts", 3, 6));
    expect(parsed.locations[1]).toEqual(pointLoc("/repo/src/a.ts", 8, 2));
    expect(parsed.locations[2]).toEqual(pointLoc("/repo/src/b.ts", 1, 0));
    // Start keys are stable for set comparison.
    expect(parsed.locations.map(startKey)).toEqual([
      "/repo/src/a.ts:3:6",
      "/repo/src/a.ts:8:2",
      "/repo/src/b.ts:1:0",
    ]);
  });

  it("maps 'No references found' to empty", () => {
    const parsed = parseMcpReferences("No references found for symbol: foo", (f) => f);
    expect(parsed.status).toBe("empty");
    expect(parsed.locations).toEqual([]);
  });

  it("skips blocks whose header path does not canonicalize", () => {
    const text = "---\n\n/elsewhere/x.ts\nReferences in File: 1\nAt: L1:C1\n";
    const parsed = parseMcpReferences(text, () => null);
    expect(parsed.status).toBe("empty");
  });
});

describe("parseMcpHover", () => {
  it("maps 'No hover information available' to empty", () => {
    const parsed = parseMcpHover(
      "No hover information available for this position on the following line:\nconst x = 1;",
    );
    expect(parsed.status).toBe("empty");
  });

  it("passes hover markdown through as ok", () => {
    const parsed = parseMcpHover("```typescript\nfunction foo(): void\n```");
    expect(parsed.status).toBe("ok");
    expect(parsed.text).toContain("function foo()");
  });

  it("maps blank output to empty", () => {
    expect(parseMcpHover("   \n").status).toBe("empty");
  });
});
