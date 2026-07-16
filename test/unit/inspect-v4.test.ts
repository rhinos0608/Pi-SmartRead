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
        expect(result.contentText).toContain("Callers (0)");
        expect(result.contentText).toContain("Children (0)");
        expect(result.contentText).toContain("Base Classes / Interfaces");
        expect(result.contentText).toContain("Overrides");
        expect(result.contentText).toContain("Re-Exported By (0)");
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
});
