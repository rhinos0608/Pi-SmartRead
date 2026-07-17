import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAdr, readAdrs, listAdrs, renderAdr, writeAdr } from "../../src/adr-store.js";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "smartread-adr-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("ADR store", () => {
  it("renders and parses ADR markdown", () => {
    const text = renderAdr({ id: "2026-01-01-test", title: "Use snapshots", status: "accepted", date: "2026-01-01", tags: ["index"], context: "Cold starts hurt.", decision: "Use gzip snapshots.", consequences: "Need verification." });
    expect(parseAdr(text)).toMatchObject({ title: "Use snapshots", status: "accepted", decision: "Use gzip snapshots." });
  });

  it("writes and reads ADRs", () => {
    writeAdr(root, { id: "2026-01-01-use-snapshots", title: "Use snapshots", status: "accepted", date: "2026-01-01", tags: ["index"], context: "Context", decision: "Decision", consequences: "Consequences" });
    expect(readAdrs(root)).toHaveLength(1);
    expect(readAdrs(root)[0]?.id).toBe("2026-01-01-use-snapshots");
  });
});

describe("listAdrs filtering", () => {
  beforeEach(() => {
    writeAdr(root, { id: "2026-01-01-accepted", title: "Accepted ADR", status: "accepted", tags: ["auth", "security"], context: "c", decision: "d", consequences: "x" });
    writeAdr(root, { id: "2026-01-02-proposed", title: "Proposed ADR", status: "proposed", tags: ["index"], context: "c", decision: "d", consequences: "x" });
    writeAdr(root, { id: "2026-01-03-rejected", title: "Rejected ADR", status: "rejected", tags: ["auth"], context: "c", decision: "d", consequences: "x" });
  });

  it("returns all ADRs when no filter", () => {
    expect(listAdrs(root)).toHaveLength(3);
  });

  it("filters by status", () => {
    expect(listAdrs(root, { status: "accepted" })).toHaveLength(1);
    expect(listAdrs(root, { status: "accepted" })[0]?.id).toBe("2026-01-01-accepted");
    expect(listAdrs(root, { status: "proposed" })).toHaveLength(1);
    expect(listAdrs(root, { status: "rejected" })).toHaveLength(1);
  });

  it("filters by tags", () => {
    expect(listAdrs(root, { tags: ["auth"] })).toHaveLength(2);
    expect(listAdrs(root, { tags: ["security"] })).toHaveLength(1);
    expect(listAdrs(root, { tags: ["index"] })).toHaveLength(1);
  });

  it("filters by both status and tags (AND)", () => {
    expect(listAdrs(root, { status: "accepted", tags: ["auth"] })).toHaveLength(1);
    expect(listAdrs(root, { status: "accepted", tags: ["index"] })).toHaveLength(0);
  });

  it("returns empty array when no match", () => {
    expect(listAdrs(root, { status: "superseded" })).toHaveLength(0);
    expect(listAdrs(root, { tags: ["nonexistent"] })).toHaveLength(0);
  });
});
