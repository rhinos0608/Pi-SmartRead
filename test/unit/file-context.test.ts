import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildFileContextLines } from "../../file-context.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("buildFileContextLines", () => {
  let repo: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "file-context-")));
    git(repo, "init");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    // Commit message carries a trailer whose key is in the default
    // showTrailerKeys (["Constraint", "Directive", "Rejected"]).
    git(repo, "commit", "-m", "add a.ts", "-m", "Constraint: keep the public API frozen");
    git(repo, "notes", "--ref=refs/notes/pi-smartread", "add", "-m", "decision: keep a tiny", "HEAD");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("includes recent commits, configured trailers, and git notes for a tracked file", async () => {
    const lines = await buildFileContextLines({ fullPath: path.join(repo, "a.ts"), cwd: repo });
    const text = lines.join("\n");
    expect(text).toContain("🔍 Context for a.ts:");
    expect(text).toContain("Recent commits:");
    expect(text).toContain("add a.ts");
    expect(text).toContain("Constraint: keep the public API frozen");
    expect(text).toContain("Git notes:");
    expect(text).toContain("decision: keep a tiny");
  });

  it("returns [] when the file does not exist", async () => {
    const lines = await buildFileContextLines({ fullPath: path.join(repo, "missing.ts"), cwd: repo });
    expect(lines).toEqual([]);
  });
});
