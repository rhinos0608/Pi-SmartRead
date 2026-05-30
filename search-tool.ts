/**
 * Consolidated search tool.
 *
 * Modes:
 *   - (default)   grep-style repository text search with definition-aware ranking.
 *   - code        AST-aware search + BM25 scoring + optional embedding re-rank
 *                  + symbol resolution enrichment.
 *   - deep        Full multi-channel orchestration: code + symbols + semantic + graph.
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
import {
  discoverFiles,
  type DiscoveryProfile,
  type FileDiscoveryDiagnostics,
} from "./file-discovery.js";
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
import { recordSparse, resolveSessionKey } from "./file-read-cache.js";

type SearchMode = "grep" | "code" | "deep";
type SearchMatchMode = "literal" | "regex";

// ── Schema ────────────────────────────────────────────────────────

const SearchSchema = Type.Object({
  mode: Type.Optional(
    Type.Unsafe<SearchMode>({
      type: "string",
      enum: ["grep", "code", "deep"],
      description:
        "Search mode. Default 'grep': grep-style line search across repository text files with definition-aware ranking. 'code': BM25 + optional embedding re-rank with symbol resolution. 'deep': multi-channel orchestration.",
      default: "grep",
    }),
  ),
  query: Type.String({
    description: "Identifier name, code pattern, or search query",
    minLength: 1,
  }),
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
  matchMode: Type.Optional(
    Type.Unsafe<SearchMatchMode>({
      type: "string",
      enum: ["literal", "regex"],
      description: "How grep mode matches the query. Default: literal substring search.",
      default: "literal",
    }),
  ),
  caseSensitive: Type.Optional(
    Type.Boolean({
      description:
        "Whether grep mode is case-sensitive. Default: auto-detect (case-sensitive only for mixed-case queries).",
    }),
  ),
  contextLines: Type.Optional(
    Type.Number({
      description: "Number of surrounding context lines to include for grep hits (0-2).",
      minimum: 0,
      maximum: 2,
      default: 0,
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

interface GrepSearchMatch {
  group: "definition" | "text";
  file: string;
  relFile: string;
  line: number;
  endLine: number;
  kind: string;
  name: string;
  lineText: string;
  snippet: string;
}

interface DiscoverySummary extends FileDiscoveryDiagnostics {
  workspaceRootsSearched: string[];
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
  const chunkSize = 1024;
  const tree = parser.parse((offset) => code.slice(offset, offset + chunkSize));
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
        let dot = 0;
        let qMag = 0;
        let dMag = 0;
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

      const withBm25 = defs
        .map((d, i) => ({ i, score: d.score }))
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
  switch (kind) {
    case 5:
      return "class";
    case 6:
      return "method";
    case 7:
    case 8:
      return "property";
    case 9:
      return "constructor";
    case 10:
      return "enum";
    case 11:
      return "interface";
    case 12:
      return "function";
    case 13:
    case 14:
      return "variable";
    case 22:
      return "enum-member";
    case 23:
      return "struct";
    case 24:
      return "event";
    default:
      return "symbol";
  }
}

function resolveSearchRoot(params: SearchInput, defaultCwd: string): string {
  const directory = params.directory?.trim();
  return directory ? resolve(defaultCwd, directory) : defaultCwd;
}

function defaultCaseSensitive(query: string): boolean {
  return /[a-z]/.test(query) && /[A-Z]/.test(query);
}

function clampContextLines(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(2, Math.trunc(value)));
}

function collapseSearchRoots(roots: string[]): string[] {
  const unique = [...new Set(roots.map((root) => resolve(root)))].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const root of unique) {
    const covered = kept.some((candidate) => {
      const rel = relative(candidate, root);
      return rel === "" || (!rel.startsWith("..") && rel !== "");
    });
    if (!covered) kept.push(root);
  }
  return kept;
}

async function discoverAcrossRoots(
  roots: string[],
  profile: DiscoveryProfile,
  signal: AbortSignal | undefined,
): Promise<{ files: string[]; summary: DiscoverySummary }> {
  const collapsedRoots = collapseSearchRoots(roots);
  const seen = new Set<string>();
  const files: string[] = [];
  const summary: DiscoverySummary = {
    profile,
    root: collapsedRoots[0] ?? "",
    directoriesVisited: 0,
    filesConsidered: 0,
    filesMatched: 0,
    filesSkippedIgnored: 0,
    filesSkippedBinary: 0,
    filesSkippedUnsupported: 0,
    workspaceRootsSearched: collapsedRoots,
  };

  for (const root of collapsedRoots) {
    const result = await discoverFiles(root, profile, 50_000, signal);
    summary.directoriesVisited += result.diagnostics.directoriesVisited;
    summary.filesConsidered += result.diagnostics.filesConsidered;
    summary.filesMatched += result.diagnostics.filesMatched;
    summary.filesSkippedIgnored += result.diagnostics.filesSkippedIgnored;
    summary.filesSkippedBinary += result.diagnostics.filesSkippedBinary;
    summary.filesSkippedUnsupported += result.diagnostics.filesSkippedUnsupported;

    for (const file of result.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }

  return { files, summary };
}

function buildLineMatcher(
  query: string,
  matchMode: SearchMatchMode,
  caseSensitive: boolean,
): (line: string) => boolean {
  if (matchMode === "literal") {
    if (caseSensitive) {
      return (line) => line.includes(query);
    }
    const lowered = query.toLowerCase();
    return (line) => line.toLowerCase().includes(lowered);
  }

  const flags = caseSensitive ? "" : "i";
  let regex: RegExp;
  try {
    regex = new RegExp(query, flags);
  } catch {
    // Invalid regex — fall back to literal matching
    if (caseSensitive) {
      return (line) => line.includes(query);
    }
    const lowered = query.toLowerCase();
    return (line) => line.toLowerCase().includes(lowered);
  }
  return (line) => regex.test(line);
}

function formatSnippet(lines: string[], lineNumber: number, contextLines: number): { snippet: string; endLine: number } {
  const startIndex = Math.max(0, lineNumber - 1 - contextLines);
  const endIndex = Math.min(lines.length - 1, lineNumber - 1 + contextLines);
  const snippetLines: string[] = [];

  for (let index = startIndex; index <= endIndex; index++) {
    const displayLine = String(index + 1).padStart(4, " ");
    snippetLines.push(`    ${displayLine} | ${lines[index] ?? ""}`);
  }

  return {
    snippet: snippetLines.join("\n"),
    endLine: endIndex + 1,
  };
}

function findOwningDefinition(
  definitions: CodeDefinition[],
  line: number,
): CodeDefinition | undefined {
  return definitions.find((definition) => definition.startLine <= line && definition.endLine >= line);
}

function formatGrepResults(
  query: string,
  matches: GrepSearchMatch[],
  summary: DiscoverySummary,
  elapsedMs: number,
  matchMode: SearchMatchMode,
  caseSensitive: boolean,
): string {
  const definitionHits = matches.filter((match) => match.group === "definition");
  const textHits = matches.filter((match) => match.group === "text");
  const lines: string[] = [
    `Found ${matches.length} match(es) for "${query}" (${matchMode}, ${caseSensitive ? "case-sensitive" : "case-insensitive"}, ${elapsedMs}ms):`,
    "",
  ];

  if (definitionHits.length > 0) {
    lines.push("Definition hits:", "");
    for (const match of definitionHits) {
      lines.push(`  ${match.relFile}:${match.line}-${match.endLine} [${match.kind}] ${match.name}`);
      lines.push(match.snippet);
      lines.push("");
    }
  }

  if (textHits.length > 0) {
    lines.push("Text hits:", "");
    for (const match of textHits) {
      lines.push(`  ${match.relFile}:${match.line}-${match.endLine} [text] ${match.name}`);
      lines.push(match.snippet);
      lines.push("");
    }
  }

  if (matches.length === 0) {
    lines.push(
      `[No text matches for "${query}" across ${summary.filesMatched} searchable files (${summary.filesSkippedBinary} binary skipped, ${summary.filesSkippedIgnored} ignored, ${summary.filesSkippedUnsupported} unsupported).]`,
    );
  } else if (matches.length < 3) {
    lines.push(
      `> 💡 Only ${matches.length} result(s) found. Try ` +
        `\`search mode=code query="${query}"\` for structural ranking, or ` +
        `\`search mode=deep query="${query}"\` for multi-channel exploration.`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ── Handlers ──────────────────────────────────────────────────────

async function handleDeep(
  toolCallId: string,
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const query = params.query ?? "";
  if (!query.trim()) throw new Error('search mode "deep" requires a non-empty "query"');
  const result = await executeDeepSearch(
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
      if (validMatches.length === 0) {
        validMatches = undefined;
      }
    }
  }

  if (validMatches && validMatches.length > 0) {
    const byFile = new Map<string, Array<{ line: number; text: string }>>();
    for (const match of validMatches) {
      const absPath = resolve(cwd, match.file);
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
}

async function handleGrep(
  toolCallId: string,
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
) {
  const query = params.query!.trim();
  const maxResults = params.maxResults ?? 30;
  const matchMode = params.matchMode ?? "literal";
  const caseSensitive = params.caseSensitive ?? defaultCaseSensitive(query);
  const contextLines = clampContextLines(params.contextLines);
  const startTime = Date.now();
  const matchLine = buildLineMatcher(query, matchMode, caseSensitive);

  const searchRoots = expandToMonorepoRoots(cwd);
  const { files: allFiles, summary } = await discoverAcrossRoots(searchRoots, "text", signal);
  const definitionCache = new Map<string, CodeDefinition[]>();
  const matches: GrepSearchMatch[] = [];

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matches.length >= maxResults) break;

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const relFile = relative(cwd, filePath).replace(/\\/g, "/");
    const lines = content.split(/\r?\n/g);
    let definitions = definitionCache.get(filePath);
    if (!definitions) {
      definitions = await extractCodeDefinitions(filePath, relFile);
      definitionCache.set(filePath, definitions);
    }

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (!matchLine(line)) continue;

      const lineNumber = index + 1;
      const owner = findOwningDefinition(definitions, lineNumber);
      const snippet = formatSnippet(lines, lineNumber, contextLines);
      matches.push({
        group: owner ? "definition" : "text",
        file: filePath,
        relFile,
        line: lineNumber,
        endLine: snippet.endLine,
        kind: owner?.kind ?? "text",
        name: owner?.name ?? (line.trim().slice(0, 80) || "(text match)"),
        lineText: line,
        snippet: snippet.snippet,
      });

      if (matches.length >= maxResults) break;
    }
  }

  matches.sort((a, b) => {
    if (a.group !== b.group) return a.group === "definition" ? -1 : 1;
    return a.relFile.localeCompare(b.relFile) || a.line - b.line;
  });

  const sessionKey = resolveSessionKey(toolCallId);
  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const match of matches) {
    const entries = byFile.get(match.file) ?? [];
    entries.push({ line: match.line, text: match.snippet });
    byFile.set(match.file, entries);
  }
  for (const [absPath, entries] of byFile) {
    recordSparse(sessionKey, absPath, entries);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: formatGrepResults(
          query,
          matches,
          summary,
          Date.now() - startTime,
          matchMode,
          caseSensitive,
        ),
      },
    ],
    details: {
      mode: "grep",
      total: matches.length,
      query,
      matchMode,
      caseSensitive,
      contextLines,
      definitionHits: matches.filter((match) => match.group === "definition").length,
      textHits: matches.filter((match) => match.group === "text").length,
      filesScanned: allFiles.length,
      filesConsidered: summary.filesConsidered,
      filesSkippedIgnored: summary.filesSkippedIgnored,
      filesSkippedBinary: summary.filesSkippedBinary,
      filesSkippedUnsupported: summary.filesSkippedUnsupported,
      workspaceRootsSearched: summary.workspaceRootsSearched,
      timeMs: Date.now() - startTime,
      matches,
    },
  };
}

async function handleCode(
  toolCallId: string,
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
  enrich: boolean,
) {
  const maxResults = params.maxResults ?? 20;
  const startTime = Date.now();
  const query = params.query!.trim();

  const searchRoots = expandToMonorepoRoots(cwd);
  const { files: allFiles, summary } = await discoverAcrossRoots(searchRoots, "code", signal);
  const maxChars = 3_000_000;

  const allDefs: CodeDefinition[] = [];
  let totalChars = 0;

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (totalChars > maxChars) break;

    const relFile = relative(cwd, filePath).replace(/\\/g, "/");
    const defs = await extractCodeDefinitions(filePath, relFile);
    for (const definition of defs) {
      totalChars += definition.body.length;
      allDefs.push(definition);
    }
  }

  const preFilterN = Math.min(maxResults * 5, 200);
  const bm25All = bm25Scores(query, allDefs.map((d) => d.body));
  for (let i = 0; i < allDefs.length; i++) {
    allDefs[i]!.score = bm25All[i] ?? 0;
  }
  allDefs.sort((a, b) => b.score - a.score);

  const topForEmbedding = allDefs.slice(0, preFilterN);
  const bm25Only = allDefs.slice(preFilterN);

  const scored = topForEmbedding.length > 0
    ? await scoreDefinitions(topForEmbedding, query, cwd, signal)
    : [];

  try {
    const enricher = getGraphifyEnricher(cwd);
    if (enricher.isAvailable) {
      for (const definition of scored) {
        const centrality = enricher.getFileCentrality(definition.file);
        if (centrality > 0) {
          definition.score *= 1 + Math.min(centrality, 20) * 0.01;
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }
  } catch {
    // best-effort only
  }

  const allResults = [...scored, ...bm25Only.sort((a, b) => b.score - a.score)];

  let lspResultsCount = 0;
  try {
    const bridge = await getLSPBridge();
    if (bridge?.isAvailable() && query.length > 2) {
      const root = params.directory ? resolve(cwd, params.directory) : cwd;
      const wsSymbols = await bridge.workspaceSymbol(query, root);
      if (wsSymbols.length > 0) {
        const existingKeys = new Set(allResults.map((d) => `${d.relFile}:${d.name}`));
        for (const symbol of wsSymbols) {
          const uri = symbol.location.uri;
          const filePath = uri.startsWith("file://") ? uri.slice(7) : uri;
          const relFile = relative(cwd, filePath).replace(/\\/g, "/");
          const key = `${relFile}:${symbol.name}`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          lspResultsCount++;
          allResults.push({
            file: filePath,
            relFile,
            startLine: symbol.location.range.start.line + 1,
            endLine: symbol.location.range.end.line + 1,
            name: symbol.name,
            kind: lspSymbolKindToString(symbol.kind),
            body: "",
            score: 1.0,
            similarity: undefined,
          });
        }
      }
    }
  } catch {
    // best-effort only
  }

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
        mode: "code",
        total: 0,
        query,
        filesScanned: allFiles.length,
        filesConsidered: summary.filesConsidered,
        filesSkippedIgnored: summary.filesSkippedIgnored,
        filesSkippedUnsupported: summary.filesSkippedUnsupported,
        workspaceRootsSearched: summary.workspaceRootsSearched,
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
    const definition = top[index]!;
    const embeddingStr =
      definition.similarity !== undefined ? `  embedding=${classifySimilarity(definition.similarity)}` : "";
    lines.push(
      `  ${definition.relFile}:${definition.startLine}-${definition.endLine} [${definition.kind}] ${definition.name} ` +
        `relevance=${classifyRelevanceByScore(definition.score, maxTopScore)} rank=${index + 1}${embeddingStr}`,
    );
    lines.push("");

    const bodyLines = definition.body.split("\n");
    const previewLines = bodyLines.slice(0, Math.min(bodyLines.length, 5));
    for (const bodyLine of previewLines) {
      lines.push(`    ${bodyLine}`);
    }
    if (bodyLines.length > 5) {
      lines.push(`    ... (${bodyLines.length - 5} more lines)`);
    }
    lines.push("");
  }

  if (top.length < 3 && enrich !== false && shouldShowLowResultHint()) {
    lines.push(
      `> 💡 Only ${top.length} result(s) found. Try ` +
        `\`search mode=deep query="${query}"\` for multi-channel semantic search + graph expansion.`,
    );
    lines.push("");
  }

  if (enrich !== false && top.length > 0) {
    try {
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
          let defLine = `  ${name} -> `;
          if (resolution.bestDefinition) {
            defLine += `def: ${resolution.bestDefinition.file}:${resolution.bestDefinition.line}`;
          } else {
            defLine += "(no definition found)";
          }
          if (resolution.references.length > 0) {
            defLine += ` (${resolution.references.length} refs)`;
          }
          resolvedLines.push(defLine);
        } catch {
          resolvedLines.push(`  ${name} -> (resolution failed)`);
        }
      }

      if (topNames.length > 0 && !signal?.aborted) {
        for (const name of topNames.slice(0, 3)) {
          try {
            const callers = await findCallers(allFiles, name, signal);
            if (callers.length > 0) {
              resolvedLines.push(
                `  ${name} callers: ${callers.slice(0, 5).map((caller) => `${caller.callerFunction} in ${caller.file}`).join(", ")}` +
                  (callers.length > 5 ? ` (+${callers.length - 5} more)` : ""),
              );
            }
          } catch {
            // skip caller enrichment failures
          }
        }
      }

      if (resolvedLines.length > 1) {
        lines.push(...resolvedLines);
        lines.push("");
      }
    } catch {
      // enrichment is best-effort
    }
  }

  const sessionKey = resolveSessionKey(toolCallId);
  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const definition of top) {
    const entries = byFile.get(definition.file) ?? [];
    entries.push({ line: definition.startLine, text: definition.body });
    byFile.set(definition.file, entries);
  }
  for (const [absPath, entries] of byFile) {
    recordSparse(sessionKey, absPath, entries);
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode: "code",
      total: top.length,
      totalScored: allDefs.length,
      lspResults: lspResultsCount,
      filesScanned: allFiles.length,
      filesConsidered: summary.filesConsidered,
      filesSkippedIgnored: summary.filesSkippedIgnored,
      filesSkippedUnsupported: summary.filesSkippedUnsupported,
      workspaceRootsSearched: summary.workspaceRootsSearched,
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
      'Search repository text and code. Default mode (grep): line-oriented text search with definition-aware ranking. ' +
      'mode=code: BM25 + optional embedding re-rank with symbol resolution and caller enrichment. ' +
      'mode=deep: multi-channel orchestration (code + symbols + semantic + graph). ' +
      'Use directory to scope the search root.',
    parameters: SearchSchema,

    async execute(
      toolCallId: string,
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
          return handleGrep(toolCallId, params, cwd, signal);
        case "code": {
          const config = loadSearchConfig(cwd);
          const enrich =
            config.enrich?.code?.symbols !== false || config.enrich?.code?.callers !== false;
          return handleCode(toolCallId, params, cwd, signal, enrich);
        }
        case "deep":
          return handleDeep(toolCallId, params, cwd, signal, ctx);
      }
    },
  } as unknown as ToolDefinition;
}
