import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { computePathEvidence } from "../../src/path-evidence.js";

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
