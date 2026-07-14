import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { executeInspectDetails } from "../../src/inspect.js";
import { computePathEvidence } from "../../src/path-evidence.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("inspect path mode enrichment", () => {
  let repo: string;
  const session = "/tmp/fake-session.jsonl";

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "inspect-enrich-")));
    git(repo, "init");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add a.ts");
    git(repo, "notes", "--ref=refs/notes/pi-smartread", "add", "-m", "decision: keep a tiny", "HEAD");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("appends git context and notes to path-mode content", async () => {
    const details = await executeInspectDetails({
      path: "a.ts",
      cwd: repo,
      sessionFilePath: session,
    });
    expect(details.mode).toBe("path");
    expect(details.contentText).toContain("1: export const a = 1;");
    expect(details.contentText).toContain("🔍 Context for a.ts:");
    expect(details.contentText).toContain("Recent commits:");
    expect(details.contentText).toContain("Git notes:");
    expect(details.contentText).toContain("decision: keep a tiny");
  });

  it("keeps the envelope identical to the unenriched read", async () => {
    const details = await executeInspectDetails({
      path: "a.ts",
      cwd: repo,
      sessionFilePath: session,
    });
    // Compute path evidence independently and verify envelope fields match.
    const pe = computePathEvidence({ path: "a.ts", cwd: repo, sessionFilePath: session });
    const resource = pe.workspaceEvidence.resources[0]!;
    expect(resource.canonicalPath).toMatch(/a\.ts$/);
    expect(resource.coverage).toBe("full-file");
    expect(resource.allowedRanges).toEqual([{ startLine: 1, endLine: 2 }]);
    expect(typeof resource.fullFileSha256).toBe("string");
    // Verify the inspect envelope's resource matches the independent compute.
    const insResource = details.workspaceEvidence.resources[0]!;
    expect(insResource.canonicalPath).toBe(resource.canonicalPath);
    expect(insResource.coverage).toBe(resource.coverage);
    expect(insResource.allowedRanges).toEqual(resource.allowedRanges);
    expect(insResource.fullFileSha256).toBe(resource.fullFileSha256);
    // lineCount/byteLength describe the file resource, not the footer.
    // "export const a = 1;\n".split("\n") -> 2 lines.
    expect(details.lineCount).toBe(2);
  });
});
