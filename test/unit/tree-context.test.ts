import { describe, expect, it } from "vitest";
import { renderTreeContext } from "../../tree-context.js";

describe("renderTreeContext", () => {
  it("renders lines with parent context", async () => {
    const result = await renderTreeContext("line1\nline2\nline3", []);
    expect(result).toBe("");
  });

  it("extracts parent scopes based on indentation", async () => {
    const code = [
      "class MyClass {",
      "  void method() {",
      "    print('hello');",
      "  }",
      "}",
    ].join("\n");

    const result = await renderTreeContext(code, [3]);
    expect(result).toContain("class MyClass {");
    expect(result).toContain("  void method() {");
    expect(result).toContain("    print('hello');");
  });

  it("handles out of range lines gracefully", async () => {
    const code = "line1\nline2";
    await expect(renderTreeContext(code, [0])).resolves.not.toThrow();
    await expect(renderTreeContext(code, [100])).resolves.not.toThrow();
    await expect(renderTreeContext(code, [-1])).resolves.not.toThrow();
  });

  it("handles empty code", async () => {
    const result = await renderTreeContext("", [1]);
    expect(result).toBe("");
  });

  it("shows ellipses between disconnected line blocks", async () => {
    const code = [
      "line1",
      "line2",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line9",
      "line10",
    ].join("\n");

    const result = await renderTreeContext(code, [3, 8]);
    expect(result).toContain("line3");
    expect(result).toContain("⋮...");
    expect(result).toContain("line8");
  });

  it("shows line numbers if enabled", async () => {
    const code = "line1\nline2";
    const result = await renderTreeContext(code, [1], { lineNumbers: true });
    expect(result).toMatch(/^\s*1: line1/);
  });

  it("respects loiPad", async () => {
    const code = "line1\nline2\nline3\nline4\nline5";
    const result = await renderTreeContext(code, [3], { loiPad: 1 });
    expect(result).toContain("line2");
    expect(result).toContain("line3");
    expect(result).toContain("line4");
    expect(result).not.toContain("line1");
    expect(result).not.toContain("line5");
  });
});
