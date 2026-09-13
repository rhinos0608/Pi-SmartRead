/**
 * Grep tool tests — structural search (split from grep-tool.test.ts, P3.1).
 *
 * Covers: structural search params, invalid combos, hit details,
 * graphFilter pagination over structural matches (WP-SR4).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { createGrepTool } from "../../../src/search/grep-tool.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { _resetAstGrepCacheForTests } from "../../../src/structural/structural-search.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../../helpers/grep-tool-fixtures.js";
let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-tool-")));
    seedStandardWorkdir(workdir);
});

afterEach(() => {
    // Clear module-level forced-unavailable state even when assertions fail.
    _resetAstGrepCacheForTests();
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});
describe("grep tool — structural search (WP-SR4)", () => {
  it("exposes structural param in schema (shared and per-query)", () => {
    const schema = createGrepTool(makeOpts()).parameters as any;
    expect(schema.properties.structural).toBeDefined();
    expect(schema.properties.structural.properties.language).toBeDefined();
    expect(schema.properties.queries.items.properties.structural).toBeDefined();
  });
  test.for([
    { id: "s-lit", params: { pattern: "x", literal: true, structural: {} }, error: /literal/ },
    { id: "s-ic", params: { pattern: "x", ignoreCase: true, structural: {} }, error: /ignoreCase/ },
    { id: "s-lang", params: { pattern: "console.log($A)", structural: { language: "cobol" } }, error: /unsupported language/ },
    { id: "s-uninferable-path", params: { pattern: "console.log($ARG)", structural: {}, path: "weird.unknownxyz" }, error: /cannot infer language|unsupported_language/, setupFile: "weird.unknownxyz" },
  ] as { id: string; params: Record<string, unknown>; error: RegExp; setupFile?: string }[])("rejects invalid structural combos — $id", async ({ id, params, error, setupFile }) => {
    const tool = createGrepTool(makeOpts());
    const ctx = makeCtx(workdir);
    if (setupFile !== undefined) writeFileSync(join(workdir, setupFile), "console.log(1)\n", "utf8");
    await expect(tool.execute(id, params as any, undefined, undefined, ctx)).rejects.toThrow(error);
  });
  it("structural hits include read args in text and details, evidence stays search-match", async () => {
    const { _setUnavailableForTests, _resetAstGrepCacheForTests, isStructuralSearchAvailable } = await import("../../../src/structural/structural-search.js");
    writeFileSync(join(workdir, "src", "s.ts"), "console.log(a)\n", "utf8");
    const tool = createGrepTool(makeOpts());
    const r: any = await tool.execute("s-ok", { pattern: "console.log($ARG)", structural: {} } as any, undefined, undefined, makeCtx(workdir));
    expect(r.details.structuralSearch).toBeDefined();
    expect(r.details.structuralSearch.schemaVersion).toBe(1);
    expect(r.details.workspaceEvidence.mode).toBe("query");
    if (r.details.structuralSearch.status === "unavailable") {
      expect(r.details.structuralSearch.reason).toBeTruthy();
      expect(r.details.workspaceEvidence.resources.length).toBe(0);
      const text = (r.content[0] as any).text;
      expect(text).toContain("structural search unavailable");
    } else {
      expect(r.details.workspaceEvidence.resources[0].coverage).toBe("search-match");
      const text = (r.content[0] as any).text;
      expect(text).toContain("read=");
      expect(r.details.structuralSearch.matches[0].read).toBeDefined();
    }
    // Unavailable forcing stays regression-covered via test hook
    _setUnavailableForTests("forced unavailable for test");
    const u: any = await tool.execute("s-unavailable", { pattern: "console.log($ARG)", structural: {} } as any, undefined, undefined, makeCtx(workdir));
    expect(u.details.structuralSearch.status).toBe("unavailable");
    expect(u.details.workspaceEvidence.resources.length).toBe(0);
    expect((u.content[0] as any).text).toContain("structural search unavailable");
    _resetAstGrepCacheForTests();
    if (await isStructuralSearchAvailable()) {
      const o: any = await tool.execute("s-ok-after-reset", { pattern: "console.log($ARG)", structural: {} } as any, undefined, undefined, makeCtx(workdir));
      if (o.details.structuralSearch.status !== "unavailable") expect(o.details.structuralSearch.matches.length).toBeGreaterThan(0);
    }
  });
  it("structural graphFilter paginates filtered results — valid hit beyond first page survives limit", async () => {
    const avail = (await import("../../../src/structural/structural-search.js")).isStructuralSearchAvailable;
    if (!(await avail())) return;
    // 30 matching files; only files whose caller imports auth-filter target should survive filter
    const { ContextGraph } = await import("../../../src/context-graph.js");
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(workdir, "src", `sr_struct_${i}.ts`), `console.log(${i})\n`, "utf8");
    }
    const target = join(workdir, "src", "auth-filter-target.ts");
    writeFileSync(target, "export const target = 1;", "utf8");
    // Importer that contains a structural match and the target import edge
    for (let i = 0; i < 3; i++) {
      writeFileSync(
        join(workdir, "src", `sr_struct_imp_${i}.ts`),
        `import { target } from "./auth-filter-target";\nconsole.log(imp${i})\n`,
        "utf8",
      );
    }
    const graph = new ContextGraph(workdir);
    await graph.buildContextGraph();
    const tool = createGrepTool(makeOpts({ contextGraph: graph }));
    const r: any = await tool.execute("s-gf-page", { pattern: "console.log($ARG)", structural: {}, graphFilter: "IMPORTED_BY->src/auth-filter-target.ts", limit: 2, skip: 1 } as any, undefined, undefined, makeCtx(workdir));
    expect(r.details.structuralSearch.status).toBe("ok");
    // After filtering only importers remain (3); skip 1 of 3 with limit 2 → 2 shown, 0 remaining → truncated false (top-level skip routes into structural.skip)
    expect(r.details.structuralSearch.totalMatches).toBe(3);
    expect(r.details.structuralSearch.shownMatches).toBe(2);
    expect(r.details.structuralSearch.truncated).toBe(false);
  });
  it("structural graphFilter with raw matches above cap — bounded pagination, no lost matches, no infinite loop", async () => {
    const structMod: any = await import("../../../src/structural/structural-search.js");
    const { GREP_STRUCTURAL_FETCH_SIZE } = await import("../../../src/search/grep-structural-executor.js");
    const cap = GREP_STRUCTURAL_FETCH_SIZE;
    const total = cap * 2 + 500; // above cap, e.g. 2500 when cap=1000
    const allFake = Array.from({ length: total }, (_, i) => ({
      path: join(workdir, "src", `fake_${i}.ts`),
      line: i + 1,
      character: 0,
      endLine: i + 1,
      endCharacter: 10,
      text: `console.log(${i})`,
    }));
    let callCount = 0;
    const spy = vi.spyOn(structMod, "structuralSearch").mockImplementation(async (opts: any) => {
      callCount++;
      if (callCount > 20) throw new Error("infinite loop — pagination did not advance");
      const skip = opts.skip ?? 0;
      const limit = opts.limit ?? cap;
      const slice = allFake.slice(skip, skip + limit);
      return {
        status: "ok" as const,
        matches: slice,
        totalMatches: total,
        shownMatches: slice.length,
        truncated: skip + slice.length < total,
        skip,
        groupByFile: false,
      };
    });
    const mockGraph: any = {
      getFileNeighbours: async (_fromFile: string) => [{ path: "src/target.ts", provenance: { type: "imports" } }],
      getMutationNeighbours: () => [],
      findSymbolFiles: async () => [],
    };
    const tool = createGrepTool(makeOpts({ contextGraph: mockGraph }));
    const r: any = await tool.execute("s-gf-big", { pattern: "console.log($ARG)", structural: {}, graphFilter: "IMPORTS->src/target.ts" } as any, undefined, undefined, makeCtx(workdir));
    expect(r.details.structuralSearch.status).toBe("ok");
    // correctness: no lost matches — filtered total equals raw total (mock graph passes all)
    expect(r.details.structuralSearch.totalMatches).toBe(total);
    // termination: bounded iterations = ceil(total / cap) e.g. 3 when 2500/1000
    const expectedCalls = Math.ceil(total / cap);
    expect(callCount).toBe(expectedCalls);
    expect(callCount).toBeLessThanOrEqual(10);
    spy.mockRestore();
  });
  it("structural graphFilter at/above raw ceiling — hard cap terminates with truncated:true and no duplicates", async () => {
    const structMod: any = await import("../../../src/structural/structural-search.js");
    const grepMod: any = await import("../../../src/search/grep-tool.js");
    const { GREP_STRUCTURAL_FETCH_SIZE } = grepMod;
    const cap = GREP_STRUCTURAL_FETCH_SIZE ?? 1000;
    // Simulate ceiling at small value to avoid 10M allocation, but exercise same clamp-repetition bug.
    // Real ceiling is 10_000_000; we use 5000 to prove hard-cap logic terminates without duplication.
    const simCeiling = 5000;
    const total = simCeiling + 3000; // exceeds sim ceiling
    let callCount = 0;
    const visitedOffsets = new Set<number>();
    let totalConsidered = 0;
    const spy = vi.spyOn(structMod, "structuralSearch").mockImplementation(async (opts: any) => {
      callCount++;
      if (callCount > Math.ceil(simCeiling / cap) + 5) throw new Error("infinite loop — ceiling cap did not terminate");
      const skip: number = opts.skip ?? 0;
      const limit: number = opts.limit ?? cap;
      if (visitedOffsets.has(skip)) throw new Error(`duplicate page — skip ${skip} repeated (clamp bug)`);
      visitedOffsets.add(skip);
      // Simulate clamp at simCeiling: beyond ceiling same page repeats (bug) — capped logic must detect and stop
      const effectiveSkip = Math.min(skip, simCeiling);
      const isClamped = effectiveSkip !== skip;
      // Generate slice on the fly without allocating huge array
      const sliceLen = Math.min(limit, total - effectiveSkip > 0 ? total - effectiveSkip : 0);
      const cappedLen = effectiveSkip >= simCeiling ? 0 : Math.min(sliceLen, simCeiling - effectiveSkip);
      totalConsidered += cappedLen;
      const slice = Array.from({ length: cappedLen }, (_, i) => {
        const idx = effectiveSkip + i;
        return { path: join(workdir, "src", `ceil_${idx}.ts`), line: idx + 1, character: 0, endLine: idx + 1, endCharacter: 10, text: `console.log(${idx})` };
      });
      return {
        status: "ok" as const,
        matches: slice,
        totalMatches: total,
        shownMatches: slice.length,
        truncated: isClamped ? true : effectiveSkip + slice.length < total,
        skip: effectiveSkip,
        groupByFile: false,
      };
    });
    const mockGraph: any = {
      getFileNeighbours: async () => [{ path: "src/target.ts", provenance: { type: "imports" } }],
      getMutationNeighbours: () => [],
      findSymbolFiles: async () => [],
    };
    const tool = createGrepTool(makeOpts({ contextGraph: mockGraph }));
    const r: any = await tool.execute("s-gf-ceiling", { pattern: "console.log($ARG)", structural: {}, graphFilter: "IMPORTS->src/target.ts" } as any, undefined, undefined, makeCtx(workdir));
    expect(r.details.structuralSearch.status).toBe("ok");
    // Must terminate at ceiling, not loop forever, and must report truncated:true (hard cap or clamp)
    expect(r.details.structuralSearch.truncated).toBe(true);
    expect(visitedOffsets.size).toBe(callCount);
    // No duplicate pages, bounded iterations, and considered matches capped at simCeiling
    expect(totalConsidered).toBe(simCeiling);
    expect(callCount).toBeLessThanOrEqual(Math.ceil(simCeiling / cap) + 1);
    expect(callCount).toBeGreaterThanOrEqual(Math.ceil(simCeiling / cap));
    // No infinite repetition: callCount bounded by ceiling/cap, not total/cap
    spy.mockRestore();
  });
});
