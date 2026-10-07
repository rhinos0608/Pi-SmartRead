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
import Parser, { Query } from "tree-sitter";
import { resolveSymbol } from "../structural/symbol-resolver.js";
import { findCallers } from "../structural/callgraph.js";
import { loadLanguage, getQueryPath } from "../structural/tags.js";
import {
  discoverFiles,
  type DiscoveryProfile,
  type FileDiscoveryDiagnostics,
  IGNORED_DETAILS_LIMIT,
} from "../file-discovery.js";
import { shouldShowLowResultHint } from "../hook.js";
import { filenameToLang } from "../languages.js";
import { bm25Scores, computeRrfScores, cosineSimilarity } from "../scoring.js";
import { fetchEmbeddings } from "../indexing/embedding.js";
import { getGraphifyEnricher } from "../graph/graphify-enricher.js";
import { classifyRelevanceByScore, classifySimilarity } from "../ranking/classifiers.js";
import { expandToMonorepoRoots } from "../workspace/monorepo-detector.js";
import { getLSPBridge } from "../lsp/lsp-bridge.js";
import { recordSparse, resolveSessionKey } from "../read/file-read-cache.js";
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
  type ParsedAstPattern,
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

function parseMatchCapture(match: Parser.QueryMatch): { name?: string; defNode?: Parser.SyntaxNode; defKind: string } {
  let name: string | undefined;
  let defNode: Parser.SyntaxNode | undefined;
  let defKind = "definition";
  for (const capture of match.captures) {
    if (capture.name.startsWith("name.definition")) name = capture.node.text;
    else if (capture.name.startsWith("definition")) {
      defNode = capture.node;
      defKind = capture.name.replace(/^definition\.?/, "") || "definition";
    }
  }
  return { name, defNode, defKind };
}

function pushDefinition(
  defs: CodeDefinition[],
  seen: Set<string>,
  filePath: string,
  relFile: string,
  name: string,
  defNode: Parser.SyntaxNode,
  defKind: string,
): void {
  const key = `${relFile}:${defNode.startPosition.row}`;
  if (seen.has(key)) return;
  seen.add(key);
  const text = defNode.text.trim();
  if (text.length < 8) return;
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

async function loadDefinitionQuery(lang: Parameters<typeof getQueryPath>[0], grammar: NonNullable<ReturnType<typeof loadLanguage>>): Promise<Query | null> {
  const queryPath = getQueryPath(lang);
  if (!queryPath || !existsSync(queryPath)) return null;
  try {
    const querySource = await fs.readFile(queryPath, "utf-8");
    return new Query(grammar, querySource);
  } catch {
    return null;
  }
}

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
  const tree = parser.parse((offset) => code.slice(offset, offset + 1024));
  if (!tree?.rootNode) return [];
  const query = await loadDefinitionQuery(lang, grammar);
  if (!query) return [];
  return collectQueryDefinitions(query.matches(tree.rootNode), filePath, relFile);
}

function collectQueryDefinitions(
  matches: Parser.QueryMatch[],
  filePath: string,
  relFile: string,
): CodeDefinition[] {
  const defs: CodeDefinition[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const { name, defNode, defKind } = parseMatchCapture(match);
    if (!name || !defNode) continue;
    pushDefinition(defs, seen, filePath, relFile, name, defNode, defKind);
  }
  return defs;
}

// ── BM25 + optional embedding scoring ─────────────────────────────

function applyBm25Scores(defs: CodeDefinition[], query: string): void {
  const bm25 = bm25Scores(query, defs.map((d) => d.body));
  for (let i = 0; i < defs.length; i++) defs[i]!.score = bm25[i] ?? 0;
}

function rankToPositions(order: number[], n: number): number[] {
  const ranks: number[] = new Array(n);
  for (let i = 0; i < n; i++) ranks[order[i]!] = i + 1;
  return ranks;
}

function applyRrfRescore(defs: CodeDefinition[]): void {
  const n = defs.length;
  const bm25Order = defs.map((d, i) => ({ i, score: d.score })).sort((a, b) => b.score - a.score).map((e) => e.i);
  const simOrder = defs.map((d, i) => ({ i, sim: d.similarity ?? 0 })).sort((a, b) => b.sim - a.sim).map((e) => e.i);
  const rrfScores = computeRrfScores(rankToPositions(simOrder, n), rankToPositions(bm25Order, n));
  for (let i = 0; i < n; i++) defs[i]!.score = rrfScores[i] ?? 0;
}

function applyEmbeddingSimilarities(defs: CodeDefinition[], vectors: number[][]): boolean {
  if (vectors.length < defs.length + 1) return false;
  const queryVec = vectors[0]!;
  for (let i = 0; i < defs.length; i++) defs[i]!.similarity = cosineSimilarity(queryVec, vectors[i + 1]!);
  applyRrfRescore(defs);
  return true;
}

async function fetchQueryEmbeddings(
  query: string,
  defs: CodeDefinition[],
  embeddingConfig: { baseUrl: string; model: string; apiKey?: string },
): Promise<number[][]> {
  const embedTexts = defs.map((d) => (d.body.length > 2048 ? d.body.slice(0, 2048) : d.body));
  const { vectors } = await fetchEmbeddings({
    baseUrl: embeddingConfig.baseUrl,
    model: embeddingConfig.model,
    apiKey: embeddingConfig.apiKey ?? "",
    inputs: [query, ...embedTexts],
    inputTypes: ["query", ...embedTexts.map(() => "document" as const)],
    inputTitles: [undefined, ...defs.map((definition) => `${definition.relFile}:${definition.name}`)],
    timeoutMs: 30_000,
  });
  return vectors;
}

async function scoreDefinitions(
  defs: CodeDefinition[],
  query: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<CodeDefinition[]> {
  if (defs.length === 0) return [];
  applyBm25Scores(defs, query);
  try {
    const { validateEmbeddingConfig } = await import("../config.js");
    const embeddingConfig = validateEmbeddingConfig(cwd);
    if (!embeddingConfig) return defs.sort((a, b) => b.score - a.score);
    if (signal?.aborted) throw new Error("Operation aborted");
    const vectors = await fetchQueryEmbeddings(query, defs, embeddingConfig);
    applyEmbeddingSimilarities(defs, vectors);
  } catch {
    // Embedding not available — BM25-only results are fine
  }
  return defs.sort((a, b) => b.score - a.score);
}

// ── Helpers ───────────────────────────────────────────────────────

const LSP_KIND_NAMES: Record<number, string> = {
  5: "class",
  6: "method",
  7: "property",
  8: "property",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "variable",
  22: "enum-member",
  23: "struct",
  24: "event",
};

function lspSymbolKindToString(kind: number): string {
  return LSP_KIND_NAMES[kind] ?? "symbol";
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

function pushLineMatch(
  matches: GrepSearchMatch[],
  filePath: string,
  relFile: string,
  lines: string[],
  lineNumber: number,
  definitions: CodeDefinition[],
  contextLines: number,
): void {
  const line = lines[lineNumber - 1] ?? "";
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
}

interface GrepScanCtx {
  cwd: string;
  definitionCache: Map<string, CodeDefinition[]>;
  matchLine: (line: string) => boolean;
  contextLines: number;
  matches: GrepSearchMatch[];
  maxResults: number;
  signal: AbortSignal | undefined;
}

function scanGrepLines(
  lines: string[],
  filePath: string,
  relFile: string,
  definitions: CodeDefinition[],
  ctx: GrepScanCtx,
): void {
  for (let index = 0; index < lines.length; index++) {
    if (ctx.matches.length >= ctx.maxResults) break;
    if (!ctx.matchLine(lines[index] ?? "")) continue;
    pushLineMatch(ctx.matches, filePath, relFile, lines, index + 1, definitions, ctx.contextLines);
  }
}

async function scanGrepFile(
  filePath: string,
  ctx: GrepScanCtx,
): Promise<void> {
  if (ctx.signal?.aborted) throw new Error("Operation aborted");
  if (await shouldSkipOversizedFile(filePath, 10 * 1024 * 1024)) return;
  const content = await readTextFileQuiet(filePath);
  if (content === null) return;
  const relFile = toRelPath(ctx.cwd, filePath);
  const lines = content.split(/\r?\n/g);
  const definitions = await getOrExtractDefinitions(ctx.definitionCache, filePath, relFile);
  scanGrepLines(lines, filePath, relFile, definitions, ctx);
}

async function resolveGrepFiles(
  cwd: string,
  signal: AbortSignal | undefined,
  options?: { preDiscoveredFiles?: string[]; sharedSummary?: DiscoverySummary; fileGlob?: string },
): Promise<{ files: string[]; summary: DiscoverySummary }> {
  let files: string[];
  let summary: DiscoverySummary;
  if (options?.preDiscoveredFiles && options.sharedSummary) {
    files = options.preDiscoveredFiles;
    summary = options.sharedSummary;
  } else {
    const discovered = await discoverAcrossRoots(expandToMonorepoRoots(cwd), "text", signal);
    files = discovered.files;
    summary = discovered.summary;
  }
  if (options?.fileGlob) {
    const { minimatch } = await import("minimatch");
    const glob = options.fileGlob;
    files = files.filter((filePath) => minimatch(relative(cwd, filePath).replace(/\\/g, "/"), glob));
  }
  return { files, summary };
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
  const { files: allFiles, summary } = await resolveGrepFiles(cwd, signal, options);
  const definitionCache = options?.sharedDefinitionCache ?? new Map<string, CodeDefinition[]>();
  const matches: GrepSearchMatch[] = [];
  const scanCtx: GrepScanCtx = { cwd, definitionCache, matchLine, contextLines, matches, maxResults, signal };
  for (const filePath of allFiles) {
    if (matches.length >= maxResults) break;
    await scanGrepFile(filePath, scanCtx);
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

/** Collect definitions across files without exceeding the char budget (~3,000,000). */
async function collectDefinitionsWithinBudget(
  allFiles: string[],
  cwd: string,
  definitionCache: Map<string, CodeDefinition[]>,
  signal: AbortSignal | undefined,
  maxChars = 3_000_000,
): Promise<CodeDefinition[]> {
  const allDefs: CodeDefinition[] = [];
  let totalChars = 0;

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

  return allDefs;
}

/** BM25 pre-filter, embedding RRF rescore, graph centrality boost, global sort. */
async function rankDefinitions(
  allDefs: CodeDefinition[],
  query: string,
  cwd: string,
  signal: AbortSignal | undefined,
  maxResults: number,
): Promise<CodeDefinition[]> {
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

  return [...scored, ...bm25Only].sort((a, b) => b.score - a.score);
}

function toLspDefinition(symbol: { name: string; kind: number; location: { uri: string; range: { start: { line: number }; end: { line: number } } } }, cwd: string): CodeDefinition {
  const uri = symbol.location.uri;
  const filePath = uri.startsWith("file://") ? uri.slice(7) : uri;
  const relFile = relative(cwd, filePath).replace(/\\/g, "/");
  return {
    file: filePath,
    relFile,
    startLine: symbol.location.range.start.line + 1,
    endLine: symbol.location.range.end.line + 1,
    name: symbol.name,
    kind: lspSymbolKindToString(symbol.kind),
    body: "",
    score: 1.0,
    similarity: undefined,
  };
}

function appendNewLspSymbols(
  allResults: CodeDefinition[],
  wsSymbols: Array<{ name: string; kind: number; location: { uri: string; range: { start: { line: number }; end: { line: number } } } }>,
  cwd: string,
): number {
  const existingKeys = new Set(allResults.map((d) => `${d.relFile}:${d.name}`));
  let added = 0;
  for (const symbol of wsSymbols) {
    const def = toLspDefinition(symbol, cwd);
    const key = `${def.relFile}:${def.name}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    added++;
    allResults.push(def);
  }
  return added;
}

/** Append LSP workspace symbols not already present; returns count added. */
async function mergeLspDefinitions(
  allResults: CodeDefinition[],
  query: string,
  cwd: string,
  searchDir: string | undefined,
): Promise<number> {
  let added = 0;
  try {
    const bridge = await getLSPBridge();
    if (!bridge?.isAvailable() || query.length <= 2) return 0;
    const root = searchDir ? resolve(cwd, searchDir) : cwd;
    const wsSymbols = await bridge.workspaceSymbol(query, root);
    if (wsSymbols.length === 0) return 0;
    added = appendNewLspSymbols(allResults, wsSymbols, cwd);
  } catch {
    return added;
  }
  if (added > 0) allResults.sort((a, b) => b.score - a.score);
  return added;
}

function pickTopNames(top: CodeDefinition[], limit = 5): Map<string, CodeDefinition> {
  const byName = new Map<string, CodeDefinition>();
  for (const entry of top) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
    if (byName.size >= limit) break;
  }
  return byName;
}

async function resolveOneName(
  name: string,
  entry: CodeDefinition,
  cwd: string,
): Promise<string> {
  try {
    const resolution = await resolveSymbol(cwd, name, entry.relFile, entry.startLine, 3);
    const target = resolution.bestDefinition
      ? `def: ${resolution.bestDefinition.file}:${resolution.bestDefinition.line}`
      : "(no definition found)";
    const refs = resolution.references.length > 0 ? ` (${resolution.references.length} refs)` : "";
    return `  ${name} -> ${target}${refs}`;
  } catch {
    return `  ${name} -> (resolution failed)`;
  }
}

async function appendCallerLines(
  lines: string[],
  names: string[],
  allFiles: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const name of names.slice(0, 3)) {
    try {
      const callers = await findCallers(allFiles, name, signal);
      if (callers.length === 0) continue;
      const shown = callers.slice(0, 5).map((c) => `${c.callerFunction} in ${c.file}`).join(", ");
      const extra = callers.length > 5 ? ` (+${callers.length - 5} more)` : "";
      lines.push(`  ${name} callers: ${shown}${extra}`);
    } catch {
      // skip caller enrichment failures
    }
  }
}

/** Best-effort symbol resolution + caller enrichment lines for top names. */
async function enrichTopDefinitions(
  top: CodeDefinition[],
  allFiles: string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const resolvedLines: string[] = ["── Enriched ──", ""];
  try {
    const byName = pickTopNames(top);
    const topNames = [...byName.keys()];
    for (const name of topNames) {
      if (signal?.aborted) break;
      resolvedLines.push(await resolveOneName(name, byName.get(name)!, cwd));
    }
    if (topNames.length > 0 && !signal?.aborted) await appendCallerLines(resolvedLines, topNames, allFiles, signal);
  } catch {
    // enrichment is best-effort
  }
  return resolvedLines;
}

/** Render code matches text, including the low-result deep-search hint. */
function renderCodeMatches(
  query: string,
  top: CodeDefinition[],
  definitionsTotal: number,
  filesTotal: number,
  lspResultsCount: number,
  elapsedMs: number,
  enrich: boolean,
): string[] {
  const lines: string[] = [
    `Found ${top.length} definition(s) matching "${query}" (${definitionsTotal} definitions across ${filesTotal} files${lspResultsCount > 0 ? `, ${lspResultsCount} from LSP` : ""}, ${elapsedMs}ms):`,
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
  return lines;
}

/** Details payload for code matches (keys consumed by deep-search callers). */
function buildCodeDetails(
  top: CodeDefinition[],
  allDefsTotal: number,
  lspResultsCount: number,
  allFiles: string[],
  summary: DiscoverySummary,
  startTime: number,
) {
  return {
    mode: "code",
    total: top.length,
    totalScored: allDefsTotal,
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
  };
}

function buildEmptyCodeResult(query: string, allFiles: string[], summary: DiscoverySummary, allDefs: CodeDefinition[], startTime: number, lspResultsCount: number) {
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

async function resolveCodeFiles(
  cwd: string,
  signal: AbortSignal | undefined,
  options?: { preDiscoveredFiles?: string[]; sharedSummary?: DiscoverySummary },
): Promise<{ files: string[]; summary: DiscoverySummary }> {
  if (options?.preDiscoveredFiles && options.sharedSummary) {
    return { files: options.preDiscoveredFiles, summary: options.sharedSummary };
  }
  const discovered = await discoverAcrossRoots(expandToMonorepoRoots(cwd), "code", signal);
  return { files: discovered.files, summary: discovered.summary };
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

  const { files: allFiles, summary } = await resolveCodeFiles(cwd, signal, options);
  const definitionCache = options?.sharedDefinitionCache ?? new Map<string, CodeDefinition[]>();
  const allDefs = await collectDefinitionsWithinBudget(allFiles, cwd, definitionCache, signal);
  const allResults = await rankDefinitions(allDefs, query, cwd, signal, maxResults);
  const lspResultsCount = await mergeLspDefinitions(allResults, query, cwd, params.directory);
  const top = allResults.slice(0, maxResults);
  if (top.length === 0) return buildEmptyCodeResult(query, allFiles, summary, allDefs, startTime, lspResultsCount);

  const lines = renderCodeMatches(query, top, allDefs.length, allFiles.length, lspResultsCount, Date.now() - startTime, enrich);

  if (enrich !== false && top.length > 0) {
    const resolvedLines = await enrichTopDefinitions(top, allFiles, cwd, signal);
    if (resolvedLines.length > 1) {
      lines.push(...resolvedLines);
      lines.push("");
    }
  }

  recordGrepMatches(
    resolveSessionKey(toolCallId),
    top.map((definition) => ({ file: definition.file, line: definition.startLine, snippet: definition.body })),
  );

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: buildCodeDetails(top, allDefs.length, lspResultsCount, allFiles, summary, startTime),
  };
}

/** Tree-sitter AST match for one file; empty on unsupported lang or failure. */
async function scanAstPatternFile(
  filePath: string,
  lang: string,
  astQuery: ParsedAstPattern,
): Promise<{ node: Parser.SyntaxNode; name: string }[]> {
  try {
    return await matchAstNodesInFile(filePath, lang, astQuery);
  } catch {
    // AST matching failed — fall through to regex fallback
    return [];
  }
}

/** Append AST hits, attributing each to its owning definition when known. */
function appendAstHits(
  matches: GrepSearchMatch[],
  astHits: { node: Parser.SyntaxNode; name: string }[],
  filePath: string,
  relFile: string,
  definitions: CodeDefinition[],
  maxResults: number,
): void {
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
}

function isRegexFallbackHit(line: string, astQuery: ParsedAstPattern): boolean {
  return !!astQuery.fallbackRegex && astQuery.fallbackRegex.test(line);
}

function isAstDuplicate(matches: GrepSearchMatch[], filePath: string, lineNumber: number): boolean {
  return matches.some((m) => m.file === filePath && m.line === lineNumber);
}

function pushRegexFallbackHit(
  matches: GrepSearchMatch[],
  filePath: string,
  relFile: string,
  lines: string[],
  lineNumber: number,
  line: string,
  definitions: CodeDefinition[],
): void {
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

/** Regex fallback for non-AST languages or partial matches; skips AST dupes. */
function appendRegexFallbackHits(
  matches: GrepSearchMatch[],
  content: string,
  filePath: string,
  relFile: string,
  astQuery: ParsedAstPattern,
  definitions: CodeDefinition[],
  maxResults: number,
): void {
  const lines = content.split(/\r?\n/g);
  for (let index = 0; index < lines.length; index++) {
    if (matches.length >= maxResults) break;
    const line = lines[index] ?? "";
    if (!isRegexFallbackHit(line, astQuery)) continue;
    const lineNumber = index + 1;
    if (isAstDuplicate(matches, filePath, lineNumber)) continue;
    pushRegexFallbackHit(matches, filePath, relFile, lines, lineNumber, line, definitions);
  }
}

/** Render AST pattern matches text, including the low-result hint. */
function renderAstPatternMatches(
  query: string,
  matches: GrepSearchMatch[],
  filesMatched: number,
  elapsedMs: number,
): string {
  const lines: string[] = [
    `Found ${matches.length} AST pattern match(es) for "${query}" (${filesMatched} searchable files, ${elapsedMs}ms):`,
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
      `[No AST pattern matches for "${query}" across ${filesMatched} searchable files.]`,
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

/** Details payload for AST pattern matches. */
function buildAstPatternDetails(
  matches: GrepSearchMatch[],
  query: string,
  allFiles: string[],
  summary: DiscoverySummary,
  astQuery: ParsedAstPattern,
  startTime: number,
) {
  return {
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
function buildAstPatternError(query: string, startTime: number) {
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

async function scanOneAstFile(
  filePath: string,
  cwd: string,
  definitionCache: Map<string, CodeDefinition[]>,
  astQuery: ParsedAstPattern,
  matches: GrepSearchMatch[],
  maxResults: number,
): Promise<void> {
  if (await shouldSkipOversizedFile(filePath, 10 * 1024 * 1024)) return;
  const relFile = toRelPath(cwd, filePath);
  const definitions = await getOrExtractDefinitions(definitionCache, filePath, relFile);
  const lang = filenameToLang(filePath);
  appendAstHits(matches, lang ? await scanAstPatternFile(filePath, lang, astQuery) : [], filePath, relFile, definitions, maxResults);
  if (matches.length >= maxResults) return;
  const content = await readTextFileQuiet(filePath);
  if (content !== null) appendRegexFallbackHits(matches, content, filePath, relFile, astQuery, definitions, maxResults);
}

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
  if (!astQuery) return buildAstPatternError(query, startTime);

  const searchRoots = expandToMonorepoRoots(cwd);
  const { files: allFiles, summary } = await discoverAcrossRoots(searchRoots, "text", signal);
  const definitionCache = new Map<string, CodeDefinition[]>();
  const matches: GrepSearchMatch[] = [];
  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matches.length >= maxResults) break;
    await scanOneAstFile(filePath, cwd, definitionCache, astQuery, matches, maxResults);
  }

  sortGrepMatches(matches);
  recordGrepMatches(resolveSessionKey(toolCallId), matches);

  return {
    content: [{ type: "text" as const, text: renderAstPatternMatches(query, matches, summary.filesMatched, Date.now() - startTime) }],
    details: buildAstPatternDetails(matches, query, allFiles, summary, astQuery, startTime),
  };
}
