/**
 * Semantic relevance ranking channel.
 *
 * Scores file entries against a query string using BM25 (TF-IDF variant)
 * applied to content snippets. Deterministic, bounded at 500 candidates,
 * and produces honest `unavailable` when the corpus is empty.
 *
 * Phase 1: no external index required — BM25 is computed over the
 * supplied snippet text directly.
 */

import { compileBm25Corpus } from "../scoring.js";

// ── Channel contract ─────────────────────────────────────────────────

export interface ChannelCandidate {
  file: string;
  line?: number;
  endLine?: number;
  name: string;
  kind: string;
  snippet: string;
  rawScore: number;
}

export interface ChannelResult {
  channel: string;
  candidates: ChannelCandidate[];
  unavailable?: { reason: string };
  metadata?: Record<string, unknown>;
}

// ── Types ────────────────────────────────────────────────────────────

/** A file entry from the snapshot to be scored. */
export interface SemanticEntry {
  file: string;
  line?: number;
  endLine?: number;
  name: string;
  kind: string;
  /** Text content used for BM25 scoring. */
  snippet: string;
}

export interface SemanticChannelOptions {
  /** Hard cap on returned candidates (default 500). */
  maxCandidates?: number;
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_CANDIDATES = 500;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Rank `entries` by BM25 similarity of their snippets to `query`.
 *
 * Deterministic: identical inputs always produce identical outputs.
 * Returns `unavailable` when `entries` is empty or every snippet is blank.
 */
export function rankSemantic(
  query: string,
  entries: SemanticEntry[],
  options: SemanticChannelOptions = {},
): ChannelResult {
  const { maxCandidates = MAX_CANDIDATES } = options;

  if (entries.length === 0 || query.trim().length === 0) {
    return {
      channel: "semantic",
      candidates: [],
      unavailable: { reason: entries.length === 0 ? "no entries provided" : "empty query" },
    };
  }

  // Skip entries with completely empty snippets — they cannot contribute
  // to BM25 scoring and would just add noise to the corpus statistics.
  const usable = entries.filter((e) => e.snippet.trim().length > 0);

  if (usable.length === 0) {
    return {
      channel: "semantic",
      candidates: [],
      unavailable: { reason: "all snippets empty" },
    };
  }

  const snippets = usable.map((e) => e.snippet);
  const corpus = compileBm25Corpus(snippets);
  const scores = corpus.score(query);

  // Pair scores with entries, sort by score descending then by file for
  // deterministic tie-breaking.
  const ranked = usable
    .map((entry, i) => ({ entry, score: scores[i]! }))
    .sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file));

  const candidates: ChannelCandidate[] = ranked.slice(0, maxCandidates).map(({ entry, score }) => ({
    file: entry.file,
    line: entry.line,
    endLine: entry.endLine,
    name: entry.name,
    kind: entry.kind,
    snippet: entry.snippet,
    rawScore: score,
  }));

  return {
    channel: "semantic",
    candidates,
    metadata: {
      corpusSize: usable.length,
      totalEntries: entries.length,
      avgDocLen: corpus.avgDocLen,
    },
  };
}
