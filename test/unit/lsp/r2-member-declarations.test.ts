import { describe, expect, it } from "vitest";
import type { NormalizedDocumentSymbol } from "../../../src/lsp/lsp-response-normalizer.js";
import { classifyReferenceRole } from "../../../src/lsp/lsp-r2-shaping.js";

function sel(
  name: string,
  kind: number,
  selStart: { line: number; character: number },
  selEnd: { line: number; character: number },
  rangeEnd = selEnd,
  children?: NormalizedDocumentSymbol[],
): NormalizedDocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line: 0, character: 0 }, end: rangeEnd },
    selectionRange: { start: selStart, end: selEnd },
    ...(children ? { children } : {}),
  };
}

describe("r2 member declarations inside hierarchical symbols", () => {
  it("classifies a nested method declaration as declaration", () => {
    const lines = [`class Foo {`, `  bar() { return 1; }`, `}`];
    const symbols = [
      sel("Foo", 5, { line: 0, character: 6 }, { line: 0, character: 9 }, { line: 2, character: 1 }, [
        sel("bar", 6, { line: 1, character: 2 }, { line: 1, character: 5 }),
      ]),
    ];
    expect(classifyReferenceRole(lines, 1, 3, symbols)).toBe("declaration");
  });

  it("classifies a nested field/property declaration as declaration", () => {
    const lines = [`class Foo {`, `  prop: number;`, `}`];
    const symbols = [
      sel("Foo", 5, { line: 0, character: 6 }, { line: 0, character: 9 }, { line: 2, character: 1 }, [
        sel("prop", 8, { line: 1, character: 2 }, { line: 1, character: 6 }),
      ]),
    ];
    expect(classifyReferenceRole(lines, 1, 3, symbols)).toBe("declaration");
  });

  it("classifies a doubly-nested member (2+ levels) as declaration", () => {
    const lines = [`class Outer {`, `  // inner`, `  get value() { return 1; }`, `}`];
    const symbols = [
      sel("Outer", 5, { line: 0, character: 6 }, { line: 0, character: 11 }, { line: 3, character: 1 }, [
        sel("Inner", 5, { line: 0, character: 6 }, { line: 0, character: 11 }, { line: 3, character: 1 }, [
          sel("value", 6, { line: 2, character: 6 }, { line: 2, character: 11 }),
        ]),
      ]),
    ];
    expect(classifyReferenceRole(lines, 2, 7, symbols)).toBe("declaration");
  });

  it("classifies an interface property declaration as declaration", () => {
    const lines = [`interface Shape {`, `  area: number;`, `}`];
    const symbols = [
      sel("Shape", 11, { line: 0, character: 10 }, { line: 0, character: 15 }, { line: 2, character: 1 }, [
        sel("area", 7, { line: 1, character: 2 }, { line: 1, character: 6 }),
      ]),
    ];
    expect(classifyReferenceRole(lines, 1, 3, symbols)).toBe("declaration");
  });

  it("keeps a use inside a method body as use", () => {
    const lines = [`class Foo {`, `  bar() { return baz; }`, `}`];
    const symbols = [
      sel("Foo", 5, { line: 0, character: 6 }, { line: 0, character: 9 }, { line: 2, character: 1 }, [
        sel("bar", 6, { line: 1, character: 2 }, { line: 1, character: 5 }),
      ]),
    ];
    // baz is not covered by any selectionRange, so it stays a use.
    expect(classifyReferenceRole(lines, 1, 19, symbols)).toBe("use");
  });

  it("keeps import and export bindings as import/export with nested symbols present", () => {
    const importLines = [`import { foo } from "./m";`];
    const exportLines = [`export { foo } from "./m";`];
    const symbols = [
      sel("Foo", 5, { line: 0, character: 6 }, { line: 0, character: 9 }, { line: 0, character: 30 }, [
        sel("bar", 6, { line: 0, character: 2 }, { line: 0, character: 5 }),
      ]),
    ];
    expect(classifyReferenceRole(importLines, 0, 9, symbols)).toBe("import");
    expect(classifyReferenceRole(exportLines, 0, 9, symbols)).toBe("export");
  });

  it("treats the selectionRange end boundary as a declaration", () => {
    const lines = [`class Foo {`, `  bar() { return 1; }`, `}`];
    const symbols = [
      sel("Foo", 5, { line: 0, character: 6 }, { line: 0, character: 9 }, { line: 2, character: 1 }, [
        sel("bar", 6, { line: 1, character: 2 }, { line: 1, character: 5 }),
      ]),
    ];
    // containsPos is end-inclusive: the exact end offset still declares.
    expect(classifyReferenceRole(lines, 1, 5, symbols)).toBe("declaration");
  });

  it("fails open to use when symbols are unavailable or ambiguous", () => {
    expect(classifyReferenceRole([`  bar() { return 1; }`], 0, 3, null)).toBe("use");
    expect(classifyReferenceRole([`  prop: number;`], 0, 3, [])).toBe("use");
  });
});
