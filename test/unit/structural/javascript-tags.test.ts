import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTagsRaw } from "../../../src/structural/tags.js";

describe("javascript tags query", () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-smartread-js-tags-"));
    filePath = join(root, "sample.js");
    writeFileSync(
      filePath,
      [
        "function greet(name) {",
        "  return \"hi \" + name;",
        "}",
        "",
        "class Widget {",
        "  render() {",
        "    return greet(\"x\");",
        "  }",
        "}",
        "",
        "module.exports = { greet, Widget };",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("extracts function, class, and method definitions from JavaScript", async () => {
    const { tags } = await getTagsRaw(filePath, "sample.js");
    const defs = tags.filter((tag) => tag.kind === "def").map((tag) => tag.name);
    expect(defs).toContain("greet");
    expect(defs).toContain("Widget");
    expect(defs).toContain("render");
  });
});
