import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ── Commit-ish validation ────────────────────────────────────────────

const SAFE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;

import type { CommitRecord } from "./git-context.js";

const execFileAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
}

/**
 * Validate a commit-ish value to prevent option injection.
 * Allows: HEAD, hex SHA (7-40 chars), safe ref names (alphanumeric, dots, hyphens, slashes).
 * Rejects values starting with `-` (option injection) or empty strings.
 */
export function isValidCommitIsh(value: string | undefined): value is string {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Option injection: values starting with - are git options, not commit-ish
  if (trimmed.startsWith("-")) return false;
  // Allow HEAD
  if (trimmed === "HEAD") return true;
  // Allow hex SHA
  if (HEX_SHA_RE.test(trimmed)) return true;
  // Allow safe ref names
  if (SAFE_REF_RE.test(trimmed)) return true;
  return false;
}

export const PI_NOTES_REF = "refs/notes/pi-smartread";

export const COMPAT_NOTES_REFS = [
  "refs/notes/lore",
  "refs/notes/opencode",
  "refs/notes/commits",
];

export interface NoteEntry {
  commitHash: string;
  commitSubject: string;
  relativeDate: string;
  content: string;
  ref: string;
}

export async function readNote(gitRoot: string, commitHash: string, ref = PI_NOTES_REF): Promise<string | null> {
  if (!isValidCommitIsh(commitHash)) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("git", ["notes", `--ref=${ref}`, "show", "--", commitHash], {
      cwd: gitRoot,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    }) as ExecResult;
    const content = stdout.trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export async function writeNote(gitRoot: string, content: string, commitHash = "HEAD"): Promise<void> {
  if (!isValidCommitIsh(commitHash)) {
    throw new Error(`Invalid commit-ish: ${commitHash}`);
  }
  await execFileAsync("git", ["notes", `--ref=${PI_NOTES_REF}`, "add", "-f", "-m", content, "--", commitHash], {
    cwd: gitRoot,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });
}

export async function scanBranchNotes(
  gitRoot: string,
  branchCommits: CommitRecord[],
  refs = [PI_NOTES_REF, ...COMPAT_NOTES_REFS],
): Promise<NoteEntry[]> {
  const notes: NoteEntry[] = [];

  for (const commit of branchCommits) {
    for (const ref of refs) {
      const content = await readNote(gitRoot, commit.hash, ref);
      if (!content) continue;
      notes.push({
        commitHash: commit.hash,
        commitSubject: commit.subject,
        relativeDate: commit.relativeDate,
        content,
        ref,
      });
      break;
    }
  }

  return notes;
}

export function formatBranchNotes(notes: NoteEntry[], tokenBudget: number): string {
  if (notes.length === 0 || tokenBudget <= 0) return "";

  const lines: string[] = ["## Session Notes (from git notes)"];
  for (const note of notes) {
    const refSuffix = note.ref === PI_NOTES_REF ? "" : ` [from ${shortNoteRef(note.ref)}]`;
    lines.push(`${note.commitHash} (${note.relativeDate}) — ${note.commitSubject}${refSuffix}`);
    for (const line of note.content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) lines.push(`  ${trimmed}`);
    }
    lines.push("");
  }

  return clampLinesToTokenBudget(lines, tokenBudget).trimEnd();
}

function shortNoteRef(ref: string): string {
  return ref.replace(/^refs\/notes\//, "");
}

function clampLinesToTokenBudget(lines: string[], tokenBudget: number): string {
  const maxChars = Math.max(0, tokenBudget) * 4;
  const kept: string[] = [];
  let chars = 0;

  for (const line of lines) {
    const next = chars + line.length + 1;
    if (kept.length > 0 && next > maxChars) break;
    kept.push(line);
    chars = next;
  }

  return kept.join("\n");
}
