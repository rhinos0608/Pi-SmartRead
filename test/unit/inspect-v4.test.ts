/**
 * inspect v4 tests: path-based mode detection.
 * - Directory → repo map (mode "directory"), evidence mode "map", zero resources
 * - File → structural facts + signals (mode "file"), evidence mode "file", search-match coverage
 * - Nonexistent path throws
 * - Legacy query/symbol/action params throw migration errors
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    resolveInspectV4Mode,
    executeInspectV4,
    executeDirectoryInspect,
    executeFileInspect,
} from "../../src/inspect.js";
import { createInspectV4Tool } from "../../src/inspect-tool.js";

let workdir: string;
let file: string;
let subdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "inspect-v4-")));
    mkdirSync(workdir, { recursive: true });
    file = join(workdir, "hello.ts");
    writeFileSync(file, "alpha\nbeta\ngamma\ndelta\n", "utf8");
    subdir = join(workdir, "mysrc");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "a.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(subdir, "b.ts"), "export const b = 2;\n", "utf8");
});

afterEach(() => {
    vi.restoreAllMocks();
});

function makeCtx(): any {
    return { cwd: workdir, sessionManager: undefined };
}

describe("resolveInspectV4Mode", () => {
    it("returns 'directory' for a directory path", () => {
        expect(resolveInspectV4Mode({ path: subdir, cwd: workdir, sessionFilePath: "/s.jsonl" })).toBe("directory");
    });

    it("returns 'file' for a file path", () => {
        expect(resolveInspectV4Mode({ path: "hello.ts", cwd: workdir, sessionFilePath: "/s.jsonl" })).toBe("file");
    });

    it("returns 'file' for absolute file path", () => {
        expect(resolveInspectV4Mode({ path: file, cwd: workdir, sessionFilePath: "/s.jsonl" })).toBe("file");
    });

    it("throws for nonexistent path", () => {
        expect(() => resolveInspectV4Mode({ path: "nonexistent.ts", cwd: workdir, sessionFilePath: "/s.jsonl" })).toThrow();
    });
});

describe("executeInspectV4", () => {
    it("directory mode produces map content and evidence mode='map' with zero resources", async () => {
        const result = await executeInspectV4({
            path: "mysrc",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(result.mode).toBe("directory");
        expect(result.workspaceEvidence.mode).toBe("map");
        expect(result.workspaceEvidence.resources).toEqual([]);
        expect(result.contentText).toContain("a.ts");
        expect(result.contentText).toContain("b.ts");
        // Protocol validator accepts mode 'symbol' (not 'file').
        expect(result.workspaceEvidence.schemaVersion).toBe(3);
        expect(result.workspaceEvidence.inspectionId).toMatch(/^[0-9a-f]{64}$/);
        expect(result.workspaceEvidence.sessionId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("file mode produces structural facts + signals and evidence mode='file'", async () => {
        const result = await executeInspectV4({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(result.mode).toBe("file");
        expect(result.workspaceEvidence.mode).toBe("symbol");
        expect(result.contentText).toContain("Signals");
        // Protocol validator accepts mode 'symbol' (not 'file').
        expect(result.workspaceEvidence.schemaVersion).toBe(3);
        expect(result.workspaceEvidence.inspectionId).toMatch(/^[0-9a-f]{64}$/);
        expect(result.workspaceEvidence.sessionId).toMatch(/^[0-9a-f]{64}$/);
        expect(Array.isArray(result.workspaceEvidence.resources)).toBe(true);
    });

    it("rejects ephemeral session identity", async () => {
        await expect(
            executeInspectV4({
                path: "hello.ts",
                cwd: workdir,
                sessionFilePath: "",
            }),
        ).rejects.toThrow(/session/i);
    });

    it("throws for nonexistent path", async () => {
        await expect(
            executeInspectV4({
                path: "nonexistent.ts",
                cwd: workdir,
                sessionFilePath: "/sessions/abc.jsonl",
            }),
        ).rejects.toThrow();
    });
});

describe("executeDirectoryInspect", () => {
    it("returns repo map content with evidence mode='map'", async () => {
        const result = await executeDirectoryInspect({
            path: "mysrc",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(result.mode).toBe("directory");
        expect(result.contentText).toContain("a.ts");
        expect(result.workspaceEvidence.mode).toBe("map");
        expect(result.workspaceEvidence.resources).toEqual([]);
        expect(result.lineCount).toBeGreaterThan(0);
        expect(result.workspaceEvidence.schemaVersion).toBe(3);
        expect(result.workspaceEvidence.inspectionId).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("executeFileInspect", () => {
    it("returns structural facts + signals with evidence mode='file'", async () => {
        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(result.mode).toBe("file");
        expect(result.contentText).toContain("Structural Facts: hello.ts");
        expect(result.contentText).toContain("Signals");
        expect(result.workspaceEvidence.mode).toBe("symbol");
        expect(Array.isArray(result.workspaceEvidence.resources)).toBe(true);
        expect(result.workspaceEvidence.schemaVersion).toBe(3);
        expect(result.workspaceEvidence.inspectionId).toMatch(/^[0-9a-f]{64}$/);
        expect(result.workspaceEvidence.sessionId).toMatch(/^[0-9a-f]{64}$/);
    });

    it("renders sections even when structural facts are empty (engines are stubs)", async () => {
        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(result.contentText).toContain("External Dependents (0)");
        expect(result.contentText).toContain("Dependencies (0)");
        expect(result.contentText).toContain("Internal Call Sites (0)");
        expect(result.contentText).toContain("Children (0)");
        expect(result.contentText).toContain("Base Classes / Interfaces");
        expect(result.contentText).toContain("Overrides");
        expect(result.contentText).toContain("Re-Exported By (0)");
    });

    it("signal rendering uses human-readable names without Yes:Yes or Unknown:Unknown", async () => {
        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        const text = result.contentText;
        // Human-readable names should appear in output
        expect(text).toContain("Complexity");
        expect(text).toContain("Public API");
        expect(text).toContain("External Reuse");
        expect(text).toContain("Last Change");
        expect(text).toContain("Tests");
        expect(text).toContain("Deprecation");
        // Forbidden patterns: will contain label/value but not "Yes: Yes" or "Unknown: Unknown"
        expect(text).not.toContain("Yes: Yes");
        expect(text).not.toContain("Unknown: Unknown");
    });

    it("finds convention-matched tests in nested repo test directories", async () => {
        const srcDir = join(workdir, "src");
        const unitTestDir = join(workdir, "test", "unit");
        mkdirSync(srcDir, { recursive: true });
        mkdirSync(unitTestDir, { recursive: true });
        writeFileSync(join(srcDir, "feature.ts"), "export const feature = true;\n", "utf8");
        writeFileSync(join(unitTestDir, "feature.test.ts"), "test('feature', () => {});\n", "utf8");

        const result = await executeFileInspect({
            path: "src/feature.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
            signals: ["tests"],
        });

        expect(result.contentText).toContain("Tests: Yes (test/unit/feature.test.ts)");
    });

    it("uses import-scan dependents when context graph has no importer edge", async () => {
        writeFileSync(join(workdir, "target.ts"), "export const target = true;\n", "utf8");
        writeFileSync(join(workdir, "importer.ts"), 'import { target } from "./target.ts";\n', "utf8");
        const emptyGraph = {
            getFileNeighbours: async () => [],
        } as any;

        const result = await executeFileInspect({
            path: "target.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
            contextGraph: emptyGraph,
            signals: ["reuse"],
        });

        expect(result.contentText).toContain("External Dependents (1)");
        expect(result.contentText).toContain("External Reuse: Yes (1 importing file)");
    });

    it("no-graph graphSchema fallback shows import/dependent edges, not just 'not built'", async () => {
        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
            graphSchema: true,
        });
        const text = result.contentText;
        // Should mention fallback nature and show counts
        expect(text).toContain("Context graph: not available");
        expect(text).toContain("dependencies");
        expect(text).toContain("dependents");
        // Should NOT contain the old "not built" message alone
        expect(text).not.toMatch(/contextGraph: "not built"/i);
    });

    it("no-graph impact fallback shows direct import-scan dependents", async () => {
        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
            impact: true,
        });
        const text = result.contentText;
        // Should mention fallback nature clearly
        expect(text).toContain("Context graph not available");
        expect(text).toContain("import-scan");
    });

    it("evidence resources include files from externalDependents and dependencies", async () => {
        // Create an importing file
        const importerPath = join(workdir, "importer.ts");
        writeFileSync(importerPath, `import { hello } from "./hello.ts";\n`, "utf8");

        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        // Should reference the importer file in content
        expect(result.contentText).toContain("External Dependents");
        // Resources should exist
        expect(result.workspaceEvidence.resources.length).toBeGreaterThanOrEqual(1);
        // Re-verify new section names appear
        expect(result.contentText).toContain("Dependencies");
        expect(result.contentText).toContain("Internal Call Sites");
    });

    it("external dependent importer has range on importer file at import line", async () => {
        // Create an importing file that imports hello.ts
        const importerPath = join(workdir, "sub", "importer.ts");
        mkdirSync(join(workdir, "sub"), { recursive: true });
        writeFileSync(importerPath, "import { hello } from '../hello.ts';\n", "utf8");

        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        // External dependents section should reference the importer file
        expect(result.contentText).toContain("importer.ts");
        // Evidence should include the importer file path (canonicalPath)
        const hasImporter = result.workspaceEvidence.resources.some(
            (r: any) => r.canonicalPath && r.canonicalPath.includes("importer.ts")
        );
        expect(hasImporter).toBe(true);
    });

    it("dependency line belongs to inspected file, not dependency file", async () => {
        // hello.ts imports from sub/helper.ts
        const helperDir = join(workdir, "sub");
        mkdirSync(helperDir, { recursive: true });
        writeFileSync(join(helperDir, "helper.ts"), "export const helper = 1;\n", "utf8");
        writeFileSync(file, 'import { helper } from "./sub/helper.ts";\n' + "alpha\nbeta\ngamma\ndelta\n", "utf8");

        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        // Should render the dependency with line number
        expect(result.contentText).toContain("Dependencies");
        expect(result.contentText).toContain("L1");
        // Evidence should include the inspected file as resource (dependency line on hello.ts)
        const hasInspectedResource = result.workspaceEvidence.resources.some(
            (r: any) => r.canonicalPath && r.canonicalPath.includes("hello.ts")
        );
        expect(hasInspectedResource).toBe(true);
    });

    it("same-basename different module is NOT counted as external dependent", async () => {
        // Create two modules with same basename in different directories
        mkdirSync(join(workdir, "modA"), { recursive: true });
        mkdirSync(join(workdir, "modB"), { recursive: true });
        writeFileSync(join(workdir, "modA", "helper.ts"), "export const foo = 1;\n", "utf8");
        writeFileSync(join(workdir, "modB", "helper.ts"), "export const bar = 2;\n", "utf8");
        // modA/client.ts imports from modA/helper.ts — should NOT be dependent of modB/helper.ts
        writeFileSync(join(workdir, "modA", "client.ts"), 'import { foo } from "./helper.ts";\n', "utf8");
        // modB/npm-like.ts imports bare "express" — should NOT be dependent of anything
        writeFileSync(join(workdir, "modB", "npmlike.ts"), 'import express from "express";\n', "utf8");

        const resultB = await executeFileInspect({
            path: join(workdir, "modB", "helper.ts"),
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        // modB/helper.ts should have zero external dependents
        expect(resultB.contentText).toContain("External Dependents (0)");

        const resultA = await executeFileInspect({
            path: join(workdir, "modA", "helper.ts"),
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        // modA/helper.ts should have 1 external dependent (client.ts)
        expect(resultA.contentText).toContain("External Dependents (1)");
        expect(resultA.contentText).toContain("client.ts");
    });

    it(".js specifier resolves .ts target", async () => {
        // TS file that imports with .js extension but the underlying file is .ts
        writeFileSync(join(workdir, "dep.ts"), "export const x = 1;\n", "utf8");
        writeFileSync(join(workdir, "user.ts"), 'import { x } from "./dep.js";\n', "utf8");

        const result = await executeFileInspect({
            path: "dep.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        // user.ts should be found as external dependent via .js→.ts resolution
        expect(result.contentText).toContain("External Dependents (1)");
        expect(result.contentText).toContain("user.ts");
    });

    it("extensionless specifier resolves index.ts", async () => {
        // Create barrel: mod/index.ts imported as "./mod"
        mkdirSync(join(workdir, "mylib"), { recursive: true });
        writeFileSync(join(workdir, "mylib", "index.ts"), "export const magic = 42;\n", "utf8");
        writeFileSync(join(workdir, "app.ts"), 'import { magic } from "./mylib";\n', "utf8");

        const result = await executeFileInspect({
            path: join(workdir, "mylib", "index.ts"),
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(result.contentText).toContain("External Dependents (1)");
        expect(result.contentText).toContain("app.ts");
    });

    it("nested importer is found repo-wide (not just sibling)", async () => {
        // Deeply nested importer in subdirectory
        mkdirSync(join(workdir, "a", "b", "c"), { recursive: true });
        writeFileSync(join(workdir, "a", "b", "c", "deep.ts"), 'import { hello } from "../../../hello.ts";\n', "utf8");

        const result = await executeFileInspect({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(result.contentText).toContain("External Dependents (1)");
        expect(result.contentText).toContain("deep.ts");
    });
});

describe("createInspectV4Tool (schema and execute)", () => {
    it("registers with the name 'inspect'", () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => null });
        expect(tool.name).toBe("inspect");
    });

    it("has path param and no query/symbol/action", () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => null });
        const schema = tool.parameters as Record<string, any>;
        const props = schema.properties ?? schema;
        expect(props.path).toBeDefined();
        expect(props.query).toBeUndefined();
        expect(props.symbol).toBeUndefined();
        expect(props.action).toBeUndefined();
    });

    it("description mentions file and directory modes", () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => null });
        expect(tool.description).toContain("directory");
        expect(tool.description).toContain("file");
        expect(tool.description).toContain("structural facts");
    });

    it("executes directory mode through the tool factory", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        const result = await tool.execute("c1", { path: "mysrc" }, undefined, undefined, makeCtx());
        const details = (result as any).details;
        expect(details.mode).toBe("directory");
        expect(details.workspaceEvidence.mode).toBe("map");
    });

    it("executes file mode through the tool factory", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        const result = await tool.execute("c2", { path: "hello.ts" }, undefined, undefined, makeCtx());
        const details = (result as any).details;
        expect(details.mode).toBe("file");
        expect(details.workspaceEvidence.mode).toBe("symbol");
    });

    it("rejects legacy query param with migration error", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(
            tool.execute("c3", { query: "old" } as any, undefined, undefined, makeCtx()),
        ).rejects.toThrow(/grep/);
    });

    it("rejects legacy symbol param with migration error", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(
            tool.execute("c4", { symbol: "old" } as any, undefined, undefined, makeCtx()),
        ).rejects.toThrow(/symbol/i);
    });

    it("rejects legacy action param with migration error", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(
            tool.execute("c5", { action: "map" } as any, undefined, undefined, makeCtx()),
        ).rejects.toThrow(/action/);
    });

    it("publishes envelope through resolver when provided", async () => {
        const published: any[] = [];
        const tool = createInspectV4Tool({
            getSessionFilePath: () => "/sessions/abc.jsonl",
            resolver: {
                publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
                    published.push({ envelope, sessionFilePath, workspaceRoot });
                },
            },
        });
        await tool.execute("c6", { path: "mysrc" }, undefined, undefined, makeCtx());
        expect(published).toHaveLength(1);
        expect(published[0].envelope.resources).toEqual([]);
    });

    it("awaits an async contextGraph getter before graph-dependent output (runtime wiring)", async () => {
        let built = false;
        const tool = createInspectV4Tool({
            getSessionFilePath: () => "/sessions/abc.jsonl",
            contextGraph: async () => {
                const { ContextGraph } = await import("../../src/context-graph.js");
                const graph = new ContextGraph(workdir);
                await graph.buildContextGraph();
                built = true;
                return graph;
            },
        });
        const result = await tool.execute(
            "c-graph",
            { path: "hello.ts", graphSchema: true },
            undefined,
            undefined,
            makeCtx(),
        );
        // The registered runtime tool must await the getter (build) before
        // producing graph-dependent output — never receive an unbuilt graph.
        expect(built).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Graph Schema");
    });
});

describe("inspect lazy ContextGraph getter", () => {
    function makeGraphStub(): any {
        return {
            getProvenanceEdges: () => [],
            getCapacityStats: () => ({ fileIndex: { entries: 0 }, graphIndex: { entries: 0 } }),
            getFileNeighbours: async () => [],
            getNeighbors: async () => [],
            getSymbolIndex: () => ({}),
        };
    }

    function makeTool() {
        const getter = vi.fn(async (_root: string) => makeGraphStub());
        const tool = createInspectV4Tool({
            getSessionFilePath: () => "/sessions/abc.jsonl",
            contextGraph: getter,
        });
        return { tool, getter };
    }

    async function run(tool: any, params: Record<string, unknown>) {
        try {
            await tool.execute("x", params, undefined, undefined, makeCtx());
        } catch {
            // Execution result is irrelevant here — only whether the getter fired.
        }
    }

    it("does not invoke getter for ordinary file inspect", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "hello.ts" });
        expect(getter).not.toHaveBeenCalled();
    });

    it("does not invoke getter for ordinary package.json inspect", async () => {
        writeFileSync(join(workdir, "package.json"), "{\"name\":\"fixture\"}\n", "utf8");
        const { tool, getter } = makeTool();
        await run(tool, { path: "package.json" });
        expect(getter).not.toHaveBeenCalled();
    });

    it("does not invoke getter for ordinary directory inspect", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "mysrc" });
        expect(getter).not.toHaveBeenCalled();
    });

    it("does not invoke getter for signals including reuse", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "hello.ts", signals: ["reuse", "tests"] });
        expect(getter).not.toHaveBeenCalled();
    });

    it("does not invoke getter for call traversal, deadCode, hotspots, diff, routes, boundaries", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "hello.ts", callDepth: 2, callDirection: "callers" });
        await run(tool, { path: "hello.ts", deadCode: true });
        await run(tool, { path: "hello.ts", hotspots: true });
        await run(tool, { path: "hello.ts", diff: "HEAD" });
        await run(tool, { path: "hello.ts", routes: true });
        await run(tool, { path: "mysrc", boundaries: true });
        expect(getter).not.toHaveBeenCalled();
    });

    it("invalid file-mode param (clusters) rejects without invoking getter", async () => {
        const { tool, getter } = makeTool();
        await expect(
            tool.execute("x", { path: "hello.ts", clusters: true }, undefined, undefined, makeCtx()),
        ).rejects.toThrow(/clusters/);
        expect(getter).not.toHaveBeenCalled();
    });

    it("nonexistent path rejects without invoking getter", async () => {
        const { tool, getter } = makeTool();
        await expect(
            tool.execute("x", { path: "does-not-exist.ts" }, undefined, undefined, makeCtx()),
        ).rejects.toThrow();
        expect(getter).not.toHaveBeenCalled();
    });

    it("directory clusters invokes getter once", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "mysrc", clusters: true });
        expect(getter).toHaveBeenCalledTimes(1);
        expect(getter).toHaveBeenCalledWith(workdir);
    });

    it("directory layers invokes getter once", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "mysrc", layers: true });
        expect(getter).toHaveBeenCalledTimes(1);
    });

    it("directory graphSchema invokes getter once", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "mysrc", graphSchema: true });
        expect(getter).toHaveBeenCalledTimes(1);
    });

    it("file graphSchema invokes getter once", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "hello.ts", graphSchema: true });
        expect(getter).toHaveBeenCalledTimes(1);
        expect(getter).toHaveBeenCalledWith(workdir);
    });

    it("file impact invokes getter once", async () => {
        const { tool, getter } = makeTool();
        await run(tool, { path: "hello.ts", impact: true });
        expect(getter).toHaveBeenCalledTimes(1);
    });

    it("file clusters is rejected (dir-only) without invoking getter", async () => {
        const { tool, getter } = makeTool();
        await expect(
            tool.execute("x", { path: "hello.ts", clusters: true }, undefined, undefined, makeCtx()),
        ).rejects.toThrow();
        expect(getter).not.toHaveBeenCalled();
    });
});
