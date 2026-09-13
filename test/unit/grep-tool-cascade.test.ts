/**
 * Grep tool tests — cascade retrieval (split from grep-tool.test.ts, P3.1).
 *
 * Covers: non-literal cascade, semantic fallback, glob-aware retrieval,
 * path-anchored globs, no-index BM25 corpus cache.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import {
    _bm25CacheBenchmark,
    _bm25CorpusCacheForTests,
    _resetBm25CorpusCacheForTests,
    createGrepTool,
} from "../../src/grep-tool.js";
import { disposeSemanticIndexes, getOrCreateSemanticIndex } from "../../src/semantic-index-registry.js";
import { makeCtx, makeOpts, runGrep, seedStandardWorkdir } from "../helpers/grep-tool-fixtures.js";
let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-tool-")));
    seedStandardWorkdir(workdir);
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
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

    it("matches *.ts files inside a path subdirectory", async () => {
        mkdirSync(join(workdir, "jobs"), { recursive: true });
        writeFileSync(
            join(workdir, "jobs", "reasoningIsolation.test.ts"),
            'const ROOT = join(import.meta.dirname, "..", "..");\n',
            "utf8",
        );
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-glob-path",
            { pattern: "meta.dirname", path: "jobs", glob: "*.ts", literal: true, limit: 20 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const text = (result.content[0] as { text: string }).text;
        expect((result.details as any).shownHits).toBeGreaterThanOrEqual(1);
        expect(text).toContain("reasoningIsolation.test.ts");
    });

    it("treats escaped dots as regex so import\\.meta\\.dirname matches import.meta.dirname", async () => {
        mkdirSync(join(workdir, "jobs"), { recursive: true });
        writeFileSync(
            join(workdir, "jobs", "reasoningIsolation.test.ts"),
            'const ROOT = join(import.meta.dirname, "..", "..");\n',
            "utf8",
        );
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-escaped-dot",
            { pattern: "import\\.meta\\.dirname", path: "jobs", limit: 20 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        expect((result.details as any).engines).toContain("regex");
        expect((result.details as any).shownHits).toBeGreaterThanOrEqual(1);
        expect((result.content[0] as { text: string }).text).toContain("reasoningIsolation.test.ts");
    });

    it("ranks BM25 hits under path + *.ts glob when there is no exact phrase", async () => {
        mkdirSync(join(workdir, "jobs"), { recursive: true });
        writeFileSync(
            join(workdir, "jobs", "reasoningIsolation.test.ts"),
            'const ROOT = join(import.meta.dirname, "..", "..");\n',
            "utf8",
        );
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute(
            "t-glob-bm25",
            { pattern: "ROOT dirname", path: "jobs", glob: "*.ts", limit: 20 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        expect((result.details as any).shownHits).toBeGreaterThanOrEqual(1);
        expect((result.content[0] as { text: string }).text).toContain("reasoningIsolation.test.ts");
    });
});
const PATH_ANCHOR = "PATH_ANCHOR_NEEDLE";

describe("grep tool — path-anchored globs", () => {
    beforeEach(() => {
        mkdirSync(join(workdir, "jobs", "sub"), { recursive: true });
        writeFileSync(join(workdir, "jobs", "top.ts"), `export const x = "${PATH_ANCHOR}";\n`, "utf8");
        writeFileSync(join(workdir, "jobs", "sub", "nested.ts"), `export const x = "${PATH_ANCHOR}";\n`, "utf8");
        writeFileSync(join(workdir, "outside.ts"), `export const x = "${PATH_ANCHOR}";\n`, "utf8");
        writeFileSync(join(workdir, "src", "deep.ts"), `export const x = "${PATH_ANCHOR}";\n`, "utf8");
    });
    test.for([
        { name: "path=jobs glob=*.ts matches only immediate children", path: "jobs", glob: "*.ts", present: ["jobs/top.ts"], absent: ["nested.ts", "outside.ts", "deep.ts"] },
        { name: "path=jobs glob=**/*.ts recurses under jobs only", path: "jobs", glob: "**/*.ts", present: ["jobs/top.ts", "jobs/sub/nested.ts"], absent: ["outside.ts", "src/deep.ts"] },
        { name: "path=jobs/sub glob=*.ts does not re-anchor to session cwd", path: "jobs/sub", glob: "*.ts", present: ["jobs/sub/nested.ts"], absent: ["jobs/top.ts", "outside.ts"] },
        { name: "path=jobs/sub glob=**/*.ts stays under sub", path: "jobs/sub", glob: "**/*.ts", present: ["jobs/sub/nested.ts"], absent: ["jobs/top.ts", "outside.ts"] },
        { name: "absolute path matches relative path semantics", path: "__WORKDIR_JOBS__", glob: "*.ts", present: ["jobs/top.ts"], absent: ["nested.ts", "outside.ts"] },
        { name: "path=. glob=*.ts is session-root immediate children", path: ".", glob: "*.ts", present: ["outside.ts"], absent: ["jobs/top.ts", "src/deep.ts"] },
        { name: "does not leak cwd files that match the glob outside searchDir", path: "jobs", glob: "*.ts", present: ["jobs/top.ts"], absent: ["outside.ts"], minShown: 1 },
        { name: "path=jobs/sub/.. normalizes to jobs", path: "jobs/sub/..", glob: "*.ts", present: ["jobs/top.ts"], absent: ["nested.ts", "outside.ts"] },
    ] as { name: string; path: string; glob: string; present: string[]; absent: string[]; minShown?: number }[])("$name", async ({ path, glob, present, absent, minShown }) => {
        const { text, details } = await runGrep(
            workdir,
            { pattern: PATH_ANCHOR, literal: true, limit: 20, path: path === "__WORKDIR_JOBS__" ? join(workdir, "jobs") : path, glob },
            { id: "t-anchor" },
        );
        if (minShown !== undefined) expect(details.shownHits).toBeGreaterThanOrEqual(minShown);
        for (const p of present) expect(text).toContain(p);
        for (const a of absent) expect(text).not.toContain(a);
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
