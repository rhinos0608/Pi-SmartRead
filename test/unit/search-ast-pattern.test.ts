import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPatternFallbackRegex,
  matchAstNodesInFile,
  parseAstPattern,
  tokenizeAstPattern,
} from "../../src/search-ast-pattern.js";
// NOTE: search-tool.js facade re-export (parseAstPattern, ParsedAstPattern)
// is verified via `tsc --noEmit`, not imported here: search-tool.js
// transitively pulls src/hook.ts, which has pre-existing unrelated
// unstaged breakage (top-level return) from another session.

describe("search-ast-pattern extract (Seam1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ast-pattern-test-"));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("parses function return pattern", () => {
    const parsed = parseAstPattern("fn * -> Result");
    expect(parsed).not.toBeNull();
    expect(parsed!.nodeTypes).toContain("function_declaration");
    expect(parsed!.returnTypePattern).toBe("Result");
    expect(parsed!.fallbackRegex).toBeInstanceOf(RegExp);
  });

  it("parses class inherit pattern", () => {
    const parsed = parseAstPattern("class * extends Base");
    expect(parsed).not.toBeNull();
    expect(parsed!.nodeTypes).toContain("class_declaration");
    expect(parsed!.extendsPattern).toBe("Base");
  });

  it("parses async glob pattern", () => {
    const parsed = parseAstPattern("async fn process_*");
    expect(parsed).not.toBeNull();
    expect(parsed!.isAsync).toBe(true);
    expect(parsed!.namePattern).toBe("process_*");
  });

  it("matches a TS function by return type via tree-sitter", async () => {
    const file = join(dir, "sample.ts");
    writeFileSync(
      file,
      `function fetchUser(): Result { return ok(); }\nfunction helper(): void {}\n`,
    );
    const query = parseAstPattern("fn * -> Result");
    expect(query).not.toBeNull();
    const hits = await matchAstNodesInFile(file, "typescript", query!);
    expect(hits.map((h) => h.name)).toContain("fetchUser");
    expect(hits.map((h) => h.name)).not.toContain("helper");
  });

  it("matches a TS class by superclass via tree-sitter", async () => {
    const file = join(dir, "shapes.ts");
    writeFileSync(file, `class Child extends Base {}\nclass Plain {}\n`);
    const query = parseAstPattern("class * extends Base");
    expect(query).not.toBeNull();
    const hits = await matchAstNodesInFile(file, "typescript", query!);
    expect(hits.map((h) => h.name)).toContain("Child");
    expect(hits.map((h) => h.name)).not.toContain("Plain");
  });

  it("falls back to regex for Rust impl and Python class lines", () => {
    const implQuery = parseAstPattern("impl * for *");
    expect(implQuery).not.toBeNull();
    expect(implQuery!.forTypePattern).toBe("*");
    expect(implQuery!.fallbackRegex!.test("impl Foo for Bar {")).toBe(true);

    const rustFn = parseAstPattern("fn * -> Result");
    expect(rustFn!.fallbackRegex!.test("fn get_user -> Result")).toBe(true);

    const pyClass = parseAstPattern("class *");
    expect(pyClass!.fallbackRegex!.test("class Child(Base):")).toBe(true);
  });

  it("buildPatternFallbackRegex tokenizes parens and braces", () => {
    expect(tokenizeAstPattern("fn(*) -> Result")).toEqual(["fn", "*", "->", "Result"]);
    const re = buildPatternFallbackRegex(["fn", "*", "->", "Result"]);
    expect(re.test("fn get_user -> Result")).toBe(true);
  });

  it("returns null for malformed patterns", () => {
    expect(parseAstPattern("hello world")).toBeNull();
    expect(parseAstPattern("")).toBeNull();
    expect(parseAstPattern("   ")).toBeNull();
  });

});
