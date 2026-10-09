import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGatherRecipe } from "../../../src/inspect/inspect-structural-gather.js";
import { DEFAULT_INSPECT_BUDGET } from "../../../src/inspect/inspect-task-contract.js";
import { DEFAULT_SCOPE_LIMITS } from "../../../src/inspect/inspect-bounded-scope.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "inspect-gather-")); roots.push(root);
    for (const [path, text] of Object.entries(files)) {
        const target = join(root, path); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, text);
    }
    return root;
}
const budget = { ...DEFAULT_INSPECT_BUDGET };

describe("bounded inspect structural gather", () => {
    it("returns stable source-backed dependency citations and unresolved aliases", async () => {
        const root = fixture({ "a.ts": 'import { b } from "./b";\nimport x from "@/x";\n', "b.ts": "export const b = 1;\n" });
        const input = { mode: "file" as const, root: join(root, "a.ts"), budget };
        const a = await runGatherRecipe("dependencies", input);
        const b = await runGatherRecipe("dependencies", input);
        expect(a.relations).toEqual(b.relations);
        expect(a.unresolved).toEqual(b.unresolved);
        expect(a.stages.map((stage) => stage.name)).toEqual(b.stages.map((stage) => stage.name));
        expect(a.relations).toEqual([expect.objectContaining({ source: "a.ts", target: "b.ts", specifier: "./b", resolutionRule: "relative-extension" })]);
        expect(a.relations[0]?.citation).toMatchObject({ path: "a.ts", range: { start: 1, end: 1 }, specifier: "./b", resolutionRule: "relative-extension" });
        expect(a.unresolved).toContainEqual(expect.objectContaining({ specifier: "@/x", reason: "alias-not-supported" }));
        expect(a.coverage).toBe("complete");
    });

    it("ignores commented-out import and route examples", async () => {
        const root = fixture({ "a.ts": '// import "./missing"; app.get("/fake", handler);\\nexport const value = 1;' });
        const result = await runGatherRecipe("overview", { mode: "directory", root, budget });
        expect(result.relations).toEqual([]);
        expect(result.sections.find((section) => section.name === "routes")?.items).toEqual([]);
    });

    it("records exact and extension-correspondence resolution separately", async () => {
        const root = fixture({ "a.ts": 'import "./exact.ts";\nimport "./mapped.js";\nimport "./folder";', "exact.ts": "", "mapped.ts": "", "folder/index.ts": "" });
        const result = await runGatherRecipe("overview", { mode: "directory", root, budget });
        expect(result.relations).toEqual(expect.arrayContaining([
            expect.objectContaining({ specifier: "./exact.ts", resolutionRule: "relative-exact" }),
            expect.objectContaining({ specifier: "./mapped.js", target: "mapped.ts", resolutionRule: "relative-extension" }),
            expect.objectContaining({ specifier: "./folder", target: "folder/index.ts", resolutionRule: "relative-index" }),
        ]));
    });

    it("includes direct importers of a file target in deterministic order", async () => {
        const root = fixture({ "target.ts": "export const target = 1;", "z.ts": 'import "./target";', "a.ts": 'import "./target";' });
        const result = await runGatherRecipe("dependencies", { mode: "file", root: join(root, "target.ts"), budget });
        expect(result.sections.find((section) => section.name === "dependencies")?.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ source: "a.ts", target: "target.ts" }),
            expect.objectContaining({ source: "z.ts", target: "target.ts" }),
        ]));
        expect(result.relations.map((relation) => relation.source)).toEqual(["a.ts", "z.ts"]);
    });

    it("resolves declared dependencies and workspace package entries with recorded rules", async () => {
        const root = fixture({
            "package.json": JSON.stringify({ name: "root", dependencies: { lodash: "^1" }, workspaces: ["packages/*"] }),
            "packages/lib/package.json": JSON.stringify({ name: "@work/lib", main: "src/index.ts" }),
            "packages/lib/src/index.ts": "export const lib = 1;",
            "a.ts": 'import "lodash";\nimport "@work/lib";\nimport "missing";\n',
        });
        const result = await runGatherRecipe("architecture", { mode: "directory", root, budget });
        expect(result.relations).toEqual(expect.arrayContaining([
            expect.objectContaining({ specifier: "lodash", target: "lodash", kind: "manifest-dep", resolutionRule: "manifest-declared" }),
            expect.objectContaining({ specifier: "@work/lib", target: "packages/lib/src/index.ts", kind: "workspace-import", resolutionRule: "workspace-manifest" }),
        ]));
        expect(result.unresolved).toContainEqual(expect.objectContaining({ specifier: "missing", reason: "undeclared-package" }));
    });

    it("limits change-review output to corroborated relations intersecting diff ranges", async () => {
        const root = fixture({ "a.ts": 'import "./b";\nconst stable = 1;\n', "b.ts": "export const b = 1;" });
        const result = await runGatherRecipe("change-review", { mode: "directory", root, budget,
            diffProvider: async () => `--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-import "./b";
+import "./b";
` });
        const section = result.sections.find((entry) => entry.name === "change-review");
        expect(section?.items).toEqual([expect.objectContaining({ specifier: "./b" })]);
    });

    it("keeps dynamic import and template specifiers unresolved", async () => {
        const root = fixture({ "a.ts": 'const one = import(name);\nconst two = import(`./template`);' });
        const result = await runGatherRecipe("dependencies", { mode: "file", root: join(root, "a.ts"), budget });
        expect(result.unresolved).toEqual(expect.arrayContaining([
            expect.objectContaining({ specifier: "<dynamic>", reason: "dynamic-specifier" }),
        ]));
    });

    it("surfaces tsconfig path aliases as unsupported aliases, not package misses", async () => {
        const root = fixture({ "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@app/*": ["src/*"] } } }),
            "a.ts": 'import "@app/util";', "src/util.ts": "export const util = 1;" });
        const result = await runGatherRecipe("overview", { mode: "directory", root, budget });
        expect(result.unresolved).toContainEqual(expect.objectContaining({ specifier: "@app/util", reason: "alias-not-supported" }));
    });

    it("reports verified static registrations as source candidates, not mounted endpoints", async () => {
        const root = fixture({ "routes.ts": 'app.get("/users", handler);\napp.post(`/dynamic`, handler);\n' });
        const result = await runGatherRecipe("routes", { mode: "directory", root, budget });
        expect(result.sections).toContainEqual(expect.objectContaining({ name: "routes", coverage: "partial" }));
        expect(result.omissions).toContain("routes.ts:2: dynamic-route-registration");
        expect(result.sections.flatMap((section) => section.items)).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: "routes.ts", route: "/users", range: { start: 1, end: 1 } }),
        ]));
        expect(result.heuristics).toContain(expect.stringMatching(/not.*mounted/i));
        expect(result.sections.find((section) => section.name === "routes")?.heuristics).toContain(expect.stringMatching(/not.*mounted/i));
    });

    it("stops later sequential stages on cancellation", async () => {
        const root = fixture({ "a.ts": 'import "./b";', "b.ts": "" });
        const controller = new AbortController();
        const result = await runGatherRecipe("dependencies", { mode: "directory", root, budget, signal: controller.signal,
            sourceReader: async (path) => { controller.abort(); return path === "a.ts" ? 'import "./b";' : ""; } });
        expect(result.stages.map((stage) => stage.status)).toContain("not-run");
        expect(result.stages.at(-1)?.status).toBe("not-run");
    });

    it("refuses over-budget scope before reading source", async () => {
        const root = fixture({ "a.ts": "x" }); let reads = 0;
        const result = await runGatherRecipe("dependencies", { mode: "directory", root, budget: { ...budget, scannedFiles: 0 },
            sourceReader: async () => { reads++; return ""; } });
        expect(reads).toBe(0);
        expect(result.status).toBe("partial");
        expect(result.followups.length).toBeGreaterThan(0);
    });

    it("does not claim complete coverage when bounded enumeration is partial", async () => {
        const root = fixture({ "a.ts": "", "b.ts": "" });
        const result = await runGatherRecipe("overview", { mode: "directory", root, budget,
            limits: { ...DEFAULT_SCOPE_LIMITS, maxEntries: 1 } });
        expect(result.status).toBe("partial");
        expect(result.coverage).toBe("partial");
        expect(result.sections.every((section) => section.coverage !== "complete")).toBe(true);
    });

    it("refuses relation output before exceeding the output-byte budget", async () => {
        const root = fixture({ "a.ts": 'import "./b";', "b.ts": "" });
        const result = await runGatherRecipe("dependencies", { mode: "directory", root, budget: { ...budget, outputBytes: 1 } });
        expect(result.status).toBe("partial");
        expect(result.followups).toContain(expect.stringMatching(/output/i));
        expect(result.relations).toEqual([]);
    });

    it("marks a builder without bound and cancellation guarantees unsupported", async () => {
        const root = fixture({ "a.ts": "" });
        const result = await runGatherRecipe("architecture", { mode: "directory", root, budget,
            boundedBuilder: async () => ({ bounded: false, cancellation: false, value: [] }) });
        expect(result.status).toBe("unsupported");
        expect(result.relations).toEqual([]);
    });
});
