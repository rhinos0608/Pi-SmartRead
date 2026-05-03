/**
 * Structural reranker for Pi-SmartRead.
 *
 * Reorders RRF-ranked candidates using cheap local signals:
 * graph distance, PageRank, path proximity, probe confidence.
 *
 * Phase 5 of the advanced retrieval plan.
 * See docs/advanced-retrieval-implementation-plan.md
 */

export interface RerankerInput {
  path: string;
  rrfScore: number;
  keywordScore: number;
  semanticScore?: number;
  graphDistance?: number;
  importDepth?: number;
  pageRank?: number;
  pathProximity?: number;
  probeConfidence?: number;
  temporalScore?: number; // Git co-commit correlation
}

export interface RerankerResult {
  path: string;
  rerankScore: number;
  originalRank: number;
  newRank: number;
  changed: boolean;
  signals: {
    rrfWeight: number;
    structuralWeight: number;
    proximityWeight: number;
  };
}

export interface RerankerOptions {
  /** Only rerank top N candidates (default: all, capped at 20). */
  maxCandidates?: number;
  /** Weight for RRF score in final ranking (default: 0.6). */
  rrfWeight?: number;
  /** Weight for structural/context signals (default: 0.3). */
  structuralWeight?: number;
  /** Weight for path proximity (default: 0.1). */
  proximityWeight?: number;
}

// ── External reranker (Phase 6) ───────────────────────────────────

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

    // Format 1: Cohere-style { results: [{ index, relevance_score }] }
    if (Array.isArray(data.results)) {
      const results = data.results as Array<{ index?: number; relevance_score?: number }>;
      const sorted = results
        .map((r, i) => ({ index: r.index ?? i, score: r.relevance_score ?? 0 }))
        .sort((a, b) => b.score - a.score);
      return {
        rankedIndices: sorted.map((r) => r.index),
        scores: sorted.map((r) => r.score),
        success: true,
      };
    }

    // Format 2: Generic { ranked_indices: [...] }
    if (Array.isArray(data.ranked_indices)) {
      return {
        rankedIndices: data.ranked_indices as number[],
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

const DEFAULT_OPTIONS: Required<RerankerOptions> = {
  maxCandidates: 20,
  rrfWeight: 0.6,
  structuralWeight: 0.3,
  proximityWeight: 0.1,
};

function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

function computeStructuralScore(input: RerankerInput): number {
  let score = 0;
  let signals = 0;

  if (input.graphDistance !== undefined && input.graphDistance >= 0) {
    score += Math.max(0, 1 - input.graphDistance / 10);
    signals++;
  }
  if (input.importDepth !== undefined && input.importDepth >= 0) {
    score += Math.max(0, 1 - input.importDepth / 5);
    signals++;
  }
  if (input.pageRank !== undefined && input.pageRank > 0) {
    score += Math.min(1, input.pageRank * 10);
    signals++;
  }
  if (input.probeConfidence !== undefined && input.probeConfidence > 0) {
    score += input.probeConfidence;
    signals++;
  }
  if (input.temporalScore !== undefined && input.temporalScore > 0) {
    score += input.temporalScore; // 0.0 to 1.0 correlation
    signals++;
  }

  return signals > 0 ? score / signals : 0;
}

/**
 * Rerank candidates using structural signals.
 * Preserves original order if reranking produces no change.
 */
export function rerank(
  candidates: RerankerInput[],
  options?: RerankerOptions,
): RerankerResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { rrfWeight, structuralWeight, proximityWeight } = opts;

  if (candidates.length === 0) return [];

  const slice = candidates.slice(0, opts.maxCandidates);
  const rest = candidates.slice(opts.maxCandidates);

  // Compute structural scores
  const structuralScores = slice.map(computeStructuralScore);

  // Path proximity scores
  const pathScores = slice.map((c) => c.pathProximity ?? 0);
  const normalizedPath = normalize(pathScores!);

  // RRF scores
  const rrfScores = slice.map((c) => c.rrfScore!);
  const normalizedRrf = normalize(rrfScores);

  // Structural scores
  const normalizedStructural = normalize(structuralScores!);

  // Composite score
  const composite = slice.map((c, i) => ({
    path: c.path,
    score:
      rrfWeight * normalizedRrf[i]! +
      structuralWeight * normalizedStructural[i]! +
      proximityWeight * normalizedPath[i]!,
    originalIndex: i,
  }));

  // Sort by composite score descending
  composite.sort((a, b) => {
    const d = b.score - a.score;
    if (d !== 0) return d;
    return a.originalIndex - b.originalIndex;
  });

  // Build results
  const newOrder = new Map(composite.map((c, i) => [c.originalIndex, i]));
  const results: RerankerResult[] = slice.map((c, i) => {
    const newRank = newOrder.get(i) ?? i;
    return {
      path: c.path,
      rerankScore: composite.find((r) => r.originalIndex === i)?.score ?? c.rrfScore,
      originalRank: i,
      newRank,
      changed: newRank !== i,
      signals: { rrfWeight, structuralWeight, proximityWeight },
    };
  });

  return [
    ...results,
    ...rest.map((c, i) => ({
      path: c.path,
      rerankScore: c.rrfScore,
      originalRank: slice.length + i,
      newRank: slice.length + i,
      changed: false,
      signals: { rrfWeight, structuralWeight, proximityWeight },
    })),
  ];
}
