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

// ── ColBERT-style late-interaction reranker ────────────────────────

export interface ColbertRerankerInput extends RerankerInput {
  /** The full document text for segmentation and embedding. */
  body: string;
}

export interface ColbertRerankerOptions extends RerankerOptions {
  /**
   * Weight for the ColBERT MaxSim score in the blended final score.
   * RRF receives (1 - colbertWeight). Default: 0.7.
   */
  colbertWeight?: number;
  /** Max segments per document (default: 8). */
  maxSegments?: number;
  /** Target char size per segment (default: 512). */
  segmentSize?: number;
  /** Top K candidates after Stage-1 pooled cosine filter (default: 10). */
  pooledFilterTopK?: number;
}

export interface ColbertRerankerResult extends RerankerResult {
  /** The ColBERT MaxSim score (late-interaction relevance). */
  colbertScore: number;
  /** The MaxSim component before blending. */
  maxSimScore: number;
  /** The Stage-1 pooled cosine similarity score. */
  pooledCosScore: number;
}

const COLBERT_DEFAULTS: Required<Pick<ColbertRerankerOptions, "colbertWeight" | "maxSegments" | "segmentSize" | "pooledFilterTopK">> = {
  colbertWeight: 0.7,
  maxSegments: 8,
  segmentSize: 512,
  pooledFilterTopK: 10,
};

/**
 * Split text into sentence-aware segments.
 * First splits on sentence boundaries (. ! ?), then merges short
 * sentences up to `segmentSize` chars, capped at `maxSegments`.
 */
export function segmentText(
  text: string,
  segmentSize: number,
  maxSegments: number,
): string[] {
  if (!text) return [];

  // Split on sentence boundaries (period, exclamation, question mark
  // followed by whitespace or end-of-string).
  const sentences = text.split(/(?<=[.!?])(?:\s+|$)/).filter(Boolean);
  const segments: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length > segmentSize && current.length > 0) {
      segments.push(current);
      current = trimmed;
    } else {
      current = current ? `${current} ${trimmed}` : trimmed;
    }

    if (segments.length >= maxSegments) break;
  }

  if (current && segments.length < maxSegments) {
    segments.push(current);
  }

  return segments.length > 0 ? segments.slice(0, maxSegments) : [text.slice(0, segmentSize)];
}

/**
 * L2-normalised cosine similarity between two vectors.
 * Vectors are assumed pre-normalised (dot product === cosine sim).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const aVal = a[i]!;
    const bVal = b[i]!;
    dot += aVal * bVal;
    magA += aVal * aVal;
    magB += bVal * bVal;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Mean-pool a list of vectors into a single vector. */
export function meanPool(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const pooled = new Array(dim).fill(0);
  for (let i = 0; i < vectors.length; i++) {
    const vec = vectors[i]!;
    for (let j = 0; j < dim; j++) {
      pooled[j] += vec[j];
    }
  }
  const n = vectors.length;
  for (let j = 0; j < dim; j++) {
    pooled[j] /= n;
  }
  return pooled;
}

/**
 * ColBERT-style MaxSim scoring.
 * For each query token vector, find the maximum dot product against
 * any document token vector. Sum and normalise by query-token count.
 *
 * When vectors are L2-normalised, dot product === cosine similarity.
 */
export function computeMaxSim(
  queryVectors: number[][],
  docVectors: number[][],
): number {
  if (queryVectors.length === 0 || docVectors.length === 0) return 0;

  let totalMaxDot = 0;
  for (let qi = 0; qi < queryVectors.length; qi++) {
    const qv = queryVectors[qi]!;
    let maxDot = -Infinity;
    for (let di = 0; di < docVectors.length; di++) {
      const dv = docVectors[di]!;
      const dim = Math.min(qv.length, dv.length);
      let dot = 0;
      for (let k = 0; k < dim; k++) {
        dot += qv[k]! * dv[k]!;
      }
      if (dot > maxDot) maxDot = dot;
    }
    totalMaxDot += maxDot;
  }

  return totalMaxDot / queryVectors.length;
}

/**
 * ColBERT-style late-interaction reranker ("poor man's ColBERT").
 *
 * Two-stage pipeline:
 *   Stage 1 (cheap): embed each candidate's full body text, compute
 *     pooled cosine similarity vs query embedding, keep top K.
 *   Stage 2 (expensive): segment query and top-K candidates, embed
 *     each segment, compute full MaxSim (maximum dot product per
 *     query segment summed across all query segments), blend with RRF.
 *
 * Falls back to structural reranker when local embedding is unavailable.
 */
export async function colbertRerank(
  query: string,
  candidates: ColbertRerankerInput[],
  queryEmbedding: number[],
  options?: ColbertRerankerOptions,
): Promise<{
  results: ColbertRerankerResult[];
  usedColbert: boolean;
  error?: string;
}> {
  if (candidates.length === 0) {
    return { results: [], usedColbert: false, error: "no candidates" };
  }

  const opts = {
    ...COLBERT_DEFAULTS,
    ...options,
    // Always cap maxCandidates (default 20 to match structural reranker)
    maxCandidates: options?.maxCandidates ?? Math.min(candidates.length, 20),
  };

  // Try to import local embedding lazily — if unavailable, fall back
  let fetchLocal: typeof import("./embedding.js").fetchLocalEmbeddings | null = null;
  try {
    const mod = await import("./embedding.js");
    fetchLocal = mod.fetchLocalEmbeddings;
    // Quick availability check — if the optional dep is missing,
    // calling fetchLocalEmbeddings will throw, so we verify.
    const { isLocalEmbeddingAvailable } = await import("./local-embedding-provider.js");
    const available = await isLocalEmbeddingAvailable();
    if (!available) {
      fetchLocal = null;
    }
  } catch {
    fetchLocal = null;
  }

  if (!fetchLocal) {
    // Fall back to structural reranker
    const fallback = rerank(candidates, options);
    return {
      results: fallback.map((r) => ({
        ...r,
        colbertScore: 0,
        maxSimScore: 0,
        pooledCosScore: 0,
      })),
      usedColbert: false,
      error: "local embedding unavailable, fell back to structural reranker",
    };
  }

  const slice = candidates.slice(0, opts.maxCandidates);
  const rest = candidates.slice(opts.maxCandidates);

  try {
    // ── Stage 1: Pooled cosine similarity filter ──────────────────

    // Embed each candidate's full body text as one vector
    const bodyEmbedResult = await fetchLocal({
      inputs: slice.map((c) => c.body || ""),
    });
    const bodyVectors = bodyEmbedResult.vectors;

    // Compute pooled cosine similarity against query embedding
    const pooledCosScores = bodyVectors.map((vec) =>
      cosineSimilarity(queryEmbedding, vec),
    );

    // Pair each candidate with its pooled score and sort descending
    // originalIndex tiebreaker ensures stable ordering when scores tie.
    const scored = slice.map((c, i) => ({
      candidate: c,
      index: i,
      pooledCosScore: pooledCosScores[i]!,
      rrfScore: c.rrfScore,
    }));
    scored.sort(
      (a, b) => b.pooledCosScore - a.pooledCosScore || a.index - b.index,
    );

    // Keep top K candidates for full MaxSim
    const topKCount = Math.min(
      opts.pooledFilterTopK ?? COLBERT_DEFAULTS.pooledFilterTopK,
      scored.length,
    );
    const topKCandidates = scored.slice(0, topKCount);

    // ── Stage 2: Full MaxSim on top K candidates ──────────────────

    // Segment the query
    const querySegments = segmentText(query, opts.segmentSize ?? COLBERT_DEFAULTS.segmentSize, opts.maxSegments ?? COLBERT_DEFAULTS.maxSegments);

    // Embed query segments
    let querySegmentVectors: number[][] = [];
    if (querySegments.length > 0 && querySegments[0]) {
      const qr = await fetchLocal({ inputs: querySegments });
      querySegmentVectors = qr.vectors;
    }

    // If query produced no segment vectors, fall back to structural
    if (querySegmentVectors.length === 0) {
      const fallback = rerank(candidates, options);
      return {
        results: fallback.map((r) => ({
          ...r,
          colbertScore: 0,
          maxSimScore: 0,
          pooledCosScore: 0,
        })),
        usedColbert: false,
        error: "query produced no segment vectors",
      };
    }

    // Segment and embed top-K candidate bodies, batched
    const topKWithSegments: Array<{
      originalIndex: number;
      segments: string[];
      segmentStart: number;
    }> = [];
    const allSegments: string[] = [];

    for (const scored of topKCandidates) {
      const segs = segmentText(
        scored.candidate.body || "",
        opts.segmentSize ?? COLBERT_DEFAULTS.segmentSize,
        opts.maxSegments ?? COLBERT_DEFAULTS.maxSegments,
      );
      topKWithSegments.push({
        originalIndex: scored.index,
        segments: segs,
        segmentStart: allSegments.length,
      });
      allSegments.push(...segs);
    }

    // Batch-embed all segments from all top-K candidates in one call
    let allSegmentVectors: number[][] = [];
    if (allSegments.length > 0) {
      const sr = await fetchLocal({ inputs: allSegments });
      allSegmentVectors = sr.vectors;
    }

    // Compute MaxSim for each top-K candidate
    const topKResults = topKWithSegments.map((entry) => {
      const docVectors = allSegmentVectors.slice(
        entry.segmentStart,
        entry.segmentStart + entry.segments.length,
      );
      const maxSimScore =
        docVectors.length > 0
          ? computeMaxSim(querySegmentVectors, docVectors)
          : 0;
      const candidate = topKCandidates.find(
        (sc) => sc.index === entry.originalIndex,
      )!;
      return {
        candidate,
        maxSimScore,
      };
    });

    // ── Blend scores ──────────────────────────────────────────

    const colbertW = opts.colbertWeight ?? COLBERT_DEFAULTS.colbertWeight;
    const rrfW = 1 - colbertW;

    // Normalise RRF scores among the top-K candidates
    const topKRRFScores = topKCandidates.map((sc) => sc.rrfScore);
    const normalizedTopKRRF = normalize(topKRRFScores);

    // F-5: Normalise MaxSim scores among the top-K candidates so colbertWeight
    // behaves as a true fraction. Without this, MaxSim is on a different scale
    // than the normalised RRF score and colbertWeight does not mean what it says.
    const topKMaxSims = topKResults.map((r) => r.maxSimScore);
    const normalizedTopKMaxSims = normalize(topKMaxSims);

    // Build composite results for top K
    const blendedTopK = topKResults.map((r, i) => {
      const maxSimScore = r.maxSimScore;
      const pooledCosScore = r.candidate.pooledCosScore;
      const colbertScore =
        colbertW * (normalizedTopKMaxSims[i] ?? 0) +
        rrfW * (normalizedTopKRRF[i] ?? 0.5);
      return {
        path: r.candidate.candidate.path,
        rerankScore: colbertScore,
        originalRank: r.candidate.index,
        newRank: 0,
        // F-2: changed flag is recomputed after sorting below; placeholder here.
        changed: false,
        signals: {
          rrfWeight: rrfW,
          structuralWeight: 0,
          proximityWeight: 0,
        },
        colbertScore,
        maxSimScore,
        pooledCosScore,
      };
    });

    // Sort top K by blended score descending (stable on originalRank)
    blendedTopK.sort(
      (a, b) => b.rerankScore - a.rerankScore || a.originalRank - b.originalRank,
    );
    blendedTopK.forEach((r, i) => {
      r.newRank = i;
      // F-2: derived from rank comparison, not hardcoded true.
      r.changed = r.newRank !== r.originalRank;
    });

    // Map top-K results back, handle non-top-K candidates
    const topKFinalIndices = new Set(
      topKCandidates.map((sc) => sc.index),
    );

    // Candidates beyond top-K (within slice) get sequential ranks by pooled-cos
    // order (their slice index preserves their position in the input order,
    // which matches the pooled-cosine sort from F-13). F-6: their rerankScore
    // is normalised pooled-cosine so it lives on the same [0,1] scale as the
    // blended top-K scores.
    const nonTopKScores = slice
      .map((_c, i) => (!topKFinalIndices.has(i) ? pooledCosScores[i] ?? 0 : null))
      .filter((s): s is number => s !== null);
    const normalizedNonTopK = normalize(nonTopKScores);
    let nonTopKCursor = 0;

    // Candidates beyond maxCandidates: keep original position, sentinel score
    const results: ColbertRerankerResult[] = [
      ...slice.map((c, i) => {
        if (!topKFinalIndices.has(i)) {
          // F-3: sequential ranks instead of shared blendedTopK.length + 0
          const newRank = blendedTopK.length + nonTopKCursor;
          const normalizedScore = normalizedNonTopK[nonTopKCursor] ?? 0;
          nonTopKCursor += 1;
          return {
            path: c.path,
            rerankScore: normalizedScore,
            originalRank: i,
            newRank,
            // F-4: derive changed from rank comparison, not hardcoded false
            changed: newRank !== i,
            signals: {
              rrfWeight: rrfW,
              structuralWeight: 0,
              proximityWeight: 0,
            },
            colbertScore: normalizedScore,
            maxSimScore: 0,
            pooledCosScore: pooledCosScores[i] ?? 0,
          };
        }
        const found = blendedTopK.find((r) => r.originalRank === i);
        return found!;
      }),
      ...rest.map((c, i) => {
        const newRank = slice.length + i;
        return {
          path: c.path,
          rerankScore: 0,
          originalRank: newRank,
          newRank,
          // Rest preserves its position; only flag a change when something
          // would actually displace it (none can with this layout, but use
          // the same derived rule for consistency).
          changed: false,
          signals: {
            rrfWeight: rrfW,
            structuralWeight: 0,
            proximityWeight: 0,
          },
          colbertScore: 0,
          maxSimScore: 0,
          pooledCosScore: 0,
        };
      }),
    ];

    return { results, usedColbert: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fallback = rerank(candidates, options);
    return {
      results: fallback.map((r) => ({
        ...r,
        colbertScore: 0,
        maxSimScore: 0,
        pooledCosScore: 0,
      })),
      usedColbert: false,
      error: msg,
    };
  }
}
