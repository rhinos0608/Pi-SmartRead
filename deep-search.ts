// deep-search.ts
// Main orchestrator for deep search with multi-channel fusion
//
// Module responsibilities:
//   - deep-search-semantic.ts: BM25 + embedding re-rank, intent-read integration
//   - deep-search-structural.ts: Tree-sitter AST parsing, code structure analysis
//   - deep-search-symbol.ts: Symbol resolution, caller graph, declaration finding
//   - deep-search-graph.ts: Context-graph traversal, EdgeStore queries
//   - deep-search-lsp.ts: LSP workspace symbols, document symbols, hover type

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { promises as fs } from "node:fs";
import { join, relative, resolve } from "node:path";

import { classifyRelevance } from "./classifiers.js";
import { computeRanks } from "./scoring.js";
import { findSrcFiles } from "./file-discovery.js";
import { RepoMap } from "./repomap.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DeepSearchParams {
  query: string;
  depth?: "quick" | "standard" | "thorough";
  scope?: "code" | "docs" | "tests" | "all";
  directory?: string;
  limit?: number;
  maxSnippetChars?: number;
  outputBudget?: number;
  includeRelationships?: boolean;
  focusFiles?: string[];
}

export type DeepSearchDepth = "quick" | "standard" | "thorough";
export type DeepSearchScope = "code" | "docs" | "tests" | "all";
export type ChannelName = "semantic" | "structural" | "symbol" | "graph" | "lsp";

export interface ProvenanceSignal {
  channel: ChannelName;
  signal: string;
  /** Internal numeric signal used only for ranking; public tool output uses strength. */
  rawScore: number;
  rank: number;
  /** Which query terms contributed to this provenance (populated for semantic channel). */
  matchedTerms?: string[];
}

export interface PublicProvenanceSignal {
  channel: ChannelName;
  signal: string;
  strength: import("./classifiers.js").RelevanceClass;
  rank: number;
  matchedTerms?: string[];
}

export interface DeepSearchCandidate {
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

export interface DeepSearchMatch {
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

export interface PublicDeepSearchMatch {
  handle: string;
  file: string;
  lines?: { start: number; end: number };
  name: string;
  kind: string;
  snippet: string;
  relevance: import("./classifiers.js").RelevanceClass;
  provenance: PublicProvenanceSignal[];
  callers?: Array<{ file: string; name: string }>;
}

export type TermStatus = "found" | "partial" | "not_found";

export interface QueryTermCoverage {
  term: string;
  status: TermStatus;
  /** One example match file/name where this term was found. */
  example?: string;
}

export interface DeepSearchDetails {
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

export interface PublicDeepSearchDetails extends Omit<DeepSearchDetails, "matches"> {
  matches: PublicDeepSearchMatch[];
}

// ── Channel imports (used by orchestrator) ────────────────────────────────────

import { RRF_K } from "./deep-search-constants.js";
import { extractQueryTerms, enrichMatchProvenance, runSemanticChannel } from "./deep-search-semantic.js";
import { runSearchChannel } from "./deep-search-structural.js";
import { runSymbolChannel, enrichRelationships } from "./deep-search-symbol.js";
import { runGraphChannel, selectGraphSeedFiles } from "./deep-search-graph.js";
import { runLSPChannel } from "./deep-search-lsp.js";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 15;
const DEFAULT_SNIPPET_CHARS = 400;
const DEFAULT_OUTPUT_BUDGET = 4096;
const MAX_DISCOVERY_FILES = 2_000;
const MAX_GRAPH_CANDIDATES = 30;

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

// ── Internal helpers ────────────────────────────────────────────────────────

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeDepth(value: DeepSearchParams["depth"]): DeepSearchDepth {
  return value === "quick" || value === "standard" || value === "thorough" ? value : "standard";
}

function normalizeScope(value: DeepSearchParams["scope"]): DeepSearchScope {
  return value === "code" || value === "docs" || value === "tests" || value === "all" ? value : "all";
}

function resolveDeepSearchRoot(params: DeepSearchParams, defaultCwd: string): string {
  const directory = params.directory?.trim();
  return directory ? resolve(defaultCwd, directory) : defaultCwd;
}

function toRelativePath(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : path.replace(/\\/g, "/");
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

function extensionOf(path: string): string {
  const match = /\.[^.\/]+$/.exec(path.toLowerCase());
  return match?.[0] ?? "";
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
  signal?: AbortSignal,
): Promise<string[]> {
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
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, abs]) => abs);
}

function candidateKey(candidate: DeepSearchCandidate): string {
  return `${candidate.file}:${candidate.line ?? 0}:${candidate.name.toLowerCase()}`;
}

function makeHandle(match: DeepSearchMatch): string {
  if (match.lines) return `chunk://${match.file}:${match.lines.start}-${match.lines.end}`;
  return `file://${match.file}`;
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (maxChars === 1) return text[0] ?? "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function channelSet(matches: DeepSearchMatch[]): ChannelName[] {
  return [...new Set(matches.flatMap((m) => m.provenance.map((p) => p.channel)))];
}

// ── Query-term extraction and coverage ──────────────────────────────────────

/** Common English filler words to exclude from query-term extraction. */
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
          status: "found" as const,
          example: `${match.file}:${match.name}`,
        };
      }
    }
    // Check snippets second (weaker signal)
    for (const match of matches) {
      if (match.snippet.toLowerCase().includes(lowerTerm)) {
        return {
          term,
          status: "partial" as const,
          example: `${match.file}:${match.name}`,
        };
      }
    }
    return { term, status: "not_found" as const };
  });
}

// ── Follow-up generation ─────────────────────────────────────────────────────

/**
 * Generate follow-up suggestions based on the user's query terms
 * and coverage results, not just the top result token.
 */
function generateFollowUps(
  matches: DeepSearchMatch[],
  coverage: QueryTermCoverage[],
): string[] {
  const lines: string[] = [];

  // Top files for read_files
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
      `- Resolve symbol: \`find_symbol\` action=declaration query=${term}`,
    );
    lines.push(
      `- Find callers: \`find_symbol\` action=references query=${term}`,
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
        `- Resolve symbol: \`find_symbol\` action=declaration query=${topSymbol}`,
      );
      lines.push(
        `- Find callers: \`find_symbol\` action=references query=${topSymbol}`,
      );
    }
  }

  return lines;
}

// ── Markdown rendering ───────────────────────────────────────────────────────

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

  // ── Exact Matches ─────────────────────────────────────────────────────
  if (exactMatches.length > 0) {
    lines.push("## 🎯 Exact Matches (Code)", "");
    for (const match of exactMatches) {
      lines.push(...formatMatch(match), "");
    }
  }

  // ── Related Matches (Semantic) ───────────────────────────────────────
  if (semanticOnlyMatches.length > 0) {
    lines.push("## 📄 Related Matches (Semantic)", "");
    for (const match of semanticOnlyMatches) {
      lines.push(...formatMatch(match), "");
    }
  } else if (details.matches.length === 0) {
    lines.push("No matches found.", "");
  }

  // ── Query Coverage ────────────────────────────────────────────────────
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

  // ── Relationships ─────────────────────────────────────────────────────
  const relationshipMatches = details.matches.filter((m) => m.callers && m.callers.length > 0);
  if (relationshipMatches.length > 0) {
    lines.push("## 🔗 Relationships", "");
    for (const match of relationshipMatches) {
      const callers = match.callers!.slice(0, 5).map((c) => `${c.name} in ${c.file}`).join(", ");
      lines.push(`- **${match.name}** called by ${callers}`);
    }
    lines.push("");
  }

  // ── Summary ──────────────────────────────────────────────────────────
  lines.push("## 📊 Summary", "");
  lines.push(`- Channels: ${details.channelsUsed.length > 0 ? details.channelsUsed.join(", ") : "none"}`);
  lines.push(`- Files inspected: ${details.filesInspected}`);
  if (details.rerankRequested) lines.push("- Rerank: requested, reserved for configured V2 rerankers");
  if (details.degraded.length > 0) {
    lines.push(`- Degraded: ${details.degraded.join("; ")}`);
  }
  lines.push("");

  // ── Follow-ups (query-aware) ───────────────────────────────────────────
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
      lines.push(`- Resolve symbol: \`find_symbol\` action=declaration query=${topSymbol}`);
      lines.push(`- Find callers: \`find_symbol\` action=references query=${topSymbol}`);
    }
  }

  return truncate(lines.join("\n"), maxOutputChars);
}

// ── Escalation helpers ───────────────────────────────────────────────────────

const TEST_PATH_RE = /(^|\/|\\)(test|tests|__tests__|spec)(\/|$|\\)/;

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
  lines.push("   - `find_symbol action=symbol query=term` → find symbol definitions");
  lines.push("   - `search mode=code query=term` → AST-aware code search");
  lines.push("   - `find_symbol action=declaration query=name` → resolve symbol");
  lines.push("");

  return lines.join("\n");
}

// ── Public types conversion ─────────────────────────────────────────────────

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

// ── Fusion ──────────────────────────────────────────────────────────────────

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

// ── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Execute deep search — internal function called by search-tool.ts.
 * Orchestrates structural code search, symbol search, LSP workspace symbol search,
 * optional intent_read semantic ranking, graph expansion, RRF fusion, provenance,
 * and follow-up suggestions.
 */
export async function executeDeepSearch(
  params: DeepSearchParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
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

  const discoveredFiles = await discoverCandidateFiles(cwd, scope, signal);
  const candidatePathFilter = new Set(discoveredFiles.map((path) => toRelativePath(cwd, path)));
  const maxChannelResults = Math.min(100, Math.max(limit * 3, limit));

  const channelResults: DeepSearchCandidate[] = [];

  // Phase 1: code + symbol in parallel (they share no state)
  const phase1Promise = (async () => {
    if (scope !== "docs") {
      const results = await Promise.allSettled([
        runSearchChannel(query, cwd, "code", maxChannelResults, signal, ctx),
        runSymbolChannel(query, cwd, maxChannelResults, signal, ctx),
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
    await enrichRelationships(matches, signal, discoveredFiles);
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
    rerankRequested: false,
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
    rendered = truncate(rendered, outputBudget);
  }

  return {
    content: [{ type: "text" as const, text: rendered }],
    details: toPublicDeepSearchDetails(details) as unknown as Record<string, unknown>,
  };
}