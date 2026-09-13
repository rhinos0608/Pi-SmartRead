// deep-search-semantic.ts
// BM25 + embedding re-rank, intent-read integration, matched term extraction

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createIntentReadTool } from "../read/intent-read.js";
import { bm25Scores } from "../scoring.js";
import { scorePathByQuery } from "./resolver.js";
import {
  type RelevanceClass,
  relevanceClassWeight,
} from "../ranking/classifiers.js";
import { tokenize } from "../scoring.js";

import type { DeepSearchCandidate } from "./deep-search.js";

// ── Semantic channel ────────────────────────────────────────────────────────

export const FILLER_WORDS = new Set([
  "the", "this", "that", "these", "those", "with", "from", "file", "code",
  "what", "where", "how", "which", "find", "show", "get", "set", "list",
  "all", "any", "has", "not", "and", "for", "are", "its", "into",
]);

/**
 * Extract code-identifier-like terms from a user query.
 * Uses tokenize() for camelCase/PascalCase/snake_case splitting,
 * then filters out common filler words and short tokens.
 */
export function extractQueryTerms(query: string): string[] {
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

function toRelativePath(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path));
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : path.replace(/\\/g, "/");
}

/** Max files the semantic channel feeds to embeddings (intent-read cap is 500). */
export const MAX_SEMANTIC_PRESELECT = 100;
/** Per-file bytes read during BM25 preselect; keeps a 2,000-file scan bounded. */
const PRESELECT_MAX_FILE_BYTES = 128 * 1024;

export type SemanticChannelStrategy = "persistent-index" | "bm25-preselect";

export interface SemanticChannelResult {
  candidates: DeepSearchCandidate[];
  /** Files embeddings actually ranked (intent-read input count, or index hits mapped). */
  inspected: number;
  /** Files the preselect scanned before narrowing (== files.length for preselect). */
  scanned: number;
  strategy: SemanticChannelStrategy;
}

function defaultReadBody(path: string): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) return "";
    // Bounded prefix read: never pull a whole multi-MB file into memory
    // to score a 128KB prefix.
    if (stat.size <= PRESELECT_MAX_FILE_BYTES) return readFileSync(path, "utf-8");
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(PRESELECT_MAX_FILE_BYTES + 1);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf-8");
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
}

/**
 * Narrow the full discovered corpus to the embedding budget using cheap signals
 * over ALL files: content BM25 first, path-token overlap as tiebreak/fallback.
 * Pure ordering — no file is excluded by alphabetical position.
 */
export function preselectSemanticFiles(
  files: string[],
  query: string,
  limit: number,
  readBody: (path: string) => string | null = defaultReadBody,
): string[] {
  const count = Math.min(MAX_SEMANTIC_PRESELECT, Math.max(limit * 2, limit));
  if (files.length <= count) return files;
  const bodies = files.map((file) => readBody(file) ?? "");
  const bm25 = bm25Scores(query, bodies);
  const pathScores = files.map((file) => scorePathByQuery(file, query));
  const order = files.map((file, i) => ({
    file,
    index: i,
    bm25: bm25[i] ?? 0,
    pathScore: pathScores[i] ?? 0,
  }));
  order.sort((a, b) => b.bm25 - a.bm25 || b.pathScore - a.pathScore || a.index - b.index);
  return order.slice(0, count).map((entry) => entry.file);
}

/**
 * Async variant used by the production channel: identical BM25 + path-score
 * ordering, but bodies are read in bounded batches with event-loop yields so
 * parallel phases and abort handling progress instead of one sync block
 * retaining the whole discovery set. Throws on abort.
 */
export async function preselectSemanticFilesAsync(
  files: string[],
  query: string,
  limit: number,
  readBody: (path: string) => string | null = defaultReadBody,
  signal?: AbortSignal,
): Promise<string[]> {
  const count = Math.min(MAX_SEMANTIC_PRESELECT, Math.max(limit * 2, limit));
  if (files.length <= count) return files;
  // Cheap path-token signals first (no IO) so the expensive content stage
  // has its tiebreak inputs ready before any file is touched.
  const pathScores = files.map((file) => scorePathByQuery(file, query));
  const bodies: string[] = new Array(files.length);
  const BATCH = 32;
  for (let start = 0; start < files.length; start += BATCH) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const end = Math.min(start + BATCH, files.length);
    for (let i = start; i < end; i++) bodies[i] = readBody(files[i]!) ?? "";
    // Yield so parallel channel phases and abort listeners run.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const bm25 = bm25Scores(query, bodies);
  const order = files.map((file, i) => ({
    file,
    index: i,
    bm25: bm25[i] ?? 0,
    pathScore: pathScores[i] ?? 0,
  }));
  order.sort((a, b) => b.bm25 - a.bm25 || b.pathScore - a.pathScore || a.index - b.index);
  return order.slice(0, count).map((entry) => entry.file);
}

/**
 * Query the persistent semantic index when one is registered and ready.
 * Returns null when no usable index exists so the caller falls back to preselect.
 */
async function tryPersistentIndex(
  query: string,
  cwd: string,
  files: string[],
  count: number,
): Promise<DeepSearchCandidate[] | null> {
  try {
    const { getSemanticIndex } = await import("../indexing/semantic-index-registry.js");
    const index = getSemanticIndex(cwd);
    if (!index?.isAvailable()) return null;
    // Filter-before-limit: the index ranks its whole corpus, so requesting only
    // `count` rows then dropping out-of-scope hits starves in-scope results.
    // Over-fetch up to the index cap and filter to the discovered set first,
    // then apply the count limit. Callers keep BM25 fallback when null.
    const results = await index.search(query, { topK: 100 });
    if (results.length === 0) return null;
    const discovered = new Set(files.map((file) => toRelativePath(cwd, file)));
    const candidates: DeepSearchCandidate[] = [];
    for (const result of results) {
      if (candidates.length >= count) break;
      const rel = toRelativePath(cwd, resolve(index.root, result.filePath));
      if (!discovered.has(rel)) continue;
      candidates.push({
        file: rel,
        kind: "file",
        name: rel.split("/").pop() ?? rel,
        rawScore: result.score,
        rank: candidates.length + 1,
        snippet: result.codeSnippet,
        channel: "semantic",
      });
    }
    return candidates.length > 0 ? candidates : null;
  } catch {
    return null;
  }
}

/**
 * Run the semantic channel using the intent-read engine for embedding-based ranking.
 * Candidates are preselected by relevance over the full corpus — never by
 * alphabetical position — or served repo-wide from the persistent semantic index.
 */
export async function runSemanticChannel(
  query: string,
  cwd: string,
  files: string[],
  limit: number,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<SemanticChannelResult> {
  const count = Math.min(MAX_SEMANTIC_PRESELECT, Math.max(limit * 2, limit));
  const indexed = await tryPersistentIndex(query, cwd, files, count);
  if (indexed) {
    // Coverage honesty: the vector store scanned its whole corpus, but only
    // these hits feed fusion. Report hits as inspected, corpus as scanned.
    return { candidates: indexed, inspected: indexed.length, scanned: files.length, strategy: "persistent-index" };
  }
  if (signal?.aborted) throw new Error("Operation aborted");
  const intentReadTool = createIntentReadTool();
  const rankedFiles = await preselectSemanticFilesAsync(files, query, limit, defaultReadBody, signal);
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
  return {
    candidates: parseSemanticCandidates(cwd, result),
    inspected: rankedFiles.length,
    scanned: files.length,
    strategy: "bm25-preselect",
  };
}

/**
 * Enrich semantic provenance entries with which query terms matched.
 * For each match, tokenizes name+snippet and checks which query terms appear.
 * This gives agents a "why this matched" signal.
 */
export function enrichMatchProvenance(
  matches: Array<{
    name: string;
    snippet: string;
    provenance: Array<{ channel: string; matchedTerms?: string[] }>;
  }>,
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