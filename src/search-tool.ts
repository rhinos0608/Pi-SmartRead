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
import { bm25Scores, computeRrfScores } from "./scoring.js";
import { fetchEmbeddings } from "./embedding.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { classifyRelevanceByScore, classifySimilarity } from "./classifiers.js";
import { expandToMonorepoRoots } from "./monorepo-detector.js";
import { getLSPBridge } from "./lsp-bridge.js";
import { recordSparse, resolveSessionKey } from "./file-read-cache.js";
import { executeDeepSearch } from "./deep-search.js";

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
      description: "How grep mode matches the query. Default: literal substring search. Use 'ast_pattern' for structural code queries like 'fn * -> Result' or 'class * extends Base'.",
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
      description: "quick (default): grep + AST code search. deep: grep + AST plus fused semantic, symbol, graph, and LSP channels with provenance — use for broad or uncertain questions, or when quick returned nothing. Deep depth ignores matchMode/caseSensitive/contextLines.",
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

  let code: string;
  try {
    code = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  let parser = parserPool.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(grammar);
    parserPool.set(lang, parser);
  }
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

// ── Boolean query parser & evaluator ──────────────────────────────────

interface BooleanExpression {
  kind: "term" | "phrase" | "not" | "and" | "or";
  value?: string;
  left?: BooleanExpression;
  right?: BooleanExpression;
  expr?: BooleanExpression;
}

type BooleanToken =
  | { type: "word" | "phrase" | "eof"; value: string }
  | { type: "op"; value: "AND" | "OR" | "NOT" }
  | { type: "paren"; value: "(" | ")" };

function tokenize(query: string): BooleanToken[] {
  const tokens: BooleanToken[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i]!)) {
      i++;
      continue;
    }
    if (query[i] === "(" || query[i] === ")") {
      tokens.push({ type: "paren", value: query[i] as "(" | ")" });
      i++;
      continue;
    }
    if (query[i] === '"') {
      let j = i + 1;
      while (j < query.length && query[j] !== '"') j++;
      tokens.push({ type: "phrase", value: query.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (
      j < query.length &&
      !/\s/.test(query[j]!) &&
      query[j] !== "(" &&
      query[j] !== ")" &&
      query[j] !== '"'
    ) {
      j++;
    }
    const word = query.slice(i, j);
    const upper = word.toUpperCase();
    if (upper === "AND" || upper === "OR" || upper === "NOT") {
      tokens.push({ type: "op", value: upper as "AND" | "OR" | "NOT" });
    } else {
      tokens.push({ type: "word", value: word });
    }
    i = j;
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

/**
 * Parse a boolean query string into an expression AST.
 *
 * Grammar (precedence: NOT > AND > OR):
 *   expression := or_expr
 *   or_expr := and_expr ("OR" and_expr)*
 *   and_expr := not_expr ("AND"? not_expr)*
 *   not_expr := "NOT" not_expr | primary
 *   primary := "(" expression ")" | phrase | term
 *   phrase := '"' [^"]* '"'
 *   term := [^\s()"]+
 */
export function parseBooleanQuery(query: string): BooleanExpression {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "term", value: "" };

  const tokens = tokenize(trimmed);
  let pos = 0;

  const peek = (): BooleanToken => tokens[pos] ?? { type: "eof", value: "" };
  const consume = (): BooleanToken => tokens[pos++] ?? { type: "eof", value: "" };

  const parseOr = (): BooleanExpression => {
    let left = parseAnd();
    while (peek().type === "op" && (peek() as { value: string }).value === "OR") {
      consume();
      const right = parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  };

  const parseAnd = (): BooleanExpression => {
    // Leading OR/AND: treat as just the right operand
    if (peek()?.value?.toUpperCase() === "OR" || peek()?.value?.toUpperCase() === "AND") {
      consume(); // skip the operator
    }
    let left = parseNot();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = peek();
      if (token.type === "eof") break;
      if (token.type === "op" && (token as { value: string }).value === "OR") break;
      if (token.type === "paren" && (token as { value: string }).value === ")") break;

      // Consume explicit AND if present
      if (token.type === "op" && (token as { value: string }).value === "AND") {
        consume();
      }

      const next = peek();
      if (
        (next.type === "op" && (next as { value: string }).value === "NOT") ||
        next.type === "word" ||
        next.type === "phrase" ||
        (next.type === "paren" && (next as { value: string }).value === "(")
      ) {
        const right = parseNot();
        left = { kind: "and", left, right };
      } else {
        break;
      }
    }
    return left;
  };

  const parseNot = (): BooleanExpression => {
    if (peek().type === "op" && (peek() as { value: string }).value === "NOT") {
      consume();
      return { kind: "not", expr: parseNot() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): BooleanExpression => {
    if (peek().type === "paren" && (peek() as { value: string }).value === "(") {
      consume();
      const expr = parseOr();
      // Consume closing paren if present (unmatched paren is tolerated)
      if (peek().type === "paren" && (peek() as { value: string }).value === ")") {
        consume();
      }
      return expr;
    }
    if (peek().type === "phrase") {
      const t = consume() as { value: string };
      return { kind: "phrase", value: t.value };
    }
    if (peek().type === "word") {
      const t = consume() as { value: string };
      return { kind: "term", value: t.value };
    }
    // Should not reach here with well-formed input; consume and return empty
    consume();
    return { kind: "term", value: "" };
  };

  return parseOr();
}

/** Evaluate a parsed boolean expression against a line of text. */
export function evaluateBooleanExpression(
  expr: BooleanExpression,
  line: string,
  caseSensitive: boolean,
): boolean {
  switch (expr.kind) {
    case "term":
    case "phrase": {
      // Empty term matches nothing (handles empty/whitespace-only queries)
      if (!expr.value) return false;
      const haystack = caseSensitive ? line : line.toLowerCase();
      const needle = caseSensitive ? expr.value! : expr.value!.toLowerCase();
      return haystack.includes(needle);
    }
    case "not": {
      // Bare NOT with no operand matches nothing
      if (!expr.expr || (expr.expr.kind === "term" && !expr.expr.value)) return false;
      return !evaluateBooleanExpression(expr.expr!, line, caseSensitive);
    }
    case "and":
      return (
        evaluateBooleanExpression(expr.left!, line, caseSensitive) &&
        evaluateBooleanExpression(expr.right!, line, caseSensitive)
      );
    case "or":
      return (
        evaluateBooleanExpression(expr.left!, line, caseSensitive) ||
        evaluateBooleanExpression(expr.right!, line, caseSensitive)
      );
  }
}

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
      if (caseSensitive) {
        return (line) => line.includes(query);
      }
      const lowered = query.toLowerCase();
      return (line) => line.toLowerCase().includes(lowered);
    }
  }

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

// ── AST Pattern Search ───────────────────────────────────────────

/**
 * Parsed representation of an AST pattern query.
 * Converts user-friendly patterns like "fn * -> Result" into structured filters.
 */
interface ParsedAstPattern {
  /** Tree-sitter node types to search for */
  nodeTypes: string[];
  /** Whether the node must be async (null = don\'t care) */
  isAsync: boolean | null;
  /** Glob pattern for node name (null = any, "*" = any, "foo*" = prefix) */
  namePattern: string | null;
  /** Glob pattern for return type annotation (null = skip check) */
  returnTypePattern: string | null;
  /** Glob pattern for extends/superclass (null = skip check) */
  extendsPattern: string | null;
  /** Glob pattern for Rust impl for-type (null = skip check) */
  forTypePattern: string | null;
  /** Field type patterns for body content check (null = skip) */
  bodyFieldPatterns: string[] | null;
  /** Regex fallback for languages without tree-sitter */
  fallbackRegex: RegExp | null;
}

/** Maps user-friendly pattern keywords to tree-sitter node types */
const AST_KEYWORD_NODE_TYPES: Record<string, string[]> = {
  fn: [
    "function_declaration",
    "function_item",
    "function_definition",
    "method_definition",
    "method_declaration",
    "function_expression",
    "arrow_function",
  ],
  class: [
    "class_declaration",
    "class_definition",
    "class_specifier",
    "class_expression",
  ],
  struct: [
    "struct_item",
    "struct_specifier",
  ],
  impl: [
    "impl_item",
  ],
  trait: [
    "trait_item",
  ],
  enum: [
    "enum_item",
    "enum_specifier",
  ],
  interface: [
    "interface_declaration",
  ],
};

const AST_KEYWORDS = new Set(Object.keys(AST_KEYWORD_NODE_TYPES));
const AST_QUALIFIERS = new Set(["async", "static", "pub", "public", "private", "protected", "export"]);
const AST_RELATIONS = new Set(["extends", "for", "implements", "with", "->"]);

/**
 * Tokenize an AST pattern into tokens, normalizing parens and braces.
 *   "fn(*) -> Result"        \u2192 ["fn", "*", "->", "Result"]
 *   "class * extends Base"   \u2192 ["class", "*", "extends", "Base"]
 *   "async fn process_*"     \u2192 ["async", "fn", "process_*"]
 *   "impl * for *"           \u2192 ["impl", "*", "for", "*"]
 *   "struct * { *: String }" \u2192 ["struct", "*", "{", "*:", "String", "}"]
 */
function tokenizeAstPattern(raw: string): string[] {
  const normalized = raw
    .replace(/\(\s*\*\s*\)/g, " * ")
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .replace(/\{/g, " { ")
    .replace(/\}/g, " } ");
  return normalized.trim().split(/\s+/).filter(Boolean);
}

/** Escape regex special characters */
function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a glob pattern (with `*` as wildcard for identifiers) to a regex pattern string.
 * Handles "*", "prefix*", "*suffix", and literal patterns.
 */
function globToRegexPattern(glob: string): string {
  if (glob === "*" || glob === "") return "[a-zA-Z_][a-zA-Z0-9_]*";
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/\*/g, "[a-zA-Z_][a-zA-Z0-9_]*");
}

/** Check if `text` matches a glob pattern (supports "*" wildcard). */
function globMatch(text: string, pattern: string): boolean {
  if (pattern === "*" || pattern === null) return true;
  if (pattern === text) return true;
  const regexStr = `^${globToRegexPattern(pattern)}$`;
  try {
    return new RegExp(regexStr).test(text);
  } catch {
    return text.includes(pattern);
  }
}

/**
 * Build a fallback regex from a tokenized AST pattern for languages
 * without tree-sitter support. Converts the pattern to a line-matching regex.
 */
function buildPatternFallbackRegex(tokens: string[]): RegExp {
  const parts: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;

    // Body block: match { ... } with flexible content
    if (token === "{") {
      i++;
      const bodyTokens: string[] = [];
      while (i < tokens.length && tokens[i] !== "}") {
        bodyTokens.push(tokens[i]!);
        i++;
      }
      if (i < tokens.length) i++; // skip "}"

      if (bodyTokens.length === 0) {
        parts.push(`\\s*\\{[^}]*\\}`);
      } else {
        // Extract literal type names (non-wildcard) for body matching
        const literals = bodyTokens.filter(
          (t) => t !== "*" && t !== "*:" && !t.includes("*"),
        );
        if (literals.length > 0) {
          const typeCheck = literals.map((t) => `\\b${escapeRegex(t)}\\b`).join("[^}]*");
          parts.push(`\\s*\\{[^}]*${typeCheck}[^}]*\\}`);
        } else {
          parts.push(`\\s*\\{[^}]*\\}`);
        }
      }
      continue;
    }

    // Keywords and qualifiers
    if (
      AST_KEYWORDS.has(token) ||
      AST_QUALIFIERS.has(token) ||
      token === "extends" ||
      token === "implements" ||
      token === "for" ||
      token === "with"
    ) {
      parts.push(`\\b${token}\\b`);
    } else if (token === "*") {
      parts.push(`[a-zA-Z_][a-zA-Z0-9_]*`);
    } else if (token === "*:") {
      parts.push(`[a-zA-Z_][a-zA-Z0-9_]*\\s*:`);
    } else if (token === "->") {
      parts.push(`->`);
    } else if (token === "(") {
      parts.push(`\\(`);
    } else if (token === ")") {
      parts.push(`\\)`);
    } else if (token.endsWith("*") && !token.startsWith("*") && token.length > 1) {
      // prefix* \u2192 prefix followed by identifier
      const prefix = escapeRegex(token.slice(0, -1));
      parts.push(`${prefix}[a-zA-Z_][a-zA-Z0-9_]*`);
    } else if (token.startsWith("*") && token.length > 1) {
      // *suffix \u2192 identifier followed by suffix
      const suffix = escapeRegex(token.slice(1));
      parts.push(`[a-zA-Z_][a-zA-Z0-9_]*${suffix}`);
    } else {
      parts.push(`\\b${escapeRegex(token)}\\b`);
    }
    i++;
  }

  return new RegExp(parts.join("\\s+"));
}

/**
 * Parse a user-friendly AST pattern string into a structured query.
 *
 * Supported patterns:
 *   fn(*) -> Result         \u2014 functions returning Result
 *   class * extends Base    \u2014 classes extending Base
 *   async fn process_*      \u2014 async functions starting with "process_"
 *   impl * for *            \u2014 trait implementations
 *   struct * { *: String }  \u2014 structs with String fields
 */
function parseAstPattern(raw: string): ParsedAstPattern | null {
  const tokens = tokenizeAstPattern(raw);
  if (tokens.length === 0) return null;

  // Find the structural keyword (fn, class, struct, impl, trait, enum, interface)
  let keyword: string | null = null;
  let keywordIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (AST_KEYWORDS.has(tokens[i]!)) {
      keyword = tokens[i]!;
      keywordIdx = i;
      break;
    }
  }
  if (!keyword) return null;

  const qualifiers = new Set<string>();
  let namePattern: string | null = null;
  let returnTypePattern: string | null = null;
  let extendsPattern: string | null = null;
  let forTypePattern: string | null = null;
  let bodyFieldPatterns: string[] | null = null;

  // Collect qualifiers before keyword
  for (let i = 0; i < keywordIdx; i++) {
    if (AST_QUALIFIERS.has(tokens[i]!)) {
      qualifiers.add(tokens[i]!);
    }
  }

  // Keep full token list for regex fallback building
  const allTokens = [...tokens];

  // Parse tokens after keyword
  let i = keywordIdx + 1;
  while (i < tokens.length) {
    const token = tokens[i]!;

    // Qualifiers can appear after keyword too
    if (AST_QUALIFIERS.has(token)) {
      qualifiers.add(token);
      i++;
      continue;
    }

    // Return type: -> Type
    if (token === "->") {
      i++;
      if (i < tokens.length) {
        returnTypePattern = tokens[i]!;
        i++;
      }
      continue;
    }

    // Extends: extends Base
    if (token === "extends") {
      i++;
      if (i < tokens.length) {
        extendsPattern = tokens[i]!;
        i++;
      }
      continue;
    }

    // For-type (Rust impl): for Type
    if (token === "for") {
      i++;
      if (i < tokens.length) {
        forTypePattern = tokens[i]!;
        i++;
      }
      continue;
    }

    // implements / with \u2014 just skip the type name
    if (token === "implements" || token === "with") {
      i++;
      if (
        i < tokens.length &&
        tokens[i] !== "{" &&
        tokens[i] !== "->" &&
        !AST_RELATIONS.has(tokens[i]!)
      ) {
        i++; // skip the type name
      }
      continue;
    }

    // Body block: { field patterns }
    if (token === "{") {
      i++;
      const fieldTokens: string[] = [];
      while (i < tokens.length && tokens[i] !== "}") {
        const ft = tokens[i]!;
        // Strip trailing ":" from field name patterns like "*:"
        fieldTokens.push(ft.endsWith(":") ? ft.slice(0, -1) : ft);
        i++;
      }
      if (i < tokens.length) i++; // skip "}"

      if (fieldTokens.length > 0) {
        // Extract literal type names (non-wildcard tokens) for body field matching
        const types = fieldTokens.filter(
          (t) => t !== "*" && !AST_KEYWORDS.has(t) && !AST_QUALIFIERS.has(t) && !t.startsWith("*"),
        );
        bodyFieldPatterns = types.length > 0 ? types : ["*"];
      } else {
        bodyFieldPatterns = ["*"];
      }
      continue;
    }

    // Skip standalone parens \u2014 they\'re decorative in pattern syntax
    if (token === "(" || token === ")") {
      i++;
      continue;
    }

    // Everything else is a name pattern or wildcard
    if (namePattern === null) {
      if (token === "*:" || token === "*") {
        namePattern = "*";
      } else if (token.includes("*")) {
        namePattern = token.replace(/:$/, "");
      } else if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) {
        namePattern = token;
      }
    }
    i++;
  }

  const nodeTypes = AST_KEYWORD_NODE_TYPES[keyword] ?? [];
  const isAsync = qualifiers.has("async") ? true : null;
  const fallbackRegex = buildPatternFallbackRegex(allTokens);

  return {
    nodeTypes,
    isAsync,
    namePattern,
    returnTypePattern,
    extendsPattern,
    forTypePattern,
    bodyFieldPatterns,
    fallbackRegex,
  };
}

/**
 * Extract the "name" from a tree-sitter AST node.
 * Tries the "name" field first, then "trait" field (Rust impl),
 * then falls back to the first identifier-like child.
 */
function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;

  // For Rust impl_item, use "trait" field
  const traitNode = node.childForFieldName("trait");
  if (traitNode) return traitNode.text;

  // Fallback to first identifier child
  for (const child of node.namedChildren) {
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier"
    ) {
      return child.text;
    }
  }
  return null;
}

/**
 * Find the body child of a tree-sitter AST node.
 * Looks for children with body-like type names.
 */
function findBodyChild(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const child of node.namedChildren) {
    const t = child.type;
    if (
      t.endsWith("_body") ||
      t === "body" ||
      t === "block" ||
      t === "statement_block" ||
      t === "declaration_list" ||
      t === "field_declaration_list" ||
      t === "class_body"
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Check whether a tree-sitter AST node matches the parsed AST pattern query.
 * Applies all non-null filters from the query against the node.
 */
function checkAstNodeMatches(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  // 1. Node type filter
  if (!query.nodeTypes.includes(node.type)) return false;

  // 2. Name filter
  if (query.namePattern !== null && query.namePattern !== "*") {
    const name = getNodeName(node);
    if (!name || !globMatch(name, query.namePattern)) return false;
  }

  // 3. Async filter
  if (query.isAsync === true) {
    const firstLine = node.text.split("\n")[0] ?? "";
    if (!/\basync\b/.test(firstLine)) return false;
  }

  // 4. Return type filter
  if (query.returnTypePattern !== null && query.returnTypePattern !== "*") {
    const rtNode = node.childForFieldName("return_type");
    if (rtNode) {
      // Strip leading ": " (TS/Java) or "-> " (Rust/Swift) from return_type text
      const rtText = rtNode.text.replace(/^[:\->]\s*/, "");
      if (!globMatch(rtText, query.returnTypePattern)) return false;
    } else {
      // Fallback: search for "-> Type" or ": Type" in text
      const arrowMatch = node.text.match(/(?:->|:)\s*([A-Za-z_][A-Za-z0-9_<>[\]]*)/);
      if (!arrowMatch || !globMatch(arrowMatch[1]!, query.returnTypePattern)) return false;
    }
  }

  // 5. Extends / superclass filter
  if (query.extendsPattern !== null && query.extendsPattern !== "*") {
    let found = false;
    for (const child of node.children) {
      if (child.type === "class_heritage" || child.type === "superclass") {
        if (child.text.includes(query.extendsPattern)) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      if (
        !node.text.includes(`extends ${query.extendsPattern}`) &&
        !node.text.includes(`extends${query.extendsPattern}`)
      ) {
        return false;
      }
    }
  }

  // 6. For-type filter (Rust impl_item: impl Trait for Type)
  if (query.forTypePattern !== null && query.forTypePattern !== "*") {
    if (node.type === "impl_item") {
      const typeNode = node.childForFieldName("type");
      if (!typeNode || !globMatch(typeNode.text, query.forTypePattern)) return false;
    } else {
      const forMatch = node.text.match(/\bfor\s+(\S+?)\s*\{/);
      if (!forMatch || !globMatch(forMatch[1]!, query.forTypePattern)) return false;
    }
  }

  // 7. Body field filter
  if (query.bodyFieldPatterns !== null) {
    if (query.bodyFieldPatterns.length === 1 && query.bodyFieldPatterns[0] === "*") {
      // { * } means any body \u2014 always matches
    } else {
      const bodyNode = findBodyChild(node);
      if (!bodyNode) return false;

      const bodyText = bodyNode.text;
      const matchesOne = query.bodyFieldPatterns.some((pattern) => {
        const re = new RegExp(`:\\s*${globToRegexPattern(pattern)}\\b`);
        return re.test(bodyText);
      });
      if (!matchesOne) return false;
    }
  }

  return true;
}

/**
 * Search a single file for AST nodes matching the parsed pattern.
 * Uses native tree-sitter (synchronous) \u2014 only supports grammars loaded
 * by `loadLanguage()` (TypeScript, JavaScript, TSX).
 * Other languages fall through to regex matching.
 */
async function matchAstNodesInFile(
  filePath: string,
  lang: string,
  query: ParsedAstPattern,
): Promise<{ node: Parser.SyntaxNode; name: string }[]> {
  const grammar = loadLanguage(lang as any);
  if (!grammar) return [];

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  let parser = parserPool.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(grammar);
    parserPool.set(lang, parser);
  }

  const chunkSize = 1024;
  const tree = parser.parse((offset) => content.slice(offset, offset + chunkSize));
  if (!tree?.rootNode) return [];

  const results: { node: Parser.SyntaxNode; name: string }[] = [];
  const cursor = tree.rootNode.walk();

  while (true) {
    const node = cursor.currentNode;
    if (node && query.nodeTypes.includes(node.type)) {
      if (checkAstNodeMatches(node, query)) {
        const name = getNodeName(node) ?? node.type;
        results.push({ node, name });
      }
    }

    if (cursor.gotoFirstChild()) continue;
    if (cursor.gotoNextSibling()) continue;

    let reachedRoot = false;
    while (true) {
      if (!cursor.gotoParent()) {
        reachedRoot = true;
        break;
      }
      if (cursor.gotoNextSibling()) break;
    }
    if (reachedRoot) break;
  }

  return results;
}

// ── Handlers ──────────────────────────────────────────────────────

export async function handleGrep(
  toolCallId: string,
  params: SearchInput,
  cwd: string,
  signal: AbortSignal | undefined,
  options?: { preDiscoveredFiles?: string[]; sharedDefinitionCache?: Map<string, CodeDefinition[]>; sharedSummary?: DiscoverySummary },
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

  const MAX_FILE_BYTES = 10 * 1024 * 1024;

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matches.length >= maxResults) break;

    // Skip oversized files to avoid unbounded memory reads
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }

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
        lineText: truncateLine(line, 200),
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

    const relFile = relative(cwd, filePath).replace(/\\/g, "/");
    let defs = definitionCache.get(filePath);
    if (!defs) {
      defs = await extractCodeDefinitions(filePath, relFile);
      definitionCache.set(filePath, defs);
    }
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
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }

    const relFile = relative(cwd, filePath).replace(/\\/g, "/");
    let definitions = definitionCache.get(filePath);
    if (!definitions) {
      definitions = await extractCodeDefinitions(filePath, relFile);
      definitionCache.set(filePath, definitions);
    }

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
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        continue;
      }

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

  matches.sort((a, b) => {
    if (a.group !== b.group) return a.group === "definition" ? -1 : 1;
    return a.relFile.localeCompare(b.relFile) || a.line - b.line;
  });

  // Record in session cache
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
        'Search repository text with grep and AST-aware code definitions by exact term, regex, boolean query, or structural ast_pattern. Use for precise lookups, e.g. { query: "refreshToken" }, { query: "TODO|FIXME", matchMode: "regex" }, or { query: "class * extends Base", matchMode: "ast_pattern" }. Use depth: "deep" for broad cross-file search that retains grep + AST while adding fused semantic, symbol, graph, and LSP evidence with provenance. Prefer symbol when a symbol name is known and relationships matter, and read/read_files once target paths are known.',
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
