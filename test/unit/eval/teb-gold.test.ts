/**
 * TEB gold-derivation helper tests on a tiny temp TS project fixture.
 * Pure and fast: compiler API + import graph + normaliser only. The live
 * pinned-server path (server-labels deriveServerGold) is exercised in CI
 * by the labeler flow, not here (project-load wait is seconds per call).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
    classifySetAgreement,
    compilerCheck,
    directImporters,
    packageEntryFiles,
} from "../../../scripts/eval/teb/gold/compiler-check.js";
import { normalizeTypeString } from "../../../scripts/eval/teb/gold/normalize.js";
import {
    applyScope,
    hoverText,
    parseAnchor,
    rawToAbsLocs,
    toGold,
} from "../../../scripts/eval/teb/gold/server-labels.js";

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "teb-gold-"));
    writeFileSync(
        join(root, "a.ts"),
        `export function add(x: number, y: number): number {\n  return x + y;\n}\nexport interface Shape {\n  area(): number;\n}\nexport class Circle implements Shape {\n  area(): number {\n    return 1;\n  }\n}\n`,
    );
    writeFileSync(join(root, "b.ts"), `import { add } from "./a";\nexport const r = add(1, 2);\n`);
    writeFileSync(join(root, "c.ts"), `import { add } from "./a";\nexport const s = add(3, 4);\n`);
    mkdirSync(join(root, "pkg"), { recursive: true });
    writeFileSync(join(root, "pkg", "index.ts"), `export const x = 1;\n`);
    writeFileSync(join(root, "pkg", "main.ts"), `export const y = 2;\n`);
    writeFileSync(
        join(root, "pkg", "package.json"),
        JSON.stringify({ name: "pkg", exports: { ".": "./index.ts" }, main: "./main.ts" }),
    );
    return root;
}

/** Minimal temp project from a filename→contents map (for importer-graph tests). */
function mkPkg(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "teb-importers-"));
    for (const [name, contents] of Object.entries(files)) {
        const full = join(root, name);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents);
    }
    return root;
}

describe("parseAnchor", () => {
    it("parses 1-based path:line:col", () => {
        expect(parseAnchor("src/a.ts:12:34")).toEqual({ path: "src/a.ts", line: 12, character: 34 });
    });

    it("rejects bad anchors", () => {
        expect(() => parseAnchor("src/a.ts:12")).toThrow();
        expect(() => parseAnchor("src/a.ts:0:1")).toThrow();
        expect(() => parseAnchor("no-coords")).toThrow();
    });
});

describe("pinned type-string normaliser (§5)", () => {
    it("extracts the first ts fenced block and drops the alias qualifier", () => {
        const raw = "some prose\n```typescript\n(alias) function build(_options: Options): Promise<void>\n```";
        expect(normalizeTypeString(raw, { arrayRewrite: false, dropUndefined: false })).toBe(
            "function build(_options: Options): Promise<void>",
        );
    });

    it("collapses whitespace and applies the task flags", () => {
        const raw = "```ts\nconst xs:   Array<number>  |  undefined\n```";
        expect(normalizeTypeString(raw, { arrayRewrite: true, dropUndefined: true })).toBe(
            "const xs: number[]",
        );
        expect(normalizeTypeString(raw, { arrayRewrite: false, dropUndefined: false })).toBe(
            "const xs: Array<number> | undefined",
        );
    });

    it("falls back to the raw string without fences", () => {
        expect(normalizeTypeString("  (alias) class QueryClient  ", { arrayRewrite: false, dropUndefined: false })).toBe(
            "class QueryClient",
        );
    });
});

describe("hoverText + rawToAbsLocs + toGold + applyScope", () => {
    it("joins hover contents and maps raw LSP locations to 1-based gold", () => {
        const root = fixture();
        const uri = pathToFileURL(join(root, "a.ts")).href;
        expect(hoverText({ contents: [{ language: "typescript", value: "function add(): void" }] })).toBe(
            "function add(): void",
        );
        const abs = rawToAbsLocs([
            { targetUri: uri, targetSelectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } },
        ]);
        expect(abs).toHaveLength(1);
        const gold = toGold(abs, root);
        expect(gold).toEqual([{ path: "a.ts", line: 1, character: 17 }]);
        expect(applyScope(gold, "")).toHaveLength(1);
        expect(applyScope(gold, "other")).toHaveLength(0);
        expect(applyScope([{ path: "x.d.ts", line: 1, character: 1 }], "")).toHaveLength(0);
        expect(applyScope([{ path: "x.d.ts", line: 1, character: 1 }], "", { dtsTarget: true })).toHaveLength(1);
        expect(rawToAbsLocs(null)).toEqual([]);
        expect(rawToAbsLocs([{ uri: "https://example.com/x.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }])).toEqual([]);
    });
});

describe("compiler cross-check on the temp fixture", () => {
    it("resolves the definition through the import to a.ts", () => {
        const root = fixture();
        // b.ts line 1: `import { add } from "./a";` — `add` starts at 1-based col 10.
        const cc = compilerCheck(root, { path: "b.ts", line: 1, character: 10 });
        expect(cc.typescriptVersion).toMatch(/^\d+\.\d+/);
        expect(cc.resolvedFrom.length).toBeGreaterThan(0);
        expect(cc.definition).toContainEqual({ path: "a.ts", line: 1, character: 17 });
    });

    it("finds references across the importing files", () => {
        const root = fixture();
        const cc = compilerCheck(root, { path: "b.ts", line: 1, character: 10 });
        const files = cc.references.map((r) => r.path).sort();
        expect(files).toContain("a.ts");
        expect(files).toContain("b.ts");
        expect(files).toContain("c.ts");
    });

    it("resolves implementations for the interface symbol", () => {
        const root = fixture();
        // a.ts line 4: `export interface Shape {` — `Shape` at 1-based col 18.
        const cc = compilerCheck(root, { path: "a.ts", line: 4, character: 18 });
        const files = cc.implementations.map((r) => r.path);
        expect(files).toContain("a.ts");
    });
});

describe("classifySetAgreement", () => {
    const s = [{ path: "a.ts", line: 1, character: 17 }];
    it("classifies agree / server-only / compiler-only / adjudicated", () => {
        expect(classifySetAgreement(s, [{ path: "a.ts", line: 1, character: 18 }])).toBe("agree");
        expect(classifySetAgreement(s, [])).toBe("server-only");
        expect(classifySetAgreement([], s)).toBe("compiler-only");
        expect(classifySetAgreement(s, [{ path: "b.ts", line: 9, character: 1 }])).toBe("adjudicated");
        expect(classifySetAgreement([], [])).toBe("agree");
    });

    it("rejects a tiny overlap between large sets (Jaccard < 0.9 → adjudicated)", () => {
        const loc = (path: string, line: number): { path: string; line: number; character: number } => ({
            path,
            line,
            character: 1,
        });
        const server = Array.from({ length: 30 }, (_, i) => loc("a.ts", i + 1));
        const compiler = [loc("a.ts", 1), loc("b.ts", 1)];
        // One shared point out of 31 distinct: old any-intersection rule said
        // "agree"; Jaccard 1/31 must not agree and neither side is a superset.
        expect(classifySetAgreement(server, compiler)).toBe("adjudicated");
    });

    it("classifies strict-superset sides by inclusion", () => {
        const loc = (line: number): { path: string; line: number; character: number } => ({
            path: "a.ts",
            line,
            character: 1,
        });
        const small = [loc(1), loc(2)];
        const large = [loc(1), loc(2), loc(3)];
        expect(classifySetAgreement(large, small)).toBe("server-only");
        expect(classifySetAgreement(small, large)).toBe("compiler-only");
    });

    it("filters the compiler declaration to align with includeDeclaration:false", () => {
        const decl = [{ path: "a.ts", line: 1, character: 17 }];
        const ref = { path: "b.ts", line: 2, character: 15 };
        // Server excludes the declaration; the raw compiler set includes it.
        expect(classifySetAgreement([ref], [decl[0]!, ref])).toBe("compiler-only");
        expect(classifySetAgreement([ref], [decl[0]!, ref], { declaration: decl })).toBe("agree");
    });
});

describe("structural families from source", () => {
    it("enumerates direct importers depth-1", () => {
        const root = fixture();
        expect(directImporters(root, "a.ts")).toEqual(["b.ts", "c.ts"]);
        expect(directImporters(root, "b.ts")).toEqual([]);
    });

    it("reads package entry files from package.json exports/main", () => {
        const root = fixture();
        expect(packageEntryFiles(join(root, "pkg"))).toEqual(["index.ts", "main.ts"]);
    });

    it("resolves .js/.jsx/.mjs/.cjs specifiers to TS sources", () => {
        const dir = mkPkg({
            "a.ts": "export const a = 1;\n",
            "b.ts": "import { a } from './a.js';\nconsole.log(a);\n",
            "c.ts": "import { a } from './a.mjs';\nconsole.log(a);\n",
        });
        // Old code dropped ESM-style `./a.js` specifiers (returned [] here).
        expect(directImporters(dir, "a.ts")).toEqual(["b.ts", "c.ts"]);
    });

    it("counts dynamic import(), require(), and re-exports as importers", () => {
        const dir = mkPkg({
            "a.ts": "export const a = 1;\n",
            "dyn.ts": "const m = await import('./a');\nconsole.log(m);\n",
            "req.ts": "const m = require('./a');\nconsole.log(m);\n",
            "star.ts": "export * from './a';\n",
            "named.ts": "export { a } from './a';\n",
        });
        expect(directImporters(dir, "a.ts")).toEqual(["dyn.ts", "named.ts", "req.ts", "star.ts"]);
    });
});
