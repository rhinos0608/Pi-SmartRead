/**
 * Unified search tool.
 *
 * Runs both grep-style text search and AST-aware code search, merging
 * results into a single response. depth: "deep" retains those channels and
 * adds fused semantic, symbol, graph, and LSP evidence with provenance.
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
  IGNORED_DETAILS_LIMIT,
} from "./file-discovery.js";
import { shouldShowLowResultHint } from "./hook.js";
import { filenameToLang, isSupportedFile } from "./languages.js";
import { loadSearchConfig } from "./config.js";
import { bm25Scores, computeRrfScores, cosineSimilarity } from "./scoring.js";
import { fetchEmbeddings } from "./embedding.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { classifyRelevanceByScore, classifySimilarity } from "./classifiers.js";
import { expandToMonorepoRoots } from "./monorepo-detector.js";
import { getLSPBridge } from "./lsp-bridge.js";
import { recordSparse, resolveSessionKey } from "./file-read-cache.js";
import { executeDeepSearch } from "./deep-search.js";
import {
  evaluateBooleanExpression,
  parseBooleanQuery,
} from "./boolean-query.js";
// Facade re-exports: boolean-query lives in its own module.
// Re-exported here so existing `search-tool.js` import paths keep working.
export {
  evaluateBooleanExpression,
  parseBooleanQuery,
  type BooleanExpression,
} from "./boolean-query.js";
import {
  matchAstNodesInFile,
  parseAstPattern,
} from "./search-ast-pattern.js";
// Facade re-exports: search-ast-pattern lives in its own module.
// Re-exported here so existing `search-tool.js` import paths keep working.
export {
  parseAstPattern,
  type ParsedAstPattern,
} from "./search-ast-pattern.js";


type SearchMatchMode = "literal" | "regex" | "boolean" | "ast_pattern";

// ── Schema ────────────────────────────────────────────────────────

const SearchSchema = Type.Object({
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
      description: "Maximum results to return (default: 30, clamped to 1-10000).",
      default: 30,
    }),
  ),
  matchMode: Type.Optional(
    Type.Unsafe<SearchMatchMode>({
      type: "string",
      enum: ["literal", "regex", "boolean", "ast_pattern"],
      description: "How grep mode matches the query. Default: literal substring search. 'boolean' parses AND/OR/NOT query syntax; 'ast_pattern' matches structural code like 'fn * -> Result' or 'class * extends Base'.",
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
      description: "Number of surrounding context lines to include for grep hits (default: 3, clamped to 0-5). Quick depth only.",
      default: 3,
    }),
  ),
  depth: Type.Optional(
    Type.Union([Type.Literal("quick"), Type.Literal("deep")], {
      description: "quick (default): grep + AST. deep: adds fused semantic, symbol, graph, and LSP channels with provenance; ignores matchMode/caseSensitive/contextLines.",
      default: "quick",
    }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal("code"), Type.Literal("docs"), Type.Literal("tests"), Type.Literal("all")], {
      description: 'File scope for depth: "deep" (default: all).',
      default: "all",
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

// Parser pool keyed by language to avoid rebuilding parsers per file
const parserPool = new Map<string, Parser>();

async function extractCodeDefinitions(
  filePath: string,
  relFile: string,
): Promise<CodeDefinition[]> {
  const lang = filenameToLang(filePath);
  if (!lang) return [];

  const grammar = loadLanguage(lang);
  if (!grammar) return [];

  const code = await readTextFileQuiet(filePath);
  if (code === null) return [];

  const parser = getSharedParser(lang, grammar);
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
      inputTypes: ["query", ...embedTexts.map(() => "document" as const)],
      inputTitles: [undefined, ...defs.map((definition) => `${definition.relFile}:${definition.name}`)],
      timeoutMs: 30_000,
    });

    if (vectors.length >= embedTexts.length + 1) {
      const queryVec = vectors[0]!;
      for (let i = 0; i < defs.length; i++) {
        const docVec = vectors[i + 1]!;
        defs[i]!.similarity = cosineSimilarity(queryVec, docVec);
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
  const dir = params.directory?.trim();
  return dir ? resolve(defaultCwd, dir) : resolve(defaultCwd);
}

function defaultCaseSensitive(query: string): boolean {
  return /[a-z]/.test(query) && /[A-Z]/.test(query);
}

function clampContextLines(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 3;
  return Math.max(0, Math.min(5, Math.trunc(value)));
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(10000, Math.trunc(value)));
}

/** Repo-relative path with posix separators for display and evidence keys. */
function toRelPath(cwd: string, filePath: string): string {
  return relative(cwd, filePath).replace(/\\/g, "/");
}

/** Pooled tree-sitter parser per language; avoids rebuilding parsers per file. */
function getSharedParser(lang: string, grammar: NonNullable<ReturnType<typeof loadLanguage>>): Parser {
  let parser = parserPool.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(grammar);
    parserPool.set(lang, parser);
  }
  return parser;
}

/** Quiet file read: null on failure so callers can skip without branching. */
async function readTextFileQuiet(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** True when file exceeds scan budget or is unreadable (callers skip either way). */
async function shouldSkipOversizedFile(filePath: string, maxBytes: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size > maxBytes;
  } catch {
    return true;
  }
}

/** Case-aware literal substring matcher shared by literal and fallback paths. */
function literalMatcher(query: string, caseSensitive: boolean): (line: string) => boolean {
  if (caseSensitive) return (line) => line.includes(query);
  const lowered = query.toLowerCase();
  return (line) => line.toLowerCase().includes(lowered);
}

/** Cached definition lookup; extracts on miss. */
async function getOrExtractDefinitions(
  cache: Map<string, CodeDefinition[]>,
  filePath: string,
  relFile: string,
): Promise<CodeDefinition[]> {
  const cached = cache.get(filePath);
  if (cached) return cached;
  const defs = await extractCodeDefinitions(filePath, relFile);
  cache.set(filePath, defs);
  return defs;
}

/** Definition hits first, then path + line order. */
function sortGrepMatches(matches: GrepSearchMatch[]): void {
  matches.sort((a, b) => {
    if (a.group !== b.group) return a.group === "definition" ? -1 : 1;
    return a.relFile.localeCompare(b.relFile) || a.line - b.line;
  });
}

/** Group matches by file for sparse session cache. */
function recordGrepMatches(
  sessionKey: string,
  matches: Array<{ file: string; line: number; snippet: string }>,
): void {
  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const match of matches) {
    const entries = byFile.get(match.file) ?? [];
    entries.push({ line: match.line, text: match.snippet });
    byFile.set(match.file, entries);
  }
  for (const [absPath, entries] of byFile) {
    recordSparse(sessionKey, absPath, entries);
  }
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
    dirsSkippedHardDenied: 0,
    filesSkippedBinary: 0,
    filesSkippedUnsupported: 0,
    ignoredDetails: [],
    ignoredDetailsTruncated: 0,
    workspaceRootsSearched: collapsedRoots,
  };

  for (const root of collapsedRoots) {
    const result = await discoverFiles(root, profile, 50_000, signal);
    summary.directoriesVisited += result.diagnostics.directoriesVisited;
    summary.filesConsidered += result.diagnostics.filesConsidered;
    summary.filesMatched += result.diagnostics.filesMatched;
    summary.filesSkippedIgnored += result.diagnostics.filesSkippedIgnored;
    summary.dirsSkippedHardDenied += result.diagnostics.dirsSkippedHardDenied;
    summary.filesSkippedBinary += result.diagnostics.filesSkippedBinary;
    summary.filesSkippedUnsupported += result.diagnostics.filesSkippedUnsupported;
    const remainingIgnoredDetailSlots = Math.max(0, IGNORED_DETAILS_LIMIT - summary.ignoredDetails.length);
    summary.ignoredDetails.push(...result.diagnostics.ignoredDetails.slice(0, remainingIgnoredDetailSlots));
    summary.ignoredDetailsTruncated += result.diagnostics.ignoredDetailsTruncated + Math.max(0, result.diagnostics.ignoredDetails.length - remainingIgnoredDetailSlots);

    for (const file of result.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }

  return { files, summary };
}

// Boolean query parser & evaluator lives in ./boolean-query.ts (re-exported above).

function buildLineMatcher(
  query: string,
  matchMode: SearchMatchMode,
  caseSensitive: boolean,
): (line: string) => boolean {
  if (matchMode === "ast_pattern") {
    // ast_pattern is handled in handleGrep before reaching buildLineMatcher
    return () => false;
  }

  if (matchMode === "boolean") {
    const trimmed = query.trim();
    if (!trimmed) return () => false;
    try {
      const expr = parseBooleanQuery(trimmed);
      return (line) => evaluateBooleanExpression(expr, line, caseSensitive);
    } catch {
      // Invalid boolean query — fall back to literal matching
      return literalMatcher(query, caseSensitive);
    }
  }

  if (matchMode === "literal") return literalMatcher(query, caseSensitive);

  const flags = caseSensitive ? "" : "i";
  let regex: RegExp;
  try {
    regex = new RegExp(query, flags);
  } catch {
    // Invalid regex — fall back to literal matching
    return literalMatcher(query, caseSensitive);
  }
  return (line) => regex.test(line);
}

const SNIPPET_LINE_MAX_CHARS = 500;

function truncateLine(line: string, maxChars: number = SNIPPET_LINE_MAX_CHARS): string {
  if (line.length <= maxChars) return line;
  return `${line.slice(0, maxChars)} …[truncated ${line.length - maxChars} chars]`;
}

function formatSnippet(lines: string[], lineNumber: number, contextLines: number): { snippet: string; endLine: number } {
  const startIndex = Math.max(0, lineNumber - 1 - contextLines);
  const endIndex = Math.min(lines.length - 1, lineNumber - 1 + contextLines);
  const snippetLines: string[] = [];

  for (let index = startIndex; index <= endIndex; index++) {
    const displayLine = String(index + 1).padStart(4, " ");
    snippetLines.push(`    ${displayLine} | ${truncateLine(lines[index] ?? "")}`);
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
    `Found ${matches.length} match(es) for "${query}" (${matchMode}, ${caseSensitive ? "case-sensitive" : "case-insensitive"}, ${summary.filesMatched} searchable files, ${elapsedMs}ms):`,
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
  } else if (matches.length < 3 && shouldShowLowResultHint()) {
    lines.push(
      `> 💡 Only ${matches.length} result(s) found. Retry with ` +
        `depth: "deep" to retain grep + AST and add semantic + symbol + graph + LSP channels.`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

// AST pattern parsing & matching lives in ./search-ast-pattern.ts (re-exported above).

// ── Handlers ──────────────────────────────────────────────────────

export async function handleGrep(
  toolCallId: string,
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
  options?: { preDiscoveredFiles?: string[]; sharedDefinitionCache?: Map<string, CodeDefinition[]>; sharedSummary?: DiscoverySummary; fileGlob?: string },
) {
  const query = params.query!.trim();
  const maxResults = clampMaxResults(params.maxResults);
  const matchMode = params.matchMode ?? "literal";

  if (matchMode === "ast_pattern") {
    return handleAstPattern(toolCallId, params, cwd, signal);
  }

  const caseSensitive = params.caseSensitive ?? defaultCaseSensitive(query);
  const contextLines = clampContextLines(params.contextLines);
  const startTime = Date.now();
  const matchLine = buildLineMatcher(query, matchMode, caseSensitive);

  let allFiles: string[];
  let summary: DiscoverySummary;
  if (options?.preDiscoveredFiles && options.sharedSummary) {
    allFiles = options.preDiscoveredFiles;
    summary = options.sharedSummary;
  } else {
    const searchRoots = expandToMonorepoRoots(cwd);
    const discovered = await discoverAcrossRoots(searchRoots, "text", signal);
    allFiles = discovered.files;
    summary = discovered.summary;
  }
  const definitionCache = options?.sharedDefinitionCache ?? new Map<string, CodeDefinition[]>();
  const matches: GrepSearchMatch[] = [];

  // Glob pre-filter: constrain candidates BEFORE the bounded loop so cutoff
  // happens after glob (existing post-filter remains as a final safeguard).
  if (options?.fileGlob) {
    const { minimatch } = await import("minimatch");
    const glob = options.fileGlob;
    allFiles = allFiles.filter((filePath) =>
      minimatch(relative(cwd, filePath).replace(/\\/g, "/"), glob),
    );
  }

  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matches.length >= maxResults) break;

    // Skip oversized files to avoid unbounded memory reads
    if (await shouldSkipOversizedFile(filePath, MAX_FILE_BYTES)) continue;

    const content = await readTextFileQuiet(filePath);
    if (content === null) continue;

    const relFile = toRelPath(cwd, filePath);
    const lines = content.split(/\r?\n/g);
    const definitions = await getOrExtractDefinitions(definitionCache, filePath, relFile);

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
        lineText: truncateLine(line, 200),
        snippet: snippet.snippet,
      });

      if (matches.length >= maxResults) break;
    }
  }

  sortGrepMatches(matches);
  recordGrepMatches(resolveSessionKey(toolCallId), matches);

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

export async function handleCode(
  toolCallId: string,
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
  enrich: boolean,
  options?: { preDiscoveredFiles?: string[]; sharedDefinitionCache?: Map<string, CodeDefinition[]>; sharedSummary?: DiscoverySummary },
) {
  const maxResults = params.maxResults ?? 20;
  const startTime = Date.now();
  const query = params.query!.trim();

  let allFiles: string[];
  let summary: DiscoverySummary;
  if (options?.preDiscoveredFiles && options.sharedSummary) {
    allFiles = options.preDiscoveredFiles;
    summary = options.sharedSummary;
  } else {
    const searchRoots = expandToMonorepoRoots(cwd);
    const discovered = await discoverAcrossRoots(searchRoots, "code", signal);
    allFiles = discovered.files;
    summary = discovered.summary;
  }
  const maxChars = 3_000_000;

  const allDefs: CodeDefinition[] = [];
  let totalChars = 0;
  const definitionCache = options?.sharedDefinitionCache ?? new Map<string, CodeDefinition[]>();

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (totalChars > maxChars) break;

    const relFile = toRelPath(cwd, filePath);
    const defs = await getOrExtractDefinitions(definitionCache, filePath, relFile);
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

  const allResults = [...scored, ...bm25Only].sort((a, b) => b.score - a.score);

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
        `> 💡 Only ${top.length} result(s) found. Retry with ` +
          `depth: "deep" to retain grep + AST and add semantic + symbol + graph + LSP channels.`,
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

  recordGrepMatches(
    resolveSessionKey(toolCallId),
    top.map((definition) => ({ file: definition.file, line: definition.startLine, snippet: definition.body })),
  );

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode: "code",
      total: top.length,
      totalScored: allDefs.length,
      lspResults: lspResultsCount,
      matches: top.map((definition) => ({
        file: definition.file,
        relFile: definition.relFile,
        line: definition.startLine,
        endLine: definition.endLine,
        name: definition.name,
        kind: definition.kind,
        snippet: definition.body,
      })),
      filesScanned: allFiles.length,
      filesConsidered: summary.filesConsidered,
      filesSkippedIgnored: summary.filesSkippedIgnored,
      filesSkippedUnsupported: summary.filesSkippedUnsupported,
      workspaceRootsSearched: summary.workspaceRootsSearched,
      timeMs: Date.now() - startTime,
    },
  };
}

// ── AST Pattern Handler ────────────────────────────────────────────

/**
 * Handle AST pattern search (matchMode === "ast_pattern").
 *
 * Parses the user-friendly pattern into a structured query, then for each
 * file tries tree-sitter AST matching (JS/TS only) and falls back to regex
 * matching for other languages.
 */
export async function handleAstPattern(
  toolCallId: string,
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
) {
  const query = params.query!.trim();
  const maxResults = clampMaxResults(params.maxResults);
  const startTime = Date.now();

  const astQuery = parseAstPattern(query);
  if (!astQuery) {
    return {
      content: [
        {
          type: "text" as const,
          text: `[Could not parse AST pattern: "${query}". Use syntax like "fn * -> Result" or "class * extends Base" or "async fn process_*".]`,
        },
      ],
      details: {
        mode: "ast_pattern",
        total: 0,
        query,
        patternError: true,
        timeMs: Date.now() - startTime,
      },
    };
  }

  const searchRoots = expandToMonorepoRoots(cwd);
  const { files: allFiles, summary } = await discoverAcrossRoots(searchRoots, "text", signal);
  const definitionCache = new Map<string, CodeDefinition[]>();
  const matches: GrepSearchMatch[] = [];

  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matches.length >= maxResults) break;

    // Skip oversized files
    if (await shouldSkipOversizedFile(filePath, MAX_FILE_BYTES)) continue;

    const relFile = toRelPath(cwd, filePath);
    const definitions = await getOrExtractDefinitions(definitionCache, filePath, relFile);

    const lang = filenameToLang(filePath);
    let astHits: { node: Parser.SyntaxNode; name: string }[] = [];

    // Try tree-sitter AST matching for supported languages
    if (lang) {
      try {
        astHits = await matchAstNodesInFile(filePath, lang, astQuery);
      } catch {
        // AST matching failed \u2014 fall through to regex fallback
      }
    }

    // Record AST matches
    for (const hit of astHits) {
      if (matches.length >= maxResults) break;
      const owner = findOwningDefinition(definitions, hit.node.startPosition.row + 1);
      matches.push({
        group: owner ? "definition" : "text",
        file: filePath,
        relFile,
        line: hit.node.startPosition.row + 1,
        endLine: hit.node.endPosition.row + 1,
        kind: owner?.kind ?? "ast_pattern",
        name: hit.name,
        lineText: hit.node.text.split("\n")[0] ?? "",
        snippet: hit.node.text,
      });
    }

    // Run regex fallback for additional coverage (non-AST languages or partial matches)
    if (matches.length < maxResults) {
      const content = await readTextFileQuiet(filePath);
      if (content === null) continue;

      const lines = content.split(/\r?\n/g);
      for (let index = 0; index < lines.length; index++) {
        if (matches.length >= maxResults) break;
        const line = lines[index] ?? "";
        if (!astQuery.fallbackRegex || !astQuery.fallbackRegex.test(line)) continue;

        const lineNumber = index + 1;

        // Skip if already matched by AST (duplicate)
        const alreadyMatched = matches.some(
          (m) => m.file === filePath && m.line === lineNumber,
        );
        if (alreadyMatched) continue;

        const owner = findOwningDefinition(definitions, lineNumber);
        const snippet = formatSnippet(lines, lineNumber, 3);
        matches.push({
          group: owner ? "definition" : "text",
          file: filePath,
          relFile,
          line: lineNumber,
          endLine: snippet.endLine,
          kind: owner?.kind ?? "ast_pattern",
          name: owner?.name ?? (line.trim().slice(0, 80) || "(text match)"),
          lineText: line,
          snippet: snippet.snippet,
        });
      }
    }
  }

  sortGrepMatches(matches);
  recordGrepMatches(resolveSessionKey(toolCallId), matches);

  // Format output
  const lines: string[] = [
    `Found ${matches.length} AST pattern match(es) for "${query}" (${summary.filesMatched} searchable files, ${Date.now() - startTime}ms):`,
    "",
  ];

  for (const match of matches) {
    lines.push(
      `  ${match.relFile}:${match.line}-${match.endLine} [${match.kind}] ${match.name}`,
    );
    lines.push(match.snippet);
    lines.push("");
  }

  if (matches.length === 0) {
    lines.push(
      `[No AST pattern matches for "${query}" across ${summary.filesMatched} searchable files.]`,
    );
  } else if (matches.length < 3 && shouldShowLowResultHint()) {
    lines.push(
      `> \uD83D\uDCA1 Only ${matches.length} result(s) found. Retry with ` +
        `depth: "deep" to retain grep + AST and add semantic + symbol + graph + LSP channels.`,
    );
    lines.push("");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode: "ast_pattern",
      total: matches.length,
      query,
      filesScanned: allFiles.length,
      filesConsidered: summary.filesConsidered,
      filesSkippedIgnored: summary.filesSkippedIgnored,
      filesSkippedBinary: summary.filesSkippedBinary,
      filesSkippedUnsupported: summary.filesSkippedUnsupported,
      workspaceRootsSearched: summary.workspaceRootsSearched,
      definitionHits: matches.filter((m) => m.group === "definition").length,
      textHits: matches.filter((m) => m.group === "text").length,
      timeMs: Date.now() - startTime,
      matches,
      pattern: {
        nodeTypes: astQuery.nodeTypes,
        isAsync: astQuery.isAsync,
        namePattern: astQuery.namePattern,
        returnTypePattern: astQuery.returnTypePattern,
        extendsPattern: astQuery.extendsPattern,
        forTypePattern: astQuery.forTypePattern,
        bodyFieldPatterns: astQuery.bodyFieldPatterns,
      },
    },
  };
}

// ── Deep search (depth: "deep") ─────────────────────────────────

async function runDeepSearch(
  toolCallId: string,
  params: SearchInput,
  searchRoot: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const result = await executeDeepSearch(
    {
      query: params.query.trim(),
      depth: "standard",
      scope: params.scope ?? "all",
      directory: searchRoot,
      limit: Math.max(1, Math.min(50, params.maxResults ?? 15)),
      maxSnippetChars: 400,
      outputBudget: 4096,
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
}

// ── Tool definition ───────────────────────────────────────────────

export default function createSearchTool(): ToolDefinition {
  return {
    name: "search",
    label: "search",
    description:
        'Search repository text with grep and AST-aware code definitions by exact term, regex, boolean query, or structural ast_pattern. Use for precise lookups; use depth: "deep" for broad cross-file search that adds fused semantic, symbol, graph, and LSP evidence with provenance. For simple literal/regex code search use `grep`; prefer `symbol` when a symbol name is known and relationships matter; use read/read_files once target paths are known.',
    parameters: SearchSchema,

    async execute(
      toolCallId: string,
      params: SearchInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const cwd = resolveSearchRoot(params, ctx.cwd);

      if (typeof params.query !== "string" || !params.query.trim()) {
        throw new Error('search requires a non-empty "query"');
      }

      if (params.depth === "deep") {
        return runDeepSearch(toolCallId, params, cwd, signal, ctx);
      }

      const config = loadSearchConfig(cwd);
      const enrich =
        config.enrich?.code?.symbols !== false || config.enrich?.code?.callers !== false;

      // Run code and grep searches, combining results.
      // Skip code search for ast_pattern/boolean modes — they are grep-only.
      const skipCode = params.matchMode === "ast_pattern" || params.matchMode === "boolean";

      // M1: Discover text files once and share across code+grep handlers to avoid
      // duplicate directory walks and file reads in quick search mode.
      let codeResult: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
      let grepResult: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

      if (skipCode) {
        codeResult = { content: [{ type: "text" as const, text: "" }], details: { total: 0, mode: "code" } };
        grepResult = await handleGrep(toolCallId, params, cwd, signal);
      } else {
        const searchRoots = expandToMonorepoRoots(cwd);
        const { files: textFiles, summary: textSummary } = await discoverAcrossRoots(searchRoots, "text", signal);
        const codeFiles = textFiles.filter((f) => isSupportedFile(f));
        const sharedDefinitionCache = new Map<string, CodeDefinition[]>();

        // Build a code-profile summary from the text discovery
        const codeSummary: DiscoverySummary = {
          ...textSummary,
          profile: "code",
          filesMatched: codeFiles.length,
        };

        const sharedOpts = { sharedDefinitionCache };
        [codeResult, grepResult] = await Promise.all([
          handleCode(toolCallId, params, cwd, signal, enrich, { preDiscoveredFiles: codeFiles, ...sharedOpts, sharedSummary: codeSummary }),
          handleGrep(toolCallId, params, cwd, signal, { preDiscoveredFiles: textFiles, ...sharedOpts, sharedSummary: textSummary }),
        ]);
      }

      const codeText = codeResult.content[0]?.type === "text" ? codeResult.content[0].text : "";
      const grepText = grepResult.content[0]?.type === "text" ? grepResult.content[0].text : "";

      const codeDetails = codeResult.details as Record<string, unknown>;
      const grepDetails = grepResult.details as Record<string, unknown>;

      const parts: string[] = [];
      if (codeText && (codeDetails?.total as number ?? 0) > 0) {
        parts.push(codeText);
      }
      if (grepText && (grepDetails?.total as number ?? 0) > 0) {
        parts.push(grepText);
      }
      if (parts.length === 0) {
        const query = params.query.trim();
        const files = (codeDetails?.filesScanned as number ?? 0) || (grepDetails?.filesScanned as number ?? 0);
        parts.push(`[No matches for "${query}" across ${files} files.]`);
        parts.push(`[hint] Retry with depth: "deep" to retain grep + AST and add semantic + symbol + graph + LSP channels, or symbol { query: "${query}" } if this is a known identifier.`);
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
        details: {
          total: (codeDetails?.total as number ?? 0) + (grepDetails?.total as number ?? 0),
          query: params.query.trim(),
          codeDefinitions: codeDetails?.total ?? 0,
          textMatches: grepDetails?.total ?? 0,
          definitionHits: grepDetails?.definitionHits ?? 0,
          textHits: grepDetails?.textHits ?? 0,
          matches: grepDetails?.matches ?? [],
          lspResults: codeDetails?.lspResults ?? 0,
          filesScanned: codeDetails?.filesScanned ?? grepDetails?.filesScanned ?? 0,
          filesConsidered: codeDetails?.filesConsidered ?? grepDetails?.filesConsidered ?? 0,
          filesSkippedIgnored: grepDetails?.filesSkippedIgnored ?? 0,
          filesSkippedBinary: grepDetails?.filesSkippedBinary ?? 0,
          workspaceRootsSearched: grepDetails?.workspaceRootsSearched ?? codeDetails?.workspaceRootsSearched ?? [],
          timeMs: Math.max(codeDetails?.timeMs as number ?? 0, grepDetails?.timeMs as number ?? 0),
        },
      };
    },
  } as unknown as ToolDefinition;
}
