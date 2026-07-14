import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAdr, readAdrs, renderAdr, writeAdr } from "../../src/adr-store.js";

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
