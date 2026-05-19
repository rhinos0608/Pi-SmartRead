import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";

import { detectDefaultBranch, findBranchPoint, findGitRoot, getStructuredLog } from "./git-context.js";
import { COMPAT_NOTES_REFS, PI_NOTES_REF, formatBranchNotes, readNote, scanBranchNotes, writeNote } from "./git-notes.js";

const GitNotesSchema = Type.Object({
  action: Type.Optional(
    Type.Unsafe<"read" | "write">({
      type: "string",
      enum: ["read", "write"],
      description: "'read' to retrieve notes (default), 'write' to attach a note",
      default: "read",
    }),
  ),
  commit: Type.Optional(
    Type.String({ description: "Commit hash. For read: if omitted returns all branch commits. For write: defaults to HEAD." }),
  ),
  content: Type.Optional(
    Type.String({ description: "Note content to attach (required for action=write)" }),
  ),
  directory: Type.Optional(Type.String({ description: "Repo root (default: cwd)" })),
  confirm: Type.Optional(
    Type.Boolean({ description: "Confirmation flag (write only)" }),
  ),
});

type GitNotesInput = Static<typeof GitNotesSchema>;

interface ToolContext {
  cwd: string;
}

function createGitNotesTool(): ToolDefinition {
  return {
    name: "git_notes",
    label: "git_notes",
    description:
      "[EXPERIMENTAL] Read or write AI session context attached to git commits as notes. " +
      "Read returns conversation context, decisions, and constraints from previous sessions. " +
      "Write records decisions, rejected approaches, and forward-looking directives. " +
      "Searches refs/notes/pi-smartread, refs/notes/lore, refs/notes/opencode, and refs/notes/commits.\n\n" +
      "Tip for write: Use Lore-style trailers for machine-parseable decisions:\n" +
      "  Constraint: <rule that shaped this decision>\n" +
      "  Rejected: <alternative> | <reason>\n" +
      "  Directive: <forward instruction for future modifier>\n" +
      "  Confidence: high|medium|low",
    parameters: GitNotesSchema,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: ToolContext,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
      const input = params as GitNotesInput;

      if (input.action === "write") {
        if (input.confirm !== true) {
          throw new Error('action "write" requires "confirm": true');
        }
        if (typeof input.content !== "string" || !input.content.trim()) {
          throw new Error('action "write" requires a non-empty "content"');
        }
      }

      const startDir = input.directory ? resolve(ctx.cwd, input.directory) : ctx.cwd;
      const gitRoot = await findGitRoot(startDir);

      if (!gitRoot) {
        return { content: [{ type: "text", text: "No git repository found." }], details: {} };
      }

      if (input.action === "write") {
        return handleWrite(gitRoot, input);
      }

      return handleRead(gitRoot, input);
    },
  } as unknown as ToolDefinition;
}

async function handleRead(
  gitRoot: string,
  input: GitNotesInput,
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
  input: GitNotesInput,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  // Validate content (defense-in-depth; execute also checks)
  if (typeof input.content !== "string" || !input.content.trim()) {
    throw new Error('action "write" requires a non-empty "content"');
  }
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

export function createGitNotesTools(): ToolDefinition[] {
  return [createGitNotesTool()];
}
