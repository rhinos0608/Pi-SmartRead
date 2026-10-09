import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enumerateRepository } from "../../../scripts/eval/inspect-cohort/enumerate.js";

const roots: string[] = [];
function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "inspect-enum-"));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
        const target = join(root, path);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, text);
    }
    return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("frozen inspect source enumeration", () => {
    it("enumerates supported static relations, manifests, routes, and tRPC keys", () => {
        const root = fixture({
            "src/main.ts": `import { x } from "./lib";\nexport { y } from "./other";\nconst z = require("./common");\napp.get("/health", handler);\nrouter.post('/items', handler);\nt.router({ users: userProcedure, posts: postProcedure });`,
            "src/lib.ts": "export const x = 1;",
            "src/other/index.tsx": "export const y = 1;",
            "src/common.js": "module.exports = 1;",
            "package.json": JSON.stringify({ exports: { ".": "./src/main.ts" }, main: "./src/common.js", types: "./src/index.d.ts", workspaces: ["packages/*"] }),
            "app/users/route.ts": "export async function GET() {}\nexport function POST() {}",
            "pages/api/items.ts": "export default function handler() {}",
        });
        const result = enumerateRepository(root, "owner__repo");
        const kinds = result.candidates.map((item) => item.kind);
        expect(kinds).toContain("import");
        expect(kinds).toContain("re-export");
        expect(kinds).toContain("require");
        expect(kinds).toContain("package");
        expect(kinds.filter((kind) => kind === "route")).toHaveLength(2);
        expect(kinds.filter((kind) => kind === "next-route")).toHaveLength(3);
        expect(kinds.filter((kind) => kind === "trpc")).toHaveLength(2);
        expect(result.candidates.find((item) => item.specifier === "./lib")?.resolved).toBe("src/lib.ts");
        expect(result.candidates.find((item) => item.specifier === "./other")?.resolved).toBe("src/other/index.tsx");
        expect(result.universe.count).toBe(result.candidates.length);
    });

    it("ignores comments, strings, dynamic imports, and flags template routes and unresolved aliases", () => {
        const root = fixture({
            "src/main.ts": `// app.get("/comment", fn)\nconst text = 'import x from "./fake"; app.get("/string", fn)';\nconst loaded = import(name);\nconst required = require(name);\napp.get(path, handler);\napp.get(\`/template\`, handler);\nimport thing from "@missing/thing";`,
            "package.json": "{}",
        });
        const result = enumerateRepository(root, "owner__repo", { "@known/*": "src/*" });
        expect(result.candidates.some((item) => item.path === "/comment" || item.path === "/string")).toBe(false);
        expect(result.candidates.some((item) => item.specifier === "./fake")).toBe(false);
        expect(result.candidates.some((item) => item.unresolvedReason === "dynamic-specifier")).toBe(true);
        expect(result.candidates.some((item) => item.path === "<dynamic>")).toBe(true);
        expect(result.candidates.some((item) => item.specifier === "@missing/thing" && item.resolved === null && item.unresolvedReason)).toBe(true);
    });

    it("excludes regex-literal decoys without confusing division expressions", () => {
        const root = fixture({
            "src/regex.ts": `const decoy = /import fake from "\\.\\/fake"; require("\\.\\/fake"); app\\.get("\\/fake", fn)/;\nconst divided = value / denominator;\nconst division = total / app.get("/real", handler);`,
            "package.json": "{}",
        });
        const result = enumerateRepository(root, "owner__repo");
        expect(result.candidates.some((item) => item.specifier === "./fake" || item.path === "/fake")).toBe(false);
        expect(result.candidates.some((item) => item.path === "/real"), JSON.stringify(result.candidates)).toBe(true);
        expect(result.candidates).toHaveLength(1);
    });

    it("excludes regex literals in ambiguous expression contexts and JSX", () => {
        const root = fixture({
            "src/regex.tsx": `if (flag) /app.get("\\/after-paren", fn)/.test(value);\nfunction read() { return /import fake from "fake"|require\\("fake"\\)|router\\.post\\("\\/return", fn\\)/.test(value); }\nconst assigned = /api.get("\\/equals", fn)/;\nconst grouped = (/server.post("\\/open", fn)/.test(value));\nconst tuple = (value, /fastify.get("\\/comma", fn)/.test(other));\nconst division = (value) / app.get("/real", handler);\nconst jsx = <div>{/app.get("\\/jsx", fn)/.test(value)}</div>;`,
            "package.json": "{}",
        });
        const result = enumerateRepository(root, "owner__repo");
        expect(result.candidates.filter((item) => item.kind === "route").map((item) => item.path)).toEqual(["/real"]);
        expect(result.candidates.some((item) => item.specifier === "fake")).toBe(false);
    });

    it("uses frozen alias mappings and deterministic ids, ordering, and digest", () => {
        const root = fixture({ "src/a.ts": `import a from "@/a";\nimport b from "./absent";`, "src/a/index.ts": "export default 1;", "package.json": "{}" });
        const aliases = { "@/*": "src/*" };
        const first = enumerateRepository(root, "x__y", aliases);
        const second = enumerateRepository(root, "x__y", aliases);
        expect(first).toEqual(second);
        expect(first.candidates.find((item) => item.specifier === "@/a")?.resolved).toBe("src/a.ts");
        expect(first.candidates.find((item) => item.specifier === "./absent")?.unresolvedReason).toBe("out-of-scope");
        expect(first.candidates.map((item) => item.id)).toEqual([...first.candidates.map((item) => item.id)].sort());
    });

    it("does not import production source or engine modules", async () => {
        const { readFileSync } = await import("node:fs");
        const source = readFileSync(new URL("../../../scripts/eval/inspect-cohort/enumerate.ts", import.meta.url), "utf8");
        expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+(?:src|repository|graph|search|lsp|inspect)\//);
    });
});
