/**
 * Unified read tool — consolidates single-file read, intent-based discovery,
 * and multi-file batch read into one tool with a `mode` parameter.
 *
 * Modes:
 *   - "file"     (default) Single file read with contextual enrichment (imports, git, graphify)
 *   - "intent"   Intent-based file discovery + hybrid RRF ranking → read top-K
 *   - "multiple" Read multiple files in one call with adaptive packing
 *
 * Replaces standalone `intent_read` and `read_multiple_files` tools.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { wrapBuiltinReadTool } from "./hook.js";
import { createIntentReadTool } from "./intent-read.js";
import { createReadManyTool } from "./read-many.js";

const UnifiedReadSchema = Type.Object({
  mode: Type.Optional(
    Type.Unsafe<"file" | "intent" | "multiple">({
      type: "string",
      enum: ["file", "intent", "multiple"],
      description:
        "Read mode. 'file' (default): single file with context enrichment. 'intent': rank files by relevance to query and read top-K. 'multiple': read up to 20 files in one call with adaptive packing.",
      default: "file",
    }),
  ),
  // ── file mode params ──
  path: Type.Optional(
    Type.String({ description: "Path to the file to read (relative or absolute)" }),
  ),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)", minimum: 1 }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of lines to read", minimum: 1 }),
  ),
  // ── intent mode params ──
  query: Type.Optional(
    Type.String({ description: "The search intent (required for mode=intent)" }),
  ),
  directory: Type.Optional(
    Type.String({
      description:
        "Root directory (default: extension cwd). For mode=file: directory containing the file. For mode=intent: directory to scan (non-recursive, max 20 files).",
    }),
  ),
  topK: Type.Optional(
    Type.Number({
      description: "Max top-K results to return for intent mode (default 20)",
      minimum: 1,
      maximum: 20,
    }),
  ),
  // ── multiple mode params ──
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
        offset: Type.Optional(Type.Number({ minimum: 1 })),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      { minItems: 1, maxItems: 20, description: "Files to read (required for mode=multiple)" },
    ),
  ),
  // ── shared ──
  stopOnError: Type.Optional(
    Type.Boolean({ description: "Stop on first read error (default false)" }),
  ),
});

type UnifiedReadInput = Static<typeof UnifiedReadSchema>;

export function createUnifiedReadTool(): ToolDefinition {
  // Lazily-created internal tool instances. Cached after first mode dispatch.
  let fileTool: ToolDefinition | null = null;
  let intentTool: ToolDefinition | null = null;
  let manyTool: ToolDefinition | null = null;

  return {
    name: "read",
    label: "read",
    description:
      "Read files with optional semantic ranking and multi-file batch support. Modes: 'file' (single file with import/git/graph context), 'intent' (rank files by relevance to query + read top-K), 'multiple' (read up to 20 files in one call with adaptive packing).",
    parameters: UnifiedReadSchema,

    async execute(
      toolCallId: string,
      params: UnifiedReadInput,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const mode = params.mode ?? "file";

      switch (mode) {
        case "file": {
          if (typeof params.path !== "string" || !params.path.trim()) {
            throw new Error('mode "file" requires a non-empty "path"');
          }
          fileTool ??= wrapBuiltinReadTool();
          return fileTool.execute(toolCallId, params, signal, onUpdate as never, ctx);
        }

        case "intent": {
          if (typeof params.query !== "string" || !params.query.trim()) {
            throw new Error('mode "intent" requires a non-empty "query"');
          }
          intentTool ??= createIntentReadTool();
          return intentTool.execute(toolCallId, params, signal, onUpdate as never, ctx);
        }

        case "multiple": {
          if (!Array.isArray(params.files) || params.files.length === 0) {
            throw new Error(
              'mode "multiple" requires a non-empty "files" array (min 1, max 20)',
            );
          }
          manyTool ??= createReadManyTool();
          return manyTool.execute(toolCallId, params, signal, onUpdate as never, ctx);
        }
      }
    },
  } as unknown as ToolDefinition;
}
