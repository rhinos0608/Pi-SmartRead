import { describe, expect, it } from "vitest";
import { probeQuery, type ProbeOptions } from "../../query-probe.js";


/**
 * Stub ContextGraph for probe testing.
 * Returns files for known symbols, empty for unknown.
 */
function makeStubGraph(symbolMap: Record<string, string[]>): ProbeOptions["graph"] {
  return {
    findSymbolFiles: async (id: string) => {
      const paths = symbolMap[id];
      if (!paths) return [];
      return paths.map((p) => ({ path: p, provenance: { from: id, to: p, type: "defines" as const, confidence: 0.8 } }));
    },
  } as unknown as ProbeOptions["graph"];
}

describe("query-probe", () => {
  it("returns off status when maxProbeAdded is 0", async () => {
    const result = await probeQuery("authentication", {
      maxProbeAdded: 0,
      graph: makeStubGraph({}),
    });
    expect(result.status).toBe("off");
    expect(result.addedPaths).toEqual([]);
  });

  it("extracts identifiers from a simple query", async () => {
    const result = await probeQuery("Authenticator", {
      maxProbeAdded: 4,
      graph: makeStubGraph({}),
    });
    expect(result.status).toBe("ok");
    expect(result.strategy).toBe("symbols");
    expect(result.inferredSymbols.length).toBeGreaterThan(0);
    expect(result.inferredSymbols).toContain("authenticator");
  });

  it("finds symbol definition files from the graph", async () => {
    const graph = makeStubGraph({
      authenticator: ["/repo/auth/authenticator.ts"],
      auth: ["/repo/auth/index.ts"],
    });
    const result = await probeQuery("Authenticator middleware", {
      maxProbeAdded: 4,
      graph,
    });
    expect(result.status).toBe("ok");
    expect(result.addedPaths).toContain("/repo/auth/authenticator.ts");
  });

  it("caps added paths at maxProbeAdded", async () => {
    const graph = makeStubGraph({
      authenticator: ["/repo/a.ts", "/repo/b.ts"],
      middleware: ["/repo/c.ts", "/repo/d.ts"],
      config: ["/repo/e.ts"],
    });
    const result = await probeQuery("authenticator middleware config", {
      maxProbeAdded: 2,
      graph,
    });
    expect(result.status).toBe("ok");
    expect(result.addedPaths.length).toBeLessThanOrEqual(2);
  });

  it("filters out common English words", async () => {
    const result = await probeQuery("find the function that handles auth", {
      maxProbeAdded: 4,
      graph: makeStubGraph({}),
    });
    expect(result.status).toBe("ok");
    // "find", "the", "function", "that", "handles" should be filtered
    // "auth" should remain
    expect(result.inferredSymbols).toContain("auth");
  });

  it("handles empty query gracefully", async () => {
    const result = await probeQuery("", {
      maxProbeAdded: 4,
      graph: makeStubGraph({}),
    });
    expect(result.status).toBe("ok");
    expect(result.inferredSymbols).toEqual([]);
    expect(result.addedPaths).toEqual([]);
  });

  it("handles graph error gracefully", async () => {
    const brokenGraph = {
      findSymbolFiles: async () => { throw new Error("graph not ready"); },
    } as unknown as ProbeOptions["graph"];

    const result = await probeQuery("authenticator", {
      maxProbeAdded: 4,
      graph: brokenGraph,
    });
    expect(result.status).toBe("ok");
    // Individual identifier failures are non-fatal
    expect(result.addedPaths).toEqual([]);
  });
});
