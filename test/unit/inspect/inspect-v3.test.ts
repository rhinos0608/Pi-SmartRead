/**
 * Ported inspect v3 → v4 tests.
 *
 * - resolveInspectV4Mode dispatches correctly from filesystem
 * - executeInspectV4 directory/file modes
 * - Migration errors for legacy params
 * - createInspectV4Tool schema and execute
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    resolveInspectV4Mode,
    executeInspectV4,
} from "../../src/inspect.js";
import { createInspectV4Tool } from "../../src/inspect-tool.js";
import {
    validateInspectionEnvelope,
} from "@rhinos0608/pi-workspace-protocol";

let workdir: string;
let file: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "inspect-v3-")));
    mkdirSync(workdir, { recursive: true });
    file = join(workdir, "hello.ts");
    writeFileSync(
        file,
        "alpha\nbeta\ngamma\ndelta\nrefreshToken = 'abc123'\n",
        "utf8",
    );
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("resolveInspectV4Mode", () => {
    it("returns 'directory' for a directory path", () => {
        expect(resolveInspectV4Mode({ path: workdir, cwd: workdir, sessionFilePath: "/s.jsonl" })).toBe("directory");
    });

    it("returns 'file' for a file path", () => {
        expect(resolveInspectV4Mode({ path: "hello.ts", cwd: workdir, sessionFilePath: "/s.jsonl" })).toBe("file");
    });

    it("throws for nonexistent path", () => {
        expect(() => resolveInspectV4Mode({ path: "nope.ts", cwd: workdir, sessionFilePath: "/s.jsonl" })).toThrow();
    });
});

describe("executeInspectV4 (modes)", () => {
    it("directory mode produces envelope with mode='map' and zero resources", async () => {
        const details = await executeInspectV4({
            path: ".",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.mode).toBe("directory");
        expect(details.workspaceEvidence.mode).toBe("map");
        expect(details.workspaceEvidence.resources).toEqual([]);
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok).toBe(true);
    });

    it("file mode produces envelope with mode='file'", async () => {
        const details = await executeInspectV4({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.mode).toBe("file");
        expect(details.workspaceEvidence.mode).toBe("symbol");
        expect(details.workspaceEvidence.schemaVersion).toBe(3);
        expect(details.workspaceEvidence.inspectionId).toMatch(/^[0-9a-f]{64}$/);
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

    it("rejects legacy query param with migration error", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(
            tool.execute("q1", { query: "refreshToken" } as any, undefined, undefined, { cwd: workdir } as any),
        ).rejects.toThrow(/grep/);
    });

    it("rejects legacy symbol param with migration error", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(
            tool.execute("s1", { symbol: "hello" } as any, undefined, undefined, { cwd: workdir } as any),
        ).rejects.toThrow(/symbol/);
    });

    it("rejects legacy action param with migration error", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/abc.jsonl" });
        await expect(
            tool.execute("a1", { action: "map" } as any, undefined, undefined, { cwd: workdir } as any),
        ).rejects.toThrow(/action/);
    });
});

describe("createInspectV4Tool (schema)", () => {
    function makeCtx(): any {
        return { cwd: workdir, sessionManager: undefined };
    }

    it("registers with the name 'inspect'", () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => null });
        expect(tool.name).toBe("inspect");
    });

    it("exposes path param and not query/symbol/action", () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => null });
        const schema = tool.parameters as Record<string, any>;
        const props = schema.properties ?? schema;
        expect(props.path).toBeDefined();
        for (const k of ["query", "symbol", "action"]) {
            expect(props[k]).toBeUndefined();
        }
    });

    it("description mentions structural facts and signals", () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => null });
        expect(tool.description).toContain("structural facts");
        expect(tool.description).toContain("signals");
    });

    it("execute() rejects when no session file is available", async () => {
        const tool = createInspectV4Tool({ getSessionFilePath: () => null });
        await expect(
            tool.execute("c1", { path: "." }, undefined, undefined, makeCtx()),
        ).rejects.toThrow(/session/i);
    });

    it("execute() with directory publishes a zero-resource envelope", async () => {
        const published: any[] = [];
        const tool = createInspectV4Tool({
            getSessionFilePath: () => "/sessions/abc.jsonl",
            resolver: {
                publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
                    published.push({ envelope, sessionFilePath, workspaceRoot });
                },
            },
        });
        const result = await tool.execute("c1", { path: "." }, undefined, undefined, makeCtx());
        const details = (result as any).details;
        expect(details.mode).toBe("directory");
        expect(details.workspaceEvidence.resources).toEqual([]);
        expect(published).toHaveLength(1);
        expect(published[0].envelope.resources).toEqual([]);
    });

    it("execute() with file mode returns file-mode envelope", async () => {
        const tool = createInspectV4Tool({
            getSessionFilePath: () => "/sessions/abc.jsonl",
        });
        const result = await tool.execute("c1", { path: "hello.ts" }, undefined, undefined, makeCtx());
        const details = (result as any).details;
        expect(details.mode).toBe("file");
        expect(details.workspaceEvidence.mode).toBe("symbol");
    });
});
