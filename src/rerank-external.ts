/**
 * External reranker (Phase 6): Cohere/Jina-compatible API client
 * plus a strategy fn that falls back to the structural reranker.
 */
import {
  DEFAULT_OPTIONS,
  rerank,
  type RerankerInput,
  type RerankerOptions,
  type RerankerResult,
} from "./rerank-structural.js";

export interface ExternalRerankerRequest {
  /** The search query. */
  query: string;
  /** Document texts to rerank. */
  documents: string[];
  /** API base URL (e.g., "https://api.cohere.com/v1"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey?: string;
  /** Model name (provider-specific). */
  model?: string;
  /** Max documents per request. */
  maxDocuments?: number;
  /** Request timeout in ms. */
  timeoutMs?: number;
}

export interface ExternalRerankerResponse {
  /** Reranked indices (0-based into the original documents array), best first. */
  rankedIndices: number[];
  /** Relevance scores aligned with rankedIndices (optional, may be empty). */
  scores: number[];
  /** Whether the external API was called successfully. */
  success: boolean;
  /** Error message if the call failed. */
  error?: string;
}

/**
 * Call an external reranker API (Cohere/Jina-compatible format).
 *
 * Supports two response formats:
 * 1. Cohere-style: { results: [{ index, relevance_score }] }
 * 2. Generic: { ranked_indices: [2, 0, 1] } or { scores: [0.3, 0.9, 0.6] }
 *
 * Falls back gracefully on network/API errors.
 */
export async function externalRerank(
  request: ExternalRerankerRequest,
): Promise<ExternalRerankerResponse> {
  const url = request.baseUrl.replace(/\/+$/, "") + "/rerank";
  const timeoutMs = request.timeoutMs ?? 10_000;

  const body: Record<string, unknown> = {
    query: request.query,
    documents: request.documents,
  };
  if (request.model) body.model = request.model;
  if (request.maxDocuments) body.top_n = request.maxDocuments;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (request.apiKey) {
    headers["Authorization"] = `Bearer ${request.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        rankedIndices: [],
        scores: [],
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json() as Record<string, unknown>;
    const docCount = request.documents.length;
    const isValidIndex = (v: unknown): v is number =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v < docCount;
    const dedupeIndices = (indices: number[]): number[] => {
      const seen = new Set<number>();
      return indices.filter((i) => {
        if (!isValidIndex(i) || seen.has(i)) return false;
        seen.add(i);
        return true;
      });
    };

    // Format 1: Cohere-style { results: [{ index, relevance_score }] }
    if (Array.isArray(data.results)) {
      const results = data.results as Array<{ index?: number; relevance_score?: number }>;
      const sorted = results
        .map((r, i) => ({ index: r.index ?? i, score: r.relevance_score ?? 0 }))
        .sort((a, b) => b.score - a.score);
      const seen = new Set<number>();
      const kept = sorted.filter((r) => {
        if (!isValidIndex(r.index) || seen.has(r.index)) return false;
        seen.add(r.index);
        return true;
      });
      return {
        rankedIndices: kept.map((r) => r.index),
        scores: kept.map((r) => r.score),
        success: true,
      };
    }

    // Format 2: Generic { ranked_indices: [...] }
    if (Array.isArray(data.ranked_indices)) {
      return {
        rankedIndices: dedupeIndices(data.ranked_indices as number[]),
        scores: [],
        success: true,
      };
    }

    // Format 3: Generic { scores: [...] } — sort by descending score
    if (Array.isArray(data.scores)) {
      const scores = data.scores as number[];
      const order = scores
        .map((s, i) => ({ score: s, index: i }))
        .sort((a, b) => b.score - a.score);
      return {
        rankedIndices: order.map((o) => o.index),
        scores: order.map((o) => o.score),
        success: true,
      };
    }

    return {
      rankedIndices: [],
      scores: [],
      success: false,
      error: "Unrecognized response format from reranker API",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rankedIndices: [],
      scores: [],
      success: false,
      error: msg,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Reorder RerankerInput candidates using an external reranker API.
 * Returns RerankerResult[] in the same format as the structural rerank().
 * Falls back to structural reranking if the external call fails.
 */
export async function rerankWithExternal(
  candidates: RerankerInput[],
  query: string,
  documentTexts: string[],
  request: Omit<ExternalRerankerRequest, "query" | "documents">,
  options?: RerankerOptions,
): Promise<{ results: RerankerResult[]; externalUsed: boolean; externalError?: string }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const slice = candidates.slice(0, opts.maxCandidates);

  const extResult = await externalRerank({
    query,
    documents: documentTexts.slice(0, opts.maxCandidates),
    ...request,
  });

  if (!extResult.success || extResult.rankedIndices.length === 0) {
    // Fallback to structural reranking
    return {
      results: rerank(candidates, options),
      externalUsed: false,
      externalError: extResult.error,
    };
  }

  // Map external ranking back to RerankerResult format
  const rest = candidates.slice(opts.maxCandidates);
  const indexToOriginal = new Map(extResult.rankedIndices.map((idx, rank) => [idx, rank]));

  const results: RerankerResult[] = [
    ...slice.map((c, i) => {
      const newRank = indexToOriginal.get(i) ?? i;
      const extScore = extResult.scores[extResult.rankedIndices.indexOf(i)] ?? c.rrfScore;
      return {
        path: c.path,
        rerankScore: extScore,
        originalRank: i,
        newRank,
        changed: newRank !== i,
        signals: { rrfWeight: 0, structuralWeight: 1, proximityWeight: 0 },
      };
    }),
    ...rest.map((c, i) => ({
      path: c.path,
      rerankScore: c.rrfScore,
      originalRank: slice.length + i,
      newRank: slice.length + i,
      changed: false,
      signals: { rrfWeight: 0, structuralWeight: 1, proximityWeight: 0 },
    })),
  ];

  return { results, externalUsed: true };
}
