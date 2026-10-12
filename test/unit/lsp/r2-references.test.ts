import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LspCursorStore } from "../../../src/lsp/lsp-cursor-store.js";
import type { NormalizedDocumentSymbol } from "../../../src/lsp/lsp-response-normalizer.js";
import {
  classifyReferenceRole,
  findR2Enclosing,
  shapeR2References,
  r2ReferencesCursorIdentity,
  type R2ShapingDeps,
} from "../../../src/lsp/lsp-r2-shaping.js";

function sym(
  name: string,
  kind: number,
  selStart: { line: number; character: number },
  selEnd: { line: number; character: number },
  rangeEnd = selEnd,
): NormalizedDocumentSymbol {
  return {
    name,
    kind,
    range: { start: { line: 0, character: 0 }, end: rangeEnd },
    selectionRange: { start: selStart, end: selEnd },
  };
}

describe("classifyReferenceRole", () => {
  it("classifies multi-line import bindings as import", () => {
    const lines = [`import {`, `  foo,`, `  bar,`, `} from "./mod";`];
    expect(classifyReferenceRole(lines, 1, 3, [])).toBe("import");
    expect(classifyReferenceRole(lines, 2, 3, [])).toBe("import");
  });

  it("classifies import type bindings as import", () => {
    const lines = [`import type { Foo } from "./types";`];
    expect(classifyReferenceRole(lines, 0, 14, [])).toBe("import");
  });

  it("classifies export specifiers and re-exports as export", () => {
    const lines = [`export { x } from "./mod";`];
    expect(classifyReferenceRole(lines, 0, 9, [])).toBe("export");
  });

  it("classifies a default-exported identifier as export", () => {
    const lines = [`export default foo;`];
    expect(classifyReferenceRole(lines, 0, 16, [])).toBe("export");
  });

  it("classifies the declared name in export default function as declaration", () => {
    const lines = [`export default function bar() {}`];
    const symbols = [sym("bar", 12, { line: 0, character: 24 }, { line: 0, character: 27 })];
    expect(classifyReferenceRole(lines, 0, 25, symbols)).toBe("declaration");
    // Lexical fallback agrees when documentSymbols are unavailable.
    expect(classifyReferenceRole(lines, 0, 25, null)).toBe("declaration");
  });

  it("classifies the declared name in export function as declaration, not export", () => {
    const lines = [`export function foo() { return 1; }`];
    const symbols = [sym("foo", 12, { line: 0, character: 16 }, { line: 0, character: 19 })];
    expect(classifyReferenceRole(lines, 0, 17, symbols)).toBe("declaration");
  });

  it("distinguishes use on the same line as an import of something else", () => {
    const lines = [`import { a } from "./m"; use(a);`];
    expect(classifyReferenceRole(lines, 0, 9, [])).toBe("import");
    expect(classifyReferenceRole(lines, 0, 29, [])).toBe("use");
  });

  it("classifies a declaration matching a selectionRange as declaration", () => {
    const lines = [`function foo() { return 1; }`];
    const symbols = [sym("foo", 12, { line: 0, character: 9 }, { line: 0, character: 12 })];
    expect(classifyReferenceRole(lines, 0, 10, symbols)).toBe("declaration");
  });

  it("fails open to use for plain calls and unknown shapes", () => {
    expect(classifyReferenceRole([`foo();`], 0, 1, [])).toBe("use");
    expect(classifyReferenceRole([`const y = foo + 1;`], 0, 11, null)).toBe("use");
  });

  it("does not treat dynamic import() as an import binding", () => {
    const lines = [`const m = await import("./m");`];
    expect(classifyReferenceRole(lines, 0, 20, [])).toBe("use");
  });

  it("treats uses inside an exported arrow body or object literal as use, not export", () => {
    const app = [`export const App = () => <div>{foo}</div>;`];
    expect(classifyReferenceRole(app, 0, 32, [])).toBe("use");
    const config = [`export const config = { handler: foo };`];
    expect(classifyReferenceRole(config, 0, 35, [])).toBe("use");
  });

  it("treats the declared name of an exported const as declaration", () => {
    const lines = [`export const App = () => <div>{foo}</div>;`];
    const symbols = [sym("App", 13, { line: 0, character: 13 }, { line: 0, character: 16 })];
    expect(classifyReferenceRole(lines, 0, 14, symbols)).toBe("declaration");
    expect(classifyReferenceRole(lines, 0, 14, null)).toBe("declaration");
  });

  it("classifies export specifier lists, default identifiers, export-equals, and namespace re-exports", () => {
    expect(classifyReferenceRole([`export { x } from "./mod";`], 0, 9, [])).toBe("export");
    expect(classifyReferenceRole([`export type { T } from "./mod";`], 0, 14, [])).toBe("export");
    expect(classifyReferenceRole([`export default foo;`], 0, 16, [])).toBe("export");
    expect(classifyReferenceRole([`export = foo;`], 0, 9, [])).toBe("export");
    expect(classifyReferenceRole([`export * as ns from "./mod";`], 0, 12, [])).toBe("export");
  });

  it("sees through blank lines and comments between import specifiers", () => {
    const lines = [`import {`, `  // leading comment`, ``, `  foo,`, `  /* trailing */`, `} from "./m";`];
    expect(classifyReferenceRole(lines, 3, 3, [])).toBe("import");
  });

  it("treats braces and semicolons inside strings as statement text (naive scan, fails open)", () => {
    // The `;` inside the string splits the naive segment, but the head of
    // the use segment is still not an import/export keyword, so both refs
    // below land on use/import respectively by head keyword, not by strings.
    expect(classifyReferenceRole([`const s = "{ ; }"; use(foo);`], 0, 25, [])).toBe("use");
    expect(classifyReferenceRole(["const t = `a}b`; foo(x);"], 0, 21, [])).toBe("use");
    expect(classifyReferenceRole([`import { a } from "m{x}"; use(a);`], 0, 9, [])).toBe("import");
    expect(classifyReferenceRole([`import { a } from "m{x}"; use(a);`], 0, 30, [])).toBe("use");
  });

  it("treats import-require as an import binding", () => {
    expect(classifyReferenceRole([`import x = require("m");`], 0, 7, [])).toBe("import");
  });

  it("never throws and always returns a valid role over hostile random lines", () => {
    const roles = new Set(["import", "export", "declaration", "use"]);
    let state = 0x12345678;
    const next = (): number => {
      state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 7), state | 61);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 1);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pieces = ["import", "export", "{", "}", ";", "foo", `"str;{"`, "`tpl}`", "// c", "/*", "*/", "(", ")", "import(", "require", "default", "type", "*", "as", "=", " ", "const", ".", ",", "🚀"];
    for (let i = 0; i < 500; i += 1) {
      const count = 1 + Math.floor(next() * 4);
      const lines: string[] = [];
      for (let l = 0; l < count; l += 1) {
        let text = "";
        const parts = 1 + Math.floor(next() * 8);
        for (let p = 0; p < parts; p += 1) text += pieces[Math.floor(next() * pieces.length)]!;
        lines.push(text);
      }
      const line = Math.floor(next() * (lines.length + 1)) - 1;
      const character = Math.floor(next() * 60) - 5;
      let role: string;
      try {
        role = classifyReferenceRole(lines, line, character, null);
      } catch {
        throw new Error(`classifier threw on ${JSON.stringify({ lines, line, character })}`);
      }
      expect(roles.has(role)).toBe(true);
    }
  });
});

describe("findR2Enclosing", () => {
  it("returns the innermost function/method/class/variable holder", () => {
    const symbols: NormalizedDocumentSymbol[] = [
      {
        name: "C",
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
        selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        children: [
          {
            name: "run",
            kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 5, character: 3 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
          },
        ],
      },
    ];
    expect(findR2Enclosing(symbols, { line: 3, character: 4 })).toEqual({ name: "run", kind: 6 });
    expect(findR2Enclosing(symbols, { line: 8, character: 0 })).toEqual({ name: "C", kind: 5 });
    expect(findR2Enclosing(symbols, { line: 20, character: 0 })).toBeNull();
  });

  it("ignores non-holder kinds", () => {
    const symbols = [sym("NS", 3, { line: 0, character: 0 }, { line: 0, character: 2 })];
    expect(findR2Enclosing(symbols, { line: 0, character: 1 })).toBeNull();
  });

  it("accepts Constant (14) and Struct (23) holders", () => {
    const symbols = [
      sym("LIMIT", 14, { line: 0, character: 6 }, { line: 0, character: 11 }),
      sym("Point", 23, { line: 1, character: 7 }, { line: 1, character: 12 }),
    ];
    expect(findR2Enclosing(symbols, { line: 0, character: 8 })).toEqual({ name: "LIMIT", kind: 14 });
    expect(findR2Enclosing(symbols, { line: 1, character: 9 })).toEqual({ name: "Point", kind: 23 });
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r2-shape-")));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return root;
}

function loc(abs: string, line: number, character: number) {
  return {
    uri: pathToFileURL(abs).href,
    range: { start: { line, character }, end: { line, character: character + 1 } },
  };
}

function testDeps(root: string, symbolsByBase: Record<string, NormalizedDocumentSymbol[]> = {}): R2ShapingDeps & { fetched: string[][] } {
  const fetched: string[][] = [];
  return {
    root,
    readLines: (abs: string) => {
      try {
        return readFileSync(abs, "utf8").split("\n");
      } catch {
        return null;
      }
    },
    fetchSymbols: async (paths: string[]) => {
      fetched.push(paths);
      const map = new Map<string, NormalizedDocumentSymbol[] | null>();
      for (const p of paths) {
        map.set(p, symbolsByBase[basename(p)] ?? []);
      }
      return map;
    },
    cursors: new LspCursorStore(),
    fetched,
  };
}

describe("shapeR2References", () => {
  it("groups by file, orders refs, and enriches role/enclosing/text", async () => {
    const root = makeRoot({
      "b.ts": `import { foo } from "./a";\nfoo();\n`,
      "a.ts": `export function foo() { return 1; }\n`,
    });
    const deps = testDeps(root, {
      "a.ts": [sym("foo", 12, { line: 0, character: 16 }, { line: 0, character: 19 })],
    });
    const out = await shapeR2References({
      locations: [loc(join(root, "b.ts"), 1, 0), loc(join(root, "b.ts"), 0, 9), loc(join(root, "a.ts"), 0, 17)],
      deps,
    });
    expect(out.total).toBe(3);
    expect(out.returned).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.nextCursor).toBeUndefined();
    expect(out.enclosingIncomplete).toBeUndefined();
    expect(out.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    const aRefs = out.files[0]!.refs;
    expect(aRefs[0]).toMatchObject({ line: 0, character: 17, role: "declaration", enclosing: { name: "foo", kind: 12 } });
    expect(aRefs[0]!.text).toBe("export function foo() { return 1; }");
    const bRefs = out.files[1]!.refs;
    expect(bRefs.map((r) => [r.line, r.character, r.role])).toEqual([[0, 9, "import"], [1, 0, "use"]]);
    expect(bRefs[0]!.enclosing).toBeNull();
  });

  it("caps text at 200 chars and trims", async () => {
    const root = makeRoot({ "a.ts": `   ${"x".repeat(300)}\n` });
    const deps = testDeps(root);
    const out = await shapeR2References({ locations: [loc(join(root, "a.ts"), 0, 5)], deps });
    expect(out.files[0]!.refs[0]!.text).toBe("x".repeat(200));
  });

  it("pages at 100 refs by default and continues with the existing cursor store", async () => {
    const root = makeRoot({ "a.ts": Array.from({ length: 130 }, (_, i) => `use${i}();`).join("\n") + "\n" });
    const deps = testDeps(root);
    const locations = Array.from({ length: 105 }, (_, i) => loc(join(root, "a.ts"), i, 0));
    const first = await shapeR2References({ locations, deps });
    expect(first.total).toBe(105);
    expect(first.returned).toBe(100);
    expect(first.truncated).toBe(true);
    expect(typeof first.nextCursor).toBe("string");
    const second = await shapeR2References({ locations, cursor: first.nextCursor, deps });
    expect(second.returned).toBe(5);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeUndefined();
    expect(second.files[0]!.refs[0]).toMatchObject({ line: 100, character: 0 });
  });

  it("honors an explicit limit", async () => {
    const root = makeRoot({ "a.ts": `a();\nb();\nc();\n` });
    const deps = testDeps(root);
    const out = await shapeR2References({
      locations: [loc(join(root, "a.ts"), 0, 0), loc(join(root, "a.ts"), 1, 0), loc(join(root, "a.ts"), 2, 0)],
      limit: 2,
      deps,
    });
    expect(out.returned).toBe(2);
    expect(out.truncated).toBe(true);
    expect(typeof out.nextCursor).toBe("string");
  });

  it("filters by scope before pagination and reports the echo and count", async () => {
    const root = makeRoot({ "sub/a.ts": `a();\n`, "top.ts": `b();\n` });
    // Nested file must exist for canonical scope validation in callers; the
    // helper takes an already-resolved scope here.
    const { realpathSync: rp } = await import("node:fs");
    const scopeAbs = rp(join(root, "sub"));
    const deps = testDeps(root);
    const out = await shapeR2References({
      locations: [loc(join(root, "top.ts"), 0, 0), loc(join(root, "sub/a.ts"), 0, 0)],
      scopeAbs,
      scopeIsFile: false,
      scopeEcho: "sub",
      deps,
    });
    expect(out.scope).toBe("sub");
    expect(out.filteredOutByScope).toBe(1);
    expect(out.total).toBe(2);
    expect(out.returned).toBe(1);
    expect(out.files.map((f) => f.path)).toEqual(["sub/a.ts"]);
  });

  it("marks enclosingIncomplete when symbols are unavailable", async () => {
    const root = makeRoot({ "a.ts": `foo();\n` });
    const deps = testDeps(root);
    deps.fetchSymbols = async (paths: string[]) => new Map(paths.map((p) => [p, null] as const));
    const out = await shapeR2References({ locations: [loc(join(root, "a.ts"), 0, 0)], deps });
    expect(out.files[0]!.refs[0]!.enclosing).toBeNull();
    expect(out.enclosingIncomplete).toBe(true);
  });

  it("fetches symbols for at most 25 files per page", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 26; i += 1) files[`f${String(i).padStart(2, "0")}.ts`] = `v${i}();\n`;
    const root = makeRoot(files);
    const deps = testDeps(root);
    const locations = Object.keys(files).map((rel) => loc(join(root, rel), 0, 0));
    const out = await shapeR2References({ locations, deps });
    expect(deps.fetched).toHaveLength(1);
    expect(deps.fetched[0]).toHaveLength(25);
    expect(out.returned).toBe(26);
    expect(out.enclosingIncomplete).toBe(true);
  });

  it("shrinks the page under the byte bound with a cursor instead of truncating mid-object", async () => {
    const root = makeRoot({ "a.ts": `a();\nb();\nc();\nd();\n` });
    const deps = testDeps(root);
    const out = await shapeR2References({
      locations: [0, 1, 2, 3].map((line) => loc(join(root, "a.ts"), line, 0)),
      outputBytes: 300,
      deps,
    });
    expect(out.returned).toBeGreaterThan(0);
    expect(out.returned).toBeLessThan(4);
    expect(out.truncated).toBe(true);
    expect(typeof out.nextCursor).toBe("string");
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(300);
    // Every returned ref is a complete object.
    for (const group of out.files) {
      for (const ref of group.refs) {
        expect(ref).toHaveProperty("line");
        expect(ref).toHaveProperty("character");
        expect(ref).toHaveProperty("role");
        expect(ref).toHaveProperty("enclosing");
        expect(ref).toHaveProperty("text");
      }
    }
  });

  it("rejects an unknown cursor like the existing paginate helper", async () => {
    const root = makeRoot({ "a.ts": `a();\n` });
    const deps = testDeps(root);
    await expect(shapeR2References({
      locations: [loc(join(root, "a.ts"), 0, 0)],
      cursor: "bogus",
      deps,
    })).rejects.toThrow("invalid cursor");
  });

  it("binds page cursors to the query identity", async () => {
    const root = makeRoot({ "a.ts": `a();\nb();\nc();\n` });
    const deps = testDeps(root);
    const locations = [0, 1, 2].map((line) => loc(join(root, "a.ts"), line, 0));
    const identity = r2ReferencesCursorIdentity(join(root, "a.ts"), { line: 0, character: 0 }, null);
    const first = await shapeR2References({ locations, limit: 2, cursorIdentity: identity, deps });
    expect(first.truncated).toBe(true);
    expect(typeof first.nextCursor).toBe("string");
    const same = await shapeR2References({ locations, cursor: first.nextCursor, cursorIdentity: identity, deps });
    expect(same.returned).toBe(1);
    await expect(shapeR2References({
      locations, cursor: first.nextCursor,
      cursorIdentity: r2ReferencesCursorIdentity(join(root, "a.ts"), { line: 0, character: 0 }, join(root, "sub")),
      deps,
    })).rejects.toThrow("invalid cursor");
    await expect(shapeR2References({ locations, cursor: first.nextCursor, deps }))
      .rejects.toThrow("invalid cursor");
  });

  it("builds identical cursor identities across path spellings", () => {
    const root = makeRoot({ "a.ts": `a();\n` });
    expect(r2ReferencesCursorIdentity(join(root, "sub", "..", "a.ts"), { line: 1, character: 2 }, null))
      .toBe(r2ReferencesCursorIdentity(join(root, "a.ts"), { line: 1, character: 2 }, null));
    expect(r2ReferencesCursorIdentity(join(root, "a.ts"), { line: 1, character: 2 }, null))
      .not.toBe(r2ReferencesCursorIdentity(join(root, "a.ts"), { line: 1, character: 3 }, null));
  });

  it("classifies an import after an emoji prefix under UTF-8 byte offsets", async () => {
    const line = `const msg = "🚀…"; import { foo } from "./m";`;
    const root = makeRoot({ "m.ts": `${line}\n` });
    const deps = testDeps(root);
    // foo starts at UTF-8 byte 31 (🚀 is 4 bytes, … is 3); in UTF-16 units it is index 27.
    const out = await shapeR2References({
      locations: [loc(join(root, "m.ts"), 0, 31)],
      encoding: "utf-8",
      deps,
    });
    expect(out.files[0]!.refs[0]).toMatchObject({ character: 31, role: "import" });
  });

  it("finds a lexical declaration across a multi-byte shift under UTF-8", async () => {
    const line = `// 🚀🚀🚀 const foo = 1;`;
    const root = makeRoot({ "a.ts": `${line}\n` });
    const deps = testDeps(root);
    // foo starts at UTF-8 byte 22 but UTF-16 index 16; raw indexing lands on `1`.
    const out = await shapeR2References({
      locations: [loc(join(root, "a.ts"), 0, 22)],
      encoding: "utf-8",
      deps,
    });
    expect(out.files[0]!.refs[0]).toMatchObject({ character: 22, role: "declaration" });
  });

  it("matches declarations and specifiers under UTF-32 code-point offsets", async () => {
    const decl = `// 🚀🚀🚀🚀🚀 const foo = 1;`;
    const root = makeRoot({ "a.ts": `${decl}\n` });
    const deps = testDeps(root);
    // foo starts at code point 15 but UTF-16 index 20.
    const lex = await shapeR2References({
      locations: [loc(join(root, "a.ts"), 0, 15)],
      encoding: "utf-32",
      deps,
    });
    expect(lex.files[0]!.refs[0]).toMatchObject({ character: 15, role: "declaration" });
    const withSymbols = testDeps(root);
    withSymbols.fetchSymbols = async (paths: string[]) => new Map(paths.map((p) => [p, [
      sym("foo", 12, { line: 0, character: 15 }, { line: 0, character: 18 }, { line: 0, character: 30 }),
    ]] as const));
    const symOut = await shapeR2References({
      locations: [loc(join(root, "a.ts"), 0, 15)],
      encoding: "utf-32",
      deps: withSymbols,
    });
    expect(symOut.files[0]!.refs[0]).toMatchObject({
      character: 15,
      role: "declaration",
      enclosing: { name: "foo", kind: 12 },
    });
  });

  it("classifies an export specifier after emoji under UTF-32", async () => {
    const line = `const e = "🚀🚀🚀🚀🚀"; export { x } from "m";`;
    const root = makeRoot({ "m.ts": `${line}\n` });
    const deps = testDeps(root);
    // x is code point 27 but UTF-16 index 32, inside the specifier braces.
    const out = await shapeR2References({
      locations: [loc(join(root, "m.ts"), 0, 27)],
      encoding: "utf-32",
      deps,
    });
    expect(out.files[0]!.refs[0]).toMatchObject({ character: 27, role: "export" });
  });
});
