import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { createReadTool } from "../../unified-read.js";
import { shownMatchesAttested } from "../../hook.js";

function makeCtx(cwd: string, sessionFile: string | null) {
  return {
    cwd,
    sessionManager: sessionFile ? { getSessionFile: () => sessionFile } : undefined,
  } as any;
}

describe("read tool workspace evidence", () => {
  let dir: string;
  let session: string;

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "read-evidence-")));
    session = path.join(dir, "session.jsonl");
    writeFileSync(path.join(dir, "x.ts"), "line1\nline2\nline3\nline4\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("full read attaches a valid full-file envelope and publishes it", async () => {
    const publish = vi.fn();
    const tool = createReadTool({ publishInspection: publish });
    const res: any = await tool.execute("t1", { path: "x.ts" }, undefined, undefined, makeCtx(dir, session));
    const env = res.details.workspaceEvidence;
    expect(env).toBeDefined();
    expect(validateInspectionEnvelope(env).ok).toBe(true);
    expect(env.mode).toBe("path");
    expect(env.resources[0].coverage).toBe("full-file");
    expect(env.resources[0].fresh).toBe(true);
    expect(publish).toHaveBeenCalledWith(env, session, env.canonicalWorkspaceRoot);
  });

  it("offset/limit read attaches line-range coverage", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t2", { path: "x.ts", offset: 2, limit: 2 }, undefined, undefined, makeCtx(dir, session));
    const env = res.details.workspaceEvidence;
    expect(env.resources[0].coverage).toBe("line-range");
    expect(env.resources[0].allowedRanges).toEqual([{ startLine: 2, endLine: 3 }]);
    expect(env.resources[0].fullFileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("selector syntax path:2-3 attaches the same line-range coverage", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t3", { path: "x.ts:2-3" }, undefined, undefined, makeCtx(dir, session));
    const env = res.details.workspaceEvidence;
    expect(env.resources[0].coverage).toBe("line-range");
    expect(env.resources[0].allowedRanges).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it("no session file → no evidence, read still succeeds", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t4", { path: "x.ts" }, undefined, undefined, makeCtx(dir, null));
    expect(res.details?.workspaceEvidence).toBeUndefined();
    expect(res.content[0].text).toContain("line1");
  });

  it("publish failure never blocks the read", async () => {
    const tool = createReadTool({ publishInspection: () => { throw new Error("boom"); } });
    const res: any = await tool.execute("t5", { path: "x.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details.workspaceEvidence).toBeDefined();
  });

  it("builtin truncation clamps coverage to the shown lines, never full-file", async () => {
    // 3000 short lines > DEFAULT_MAX_LINES (2000) → builtin read truncates by lines.
    const big = Array.from({ length: 3000 }, (_, i) => `l${i + 1}`).join("\n");
    writeFileSync(path.join(dir, "big.ts"), big);
    const tool = createReadTool();
    const res: any = await tool.execute("t6", { path: "big.ts" }, undefined, undefined, makeCtx(dir, session));
    const trunc = res.details.truncation;
    expect(trunc.truncated).toBe(true);
    const env = res.details.workspaceEvidence;
    expect(env.resources[0].coverage).toBe("line-range");
    expect(env.resources[0].allowedRanges).toEqual([{ startLine: 1, endLine: trunc.outputLines }]);
  });

  it("first line exceeding the byte limit → no evidence (zero lines shown)", async () => {
    writeFileSync(path.join(dir, "wide.ts"), "x".repeat(60 * 1024));
    const tool = createReadTool();
    const res: any = await tool.execute("t7", { path: "wide.ts" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details?.workspaceEvidence).toBeUndefined();
  });

  it("limit: 0 → no evidence (nothing shown, nothing authorized)", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t8", { path: "x.ts", offset: 1, limit: 0 }, undefined, undefined, makeCtx(dir, session));
    expect(res.details?.workspaceEvidence).toBeUndefined();
  });

  it("raw mode emits no evidence", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t9", { path: "x.ts:raw" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details?.workspaceEvidence).toBeUndefined();
  });
});

describe("shownMatchesAttested", () => {
  it("exact match (same text, same file)", () => {
    expect(shownMatchesAttested({
      builtinText: "hello",
      truncationContent: undefined,
      sliceText: "hello",
      totalLines: 5,
      evidenceOffset: undefined,
      evidenceLimit: undefined,
    })).toBe(true);
  });

  it("adversarial regression: suffix that looks like a note but isn't", () => {
    // Old regex would strip '\n\n[old content removed]' and claim match.
    // With reconstruction, evidenceLimit is undefined so the method returns false.
    expect(shownMatchesAttested({
      builtinText: "safe\n\n[old content removed]",
      truncationContent: undefined,
      sliceText: "safe",
      totalLines: 3,
      evidenceOffset: undefined,
      evidenceLimit: undefined,
    })).toBe(false);
  });

  it("adversarial: trailing note with no evidenceLimit is false", () => {
    // Even if builtinText has what looks like a continuation note,
    // when evidenceLimit is undefined the reconstructed note cannot be
    // built → must be false.
    expect(shownMatchesAttested({
      builtinText: "line1\n\n[5 more lines in file. Use offset=3 to continue.]",
      truncationContent: undefined,
      sliceText: "line1",
      totalLines: 7,
      evidenceOffset: undefined,
      evidenceLimit: undefined,
    })).toBe(false);
  });

  it("exact note acceptance (limited read with continuation)", () => {
    // 7-line file, offset=1, limit=2 → shown lines 1-2, remaining 5.
    // builtinText = sliceText + the reconstructed note.
    const sliceText = "line1\nline2";
    const note = "\n\n[5 more lines in file. Use offset=3 to continue.]";
    const builtinText = sliceText + note;
    expect(shownMatchesAttested({
      builtinText,
      truncationContent: undefined,
      sliceText,
      totalLines: 7,
      evidenceOffset: 1,
      evidenceLimit: 2,
    })).toBe(true);
  });

  it("wrong numbers in note → false", () => {
    // File had 7 lines, offset=1, limit=2 → remaining=5, endLine=2.
    // But builtinText has a note claiming different numbers.
    const sliceText = "line1\nline2";
    const fakeNote = "\n\n[99 more lines in file. Use offset=100 to continue.]";
    const builtinText = sliceText + fakeNote;
    expect(shownMatchesAttested({
      builtinText,
      truncationContent: undefined,
      sliceText,
      totalLines: 7,
      evidenceOffset: 1,
      evidenceLimit: 2,
    })).toBe(false);
  });

  it("truncated case compares truncation.content directly", () => {
    // When truncation happened, truncationContent is the raw shown bytes.
    const truncationContent = "line1\nline2";
    expect(shownMatchesAttested({
      builtinText: "unused text that the model didn't see",
      truncationContent,
      sliceText: "line1\nline2",
      totalLines: 3000,
      evidenceOffset: undefined,
      evidenceLimit: undefined,
    })).toBe(true);
    expect(shownMatchesAttested({
      builtinText: "unused",
      truncationContent,
      sliceText: "different text",
      totalLines: 3000,
      evidenceOffset: undefined,
      evidenceLimit: undefined,
    })).toBe(false);
  });

  it("remaining <= 0 → false (no note to expect)", () => {
    // offset=1, limit=7 on a 7-line file → endLine=7, remaining=0 → no note.
    // So builtinText must === sliceText exactly. A note suffix → false.
    const sliceText = "l1\nl2\nl3\nl4\nl5\nl6\nl7";
    expect(shownMatchesAttested({
      builtinText: sliceText,
      truncationContent: undefined,
      sliceText,
      totalLines: 7,
      evidenceOffset: 1,
      evidenceLimit: 7,
    })).toBe(true);
    // With a trailing note → false (remaining=0 → no note expected)
    expect(shownMatchesAttested({
      builtinText: sliceText + "\n\n[0 more lines in file. Use offset=8 to continue.]",
      truncationContent: undefined,
      sliceText,
      totalLines: 7,
      evidenceOffset: 1,
      evidenceLimit: 7,
    })).toBe(false);
  });

  it("evidenceLimit is undefined but text differs → false", () => {
    expect(shownMatchesAttested({
      builtinText: "some content",
      truncationContent: undefined,
      sliceText: "other content",
      totalLines: 5,
      evidenceOffset: undefined,
      evidenceLimit: undefined,
    })).toBe(false);
  });
});
