import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { computePathEvidence, computeStructuralOutlineEvidence } from "../../src/path-evidence.js";

describe("computePathEvidence", () => {
  let dir: string;
  const session = "/tmp/fake-session.jsonl";

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "path-evidence-")));
    writeFileSync(path.join(dir, "x.ts"), "line1\nline2\nline3\nline4\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("full read produces a valid full-file envelope", () => {
    const r = computePathEvidence({ path: "x.ts", cwd: dir, sessionFilePath: session });
    const v = validateInspectionEnvelope(r.workspaceEvidence);
    expect(v.ok).toBe(true);
    const res = r.workspaceEvidence.resources[0]!;
    expect(r.workspaceEvidence.mode).toBe("path");
    expect(res.coverage).toBe("full-file");
    expect(res.fresh).toBe(true);
    const expectedSha = createHash("sha256")
      .update("line1\nline2\nline3\nline4\n", "utf8").digest("hex");
    expect(res.fullFileSha256).toBe(expectedSha);
    expect(r.contentText.startsWith("1: line1")).toBe(true);
    expect(r.truncated).toBe(false);
    // totalLines = content.split("\n").length = 5 (trailing \n yields empty last element)
    expect(r.totalLines).toBe(5);
  });

  it("offset/limit produces line-range coverage carrying fullFileSha256", () => {
    const r = computePathEvidence({ path: "x.ts", offset: 2, limit: 2, cwd: dir, sessionFilePath: session });
    const res = r.workspaceEvidence.resources[0]!;
    expect(res.coverage).toBe("line-range");
    expect(res.allowedRanges).toEqual([{ startLine: 2, endLine: 3 }]);
    expect(res.fullFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.truncated).toBe(true);
    expect(r.contentText.startsWith("2: line2")).toBe(true);
    expect(r.sliceText).toBe("line2\nline3");
  });

  it("sliceText for a full read is the exact file content", () => {
    const r = computePathEvidence({ path: "x.ts", cwd: dir, sessionFilePath: session });
    expect(r.sliceText).toBe("line1\nline2\nline3\nline4\n");
  });

  it("rejects non-positive or fractional offset/limit", () => {
    expect(() => computePathEvidence({ path: "x.ts", limit: 0, cwd: dir, sessionFilePath: session })).toThrow(/positive integer/);
    expect(() => computePathEvidence({ path: "x.ts", limit: -3, cwd: dir, sessionFilePath: session })).toThrow(/positive integer/);
    expect(() => computePathEvidence({ path: "x.ts", offset: 1.5, cwd: dir, sessionFilePath: session })).toThrow(/positive integer/);
    expect(() => computePathEvidence({ path: "x.ts", offset: 0, cwd: dir, sessionFilePath: session })).toThrow(/positive integer/);
  });

  it("rejects missing files and empty session paths", () => {
    expect(() => computePathEvidence({ path: "nope.ts", cwd: dir, sessionFilePath: session })).toThrow(/not readable/);
    expect(() => computePathEvidence({ path: "x.ts", cwd: dir, sessionFilePath: "" })).toThrow(/session/);
  });

  it("directs directory inputs to inspect map mode", () => {
    expect(() =>
      computePathEvidence({ path: ".", cwd: dir, sessionFilePath: session }),
    ).toThrow(/not a regular file/);
  });
});

describe("computeStructuralOutlineEvidence", () => {
  let dir: string;
  const session = "/tmp/fake-session.jsonl";
  const content = "line1\nline2\nline3\nline4\nline5\n";

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "outline-evidence-")));
    writeFileSync(path.join(dir, "x.ts"), content);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("produces one single-line range resource per declaration line, never full-file", () => {
    const r = computeStructuralOutlineEvidence({
      path: "x.ts", cwd: dir, sessionFilePath: session,
      fullContent: content, declarationLines: [1, 3],
    });
    const v = validateInspectionEnvelope(r.workspaceEvidence);
    expect(v.ok).toBe(true);
    expect(r.workspaceEvidence.mode).toBe("path");
    expect(r.workspaceEvidence.resources).toHaveLength(2);
    for (const res of r.workspaceEvidence.resources) {
      expect(res.coverage).toBe("line-range");
      expect(res.kind).toBe("range");
      expect(res.allowedRanges[0]!.startLine).toBe(res.allowedRanges[0]!.endLine);
      expect(res.fullFileSha256).toBe(r.fullFileSha256);
    }
    const startLines = r.workspaceEvidence.resources.map((res) => res.allowedRanges[0]!.startLine).sort();
    expect(startLines).toEqual([1, 3]);
  });

  it("never emits a full-file coverage resource regardless of how many lines are declared", () => {
    const r = computeStructuralOutlineEvidence({
      path: "x.ts", cwd: dir, sessionFilePath: session,
      fullContent: content, declarationLines: [1, 2, 3, 4, 5],
    });
    expect(r.workspaceEvidence.resources.every((res) => res.coverage === "line-range")).toBe(true);
    expect(r.workspaceEvidence.resources.every((res) => res.kind === "range")).toBe(true);
  });

  it("deduplicates repeated declaration lines", () => {
    const r = computeStructuralOutlineEvidence({
      path: "x.ts", cwd: dir, sessionFilePath: session,
      fullContent: content, declarationLines: [2, 2, 2],
    });
    expect(r.workspaceEvidence.resources).toHaveLength(1);
  });

  it("produces zero resources (no authority) for an empty declaration set", () => {
    const r = computeStructuralOutlineEvidence({
      path: "x.ts", cwd: dir, sessionFilePath: session,
      fullContent: content, declarationLines: [],
    });
    expect(r.workspaceEvidence.resources).toHaveLength(0);
  });

  it("rejects an empty session file path", () => {
    expect(() => computeStructuralOutlineEvidence({
      path: "x.ts", cwd: dir, sessionFilePath: "", fullContent: content, declarationLines: [1],
    })).toThrow(/session/);
  });

  it("a range-mode single-line read produces the same resourceId as the outline's line resource", () => {
    const outline = computeStructuralOutlineEvidence({
      path: "x.ts", cwd: dir, sessionFilePath: session, fullContent: content, declarationLines: [2],
    });
    const directRead = computePathEvidence({ path: "x.ts", offset: 2, limit: 1, cwd: dir, sessionFilePath: session });
    expect(outline.workspaceEvidence.resources[0]!.resourceId).toBe(directRead.workspaceEvidence.resources[0]!.resourceId);
  });
});
