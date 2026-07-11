import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_RESOURCES, resolveResource } from "../../mcp-resources.js";
import { recordCoverage } from "../../index-coverage.js";
import { writeAdr } from "../../adr-store.js";

let root: string;
let oldCwd: string;

beforeEach(() => {
  oldCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "smartread-resources-"));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(oldCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("MCP resources", () => {
  it("lists coverage, ADR, and near-clone resources", () => {
    const uris = MCP_RESOURCES.map((r) => r.uri);
    expect(uris).toContain("smartread://repo/index/coverage");
    expect(uris).toContain("smartread://repo/adrs");
    expect(uris).toContain("smartread://repo/near-clones");
  });

  it("resolves index coverage and ADR resources", async () => {
    recordCoverage(root, { file: "a.ts", phase: "tags", status: "indexed" });
    writeAdr(root, { id: "2026-01-01-test", title: "Test", status: "accepted", date: "2026-01-01", tags: [], context: "c", decision: "d", consequences: "e" });

    const coverage = JSON.parse((await resolveResource("smartread://repo/index/coverage")).text) as { summary: { total: number } };
    const adrs = JSON.parse((await resolveResource("smartread://repo/adrs")).text) as { records: Array<{ id: string }> };

    expect(coverage.summary.total).toBe(1);
    expect(adrs.records[0]?.id).toBe("2026-01-01-test");
  });

  it("resolves near-clone resource with fileCount and clones", async () => {
    mkdirSync(require("node:path").join(root, "src"), { recursive: true });
    writeFileSync(require("node:path").join(root, "src", "a.ts"), "export function add(x: number, y: number): number { return x + y; }");
    writeFileSync(require("node:path").join(root, "src", "b.ts"), "export function add(a: number, b: number): number { return a + b; }");

    const clones = JSON.parse((await resolveResource("smartread://repo/near-clones")).text) as { fileCount: number; clones: Array<{ a: string; b: string; jaccard: number }> };
    expect(clones.fileCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(clones.clones)).toBe(true);
  });
});
