/**
 * Tests for tree-context rendering.
 */
import { describe, it, expect } from "vitest";
import { renderTreeContext } from "../../tree-context.js";

describe("renderTreeContext", () => {
  it("returns empty string for empty lines of interest", () => {
    const result = renderTreeContext("line1\nline2\nline3", []);
    expect(result).toBe("");
  });

  it("includes parent context for nested code", () => {
    const code = [
      "class Foo {",
      "  method1() {",
      "    const x = 1;",
      "  }",
      "  method2() {",
      "    const y = 2;",
      "  }",
      "}",
    ].join("\n");

    // Line of interest is the const declaration inside method2 (line 6)
    const result = renderTreeContext(code, [6]);

    // Should include the class header, method2 header, and the const line
    expect(result).toContain("class Foo {");
    expect(result).toContain("method2()");
    expect(result).toContain("const y = 2;");
    // Should NOT include method1 internals
    expect(result).not.toContain("method1()");
    expect(result).not.toContain("const x = 1;");
  });

  it("handles out-of-bounds line numbers gracefully", () => {
    const code = "line1\nline2\n";
    // Should not throw
    expect(() => renderTreeContext(code, [0])).not.toThrow();
    expect(() => renderTreeContext(code, [100])).not.toThrow();
    expect(() => renderTreeContext(code, [-1])).not.toThrow();
  });

  it("handles empty code", () => {
    const result = renderTreeContext("", [1]);
    expect(result).toBe("");
  });

  it("inserts ellipsis for gaps between visible lines", () => {
    const code = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    const result = renderTreeContext(code, [3, 8]);

    expect(result).toContain("line3");
    expect(result).toContain("line8");
    expect(result).toContain("⋮...");
  });

  it("returns the line when no parent context exists", () => {
    const code = "const x = 1;";
    const result = renderTreeContext(code, [1]);
    expect(result).toContain("const x = 1;");
  });

  it("handles single line of interest at top level", () => {
    const code = [
      "const a = 1;",
      "",
      "function foo() {",
      "  return a + b;",
      "}",
    ].join("\n");

    const result = renderTreeContext(code, [3]);
    // Line 3 is 'function foo() {' — parent context walker finds nothing less-indented
    // Only the line of interest itself should be included
    expect(result).toContain("function foo() {");
    expect(result).not.toContain("return a + b;");
  });
});
