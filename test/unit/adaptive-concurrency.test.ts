import { describe, expect, it } from "vitest";
import { chooseConcurrency } from "../../src/adaptive-concurrency.js";

describe("adaptive concurrency", () => {
  it("returns one worker for tiny jobs", () => {
    expect(chooseConcurrency({ fileCount: 1, operation: "parse", cpuCount: 8, env: {} })).toBe(1);
  });

  it("bounds parse and io concurrency", () => {
    expect(chooseConcurrency({ fileCount: 1000, operation: "parse", cpuCount: 4, env: {} })).toBe(8);
    expect(chooseConcurrency({ fileCount: 1000, operation: "io", cpuCount: 4, env: {} })).toBe(16);
  });

  it("honors env override with cap", () => {
    expect(chooseConcurrency({ fileCount: 1000, operation: "parse", cpuCount: 4, env: { PI_SMARTREAD_CONCURRENCY: "200" } })).toBe(128);
  });
});
