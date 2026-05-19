import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommitRecord } from "../../git-context.js";
import { PI_NOTES_REF, formatBranchNotes, readNote, scanBranchNotes, writeNote } from "../../git-notes.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function commitRecord(hash: string, subject = "feat: add note"): CommitRecord {
  return {
    hash,
    isoDate: "2026-05-17T00:00:00Z",
    relativeDate: "1 hour ago",
    author: "Test User",
    subject,
    trailers: [],
    filesChanged: [],
  };
}

describe("git notes", () => {
  let root: string;
  let head: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-notes-test-"));
    git(root, ["init"]);
    git(root, ["config", "user.name", "Test User"]);
    git(root, ["config", "user.email", "test@example.com"]);
    writeFileSync(join(root, "file.ts"), "export const value = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat: add file"]);
    head = git(root, ["rev-parse", "--short", "HEAD"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes and reads Pi notes", async () => {
    await writeNote(root, "Constraint: keep this decision", head);
    await expect(readNote(root, head, PI_NOTES_REF)).resolves.toBe("Constraint: keep this decision");
  });

  it("scans branch notes with Pi notes taking precedence", async () => {
    await writeNote(root, "Directive: prefer cached graph", head);
    const notes = await scanBranchNotes(root, [commitRecord(head)]);
    expect(notes).toEqual([expect.objectContaining({
      commitHash: head,
      content: "Directive: prefer cached graph",
      ref: PI_NOTES_REF,
    })]);
  });
});

describe("formatBranchNotes", () => {
  it("formats notes with source refs and respects empty input", () => {
    expect(formatBranchNotes([], 100)).toBe("");
    const text = formatBranchNotes([
      {
        commitHash: "abc12345",
        commitSubject: "feat: add auth",
        relativeDate: "2 days ago",
        content: "Constraint: auth TTL is unpredictable",
        ref: "refs/notes/lore",
      },
    ], 200);
    expect(text).toContain("## Session Notes");
    expect(text).toContain("[from lore]");
    expect(text).toContain("Constraint: auth TTL is unpredictable");
  });
});
