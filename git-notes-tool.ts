import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toToolDefinition, toToolDefinitions } from "./types.js";
import { resolve } from "node:path";

import { detectDefaultBranch, findBranchPoint, findGitRoot, getStructuredLog } from "./git-context.js";
import { COMPAT_NOTES_REFS, PI_NOTES_REF, formatBranchNotes, readNote, scanBranchNotes, writeNote } from "./git-notes.js";

// ── Schemas ─────────────────────────────────────────────────────────

const GitNotesReadSchema = Type.Object({
  commit: Type.Optional(
    Type.String({ description: "Commit hash. If omitted, returns notes for all branch commits." }),
  ),
  directory: Type.Optional(Type.String({ description: "Repo root (default: cwd)" })),
});

const GitNotesWriteSchema = Type.Object({
  content: Type.String({ description: "Note content to attach. Use Lore-style trailers for machine-parseable decisions: Constraint:, Rejected:, Directive:, Confidence:" }),
  commit: Type.Optional(
    Type.String({ description: "Commit hash to attach the note to (default: HEAD)." }),
  ),
  directory: Type.Optional(Type.String({ description: "Repo root (default: cwd)" })),
});

type GitNotesReadInput = Static<typeof GitNotesReadSchema>;
type GitNotesWriteInput = Static<typeof GitNotesWriteSchema>;

interface ToolContext {
  cwd: string;
}

// ── Read tool ────────────────────────────────────────────────────────

function createGitNotesReadTool(): ToolDefinition {
  return toToolDefinition({
    name: "git_notes_read",
    label: "git_notes_read",
    description:
      "[EXPERIMENTAL] Read AI session context attached to git commits as notes. " +
      "Returns conversation context, decisions, and constraints from previous sessions. " +
      "Searches refs/notes/pi-smartread, refs/notes/lore, refs/notes/opencode, and refs/notes/commits.",
    parameters: GitNotesReadSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ToolContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const input = params as GitNotesReadInput;
      const startDir = input.directory ? resolve(ctx.cwd, input.directory) : ctx.cwd;
      const gitRoot = await findGitRoot(startDir);

      if (!gitRoot) {
        return { content: [{ type: "text", text: "No git repository found." }], details: {} };
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
      "[EXPERIMENTAL] Write AI session context as a git note attached to a commit. " +
      "Records decisions, rejected approaches, and forward-looking directives. " +
      "Tip: Use Lore-style trailers for machine-parseable decisions:\n" +
      "  Constraint: <rule that shaped this decision>\n" +
      "  Rejected: <alternative> | <reason>\n" +
      "  Directive: <forward instruction for future modifier>\n" +
      "  Confidence: high|medium|low",
    parameters: GitNotesWriteSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ToolContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const input = params as GitNotesWriteInput;

      if (typeof input.content !== "string" || !input.content.trim()) {
        throw new Error("content must be a non-empty string");
      }

      const startDir = input.directory ? resolve(ctx.cwd, input.directory) : ctx.cwd;
      const gitRoot = await findGitRoot(startDir);

      if (!gitRoot) {
        return { content: [{ type: "text", text: "No git repository found." }], details: {} };
      }

      return handleWrite(gitRoot, input);
    },
  });
}

// ── Handlers (shared) ──────────────────────────────────────────────

async function handleRead(
  gitRoot: string,
  input: GitNotesReadInput,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  if (input.commit) {
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
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const timestamp = new Date().toISOString();
  const content = `[pi-smartread session ${timestamp}]\n\n${input.content}`;

  try {
    await writeNote(gitRoot, content, input.commit ?? "HEAD");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Failed to write git note: ${message}` }],
      details: { error: message },
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
