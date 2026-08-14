import { describe, expect, it, vi, beforeEach } from "vitest";

const getStatsForRoot = vi.fn(() => null);
const getStats = vi.fn(() => ({
  managerCount: 1,
  connectionsByRoot: { "/other/workspace": 1 },
  totalOpenDocuments: 0,
}));

vi.mock("../../src/lsp-bridge.js", () => ({
  getLSPBridge: vi.fn(async () => ({ getStatsForRoot, getStats })),
}));
vi.mock("../../src/semantic-index-registry.js", () => ({
  getSemanticIndex: vi.fn(() => null),
}));
vi.mock("../../src/config.js", () => ({
  validateEmbeddingConfig: vi.fn(() => null),
}));

const {
  getRuntimeHealth,
  recentDegradations,
  recordDegradation,
  resetRuntimeHealth,
} = await import("../../src/runtime-health.js");

describe("runtime health integrity", () => {
  beforeEach(() => {
    resetRuntimeHealth();
    getStatsForRoot.mockClear();
    getStats.mockClear();
  });

  it("does not report another workspace's LSP manager for the current root", async () => {
    const report = await getRuntimeHealth("/current/workspace", () => ({ active: false, dirty: false }));

    expect(report.lsp.available).toBe(false);
    expect(report.lsp.stats).toBeUndefined();
    expect(getStatsForRoot).toHaveBeenCalledWith("/current/workspace");
    expect(getStats).not.toHaveBeenCalled();
  });

  it("queries graph state with the health request root and does not use global generation", async () => {
    const getGraphState = vi.fn((root: string) => ({
      built: root === "/current/workspace",
      generation: root === "/current/workspace" ? 7 : 0,
    }));

    const report = await getRuntimeHealth("/current/workspace", () => ({ active: false, dirty: false }), getGraphState);
    expect(getGraphState).toHaveBeenCalledWith("/current/workspace");
    expect(report.graph).toEqual({ built: true, generation: 7 });

    const other = await getRuntimeHealth("/other/workspace", () => ({ active: false, dirty: false }), getGraphState);
    expect(other.graph).toEqual({ built: false, generation: 0 });
  });

  it("coalesces repeated identical degradation records", () => {
    recordDegradation("index_unavailable", "semantic");
    recordDegradation("index_unavailable", "semantic");
    recordDegradation("index_unavailable", "semantic");

    expect(recentDegradations()).toHaveLength(1);
  });
});
