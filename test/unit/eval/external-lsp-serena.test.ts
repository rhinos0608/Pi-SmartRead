/**
 * Unit tests for the Serena comparator output parsers (synthetic samples).
 * Serena output is line-granular by design: find_symbol returns 0-based
 * body_location lines without columns, and find_referencing_symbols marks
 * referencing lines with `> N:` markers in content_around_reference.
 */
import { describe, expect, it } from "vitest";
import {
  lineKey,
  parseSerenaFindSymbol,
  parseSerenaReferences,
  SERENA_REF_CANDIDATE_CAP,
} from "../../../scripts/eval/external/lsp/comparators/serena.js";

const ident = (f: string): ((file: string) => string | null) => (file: string) =>
  file === f ? f : null;

describe("parseSerenaFindSymbol", () => {
  it("parses symbol entries into 0-based point locations plus candidates", () => {
    const raw = JSON.stringify([
      { name_path: "greet", kind: "Function", relative_path: "src/a.ts", body_location: { start_line: 0, end_line: 2 } },
      { name_path: "run", kind: "Function", relative_path: "src/b.ts", body_location: { start_line: 1, end_line: 3 } },
    ]);
    const parsed = parseSerenaFindSymbol(raw, "/repo", ident("/repo/src/a.ts"));
    // Only the canonicalizable file survives as a location; candidates keep both.
    expect(parsed.status).toBe("ok");
    expect(parsed.locations).toEqual([
      {
        file: "/repo/src/a.ts",
        start: { file: "/repo/src/a.ts", line: 0, character: 0 },
        end: { file: "/repo/src/a.ts", line: 0, character: 0 },
      },
    ]);
    expect(parsed.candidates).toEqual([
      { namePath: "greet", relativePath: "src/a.ts" },
      { namePath: "run", relativePath: "src/b.ts" },
    ]);
  });

  it("returns empty on malformed JSON or entries without locations", () => {
    expect(parseSerenaFindSymbol("not json", "/repo").status).toBe("empty");
    expect(
      parseSerenaFindSymbol(JSON.stringify([{ name_path: "x" }]), "/repo").status,
    ).toBe("empty");
  });
});

describe("parseSerenaReferences", () => {
  it("parses `> N:` snippet markers into line-anchored locations", () => {
    const raw = JSON.stringify({
      "src/b.ts": {
        File: [
          {
            name_path: "b",
            body_location: { start_line: 0, end_line: 5 },
            content_around_reference:
              '  >   0:import { greet } from "./a";\n...   1:export function run(): string {',
          },
        ],
        Function: [
          {
            name_path: "run",
            body_location: { start_line: 1, end_line: 3 },
            content_around_reference:
              '...   1:export function run(): string {\n  >   2:  return greet("world");\n...   3:}',
          },
        ],
      },
    });
    const parsed = parseSerenaReferences(raw, "/repo", ident("/repo/src/b.ts"));
    expect(parsed.status).toBe("ok");
    expect(parsed.locations).toHaveLength(2);
    expect(parsed.locations[0]?.start).toEqual({ file: "/repo/src/b.ts", line: 0, character: 0 });
    expect(parsed.locations[1]?.start).toEqual({ file: "/repo/src/b.ts", line: 2, character: 0 });
    // Line keys are the Serena-fair scoring unit (no columns by design).
    expect(parsed.locations.map(lineKey)).toEqual([
      "/repo/src/b.ts:0",
      "/repo/src/b.ts:2",
    ]);
  });

  it("dedupes repeated markers and drops unresolvable files", () => {
    const raw = JSON.stringify({
      "src/missing.ts": {
        Function: [
          { name_path: "f", content_around_reference: "  >   4: f();\n  >   4: f();" },
        ],
      },
    });
    const parsed = parseSerenaReferences(raw, "/repo", () => null);
    expect(parsed.status).toBe("empty");
    expect(parsed.locations).toHaveLength(0);
  });

  it("documents the references candidate cap", () => {
    expect(SERENA_REF_CANDIDATE_CAP).toBe(3);
  });
});
