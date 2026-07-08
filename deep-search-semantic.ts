// deep-search-semantic.ts
// BM25 + embedding re-rank, intent-read integration, matched term extraction

import { relative, resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createIntentReadTool } from "./intent-read.js";
import {
  type RelevanceClass,
  relevanceClassWeight,
} from "./classifiers.js";
import { tokenize } from "./scoring.js";

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

/**
 * Run the semantic channel using the intent-read engine for embedding-based ranking.
 */
export async function runSemanticChannel(
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