import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearEnricherCache,
  getGraphifyEnricher,
  GraphifyEnricher,
} from "../../src/graphify-enricher.js";

const TEST_CWD = mkdtempSync(join(tmpdir(), "graphify-enricher-test-"));

function writeGraph(
  dir: string,
  graph: {
    nodes: Array<{ id: string; label?: string; source_file?: string; community?: number }>;
    links: Array<{ source: string; target: string; relation?: string }>;
  },
) {
  const graphDir = join(dir, "graphify-out");
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, "graph.json"), JSON.stringify(graph));
}

describe("GraphifyEnricher community detection", () => {
  beforeAll(() => {
    // Two disconnected K3 clusters with no pre-computed communities
    writeGraph(TEST_CWD, {
      nodes: [
        { id: "a", label: "alpha", source_file: "src/a.ts" },
        { id: "b", label: "beta", source_file: "src/b.ts" },
        { id: "c", label: "gamma", source_file: "src/c.ts" },
        { id: "d", label: "delta", source_file: "src/d.ts" },
        { id: "e", label: "epsilon", source_file: "src/e.ts" },
        { id: "f", label: "zeta", source_file: "src/f.ts" },
      ],
      links: [
        { source: "a", target: "b" },
        { source: "b", target: "c" },
        { source: "c", target: "a" },
        { source: "d", target: "e" },
        { source: "e", target: "f" },
        { source: "f", target: "d" },
      ],
    });
  });

  afterAll(() => {
    clearEnricherCache();
    rmSync(TEST_CWD, { recursive: true, force: true });
  });

  it("detects communities when graph.json has none", () => {
    const enricher = new GraphifyEnricher(TEST_CWD);
    const communities = enricher.detectCommunities();
    expect(communities.size).toBe(6);
    // a, b, c form one community
    expect(communities.get("a")).toBe(communities.get("b"));
    expect(communities.get("b")).toBe(communities.get("c"));
    // d, e, f form another
    expect(communities.get("d")).toBe(communities.get("e"));
    expect(communities.get("e")).toBe(communities.get("f"));
    // The two groups are distinct
    expect(communities.get("a")).not.toBe(communities.get("d"));
  });

  it("caches detected communities (same resolution returns same result)", () => {
    const enricher = new GraphifyEnricher(TEST_CWD);
    const c1 = enricher.detectCommunities({ resolution: 1.0 });
    const c2 = enricher.detectCommunities({ resolution: 1.0 });
    expect(c1).toBe(c2); // same Map instance = cached
  });

  it("re-detects with different resolution", () => {
    const enricher = new GraphifyEnricher(TEST_CWD);
    enricher.detectCommunities({ resolution: 1.0 });
    const c2 = enricher.detectCommunities({ resolution: 5.0 });
    // At higher resolution, more (smaller) communities
    const numHigh = new Set(c2.values()).size;
    expect(numHigh).toBeGreaterThanOrEqual(2);
  });

  it("getFileCommunity falls back to detected communities when graph.json has none", () => {
    const enricher = new GraphifyEnricher(TEST_CWD);
    const aComm = enricher.getFileCommunity(join(TEST_CWD, "src/a.ts"));
    const dComm = enricher.getFileCommunity(join(TEST_CWD, "src/d.ts"));
    expect(aComm).toBeDefined();
    expect(dComm).toBeDefined();
    expect(aComm).not.toBe(dComm);
  });

  it("getCommunityFiles returns files for a detected community", () => {
    const enricher = new GraphifyEnricher(TEST_CWD);
    const aComm = enricher.getFileCommunity(join(TEST_CWD, "src/a.ts"));
    expect(aComm).toBeDefined();
    const files = enricher.getCommunityFiles(aComm!);
    expect(files.length).toBe(3);
    // Should include a.ts, b.ts, c.ts
    const relFiles = files.map(f => f.replace(TEST_CWD + "/", ""));
    expect(relFiles).toContain("src/a.ts");
    expect(relFiles).toContain("src/b.ts");
    expect(relFiles).toContain("src/c.ts");
  });

  it("communityCount reflects detected communities when graph.json has none", () => {
    const enricher = new GraphifyEnricher(TEST_CWD);
    const count = enricher.communityCount;
    expect(count).toBe(2);
  });

  it("getCommunityStats returns stats for detected communities", () => {
    const enricher = new GraphifyEnricher(TEST_CWD);
    const stats = enricher.getCommunityStats();
    expect(stats.length).toBe(2);
    for (const s of stats) {
      expect(s.size).toBe(3);
      expect(typeof s.id).toBe("number");
      expect(typeof s.modularity).toBe("number");
    }
  });
});

describe("GraphifyEnricher with pre-computed communities", () => {
  const CWD = mkdtempSync(join(tmpdir(), "graphify-precomputed-"));

  beforeAll(() => {
    writeGraph(CWD, {
      nodes: [
        { id: "a", label: "alpha", source_file: "src/a.ts", community: 0 },
        { id: "b", label: "beta", source_file: "src/b.ts", community: 0 },
        { id: "c", label: "gamma", source_file: "src/c.ts", community: 1 },
        { id: "d", label: "delta", source_file: "src/d.ts", community: 1 },
      ],
      links: [
        { source: "a", target: "b" },
        { source: "b", target: "a" },
        { source: "c", target: "d" },
        { source: "d", target: "c" },
      ],
    });
  });

  afterAll(() => {
    clearEnricherCache();
    rmSync(CWD, { recursive: true, force: true });
  });

  it("uses pre-computed communities from graph.json", () => {
    const enricher = new GraphifyEnricher(CWD);
    const aComm = enricher.getFileCommunity(join(CWD, "src/a.ts"));
    const cComm = enricher.getFileCommunity(join(CWD, "src/c.ts"));
    expect(aComm).toBe(0);
    expect(cComm).toBe(1);
  });

  it("getCommunityStats uses pre-computed communities when available", () => {
    const enricher = new GraphifyEnricher(CWD);
    const stats = enricher.getCommunityStats();
    expect(stats.length).toBe(2);
    expect(stats.find(s => s.id === 0)?.size).toBe(2);
    expect(stats.find(s => s.id === 1)?.size).toBe(2);
  });
});

describe("getGraphifyEnricher cache", () => {
  const CWD = mkdtempSync(join(tmpdir(), "graphify-cache-"));

  beforeAll(() => {
    writeGraph(CWD, {
      nodes: [
        { id: "a", label: "alpha", source_file: "src/a.ts" },
        { id: "b", label: "beta", source_file: "src/b.ts" },
      ],
      links: [{ source: "a", target: "b" }, { source: "b", target: "a" }],
    });
  });

  afterAll(() => {
    clearEnricherCache();
    rmSync(CWD, { recursive: true, force: true });
  });

  it("returns the same instance for the same cwd", () => {
    const e1 = getGraphifyEnricher(CWD);
    const e2 = getGraphifyEnricher(CWD);
    expect(e1).toBe(e2);
  });
});
