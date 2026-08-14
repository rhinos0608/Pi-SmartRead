/**
 * Tests for the wrapped grep tool (P4).
 *
 * Covers: literal mode, smart cascade (BM25 + symbol), RRF fusion,
 * dedup, evidence envelope validity, truncation, limit clamping.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { createGrepTool, type GrepToolOptions, _resetBm25CorpusCacheForTests, _bm25CorpusCacheForTests, _bm25CacheBenchmark } from "../../src/grep-tool.js";
import { disposeSemanticIndexes, getOrCreateSemanticIndex } from "../../src/semantic-index-registry.js";

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

    it("searches regex alternation within a file path", async () => {
        writeFileSync(
            join(workdir, "src", "index.ts"),
            "registerTool(browserTool);\nregisterTool(fetchTool);\n",
            "utf8",
        );
        const result = await createGrepTool(makeOpts()).execute(
            "t-regex-file",
            { pattern: "browser|registerTool", path: "src/index.ts" },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("src/index.ts");
        expect(text).toContain("registerTool(browserTool)");
        expect(text).not.toContain("src/auth.ts");
        expect((result.details as any).engines).toEqual(["regex"]);
    });

    it("searches ordinary text within an absolute file path", async () => {
        const indexPath = join(workdir, "src", "index.ts");
        writeFileSync(indexPath, "registerTool(browserTool);\n", "utf8");
        const result = await createGrepTool(makeOpts()).execute(
            "t-text-absolute-file",
            { pattern: "registerTool", path: indexPath },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("src/index.ts");
        expect(text).toContain("registerTool(browserTool)");
        // Scoped to a single file: exact phrase plus in-memory BM25 both match.
        expect((result.details as any).engines).toEqual(["lexical", "bm25"]);
    });

    it("auto-detects regex alternation for directory searches", async () => {
        const result = await createGrepTool(makeOpts()).execute(
            "t-regex-directory",
            { pattern: "DATABASE_URL|validateToken", path: "src" },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("src/auth.ts");
        expect(text).toContain("src/db.ts");
        expect((result.details as any).engines).toEqual(["regex"]);
    });

    it("treats regex metacharacters literally when literal is true", async () => {
        writeFileSync(join(workdir, "src", "patterns.txt"), "browser|registerTool\nbrowser\n", "utf8");
        const result = await createGrepTool(makeOpts()).execute(
            "t-regex-literal-override",
            { pattern: "browser|registerTool", path: "src/patterns.txt", literal: true },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        expect((result.details as any).totalHits).toBe(1);
        expect((result.details as any).engines).toEqual(["lexical"]);
    });
});

// ── Batch queries ──────────────────────────────────────────────────

describe("grep tool — batch queries", () => {
    it("exposes a bounded queries array of full search objects", () => {
        const schema = createGrepTool(makeOpts()).parameters as any;
        expect(schema.properties.queries.type).toBe("array");
        expect(schema.properties.queries.minItems).toBe(1);
        expect(schema.properties.queries.maxItems).toBe(10);
        expect(schema.properties.queries.items.required).toContain("pattern");
        expect(schema.properties.queries.items.properties.graphFilter).toBeDefined();
    });

    it("runs multiple full query objects in one call", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-batch",
            {
                queries: [
                    { pattern: "DATABASE_URL", literal: true },
                    { pattern: "validateToken" },
                ],
            },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('Query 1: "DATABASE_URL"');
        expect(text).toContain('Query 2: "validateToken"');
        expect(text).toContain("src/db.ts");
        expect(text).toContain("src/auth.ts");

        const details = result.details as any;
        expect(details.queryResults).toHaveLength(2);
        expect(details.queryResults[0].pattern).toBe("DATABASE_URL");
        expect(details.queryResults[1].pattern).toBe("validateToken");
        expect(validateInspectionEnvelope(details.workspaceEvidence).ok).toBe(true);
        // db.ts (query 1 literal) + auth.ts + tokens.ts (query 2: exact/symbol
        // plus in-memory BM25 also surfacing the token-bearing tokens.ts).
        expect(details.workspaceEvidence.resources).toHaveLength(3);
    });

    it("requires exactly one search mode and bounds direct execute calls", async () => {
        const tool = createGrepTool(makeOpts());
        const execute = (params: any) => tool.execute("t-batch-invalid", params, undefined, undefined, makeCtx(workdir));

        await expect(execute({ pattern: "auth", queries: [{ pattern: "token" }] }))
            .rejects.toThrow("Provide exactly one of: pattern or queries");
        await expect(execute({ queries: [] }))
            .rejects.toThrow("queries must contain between 1 and 10 search objects");
        await expect(execute({ queries: Array.from({ length: 11 }, () => ({ pattern: "auth" })) }))
            .rejects.toThrow("queries must contain between 1 and 10 search objects");
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
    it("combines exact lexical, BM25, and AST symbol search while the semantic index is unbuilt", async () => {
        const index = getOrCreateSemanticIndex(workdir, {
            config: {
                baseUrl: "http://localhost:11434/v1",
                model: "test-model",
                chunkSizeChars: 4096,
                chunkOverlapChars: 0,
                maxChunksPerFile: 12,
            },
        });
        expect(index.isAvailable()).toBe(false);

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
        // No semantic index: exact lexical + in-memory BM25 + AST symbol are combined.
        expect((result.details as any).engines).toEqual(["lexical", "bm25", "symbol"]);
    });

    it("returns a BM25 result for a token-overlap query with no exact phrase (no semantic index)", async () => {
        // "revenue total" never appears as a contiguous substring; only the
        // tokens total/revenue exist inside totalRevenue. Exact lexical and AST
        // symbol find nothing, so the in-memory BM25 ranker must surface it.
        writeFileSync(
            join(workdir, "src", "orders.ts"),
            [
                "export function totalRevenue(orders: Order[]): number {",
                "  return orders.reduce((sum, o) => sum + o.total, 0);",
                "}",
            ].join("\n"),
            "utf8",
        );

        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-bm25-fallback",
            { pattern: "revenue total" },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        const details = result.details as any;
        expect(details.engines).toContain("bm25");
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("src/orders.ts");
    });

    it("returns AST symbol hits even when the exact substring is absent (no semantic index)", async () => {
    // The queried symbol is a qualified name ("Calculator.computeTotal") that
    // the AST matcher resolves via the class name path, but the exact literal
    // never appears in the file — lexical search cannot match it.
    writeFileSync(
      join(workdir, "src", "service.ts"),
      [
        "export class Calculator {",
        "  computeTotal(items: number[]): number {",
        "    return items.reduce((a, b) => a + b, 0);",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );
    const tool = createGrepTool(makeOpts());
    const result = await tool.execute(
      "t-symbol-only",
      { pattern: "Calculator.computeTotal" },
      undefined,
      undefined,
      makeCtx(workdir),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("computeTotal");
    expect(text).toContain("src/service.ts");
    expect((result.details as any).engines).toContain("symbol");
    // The exact literal "Calculator.computeTotal" is absent from the file, so
    // the lexical engine must not have provided the result.
    expect((result.details as any).engines).not.toContain("lexical");
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

// ── Semantic fallback ──────────────────────────────────────────────

describe("grep tool — semantic fallback", () => {
    it("uses embeddings only after lexical and symbol search return no hits", async () => {
        const embed = vi.fn(async (request: { inputs: string[] }) => ({
            vectors: request.inputs.map((input) => {
                if (/identity proof|authenticate|validateToken/i.test(input)) return [1, 0, 0];
                if (/database|connectDatabase|DATABASE_URL/i.test(input)) return [0, 1, 0];
                return [0, 0, 1];
            }),
        }));
        const index = getOrCreateSemanticIndex(workdir, {
            config: {
                baseUrl: "http://localhost:11434/v1",
                model: "test-model",
                chunkSizeChars: 4096,
                chunkOverlapChars: 0,
                maxChunksPerFile: 12,
            },
            fetchEmbeddings: embed as never,
        });
        await index.updateIndex();
        embed.mockClear();

        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-semantic-fallback",
            { pattern: "identity proof" },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        const details = result.details as any;
        const text = (result.content[0] as { text: string }).text;
        expect(details.engines).toEqual(["semantic"]);
        expect(details.totalHits).toBe(1);
        expect(embed).toHaveBeenCalledTimes(1);
        expect(embed.mock.calls[0]?.[0].inputs).toEqual(["identity proof"]);
        expect(text).toContain("src/auth.ts");
        expect(text).not.toContain("src/db.ts");
    });

    it("keeps exact raw matches ahead of partial BM25 matches", async () => {
        const embed = vi.fn(async (request: { inputs: string[] }) => ({
            vectors: request.inputs.map(() => [0, 0, 1]),
        }));
        const index = getOrCreateSemanticIndex(workdir, {
            config: {
                baseUrl: "http://localhost:11434/v1",
                model: "test-model",
                chunkSizeChars: 4096,
                chunkOverlapChars: 0,
                maxChunksPerFile: 12,
            },
            fetchEmbeddings: embed as never,
        });
        await index.updateIndex();
        writeFileSync(
            join(workdir, "src", "payment.ts"),
            "export const marker = 'processPayment_special_string';\n",
            "utf8",
        );

        const result = await createGrepTool(makeOpts()).execute(
            "t-exact-over-bm25",
            { pattern: "processPayment_special_string", limit: 1 },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        const details = result.details as any;
        const text = (result.content[0] as { text: string }).text;
        expect(details.engines).toContain("lexical");
        expect(text).toContain("src/payment.ts");
    });

    it("prefers an exact raw match from a file missing in the semantic index", async () => {
        const embed = vi.fn(async (request: { inputs: string[] }) => ({
            vectors: request.inputs.map(() => [0, 0, 1]),
        }));
        const index = getOrCreateSemanticIndex(workdir, {
            config: {
                baseUrl: "http://localhost:11434/v1",
                model: "test-model",
                chunkSizeChars: 4096,
                chunkOverlapChars: 0,
                maxChunksPerFile: 12,
            },
            fetchEmbeddings: embed as never,
        });
        await index.updateIndex();
        writeFileSync(
            join(workdir, "src", "payment.ts"),
            "export const marker = 'quuxZorb987654';\n",
            "utf8",
        );

        const result = await createGrepTool(makeOpts()).execute(
            "t-stale-index-lexical",
            { pattern: "quuxZorb987654" },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        const details = result.details as any;
        const text = (result.content[0] as { text: string }).text;
        expect(details.engines).toEqual(["lexical-passthrough"]);
        expect(text).toContain("src/payment.ts");
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

    it("awaits an async contextGraph getter before applying graphFilter (runtime wiring)", async () => {
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
        let built = false;
        let getterRoot: string | undefined;
        // Simulate the runtime DI: an async getter that builds the shared graph
        // (with call graph) — the tool must await it before graphFilter.
        const { ContextGraph } = await import("../../src/context-graph.js");
        const tool = createGrepTool(makeOpts({
            contextGraph: async (root) => {
                getterRoot = root;
                const graph = new ContextGraph(workdir);
                await graph.buildContextGraph({ includeCalls: true });
                built = true;
                return graph;
            },
        }));

        const result = await tool.execute(
            "t-gf-async",
            { pattern: "authenticate", literal: true, graphFilter: "IMPORTED_BY->src/auth.ts", limit: 10 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        expect(built).toBe(true);
        expect(getterRoot).toBe(workdir);
        const details = result.details as any;
        const resources = details.workspaceEvidence.resources;
        expect(resources).toHaveLength(1);
        expect(resources[0].canonicalPath).toContain("importer.ts");
    });
});

// ── Glob-aware retrieval ─────────────────────────────────────────
describe("grep tool — glob-aware retrieval", () => {
    it("constrains candidates before bounded topK so limit is filled with matching glob files", async () => {
        // 30 .ts + 30 .md, all contain "needle", interleaved alphabetically.
        for (let i = 0; i < 30; i++) {
            writeFileSync(join(workdir, "src", `f${i}.ts`), `export const needle${i} = 1; // needle\n`, "utf8");
            writeFileSync(join(workdir, "src", `f${i}.md`), `# doc ${i}\nneedle\n`, "utf8");
        }
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-glob",
            { pattern: "needle", literal: true, glob: "src/*.ts", limit: 20 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        // Glob pre-filter fills the bounded topK with .ts hits (not fewer).
        expect((result.details as any).shownHits).toBe(20);
        expect((result.details as any).totalHits).toBeGreaterThanOrEqual(20);
        expect(text).not.toContain(".md");
    });
});

// ── Explicit degradation reasons ─────────────────────────────────
describe("grep tool — explicit degradation reasons", () => {
    it("reports index_unavailable degradation when no semantic index is available", async () => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-deg",
            { pattern: "authenticate" },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        // No semantic index: exact lexical + in-memory BM25 + AST symbol are combined.
        expect((result.details as any).engines).toEqual(["lexical", "bm25", "symbol"]);
        // structured, non-secret degradation present.
        const degradation = (result.details as any).degradation;
        expect(Array.isArray(degradation)).toBe(true);
        expect(degradation.some((d: any) => d.code === "index_unavailable")).toBe(true);
    });
});

// ── graphFilter single-pass over-fetch ──────────────────────────
// N3 regression: when graphFilter is present, the gather loop requests the
// maximum candidate set in a single pass instead of re-running the corpus
// search per gather step. Counts applyGraphFilter invocations (one per loop
// iteration) via ESM live binding to prove the loop does not re-evaluate.
describe("grep tool — graphFilter single-pass over-fetch", () => {
    it("fetches the maximum candidate set in one pass when filtering starves hits below topK", async () => {
        // Seed a modest corpus so the search has candidates to gather.
        for (let i = 0; i < 12; i++) {
            writeFileSync(
                join(workdir, "src", `file_${String(i).padStart(2, "0")}.ts`),
                `export const token${i} = ${i};
`,
                "utf8",
            );
        }

        const { ContextGraph } = await import("../../src/context-graph.js");
        const graphFilterModule = await import("../../src/graph-filter.js");
        const graph = new ContextGraph(workdir);

        // Force a filter that keeps no hits — the single-pass gather must still
        // evaluate the graph filter exactly once (no repeated corpus searches).
        const tool = createGrepTool(makeOpts({ contextGraph: graph }));
        const spy = vi.spyOn(graphFilterModule, "applyGraphFilter");

        await tool.execute(
            "t-overfetch",
            { pattern: "token", literal: true, graphFilter: "CALLS->nonexistent.symbol", limit: 100 },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        // Exactly one filter pass: the gather loop requests the maximum
        // candidate set once instead of re-running the search per gather step.
        expect(spy.mock.calls.length).toBe(1);
        spy.mockRestore();
    });
});

describe("grep no-index BM25 corpus cache", () => {
  it("short-circuits BM25 and structural fallback when exact hits fill the limit", async () => {
    _resetBm25CorpusCacheForTests();
    const graphPeek = vi.fn(() => null);
    const tool = createGrepTool(makeOpts({
      getWorkspaceRevision: () => 0,
      getSharedContextGraphIfBuilt: graphPeek,
    }));

    const result = await tool.execute(
      "exact-short-circuit",
      { pattern: "export", path: "src", limit: 1 },
      undefined,
      undefined,
      makeCtx(workdir),
    );

    // The literal pass found at least the requested one result. The no-index
    // fallback must not build/read the BM25 corpus or even peek at the graph
    // for the AST-symbol layer.
    expect(_bm25CorpusCacheForTests().builds).toBe(0);
    expect(graphPeek).not.toHaveBeenCalled();
    expect((result.details as any).engines).toEqual(["lexical-passthrough"]);
    expect((result.details as any).shownHits).toBe(1);
  });

  it("warm reuse builds the corpus once and reuses the cached result", async () => {
    _resetBm25CorpusCacheForTests();
    let revision = 0;
    const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => revision }));
    const p = { pattern: "createToken", path: "src" };
    const r1 = await tool.execute("c1", p as any, undefined, undefined, makeCtx(workdir));
    const buildsAfterCold = _bm25CorpusCacheForTests().builds;
    const r2 = await tool.execute("c2", p as any, undefined, undefined, makeCtx(workdir));
    const stats = _bm25CorpusCacheForTests();
    expect(buildsAfterCold).toBe(1);
    expect(stats.builds).toBe(1); // second query served from cache, no rebuild
    expect(stats.size).toBe(1);
    const t1 = (r1.content[0] as { text: string }).text;
    const t2 = (r2.content[0] as { text: string }).text;
    expect(t1).toContain("2 result(s)");
    expect(t2).toContain("2 result(s)");
    expect(t2).toContain("src/tokens.ts");
  });

  it("revision bump invalidates the cached corpus and rebuilds", async () => {
    _resetBm25CorpusCacheForTests();
    let revision = 0;
    const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => revision }));
    const p = { pattern: "createToken", path: "src" };
    await tool.execute("c1", p as any, undefined, undefined, makeCtx(workdir));
    expect(_bm25CorpusCacheForTests().builds).toBe(1);
    revision = 1; // workspace mutated
    await tool.execute("c2", p as any, undefined, undefined, makeCtx(workdir));
    expect(_bm25CorpusCacheForTests().builds).toBe(2);
  });

  it("concurrent queries on the same revision coalesce onto one build", async () => {
    _resetBm25CorpusCacheForTests();
    const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
    const p = { pattern: "createToken", path: "src" };
    await Promise.all([
      tool.execute("c1", p as any, undefined, undefined, makeCtx(workdir)),
      tool.execute("c2", p as any, undefined, undefined, makeCtx(workdir)),
      tool.execute("c3", p as any, undefined, undefined, makeCtx(workdir)),
    ]);
    expect(_bm25CorpusCacheForTests().builds).toBe(1);
  });

  it("isolates cache entries by glob/scope", async () => {
    _resetBm25CorpusCacheForTests();
    const tool = createGrepTool(makeOpts({ getWorkspaceRevision: () => 0 }));
    await tool.execute("c1", { pattern: "createToken", path: "src", glob: "*.ts" } as any, undefined, undefined, makeCtx(workdir));
    await tool.execute("c2", { pattern: "createToken", path: "src" } as any, undefined, undefined, makeCtx(workdir));
    const stats = _bm25CorpusCacheForTests();
    expect(stats.builds).toBe(2); // different glob => different corpus
    expect(stats.size).toBe(2);
  });

  it("reuses the built structural symbol index for a simple identifier without an AST scan", async () => {
    _resetBm25CorpusCacheForTests();
    const graphPeek = vi.fn(() => ({
      findExactSymbolDef: () => ({
        file: join(workdir, "src", "tokens.ts"),
        relFile: "src/tokens.ts",
        line: 20,
        name: "ghostSymbol",
        kind: "symbol",
      }),
    }) as any);
    const tool = createGrepTool(makeOpts({ getSharedContextGraphIfBuilt: graphPeek }));
    const result = await tool.execute("c1", { pattern: "ghostSymbol", path: "src" } as any, undefined, undefined, makeCtx(workdir));
    // handleSymbol would find nothing for "ghostSymbol"; a hit proves the
    // structural-index fast path supplied the definition.
    expect(graphPeek).toHaveBeenCalledTimes(1);
    expect((result.content[0] as { text: string }).text).toContain("ghostSymbol");
  });

  it("benchmark harness: 100/1k/10k-file cold/warm corpus builds without a timing gate", async () => {
    for (const n of [100, 1000, 10000]) {
      const r = await _bm25CacheBenchmark(n);
      // Deterministic assertions: warm hit is cached and adds no rebuild.
      expect(r.cachedWarm).toBe(true);
      expect(r.warmBuilds).toBe(r.coldBuilds);
      console.log(`corpus-bench[${n} files]: cold=${r.coldMs}ms builds=${r.coldBuilds} warm=${r.warmMs}ms builds=${r.warmBuilds}`);
    }
  }, 120_000);
});
