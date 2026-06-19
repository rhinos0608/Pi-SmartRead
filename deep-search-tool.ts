/**
 * First-class deep search tool.
 *
 * Split from search-tool.ts's mode=deep into its own tool so agents can
 * call it directly without routing through the search umbrella.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { executeDeepSearch } from "./deep-search.js";
import { recordSparse, resolveSessionKey } from "./file-read-cache.js";

// ── Schema ────────────────────────────────────────────────────────

const DeepSearchSchema = Type.Object({
  query: Type.String({
    description: "Identifier name, code pattern, or natural language search query",
    minLength: 1,
  }),
  depth: Type.Optional(
    Type.Union([
      Type.Literal("quick"),
      Type.Literal("standard"),
      Type.Literal("thorough"),
    ], { description: "Search depth. quick: grep + structural only. standard (default): adds semantic + symbol + graph. thorough: adds relationship enrichment.", default: "standard" }),
  ),
  scope: Type.Optional(
    Type.Union([
      Type.Literal("code"),
      Type.Literal("docs"),
      Type.Literal("tests"),
      Type.Literal("all"),
    ], { description: "Scope of files to search. code: source files only. docs: documentation only. tests: test files only. all (default): everything.", default: "all" }),
  ),
  directory: Type.Optional(
    Type.String({
      description: "Root directory to search (default: extension working directory)",
      default: ".",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum results to return (default: 15, clamped to 1-50).",
      default: 15,
    }),
  ),
  maxSnippetChars: Type.Optional(
    Type.Number({
      description: "Max characters per snippet (default: 400, clamped to 100-1000).",
      default: 400,
    }),
  ),
  outputBudget: Type.Optional(
    Type.Number({
      description: "Max output characters (default: 4096, clamped to 1024-16384).",
      default: 4096,
    }),
  ),
  includeRelationships: Type.Optional(
    Type.Boolean({
      description: "Include caller/callee relationships in results (default: true for thorough depth).",
    }),
  ),
  focusFiles: Type.Optional(
    Type.Array(Type.String(), {
      description: "File paths to boost in ranking.",
    }),
  ),
});

type DeepSearchInput = Static<typeof DeepSearchSchema>;

// ── Tool factory ─────────────────────────────────────────────────

export default function createDeepSearchTool(): ToolDefinition {
  return {
    name: "deep_search",
    label: "deep_search",
    description:
      "Multi-channel code search combining structural (AST), grep, symbol resolution, " +
      "semantic (embedding), graph traversal, and LSP. Produces fused results with " +
      "provenance signals showing why each match was found. Best for complex or " +
      "imprecise queries where single-channel search is insufficient.",
    parameters: DeepSearchSchema,

    async execute(
      toolCallId: string,
      params: DeepSearchInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const searchRoot = resolveSearchDirParam(params, ctx.cwd);

      const result = await executeDeepSearch(
        {
          query: params.query,
          depth: params.depth ?? "standard",
          scope: params.scope ?? "all",
          directory: searchRoot,
          limit: params.limit ?? 15,
          maxSnippetChars: params.maxSnippetChars ?? 400,
          outputBudget: params.outputBudget ?? 4096,
          includeRelationships: params.includeRelationships,
          focusFiles: params.focusFiles,
        },
        signal,
        ctx,
      );

      // Record matches in sparse cache for context hygiene
      const sessionKey = resolveSessionKey(toolCallId);
      let validMatches: Array<{ file: string; lines?: { start: number }; snippet: string }> | undefined;
      const rawDetails = result.details;
      if (rawDetails && typeof rawDetails === "object" && !Array.isArray(rawDetails)) {
        const rawMatches = (rawDetails as Record<string, unknown>).matches;
        if (Array.isArray(rawMatches)) {
          validMatches = rawMatches.filter(
            (match): match is { file: string; lines?: { start: number }; snippet: string } => {
              if (!match || typeof match !== "object") return false;
              const entry = match as Record<string, unknown>;
              if (typeof entry.file !== "string") return false;
              if (typeof entry.snippet !== "string") return false;
              if (entry.lines !== undefined) {
                if (typeof entry.lines !== "object" || entry.lines === null) return false;
                const lines = entry.lines as Record<string, unknown>;
                if (lines.start !== undefined && typeof lines.start !== "number") return false;
              }
              return true;
            },
          );
          if (validMatches.length === 0) validMatches = undefined;
        }
      }

      if (validMatches && validMatches.length > 0) {
        const byFile = new Map<string, Array<{ line: number; text: string }>>();
        for (const match of validMatches) {
          const absPath = resolve(searchRoot, match.file);
          const lineNum = match.lines?.start ?? 1;
          const entries = byFile.get(absPath) ?? [];
          entries.push({ line: lineNum, text: match.snippet });
          byFile.set(absPath, entries);
        }
        for (const [absPath, entries] of byFile) {
          recordSparse(sessionKey, absPath, entries);
        }
      }

      return result;
    },
  } as unknown as ToolDefinition;
}

function resolveSearchDirParam(params: DeepSearchInput, defaultCwd: string): string {
  const dir = params.directory?.trim();
  const resolvedDir = dir ? resolve(defaultCwd, dir) : resolve(defaultCwd);
  try {
    const realCwd = realpathSync(resolve(defaultCwd));
    let realDir: string;
    try {
      realDir = realpathSync(resolvedDir);
    } catch {
      realDir = resolvedDir;
    }
    const rel = relative(realCwd, realDir);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(`Directory outside workspace: ${dir ?? "."}`);
    }
    return realDir;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Directory outside workspace")) {
      throw err;
    }
    return resolvedDir;
  }
}
