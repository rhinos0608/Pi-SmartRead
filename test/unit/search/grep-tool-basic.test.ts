/**
 * Grep tool tests — basic modes (split from grep-tool.test.ts, P3.1).
 *
 * Covers: literal mode, per-hit engine provenance, batch queries,
 * zero-hit fallback, limit clamping, truncation, ignoreCase,
 * contextLines, evidence envelopes, resolver publish, regex detection,
 * explicit degradation reasons.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { createGrepTool } from "../../src/grep-tool.js";
import { disposeSemanticIndexes } from "../../src/semantic-index-registry.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../helpers/grep-tool-fixtures.js";
let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-tool-")));
    seedStandardWorkdir(workdir);
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
describe("grep tool — per-hit engine provenance rendering", () => {
  it("uniform single-engine result set renders no per-hit annotation", async () => {
    const { _formatOutputForTests } = await import("../../src/grep-tool.js");
    const hits: any[] = [
      { relFile: "src/a.ts", line: 1, endLine: 1, name: "foo", snippet: "", engines: ["bm25"] },
      { relFile: "src/b.ts", line: 2, endLine: 2, name: "", snippet: "", engines: ["bm25"] },
    ];
    const text = _formatOutputForTests("foo", hits, hits.length, ["bm25"], false, 5);
    expect(text).toContain('(bm25');
    expect(text).not.toContain("[bm25]");
    expect(text).toContain("src/a.ts  L1  foo");
    expect(text).toContain("src/b.ts  L2");
  });

  it("divergent engines across hits render per-hit annotations accurately", async () => {
    const { _formatOutputForTests } = await import("../../src/grep-tool.js");
    const hits: any[] = [
      { relFile: "src/a.ts", line: 1, endLine: 1, name: "", snippet: "hit a", engines: ["bm25"] },
      { relFile: "src/b.ts", line: 10, endLine: 12, name: "Bar", snippet: "hit b", engines: ["symbol"] },
      { relFile: "src/c.ts", line: 3, endLine: 3, name: "", snippet: "", engines: ["semantic"] },
    ];
    const text = _formatOutputForTests("q", hits, hits.length, ["bm25", "symbol", "semantic"], false, 7);
    expect(text).toContain("src/a.ts  L1  [bm25]");
    expect(text).toContain("src/b.ts  L10-12  Bar  [symbol]");
    expect(text).toContain("src/c.ts  L3  [semantic]");
  });

  it("single hit with multiple engines shows combined provenance", async () => {
    const { _formatOutputForTests } = await import("../../src/grep-tool.js");
    const hits: any[] = [
      { relFile: "src/a.ts", line: 5, endLine: 5, name: "doThing", snippet: "code", engines: ["lexical", "bm25"] },
    ];
    const text = _formatOutputForTests("doThing", hits, 1, ["lexical", "bm25"], false, 3);
    expect(text).toContain("src/a.ts  L5  doThing  [lexical+bm25]");
  });

  it("uniform multi-engine hits still show provenance (confidence signal)", async () => {
    const { _formatOutputForTests, _shouldShowPerHitEnginesForTests } = await import("../../src/grep-tool.js");
    const hits: any[] = [
      { relFile: "src/a.ts", line: 1, endLine: 1, name: "", snippet: "", engines: ["lexical", "bm25"] },
      { relFile: "src/b.ts", line: 2, endLine: 2, name: "", snippet: "", engines: ["lexical", "bm25"] },
    ];
    expect(_shouldShowPerHitEnginesForTests(hits)).toBe(true);
    const text = _formatOutputForTests("q", hits, hits.length, ["lexical", "bm25"], false, 2);
    expect(text).toContain("[lexical+bm25]");
  });

  it("empty engines array never renders brackets", async () => {
    const { _formatOutputForTests } = await import("../../src/grep-tool.js");
    const hits: any[] = [
      { relFile: "src/a.ts", line: 1, endLine: 1, name: "", snippet: "", engines: [] },
    ];
    const text = _formatOutputForTests("q", hits, 1, [], false, 1);
    expect(text).not.toContain("[");
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
    test.for([
        { name: "pattern+queries", params: { pattern: "auth", queries: [{ pattern: "token" }] } as any, error: "Provide exactly one of: pattern or queries" },
        { name: "empty queries", params: { queries: [] } as any, error: "queries must contain between 1 and 10 search objects" },
        { name: "eleven queries", params: { queries: Array.from({ length: 11 }, () => ({ pattern: "auth" })) } as any, error: "queries must contain between 1 and 10 search objects" },
    ])("requires exactly one search mode and bounds direct execute calls — $name", async ({ params, error }) => {
        const tool = createGrepTool(makeOpts());
        await expect(
            tool.execute("t-batch-invalid", params, undefined, undefined, makeCtx(workdir)),
        ).rejects.toThrow(error);
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
    test.for([
        { name: "limit 0 clamps up to 1", limit: 0, minShown: 1 },
        { name: "limit 999 clamps down to 100", limit: 999, maxShown: 100 },
    ] as { name: string; limit: number; minShown?: number; maxShown?: number }[])("limit clamping — $name", async ({ limit, minShown, maxShown }) => {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-clamp",
            { pattern: "export", literal: true, limit },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        if (minShown !== undefined) expect(details.shownHits).toBeGreaterThanOrEqual(minShown);
        if (maxShown !== undefined) expect(details.shownHits).toBeLessThanOrEqual(maxShown);
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
describe("grep tool — regex detection", () => {
    beforeEach(() => {
        writeFileSync(join(workdir, "src", "classify.ts"), "foo.bar\nfoo\\z\n", "utf8");
    });

    async function enginesFor(pattern: string): Promise<string[]> {
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-re",
            { pattern, path: "src/classify.ts", limit: 20 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        return (result.details as any).engines as string[];
    }
    test.for([
        { pattern: "foo\\.bar", isRegex: true },
        { pattern: "foo.bar", isRegex: false },
        { pattern: "foo\\z", isRegex: false },
    ])("regex routing — $pattern", async ({ pattern, isRegex }) => {
        const engines = await enginesFor(pattern);
        if (isRegex) expect(engines).toContain("regex");
        else expect(engines).not.toContain("regex");
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
