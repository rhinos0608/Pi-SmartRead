import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toToolDefinition, toToolDefinitions } from "./types.js";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { detectDefaultBranch, findBranchPoint, findGitRoot, getStructuredLog } from "./git-context.js";
import { COMPAT_NOTES_REFS, PI_NOTES_REF, formatBranchNotes, isValidCommitIsh, readNote, scanBranchNotes, writeNote } from "./git-notes.js";

// ── Schemas ─────────────────────────────────────────────────────────

const GitNotesReadSchema = Type.Object({
  commit: Type.Optional(
    Type.String({ description: "Commit hash. If omitted, returns notes for all branch commits." }),
  ),
  directory: Type.Optional(Type.String({ description: "Repo root (default: cwd)" })),
});

const GitNotesWriteSchema = Type.Object({
  content: Type.String({ description: "Note content to attach. Use Lore-style trailers for machine-parseable decisions: Constraint:, Rejected:, Directive:, Confidence:", maxLength: 64000 }),
  commit: Type.Optional(
    Type.String({ description: "Commit hash to attach the note to (default: HEAD)." }),
  ),
  directory: Type.Optional(Type.String({ description: "Repo root (default: cwd)" })),
});

type GitNotesReadInput = Static<typeof GitNotesReadSchema>;
type GitNotesWriteInput = Static<typeof GitNotesWriteSchema>;

// ToolContext no longer needed — uses ExtensionContext from pi-coding-agent directly

// ── Read tool ────────────────────────────────────────────────────────

function createGitNotesReadTool(): ToolDefinition {
  return toToolDefinition({
    name: "git_notes_read",
    label: "git_notes_read",
    description:
      "[EXPERIMENTAL] Read AI session context attached to git commits. Returns decisions, constraints from prior sessions.",
    parameters: GitNotesReadSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
        const input = params as GitNotesReadInput;
        const startDir = resolveDirParam(ctx.cwd, input.directory);
      const gitRoot = await findGitRoot(startDir);

      if (!gitRoot) {
        return { content: [{ type: "text", text: "No git repository found." }], details: {}, isError: true };
      }

      return handleRead(gitRoot, input);
    },
  });
}

// ── Write tool ─────────────────────────────────────────────────────

function createGitNotesWriteTool(): ToolDefinition {
  return toToolDefinition({
    name: "git_notes_write",
    label: "git_notes_write",
    description:
      "[EXPERIMENTAL] Write session context as git note. Use Lore-style trailers: Constraint:, Rejected:, Directive:, Confidence:",
    parameters: GitNotesWriteSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
      const input = params as GitNotesWriteInput;

      if (typeof input.content !== "string" || !input.content.trim()) {
        throw new Error("content must be a non-empty string");
      }

      const startDir = resolveDirParam(ctx.cwd, input.directory);
      const gitRoot = await findGitRoot(startDir);

      if (!gitRoot) {
        return { content: [{ type: "text", text: "No git repository found." }], details: {}, isError: true };
      }

      return handleWrite(gitRoot, input);
    },
  });
}

// ── Handlers (shared) ──────────────────────────────────────────────

async function handleRead(
  gitRoot: string,
  input: GitNotesReadInput,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
  if (input.commit) {
    if (!isValidCommitIsh(input.commit)) {
      return { content: [{ type: "text", text: `Invalid commit reference: ${input.commit}` }], details: {} };
    }
    const entries: string[] = [];
    for (const ref of [PI_NOTES_REF, ...COMPAT_NOTES_REFS]) {
      const note = await readNote(gitRoot, input.commit, ref);
      if (note) entries.push(`--- ${input.commit} (${ref}) ---\n${note}`);
    }
    return {
      content: [{ type: "text", text: entries.join("\n\n") || `No git notes found for ${input.commit}.` }],
      details: {},
    };
  }

  const defaultBranch = await detectDefaultBranch(gitRoot);
  const branchPoint = await findBranchPoint(gitRoot, defaultBranch);
  const commits = await getStructuredLog(gitRoot, { branchPoint: branchPoint ?? undefined, limit: 50, includeBody: false });
  const notes = await scanBranchNotes(gitRoot, commits);
  const text = formatBranchNotes(notes, 2000) || "No git notes found for branch commits.";
  return { content: [{ type: "text", text }], details: {} };
}

async function handleWrite(
  gitRoot: string,
  input: GitNotesWriteInput,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }> {
  const timestamp = new Date().toISOString();
  const content = `[pi-smartread session ${timestamp}]\n\n${input.content}`;

  const targetCommit = input.commit ?? "HEAD";
  if (!isValidCommitIsh(targetCommit)) {
    return {
      content: [{ type: "text", text: `Invalid commit reference: ${targetCommit}` }],
      details: {},
      isError: true,
    };
  }
  try {
    await writeNote(gitRoot, content, targetCommit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Failed to write git note: ${message}` }],
      details: { error: message },
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `Wrote git note to ${input.commit ?? "HEAD"} in ${PI_NOTES_REF}.` }],
    details: {},
  };
}

// ── Export ─────────────────────────────────────────────────────────

export function createGitNotesTools(): ToolDefinition[] {
  return toToolDefinitions([createGitNotesReadTool(), createGitNotesWriteTool()]);
}

function resolveDirParam(cwd: string, directory: string | undefined): string {
  const resolvedDir = directory ? resolve(cwd, directory) : resolve(cwd);
  try {
    const realCwd = realpathSync(resolve(cwd));
    let realDir: string;
    try {
      realDir = realpathSync(resolvedDir);
    } catch {
      realDir = resolvedDir;
    }
    const rel = relative(realCwd, realDir);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(`Directory outside workspace: ${directory ?? "."}`);
    }
    return realDir;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Directory outside workspace")) {
      throw err;
    }
    return resolvedDir;
  }
}
