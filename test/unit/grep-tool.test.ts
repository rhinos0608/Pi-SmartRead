/**
 * Tests for the wrapped grep tool (P4).
 *
 * Covers: literal mode, smart cascade (BM25 + symbol), RRF fusion,
 * dedup, evidence envelope validity, truncation, limit clamping.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { createGrepTool, type GrepToolOptions } from "../../src/grep-tool.js";
import { disposeSemanticIndexes } from "../../src/semantic-index-registry.js";

function makeCtx(cwd: string) {
    return { cwd } as any;
}

function makeOpts(overrides?: Partial<GrepToolOptions>): GrepToolOptions {
    return {
        getSessionFilePath: () => "/sessions/test-session.jsonl",
        ...overrides,
    };
}

let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-tool-")));
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(
        join(workdir, "src", "auth.ts"),
        [
            "export function authenticate(req: Request, res: Response) {",
            "  const token = req.headers.authorization;",
            "  return validateToken(token);",
            "}",
            "",
            "export function validateToken(token: string): TokenPayload | null {",
            "  return { sub: 'user1' };",
            "}",
        ].join("\n"),
        "utf8",
    );
    writeFileSync(
        join(workdir, "src", "tokens.ts"),
        [
            "export interface TokenPayload {",
            "  sub: string;",
            "}",
            "",
            "export function createToken(payload: TokenPayload): string {",
            "  return JSON.stringify(payload);",
            "}",
        ].join("\n"),
        "utf8",
    );
    writeFileSync(
        join(workdir, "src", "db.ts"),
        [
            "export const DATABASE_URL = 'postgres://localhost/auth';",
            "export function connectDatabase() { return {}; }",
        ].join("\n"),
        "utf8",
    );
    // A large file with many named functions to test truncation
    const manyFns = Array.from({ length: 30 }, (_, i) =>
        `export function handler${i}(req: Request) { return ${i}; }`,
    ).join("\n");
    writeFileSync(join(workdir, "src", "handlers.ts"), manyFns, "utf8");
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});

// ── Literal mode ────────────────────────────────────────────────────

describe("grep tool — literal mode", () => {
    it("returns lexical matches for a known pattern", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t1",
            { pattern: "authenticate" },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("authenticate");
        expect(text).toContain("src/auth.ts");
        expect((result.details as any).truncated).toBe(false);
    });

    it("literal mode uses lexical grep directly", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-lit",
            { pattern: "DATABASE_URL", literal: true },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("DATABASE_URL");
        expect(text).toContain("src/db.ts");
        expect((result.details as any).engines).toEqual(["lexical"]);
    });
});

// ── WP-2: graphFilter schema ───────────────────────────────────────

describe("grep tool — graphFilter schema (WP-2)", () => {
    it("accepts valid graphFilter param in schema", () => {
        const tool = createGrepTool(makeOpts());
        const schema = tool.parameters as any;
        expect(schema.properties.graphFilter).toBeDefined();
        expect(schema.properties.graphFilter.type).toBe("string");
    });

    it("graphFilter is optional in schema", () => {
        const tool = createGrepTool(makeOpts());
        const schema = tool.parameters as any;
        // graphFilter should not be in required array
        const required: string[] = schema.required ?? [];
        expect(required).not.toContain("graphFilter");
    });

    it("graphFilter description mentions EDGE_TYPE->target format", () => {
        const tool = createGrepTool(makeOpts());
        const schema = tool.parameters as any;
        const desc = schema.properties.graphFilter.description;
        expect(desc).toContain("EDGE_TYPE->target");
        expect(desc).toContain("CALLS");
        expect(desc).toContain("IMPORTED_BY");
    });
});

// ── Non-literal / cascade ───────────────────────────────────────────

describe("grep tool — non-literal cascade", () => {
    it("finds known symbol via AST layer when no semantic index", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t2",
            { pattern: "validateToken" },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("validateToken");
        // Should have at least symbol engine
        const engines = (result.details as any).engines as string[];
        expect(engines).toContain("symbol");
    });

    it("returns valid evidence envelope with mode='query'", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t3",
            { pattern: "authenticate" },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const env = (result.details as any).workspaceEvidence;
        expect(env).toBeDefined();
        expect(env.mode).toBe("query");
        expect(env.schemaVersion).toBe(3);
        const v = validateInspectionEnvelope(env);
        expect(v.ok).toBe(true);
    });

    it("evidence resources have coverage 'search-match'", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t4",
            { pattern: "authenticate" },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const env = (result.details as any).workspaceEvidence;
        expect(env.resources.length).toBeGreaterThan(0);
        for (const r of env.resources) {
            expect(r.coverage).toBe("search-match");
            expect(r.kind).toBe("range");
            expect(Array.isArray(r.allowedRanges)).toBe(true);
            expect(r.allowedRanges.length).toBeGreaterThan(0);
        }
    });

    it("resources deduplicated by path with merged ranges", async () => {
        const tool = createGrepTool(makeOpts());
        // Search for "export" which appears on multiple lines in auth.ts
        const result = await tool.execute(
            "t-dedup",
            { pattern: "export", literal: true },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const env = (result.details as any).workspaceEvidence;
        // auth.ts has multiple "export" lines — should be merged into one resource
        const authResources = env.resources.filter(
            (r: any) => typeof r.canonicalPath === "string" && r.canonicalPath.includes("auth.ts"),
        );
        expect(authResources.length).toBe(1);
        expect(authResources[0].allowedRanges.length).toBeGreaterThanOrEqual(2);
    });
});

// ── Zero hits + fallback ────────────────────────────────────────────

describe("grep tool — zero-hit fallback chain", () => {
    it("falls back to lexical grep when no layers match", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-zero",
            { pattern: "nonexistent_xyz123_impossible", literal: true },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        expect(details.totalHits).toBe(0);
        // Evidence envelope still valid even with zero hits (query mode allows empty)
        expect(validateInspectionEnvelope(details.workspaceEvidence).ok).toBe(true);
    });
});

// ── Limit clamping ──────────────────────────────────────────────────

describe("grep tool — limit clamping", () => {
    it("clamps limit to valid range", async () => {
        const tool = createGrepTool(makeOpts());
        // limit=0 should clamp to 1
        const result = await tool.execute(
            "t-clamp0",
            { pattern: "export", literal: true, limit: 0 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        expect(details.shownHits).toBeGreaterThanOrEqual(1);
    });

    it("clamps very high limit to 100", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-clamp100",
            { pattern: "export", literal: true, limit: 999 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        expect(details.shownHits).toBeLessThanOrEqual(100);
    });
});

// ── Truncation ──────────────────────────────────────────────────────

describe("grep tool — truncation", () => {
    it("sets truncated flag when totalHits exceeds limit", async () => {
        const tool = createGrepTool(makeOpts());
        // Non-literal cascade: symbol layer scans with bigK=topK*2,
        // so fused can have more hits than the display limit.
        const result = await tool.execute(
            "t-trunc",
            { pattern: "handler", limit: 3 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        // The symbol scan finds handler symbols in handlers.ts (up to bigK=6),
        // then we slice to limit=3 for display.
        expect(details.shownHits).toBe(3);
        // If symbol search found >3 unique symbols, truncation fires.
        if (details.totalHits > 3) {
            expect(details.truncated).toBe(true);
            const text = (result.content[0] as { text: string }).text;
            expect(text).toContain("truncated");
        }
    });
});

// ── IgnoreCase ──────────────────────────────────────────────────────

describe("grep tool — ignoreCase", () => {
    it("case-insensitive search finds mixed-case hits", async () => {
        const tool = createGrepTool(makeOpts());
        const { content } = await tool.execute(
            "t-ic",
            { pattern: "DATABASE_URL", ignoreCase: true, literal: true },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        expect((content[0] as { text: string }).text).toContain("DATABASE_URL");
    });
});

// ── Context lines ───────────────────────────────────────────────────

describe("grep tool — contextLines", () => {
    it("zero contextLines still returns matches", async () => {
        const tool = createGrepTool(makeOpts());
        const { content } = await tool.execute(
            "t-ctx0",
            { pattern: "connectDatabase", literal: true, contextLines: 0 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        expect((content[0] as { text: string }).text).toContain("connectDatabase");
    });
});

// ── Evidence envelope (zero hits) ───────────────────────────────────

describe("grep tool — evidence with zero hits", () => {
    it("produces valid envelope even with no matches", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-env0",
            { pattern: "zzz_no_match_zzz", literal: true },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const env = (result.details as any).workspaceEvidence;
        expect(env.mode).toBe("query");
        expect(env.resources).toEqual([]);
        expect(validateInspectionEnvelope(env).ok).toBe(true);
    });
});

// ── Resolver publish ────────────────────────────────────────────────

describe("grep tool — resolver publish", () => {
    it("calls publishInspection when resolver is provided", async () => {
        let published = false;
        let publishedEnvelope: any = null;
        const tool = createGrepTool({
            getSessionFilePath: () => "/sessions/test.jsonl",
            resolver: {
                publishInspection(envelope: unknown, _sp: string, _wr: string) {
                    published = true;
                    publishedEnvelope = envelope;
                },
            },
        });
        await tool.execute(
            "t-pub",
            { pattern: "authenticate", literal: true },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        expect(published).toBe(true);
        expect(publishedEnvelope).toBeDefined();
        expect(publishedEnvelope.mode).toBe("query");
    });
});

// ── WP-5: graphFilter wiring ─────────────────────────────────────

describe("grep tool — graphFilter wiring (WP-5)", () => {
    it("throws when graphFilter is provided but no contextGraph", async () => {
        const tool = createGrepTool(makeOpts());
        await expect(
            tool.execute(
                "t-gf-no-graph",
                { pattern: "authenticate", graphFilter: "CALLS->auth.login" },
                undefined,
                undefined,
                makeCtx(workdir),
            ),
        ).rejects.toThrow("graphFilter requires an indexed context graph");
    });

    it("rejects invalid graphFilter format with spec error", async () => {
        const { ContextGraph } = await import("../../src/context-graph.js");
        const graph = new ContextGraph(workdir);
        const tool = createGrepTool(makeOpts({ contextGraph: graph }));
        // Invalid edge type "INVALID" should throw spec error
        await expect(
            tool.execute(
                "t-gf-invalid",
                { pattern: "authenticate", graphFilter: "INVALID->target" },
                undefined,
                undefined,
                makeCtx(workdir),
            ),
        ).rejects.toThrow('Invalid graphFilter: expected "EDGE_TYPE->target" format');
    });

    it("contextGraph is accepted as a valid option", async () => {
        const { ContextGraph } = await import("../../src/context-graph.js");
        const graph = new ContextGraph(workdir);
        // Add a file that imports auth.ts so graphFilter has an edge to check
        writeFileSync(
            join(workdir, "src", "importer.ts"),
            [
                'import { authenticate } from "./auth";',
                "export function useAuth() {",
                "  return authenticate;",
                "}",
            ].join("\n"),
            "utf8",
        );
        // Build the context graph so import edges are populated for filtering
        await graph.buildContextGraph();
        const tool = createGrepTool(makeOpts({ contextGraph: graph }));
        expect(tool).toBeDefined();

        // Execute with graphFilter; only importer.ts imports auth.ts → survives filter
        const result = await tool.execute(
            "t-gf-exec",
            { pattern: "authenticate", literal: true, graphFilter: "IMPORTED_BY->src/auth.ts", limit: 10 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        const resources = details.workspaceEvidence.resources;
        expect(resources).toHaveLength(1);
        expect(resources[0].canonicalPath).toContain("importer.ts");
    });
});
