/**
 * Consolidated search tool.
 *
 * Modes:
 *   - (default)   AST-aware grep — finds definitions whose names match the query.
 *                  No embeddings, no BM25. Fast, simple, based on tree-sitter.
 *   - code        AST-aware search + BM25 scoring + optional embedding re-rank
 *                  + symbol resolution enrichment. Supersedes old symbols/callers/resolve.
 *   - deep        Full multi-channel orchestration: code + symbols + semantic + graph.
 *
 * Modes "symbols", "callers", and "resolve" are removed. Their functionality is
 * available through the default grep mode (symbol search) and code mode (enrichment
 * auto-resolves top symbols and shows callers).
 */
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { relative, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import Parser, { Query } from "tree-sitter";
import { resolveSymbol } from "./symbol-resolver.js";
import { findCallers } from "./callgraph.js";
import { loadLanguage, getQueryPath } from "./tags.js";
import { findSrcFiles } from "./file-discovery.js";
import { shouldShowLowResultHint } from "./hook.js";
import { filenameToLang } from "./languages.js";
import { loadSearchConfig } from "./config.js";
import { bm25Scores, computeRrfScores } from "./scoring.js";
import { fetchEmbeddings } from "./embedding.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { classifyRelevanceByScore, classifySimilarity } from "./classifiers.js";
import { expandToMonorepoRoots } from "./monorepo-detector.js";
import { executeDeepSearch } from "./deep-search.js";
import { getLSPBridge } from "./lsp-bridge.js";

// ── Schema ────────────────────────────────────────────────────────

const SearchSchema = Type.Object({
  mode: Type.Optional(
    Type.Unsafe<"grep" | "code" | "deep">({
      type: "string",
      enum: ["grep", "code", "deep"],
      description:
        "Search mode. Default 'grep': AST-aware definition search (fast, no embeddings). 'code': BM25 + optional embedding re-rank with symbol resolution. 'deep': multi-channel orchestration.",
      default: "grep",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Identifier name, code pattern, or search query",
      minLength: 1,
    }),
  ),
  directory: Type.Optional(
    Type.String({
      description: "Root directory to search (default: extension working directory)",
      default: ".",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: "Maximum results to return (1-10000)",
      minimum: 1,
      maximum: 10000,
    }),
  ),
});

type SearchInput = Static<typeof SearchSchema>;

// ── Code-definition extraction ────────────────────────────────────

interface CodeDefinition {
  file: string;
  relFile: string;
  startLine: number;
  endLine: number;
  name: string;
  kind: string;
  body: string;
  score: number;
  similarity?: number;
}

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
  const CHUNK_SIZE = 1024;
  const tree = parser.parse((offset) => code.slice(offset, offset + CHUNK_SIZE));
  if (!tree?.rootNode) return [];

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
        defKind = capture.name.replace(/^definition\.?/, "") || "definition";
      }
    }

    if (!name || !defNode) continue;

    const key = `${relFile}:${defNode.startPosition.row}`;
    if (seen.has(key)) continue;
    seen.add(key);

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

async function scoreDefinitions(
  defs: CodeDefinition[],
  query: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CodeDefinition[]> {
  if (defs.length === 0) return [];

  const bm25 = bm25Scores(query, defs.map((d) => d.body));
  for (let i = 0; i < defs.length; i++) {
    defs[i]!.score = bm25[i] ?? 0;
  }

  try {
    const { validateEmbeddingConfig } = await import("./config.js");
    const embeddingConfig = validateEmbeddingConfig(cwd);

    if (!embeddingConfig) {
      return defs.sort((a, b) => b.score - a.score);
    }

    if (signal?.aborted) throw new Error("Operation aborted");

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
        let dot = 0, qMag = 0, dMag = 0;
        for (let j = 0; j < queryVec.length; j++) {
          const qv = queryVec[j] ?? 0;
          const dv = docVec[j] ?? 0;
          dot += qv * dv;
          qMag += qv * qv;
          dMag += dv * dv;
        }
        defs[i]!.similarity = qMag > 0 && dMag > 0 ? dot / (Math.sqrt(qMag) * Math.sqrt(dMag)) : 0;
      }

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

  return defs.sort((a, b) => b.score - a.score);
}

// ── Helpers ───────────────────────────────────────────────────────

function lspSymbolKindToString(kind: number): string {
  // LSP SymbolKind enum: 1=File,2=Module,3=Namespace,4=Package,5=Class,
  // 6=Method,7=Property,8=Field,9=Constructor,10=Enum,11=Interface,
  // 12=Function,13=Variable,14=Constant,15=String,16=Number,17=Boolean,18=Array,
  // 19=Object,20=Key,21=Null,22=EnumMember,23=Struct,24=Event,25=Operator,26=TypeParameter
  switch (kind) {
    case 5: return "class";
    case 6: return "method";
    case 7: case 8: return "property";
    case 9: return "constructor";
    case 10: return "enum";
    case 11: return "interface";
    case 12: return "function";
    case 13: case 14: return "variable";
    case 22: return "enum-member";
    case 23: return "struct";
    case 24: return "event";
    default: return "symbol";
  }
}

function resolveSearchRoot(params: SearchInput, defaultCwd: string): string {
  const directory = params.directory?.trim();
  return directory ? resolve(defaultCwd, directory) : defaultCwd;
}

// ── Handlers ──────────────────────────────────────────────────────

async function handleDeep(
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const query = params.query ?? "";
  if (!query.trim()) throw new Error('search mode "deep" requires a non-empty "query"');
  return executeDeepSearch(
    {
      query,
      depth: "standard",
      scope: "all",
      directory: params.directory ?? cwd,
      limit: params.maxResults ?? 15,
      maxSnippetChars: 400,
      outputBudget: 4096,
      includeRelationships: undefined,
      focusFiles: undefined,
    },
    signal,
    ctx,
  );
}

async function handleGrep(
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
) {
  const query = params.query!.trim();
  const maxResults = params.maxResults ?? 30;
  const startTime = Date.now();

  const searchRoots = expandToMonorepoRoots(cwd);
  let allFiles: string[] = [];
  for (const root of searchRoots) {
    const files = await findSrcFiles(root, 50_000, signal);
    allFiles.push(...files);
  }
  allFiles = [...new Set(allFiles)];
  const matches: CodeDefinition[] = [];
  let totalDefs = 0;
  const maxChars = 3_000_000;
  let totalChars = 0;

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matches.length >= maxResults || totalChars > maxChars) break;

    const relFile = relative(cwd, filePath);
    const defs = await extractCodeDefinitions(filePath, relFile);
    totalDefs += defs.length;

    for (const d of defs) {
      totalChars += d.body.length;
      // Simple case-insensitive substring match on definition name
      if (d.name.toLowerCase().includes(query.toLowerCase())) {
        matches.push(d);
        if (matches.length >= maxResults) break;
      }
    }
  }

  if (matches.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[No definitions matching "${query}" across ${allFiles.length} source files (${totalDefs} definitions scanned).]`,
        },
      ],
      details: {
        total: 0,
        query,
        filesScanned: allFiles.length,
        definitionsScanned: totalDefs,
        timeMs: Date.now() - startTime,
      },
    };
  }

  const lines: string[] = [
    `Found ${matches.length} definition(s) matching "${query}" (${totalDefs} definitions scanned across ${allFiles.length} files, ${Date.now() - startTime}ms):`,
    "",
  ];

  for (let i = 0; i < matches.length; i++) {
    const d = matches[i]!;
    lines.push(`  ${d.relFile}:${d.startLine}-${d.endLine}  [${d.kind}]  ${d.name}`);
    const bodyLines = d.body.split("\n");
    const previewLines = bodyLines.slice(0, Math.min(bodyLines.length, 4));
    for (const bl of previewLines) {
      lines.push(`    ${bl}`);
    }
    if (bodyLines.length > 4) {
      lines.push(`    ... (${bodyLines.length - 4} more lines)`);
    }
    lines.push("");
  }

  if (matches.length < 3) {
    lines.push(
      `> 💡 Only ${matches.length} result(s) found. Try ` +
        `\`search mode=code query="${query}"\` for ranked BM25 search, or ` +
        `\`search mode=deep query="${query}"\` for multi-channel semantic search.`,
    );
    lines.push("");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      total: matches.length,
      filesScanned: allFiles.length,
      definitionsScanned: totalDefs,
      timeMs: Date.now() - startTime,
    },
  };
}

async function handleCode(
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
  enrich: boolean,
) {
  const maxResults = params.maxResults ?? 20;
  const startTime = Date.now();
  const query = params.query!.trim();

  // 1. Discover source files (with monorepo workspace expansion)
  const searchRoots = expandToMonorepoRoots(cwd);
  let allFiles: string[] = [];
  for (const root of searchRoots) {
    const files = await findSrcFiles(root, 50_000, signal);
    allFiles.push(...files);
  }
  allFiles = [...new Set(allFiles)];
  const maxChars = 3_000_000;

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

  // 3. BM25 pre-filter
  const preFilterN = Math.min(maxResults * 5, 200);
  const bm25All = bm25Scores(query, allDefs.map((d) => d.body));
  for (let i = 0; i < allDefs.length; i++) {
    allDefs[i]!.score = bm25All[i] ?? 0;
  }
  allDefs.sort((a, b) => b.score - a.score);

  const topForEmbedding = allDefs.slice(0, preFilterN);
  const bm25Only = allDefs.slice(preFilterN);

  // 4. Score top definitions (BM25 + optional embedding re-rank)
  const scored = topForEmbedding.length > 0
    ? await scoreDefinitions(topForEmbedding, query, cwd, signal)
    : [];

  // Graph centrality boost
  try {
    const enricher = getGraphifyEnricher(cwd);
    if (enricher.isAvailable) {
      for (const def of scored) {
        const centrality = enricher.getFileCentrality(def.file);
        if (centrality > 0) {
          def.score *= 1 + Math.min(centrality, 20) * 0.01;
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }
  } catch { /* best-effort */ }

  const allResults = [...scored, ...bm25Only.sort((a, b) => b.score - a.score)];

  // 5. LSP workspace/symbol — additional retrieval channel
  let lspResultsCount = 0;
  try {
    const bridge = await getLSPBridge();
    if (bridge?.isAvailable() && query.length > 2) {
      const root = params.directory ? resolve(cwd, params.directory) : cwd;
      const wsSymbols = await bridge.workspaceSymbol(query, root);
      if (wsSymbols.length > 0) {
        const existingKeys = new Set(allResults.map((d) => `${d.relFile}:${d.name}`));
        for (const sym of wsSymbols) {
          const uri = sym.location.uri;
          const filePath = uri.startsWith("file://") ? uri.slice(7) : uri;
          const relFile = relative(cwd, filePath);
          const key = `${relFile}:${sym.name}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          lspResultsCount++;
          allResults.push({
            file: filePath,
            relFile,
            startLine: sym.location.range.start.line + 1,
            endLine: sym.location.range.end.line + 1,
            name: sym.name,
            kind: lspSymbolKindToString(sym.kind),
            body: "",
            score: 1.0,
            similarity: undefined,
          });
        }
      }
    }
  } catch { /* LSP workspace/symbol is best-effort */ }

  // Re-sort since LSP entries were pushed with score 1.0
  if (lspResultsCount > 0) {
    allResults.sort((a, b) => b.score - a.score);
  }

  const top = allResults.slice(0, maxResults);

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
        query,
        filesScanned: allFiles.length,
        definitionsExtracted: allDefs.length,
        timeMs: Date.now() - startTime,
        lspResults: lspResultsCount,
      },
    };
  }

  const lines: string[] = [
    `Found ${top.length} definition(s) matching "${query}" (${allDefs.length} definitions across ${allFiles.length} files${lspResultsCount > 0 ? `, ${lspResultsCount} from LSP` : ""}, ${Date.now() - startTime}ms):`,
    "",
  ];
  const maxTopScore = Math.max(...top.map((d) => d.score), 0);

  for (let index = 0; index < top.length; index++) {
    const d = top[index]!;
    const embeddingStr =
      d.similarity !== undefined ? `  embedding=${classifySimilarity(d.similarity)}` : "";
    lines.push(
      `  ${d.relFile}:${d.startLine}-${d.endLine}  [${d.kind}]  ${d.name}  ` +
        `relevance=${classifyRelevanceByScore(d.score, maxTopScore)}  rank=${index + 1}${embeddingStr}`,
    );
    lines.push("");

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

  // Auto-escalation hint
  if (top.length < 3 && enrich !== false && shouldShowLowResultHint()) {
    lines.push(
      `> 💡 Only ${top.length} result(s) found. Try ` +
        `\`search mode=deep query="${query}"\` for multi-channel semantic search + graph expansion.`,
    );
    lines.push("");
  }

  // Enrich: symbol resolution + callers for top matches
  if (enrich !== false && top.length > 0) {
    try {
      // Build a name->first-entry map for correct context per symbol
      const nameToEntry = new Map<string, typeof top[0]>();
      for (const entry of top) {
        if (!nameToEntry.has(entry.name)) {
          nameToEntry.set(entry.name, entry);
        }
      }
      const topNames = [...nameToEntry.keys()].slice(0, 5);
      const resolvedLines: string[] = ["── Enriched ──", ""];

      for (const name of topNames) {
        if (signal?.aborted) break;
        try {
          const entry = nameToEntry.get(name)!;
          const resolution = await resolveSymbol(cwd, name, entry.relFile, entry.startLine, 3);
          let defLine = `  ${name} → `;
          if (resolution.bestDefinition) {
            defLine += `def: ${resolution.bestDefinition.file}:${resolution.bestDefinition.line}`;
          } else {
            defLine += `(no definition found)`;
          }
          if (resolution.references.length > 0) {
            defLine += `  (${resolution.references.length} refs)`;
          }
          resolvedLines.push(defLine);
        } catch {
          resolvedLines.push(`  ${name} → (resolution failed)`);
        }
      }

      // Also find callers for the top result names
      if (topNames.length > 0 && !signal?.aborted) {
        try {
          for (const name of topNames.slice(0, 3)) {
            try {
              const callers = await findCallers(allFiles, name, signal);
              if (callers.length > 0) {
                resolvedLines.push(
                  `  ${name} callers: ${callers.slice(0, 5).map((c) => `${c.callerFunction} in ${c.file}`).join(", ")}` +
                    (callers.length > 5 ? ` (+${callers.length - 5} more)` : ""),
                );
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      }

      if (resolvedLines.length > 1) {
        lines.push(...resolvedLines);
        lines.push("");
      }
    } catch { /* enrichment is best-effort */ }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      total: top.length,
      totalScored: allDefs.length,
      lspResults: lspResultsCount,
      filesScanned: allFiles.length,
      timeMs: Date.now() - startTime,
    },
  };
}

// ── Tool definition ───────────────────────────────────────────────

export default function createSearchTool(): ToolDefinition {
  return {
    name: "search",
    label: "search",
    description:
      'Search code by identifier or pattern. Default mode (grep): AST-aware definition search — fast, no embeddings. ' +
      'mode=code: BM25 + optional embedding re-rank with symbol resolution and caller enrichment. ' +
      'mode=deep: multi-channel orchestration (code + symbols + semantic + graph). ' +
      'Use directory to scope the search root.',
    parameters: SearchSchema,

    async execute(
      _toolCallId: string,
      params: SearchInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const mode = params.mode ?? "grep";
      const cwd = resolveSearchRoot(params, ctx.cwd);

      if (typeof params.query !== "string" || !params.query.trim()) {
        throw new Error(`search mode "${mode}" requires a non-empty "query"`);
      }

      switch (mode) {
        case "grep":
          return handleGrep(params, cwd, signal);

        case "code": {
          const config = loadSearchConfig(cwd);
          const enrich =
            (config.enrich?.code?.symbols !== false || config.enrich?.code?.callers !== false);
          return handleCode(params, cwd, signal, enrich);
        }

        case "deep":
          return handleDeep(params, cwd, signal, ctx);
      }
    },
  } as unknown as ToolDefinition;
}
