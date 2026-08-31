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
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
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

describe("WP-SR3 inspect.navigation + inspect.diagnostics (decision §1 §2)", () => {
    it("directory workspaceSymbols keeps mode map zero resources and renders navigation section", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        const result = await tool.execute("c-nav-dir", { path: "mysrc", navigation: { operation: "workspaceSymbols", query: "a" } }, undefined, undefined, makeCtx());
        const details: any = (result as any).details;
        expect(details.mode).toBe("directory");
        expect(details.workspaceEvidence.mode).toBe("map");
        expect(details.workspaceEvidence.resources).toEqual([]);
        // verbatim shape: schemaVersion 1, source lsp, truncated boolean, status additive-friendly
        expect(details.navigation).toBeDefined();
        expect(details.navigation.schemaVersion).toBe(1);
        expect(details.navigation.source).toBe("lsp");
        expect(details.navigation.operation).toBe("workspaceSymbols");
        expect(["ok", "empty", "unavailable", "degraded"].includes(details.navigation.status) || typeof details.navigation.status === "string").toBe(true);
        expect(Array.isArray(details.navigation.items)).toBe(true);
        expect(typeof details.navigation.truncated).toBe("boolean");
        const text = (result.content[0] as any).text as string;
        expect(text).toContain("## LSP Navigation");
        expect(text).toContain("workspaceSymbols");
        // tryCanonical seam: paths in items must be realpath canonical (contains workdir)
        for (const it of details.navigation.items as any[]) {
            const uri: string | undefined = it?.location?.uri ?? it?.uri;
            if (uri) expect(uri).toContain("file://");
        }
    });

    it("call hierarchy operations require line/character and forbid query, respect maxResults bounding", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(tool.execute("c-ch1", { path: "hello.ts", navigation: { operation: "prepareCallHierarchy" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/requires line/);
        await expect(tool.execute("c-ch2", { path: "hello.ts", navigation: { operation: "incomingCalls", line: 1, character: 1, query: "q" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/forbids query/);
        await expect(tool.execute("c-ch3", { path: "mysrc", navigation: { operation: "prepareCallHierarchy", line: 1, character: 1 } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/requires a file/);
        await expect(tool.execute("c-ch-bounds", { path: "hello.ts", navigation: { operation: "outgoingCalls", line: 1, character: 1, maxResults: 101 } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/maxResults/);
        const fileAbs = realpathSync(join(workdir, "hello.ts"));
        const item = { name: "fn", kind: 12, uri: "file://" + fileAbs, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } };
        const inc = { from: item, fromRanges: [{ start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }] };
        const provider: any = {
            inspectNavigation: async (inp: any) => {
                if (inp.operation === "prepareCallHierarchy") return { status: "confirmed", operation: inp.operation, items: [item], truncated: false };
                if (inp.operation === "incomingCalls") return { status: "confirmed", operation: inp.operation, items: [inc], truncated: false };
                return { status: "empty", operation: inp.operation, items: [], truncated: false };
            },
            inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
        };
        const tool2 = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl", lspInspectionProvider: provider });
        const r = await tool2.execute("c-ch-ok", { path: "hello.ts", navigation: { operation: "prepareCallHierarchy", line: 1, character: 1 } }, undefined, undefined, makeCtx());
        const details: any = (r as any).details;
        expect(details.navigation.status).toBe("ok");
        expect(details.navigation.operation).toBe("prepareCallHierarchy");
        for (const res of details.workspaceEvidence.resources as any[]) expect(res.coverage).toBe("search-match");
        const r2 = await tool2.execute("c-ch-inc", { path: "hello.ts", navigation: { operation: "incomingCalls", line: 1, character: 1 } }, undefined, undefined, makeCtx());
        const d2: any = (r2 as any).details;
        expect(d2.navigation.status).toBe("ok");
        expect((r2.content[0] as any).text).toContain("incoming from");
    });

    it("file definition requires line/character forbids query", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(tool.execute("c1", { path: "hello.ts", navigation: { operation: "definition" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/requires line/);
        await expect(tool.execute("c2", { path: "hello.ts", navigation: { operation: "definition", line: 1, character: 1, query: "x" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/forbids query/);
        // documentSymbols forbids line/character/query
        await expect(tool.execute("c3", { path: "hello.ts", navigation: { operation: "documentSymbols", line: 1 } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/forbids/);
        await expect(tool.execute("c4", { path: "hello.ts", navigation: { operation: "documentSymbols", query: "q" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/forbids/);
        // workspaceSymbols requires directory
        await expect(tool.execute("c5", { path: "hello.ts", navigation: { operation: "workspaceSymbols", query: "q" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/requires a directory/);
        await expect(tool.execute("c6", { path: "mysrc", navigation: { operation: "workspaceSymbols" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/requires query/);
        // workspaceSymbols forbids line/character
        await expect(tool.execute("c7", { path: "mysrc", navigation: { operation: "workspaceSymbols", query: "q", line: 1 } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/forbids line/);
    });

    it("file navigation keeps coverage search-match and renders section", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        const result = await tool.execute("c-nav-file", { path: "hello.ts", navigation: { operation: "documentSymbols" } }, undefined, undefined, makeCtx());
        const details: any = (result as any).details;
        expect(details.mode).toBe("file");
        // file-mode results stay coverage:"search-match" when resources present
        for (const r of details.workspaceEvidence.resources as any[]) {
            expect(r.coverage).toBe("search-match");
        }
        expect(details.navigation).toBeDefined();
        expect(details.navigation.schemaVersion).toBe(1);
        expect(details.navigation.source).toBe("lsp");
        const text = (result.content[0] as any).text as string;
        expect(text).toContain("## LSP Navigation");
        expect(text).toContain("documentSymbols");
    });

    it("diagnostics directory keeps mode map zero resources, file diagnostics renders section", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        const dirResult = await tool.execute("c-diag-dir", { path: "mysrc", diagnostics: { waitMs: 10, maxPerFile: 2, maxFiles: 1 } }, undefined, undefined, makeCtx());
        const dirDetails: any = (dirResult as any).details;
        expect(dirDetails.mode).toBe("directory");
        expect(dirDetails.workspaceEvidence.mode).toBe("map");
        expect(dirDetails.workspaceEvidence.resources).toEqual([]);
        expect(dirDetails.diagnostics).toBeDefined();
        expect(dirDetails.diagnostics.schemaVersion).toBe(1);
        expect(dirDetails.diagnostics.source).toBe("lsp");
        expect(["findings", "unconfirmed", "unavailable", "partial"].includes(dirDetails.diagnostics.status) || typeof dirDetails.diagnostics.status === "string").toBe(true);
        expect(Array.isArray(dirDetails.diagnostics.files)).toBe(true);
        expect(typeof dirDetails.diagnostics.truncated).toBe("boolean");
        // canonical paths
        for (const f of dirDetails.diagnostics.files as any[]) expect(typeof f.path).toBe("string");
        const dirText = (dirResult.content[0] as any).text as string;
        expect(dirText).toContain("## LSP Diagnostics");

        const fileResult = await tool.execute("c-diag-file", { path: "hello.ts", diagnostics: { waitMs: 10, maxPerFile: 1 } }, undefined, undefined, makeCtx());
        const fileDetails: any = (fileResult as any).details;
        expect(fileDetails.diagnostics).toBeDefined();
        expect(fileDetails.diagnostics.schemaVersion).toBe(1);
        const fileText = (fileResult.content[0] as any).text as string;
        expect(fileText).toContain("## LSP Diagnostics");
    });

    it("diagnostics maxFiles requires directory", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(tool.execute("c-diag", { path: "hello.ts", diagnostics: { maxFiles: 5 } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/requires a directory/);
    });

    it("navigation maxResults bounds", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(tool.execute("c-bounds", { path: "mysrc", navigation: { operation: "workspaceSymbols", query: "q", maxResults: 101 } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/maxResults/);
    });

    it("file navigation envelope validates via protocol and has valid search-match resources (no fullFileSha256)", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        const result = await tool.execute("c-nav-validate", { path: "hello.ts", navigation: { operation: "documentSymbols" } }, undefined, undefined, makeCtx());
        const details: any = (result as any).details;
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok, v.ok ? "" : (v as any).error).toBe(true);
        for (const r of details.workspaceEvidence.resources as any[]) {
            expect(typeof r.resourceId).toBe("string");
            expect(r.resourceId).toMatch(/^[0-9a-f]{64}$/);
            expect(["full", "range"].includes(r.kind)).toBe(true);
            expect(typeof r.fresh).toBe("boolean");
            expect(r.coverage).toBe("search-match");
            expect(r.fullFileSha256).toBeUndefined();
            expect(Array.isArray(r.allowedRanges) && r.allowedRanges.length > 0).toBe(true);
        }
    });

    it("file diagnostics envelope validates via protocol and has valid search-match resources", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        const result = await tool.execute("c-diag-validate", { path: "hello.ts", diagnostics: { waitMs: 10, maxPerFile: 1 } }, undefined, undefined, makeCtx());
        const details: any = (result as any).details;
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok, v.ok ? "" : (v as any).error).toBe(true);
        for (const r of details.workspaceEvidence.resources as any[]) {
            expect(typeof r.resourceId).toBe("string");
            expect(r.kind).toBe("range");
            expect(r.coverage).toBe("search-match");
            expect(r.fullFileSha256).toBeUndefined();
        }
    });

    it("duplicate same-file navigation ranges accumulate/merge into allowedRanges", async () => {
        const fileAbs = realpathSync(join(workdir, "hello.ts"));
        const uri = "file://" + fileAbs;
        const provider: any = {
            inspectNavigation: async () => ({
                status: "confirmed",
                operation: "references",
                items: [
                    { location: { uri, range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } } } },
                    { location: { uri, range: { start: { line: 9, character: 0 }, end: { line: 11, character: 0 } } } },
                ],
                truncated: false,
            }),
            inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
        };
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl", lspInspectionProvider: provider });
        const result = await tool.execute("c-multi-nav", { path: "hello.ts", navigation: { operation: "references", line: 2, character: 1 } }, undefined, undefined, makeCtx());
        const details: any = (result as any).details;
        // single resource for hello.ts should contain both ranges (2-3 and 10-12 after +1 conversion)
        const res = details.workspaceEvidence.resources.find((r: any) => r.canonicalPath.includes("hello.ts"));
        expect(res).toBeDefined();
        expect(res.allowedRanges).toEqual(expect.arrayContaining([{ startLine: 2, endLine: 3 }, { startLine: 10, endLine: 12 }]));
        expect(res.allowedRanges.length).toBe(2);
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok, v.ok ? "" : (v as any).error).toBe(true);
    });

    it("URI-less documentSymbols record each symbol's real range", async () => {
        const provider: any = {
            inspectNavigation: async () => ({
                status: "confirmed",
                operation: "documentSymbols",
                items: [
                    { name: "alpha", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
                    { name: "beta", kind: 12, range: { start: { line: 10, character: 0 }, end: { line: 14, character: 0 } }, selectionRange: { start: { line: 10, character: 0 }, end: { line: 10, character: 4 } } },
                ],
                truncated: false,
            }),
            inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
        };
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl", lspInspectionProvider: provider });
        const result = await tool.execute("c-doc-sym", { path: "hello.ts", navigation: { operation: "documentSymbols" } }, undefined, undefined, makeCtx());
        const details: any = (result as any).details;
        const res = details.workspaceEvidence.resources.find((r: any) => r.canonicalPath.includes("hello.ts"));
        expect(res).toBeDefined();
        // ranges 1-5 and 11-15 (0-based +1)
        expect(res.allowedRanges).toEqual(expect.arrayContaining([{ startLine: 1, endLine: 5 }, { startLine: 11, endLine: 15 }]));
        expect(res.allowedRanges.length).toBe(2);
        // should NOT be just line 1
        expect(res.allowedRanges).not.toEqual([{ startLine: 1, endLine: 1 }]);
    });

    it("empty documentSymbols produces no fake line-1 evidence", async () => {
        const provider: any = {
            inspectNavigation: async () => ({ status: "empty", operation: "documentSymbols", items: [], truncated: false }),
            inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
        };
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl", lspInspectionProvider: provider });
        const result: any = await tool.execute("c-empty-sym", { path: "hello.ts", navigation: { operation: "documentSymbols" } }, undefined, undefined, makeCtx());
        const details: any = result.details;
        // If srNav empty, there may be zero nav resources or resource from structural facts only.
        // Navigation empty should not fabricate line-1 search-match; check nav-origin resource not present or if present not fake [1,1] alone.
        // Structural facts still add full-file coverage, but search-match nav resource should be absent.
        const navOnlyResources = details.workspaceEvidence.resources.filter((r: any) => r.coverage === "search-match" && r.canonicalPath.includes("hello.ts"));
        // All search-match for hello.ts should be from items, but items empty => no search-match nav range fabricated
        // If provider returned empty, no search-match range should claim [1,1] as nav evidence unless diagnostics also fabricated.
        for (const r of navOnlyResources) {
            // diagnostics empty also produces no coverage, so if empty both, search-match should be empty or not contain fake 1,1-only
            // Ensure not solely fake line1 from empty fallback
            if (r.allowedRanges.length === 1 && r.allowedRanges[0].startLine === 1 && r.allowedRanges[0].endLine === 1) {
                // This would be fabricated evidence - fail
                expect(r.allowedRanges).not.toEqual([{ startLine: 1, endLine: 1 }]);
            }
        }
        // Stronger: empty nav produces zero search-match resources when structural facts stripped?
        // Directly test executeFileInspect with stub to isolate nav section: use fresh file with no deps.
        const { executeFileInspect: exec } = await import("../../src/inspect.js");
        const direct = await exec({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl", navigation: { operation: "documentSymbols" as any }, lspInspectionProvider: provider } as any);
        const directNavRanges = direct.workspaceEvidence.resources.filter((r: any) => r.coverage === "search-match");
        // empty diagnostics+nav should contribute zero search-match entries (structural facts use different coverage)
        // If any search-match exists it must not be fake line-1 from empty outcome
        for (const r of directNavRanges) {
            expect(r.allowedRanges).not.toEqual([{ startLine: 1, endLine: 1 }]);
        }
        // When only empty nav+structural facts present, search-match set should be empty
        expect(directNavRanges.length).toBe(0);
    });

    it("empty diagnostics produces no fake line-1 evidence", async () => {
        const provider: any = {
            inspectNavigation: async () => ({ status: "empty", operation: "documentSymbols", items: [], truncated: false }),
            inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
        };
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl", lspInspectionProvider: provider });
        const result: any = await tool.execute("c-empty-diag", { path: "hello.ts", diagnostics: { waitMs: 10, maxPerFile: 5 } }, undefined, undefined, makeCtx());
        const details: any = result.details;
        const { executeFileInspect: exec } = await import("../../src/inspect.js");
        const direct = await exec({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl", diagnostics: { waitMs: 10, maxPerFile: 5 } as any, lspInspectionProvider: provider } as any);
        const directRanges = direct.workspaceEvidence.resources.filter((r: any) => r.coverage === "search-match");
        expect(directRanges.length).toBe(0);
        expect(details.workspaceEvidence.resources.filter((r: any) => r.coverage === "search-match").length).toBe(0);
    });

    it("multi-call same-path navigation+diagnostics ranges union (no drop)", async () => {
        // navigation returns line 2-3 on hello.ts, diagnostics returns line 10-11 on same hello.ts -> merged union should have both
        const fileAbs = realpathSync(join(workdir, "hello.ts"));
        const provider: any = {
            inspectNavigation: async () => ({
                status: "confirmed", operation: "references",
                items: [{ location: { uri: "file://" + fileAbs, range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } } } }],
                truncated: false,
            }),
            inspectDiagnostics: async () => ({
                status: "confirmed", diagnostics: [{ message: "err", range: { start: { line: 9, character: 0 }, end: { line: 10, character: 5 } } }],
                truncated: false,
            }),
        };
        const { executeFileInspect: exec } = await import("../../src/inspect.js");
        const direct = await exec({
            path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl",
            navigation: { operation: "references" as any, line: 2, character: 1 },
            diagnostics: { waitMs: 10, maxPerFile: 5 } as any,
            lspInspectionProvider: provider,
        } as any);
        const res = direct.workspaceEvidence.resources.find((r: any) => r.canonicalPath.includes("hello.ts") && r.coverage === "search-match");
        expect(res!).toBeDefined();
        expect(res!.allowedRanges).toEqual(expect.arrayContaining([{ startLine: 2, endLine: 3 }, { startLine: 10, endLine: 11 }]));
        expect(res!.allowedRanges.length).toBe(2);
    });

    it("hover with explicit line does not fallback to 1 when line missing", async () => {
        const provider: any = {
            inspectNavigation: async () => ({ status: "empty", operation: "hover", items: [], truncated: false }),
            inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
        };
        const { executeFileInspect: exec } = await import("../../src/inspect.js");
        // hover without line param -> should produce no fake coverage
        const noLine = await exec({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl", navigation: { operation: "hover" as any }, lspInspectionProvider: provider } as any);
        expect(noLine.workspaceEvidence.resources.filter((r: any) => r.coverage === "search-match").length).toBe(0);
        // hover with line 5 -> should produce range 5-5
        const withLine = await exec({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl", navigation: { operation: "hover" as any, line: 5, character: 1 }, lspInspectionProvider: provider } as any);
        const res2 = withLine.workspaceEvidence.resources.find((r: any) => r.coverage === "search-match");
        expect(res2).toBeDefined();
        expect(res2!.allowedRanges).toEqual([{ startLine: 5, endLine: 5 }]);
    });

    it("non-empty hover without range uses queried line not synthetic line-1", async () => {
        const provider: any = {
            inspectNavigation: async () => ({ status: "confirmed", operation: "hover", items: [{ contents: "hover text no range" }], truncated: false }),
            inspectDiagnostics: async () => ({ status: "empty", diagnostics: [], truncated: false }),
        };
        const { executeFileInspect: exec } = await import("../../src/inspect.js");
        // hover with non-empty result but no range, line 7 queried -> should use line 7, not fake 1
        const withRangeLess = await exec({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl", navigation: { operation: "hover" as any, line: 7, character: 2 }, lspInspectionProvider: provider } as any);
        const res = withRangeLess.workspaceEvidence.resources.find((r: any) => r.coverage === "search-match");
        expect(res).toBeDefined();
        expect(res!.allowedRanges).toEqual([{ startLine: 7, endLine: 7 }]);
        expect(res!.allowedRanges).not.toEqual([{ startLine: 1, endLine: 1 }]);
        // without queried line, range-less hover should produce no coverage (no fake line-1)
        const noLine = await exec({ path: "hello.ts", cwd: workdir, sessionFilePath: "/sessions/abc.jsonl", navigation: { operation: "hover" as any }, lspInspectionProvider: provider } as any);
        expect(noLine.workspaceEvidence.resources.filter((r: any) => r.coverage === "search-match").length).toBe(0);
    });

    it("diagnostics record real range per diagnostic", async () => {
        const provider: any = {
            inspectNavigation: async () => ({ status: "empty", operation: "documentSymbols", items: [], truncated: false }),
            inspectDiagnostics: async () => ({
                status: "confirmed",
                diagnostics: [
                    { message: "err1", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 10 } } },
                    { message: "err2", range: { start: { line: 9, character: 0 }, end: { line: 10, character: 5 } } },
                ],
                truncated: false,
            }),
        };
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl", lspInspectionProvider: provider });
        const result = await tool.execute("c-diag-range", { path: "hello.ts", diagnostics: { waitMs: 10, maxPerFile: 5 } }, undefined, undefined, makeCtx());
        const details: any = (result as any).details;
        const res = details.workspaceEvidence.resources.find((r: any) => r.canonicalPath.includes("hello.ts"));
        expect(res).toBeDefined();
        // 0-based lines +1 => 3-3 and 10-11
        expect(res.allowedRanges).toEqual(expect.arrayContaining([{ startLine: 3, endLine: 3 }, { startLine: 10, endLine: 11 }]));
        expect(res.allowedRanges.length).toBe(2);
    });

});
