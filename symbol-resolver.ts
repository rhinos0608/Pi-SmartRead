/**
 * Cross-file symbol resolution.
 *
 * Given a symbol name and a context file/line, resolves:
 *   - The definition location across files
 *   - All reference locations across files
 *   - The most likely definition (prioritizing same-directory / direct-import matches)
 *
 * Leverages the existing `defines` and `references` maps built from
 * tree-sitter tag extraction, matching the approach in `getRankedTags`.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getTagsBatch, initParser } from "./tags.js";
import { findSrcFiles } from "./file-discovery.js";
import { filenameToLang } from "./languages.js";
import { TagsCache } from "./cache.js";
import type { Tag } from "./cache.js";
import { renderTreeContext } from "./tree-context.js";

export interface SymbolResolution {
  symbol: string;
  contextFile: string;
  contextLine: number;
  definitions: {
    file: string;
    line: number;
    kind: string;
    scope?: string;
    context?: string;
  }[];
  references: {
    file: string;
    line: number;
    context?: string;
  }[];
  /** Best-guess definition (prioritized) */
  bestDefinition?: {
    file: string;
    line: number;
    kind: string;
    scope?: string;
    context?: string;
  };
  /** How the resolution was computed */
  strategy: "tree-sitter" | "text-fallback";
  stats: {
    totalFilesScanned: number;
    totalTagsExtracted: number;
    parseTimeMs: number;
  };
}

const SymbolResolutionSchema = Type.Object({
  symbol: Type.String({
    description: "The symbol name to resolve (e.g., 'User', 'createUser')",
    minLength: 1,
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Context location in format 'file.ts:42'. Helps disambiguate which definition to pick when the symbol is defined in multiple files.",
    }),
  ),
  directory: Type.Optional(
    Type.String({
      description:
        "Root directory to search (default: extension working directory)",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum definition + reference results (default: 50)",
      minimum: 1,
      maximum: 200,
    }),
  ),
});

type SymbolResolutionInput = Static<typeof SymbolResolutionSchema>;

// ── Import specifier extraction ───────────────────────────────────

// Matches: default imports, named imports, namespace imports, side-effect imports, require()
const IMPORT_RE = /^\s*(?:import\s+(?:type\s+)?(?:\*\s+as\s+\w+\s+from\s+|\{[^}]*\}\s+from\s+|\w+(?:\s*,\s*\{[^}]*\})?\s+from\s+)?["']([^"']+)["']|import\s*\(["']([^"']+)["']\)|(?:const|let|var)\s+[^=]+?=\s*require\(["']([^"']+)["']\))/gm;
const RESOLUTION_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];

/**
 * Extract all raw import specifiers from a file.
 */
function extractImportSpecifiers(code: string): string[] {
  const specs: string[] = [];
  for (const match of code.matchAll(IMPORT_RE)) {
    const spec = match[1] || match[2] || match[3];
    if (spec && spec.startsWith(".")) specs.push(spec);
  }
  return specs;
}

/**
 * Check whether a specifier can be resolved to an actual file within root.
 */
function canResolveImport(root: string, importerDir: string, specifier: string): string | null {
  const basePath = resolve(importerDir, specifier);
  for (const ext of RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    const relCandidate = relative(root, candidate);
    if (!relCandidate.startsWith("..") && existsSync(candidate)) {
      return relCandidate;
    }
  }
  return null;
}

/**
 * Score a definition candidate by proximity to the context file.
 *
 * Priority order:
 *   1. Same file (highest score)
 *   2. Direct import from context file
 *   3. Same directory
 *   4. Same parent directory
 *   5. Anywhere else
 */
function scoreDefinitionRelevance(
  defFile: string,
  contextFile: string,
  importMap: Map<string, Set<string>>,
): number {
  if (defFile === contextFile) return 100;

  // Direct import
  const imports = importMap.get(contextFile);
  if (imports?.has(defFile)) return 90;

  // Same directory
  if (dirname(defFile) === dirname(contextFile)) return 50;

  // Same parent tree (shared ancestor)
  const defDir = dirname(defFile);
  const ctxDir = dirname(contextFile);
  if (defDir.startsWith(ctxDir + "/") || ctxDir.startsWith(defDir + "/")) return 30;

  return 10;
}

// ── Main resolution function ──────────────────────────────────────

async function resolveSymbol(
  root: string,
  symbol: string,
  contextFile: string | undefined,
  contextLine: number | undefined,
  maxResults: number,
): Promise<SymbolResolution> {
  const startTime = Date.now();
  const allSrcFiles = findSrcFiles(root);

  if (allSrcFiles.length === 0) {
    return {
      symbol,
      contextFile: contextFile ?? "(none)",
      contextLine: contextLine ?? 0,
      definitions: [],
      references: [],
      strategy: "text-fallback",
      stats: { totalFilesScanned: 0, totalTagsExtracted: 0, parseTimeMs: 0 },
    };
  }

  // ── Extract tags ──
  await initParser();
  const cache = new TagsCache(root);

  const allTags = await getTagsBatch(
    allSrcFiles.map((f) => ({ fname: f, relFname: relative(root, f) })),
    cache,
    false,
    20,
  );

  const parseTimeMs = Date.now() - startTime;

  // ── Build definition and reference maps ──
  const defines = new Map<string, { file: string; line: number; kind: string }[]>();
  const references = new Map<string, { file: string; line: number }[]>();
  const importMap = new Map<string, Set<string>>();

  for (const f of allSrcFiles) {
    const relFname = relative(root, f);
    importMap.set(relFname, new Set());

    // Extract imports in parallel with tag processing
    try {
      const code = readFileSync(f, "utf-8");
      const importSpecs = extractImportSpecifiers(code);
      for (const spec of importSpecs) {
        const resolved = canResolveImport(root, dirname(f), spec);
        if (resolved) importMap.get(relFname)!.add(resolved);
      }
    } catch { /* ignore */ }
  }

  for (const tag of allTags) {
    if (tag.kind === "def") {
      let list = defines.get(tag.name);
      if (!list) { list = []; defines.set(tag.name, list); }
      list.push({ file: tag.relFname, line: tag.line, kind: "symbol" });
    } else if (tag.kind === "ref") {
      let list = references.get(tag.name);
      if (!list) { list = []; references.set(tag.name, list); }
      list.push({ file: tag.relFname, line: tag.line });
    }
  }

  // ── Filter to the requested symbol ──
  const symbolLower = symbol.toLowerCase();
  let defs = defines.get(symbol)?.filter((d) => d.file) ?? [];

  // Fuzzy match if exact match not found
  if (defs.length === 0) {
    for (const [name, ds] of defines) {
      if (name.toLowerCase() === symbolLower) {
        defs = ds;
        break;
      }
    }
  }

  let refs = references.get(symbol) ?? [];
  if (refs.length === 0) {
    for (const [name, rs] of references) {
      if (name.toLowerCase() === symbolLower) {
        refs = rs;
        break;
      }
    }
  }

  // ── Prioritize definitions by proximity to context ──
  let bestDefinition: SymbolResolution["bestDefinition"];

  if (defs.length > 0) {
    // Score each definition by relevance to context
    const scored = defs.map((d) => ({
      ...d,
      score: contextFile
        ? scoreDefinitionRelevance(d.file, contextFile, importMap)
        : 0,
    }));

    scored.sort((a, b) => b.score - a.score);
    // Re-order defs so the highest-scored definitions come first and maxResults is consistent
    defs = scored.map((s) => ({ file: s.file, line: s.line, kind: s.kind }));
    bestDefinition = scored[0];
  }

  // ── Enrich definitions with context snippets ──
  const enrichedDefs = await Promise.all(
    defs
      .slice(0, maxResults)
      .map(async (d) => {
        let context: string | undefined;
        try {
          const code = readFileSync(resolve(root, d.file), "utf-8");
          context = renderTreeContext(code, [d.line], { lineNumbers: true, loiPad: 2 }, resolve(root, d.file));
        } catch { /* omit */ }
        return { ...d, context };
      }),
  );

  const enrichedRefs = await Promise.all(
    refs.slice(0, maxResults).map(async (r) => {
      let context: string | undefined;
      try {
        const code = readFileSync(resolve(root, r.file), "utf-8");
        context = renderTreeContext(code, [r.line], { lineNumbers: true, loiPad: 2 }, resolve(root, r.file));
      } catch { /* omit */ }
      return { ...r, context };
    }),
  );

  return {
    symbol,
    contextFile: contextFile ?? "(none)",
    contextLine: contextLine ?? 0,
    definitions: enrichedDefs,
    references: enrichedRefs,
    bestDefinition,
    strategy: "tree-sitter",
    stats: {
      totalFilesScanned: allSrcFiles.length,
      totalTagsExtracted: allTags.length,
      parseTimeMs,
    },
  };
}

// ── Tool definition ───────────────────────────────────────────────

export function createSymbolResolverTool(): ToolDefinition {
  return {
    name: "resolve_symbol",
    label: "resolve_symbol",
    description:
      "Resolve a symbol (function, class, variable) name across the repository. Given a symbol and optional context file:line, returns the definition location, all references, and enriched context snippets. Uses tree-sitter AST analysis for precise results.",
    parameters: SymbolResolutionSchema,

    async execute(
      toolCallId: string,
      params: SymbolResolutionInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const cwd = params.directory ?? ctx.cwd;
      const root = resolve(cwd);

      // Parse context if provided
      let contextFile: string | undefined;
      let contextLine: number | undefined;
      if (params.context) {
        const parts = params.context.split(":");
        contextFile = parts[0]!;
        contextLine = parts[1] ? parseInt(parts[1], 10) : undefined;
      }

      if (signal?.aborted) throw new Error("Operation aborted");

      const result = await resolveSymbol(
        root,
        params.symbol,
        contextFile,
        contextLine,
        params.maxResults ?? 50,
      );

      // ── Format output ──
      const lines: string[] = [
        `Resolved symbol: "${result.symbol}"`,
        result.contextFile !== "(none)"
          ? `Context: ${result.contextFile}:${result.contextLine}`
          : "Context: none provided",
        `Strategy: ${result.strategy}`,
        `Scanned ${result.stats.totalFilesScanned} files (${result.stats.parseTimeMs}ms)`,
        "",
      ];

      if (result.definitions.length === 0) {
        lines.push(`[No definitions found for "${result.symbol}"]`);
        lines.push("");
        if (result.references.length > 0) {
          lines.push(`${result.references.length} reference(s) found (symbol may be from an external module):`);
          lines.push("");
          for (const r of result.references.slice(0, 20)) {
            const ctxStr = r.context ? `\n${r.context.split("\n").map((l) => `  ${l}`).join("\n")}` : "";
            lines.push(`  ${r.file}:${r.line}  [ref]${ctxStr}`);
            lines.push("");
          }
        } else {
          lines.push("[No references found]");
        }
      } else {
        // Best definition first
        if (result.bestDefinition) {
          const bd = result.bestDefinition;
          const ctxStr = bd.context ? `\n${bd.context.split("\n").map((l) => `  ${l}`).join("\n")}` : "";
          lines.push(`Best definition → ${bd.file}:${bd.line}  [def]${ctxStr}`);
          lines.push("");
        }

        lines.push(`${result.definitions.length} definition(s):`);
        lines.push("");
        for (const d of result.definitions) {
          const ctxStr = d.context ? `\n${d.context.split("\n").map((l) => `  ${l}`).join("\n")}` : "";
          lines.push(`  ${d.file}:${d.line}  [def]${ctxStr}`);
          lines.push("");
        }

        if (result.references.length > 0) {
          lines.push(`${result.references.length} reference(s):`);
          lines.push("");
          for (const r of result.references.slice(0, 30)) {
            const ctxStr = r.context ? `\n${r.context.split("\n").map((l) => `  ${l}`).join("\n")}` : "";
            lines.push(`  ${r.file}:${r.line}  [ref]${ctxStr}`);
            lines.push("");
          }
          if (result.references.length > 30) {
            lines.push(`  ... and ${result.references.length - 30} more references`);
            lines.push("");
          }
        } else {
          lines.push("[No references found]");
          lines.push("");
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: result,
      };
    },
  } as unknown as ToolDefinition;
}
