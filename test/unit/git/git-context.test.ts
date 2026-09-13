import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStartupGitContext,
  extractCoCommitPairs,
  parseCommitTrailers,
  parseStructuredLogOutput,
} from "../../src/git-context.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("parseCommitTrailers", () => {
  it("parses Lore-style trailers from the final paragraph", () => {
    const trailers = parseCommitTrailers("Body text\n\nConstraint: Keep auth broad\nRejected: Timer refresh | race\nDirective: Do not narrow 4xx");
    expect(trailers).toEqual([
      { key: "Constraint", value: "Keep auth broad" },
      { key: "Rejected", value: "Timer refresh | race" },
      { key: "Directive", value: "Do not narrow 4xx" },
    ]);
  });

  it("ignores non-trailer final paragraphs", () => {
    expect(parseCommitTrailers("Body text\n\nnot a trailer")).toEqual([]);
    expect(parseCommitTrailers("Body text only")).toEqual([]);
  });
});

describe("parseStructuredLogOutput", () => {
  it("parses null-delimited commit records with files and trailers", () => {
    const output = "\x1eabc12345\x002026-05-17T00:00:00Z\x002 days ago\x00Alice\x00feat: add auth\x00Body\n\nConstraint: No introspection\x00\nsrc/auth.ts\nsrc/token.ts\n";
    const commits = parseStructuredLogOutput(output);

    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      hash: "abc12345",
      isoDate: "2026-05-17T00:00:00Z",
      relativeDate: "2 days ago",
      author: "Alice",
      subject: "feat: add auth",
      filesChanged: ["src/auth.ts", "src/token.ts"],
      trailers: [{ key: "Constraint", value: "No introspection" }],
    });
  });
});

describe("git-context integration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-context-test-"));
    git(root, ["init"]);
    git(root, ["config", "user.name", "Test User"]);
    git(root, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat: add a and b"]);
    writeFileSync(join(root, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(root, "b.ts"), "export const b = 2;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fix: update pair"]);
    writeFileSync(join(root, "a.ts"), "export const a = 3;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "chore: update a"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("extracts co-commit pairs from recent history", async () => {
    const pairs = await extractCoCommitPairs(root, 10);
    expect(pairs).toContainEqual(expect.objectContaining({
      fromPath: "a.ts",
      toPath: "b.ts",
      count: 2,
      correlation: expect.any(Number),
    }));
  });

  it("builds startup git context without requiring a remote", async () => {
    const result = await buildStartupGitContext(root, 300);
    expect(result.contextString).toContain("## Git Context");
    expect(result.contextString).toContain("Recent commits:");
    expect(result.branchCommits.length).toBeGreaterThan(0);
  });
});
