import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { createReadTool } from "../../src/unified-read.js";
import { shownMatchesAttested } from "../../src/hook.js";
import { disposeSemanticIndexes, getOrCreateSemanticIndex } from "../../src/semantic-index-registry.js";
import { createGrepTool } from "../../src/grep-tool.js";

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

  it("rejects non-positive or fractional single-file line positions", async () => {
    const tool = createReadTool();
    await expect(tool.execute("t8", { path: "x.ts", offset: 1, limit: 0 } as any, undefined, undefined, makeCtx(dir, session))).rejects.toThrow(/positive integer/i);
    await expect(tool.execute("fractional", { path: "x.ts", offset: 1.5 } as any, undefined, undefined, makeCtx(dir, session))).rejects.toThrow(/positive integer/i);
  });

  it("raw mode emits no evidence", async () => {
    const tool = createReadTool();
    const res: any = await tool.execute("t9", { path: "x.ts:raw" }, undefined, undefined, makeCtx(dir, session));
    expect(res.details?.workspaceEvidence).toBeUndefined();
  });
});

describe("extended read modes", () => {
  let root: string;
  let session: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "extended-read-")));
    session = path.join(root, "session.jsonl");
    writeFileSync(path.join(root, "package.json"), "{}\n");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "test"], { cwd: root, stdio: "ignore" });
    writeFileSync(path.join(root, "a.ts"), "export const semanticNeedle = 'auth token';\n");
    writeFileSync(path.join(root, "b.ts"), "export const other = true;\n");
  });

  afterAll(() => {
    disposeSemanticIndexes();
    rmSync(root, { recursive: true, force: true });
  });

  it("includes context enrichment in multi-file output without changing source evidence", async () => {
    execFileSync("git", ["add", "package.json", "a.ts", "b.ts"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add batch files", "-m", "Constraint: keep batch evidence"], { cwd: root, stdio: "ignore" });
    const tool = createReadTool();
    const result: any = await tool.execute(
      "batch-enrichment",
      { paths: [{ path: "a.ts" }, { path: "b.ts" }] },
      undefined,
      undefined,
      makeCtx(root, session),
    );
    expect(result.content[0].text).toContain("Recent commits:");
    expect(result.content[0].text).toContain("add batch files");
    expect(result.content[0].text).toContain("Constraint: keep batch evidence");
    expect(result.details.workspaceEvidence.resources).toHaveLength(2);
    expect(result.details.workspaceEvidence.resources.every((resource: any) => resource.coverage === "full-file")).toBe(true);
  });

  it("keeps raw selectors raw in multi-file output and without evidence", async () => {
    const tool = createReadTool();
    const result: any = await tool.execute(
      "batch-raw",
      { paths: [{ path: "a.ts:raw" }] },
      undefined,
      undefined,
      makeCtx(root, session),
    );
    expect(result.content[0].text).toContain("export const semanticNeedle = 'auth token';");
    expect(result.content[0].text).not.toMatch(/^\d+[a-z]{0,2}\|/m);
    expect(result.content[0].text).not.toContain("🔍 Context for");
    expect(result.details.workspaceEvidence).toBeUndefined();
  });

  it("returns and publishes real-chain batch evidence for paths", async () => {
    const publish = vi.fn();
    const tool = createReadTool({ publishInspection: publish });
    const result: any = await tool.execute(
      "batch",
      { paths: [{ path: "a.ts" }, { path: "b.ts" }] },
      undefined,
      undefined,
      makeCtx(root, session),
    );
    expect(result.details.workspaceEvidence.resources).toHaveLength(2);
    expect(result.details.workspaceEvidence.resources.every((resource: any) => resource.coverage === "full-file")).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      result.details.workspaceEvidence,
      session,
      result.details.workspaceEvidence.canonicalWorkspaceRoot,
    );
  });

  it("returns strong evidence for shared hybrid query and grep+AST fallback query", async () => {
    disposeSemanticIndexes();
    const config = { baseUrl: "http://localhost:11434/v1", model: "test" };
    const index = getOrCreateSemanticIndex(root, {
      config,
      discoverFiles: (async () => ({ files: [path.join(root, "a.ts"), path.join(root, "b.ts")], diagnostics: {} as never })) as never,
      fetchEmbeddings: (async (request: { inputs: string[] }) => ({
        vectors: request.inputs.map((input) => /auth|semanticNeedle/i.test(input) ? [1, 0, 0, 0, 0] : [0, 1, 0, 0, 0]),
      })) as never,
    });
    await index.initialize();
    await index.updateIndex();

    const tool = createReadTool();
    const hybrid: any = await tool.execute("hybrid", { query: "semanticNeedle auth", topK: 1 }, undefined, undefined, makeCtx(root, session));
    expect(hybrid.details.retrievalStrategy).toBe("hybrid");
    expect(hybrid.details.workspaceEvidence.resources).toHaveLength(1);
    expect(hybrid.content[0].text).toContain("semanticNeedle");
    expect(hybrid.content[0].text).toContain("Recent commits:");

    disposeSemanticIndexes();
    const fallback: any = await tool.execute("fallback", { query: "semanticNeedle", topK: 1 }, undefined, undefined, makeCtx(root, session));
    expect(fallback.details.retrievalStrategy).toBe("fallback");
    expect(fallback.details.workspaceEvidence.resources).toHaveLength(1);
  });

  it("rejects conflicting and mode-invalid parameters", async () => {
    const tool = createReadTool();
    await expect(tool.execute("bad", { path: "a.ts", paths: [{ path: "b.ts" }] }, undefined, undefined, makeCtx(root, session))).rejects.toThrow(/exactly one/i);
    await expect(tool.execute("bad", { paths: [{ path: "a.ts" }], directory: "." }, undefined, undefined, makeCtx(root, session))).rejects.toThrow(/not valid/i);
    await expect(tool.execute("bad", { query: "auth", offset: 1 }, undefined, undefined, makeCtx(root, session))).rejects.toThrow(/not valid/i);
    await expect(tool.execute("fractional-batch", { paths: [{ path: "a.ts", limit: 2.5 }] } as any, undefined, undefined, makeCtx(root, session))).rejects.toThrow(/paths\[0\]\.limit.*positive integer/i);
    await expect(tool.execute("fractional-topk", { query: "auth", topK: 1.5 } as any, undefined, undefined, makeCtx(root, session))).rejects.toThrow(/topK.*positive integer/i);
  });

  it("does not authorize structurally summarized files", async () => {
    const summarized = [
      "export function hugeFunction() {",
      ...Array.from({ length: 900 }, (_, index) => `  const value${index} = ${index};`),
      "  return value899;",
      "}",
    ].join("\n");
    writeFileSync(path.join(root, "summarized.ts"), summarized);
    const tool = createReadTool();
    const result: any = await tool.execute(
      "summarized",
      { paths: [{ path: "summarized.ts" }] },
      undefined,
      undefined,
      makeCtx(root, session),
    );

    expect(result.content[0].text).toMatch(/lines 2-902 elided/);
    expect(result.details.workspaceEvidence).toBeUndefined();
  });

  it("does not authorize partial or omitted packed files", async () => {
    const huge = Array.from({ length: 3000 }, (_, index) => `line ${index} ${"x".repeat(40)}`).join("\n");
    writeFileSync(path.join(root, "huge.ts"), huge);
    const tool = createReadTool();
    const result: any = await tool.execute(
      "partial",
      { paths: [{ path: "a.ts" }, { path: "huge.ts" }] },
      undefined,
      undefined,
      makeCtx(root, session),
    );
    const authorized = result.details.workspaceEvidence.resources.map((resource: any) => resource.canonicalPath);
    expect(authorized).toContain(realpathSync(path.join(root, "a.ts")));
    expect(authorized).not.toContain(realpathSync(path.join(root, "huge.ts")));
    expect(result.details.packing.partialIncludedPath).toContain("huge.ts");
  });
});

describe("grep evidence envelopes", () => {
  let dir: string;
  let session: string;

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "grep-evidence-")));
    session = path.join(dir, "session.jsonl");
    writeFileSync(path.join(dir, "alpha.ts"), "export function authenticate() { return true; }\n");
    writeFileSync(path.join(dir, "beta.ts"), "export const auth = authenticate();\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("grep-produced envelope validates with mode query and coverage search-match", async () => {
    const tool = createGrepTool({});
    const ctx = {
      cwd: dir,
      sessionManager: { getSessionFile: () => session },
    } as any;
    const result: any = await tool.execute("g1", { pattern: "authenticate" }, undefined, undefined, ctx);
    const env = result.details?.workspaceEvidence;
    expect(env).toBeDefined();
    expect(validateInspectionEnvelope(env).ok).toBe(true);
    expect(env.mode).toBe("query");
    for (const resource of env.resources) {
      expect(resource.coverage).toBe("search-match");
    }
  });

  it("grep literal fallback produces valid envelope", async () => {
    const tool = createGrepTool({});
    const ctx = {
      cwd: dir,
      sessionManager: { getSessionFile: () => session },
    } as any;
    const result: any = await tool.execute("g2", { pattern: "authenticate", literal: true }, undefined, undefined, ctx);
    const env = result.details?.workspaceEvidence;
    expect(env).toBeDefined();
    expect(validateInspectionEnvelope(env).ok).toBe(true);
    expect(env.mode).toBe("query");
  });

  it("grep structural search produces valid envelope with search-match and structuralSearch details", async () => {
    writeFileSync(path.join(dir, "c.ts"), "console.log(a)\n", "utf8");
    const tool = createGrepTool({});
    const ctx = { cwd: dir, sessionManager: { getSessionFile: () => session } } as any;
    const result: any = await tool.execute("g-struct", { pattern: "console.log($ARG)", structural: {} } as any, undefined, undefined, ctx);
    expect(result.details.workspaceEvidence).toBeDefined();
    expect(validateInspectionEnvelope(result.details.workspaceEvidence).ok).toBe(true);
    expect(result.details.structuralSearch).toBeDefined();
    if (result.details.structuralSearch.status === "unavailable") {
      expect(result.details.structuralSearch.reason).toBeTruthy();
      expect(result.content[0].text).toContain("structural search unavailable");
    } else {
      expect(result.details.workspaceEvidence.resources[0].coverage).toBe("search-match");
      expect(result.content[0].text).toContain("read=");
    }
    const { _setUnavailableForTests, _resetAstGrepCacheForTests } = await import("../../src/structural-search.js");
    try {
      _setUnavailableForTests("forced unavailable for envelope test");
      const unav: any = await tool.execute("g-struct-unav", { pattern: "console.log($ARG)", structural: {} } as any, undefined, undefined, ctx);
      expect(unav.details.workspaceEvidence).toBeDefined();
      expect(validateInspectionEnvelope(unav.details.workspaceEvidence).ok).toBe(true);
      expect(unav.details.structuralSearch.status).toBe("unavailable");
      expect(unav.details.workspaceEvidence.resources.length).toBe(0);
    } finally {
      _resetAstGrepCacheForTests();
    }
  });
  it("grep zero matches produces valid envelope with zero resources in query mode", async () => {
    const tool = createGrepTool({});
    const ctx = {
      cwd: dir,
      sessionManager: { getSessionFile: () => session },
    } as any;
    const result: any = await tool.execute("g3", { pattern: "zzz_nonexistent_xyz123" }, undefined, undefined, ctx);
    const env = result.details?.workspaceEvidence;
    expect(env).toBeDefined();
    expect(validateInspectionEnvelope(env).ok).toBe(true);
    expect(env.mode).toBe("query");
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
