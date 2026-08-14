/**
 * Tests for impact analysis (WP-2).
 *
 * Covers: risk classification, BFS expansion, dead code detection,
 * edge cases (empty graph, single file, deep blast radius).
 */
import { describe, expect, it } from "vitest";
import {
  classifyFileRisk,
  detectDeadCode,
  expandBlastRadius,
} from "../../src/impact-analysis.js";
import type { CallGraphResult, FunctionInfo } from "../../src/callgraph.js";

// ── Fixtures ──────────────────────────────────────────────────────

function makeFunctionInfo(overrides: Partial<FunctionInfo>): FunctionInfo {
  return {
    name: "testFn",
    file: "src/test.ts",
    line: 1,
    calls: [],
    calledBy: [],
    ...overrides,
  };
}

function makeCallGraph(functions: FunctionInfo[]): CallGraphResult {
  return {
    functions,
    callersOf: (name: string) =>
      functions.filter((f) => f.calls.includes(name)),
    calleesOf: (name: string) => {
      const fn = functions.find((f) => f.name === name);
      if (!fn) return [];
      return fn.calls
        .map((callee) => functions.find((f) => f.name === callee))
        .filter(Boolean) as FunctionInfo[];
    },
    edgeCount: functions.reduce((sum, f) => sum + f.calls.length, 0),
  };
}

// ── Risk classification tests ─────────────────────────────────────

describe("classifyFileRisk", () => {
  it("returns low for files with no signals", () => {
    const risk = classifyFileRisk({
      filePath: "src/unknown.ts",
      pageRank: 0.1,
      fanIn: 0,
      blastRadiusDepth: 0,
    });
    expect(risk).toBe("low");
  });

  it("returns critical for high PageRank", () => {
    const risk = classifyFileRisk({
      filePath: "src/utils.ts",
      pageRank: 0.95,
      fanIn: 0,
      blastRadiusDepth: 0,
    });
    expect(risk).toBe("critical");
  });

  it("returns critical for high fan-in", () => {
    const risk = classifyFileRisk({
      filePath: "src/utils.ts",
      pageRank: 0.1,
      fanIn: 60,
      blastRadiusDepth: 0,
    });
    expect(risk).toBe("critical");
  });

  it("returns critical for entry point with deep blast radius", () => {
    const risk = classifyFileRisk({
      filePath: "src/index.ts",
      pageRank: 0.1,
      fanIn: 0,
      blastRadiusDepth: 3,
      isEntryPoint: true,
    });
    expect(risk).toBe("critical");
  });

  it("returns high for medium-high PageRank", () => {
    const risk = classifyFileRisk({
      filePath: "src/service.ts",
      pageRank: 0.75,
      fanIn: 0,
      blastRadiusDepth: 0,
    });
    expect(risk).toBe("high");
  });

  it("returns high for medium fan-in", () => {
    const risk = classifyFileRisk({
      filePath: "src/service.ts",
      pageRank: 0.1,
      fanIn: 25,
      blastRadiusDepth: 0,
    });
    expect(risk).toBe("high");
  });

  it("returns high for public API", () => {
    const risk = classifyFileRisk({
      filePath: "src/service.ts",
      pageRank: 0.1,
      fanIn: 0,
      blastRadiusDepth: 0,
      isPublicApi: true,
    });
    expect(risk).toBe("high");
  });

  it("returns medium for moderate fan-in", () => {
    const risk = classifyFileRisk({
      filePath: "src/helper.ts",
      pageRank: 0.1,
      fanIn: 8,
      blastRadiusDepth: 0,
    });
    expect(risk).toBe("medium");
  });

  it("returns medium for blast radius >= 2", () => {
    const risk = classifyFileRisk({
      filePath: "src/helper.ts",
      pageRank: 0.1,
      fanIn: 0,
      blastRadiusDepth: 2,
    });
    expect(risk).toBe("medium");
  });

  it("detects entry points by filename pattern", () => {
    const risk = classifyFileRisk({
      filePath: "src/handler.ts",
      pageRank: 0.1,
      fanIn: 0,
      blastRadiusDepth: 3,
    });
    expect(risk).toBe("critical");
  });
});

// ── Dead code detection tests ─────────────────────────────────────

describe("detectDeadCode", () => {
  it("returns empty for null call graph", () => {
    const result = detectDeadCode("src/", null);
    expect(result.files).toEqual([]);
    expect(result.totalDeadFunctions).toBe(0);
  });

  it("detects zero-caller functions", () => {
    const cg = makeCallGraph([
      makeFunctionInfo({ name: "used", file: "src/a.ts", calledBy: ["caller"] }),
      makeFunctionInfo({ name: "unused", file: "src/a.ts", calledBy: [] }),
    ]);

    const result = detectDeadCode("src/", cg);
    expect(result.totalDeadFunctions).toBe(1);
    expect(result.files[0]?.functions[0]?.name).toBe("unused");
  });

  it("excludes functions with callers", () => {
    const cg = makeCallGraph([
      makeFunctionInfo({ name: "used", file: "src/a.ts", calledBy: ["a", "b", "c"] }),
    ]);

    const result = detectDeadCode("src/", cg);
    expect(result.totalDeadFunctions).toBe(0);
  });

  it("excludes test files", () => {
    const cg = makeCallGraph([
      makeFunctionInfo({ name: "testFn", file: "src/a.test.ts", calledBy: [] }),
      makeFunctionInfo({ name: "testFn2", file: "src/a.spec.ts", calledBy: [] }),
    ]);

    const result = detectDeadCode("src/", cg);
    expect(result.totalDeadFunctions).toBe(0);
  });

  it("excludes entry point functions", () => {
    const cg = makeCallGraph([
      makeFunctionInfo({ name: "main", file: "src/app.ts", calledBy: [] }),
      makeFunctionInfo({ name: "handler", file: "src/handler.ts", calledBy: [] }),
      makeFunctionInfo({ name: "index", file: "src/index.ts", calledBy: [] }),
    ]);

    const result = detectDeadCode("src/", cg);
    expect(result.totalDeadFunctions).toBe(0);
  });

  it("scopes to target path", () => {
    const cg = makeCallGraph([
      makeFunctionInfo({ name: "dead1", file: "src/a.ts", calledBy: [] }),
      makeFunctionInfo({ name: "dead2", file: "lib/b.ts", calledBy: [] }),
    ]);

    const result = detectDeadCode("src/", cg);
    expect(result.totalDeadFunctions).toBe(1);
    expect(result.files[0]?.path).toBe("src/a.ts");
  });

  it("counts multiple dead functions per file", () => {
    const cg = makeCallGraph([
      makeFunctionInfo({ name: "dead1", file: "src/a.ts", calledBy: [] }),
      makeFunctionInfo({ name: "dead2", file: "src/a.ts", calledBy: [] }),
      makeFunctionInfo({ name: "dead3", file: "src/a.ts", calledBy: [] }),
    ]);

    const result = detectDeadCode("src/", cg);
    expect(result.totalDeadFunctions).toBe(3);
    expect(result.files[0]?.functions).toHaveLength(3);
  });

  it("returns results sorted by file path", () => {
    const cg = makeCallGraph([
      makeFunctionInfo({ name: "dead1", file: "src/z.ts", calledBy: [] }),
      makeFunctionInfo({ name: "dead2", file: "src/a.ts", calledBy: [] }),
    ]);

    const result = detectDeadCode("src/", cg);
    expect(result.files[0]?.path).toBe("src/a.ts");
    expect(result.files[1]?.path).toBe("src/z.ts");
  });
});

// ── BFS expansion tests (with mock ContextGraph) ──────────────────

describe("expandBlastRadius", () => {
  it("returns single file when graph has no neighbours", async () => {
    // Mock ContextGraph with no-op methods
    const mockGraph = {
      getFileNeighbours: async () => [],
      getMutationNeighbours: () => [],
    } as any;

    const result = await expandBlastRadius("src/a.ts", mockGraph, 3, "");
    expect(result.size).toBe(1);
    expect(result.has("src/a.ts")).toBe(true);
  });

  it("expands to neighbours within depth", async () => {
    const mockGraph = {
      getFileNeighbours: async (path: string) => {
        const edges: Record<string, string[]> = {
          "src/a.ts": ["src/b.ts", "src/c.ts"],
          "src/b.ts": ["src/d.ts"],
        };
        return (edges[path] ?? []).map((p) => ({
          path: p,
          provenance: { from: path, to: p, type: "imports" as const, confidence: 1.0 },
        }));
      },
      getMutationNeighbours: () => [],
    } as any;

    const result = await expandBlastRadius("src/a.ts", mockGraph, 2, "");
    expect(result.size).toBe(4);
    expect(result.get("src/a.ts")?.depth).toBe(0);
    expect(result.get("src/b.ts")?.depth).toBe(1);
    expect(result.get("src/c.ts")?.depth).toBe(1);
    expect(result.get("src/d.ts")?.depth).toBe(2);
  });

  it("respects maxDepth", async () => {
    const mockGraph = {
      getFileNeighbours: async (path: string) => {
        const edges: Record<string, string[]> = {
          "src/a.ts": ["src/b.ts"],
          "src/b.ts": ["src/c.ts"],
          "src/c.ts": ["src/d.ts"],
        };
        return (edges[path] ?? []).map((p) => ({
          path: p,
          provenance: { from: path, to: p, type: "imports" as const, confidence: 1.0 },
        }));
      },
      getMutationNeighbours: () => [],
    } as any;

    const result = await expandBlastRadius("src/a.ts", mockGraph, 1, "");
    expect(result.size).toBe(2); // a.ts + b.ts only
    expect(result.has("src/c.ts")).toBe(false);
  });

  it("includes mutation edges", async () => {
    const mockGraph = {
      getFileNeighbours: async () => [],
      getMutationNeighbours: (path: string) => {
        if (path === "src/a.ts") {
          return [{
            path: "src/b.ts",
            provenance: { from: path, to: "src/b.ts", type: "co_change" as const, confidence: 0.7 },
          }];
        }
        return [];
      },
    } as any;

    const result = await expandBlastRadius("src/a.ts", mockGraph, 3, "");
    expect(result.size).toBe(2);
    expect(result.get("src/b.ts")?.edgeType).toBe("co_change");
  });

  it("does not revisit already-visited files", async () => {
    const mockGraph = {
      getFileNeighbours: async (path: string) => {
        // Circular: a → b → a
        const edges: Record<string, string[]> = {
          "src/a.ts": ["src/b.ts"],
          "src/b.ts": ["src/a.ts", "src/c.ts"],
        };
        return (edges[path] ?? []).map((p) => ({
          path: p,
          provenance: { from: path, to: p, type: "imports" as const, confidence: 1.0 },
        }));
      },
      getMutationNeighbours: () => [],
    } as any;

    const result = await expandBlastRadius("src/a.ts", mockGraph, 3, "");
    expect(result.size).toBe(3); // a, b, c — no infinite loop
  });

  it("handles getFileNeighbours errors gracefully", async () => {
    const mockGraph = {
      getFileNeighbours: async () => { throw new Error("EACCES"); },
      getMutationNeighbours: () => [],
    } as any;

    const result = await expandBlastRadius("src/a.ts", mockGraph, 3, "");
    expect(result.size).toBe(1); // Only the target
  });
});

// ── computeImpact tests ───────────────────────────────────────

describe("computeImpact", () => {
  it("returns target-only result when no ContextGraph provided", async () => {
    const { computeImpact } = await import("../../src/impact-analysis.js");
    const result = await computeImpact({
      targetFile: "src/a.ts",
    });
    expect(result.target).toBe("src/a.ts");
    expect(result.affectedFiles).toEqual([]);
    expect(result.blastRadiusDepth).toBe(0);
  });

  it("performs real BFS traversal with ContextGraph", async () => {
    const { computeImpact } = await import("../../src/impact-analysis.js");
    const mockGraph = {
      getFileNeighbours: async (path: string) => {
        const edges: Record<string, string[]> = {
          "src/a.ts": ["src/b.ts"],
          "src/b.ts": ["src/c.ts"],
        };
        return (edges[path] ?? []).map((p) => ({
          path: p,
          provenance: { from: path, to: p, type: "imports" as const, confidence: 1.0 },
        }));
      },
      getMutationNeighbours: () => [],
    } as any;

    const result = await computeImpact({
      targetFile: "src/a.ts",
      maxDepth: 2,
      contextGraph: mockGraph,
    });
    expect(result.target).toBe("src/a.ts");
    expect(result.affectedFiles.length).toBe(2); // b.ts, c.ts
    const paths = result.affectedFiles.map(f => f.path).sort();
    expect(paths).toEqual(["src/b.ts", "src/c.ts"]);
    expect(result.blastRadiusDepth).toBe(2);
  });
});
