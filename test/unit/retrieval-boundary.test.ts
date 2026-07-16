import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeInspectV4 } from "../../src/inspect.js";
import { computePathEvidence } from "../../src/path-evidence.js";
import { createRepoTool } from "../../src/repomap-tool.js";
import { createReadTool } from "../../src/unified-read.js";
import { retrieveQuery } from "../../src/query-retrieval.js";

function makeCtx(cwd: string, sessionFile: string) {
  return { cwd, sessionManager: { getSessionFile: () => sessionFile } } as any;
}

describe("cross-workspace retrieval (no allowed-root gating)", () => {
  let root: string;
  let allowed: string;
  let outside: string;
  let sessionFile: string;
  let previousAllowedRoot: string | undefined;
  let previousCbmAllowedRoot: string | undefined;

  beforeEach(() => {
    previousAllowedRoot = process.env.PI_SMARTREAD_ALLOWED_ROOT;
    previousCbmAllowedRoot = process.env.CBM_ALLOWED_ROOT;
    delete process.env.CBM_ALLOWED_ROOT;

    root = realpathSync(mkdtempSync(join(tmpdir(), "smartread-retrieval-boundary-")));
    allowed = join(root, "allowed");
    outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(allowed, "inside.ts"), "export function boundarySharedSymbol() { return 'inside'; }\n");
    writeFileSync(join(outside, "outside.ts"), "export function boundarySharedSymbol() { return 'outside'; }\n");
    sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, "", { mode: 0o600 });
    process.env.PI_SMARTREAD_ALLOWED_ROOT = allowed;
  });

  afterEach(() => {
    if (previousAllowedRoot === undefined) delete process.env.PI_SMARTREAD_ALLOWED_ROOT;
    else process.env.PI_SMARTREAD_ALLOWED_ROOT = previousAllowedRoot;
    if (previousCbmAllowedRoot === undefined) delete process.env.CBM_ALLOWED_ROOT;
    else process.env.CBM_ALLOWED_ROOT = previousCbmAllowedRoot;
    rmSync(root, { recursive: true, force: true });
  });

  it("allows single reads outside allowed root with strong evidence", async () => {
    const tool = createReadTool();
    const ctx = makeCtx(root, sessionFile);

    // Inside reads still work
    const inside = await tool.execute("inside", { path: "allowed/inside.ts" }, undefined, undefined, ctx) as any;
    expect(inside.content[0].text).toContain("boundarySharedSymbol");
    expect(inside.details.workspaceEvidence.resources[0].canonicalPath).toBe(realpathSync(join(allowed, "inside.ts")));

    // Outside reads now succeed (no allowed-root gating)
    const outsideResult = await tool.execute("outside", { path: "outside/outside.ts" }, undefined, undefined, ctx) as any;
    expect(outsideResult.content[0].text).toContain("boundarySharedSymbol");
    expect(outsideResult.details.workspaceEvidence.resources[0].canonicalPath).toBe(realpathSync(join(outside, "outside.ts")));

    // Raw reads outside also succeed
    const rawOutside = await tool.execute("raw-outside", { path: "outside/outside.ts:raw" }, undefined, undefined, ctx) as any;
    expect(rawOutside.content[0].text).toContain("boundarySharedSymbol");
  });

  it("allows direct evidence computation outside allowed root", () => {
    const evidence = computePathEvidence({
      path: "outside/outside.ts",
      cwd: root,
      sessionFilePath: sessionFile,
    });
    expect(evidence.workspaceEvidence.resources[0]?.canonicalPath).toBe(realpathSync(join(outside, "outside.ts")));
    expect(evidence.contentText).toContain("boundarySharedSymbol");
  });

  it("allows batch paths outside allowed root", async () => {
    const tool = createReadTool();
    const ctx = makeCtx(root, sessionFile);

    const result = await tool.execute("batch", {
      paths: [
        { path: "allowed/inside.ts" },
        { path: "outside/outside.ts" },
      ],
    }, undefined, undefined, ctx) as any;
    const text = result.content[0].text;
    expect(text).toContain("inside.ts");
    expect(text).toContain("outside.ts");
    expect(text).toContain("boundarySharedSymbol");
  });

  it("allows file inspect outside allowed root", async () => {
    // File inspect in outside directory succeeds
    const result = await executeInspectV4({
      path: "outside/outside.ts",
      cwd: root,
      sessionFilePath: sessionFile,
    });

    expect(result.contentText).toContain("outside.ts");
    expect(result.workspaceEvidence.mode).toBe("symbol");
    expect(result.workspaceEvidence.resources.length).toBeGreaterThanOrEqual(0);
  });

  it("allows inspect map outside allowed root", async () => {
    const result = await executeInspectV4({
      path: "outside",
      cwd: root,
      sessionFilePath: sessionFile,
    });
    expect(result.contentText).not.toContain("inside.ts");
    // Map should show outside directory content
    expect(result.contentText).toContain("outside.ts");
  });

  it("allows repomap tool outside allowed root", async () => {
    const repoTool = createRepoTool();
    const result = await repoTool.execute(
      "outside-map",
      { directory: "outside" },
      undefined,
      undefined,
      makeCtx(root, sessionFile),
    ) as any;
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("outside.ts");
  });

  it("allows query with explicit directory outside project root", async () => {
    // Query with explicit directory outside the project root
    // Uses grep+AST fallback since no semantic index exists for outside dir
    const result = await retrieveQuery({
      query: "boundarySharedSymbol",
      cwd: root,
      directory: "outside",
      topK: 10,
      toolCallId: "test-query-outside",
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.absolutePath.includes("outside.ts"))).toBe(true);
    expect(result.hits.some((h) => h.absolutePath.includes("inside.ts"))).toBe(false);
  });

  it("allows query with explicit directory inside project root", async () => {
    const result = await retrieveQuery({
      query: "boundarySharedSymbol",
      cwd: root,
      directory: "allowed",
      topK: 10,
      toolCallId: "test-query-inside",
    });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.absolutePath.includes("inside.ts"))).toBe(true);
    expect(result.hits.some((h) => h.absolutePath.includes("outside.ts"))).toBe(false);
  });

  it("allows query with no directory (cwd) inside project root", async () => {
    const result = await retrieveQuery({
      query: "boundarySharedSymbol",
      cwd: root,
      topK: 10,
      toolCallId: "test-query-cwd",
    });
    expect(result.hits.length).toBeGreaterThan(0);
  });
});
