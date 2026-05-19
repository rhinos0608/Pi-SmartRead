import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { EdgeStore, findDirectImportNeighbours, isReadableWorkspaceFile } from "./context-graph.js";
import { createIntentReadTool } from "./intent-read.js";
import createSearchTool from "./search-tool.js";
import { findSrcFiles } from "./file-discovery.js";
import { computeRanks, tokenize } from "./scoring.js";
import { RepoMap } from "./repomap.js";
import {
  classifyRelevance,
  type RelevanceClass,
  relevanceClassWeight,
} from "./classifiers.js";
import { getLSPBridge } from "./lsp-bridge.js";

const DeepSearchSchema = Type.Object({
  query: Type.String({
    description: "Natural language question or code symbol to search for",
    minLength: 1,
    maxLength: 500,
  }),
  depth: Type.Optional(
    Type.Unsafe<DeepSearchDepth>({
      type: "string",
      enum: ["quick", "standard", "thorough"],
      description:
        "Search depth. quick=code+symbols; standard=+semantic file ranking+graph expansion; thorough=+caller relationship enrichment",
      default: "standard",
    }),
  ),
  scope: Type.Optional(
    Type.Unsafe<DeepSearchScope>({
      type: "string",
      enum: ["code", "docs", "tests", "all"],
      description: "Content type filter",
      default: "all",
    }),
  ),
  directory: Type.Optional(
    Type.String({
      description: "Root directory to search (default: extension working directory)",
    }),
  ),
  folder: Type.Optional(
    Type.String({
      description: "Alias for directory. Root folder to search (default: extension working directory)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum matches to return (1-50)",
      minimum: 1,
      maximum: 50,
      default: 15,
    }),
  ),
  maxSnippetChars: Type.Optional(
    Type.Number({
      description: "Max characters per code snippet (100-1000)",
      minimum: 100,
      maximum: 1000,
      default: 400,
    }),
  ),
  outputBudget: Type.Optional(
    Type.Number({
      description: "Approximate output token budget (1k-16k). Tool may truncate to fit.",
      minimum: 1024,
      maximum: 16384,
      default: 4096,
    }),
  ),
  includeRelationships: Type.Optional(
    Type.Boolean({
      description:
        "Include caller/callee/import hints for top matches (default true for thorough, false otherwise)",
      default: false,
    }),
  ),
  filePattern: Type.Optional(
    Type.String({
      description: "Glob/regex to restrict files, e.g. '*.ts' or '^(src/|lib/)'",
    }),
  ),
  focusFiles: Type.Optional(
    Type.Array(Type.String(), {
      description: "Personalize ranking toward these files (like repo_map focusFiles)",
      maxItems: 20,
    }),
  ),
  rerank: Type.Optional(
    Type.Boolean({
      description: "Run optional reranker on top candidates (reserved for configured V2 rerankers)",
      default: false,
    }),
  ),
});

type DeepSearchInput = Static<typeof DeepSearchSchema>;
type DeepSearchDepth = "quick" | "standard" | "thorough";
type DeepSearchScope = "code" | "docs" | "tests" | "all";
type ChannelName = "semantic" | "structural" | "symbol" | "graph" | "lsp";

interface ProvenanceSignal {
  channel: ChannelName;
  signal: string;
  /** Internal numeric signal used only for ranking; public tool output uses strength. */
  rawScore: number;
  rank: number;
  /** Which query terms contributed to this provenance (populated for semantic channel). */
  matchedTerms?: string[];
}

interface PublicProvenanceSignal {
  channel: ChannelName;
  signal: string;
  strength: RelevanceClass;
  rank: number;
  matchedTerms?: string[];
}

interface DeepSearchCandidate {
  file: string;
  line?: number;
  endLine?: number;
  name: string;
  kind: string;
  snippet: string;
  channel: ChannelName;
  rawScore: number;
  rank: number;
}

interface DeepSearchMatch {
  handle: string;
  file: string;
  lines?: { start: number; end: number };
  name: string;
  kind: string;
  snippet: string;
  /** Internal fused score used only for sorting; public tool output uses relevance. */
  score: number;
  provenance: ProvenanceSignal[];
  callers?: Array<{ file: string; name: string }>;
}

interface PublicDeepSearchMatch {
  handle: string;
  file: string;
  lines?: { start: number; end: number };
  name: string;
  kind: string;
  snippet: string;
  relevance: RelevanceClass;
  provenance: PublicProvenanceSignal[];
  callers?: Array<{ file: string; name: string }>;
}

type TermStatus = "found" | "partial" | "not_found";

interface QueryTermCoverage {
  term: string;
  status: TermStatus;
  /** One example match file/name where this term was found. */
  example?: string;
}

interface DeepSearchDetails {
  query: string;
  depth: DeepSearchDepth;
  scope: DeepSearchScope;
  filesInspected: number;
  matches: DeepSearchMatch[];
  channelsUsed: ChannelName[];
  degraded: string[];
  elapsedMs: number;
  rerankRequested: boolean;
  /** Per-query-term coverage to help agents assess search completeness. */
  coverage?: QueryTermCoverage[];
}

interface PublicDeepSearchDetails extends Omit<DeepSearchDetails, "matches"> {
  matches: PublicDeepSearchMatch[];
}

const RRF_K = 60;
const DEFAULT_LIMIT = 15;
const DEFAULT_SNIPPET_CHARS = 400;
const DEFAULT_OUTPUT_BUDGET = 4096;
const MAX_DISCOVERY_FILES = 2_000;
const MAX_GRAPH_SEEDS = 10;
const MAX_GRAPH_CANDIDATES = 30;
const MAX_GRAPH_REVERSE_IMPORT_SCAN = 500;
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage",
  ".cache",
  ".pi-smartread.tags.cache",
  ".pi-smartread.embeddings.cache",
]);

// ── LSP channel constants ────────────────────────────────────

const LSP_SCORE_BOOST = 0.15;
const MAX_LSP_RESULTS = 30;
const MAX_HOVER_RESULTS = 3;

// ── Escalation helpers ─────────────────────────────────────────

const TEST_PATH_RE = /(^|\/|\\)(test|tests|__tests__|spec)(\/|$|\\)/;

/**
 * Check if deep_search should escalate to a compact repo_map.
 * Triggers when 3+ query terms were not found AND (no structural matches
 * exist OR all structural/symbol matches come from test files).
 */
function shouldEscalateToRepoMap(
  coverage: QueryTermCoverage[] | undefined,
  matches: DeepSearchMatch[],
): boolean {
  if (!coverage || coverage.length === 0) return false;

  const notFoundCount = coverage.filter((c) => c.status === "not_found").length;
  if (notFoundCount < 3) return false;

  const structuralMatches = matches.filter((m) =>
    m.provenance.some((p) => p.channel === "structural" || p.channel === "symbol" || p.channel === "lsp"),
  );

  return structuralMatches.length === 0 || structuralMatches.every((m) => TEST_PATH_RE.test(m.file));
}

/**
 * Generate a compact repo-map summary for escalation fallback.
 * Returns a short markdown snippet (~600 chars) summarizing the repo.
 */
async function getCompactRepoSummary(
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (signal?.aborted) return "";

  try {
    const rm = new RepoMap(cwd);
    const result = await rm.getRepoMap({
      mapTokens: 1200,
      focusFiles: [],
      priorityIdentifiers: [],
      mentionedIdents: [],
      mentionedFnames: [],
      excludeUnranked: false,
      forceRefresh: false,
      useImportBased: false,
      autoFallback: true,
      compact: true,
      verbose: false,
    });

    if (!result.map) return "";

    const summary = result.map.length > 800
      ? result.map.slice(0, 600).trimEnd() + "\n…"
      : result.map;

    return `\n## 🗺️ Repo Context (auto-escalated)\n${summary}\n`;
  } catch {
    return "";
  }
}

/**
 * Generate search guidelines for agents when escalation triggers.
 * Based on context-mode's "think in code" and "search technical terms" principles.
 */
function generateSearchGuidelines(notFoundTerms: string[]): string {
  const lines: string[] = [];

  lines.push("### 🔍 Search Guidelines (auto-generated)");
  lines.push("");
  lines.push("Your query had limited matches. For better results:");
  lines.push("");
  lines.push("**1. Use specific technical terms, not concepts:**");
  lines.push(`   - ❌ "${notFoundTerms.slice(0, 2).join('" or "') || 'entry point'}" (concept)`);
  lines.push("   - ✅ `createDeepSearchTool` (exact symbol name)");
  lines.push("   - ✅ `parseCodeCandidates` (function name)");
  lines.push("   - ✅ `QueryTermCoverage` (interface/type name)");
  lines.push("");
  lines.push("**2. Think in code:**");
  lines.push("   - Analyze/count/filter data → write code via `ctx_execute(language, code)`");
  lines.push("   - Process files → `ctx_execute_file(path, language, code)`");
  lines.push("   - Program the analysis, don't compute it mentally");
  lines.push("");
  lines.push("**3. Use repo_map for broad context:**");
  lines.push("   - `repo_map(compact: true)` → single-line file summaries");
  lines.push("   - `repo_map(focusFiles: [\"file.ts\"])` → personalized ranking");
  lines.push("");
  lines.push("**4. Multi-channel search:**");
  lines.push("   - `search mode=symbols query=term` → find symbol definitions");
  lines.push("   - `search mode=code query=term` → AST-aware code search");
  lines.push("   - `search mode=resolve symbol=name` → resolve to definition");
  lines.push("");

  return lines.join("\n");
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeDepth(value: DeepSearchInput["depth"]): DeepSearchDepth {
  return value === "quick" || value === "standard" || value === "thorough" ? value : "standard";
}

function normalizeScope(value: DeepSearchInput["scope"]): DeepSearchScope {
  return value === "code" || value === "docs" || value === "tests" || value === "all" ? value : "all";
}

function resolveDeepSearchRoot(params: DeepSearchInput, defaultCwd: string): string {
  const directory = params.directory?.trim();
  const folder = params.folder?.trim();

  if (directory && folder && resolve(defaultCwd, directory) !== resolve(defaultCwd, folder)) {
    throw new Error("Provide either directory or folder, not both");
  }

  const requested = directory ?? folder;
  return requested ? resolve(defaultCwd, requested) : defaultCwd;
}

function toRelativePath(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : path.replace(/\\/g, "/");
}

function toDisplayName(path: string): string {
  return path.split("/").pop() ?? path;
}

function resolveWorkspaceFile(cwd: string, pathOrSymbol: string): string | undefined {
  const resolved = resolve(cwd, pathOrSymbol);
  if (isReadableWorkspaceFile(cwd, resolved)) return resolved;

  // graph_mutate accepts "file.ts:symbol" handles. EdgeStore stores them as
  // supplied, so strip a trailing symbol suffix when resolving graph edges.
  const normalized = pathOrSymbol.replace(/\\/g, "/");
  const colonIndex = normalized.lastIndexOf(":");
  const slashIndex = normalized.lastIndexOf("/");
  if (colonIndex > slashIndex) {
    const withoutSymbol = pathOrSymbol.slice(0, colonIndex);
    const resolvedWithoutSymbol = resolve(cwd, withoutSymbol);
    if (isReadableWorkspaceFile(cwd, resolvedWithoutSymbol)) return resolvedWithoutSymbol;
  }

  return undefined;
}

function sameResolvedFile(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function pathMatchesScope(path: string, scope: DeepSearchScope): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const isTest = /(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(normalized) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized);
  const isDoc = /\.(md|mdx|txt|rst|adoc)$/.test(normalized) || normalized.startsWith("docs/");

  switch (scope) {
    case "code":
      return !isTest && !isDoc;
    case "docs":
      return isDoc;
    case "tests":
      return isTest;
    case "all":
      return true;
  }
}

function compilePathFilter(pattern: string | undefined): ((path: string) => boolean) | undefined {
  if (!pattern?.trim()) return undefined;
  const raw = pattern.trim();
  try {
    const regex = new RegExp(raw);
    return (path) => regex.test(path);
  } catch {
    const escaped = raw
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    const regex = new RegExp(`^${escaped}$`);
    return (path) => regex.test(path);
  }
}

function extensionOf(path: string): string {
  const match = /\.[^.\/]+$/.exec(path.toLowerCase());
  return match?.[0] ?? "";
}

// ── LSP helpers ─────────────────────────────────────────────

/** LSP SymbolKind values (matching VS Code SymbolKind convention). */
const LSP_SYMBOL_KINDS: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enumMember",
  23: "struct",
  24: "event",
  25: "operator",
  26: "typeParameter",
};

function lspKindToString(kind: number): string {
  return LSP_SYMBOL_KINDS[kind] ?? "symbol";
}

/** Convert a file:// URI to an absolute filesystem path. */
function uriToPath(uri: string): string {
  const decoded = decodeURIComponent(uri);
  if (decoded.startsWith("file://")) {
    return decoded.slice(7); // strip "file://" prefix
  }
  return decoded;
}

async function discoverDocFiles(root: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= limit || signal?.aborted) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= limit || signal?.aborted) return;
      if (entry.name.startsWith(".") && entry.name !== ".github") {
        if (IGNORED_DIRS.has(entry.name)) continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(fullPath);
      } else if (entry.isFile() && DOC_EXTENSIONS.has(extensionOf(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results;
}

async function discoverCandidateFiles(
  cwd: string,
  scope: DeepSearchScope,
  filePattern: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const pathFilter = compilePathFilter(filePattern);
  const all = new Map<string, string>();

  if (scope !== "docs") {
    for (const file of await findSrcFiles(cwd, MAX_DISCOVERY_FILES, signal)) {
      const rel = toRelativePath(cwd, file);
      all.set(rel, file);
    }
  }

  if (scope === "docs" || scope === "all") {
    for (const file of await discoverDocFiles(cwd, MAX_DISCOVERY_FILES, signal)) {
      const rel = toRelativePath(cwd, file);
      all.set(rel, file);
    }
  }

  return [...all.entries()]
    .filter(([rel]) => pathMatchesScope(rel, scope))
    .filter(([rel]) => (pathFilter ? pathFilter(rel) : true))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, abs]) => abs);
}

function extractText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text") {
        return String((item as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseCodeCandidates(text: string, channel: ChannelName): DeepSearchCandidate[] {
  const lines = text.split("\n");
  const candidates: DeepSearchCandidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = /^\s{2}(.+?):(\d+)-(\d+)\s+\[([^\]]+)]\s+(.+?)\s+relevance=(exact|strong|related|weak|none)\s+rank=(\d+)/.exec(line);
    if (!match) continue;

    const snippetLines: string[] = [];
    for (let j = i + 2; j < lines.length && snippetLines.length < 6; j++) {
      const snippetLine = lines[j] ?? "";
      if (!snippetLine.trim()) break;
      snippetLines.push(snippetLine.replace(/^\s{4}/, ""));
    }

    const rank = Number(match[7]) || candidates.length + 1;
    candidates.push({
      file: match[1]!,
      line: Number(match[2]),
      endLine: Number(match[3]),
      kind: match[4]!,
      name: match[5]!.trim(),
      rawScore: relevanceClassWeight(match[6] as RelevanceClass) + 1 / (RRF_K + rank),
      rank,
      snippet: snippetLines.join("\n"),
      channel,
    });
  }

  return candidates;
}

function parseSymbolCandidates(text: string): DeepSearchCandidate[] {
  const candidates: DeepSearchCandidate[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s{2}(.+?):(\d+)\s+\[(def|ref)]\s+\[[^\]]+]\s+([^\s]+)/.exec(line);
    if (!match) continue;
    candidates.push({
      file: match[1]!,
      line: Number(match[2]),
      endLine: Number(match[2]),
      kind: match[3] === "def" ? "symbol" : "reference",
      name: match[4]!,
      rawScore: match[3] === "def" ? 1 : 0.75,
      rank: candidates.length + 1,
      snippet: line.trim(),
      channel: "symbol",
    });
  }
  return candidates;
}

function parseSemanticCandidates(cwd: string, result: unknown): DeepSearchCandidate[] {
  const details = (result as { details?: { files?: unknown } }).details;
  const files = details?.files;
  if (!Array.isArray(files)) return [];

  const candidates: DeepSearchCandidate[] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue;
    const item = file as {
      path?: unknown;
      ok?: unknown;
      included?: unknown;
      fusedRelevance?: unknown;
      keywordRelevance?: unknown;
      semanticRelevance?: unknown;
      chunkRelevance?: unknown;
      chunkIndex?: unknown;
    };
    if (item.ok !== true || item.included !== true || typeof item.path !== "string") continue;
    const relevance = typeof item.fusedRelevance === "string"
      ? item.fusedRelevance as RelevanceClass
      : "related";
    const rel = toRelativePath(cwd, item.path);
    candidates.push({
      file: rel,
      kind: "file",
      name: rel.split("/").pop() ?? rel,
      rawScore: relevanceClassWeight(relevance),
      rank: candidates.length + 1,
      snippet: [
        typeof item.semanticRelevance === "string" ? `semantic=${item.semanticRelevance}` : undefined,
        typeof item.keywordRelevance === "string" ? `keyword=${item.keywordRelevance}` : undefined,
        typeof item.chunkRelevance === "string" ? `chunk=${item.chunkRelevance}` : undefined,
        typeof item.chunkIndex === "number" ? `best chunk #${item.chunkIndex}` : undefined,
      ]
        .filter(Boolean)
        .join("; "),
      channel: "semantic",
    });
  }
  return candidates;
}

function candidateKey(candidate: DeepSearchCandidate): string {
  return `${candidate.file}:${candidate.line ?? 0}:${candidate.name.toLowerCase()}`;
}

function makeHandle(match: DeepSearchMatch): string {
  if (match.lines) return `chunk://${match.file}:${match.lines.start}-${match.lines.end}`;
  return `file://${match.file}`;
}

// ── Query-term extraction and coverage ─────────────────────────────

/** Common English filler words to exclude from query-term extraction. */
const FILLER_WORDS = new Set([
  "the", "this", "that", "these", "those", "with", "from", "file", "code",
  "what", "where", "how", "which", "find", "show", "get", "set", "list",
  "all", "any", "has", "not", "and", "for", "are", "its", "into",
]);

/**
 * Extract code-identifier-like terms from a user query.
 * Uses tokenize() for camelCase/PascalCase/snake_case splitting,
 * then filters out common filler words and short tokens.
 */
function extractQueryTerms(query: string): string[] {
  const tokens = tokenize(query);
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (FILLER_WORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

/**
 * Compute per-term coverage against fused matches.
 * - "found": term appears in a match's name (case-insensitive substring).
 * - "partial": term appears only in a match's snippet, not its name.
 * - "not_found": term doesn't appear in any match name or snippet.
 */
function computeQueryTermCoverage(
  matches: DeepSearchMatch[],
  queryTerms: string[],
): QueryTermCoverage[] {
  return queryTerms.map((term) => {
    const lowerTerm = term.toLowerCase();
    // Check names first (stronger signal)
    for (const match of matches) {
      if (match.name.toLowerCase().includes(lowerTerm)) {
        return {
          term,
          status: "found" as TermStatus,
          example: `${match.file}:${match.name}`,
        };
      }
    }
    // Check snippets second (weaker signal)
    for (const match of matches) {
      if (match.snippet.toLowerCase().includes(lowerTerm)) {
        return {
          term,
          status: "partial" as TermStatus,
          example: `${match.file}:${match.name}`,
        };
      }
    }
    return { term, status: "not_found" as TermStatus };
  });
}

/**
 * Enrich semantic provenance entries with which query terms matched.
 * For each match, tokenizes name+snippet and checks which query terms
 * appear. This gives agents a "why this matched" signal.
 */
function enrichMatchProvenance(
  matches: DeepSearchMatch[],
  query: string,
): void {
  const queryTerms = extractQueryTerms(query);
  if (queryTerms.length === 0) return;

  for (const match of matches) {
    const text = `${match.name} ${match.snippet}`.toLowerCase();
    const matched = queryTerms.filter((term) => text.includes(term.toLowerCase()));
    if (matched.length === 0) continue;

    for (const prov of match.provenance) {
      if (prov.channel === "semantic") {
        prov.matchedTerms = matched;
      }
    }
  }
}

/**
 * Generate follow-up suggestions based on the user's query terms
 * and coverage results, not just the top result token.
 */
function generateFollowUps(
  matches: DeepSearchMatch[],
  coverage: QueryTermCoverage[],
): string[] {
  const lines: string[] = [];

  // Top files for read_multiple_files
  const topFiles = [...new Set(matches.map((m) => m.file))].slice(0, 5);
  if (topFiles.length > 0) {
    lines.push(
      `- Read full files: \`read mode=multiple\` with files: [${topFiles.join(", ")}]`,
    );
  }

  // For each query term that was "found": suggest resolve and callers
  const foundTerms = coverage
    .filter((c) => c.status === "found")
    .map((c) => c.term);
  const resolveTerms = foundTerms.filter(
    (t) => /^[A-Za-z_$][\w$]*$/.test(t),
  );
  for (const term of resolveTerms.slice(0, 3)) {
    lines.push(
      `- Resolve symbol: \`search\` mode=resolve symbol=${term}`,
    );
    lines.push(
      `- Find callers: \`search\` mode=callers function=${term}`,
    );
  }

  // For query terms that were NOT found: suggest broader code search
  const notFoundTerms = coverage
    .filter((c) => c.status === "not_found")
    .map((c) => c.term);
  if (notFoundTerms.length > 0) {
    for (const term of notFoundTerms.slice(0, 3)) {
      lines.push(
        `- Search code for: \`search\` mode=code query="${term}"`,
      );
    }
  }

  // If no query-specific follow-ups, fall back to top-match heuristic
  if (resolveTerms.length === 0 && notFoundTerms.length === 0) {
    const topSymbol = matches.find((m) => m.kind !== "file")?.name;
    if (topSymbol && /^[A-Za-z_$][\w$]*$/.test(topSymbol)) {
      lines.push(
        `- Resolve symbol: \`search\` mode=resolve symbol=${topSymbol}`,
      );
      lines.push(
        `- Find callers: \`search\` mode=callers function=${topSymbol}`,
      );
    }
  }

  return lines;
}

function fuseCandidates(
  candidates: DeepSearchCandidate[],
  limit: number,
  focusFiles: string[],
  maxSnippetChars: number,
): DeepSearchMatch[] {
  const grouped = new Map<string, DeepSearchMatch>();
  const focus = new Set(focusFiles.map((file) => file.replace(/\\/g, "/")));

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const contribution = 1 / (RRF_K + candidate.rank);
    let existing = grouped.get(key);
    if (!existing) {
      existing = {
        handle: "",
        file: candidate.file,
        lines: candidate.line ? { start: candidate.line, end: candidate.endLine ?? candidate.line } : undefined,
        name: candidate.name,
        kind: candidate.kind,
        snippet: truncate(candidate.snippet || candidate.name, maxSnippetChars),
        score: 0,
        provenance: [],
      };
      grouped.set(key, existing);
    }

    existing.score += contribution;
    existing.provenance.push({
      channel: candidate.channel,
      signal: candidate.kind,
      rawScore: candidate.rawScore,
      rank: candidate.rank,
    });
  }

  const matches = [...grouped.values()];
  for (const match of matches) {
    if (focus.has(match.file)) match.score *= 1.15;
    match.handle = makeHandle(match);
  }

  matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const maxScore = Math.max(...matches.map((m) => m.score), 0.000001);
  return matches.slice(0, limit).map((match) => ({
    ...match,
    score: match.score / maxScore,
  }));
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function channelSet(matches: DeepSearchMatch[]): ChannelName[] {
  return [...new Set(matches.flatMap((m) => m.provenance.map((p) => p.channel)))];
}

function formatMatch(match: DeepSearchMatch): string[] {
  const matchLines = match.lines ? `L${match.lines.start}-${match.lines.end}` : "file";
  const signals = [...new Set(match.provenance.map((p) => p.channel))].join(" + ");

  // Collect matched terms from semantic provenance for "why this matched"
  const semanticProv = match.provenance.filter((p) => p.channel === "semantic");
  const matchedTerms = [...new Set(semanticProv.flatMap((p) => p.matchedTerms ?? []))];

  const output = [
    `### ${match.file}`,
    `- **${match.name}** (${matchLines}) — \`relevance: ${classifyRelevance(match.score)}\` — ${signals}`,
  ];
  if (matchedTerms.length > 0) {
    output.push(`  matched: ${matchedTerms.join(", ")}`);
  }
  if (match.snippet.trim()) {
    output.push("  ```");
    output.push(...match.snippet.split("\n").map((line) => `  ${line}`));
    output.push("  ```");
  }
  return output;
}

function renderMarkdown(details: DeepSearchDetails, maxOutputChars: number): string {
  const files = new Set(details.matches.map((m) => m.file));
  const lines: string[] = [
    `# Deep Search: "${details.query}"`,
    `**Depth:** ${details.depth} | **Matches:** ${details.matches.length} | **Files:** ${files.size} | **Time:** ${(details.elapsedMs / 1000).toFixed(1)}s`,
    "",
  ];

  // Split matches: exact have structural or symbol provenance, semantic-only don't
  const exactMatches = details.matches.filter((m) =>
    m.provenance.some((p) => p.channel === "structural" || p.channel === "symbol" || p.channel === "lsp"),
  );
  const semanticOnlyMatches = details.matches.filter(
    (m) => !exactMatches.includes(m),
  );

  // ── Exact Matches ────────────────────────────────────────────────
  if (exactMatches.length > 0) {
    lines.push("## 🎯 Exact Matches (Code)", "");
    for (const match of exactMatches) {
      lines.push(...formatMatch(match), "");
    }
  }

  // ── Related Matches (Semantic) ───────────────────────────────────
  if (semanticOnlyMatches.length > 0) {
    lines.push("## 📄 Related Matches (Semantic)", "");
    if (exactMatches.length === 0 && semanticOnlyMatches.length === 0) {
      // Already covered above, but for completeness
    }
    for (const match of semanticOnlyMatches) {
      lines.push(...formatMatch(match), "");
    }
  } else if (details.matches.length === 0) {
    lines.push("No matches found.", "");
  }

  // ── Query Coverage ───────────────────────────────────────────────
  if (details.coverage && details.coverage.length > 0) {
    lines.push("## 📊 Query Coverage", "");
    lines.push("| Term | Status | Example |");
    lines.push("|------|--------|---------|");
    for (const c of details.coverage) {
      const icon = c.status === "found" ? "✅" : c.status === "partial" ? "⚠️" : "❌";
      const statusLabel = c.status === "found" ? "found" : c.status === "partial" ? "partial" : "not found";
      const example = c.example ? c.example.split("/").pop() ?? c.example : "—";
      lines.push(`| \`${c.term}\` | ${icon} ${statusLabel} | ${example} |`);
    }
    lines.push("");

    // Explicit "not found" callout
    const notFound = details.coverage.filter((c) => c.status === "not_found").map((c) => c.term);
    if (notFound.length > 0) {
      lines.push(
        `> ⚠️ **Note:** ${notFound.map((t) => `\`${t}\``).join(", ")} not found in top ${details.matches.length} results. ` +
        `Consider using \`search\` mode=code for these terms.`,
        "",
      );
    }
  }

  // ── Relationships ────────────────────────────────────────────────
  const relationshipMatches = details.matches.filter((m) => m.callers && m.callers.length > 0);
  if (relationshipMatches.length > 0) {
    lines.push("## 🔗 Relationships", "");
    for (const match of relationshipMatches) {
      const callers = match.callers!.slice(0, 5).map((c) => `${c.name} in ${c.file}`).join(", ");
      lines.push(`- **${match.name}** called by ${callers}`);
    }
    lines.push("");
  }

  // ── Summary ──────────────────────────────────────────────────────
  lines.push("## 📊 Summary", "");
  lines.push(`- Channels: ${details.channelsUsed.length > 0 ? details.channelsUsed.join(", ") : "none"}`);
  lines.push(`- Files inspected: ${details.filesInspected}`);
  if (details.rerankRequested) lines.push("- Rerank: requested, reserved for configured V2 rerankers");
  if (details.degraded.length > 0) {
    lines.push(`- Degraded: ${details.degraded.join("; ")}`);
  }
  lines.push("");

  // ── Follow-ups (query-aware) ─────────────────────────────────────
  lines.push("## ➡️ Follow-ups", "");
  if (details.coverage && details.coverage.length > 0) {
    lines.push(...generateFollowUps(details.matches, details.coverage));
  } else {
    // Fallback: old heuristic
    const topFiles = [...new Set(details.matches.map((m) => m.file))].slice(0, 5);
    const topSymbol = details.matches.find((m) => m.kind !== "file")?.name;
    if (topFiles.length > 0) {
      lines.push(`- Read full files: \`read mode=multiple\` with files: [${topFiles.join(", ")}]`);
    }
    if (topSymbol) {
      lines.push(`- Resolve symbol: \`search\` mode=resolve symbol=${topSymbol}`);
      lines.push(`- Find callers: \`search\` mode=callers function=${topSymbol}`);
    }
  }

  return truncate(lines.join("\n"), maxOutputChars);
}

function toPublicDeepSearchDetails(details: DeepSearchDetails): PublicDeepSearchDetails {
  return {
    ...details,
    matches: details.matches.map((match) => ({
      handle: match.handle,
      file: match.file,
      ...(match.lines && { lines: match.lines }),
      name: match.name,
      kind: match.kind,
      snippet: match.snippet,
      relevance: classifyRelevance(match.score),
      provenance: match.provenance.map((signal) => ({
        channel: signal.channel,
        signal: signal.signal,
        strength: classifyRelevance(Math.min(1, Math.max(0, signal.rawScore))),
        rank: signal.rank,
        ...(signal.matchedTerms && { matchedTerms: signal.matchedTerms }),
      })),
      ...(match.callers && { callers: match.callers }),
    })),
  };
}

function callerDetails(result: unknown): Array<{ file: string; name: string }> {
  const details = (result as { details?: { callers?: unknown } }).details;
  if (!Array.isArray(details?.callers)) return [];
  return details.callers.flatMap((caller) => {
    if (typeof caller !== "object" || caller === null) return [];
    const item = caller as { file?: unknown; callerFunction?: unknown };
    if (typeof item.file !== "string" || typeof item.callerFunction !== "string") return [];
    return [{ file: item.file, name: item.callerFunction }];
  });
}

async function enrichRelationships(
  matches: DeepSearchMatch[],
  cwd: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<void> {
  const searchTool = createSearchTool();
  const eligible = matches.filter((m) => /^[A-Za-z_$][\w$]*$/.test(m.name)).slice(0, 3);

  for (const match of eligible) {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      const result = await searchTool.execute(
        "deep-search:callers",
        { mode: "callers", function: match.name, maxResults: 10, directory: cwd },
        signal,
        undefined,
        ctx,
      );
      match.callers = callerDetails(result);
    } catch {
      match.callers = [];
    }
  }
}

async function runSearchChannel(
  query: string,
  cwd: string,
  mode: "code" | "symbols",
  maxResults: number,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<DeepSearchCandidate[]> {
  const searchTool = createSearchTool();
  const result = await searchTool.execute(
    `deep-search:${mode}`,
    { mode, query, maxResults, enrich: false, directory: cwd },
    signal,
    undefined,
    ctx,
  );
  const text = extractText(result);
  return mode === "code" ? parseCodeCandidates(text, "structural") : parseSymbolCandidates(text);
}

async function runSemanticChannel(
  query: string,
  cwd: string,
  files: string[],
  limit: number,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<DeepSearchCandidate[]> {
  const intentReadTool = createIntentReadTool();
  const rankedFiles = files.slice(0, Math.max(limit * 2, limit));
  const result = await intentReadTool.execute(
    "deep-search:semantic",
    {
      query,
      files: rankedFiles.map((path) => ({ path })),
      topK: Math.min(20, Math.max(limit, 1)),
      stopOnError: false,
    },
    signal,
    undefined,
    ctx,
  );
  return parseSemanticCandidates(cwd, result);
}

function graphCandidate(
  cwd: string,
  file: string,
  kind: string,
  from: string,
  rawScore: number,
  rank: number,
): DeepSearchCandidate | undefined {
  const resolved = resolveWorkspaceFile(cwd, file);
  if (!resolved || sameResolvedFile(resolve(cwd, from), resolved)) return undefined;

  const rel = toRelativePath(cwd, resolved);
  const fromRel = toRelativePath(cwd, from);
  return {
    file: rel,
    kind,
    name: toDisplayName(rel),
    rawScore,
    rank,
    snippet: `${kind}: ${fromRel} → ${rel}`,
    channel: "graph",
  };
}

function selectGraphSeedFiles(cwd: string, candidates: DeepSearchCandidate[], focusFiles: string[]): string[] {
  const seeds = new Map<string, number>();
  for (const focusFile of focusFiles) {
    const resolved = resolveWorkspaceFile(cwd, focusFile);
    if (resolved) seeds.set(resolved, Number.POSITIVE_INFINITY);
  }

  for (const candidate of candidates) {
    const resolved = resolveWorkspaceFile(cwd, candidate.file);
    if (!resolved) continue;
    const score = candidate.rawScore + 1 / (RRF_K + candidate.rank);
    seeds.set(resolved, Math.max(seeds.get(resolved) ?? 0, score));
  }

  return [...seeds.entries()]
    .sort((a, b) => b[1] - a[1] || toRelativePath(cwd, a[0]).localeCompare(toRelativePath(cwd, b[0])))
    .slice(0, MAX_GRAPH_SEEDS)
    .map(([file]) => file);
}

function addGraphCandidate(
  candidates: DeepSearchCandidate[],
  seen: Set<string>,
  cwd: string,
  file: string,
  kind: string,
  from: string,
  rawScore: number,
  maxCandidates: number,
): void {
  if (candidates.length >= maxCandidates) return;
  const candidate = graphCandidate(cwd, file, kind, from, rawScore, candidates.length + 1);
  if (!candidate) return;
  const key = `${candidate.file}:${candidate.kind}:${toRelativePath(cwd, from)}`;
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push(candidate);
}

async function runGraphChannel(
  cwd: string,
  seedFiles: string[],
  discoveredFiles: string[],
  maxCandidates: number,
  signal: AbortSignal | undefined,
): Promise<DeepSearchCandidate[]> {
  if (seedFiles.length === 0 || maxCandidates <= 0) return [];

  const candidates: DeepSearchCandidate[] = [];
  const seen = new Set<string>();
  const resolvedSeeds = seedFiles.map((file) => resolve(cwd, file));
  const seedSet = new Set(resolvedSeeds);

  for (const seedFile of resolvedSeeds) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const importNeighbours = findDirectImportNeighbours(cwd, [seedFile], maxCandidates);
    for (const neighbour of importNeighbours) {
      addGraphCandidate(candidates, seen, cwd, neighbour, "imports", seedFile, 0.9, maxCandidates);
    }
  }

  // Reverse import adjacency lets a definition file pull in its importers.
  // This is the common "auth.ts is relevant; show api.ts too" graph case.
  for (const file of discoveredFiles.slice(0, MAX_GRAPH_REVERSE_IMPORT_SCAN)) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (candidates.length >= maxCandidates) break;
    const importer = resolve(cwd, file);
    const importedFiles = findDirectImportNeighbours(cwd, [importer], maxCandidates);
    for (const imported of importedFiles) {
      const importedResolved = resolve(cwd, imported);
      if (!seedSet.has(importedResolved)) continue;
      addGraphCandidate(candidates, seen, cwd, importer, "imported_by", importedResolved, 0.85, maxCandidates);
    }
  }

  for (const event of EdgeStore.readEdges(cwd)) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (candidates.length >= maxCandidates) break;
    const fromFile = resolveWorkspaceFile(cwd, event.data.from);
    const toFile = resolveWorkspaceFile(cwd, event.data.to);
    if (!fromFile || !toFile || !seedSet.has(fromFile)) continue;
    const confidence = event.data.confidence ?? (event.type === "breakage" ? 1.0 : 0.7);
    addGraphCandidate(candidates, seen, cwd, toFile, event.type, fromFile, confidence, maxCandidates);
  }

  return candidates;
}

/**
 * Run the LSP workspace/symbol retrieval channel.
 * Best-effort: returns empty array on any failure.
 */
async function runLSPChannel(
  query: string,
  cwd: string,
  depth: DeepSearchDepth,
  maxResults: number,
  signal: AbortSignal | undefined,
): Promise<DeepSearchCandidate[]> {
  if (signal?.aborted) return [];
  if (query.length <= 2) return [];

  const bridge = await getLSPBridge();
  if (signal?.aborted) return [];
  if (!bridge?.isAvailable()) return [];

  let symbols: import("./lsp-bridge.js").LSPWorkspaceSymbol[];
  try {
    symbols = await bridge.workspaceSymbol(query, cwd);
  } catch {
    return [];
  }

  if (signal?.aborted || !Array.isArray(symbols) || symbols.length === 0) return [];

  const limit = depth === "thorough" ? Math.min(maxResults * 2, MAX_LSP_RESULTS) : maxResults;
  const candidates: DeepSearchCandidate[] = [];

  for (let i = 0; i < Math.min(symbols.length, limit); i++) {
    const sym = symbols[i]!;
    if (!sym?.name || !sym?.location?.uri) continue;

    const filePath = uriToPath(sym.location.uri);
    const rel = toRelativePath(cwd, filePath);
    if (!rel) continue;

    candidates.push({
      file: rel,
      line: sym.location.range.start.line + 1,
      endLine: sym.location.range.end.line + 1,
      name: sym.name,
      kind: lspKindToString(sym.kind),
      rawScore: 1 + LSP_SCORE_BOOST,
      rank: candidates.length + 1,
      snippet: "",
      channel: "lsp",
    });
  }

  // For thorough depth, fetch hover info for the first few results
  // to enrich snippets with type/signature information.
  if (depth === "thorough" && candidates.length > 0) {
    const hoverLimit = Math.min(MAX_HOVER_RESULTS, candidates.length);
    for (let i = 0; i < hoverLimit; i++) {
      if (signal?.aborted) break;
      const candidate = candidates[i];
      if (!candidate || candidate.line === undefined) continue;
      try {
        const absPath = resolve(cwd, candidate.file);
        const hoverResult = await bridge.hover(absPath, candidate.line - 1, 0, cwd);
        if (hoverResult) {
          const hoverText = typeof hoverResult.contents === "string"
            ? hoverResult.contents
            : Array.isArray(hoverResult.contents)
              ? hoverResult.contents.map((c) => typeof c === "string" ? c : c.value).join("\n")
              : "value" in hoverResult.contents ? hoverResult.contents.value : "";
          if (hoverText) {
            candidate.snippet = hoverText.slice(0, 200);
          }
        }
      } catch { /* best effort */ }
    }
  }

  return candidates;
}

export function createDeepSearchTool(): ToolDefinition {
  return {
    name: "deep_search",
    label: "deep_search",
    description:
      "Agentic deep repository search. Orchestrates structural code search, symbol search, LSP workspace symbol search, optional intent_read semantic ranking, graph expansion, RRF fusion, provenance, and follow-up suggestions in one call. Use directory/folder to search a specific root.",
    parameters: DeepSearchSchema,

    async execute(
      _toolCallId: string,
      params: DeepSearchInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const startedAt = Date.now();
      const query = params.query.trim();
      if (!query) throw new Error("query must not be empty or whitespace-only");

      const depth = normalizeDepth(params.depth);
      const scope = normalizeScope(params.scope);
      const limit = clampInteger(params.limit, 1, 50, DEFAULT_LIMIT);
      const maxSnippetChars = clampInteger(params.maxSnippetChars, 100, 1_000, DEFAULT_SNIPPET_CHARS);
      const outputBudget = clampInteger(params.outputBudget, 1_024, 16_384, DEFAULT_OUTPUT_BUDGET);
      const includeRelationships = params.includeRelationships ?? depth === "thorough";
      const focusFiles = (params.focusFiles ?? []).map((file) => file.replace(/\\/g, "/"));
      const cwd = resolveDeepSearchRoot(params, ctx.cwd);
      const degraded: string[] = [];

      const discoveredFiles = await discoverCandidateFiles(cwd, scope, params.filePattern, signal);
      const candidatePathFilter = new Set(discoveredFiles.map((path) => toRelativePath(cwd, path)));
      const maxChannelResults = Math.min(100, Math.max(limit * 3, limit));

      const channelResults: DeepSearchCandidate[] = [];

      // Phase 1: code + symbol in parallel (they share no state)
      const phase1Promise = (async () => {
        if (scope !== "docs") {
          const results = await Promise.allSettled([
            runSearchChannel(query, cwd, "code", maxChannelResults, signal, ctx),
            runSearchChannel(query, cwd, "symbols", maxChannelResults, signal, ctx),
          ]);
          if (results[0].status === "fulfilled") {
            channelResults.push(...results[0].value);
          } else {
            degraded.push(`structural channel failed: ${results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason)}`);
          }
          if (results[1].status === "fulfilled") {
            channelResults.push(...results[1].value);
          } else {
            degraded.push(`symbol channel failed: ${results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason)}`);
          }
        }
      })();

      // Phase 2: semantic in parallel with phase 1 (it only needs discoveredFiles)
      const phase2Promise = (async () => {
        if (depth !== "quick" && discoveredFiles.length > 0) {
          try {
            channelResults.push(...await runSemanticChannel(query, cwd, discoveredFiles, limit, signal, ctx));
          } catch (error) {
            degraded.push(`semantic channel unavailable: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      })();

      // LSP workspace/symbol channel in parallel — independent of file discovery
      // Best-effort: wraps in try/catch internally
      const lspPromise = (async () => {
        if (query.length > 2) {
          try {
            channelResults.push(...await runLSPChannel(query, cwd, depth, maxChannelResults, signal));
          } catch (error) {
            degraded.push(`lsp channel failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      })();

      // Wait for phases 1, 2, and LSP
      await Promise.all([phase1Promise, phase2Promise, lspPromise]);

      // Phase 3: graph channel (needs seeds from phase 1 results)
      if (depth !== "quick" && scope !== "docs" && channelResults.length > 0) {
        try {
          const graphSeeds = selectGraphSeedFiles(cwd, channelResults, focusFiles);
          channelResults.push(
            ...await runGraphChannel(
              cwd,
              graphSeeds,
              discoveredFiles,
              Math.min(MAX_GRAPH_CANDIDATES, maxChannelResults),
              signal,
            ),
          );
        } catch (error) {
          degraded.push(`graph channel failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const filteredCandidates = channelResults
        .map((candidate) => ({
          ...candidate,
          file: toRelativePath(cwd, candidate.file),
        }))
        .filter((candidate) => candidatePathFilter.size === 0 || candidatePathFilter.has(candidate.file))
        .filter((candidate) => pathMatchesScope(candidate.file, scope));

      for (const channel of ["semantic", "structural", "symbol", "graph", "lsp"] as const) {
        const candidates = filteredCandidates.filter((candidate) => candidate.channel === channel);
        const ranks = computeRanks(candidates.map((candidate) => candidate.rawScore), candidates.map((candidate) => candidate.file));
        candidates.forEach((candidate, index) => {
          candidate.rank = ranks[index] ?? candidate.rank;
        });
      }

      const matches = fuseCandidates(filteredCandidates, limit, focusFiles, maxSnippetChars);

      // Post-fusion enrichment: provenance matchedTerms + per-term coverage
      enrichMatchProvenance(matches, query);
      const queryTerms = extractQueryTerms(query);
      const coverage = queryTerms.length > 0
        ? computeQueryTermCoverage(matches, queryTerms)
        : undefined;

      if (includeRelationships && matches.length > 0 && scope !== "docs") {
        await enrichRelationships(matches, cwd, signal, ctx);
      }

      const details: DeepSearchDetails = {
        query,
        depth,
        scope,
        filesInspected: discoveredFiles.length,
        matches,
        channelsUsed: channelSet(matches),
        degraded,
        elapsedMs: Date.now() - startedAt,
        rerankRequested: params.rerank === true,
        ...(coverage && { coverage }),
      };

      // Escalation: prepend compact repo-map + guidelines when query had poor coverage
      // and all structural matches came from test files (or there were no structural matches)
      const escalate = shouldEscalateToRepoMap(coverage, matches);
      let rendered = renderMarkdown(details, outputBudget * 4);

      if (escalate) {
        // Append repo-map summary
        const repoSummary = await getCompactRepoSummary(cwd, signal);
        if (repoSummary) {
          rendered = rendered + "\n" + repoSummary;
        }

        // Append search guidelines
        if (coverage) {
          const notFoundTerms = coverage
            .filter((c) => c.status === "not_found")
            .map((c) => c.term);
          if (notFoundTerms.length > 0) {
            rendered = rendered + "\n" + generateSearchGuidelines(notFoundTerms) + "\n";
          }
        }

        // Enforce outputBudget on the combined content
        rendered = renderMarkdown({ ...details, matches: [], coverage: undefined }, outputBudget);
      }

      return {
        content: [{ type: "text" as const, text: rendered }],
        details: toPublicDeepSearchDetails(details),
      };
    },
  } as unknown as ToolDefinition;
}
