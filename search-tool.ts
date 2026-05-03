/**
 * Consolidated search tool.
 *
 * Replaces three separate tools (search_symbols, find_callers, resolve_symbol)
 * with a single polymorphic `search` tool supporting 4 modes:
 *
 *   - symbols:  fuzzy/substring symbol search
 *   - callers:  find all callers of a function
 *   - resolve:  resolve a symbol to its definition + references
 *   - code:     AST-aware + semantically ranked code definition search
 *
 * Enrichment (controlled by an `enrich` flag + pi-smartread.config.json):
 * when enabled, each mode cross-references results with other modes.
 */
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { relative } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import Parser, { Query } from "tree-sitter";
import { RepoMap, type SearchResult } from "./repomap.js";
import { resolveSymbol } from "./symbol-resolver.js";
import { findCallers } from "./callgraph.js";
import { loadLanguage, getQueryPath } from "./tags.js";
import { findSrcFiles } from "./file-discovery.js";
import { filenameToLang } from "./languages.js";
import { loadSearchConfig, type SearchConfig } from "./config.js";
import { bm25Scores, computeRrfScores } from "./scoring.js";
import { fetchEmbeddings } from "./embedding.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";

// ── Schema ────────────────────────────────────────────────────────

const SearchSchema = Type.Object({
  mode: Type.Unsafe<"symbols" | "callers" | "resolve" | "code">({
    type: "string",
    enum: ["symbols", "callers", "resolve", "code"],
  }),
  query: Type.Optional(
    Type.String({
      description:
        "Identifier name, code pattern, or search query depending on mode",
      minLength: 1,
    }),
  ),
  function: Type.Optional(
    Type.String({
      description:
        "Function name to find callers for (e.g., 'getConfig', 'createUser')",
      minLength: 1,
    }),
  ),
  symbol: Type.Optional(
    Type.String({
      description: "The symbol name to resolve (e.g., 'User', 'createUser')",
      minLength: 1,
    }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Context location in format 'file.ts:42'. Helps disambiguate which definition to pick when the symbol is defined in multiple files.",
    }),
  ),
  enrich: Type.Optional(
    Type.Boolean({
      description:
        "Auto-enable cross-mode enrichment where supported (default: true)",
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
      description: "Maximum results to return",
      minimum: 1,
      maximum: 500,
    }),
  ),
  includeDefinitions: Type.Optional(
    Type.Boolean({
      description: "Include definition matches (default: true)",
    }),
  ),
  includeReferences: Type.Optional(
    Type.Boolean({
      description: "Include reference matches (default: true)",
    }),
  ),
  filePattern: Type.Optional(
    Type.String({
      description:
        "Glob filter to restrict files (e.g. '*.ts'). Default: all supported source files.",
    }),
  ),
});

type SearchInput = Static<typeof SearchSchema>;

// ── Code-definition extraction for mode: "code" ───────────────────

interface CodeDefinition {
  file: string;
  relFile: string;
  startLine: number;
  endLine: number;
  name: string;
  kind: string;
  body: string;
  /** BM25 score against the query (populated after scoring). */
  score: number;
  /** Embedding cosine similarity (populated after embedding). */
  similarity?: number;
}

/**
 * Extract all top-level definitions from a source file using tree-sitter.
 * Returns function, class, method, interface, and type alias definitions
 * with their full body text and AST metadata.
 */
async function extractCodeDefinitions(
  filePath: string,
  relFile: string,
): Promise<CodeDefinition[]> {
  const lang = filenameToLang(filePath);
  if (!lang) return [];

  const grammar = loadLanguage(lang);
  if (!grammar) return [];

  let code: string;
  try {
    code = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const parser = new Parser();
  parser.setLanguage(grammar);
  // Use chunked callback to avoid "Invalid argument" on large files (>30KB).
  // The native tree-sitter binding's default buffer overflows with the default string callback
  // which returns the entire rest of the string on each invocation. Chunking to 1KB per
  // call prevents the overflow while keeping overhead negligible.
  const CHUNK_SIZE = 1024;
  const tree = parser.parse((offset) => code.slice(offset, offset + CHUNK_SIZE));
  if (!tree?.rootNode) return [];

  // Load the tag query for this language to find definition nodes
  const queryPath = getQueryPath(lang);
  if (!queryPath || !existsSync(queryPath)) return [];

  let query: Query;
  try {
    const querySource = await fs.readFile(queryPath, "utf-8");
    query = new Query(grammar, querySource);
  } catch {
    return [];
  }

  const matches = query.matches(tree.rootNode);
  const defs: CodeDefinition[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    let name: string | undefined;
    let defNode: Parser.SyntaxNode | undefined;
    let defKind = "definition";

    for (const capture of match.captures) {
      if (capture.name.startsWith("name.definition")) {
        name = capture.node.text;
      } else if (capture.name.startsWith("definition")) {
        defNode = capture.node;
        // Derive a readable kind from the capture name (e.g. "definition.function" → "function")
        defKind = capture.name.replace(/^definition\.?/, "") || "definition";
      }
    }

    if (!name || !defNode) continue;

    // Deduplicate by file + start position
    const key = `${relFile}:${defNode.startPosition.row}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Skip very small captures (likely partial matches)
    const text = defNode.text.trim();
    if (text.length < 8) continue;

    defs.push({
      file: filePath,
      relFile,
      startLine: defNode.startPosition.row + 1,
      endLine: defNode.endPosition.row + 1,
      name,
      kind: defKind,
      body: text,
      score: 0,
    });
  }

  return defs;
}

// ── BM25 + optional embedding scoring ─────────────────────────────

/**
 * Score an array of code definitions against a query using BM25,
 * then optionally re-rank with embeddings + RRF fusion.
 */
async function scoreDefinitions(
  defs: CodeDefinition[],
  query: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CodeDefinition[]> {
  if (defs.length === 0) return [];

  // 1. BM25 scoring (takes query string + document string array)
  const bm25 = bm25Scores(query, defs.map((d) => d.body));
  for (let i = 0; i < defs.length; i++) {
    defs[i]!.score = bm25[i] ?? 0;
  }

  // 3. Try embedding re-rank if config available
  try {
    const { validateEmbeddingConfig } = await import("./config.js");
    const embeddingConfig = validateEmbeddingConfig(cwd);

    if (signal?.aborted) throw new Error("Operation aborted");

    // Chunk bodies for embedding (truncate long bodies)
    const embedTexts = defs.map((d) =>
      d.body.length > 2048 ? d.body.slice(0, 2048) : d.body,
    );

    const { vectors } = await fetchEmbeddings({
      baseUrl: embeddingConfig.baseUrl,
      model: embeddingConfig.model,
      apiKey: embeddingConfig.apiKey,
      inputs: [query, ...embedTexts],
      timeoutMs: 30_000,
    });

    if (vectors.length >= embedTexts.length + 1) {
      const queryVec = vectors[0]!;
      for (let i = 0; i < defs.length; i++) {
        const docVec = vectors[i + 1]!;
        let dot = 0,
          qMag = 0,
          dMag = 0;
        for (let j = 0; j < queryVec.length; j++) {
          const qv = queryVec[j] ?? 0;
          const dv = docVec[j] ?? 0;
          dot += qv * dv;
          qMag += qv * qv;
          dMag += dv * dv;
        }
        defs[i]!.similarity =
          qMag > 0 && dMag > 0 ? dot / (Math.sqrt(qMag) * Math.sqrt(dMag)) : 0;
      }

      // 4. RRF fusion of BM25 and embedding scores
      // computeRrfScores expects 1-based rank arrays (best = rank 1)
      const withBm25 = defs.map((d, i) => ({ i, score: d.score }))
        .sort((a, b) => b.score - a.score);
      const bm25Ranks: number[] = [];
      for (let i = 0; i < defs.length; i++) bm25Ranks[withBm25[i]!.i] = i + 1;

      const withSim = defs
        .map((d, i) => ({ i, sim: d.similarity ?? 0 }))
        .sort((a, b) => b.sim - a.sim);
      const simRanks: number[] = [];
      for (let i = 0; i < defs.length; i++) simRanks[withSim[i]!.i] = i + 1;

      const rrfScores = computeRrfScores(simRanks, bm25Ranks);

      for (let i = 0; i < defs.length; i++) {
        defs[i]!.score = rrfScores[i] ?? 0;
      }
    }
  } catch {
    // Embedding not available — BM25-only results are fine
  }

  // Sort by score descending
  return defs.sort((a, b) => b.score - a.score);
}

// ── Enrichment helpers ────────────────────────────────────────────

function shouldEnrich(
  mode: string,
  enrichFlag: boolean | undefined,
  config: SearchConfig,
): boolean {
  if (!enrichFlag) return false;
  const modeEnrich = config.enrich?.[mode as keyof NonNullable<SearchConfig["enrich"]>];
  if (modeEnrich === undefined) return true; // default: on
  // Check if any enrichment type is enabled
  return modeEnrich.callers !== false || modeEnrich.resolution !== false || modeEnrich.symbols !== false;
}

// ── Tool definition ───────────────────────────────────────────────

/**
 * Create the consolidated `search` tool.
 * The `pi` parameter is optional — when provided, the tool registers itself.
 */
export default function createSearchTool(): ToolDefinition {
  const repoMapInstances = new Map<string, RepoMap>();

  function getRepoMap(cwd: string): RepoMap {
    let instance = repoMapInstances.get(cwd);
    if (!instance) {
      instance = new RepoMap(cwd);
      repoMapInstances.set(cwd, instance);
    }
    return instance;
  }

  return {
    name: "search",
    label: "search",
    description: `Search for symbols, resolve a symbol to its definition and references, find callers of a function, or search code by pattern. Supports 4 modes: "symbols" (fuzzy symbol search), "resolve" (exact symbol → def + refs), "callers" (function call graph), "code" (AST-aware code definition search with BM25 + optional embedding re-rank). Set enrich=false to disable cross-mode enrichment (default: true).`,
    parameters: SearchSchema,

    async execute(
      _toolCallId: string,
      params: SearchInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const mode = params.mode;
      const cwd = (params as any).directory ?? ctx.cwd;
      const config = loadSearchConfig(cwd);
      const enrich = shouldEnrich(mode, (params as any).enrich ?? true, config);

      switch (mode) {
        case "symbols":
          if (typeof params.query !== "string" || !params.query.trim()) {
            throw new Error('search mode "symbols" requires a non-empty "query"');
          }
          return handleSymbols(
            params as SearchInput & { mode: "symbols"; query: string },
            cwd,
            signal,
            getRepoMap,
            enrich,
            config,
          );
        case "callers":
          if (typeof params.function !== "string" || !params.function.trim()) {
            throw new Error('search mode "callers" requires a non-empty "function"');
          }
          return handleCallers(
            params as SearchInput & { mode: "callers"; function: string },
            cwd,
            signal,
            enrich,
            config,
          );
        case "resolve":
          if (typeof params.symbol !== "string" || !params.symbol.trim()) {
            throw new Error('search mode "resolve" requires a non-empty "symbol"');
          }
          return handleResolve(
            params as SearchInput & { mode: "resolve"; symbol: string },
            cwd,
            signal,
            ctx,
            enrich,
            config,
          );
        case "code":
          if (typeof params.query !== "string" || !params.query.trim()) {
            throw new Error('search mode "code" requires a non-empty "query"');
          }
          return handleCode(
            params as SearchInput & { mode: "code"; query: string },
            cwd,
            signal,
            enrich,
            config,
          );
      }
    },
  } as unknown as ToolDefinition;
}

// ── Mode handlers ─────────────────────────────────────────────────

async function handleSymbols(
  params: SearchInput & { mode: "symbols" },
  cwd: string,
  signal: AbortSignal | undefined,
  getRepoMap: (cwd: string) => RepoMap,
  enrich: boolean,
  config: SearchConfig,
) {
  const rm = getRepoMap(cwd);
  const startTime = Date.now();
  if (typeof params.query !== "string" || !params.query.trim()) {
    throw new Error('search mode "symbols" requires a non-empty "query"');
  }
  const query = params.query;
  const results: SearchResult[] = await rm.searchIdentifiers(
    query,
    {
      maxResults: params.maxResults ?? 50,
      includeDefinitions: params.includeDefinitions ?? true,
      includeReferences: params.includeReferences ?? true,
    },
    signal,
  );

  if (results.length === 0) {
    const allFiles = await findSrcFiles(cwd);
    return {
      content: [
        {
          type: "text" as const,
          text: `[No symbols found matching "${params.query}". Searched ${allFiles.length} source file(s) in ${cwd}.]`,
        },
      ],
      details: {
        total: 0,
        query: params.query,
        directory: cwd,
        filesScanned: allFiles.length,
        timeMs: Date.now() - startTime,
      },
    };
  }

  const lines: string[] = [
    `Found ${results.length} symbol(s) matching "${params.query}":`,
    "",
  ];

  for (const r of results) {
    const kind = r.kind === "def" ? "def" : "ref";
    const confidence = r.confidence ?? "extracted";
    const contextStr = r.context
      ? `\n${r.context.split("\n").map((l) => `  ${l}`).join("\n")}`
      : "";
    lines.push(`  ${r.file}:${r.line}  [${kind}]  [${confidence}]  ${r.name}${contextStr}`);
    lines.push("");
  }

  // Enrich: resolve the top result if enabled and config allows
  if (enrich && results.length > 0) {
    const configOk = config.enrich?.symbols?.resolution !== false;
    if (configOk) {
      const top = results[0]!;
      try {
        const resolution = await resolveSymbol(
          cwd,
          top.name,
          top.file,
          top.line ?? 1,
          5,
        );
        if (resolution.bestDefinition || resolution.definitions.length > 0) {
          lines.push(`── Enriched: resolved "${top.name}" ──`);
          lines.push("");
          if (resolution.bestDefinition) {
            const bd = resolution.bestDefinition;
            lines.push(`  Best definition: ${bd.file}:${bd.line}`);
            lines.push("");
          }
        }
      } catch {
        // Enrichment is best-effort
      }
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { total: results.length },
  };
}

async function handleCallers(
  params: SearchInput & { mode: "callers" },
  cwd: string,
  signal: AbortSignal | undefined,
  _enrich: boolean,
  _config: SearchConfig,
) {
  const allFiles = await findSrcFiles(cwd, 10_000, signal);
  if (typeof params.function !== "string" || !params.function.trim()) {
    throw new Error('search mode "callers" requires a non-empty "function"');
  }
  const functionName = params.function;
  const callers = await findCallers(allFiles, functionName, signal);
  const max = params.maxResults ?? 50;
  const shown = callers.slice(0, max);

  if (callers.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[No callers found for "${functionName}". The function may be uncalled, externally defined, or in an unsupported language.]`,
        },
      ],
      details: { function: functionName, callers: [], total: 0 },
    };
  }

  const lines: string[] = [
    `Found ${callers.length} caller(s) for "${functionName}":`,
    "",
  ];

  for (const c of shown) {
    lines.push(`  ${c.callerFunction} in ${c.file}`);
  }

  if (callers.length > max) {
    lines.push("");
    lines.push(`  ... and ${callers.length - max} more`);
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: { function: params.function, callers: shown, total: callers.length },
  };
}

async function handleResolve(
  params: SearchInput & { mode: "resolve" },
  cwd: string,
  signal: AbortSignal | undefined,
  _ctx: ExtensionContext,
  enrich: boolean,
  config: SearchConfig,
) {
  if (typeof params.symbol !== "string" || !params.symbol.trim()) {
    throw new Error('search mode "resolve" requires a non-empty "symbol"');
  }
  const symbol = params.symbol;
  // Parse context if provided
  let contextFile: string | undefined;
  let contextLine: number | undefined;
  if (params.context) {
    const lastColon = params.context.lastIndexOf(":");
    if (lastColon !== -1 && lastColon < params.context.length - 1) {
      const trailing = params.context.slice(lastColon + 1);
      const parsed = parseInt(trailing, 10);
      if (!isNaN(parsed)) {
        contextFile = params.context.slice(0, lastColon);
        contextLine = parsed;
      } else {
        contextFile = params.context;
      }
    } else {
      contextFile = params.context;
    }
  }

  if (signal?.aborted) throw new Error("Operation aborted");

  const result = await resolveSymbol(
    cwd,
    symbol,
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

  // Enrich: auto-append callers if enabled
  if (enrich && result.bestDefinition) {
    const configOk = config.enrich?.resolve?.callers !== false;
    if (configOk) {
      try {
        if (signal?.aborted) throw new Error("Operation aborted");
        const allFiles = await findSrcFiles(cwd, 10_000, signal);
        const callers = await findCallers(allFiles, symbol, signal);
        if (callers.length > 0) {
          lines.push(`── Enriched: ${callers.length} caller(s) for "${symbol}" ──`);
          lines.push("");
          for (const c of callers.slice(0, 20)) {
            lines.push(`  ${c.callerFunction} in ${c.file}`);
          }
          if (callers.length > 20) {
            lines.push(`  ... and ${callers.length - 20} more`);
          }
          lines.push("");
        }
      } catch {
        // Enrichment is best-effort
      }
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: result,
  };
}

async function handleCode(
  params: SearchInput & { mode: "code" },
  cwd: string,
  signal: AbortSignal | undefined,
  enrich: boolean,
  config: SearchConfig,
) {
  const maxResults = params.maxResults ?? 20;
  const startTime = Date.now();
  if (typeof params.query !== "string" || !params.query.trim()) {
    throw new Error('search mode "code" requires a non-empty "query"');
  }
  const query = params.query;

  // 1. Discover source files
  const allFiles = await findSrcFiles(cwd, 50_000, signal);
  const maxChars = 3_000_000; // Safety: stop processing after this many chars of source

  // 2. Extract AST definitions from all files
  const allDefs: CodeDefinition[] = [];
  let totalChars = 0;

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (totalChars > maxChars) break;

    const relFile = relative(cwd, filePath);
    const defs = await extractCodeDefinitions(filePath, relFile);
    for (const d of defs) {
      totalChars += d.body.length;
      allDefs.push(d);
    }
  }

  // 3. Score definitions
  const scored = await scoreDefinitions(allDefs, query, cwd, signal);

  // 3b. Graph centrality boost: slightly boost definitions in files that are
  // important nodes in the graphify knowledge graph (when available).
  // Uses a small multiplier (0-20%) so BM25 + embedding signals dominate.
  try {
    const enricher = getGraphifyEnricher(cwd);
    if (enricher.isAvailable) {
      for (const def of scored) {
        const centrality = enricher.getFileCentrality(def.file);
        if (centrality > 0) {
          // Boost by up to 20% for highly central files
          const boost = 1 + Math.min(centrality, 20) * 0.01;
          def.score *= boost;
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }
  } catch {
    // Graphify boost is best-effort
  }

  const top = scored.slice(0, maxResults);

  if (top.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[No code definitions found matching "${query}" across ${allFiles.length} source files.]`,
        },
      ],
      details: {
        total: 0,
        query: params.query,
        filesScanned: allFiles.length,
        definitionsExtracted: allDefs.length,
        timeMs: Date.now() - startTime,
      },
    };
  }

  // 4. Format results
  const lines: string[] = [
    `Found ${top.length} definition(s) matching "${query}" (scored ${allDefs.length} definitions across ${allFiles.length} files, ${Date.now() - startTime}ms):`,
    "",
  ];

  for (const d of top) {
    const simStr =
      d.similarity !== undefined
        ? `  sim=${d.similarity.toFixed(3)}`
        : "";
    lines.push(`  ${d.relFile}:${d.startLine}-${d.endLine}  [${d.kind}]  ${d.name}  score=${d.score.toFixed(3)}${simStr}`);
    lines.push("");

    // Show a compact preview of the definition body
    const bodyLines = d.body.split("\n");
    const previewLines = bodyLines.slice(0, Math.min(bodyLines.length, 5));
    for (const bl of previewLines) {
      lines.push(`    ${bl}`);
    }
    if (bodyLines.length > 5) {
      lines.push(`    ... (${bodyLines.length - 5} more lines)`);
    }
    lines.push("");
  }

  // Enrich: tag results with symbol resolution metadata
  if (enrich && top.length > 0) {
    const configOk = config.enrich?.code?.symbols !== false;
    if (configOk) {
      try {
        const topNames = [...new Set(top.slice(0, 5).map((d) => d.name))];
        const resolvedLines: string[] = ["── Enriched symbol resolution ──", ""];
        for (const name of topNames) {
          if (signal?.aborted) throw new Error("Operation aborted");
          try {
            const resolution = await resolveSymbol(cwd, name, top[0]!.relFile, top[0]!.startLine, 3);
            if (resolution.bestDefinition) {
              resolvedLines.push(
                `  ${name} → ${resolution.bestDefinition.file}:${resolution.bestDefinition.line}`,
              );
            }
          } catch {
            resolvedLines.push(`  ${name} → (resolution failed)`);
          }
        }
        if (resolvedLines.length > 1) {
          lines.push(...resolvedLines);
          lines.push("");
        }
      } catch {
        // Enrichment is best-effort
      }
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      total: top.length,
      totalScored: allDefs.length,
      filesScanned: allFiles.length,
      timeMs: Date.now() - startTime,
    },
  };
}
