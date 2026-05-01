import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTagsRaw } from "../../tags.js";

describe("tree-sitter tag extraction", () => {
  let root: string;
  let filePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-smartread-tags-"));
    filePath = join(root, "sample.ts");
    writeFileSync(
      filePath,
      [
        "export function demo(x: number) {",
        "  return x + 1;",
        "}",
        "",
        "const value = demo(2);",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("extracts definitions and references from TypeScript", async () => {
    const { tags } = await getTagsRaw(filePath, "sample.ts");

    expect(tags.some((tag) => tag.kind === "def" && tag.name === "demo")).toBe(true);
    expect(tags.some((tag) => tag.kind === "ref" && tag.name === "demo")).toBe(true);
  });

  it("extracts tags from TypeScript files larger than 32KB", async () => {
    let code = [
      "export function demo(x: number) {",
      "  return x + 1;",
      "}",
      "",
    ].join("\n");

    while (code.length < 33_000) {
      code += `\nconst value${code.length} = demo(2);`;
    }

    writeFileSync(filePath, `${code}\n`);

    const { tags } = await getTagsRaw(filePath, "sample.ts");

    expect(tags.some((tag) => tag.kind === "def" && tag.name === "demo")).toBe(true);
    expect(tags.some((tag) => tag.kind === "ref" && tag.name === "demo")).toBe(true);
  });
});
