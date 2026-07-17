/**
 * Tests for graph filter (WP-2).
 *
 * Covers: filter parsing, edge matching, error cases, inverse edges,
 * async edge checking, symbol resolution via findSymbolFiles.
 */
import { describe, expect, it } from "vitest";
import {
  parseGraphFilter,
  applyGraphFilter,
  isFilePath,
  type GrepHit,
} from "../../src/graph-filter.js";

// ── Fixtures ──────────────────────────────────────────────────────

function makeHit(overrides: Partial<GrepHit> = {}): GrepHit {
  return {
    file: "/workspace/src/auth.ts",
    relFile: "src/auth.ts",
    line: 10,
    endLine: 10,
    name: "authenticate",
    kind: "function",
    snippet: "  authenticate() {",
    engines: ["bm25"],
    score: 0.5,
    ...overrides,
  };
}

interface MutationEdge {
  path: string;
  type: string;
}

function makeMockGraph(opts: {
  mutationEdges?: Map<string, MutationEdge[]>;
  importEdges?: Map<string, string[]>;
  importedByEdges?: Map<string, string[]>;
  callEdges?: Map<string, string[]>;
  symbolResolutions?: Map<string, string[]>;
} = {}) {
  return {
    getMutationNeighbours: (path: string) => {
      const edges = opts.mutationEdges ?? new Map();
      const list = edges.get(path) ?? [];
      return list.map((e: MutationEdge) => ({
        path: e.path,
        provenance: {
          from: path,
          to: e.path,
          type: e.type as any,
          confidence: 1.0,
        },
      }));
    },
    getFileNeighbours: async (path: string, options?: { includeCalls?: boolean }) => {
      const neighbours: Array<{ path: string; provenance: { type: string; from: string; to: string; confidence: number } }> = [];

      // Import neighbours (forward: this file imports target)
      const imports = opts.importEdges ?? new Map<string, string[]>();
      const importTargets = imports.get(path) ?? [];
      for (const target of importTargets) {
        neighbours.push({
          path: target,
          provenance: { from: path, to: target, type: "imports" as const, confidence: 1.0 },
        });
      }

      // Imported-by neighbours (reverse: this file is imported by source)
      const importedBy = opts.importedByEdges ?? new Map<string, string[]>();
      const importedBySources = importedBy.get(path) ?? [];
      for (const source of importedBySources) {
        neighbours.push({
          path: source,
          provenance: { from: path, to: source, type: "imported_by" as const, confidence: 1.0 },
        });
      }

      // Call neighbours
      if (options?.includeCalls) {
        const calls = opts.callEdges ?? new Map<string, string[]>();
        // Outgoing calls
        const callTargets = calls.get(path) ?? [];
        for (const target of callTargets) {
          neighbours.push({
            path: target,
            provenance: { from: path, to: target, type: "calls" as const, confidence: 0.8 },
          });
        }
        // Incoming calls (called_by): if path is a callee target, add caller
        for (const [caller, targets] of calls) {
          if (caller !== path && targets.includes(path)) {
            neighbours.push({
              path: caller,
              provenance: { from: path, to: caller, type: "called_by" as const, confidence: 0.8 },
            });
          }
        }
      }

      return neighbours;
    },
    findSymbolFiles: async (query: string) => {
      const symbols = opts.symbolResolutions ?? new Map<string, string[]>();
      const files = symbols.get(query) ?? [];
      return files.map((f: string) => ({
        path: f,
        provenance: { from: query, to: f, type: "defines" as const, confidence: 0.9 },
      }));
    },
  } as any;
}

// ── isFilePath tests ──────────────────────────────────────────────

describe("isFilePath", () => {
  it("returns true for paths with /", () => {
    expect(isFilePath("src/core")).toBe(true);
    expect(isFilePath("/workspace/file.ts")).toBe(true);
  });

  it("returns true for paths with known source extension", () => {
    expect(isFilePath("auth.ts")).toBe(true);
    expect(isFilePath("component.tsx")).toBe(true);
    expect(isFilePath("main.js")).toBe(true);
    expect(isFilePath("App.jsx")).toBe(true);
    expect(isFilePath("server.py")).toBe(true);
  });

  it("returns false for qualified symbols with dots", () => {
    expect(isFilePath("auth.login")).toBe(false);
    expect(isFilePath("AuthService.authenticate")).toBe(false);
    expect(isFilePath("some.module.func")).toBe(false);
  });

  it("returns false for bare names", () => {
    expect(isFilePath("validateToken")).toBe(false);
  });
});

// ── parseGraphFilter tests ────────────────────────────────────────

describe("parseGraphFilter", () => {
  it("parses valid CALLS->target format", () => {
    const result = parseGraphFilter("CALLS->auth.login");
    expect(result).toEqual({ edgeType: "calls", target: "auth.login" });
  });

  it("parses valid IMPORTED_BY->src/core format", () => {
    const result = parseGraphFilter("IMPORTED_BY->src/core");
    expect(result).toEqual({ edgeType: "imported_by", target: "src/core" });
  });

  it("parses valid BREAKAGE->src/types.ts format", () => {
    const result = parseGraphFilter("BREAKAGE->src/types.ts");
    expect(result).toEqual({ edgeType: "breakage", target: "src/types.ts" });
  });

  it("parses valid CO_CHANGE->src/config.ts format", () => {
    const result = parseGraphFilter("CO_CHANGE->src/config.ts");
    expect(result).toEqual({ edgeType: "co_change", target: "src/config.ts" });
  });

  it("parses case-insensitive edge type", () => {
    const result = parseGraphFilter("calls->auth.login");
    expect(result).toEqual({ edgeType: "calls", target: "auth.login" });
  });

  it("returns null for empty string", () => {
    expect(parseGraphFilter("")).toBeNull();
  });

  it("returns null for missing separator", () => {
    expect(parseGraphFilter("CALLSauth.login")).toBeNull();
  });

  it("returns null for missing target", () => {
    expect(parseGraphFilter("CALLS->")).toBeNull();
  });

  it("returns null for unknown edge type", () => {
    expect(parseGraphFilter("UNKNOWN->target")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseGraphFilter(null as any)).toBeNull();
  });

  it("handles whitespace in edge type", () => {
    const result = parseGraphFilter("  CALLS  ->  auth.login  ");
    expect(result).toEqual({ edgeType: "calls", target: "auth.login" });
  });

  it("parses all valid edge types", () => {
    const types = [
      "IMPORTS", "IMPORTED_BY", "CALLS", "CALLED_BY",
      "DEFINES", "DEFINED_IN", "REFERENCES", "REFERENCED_BY",
      "BREAKAGE", "CO_CHANGE",
    ];
    for (const t of types) {
      const result = parseGraphFilter(`${t}->target`);
      expect(result).not.toBeNull();
      expect(result!.edgeType).toBeTruthy();
    }
  });
});

// ── applyGraphFilter tests ────────────────────────────────────────

describe("applyGraphFilter", () => {
  it("throws on invalid filter format", async () => {
    const hits = [makeHit(), makeHit({ file: "/workspace/src/b.ts", relFile: "src/b.ts" })];
    const graph = makeMockGraph();
    await expect(
      applyGraphFilter(hits, "bad-format", graph),
    ).rejects.toThrow('Invalid graphFilter: expected "EDGE_TYPE->target" format');
  });

  it("throws on null-like invalid filter", async () => {
    const graph = makeMockGraph();
    await expect(
      applyGraphFilter([], "NOSEPARATOR", graph),
    ).rejects.toThrow('Invalid graphFilter: expected "EDGE_TYPE->target" format');
  });

  it("filters by CO_CHANGE edge via mutation neighbours", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/a.ts", relFile: "src/a.ts" }),
      makeHit({ file: "/workspace/src/b.ts", relFile: "src/b.ts" }),
      makeHit({ file: "/workspace/src/c.ts", relFile: "src/c.ts" }),
    ];

    const mutationEdges = new Map([
      ["src/target.ts", [
        { path: "src/a.ts", type: "co_change" },
      ]],
    ]);

    const graph = makeMockGraph({ mutationEdges });
    const result = await applyGraphFilter(hits, "CO_CHANGE->src/target.ts", graph);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/a.ts");
    expect(result.notes).toEqual([]);
  });

  it("filters by BREAKAGE edge via mutation neighbours", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/a.ts", relFile: "src/a.ts" }),
      makeHit({ file: "/workspace/src/b.ts", relFile: "src/b.ts" }),
    ];

    const mutationEdges = new Map([
      ["src/source.ts", [
        { path: "src/a.ts", type: "breakage" },
        { path: "src/b.ts", type: "breakage" },
      ]],
    ]);

    const graph = makeMockGraph({ mutationEdges });
    const result = await applyGraphFilter(hits, "BREAKAGE->src/source.ts", graph);
    expect(result.hits).toHaveLength(2);
  });

  it("returns empty when no edges match", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/a.ts", relFile: "src/a.ts" }),
    ];

    const graph = makeMockGraph({ mutationEdges: new Map() });
    const result = await applyGraphFilter(hits, "CO_CHANGE->src/target.ts", graph);
    expect(result.hits).toHaveLength(0);
  });

  it("returns empty for empty hits array", async () => {
    const graph = makeMockGraph();
    const result = await applyGraphFilter([], "CALLS->target", graph);
    expect(result.hits).toHaveLength(0);
  });

  it("filters by IMPORTS edge when hit file imports the target path", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/server.ts", relFile: "src/server.ts" }),
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
    ];

    const importEdges = new Map([
      ["/workspace/src/server.ts", ["/workspace/src/db.ts"]],
      ["/workspace/src/user.ts", []],
    ]);
    // db.ts has incoming import edge from server.ts (db.ts is imported_by server.ts)
    const importedByEdges = new Map([
      ["/workspace/src/db.ts", ["/workspace/src/server.ts"]],
    ]);

    const graph = makeMockGraph({ importEdges, importedByEdges });
    const result = await applyGraphFilter(hits, "IMPORTS->src/db.ts", graph);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/server.ts");
  });

  it("filters by CALLS edge using call graph neighbours", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/auth.ts", relFile: "src/auth.ts" }),
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
    ];

    const callEdges = new Map([
      ["/workspace/src/auth.ts", ["/workspace/src/tokens.ts"]],
      ["/workspace/src/user.ts", []],
    ]);

    const graph = makeMockGraph({ callEdges });
    const result = await applyGraphFilter(hits, "CALLS->src/tokens.ts", graph);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/auth.ts");
  });

  it("resolves symbol target with dots via findSymbolFiles", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/auth.ts", relFile: "src/auth.ts" }),
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
    ];

    // auth.login resolves to /workspace/src/tokens.ts
    const symbolResolutions = new Map([
      ["auth.login", ["/workspace/src/tokens.ts"]],
    ]);

    // auth.ts calls tokens.ts
    const callEdges = new Map([
      ["/workspace/src/auth.ts", ["/workspace/src/tokens.ts"]],
      ["/workspace/src/user.ts", []],
    ]);

    const graph = makeMockGraph({ callEdges, symbolResolutions });
    const result = await applyGraphFilter(hits, "CALLS->auth.login", graph);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/auth.ts");
  });

  it("notes when symbol not found in workspace", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/auth.ts", relFile: "src/auth.ts" }),
    ];

    const graph = makeMockGraph({ symbolResolutions: new Map() });
    const result = await applyGraphFilter(hits, "CALLS->unknown.symbol", graph);
    expect(result.hits).toHaveLength(0);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.notes[0]).toContain('graphFilter: symbol "unknown.symbol" not found');
  });

  // ── Edge type directionality tests ─────────────────────────────

  it("filters by IMPORTED_BY: hit file is imported by the target file", async () => {
    // server.ts imports db.ts. "IMPORTED_BY->db.ts" should match server.ts
    const hits = [
      makeHit({ file: "/workspace/src/server.ts", relFile: "src/server.ts" }),
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
    ];
    const importEdges = new Map([
      ["/workspace/src/server.ts", ["/workspace/src/db.ts"]],
      ["/workspace/src/user.ts", []],
    ]);
    const graph = makeMockGraph({ importEdges });
    const result = await applyGraphFilter(hits, "IMPORTED_BY->src/db.ts", graph);
    // Inverse: db.ts has edge TO server.ts via imported_by. So server.ts should match.
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/server.ts");
  });

  it("filters by CALLED_BY: hit file is called by the target file", async () => {
    // auth.ts calls tokens.ts. "CALLED_BY->tokens.ts" should match auth.ts
    const hits = [
      makeHit({ file: "/workspace/src/auth.ts", relFile: "src/auth.ts" }),
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
    ];
    const callEdges = new Map([
      ["/workspace/src/auth.ts", ["/workspace/src/tokens.ts"]],
      ["/workspace/src/user.ts", []],
    ]);
    const graph = makeMockGraph({ callEdges });
    const result = await applyGraphFilter(hits, "CALLED_BY->src/tokens.ts", graph);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/auth.ts");
  });

  it("filters by DEFINES with symbol provenance: hit file defines the symbol", async () => {
    // auth.login resolves to tokens.ts with provenance type "defines"
    const hits = [
      makeHit({ file: "/workspace/src/tokens.ts", relFile: "src/tokens.ts" }),
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
    ];
    const symbolResolutions = new Map([
      ["auth.login", ["/workspace/src/tokens.ts"]],
    ]);
    const graph = makeMockGraph({ symbolResolutions });
    const result = await applyGraphFilter(hits, "DEFINES->auth.login", graph);
    // Direct provenance: tokens.ts has "defines" provenance, so tokens.ts matches
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/tokens.ts");
  });

  it("filters by REFERENCES with symbol provenance: hit file references the symbol", async () => {
    // auth.login resolves to user.ts with provenance type "references"
    const hits = [
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
      makeHit({ file: "/workspace/src/tokens.ts", relFile: "src/tokens.ts" }),
    ];
    // Override findSymbolFiles to return "references" provenance
    const graph = makeMockGraph({ symbolResolutions: new Map() });
    (graph as any).findSymbolFiles = async (query: string) => {
      if (query === "auth.login") {
        return [{
          path: "/workspace/src/user.ts",
          provenance: { from: query, to: "/workspace/src/user.ts", type: "references" as const, confidence: 0.9 },
        }];
      }
      return [];
    };
    const result = await applyGraphFilter(hits, "REFERENCES->auth.login", graph);
    // Direct provenance: user.ts has "references" provenance, so user.ts matches
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/user.ts");
  });

  it("filters by DEFINED_IN with symbol provenance (inverse of defines)", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/tokens.ts", relFile: "src/tokens.ts" }),
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
    ];
    const symbolResolutions = new Map([
      ["auth.login", ["/workspace/src/tokens.ts"]],
    ]);
    const graph = makeMockGraph({ symbolResolutions });
    const result = await applyGraphFilter(hits, "DEFINED_IN->auth.login", graph);
    // Inverse of defines, but for symbol targets: tokens.ts defines auth.login → tokens.ts matches
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/tokens.ts");
  });

  it("filters by REFERENCED_BY with symbol provenance (inverse of references)", async () => {
    const hits = [
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
      makeHit({ file: "/workspace/src/tokens.ts", relFile: "src/tokens.ts" }),
    ];
    const graph = makeMockGraph({ symbolResolutions: new Map() });
    (graph as any).findSymbolFiles = async (query: string) => {
      if (query === "auth.login") {
        return [{
          path: "/workspace/src/user.ts",
          provenance: { from: query, to: "/workspace/src/user.ts", type: "references" as const, confidence: 0.9 },
        }];
      }
      return [];
    };
    const result = await applyGraphFilter(hits, "REFERENCED_BY->auth.login", graph);
    // Inverse of references, but for symbol targets: user.ts references auth.login → user.ts matches
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.relFile).toBe("src/user.ts");
  });

  it("does not false-positive DEFINES when provenance is references", async () => {
    // auth.login resolves to user.ts with provenance type "references"
    const hits = [
      makeHit({ file: "/workspace/src/user.ts", relFile: "src/user.ts" }),
    ];
    const graph = makeMockGraph({ symbolResolutions: new Map() });
    (graph as any).findSymbolFiles = async (query: string) => {
      if (query === "auth.login") {
        return [{
          path: "/workspace/src/user.ts",
          provenance: { from: query, to: "/workspace/src/user.ts", type: "references" as const, confidence: 0.9 },
        }];
      }
      return [];
    };
    const result = await applyGraphFilter(hits, "DEFINES->auth.login", graph);
    // Should NOT match: provenance is "references" but filter asks for "defines"
    expect(result.hits).toHaveLength(0);
  });
});
