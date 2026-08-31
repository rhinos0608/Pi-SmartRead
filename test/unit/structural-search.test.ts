import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  structuralSearch,
  StructuralSearchError,
  resolveStructuralLang,
  inferLanguageId,
  isStructuralSearchAvailable,
  _resetAstGrepCacheForTests,
  _setUnavailableForTests,
  SUPPORTED_STRUCTURAL_LANGUAGES,
} from "../../src/structural-search.js";

describe("structural-search engine (WP-SR2)", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sr-test-")));
    _resetAstGrepCacheForTests();
  });
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    _resetAstGrepCacheForTests();
  });

  it("duplicates SmartEdit LANG_MAP (case-insensitive, covers ~20 langs)", () => {
    expect(resolveStructuralLang("typescript")).toBe("TypeScript");
    expect(resolveStructuralLang("TypeScript")).toBe("TypeScript");
    expect(resolveStructuralLang("TYPESCRIPT")).toBe("TypeScript");
    expect(resolveStructuralLang("python")).toBe("Python");
    expect(resolveStructuralLang("tsx")).toBe("TSX");
    expect(resolveStructuralLang("bash")).toBe("Bash");
    expect(resolveStructuralLang("shell")).toBe("Bash");
    expect(resolveStructuralLang("csharp")).toBe("CSharp");
    expect(resolveStructuralLang("unknown_lang_xyz")).toBeNull();
    expect(SUPPORTED_STRUCTURAL_LANGUAGES).toContain("typescript");
    expect(SUPPORTED_STRUCTURAL_LANGUAGES).toContain("rust");
  });

  it("inferLanguageId maps extensions to SmartEdit ids", () => {
    expect(inferLanguageId("a.ts")).toBe("typescript");
    expect(inferLanguageId("a.TS")).toBe("typescript");
    expect(inferLanguageId("a.tsx")).toBe("tsx");
    expect(inferLanguageId("a.js")).toBe("javascript");
    expect(inferLanguageId("a.py")).toBe("python");
    expect(inferLanguageId("a.go")).toBe("go");
    expect(inferLanguageId("a.rs")).toBe("rust");
    expect(inferLanguageId("a.sh")).toBe("bash");
    expect(inferLanguageId("a.yaml")).toBe("yaml");
    expect(inferLanguageId("noext")).toBeNull();
    expect(inferLanguageId("a.unknownxyz")).toBeNull();
  });

  it("returns ok with matches for a structural pattern", async () => {
    writeFileSync(join(dir, "a.ts"), "console.log(x)\nconsole.log(y)\nconst z = 1\n", "utf8");
    writeFileSync(join(dir, "b.ts"), "console.log(z)\n", "utf8");
    const avail = await isStructuralSearchAvailable();
    if (!avail) {
      const res = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir });
      expect(res.status).toBe("unavailable");
      return;
    }
    const res = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir });
    expect(res.status).toBe("ok");
    expect(res.totalMatches).toBe(3);
    expect(res.matches.length).toBe(3);
    // paginated stably by path/start-location
    expect(res.matches[0]!.path.endsWith("a.ts")).toBe(true);
    expect(res.matches[0]!.line).toBe(1);
    expect(res.matches[1]!.line).toBe(2);
    expect(res.matches[2]!.path.endsWith("b.ts")).toBe(true);
    for (const m of res.matches) {
      expect(typeof m.text).toBe("string");
      expect(m.text).toContain("console.log");
      expect(typeof m.line).toBe("number");
      expect(typeof m.character).toBe("number");
      expect(typeof m.endLine).toBe("number");
      expect(typeof m.endCharacter).toBe("number");
    }
  });

  it("paginates stably via skip/limit", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    writeFileSync(join(dir, "a.ts"), "console.log(a)\nconsole.log(b)\nconsole.log(c)\nconsole.log(d)\n", "utf8");
    const all = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, limit: 10 });
    expect(all.totalMatches).toBe(4);
    const page1 = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, limit: 2, skip: 0 });
    const page2 = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, limit: 2, skip: 2 });
    expect(page1.matches.length).toBe(2);
    expect(page2.matches.length).toBe(2);
    // stable ordering: page1 + page2 == all sorted
    expect(page1.matches[0]!.line).toBe(1);
    expect(page1.matches[1]!.line).toBe(2);
    expect(page2.matches[0]!.line).toBe(3);
    expect(page2.matches[1]!.line).toBe(4);
    expect(page1.truncated).toBe(true);
    expect(page2.truncated).toBe(false);
  });

  it("groupByFile groups matches", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    writeFileSync(join(dir, "a.ts"), "console.log(a)\n", "utf8");
    writeFileSync(join(dir, "b.ts"), "console.log(b)\n", "utf8");
    const res = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, groupByFile: true });
    expect(res.status).toBe("ok");
    expect(res.groupedByFile).toBeDefined();
    expect(Object.keys(res.groupedByFile!).length).toBe(2);
    for (const arr of Object.values(res.groupedByFile!)) {
      expect(arr.length).toBeGreaterThan(0);
    }
  });

  it("throws for empty/invalid pattern (never silent zero)", async () => {
    await expect(structuralSearch({ pattern: "", cwd: dir })).rejects.toThrow(StructuralSearchError);
    await expect(structuralSearch({ pattern: "   ", cwd: dir })).rejects.toThrow(StructuralSearchError);
    try {
      await structuralSearch({ pattern: "", cwd: dir });
    } catch (e) {
      expect((e as StructuralSearchError).code).toBe("invalid_pattern");
    }
  });

  it("throws for unsupported explicit language", async () => {
    await expect(structuralSearch({ pattern: "console.log($A)", cwd: dir, language: "cobol" })).rejects.toThrow(StructuralSearchError);
    try {
      await structuralSearch({ pattern: "console.log($A)", cwd: dir, language: "cobol" });
    } catch (e) {
      expect((e as StructuralSearchError).code).toBe("unsupported_language");
    }
  });

  it("returns unavailable when @ast-grep/napi not installed (never silent zero)", async () => {
    _setUnavailableForTests("mocked missing @ast-grep/napi for test");
    const res = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir });
    expect(res.status).toBe("unavailable");
    expect(res.reason).toContain("mocked");
    expect(res.matches.length).toBe(0);
    // must not look like a normal empty result
    expect(res.status).not.toBe("ok");
  });

  it("invalid pattern syntax throws when module available (if module probes empty -> we still cover)", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    await expect(structuralSearch({ pattern: "", cwd: dir })).rejects.toThrow(/pattern/i);
  });

  it("malformed non-empty pattern throws invalid_pattern when module available", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    // ast-grep pattern parse error: standalone $$$ is invalid syntax, must not return silent zero
    const bad = "$$$";
    await expect(structuralSearch({ pattern: bad, cwd: dir })).rejects.toThrow(StructuralSearchError);
    try {
      await structuralSearch({ pattern: bad, cwd: dir });
    } catch (e) {
      expect((e as StructuralSearchError).code).toBe("invalid_pattern");
    }
  });

  it("explicit language retains exact file with custom/unknown extension", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    // exact file target with custom extension, explicit language must override inference
    const customFile = join(dir, "fixture.custom");
    writeFileSync(customFile, "console.log(1)\n", "utf8");
    const res = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, path: "fixture.custom", language: "typescript" });
    expect(res.status).toBe("ok");
    expect(res.totalMatches).toBe(1);
    expect(res.matches[0]!.path).toBe(realpathSync(customFile));
  });

  it("extensionless exact file with explicit language is retained", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    const noExtFile = join(dir, "noext");
    writeFileSync(noExtFile, "console.log(2)\n", "utf8");
    const res = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, path: "noext", language: "typescript" });
    expect(res.status).toBe("ok");
    expect(res.totalMatches).toBe(1);
  });

  it("uninferable exact file without explicit language throws unsupported_language", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    const customFile = join(dir, "weird.custom");
    writeFileSync(customFile, "console.log(1)\n", "utf8");
    await expect(structuralSearch({ pattern: "console.log($ARG)", cwd: dir, path: "weird.custom" })).rejects.toThrow(StructuralSearchError);
    try {
      await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, path: "weird.custom" });
    } catch (e) {
      expect((e as StructuralSearchError).code).toBe("unsupported_language");
    }
  });

  it("explicit language restricts search to that language (or parses with it)", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    writeFileSync(join(dir, "a.ts"), "console.log(1)\n", "utf8");
    writeFileSync(join(dir, "a.py"), "print(1)\n", "utf8");
    const tsRes = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, language: "typescript" });
    expect(tsRes.status).toBe("ok");
    // Only TS file should match console.log
    expect(tsRes.totalMatches).toBe(1);
    expect(tsRes.matches[0]!.path.endsWith(".ts")).toBe(true);
  });

  it("path param scopes search to file or dir", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.ts"), "console.log(1)\n", "utf8");
    writeFileSync(join(dir, "sub", "b.ts"), "console.log(2)\n", "utf8");
    const subOnly = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir, path: "sub" });
    expect(subOnly.totalMatches).toBe(1);
    expect(subOnly.matches[0]!.path).toContain("sub");
  });

  it("no matches returns ok with zero, not unavailable", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) return;
    writeFileSync(join(dir, "a.ts"), "const x = 1\n", "utf8");
    const res = await structuralSearch({ pattern: "console.log($ARG)", cwd: dir });
    expect(res.status).toBe("ok");
    expect(res.totalMatches).toBe(0);
    expect(res.matches.length).toBe(0);
    expect(res.truncated).toBe(false);
  });

  it("implicit language uses file's real language — CSS pattern not rejected via TS-first probe", async () => {
    const avail = await isStructuralSearchAvailable();
    if (!avail) {
      // parser unavailable: assert unavailable-status shape instead of silent pass
      const unavailable = await structuralSearch({ pattern: "div { color: $VAL }", cwd: dir });
      expect(unavailable.status).toBe("unavailable");
      expect(unavailable.matches.length).toBe(0);
      return;
    }
    // Pattern valid in CSS but invalid in TypeScript (TS probe would throw "Multiple AST nodes").
    // Before fix: implicit search validated against TypeScript first, so this threw invalid_pattern.
    // After fix: validation uses language inferred from candidate file (.css -> Css).
    writeFileSync(join(dir, "style.css"), "div { color: red }\n", "utf8");
    const res = await structuralSearch({ pattern: "div { color: $VAL }", cwd: dir });
    expect(res.status).toBe("ok");
    expect(res.totalMatches).toBe(1);
    expect(res.matches[0]!.path.endsWith("style.css")).toBe(true);
    // also prove mixed candidate set (css + ts) does not reject css-valid pattern
    writeFileSync(join(dir, "a.ts"), "const x = 1\n", "utf8");
    const mixed = await structuralSearch({ pattern: "div { color: $VAL }", cwd: dir });
    expect(mixed.status).toBe("ok");
    expect(mixed.totalMatches).toBe(1);
  });
});
