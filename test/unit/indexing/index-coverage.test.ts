import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCoverage, recordCoverage, summarizeCoverage, writeCoverage } from "../../../src/indexing/index-coverage.js";

let root: string;

// F4 behaviour change: coverage persists only at a canonical state root, so
// the fixture declares its temp dir a project (non-git marker) root — the
// round-trip assertions below encoded the old markerless-root persistence.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smartread-coverage-"));
  writeFileSync(join(root, "package.json"), "{}\n");
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("index coverage", () => {
  it("records and summarizes coverage status", () => {
    recordCoverage(root, { file: "a.ts", phase: "tags", status: "indexed" });
    recordCoverage(root, { file: "b.ts", phase: "tags", status: "parse_error", reason: "ERROR node" });
    const records = readCoverage(root);
    expect(records).toHaveLength(2);
    expect(summarizeCoverage(records)).toEqual({ total: 2, byStatus: { indexed: 1, parse_error: 1 }, problematic: 1 });
  });

  it("replaces existing file/phase records", () => {
    recordCoverage(root, { file: "a.ts", phase: "tags", status: "parse_error" });
    recordCoverage(root, { file: "a.ts", phase: "tags", status: "indexed" });
    expect(readCoverage(root).map((r) => r.status)).toEqual(["indexed"]);
  });

  it("writeCoverage merges cross-phase records", () => {
    recordCoverage(root, { file: "a.ts", phase: "tags", status: "indexed" });
    writeCoverage(root, [{ file: "a.ts", phase: "graph", status: "partial", updatedAt: Date.now() }]);
    const records = readCoverage(root);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.phase === "tags")?.status).toBe("indexed");
    expect(records.find((r) => r.phase === "graph")?.status).toBe("partial");
  });
});
