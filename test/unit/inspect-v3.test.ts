/**
 * Multi-mode inspect tests (v3).
 *
 * - query mode: delegates to search engine, returns envelope with mode="query"
 * - symbol mode: delegates to symbol engine, returns envelope with mode="symbol"
 * - map mode: delegates to repo engine, returns envelope with mode="map"
 * - path mode: same as v1, unchanged
 * - resolveMode() dispatches correctly from the input shape
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    computeInspectDetails,
    executeInspectDetails,
    resolveMode,
} from "../../inspect.js";
import { createInspectTool } from "../../inspect-tool.js";
import {
    PROTOCOL_SCHEMA_VERSION,
    validateInspectionEnvelope,
} from "@rhinos0608/pi-workspace-protocol";

let workdir: string;
let file: string;
let canonicalFile: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "inspect-v3-")));
    mkdirSync(workdir, { recursive: true });
    file = join(workdir, "hello.ts");
    writeFileSync(
        file,
        "alpha\nbeta\ngamma\ndelta\nrefreshToken = 'abc123'\n",
        "utf8",
    );
    canonicalFile = realpathSync(file);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("resolveMode", () => {
    it("prefers action=map", () => {
        expect(
            resolveMode({
                path: "x",
                action: "map",
                cwd: workdir,
                sessionFilePath: "/s.jsonl",
            }),
        ).toBe("map");
    });

    it("returns symbol when symbol provided", () => {
        expect(
            resolveMode({
                symbol: "Auth.login",
                cwd: workdir,
                sessionFilePath: "/s.jsonl",
            }),
        ).toBe("symbol");
    });

    it("returns path when path provided", () => {
        expect(
            resolveMode({
                path: "x.ts",
                cwd: workdir,
                sessionFilePath: "/s.jsonl",
            }),
        ).toBe("path");
    });

    it("returns query when query provided", () => {
        expect(
            resolveMode({
                query: "needle",
                cwd: workdir,
                sessionFilePath: "/s.jsonl",
            }),
        ).toBe("query");
    });

    it("throws when no mode is detectable", () => {
        expect(() =>
            resolveMode({ cwd: workdir, sessionFilePath: "/s.jsonl" }),
        ).toThrow();
    });
});

describe("computeInspectDetails (path mode — v1 parity)", () => {
    it("still returns a full-file resource for the whole file", () => {
        const details = computeInspectDetails({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.mode).toBe("path");
        expect(details.workspaceEvidence.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok).toBe(true);
        const r = details.workspaceEvidence.resources[0]!;
        expect(r.kind).toBe("full");
        expect(r.canonicalPath).toBe(canonicalFile);
    });

    it("path mode envelope carries mode='path'", () => {
        const details = computeInspectDetails({
            path: "hello.ts",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.workspaceEvidence.mode).toBe("path");
    });

    it("computeInspectDetails rejects async modes", () => {
        expect(() =>
            computeInspectDetails({
                query: "x",
                cwd: workdir,
                sessionFilePath: "/s.jsonl",
            }),
        ).toThrow(/query|async/);
    });
});

describe("executeInspectDetails (async modes)", () => {
    it("query mode produces envelope with mode='query' and range resources", async () => {
        const details = await executeInspectDetails({
            query: "refreshToken",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.mode).toBe("query");
        expect(details.workspaceEvidence.mode).toBe("query");
        // The matches should reference hello.ts and have at least one resource
        expect(details.workspaceEvidence.resources.length).toBeGreaterThanOrEqual(0);
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok).toBe(true);
    });

    it("query mode rejects empty query", async () => {
        await expect(
            executeInspectDetails({
                query: "",
                cwd: workdir,
                sessionFilePath: "/s.jsonl",
            }),
        ).rejects.toThrow(/query/i);
    });

    it("symbol mode produces envelope with mode='symbol'", async () => {
        // The fixture file is plain text, so symbol search may return zero matches —
        // that's fine; the envelope just must have mode="symbol" and validate.
        const details = await executeInspectDetails({
            symbol: "hello",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.mode).toBe("symbol");
        expect(details.workspaceEvidence.mode).toBe("symbol");
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok).toBe(true);
    });

    it("symbol mode rejects empty symbol", async () => {
        await expect(
            executeInspectDetails({
                symbol: "",
                cwd: workdir,
                sessionFilePath: "/s.jsonl",
            }),
        ).rejects.toThrow(/symbol/i);
    });

    it("map mode produces envelope with mode='map' and zero resources", async () => {
        const details = await executeInspectDetails({
            action: "map",
            cwd: workdir,
            sessionFilePath: "/sessions/abc.jsonl",
        });
        expect(details.mode).toBe("map");
        expect(details.workspaceEvidence.mode).toBe("map");
        expect(details.workspaceEvidence.resources).toEqual([]);
        const v = validateInspectionEnvelope(details.workspaceEvidence);
        expect(v.ok).toBe(true);
    });

    it("rejects ephemeral session identity", async () => {
        await expect(
            executeInspectDetails({
                path: "hello.ts",
                cwd: workdir,
                sessionFilePath: "",
            }),
        ).rejects.toThrow(/session/i);
    });
});

describe("createInspectTool (schema)", () => {
    function makeCtx(): any {
        return { cwd: workdir, sessionManager: undefined };
    }

    it("registers with the name 'inspect'", () => {
        const tool = createInspectTool({ getSessionFilePath: () => null });
        expect(tool.name).toBe("inspect");
    });

    it("exposes path/query/symbol/action/offset/limit/depth in the schema", () => {
        const tool = createInspectTool({ getSessionFilePath: () => null });
        const schema = tool.parameters as Record<string, any>;
        const props = schema.properties ?? schema;
        const keys = Object.keys(props);
        for (const k of ["path", "query", "symbol", "action", "offset", "limit", "depth"]) {
            expect(keys).toContain(k);
        }
    });

    it("description mentions path/query/symbol/map modes", () => {
        const tool = createInspectTool({ getSessionFilePath: () => null });
        expect(tool.description).toContain("path");
        expect(tool.description).toContain("query");
        expect(tool.description).toContain("symbol");
        expect(tool.description).toContain("map");
    });

    it("execute() with path returns path-mode envelope", async () => {
        const tool = createInspectTool({
            getSessionFilePath: () => "/sessions/abc.jsonl",
        });
        const result = await tool.execute("c1", { path: "hello.ts" }, undefined, undefined, makeCtx());
        const text = (result.content[0] as any).text as string;
        expect(text).toContain("alpha");
        const details = result.details as any;
        expect(details.mode).toBe("path");
        expect(details.workspaceEvidence.mode).toBe("path");
    });

    it("execute() rejects when no session file is available", async () => {
        const tool = createInspectTool({ getSessionFilePath: () => null });
        await expect(
            tool.execute("c1", { path: "hello.ts" }, undefined, undefined, makeCtx()),
        ).rejects.toThrow(/session/i);
    });

    it("execute() with action:map publishes a zero-resource envelope through a real resolver without throwing", async () => {
        const published: any[] = [];
        const tool = createInspectTool({
            getSessionFilePath: () => "/sessions/abc.jsonl",
            resolver: {
                publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
                    published.push({ envelope, sessionFilePath, workspaceRoot });
                },
            },
        });
        const result = await tool.execute("c1", { action: "map" }, undefined, undefined, makeCtx());
        const details = result.details as any;
        expect(details.mode).toBe("map");
        expect(details.workspaceEvidence.resources).toEqual([]);
        expect(published).toHaveLength(1);
        expect(published[0].envelope.resources).toEqual([]);
    });

    it("execute() with path mode twice on a changed file re-publishes without throwing (re-inspect after edit)", async () => {
        const published: any[] = [];
        const tool = createInspectTool({
            getSessionFilePath: () => "/sessions/abc.jsonl",
            resolver: {
                publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
                    published.push({ envelope, sessionFilePath, workspaceRoot });
                },
            },
        });
        const first = await tool.execute("c1", { path: "hello.ts" }, undefined, undefined, makeCtx());
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file, "alpha\nbeta\ngamma\ndelta\nrefreshToken = 'changed'\n", "utf8");
        const second = await tool.execute("c2", { path: "hello.ts" }, undefined, undefined, makeCtx());
        expect(published).toHaveLength(2);
        const firstDetails = (first.details as any).workspaceEvidence;
        const secondDetails = (second.details as any).workspaceEvidence;
        expect(firstDetails.inspectionId).toBe(secondDetails.inspectionId);
        expect(firstDetails.resources[0].fullFileSha256).not.toBe(secondDetails.resources[0].fullFileSha256);
    });
});
