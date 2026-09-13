import { beforeEach, describe, expect, it } from "vitest";

const {
  recentDegradations,
  recordDegradation,
  resetRuntimeHealth,
} = await import("../../src/runtime-health.js");

describe("retrieval degradation tracking", () => {
  beforeEach(() => {
    resetRuntimeHealth();
  });

  it("coalesces repeated identical degradation records", () => {
    recordDegradation("index_unavailable", "semantic");
    recordDegradation("index_unavailable", "semantic");
    recordDegradation("index_unavailable", "semantic");

    expect(recentDegradations()).toHaveLength(1);
  });
});
