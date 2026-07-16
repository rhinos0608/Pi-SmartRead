import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createExtendedReadTool } from "../../src/hook.js";
import { computePathEvidence } from "../../src/path-evidence.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeCtx(cwd: string, sessionFile: string | null) {
  return {
    cwd,
    sessionManager: sessionFile ? { getSessionFile: () => sessionFile } : undefined,
  } as any;
}

describe("read tool enrichment (replaces inspect path mode enrichment)", () => {
  let repo: string;
  const session = "/tmp/fake-session.jsonl";

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "read-enrich-")));
    git(repo, "init");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add a.ts");
    git(repo, "notes", "--ref=refs/notes/pi-smartread", "add", "-m", "decision: keep a tiny", "HEAD");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("appends git context and notes to read content", async () => {
    const tool = createExtendedReadTool();
    const result = await tool.execute("t1", { path: "a.ts" }, undefined, undefined, makeCtx(repo, session));
    const text = (result.content[0] as any).text as string;
    expect(text).toContain("export const a = 1;");
    expect(text).toContain("🔍 Context for a.ts:");
    expect(text).toContain("Recent commits:");
    expect(text).toContain("Git notes:");
    expect(text).toContain("decision: keep a tiny");
  });

  it("keeps the envelope identical to the unenriched read", async () => {
    const tool = createExtendedReadTool();
    const result = await tool.execute("t2", { path: "a.ts" }, undefined, undefined, makeCtx(repo, session));
    const env = (result.details as any).workspaceEvidence;
    const resource = env.resources[0];
    expect(resource.canonicalPath).toMatch(/a\.ts$/);
    expect(resource.coverage).toBe("full-file");
    expect(resource.allowedRanges).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(typeof resource.fullFileSha256).toBe("string");

    // Verify the read envelope's resource matches the independent compute.
    const pe = computePathEvidence({ path: "a.ts", cwd: repo, sessionFilePath: session });
    const peResource = pe.workspaceEvidence.resources[0]!;
    expect(resource.canonicalPath).toBe(peResource.canonicalPath);
    expect(resource.coverage).toBe(peResource.coverage);
    expect(resource.allowedRanges).toEqual(peResource.allowedRanges);
    expect(resource.fullFileSha256).toBe(peResource.fullFileSha256);
  });
});
