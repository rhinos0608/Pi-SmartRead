import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getTagsRaw } from "../../tags.js";

describe("tags extraction", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tags-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("extracts references from a file with no definitions", async () => {
    const file = join(root, "test.ts");
    // typescript-tags.scm captures type_annotation and new_expression
    writeFileSync(file, "let x: MyType; const y = new MyClass();");
    
    // Note: relFname is used for caching/keys
    const { tags } = await getTagsRaw(file, "test.ts");
    
    console.log("Tags found:", tags);
    expect(tags.some(t => t.name === "MyType" && t.kind === "ref")).toBe(true);
    expect(tags.some(t => t.name === "MyClass" && t.kind === "ref")).toBe(true);
  });
});
