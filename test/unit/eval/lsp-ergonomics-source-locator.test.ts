import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locateSourceIdentifier, type SourceLocatorOptions } from "../../../scripts/eval/lsp-ergonomics/source-locator.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "source-locator-")); roots.push(root);
  for (const [name, text] of Object.entries(files)) { const path = join(root, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); }
  return realpathSync(root);
}
const run = (path: string, line: number, identifier: string, occurrence?: number, options?: SourceLocatorOptions) =>
  locateSourceIdentifier({ path, line, identifier, ...(occurrence === undefined ? {} : { occurrence }) }, options);

describe("locateSourceIdentifier", () => {
  it("uses one-based input lines and returns validated zero-based UTF-16 coordinates, offsets, and fingerprint", async () => {
    const source = "const emoji = '😀';\r\nconst target = emoji;\r\n";
    const root = fixture({ "a.ts": source });
    const result = await run(join(root, "a.ts"), 2, "target");
    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    const start = source.indexOf("target");
    expect(result.sourcePositionUtf16).toEqual({ line: 1, character: source.split("\r\n")[1]!.indexOf("target") });
    expect(result.tokenSpan).toEqual({ start, end: start + "target".length });
    expect(result.canonicalPath).toBe(join(root, "a.ts"));
    expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("preserves a UTF-8 BOM in source offsets and fingerprint input", async () => {
    const source = "\uFEFFconst target = 1;\n";
    expect(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.from(source))).toBe(source);
    const root = fixture({ "bom.ts": source });
    const result = await run(join(root, "bom.ts"), 1, "target");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.sourcePositionUtf16.character).toBe(source.indexOf("target"));
      expect(result.tokenSpan).toEqual({ start: source.indexOf("target"), end: source.indexOf("target") + 6 });
      expect(result.sourceSha256).toBe(createHash("sha256").update(Buffer.from(source)).digest("hex"));
    }
  });
  it("maps bare-CR physical lines without mixing parser row conventions", async () => {
    const source = "const first = 1;\rconst target = 2;\r";
    const root = fixture({ "bare-cr.ts": source });
    const result = await run(join(root, "bare-cr.ts"), 2, "target");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.sourcePositionUtf16).toEqual({ line: 1, character: 6 });
      expect(result.tokenSpan).toEqual({ start: source.indexOf("target"), end: source.indexOf("target") + 6 });
    }
  });
  it("counts same-line emoji, accented, and CJK text in UTF-16 units", async () => {
    const source = "const emoji = '😀'; const accent = 'é'; const cjk = '漢'; const target = 1;\n";
    const root = fixture({ "unicode.ts": source });
    const result = await run(join(root, "unicode.ts"), 1, "target");
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.sourcePositionUtf16.character).toBe(source.indexOf("target"));
      expect(result.tokenSpan).toEqual({ start: source.indexOf("target"), end: source.indexOf("target") + 6 });
    }
  });
  it("excludes comments and strings, but finds template interpolation", async () => {
    const root = fixture({ "a.ts": "const x = `target ${target}`; // target\nconst s = 'target';\n" });
    const result = await run(join(root, "a.ts"), 1, "target");
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.sourcePositionUtf16.character).toBe(20);
    expect((await run(join(root, "a.ts"), 2, "target")).status).toBe("notfound");
  });
  it.each([["ts", "const { target } = source;\n"], ["js", "const { target } = source;\n"]])("locates shorthand destructuring names in .%s ASTs", async (ext, source) => {
    const root = fixture({ [`destructure.${ext}`]: source });
    const result = await run(join(root, `destructure.${ext}`), 1, "target");
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.sourcePositionUtf16.character).toBe(source.indexOf("target"));
  });
  it("locates Rust shorthand field initializer occurrence after parameter", async () => {
    const source = "struct S { target: i32 }\nfn f(target: i32) { let _ = S { target }; }\n";
    const root = fixture({ "shorthand.rs": source });
    const result = await run(join(root, "shorthand.rs"), 2, "target", 2);
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.sourcePositionUtf16.character).toBe(source.split("\n")[1]!.lastIndexOf("target"));
  });
  it("requires occurrence to disambiguate exact same-line duplicates and never falls back", async () => {
    const root = fixture({ "a.py": "thing = thing\n" }); const path = join(root, "a.py");
    expect((await run(path, 1, "thing")).status).toBe("ambiguous");
    expect((await run(path, 1, "thing", 2)).status).toBe("found");
    expect((await run(path, 1, "thing", 3)).status).toBe("notfound");
    expect((await run(path, 2, "thing")).status).toBe("notfound");
    expect((await run(path, 1, "Thing")).status).toBe("notfound");
  });
});

describe("source locator parser and boundary behavior", () => {
  it.each([
    ["ts", "const target = target;\n", 1], ["tsx", "const target = <div>{target}</div>;\n", 1],
    ["js", "const target = target;\n", 1], ["jsx", "const target = <div>{target}</div>;\n", 1],
    ["mts", "const target = target;\n", 1], ["cts", "const target = target;\n", 1],
    ["mjs", "const target = target;\n", 1], ["cjs", "const target = target;\n", 1],
    ["py", "target = target\n", 1], ["rs", "fn main() { let target = target; }\n", 1],
    ["go", "package p\nfunc f() { target := target }\n", 2],
  ])("parses real native grammar for .%s", async (ext, text, line) => {
    const root = fixture({ [`a.${ext}`]: text });
    expect((await run(join(root, `a.${ext}`), line, "target", 2)).status).toBe("found");
  });
  it("canonicalizes symlinks and rejects foreign/malformed request fields", async ({ skip }) => {
    const root = fixture({ "a.js": "const x = 1;\n" }); const link = join(root, "link.js");
    try { symlinkSync(join(root, "a.js"), link); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "EOPNOTSUPP") skip();
      throw error;
    }
    const result = await run(link, 1, "x");
    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.canonicalPath).toBe(join(root, "a.js"));
  });
  it("rejects malformed requests independently of symlink support", async () => {
    const root = fixture({ "a.js": "const x = 1;\n" });
    const path = join(root, "a.js");
    expect((await locateSourceIdentifier({ path, line: 1, identifier: "x", foreign: true } as never)).status).toBe("invalid");
    expect((await locateSourceIdentifier({ path, line: 0, identifier: "x" })).status).toBe("invalid");
  });
  it("reports unsupported extensions, missing grammar, non-files, and target-line syntax errors", async () => {
    const root = fixture({ "a.txt": "target\n", "bad.py": "def (target\n" });
    mkdirSync(join(root, "folder.py"));
    expect((await run(join(root, "a.txt"), 1, "target")).status).toBe("unsupported");
    expect((await run(join(root, "bad.py"), 1, "target")).status).toBe("incomplete");
    expect((await run(join(root, "folder.py"), 1, "target")).status).toBe("unsupported");
    expect((await run(join(root, "bad.py"), 2, "target", undefined, { languageLoader: () => undefined })).status).toBe("unsupported");
    expect((await run(join(root, "bad.py"), 2, "target", undefined, { languageLoader: () => ({}) })).status).toBe("unsupported");
    expect((await run(join(root, "bad.py"), 2, "target")).status).toBe("notfound");
  });
  it("honors file-size, AST traversal, match-display, and cancellation bounds", async () => {
    const path = join(fixture({ "a.py": "target = target\n" }), "a.py");
    expect((await run(path, 1, "target", undefined, { maxFileBytes: 1 })).status).toBe("incomplete");
    expect((await run(path, 1, "target", undefined, { maxNodes: 1 })).status).toBe("incomplete");
    const crowded = join(fixture({ "many.py": Array.from({ length: 12 }, () => "target").join(" + ") }), "many.py");
    const ambiguous = await run(crowded, 1, "target", undefined, { maxDisplayedMatches: 2 });
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") expect(ambiguous.displayedMatches).toHaveLength(2);
    expect((await run(crowded, 1, "target", undefined, { maxMatches: 3 })).status).toBe("incomplete");
    const controller = new AbortController(); controller.abort();
    expect((await run(path, 1, "target", undefined, { signal: controller.signal })).status).toBe("incomplete");
  });
});
