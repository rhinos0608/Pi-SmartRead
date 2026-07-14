import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectResourceDiagnosticSample, startResourceDiagnostics, stopResourceDiagnostics, writeResourceDiagnosticSample } from "../../src/resource-diagnostics.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smartread-diag-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resource diagnostics", () => {
  it("collects process resource samples", () => {
    const sample = collectResourceDiagnosticSample();
    expect(sample.pid).toBe(process.pid);
    expect(sample.rss).toBeGreaterThan(0);
    expect(sample.heapUsed).toBeGreaterThan(0);
  });

  it("writes ndjson samples", () => {
    const path = writeResourceDiagnosticSample(root, {
      timestamp: 1,
      pid: 123,
      rss: 1,
      heapUsed: 2,
      heapTotal: 3,
      external: 4,
      arrayBuffers: 5,
      activeHandles: 6,
      fdCount: null,
    });
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8").trim()).toContain('"pid":123');
  });

  it("only starts interval when env enables diagnostics", () => {
    expect(startResourceDiagnostics(root, {})).toBeNull();
    const timer = startResourceDiagnostics(root, { PI_SMARTREAD_DIAGNOSTICS: "1" });
    expect(timer).not.toBeNull();
    clearInterval(timer!);
  });

  it("stopResourceDiagnostics clears active timer", () => {
    const timer = startResourceDiagnostics(root, { PI_SMARTREAD_DIAGNOSTICS: "1" });
    expect(timer).not.toBeNull();
    stopResourceDiagnostics();
    // Starting again should create a new timer (not leak)
    const timer2 = startResourceDiagnostics(root, { PI_SMARTREAD_DIAGNOSTICS: "1" });
    expect(timer2).not.toBeNull();
    expect(timer2).not.toBe(timer);
    clearInterval(timer2!);
  });

  it("start→stop→start cycle does not leak", () => {
    const t1 = startResourceDiagnostics(root, { PI_SMARTREAD_DIAGNOSTICS: "1" });
    stopResourceDiagnostics();
    const t2 = startResourceDiagnostics(root, { PI_SMARTREAD_DIAGNOSTICS: "1" });
    stopResourceDiagnostics();
    expect(t1).not.toBeNull();
    expect(t2).not.toBeNull();
    clearInterval(t1!);
    clearInterval(t2!);
  });
});
