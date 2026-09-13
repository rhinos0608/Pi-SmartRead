/**
 * ColBERT-style late-interaction reranker ("poor man's ColBERT").
 */
import { cosineSimilarity } from "../scoring.js";
import {
  normalize,
  rerank,
  type RerankerInput,
  type RerankerOptions,
  type RerankerResult,
} from "./rerank-structural.js";

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

type FetchLocalFn = (args: { inputs: string[] }) => Promise<{ vectors: number[][] }>;

interface ResolvedColbertOpts {
  colbertWeight: number;
  maxSegments: number;
  segmentSize: number;
  pooledFilterTopK: number;
  maxCandidates: number;
}

interface ScoredCandidate {
  candidate: ColbertRerankerInput;
  index: number;
  pooledCosScore: number;
  rrfScore: number;
}

interface TopKSegmentEntry {
  originalIndex: number;
  segments: string[];
  segmentStart: number;
}

interface TopKMaxSim {
  candidate: ScoredCandidate;
  maxSimScore: number;
}

function resolveColbertOpts(candidateCount: number, options?: ColbertRerankerOptions): ResolvedColbertOpts {
  return {
    ...COLBERT_DEFAULTS,
    ...options,
    // Always cap maxCandidates (default 20 to match structural reranker)
    maxCandidates: options?.maxCandidates ?? Math.min(candidateCount, 20),
  };
}

function fallbackToStructural(
  candidates: ColbertRerankerInput[],
  options: ColbertRerankerOptions | undefined,
  error: string,
): { results: ColbertRerankerResult[]; usedColbert: boolean; error: string } {
  const fallback = rerank(candidates, options);
  return {
    results: fallback.map((r) => ({
      ...r,
      colbertScore: 0,
      maxSimScore: 0,
      pooledCosScore: 0,
    })),
    usedColbert: false,
    error,
  };
}

async function resolveLocalFetcher(): Promise<FetchLocalFn | null> {
  try {
    const mod = await import("../indexing/embedding.js");
    const fetchLocal: FetchLocalFn = mod.fetchLocalEmbeddings;
    // Quick availability check — if the optional dep is missing,
    // calling fetchLocalEmbeddings will throw, so we verify.
    const { isLocalEmbeddingAvailable } = await import("../indexing/local-embedding-provider.js");
    const available = await isLocalEmbeddingAvailable();
    if (!available) return null;
    return fetchLocal;
  } catch {
    return null;
  }
}

function scoreByPooledCosine(args: {
  slice: ColbertRerankerInput[];
  pooledCosScores: number[];
}): ScoredCandidate[] {
  const scored = args.slice.map((c, i) => ({
    candidate: c,
    index: i,
    pooledCosScore: args.pooledCosScores[i]!,
    rrfScore: c.rrfScore,
  }));
  scored.sort(
    (a, b) => b.pooledCosScore - a.pooledCosScore || a.index - b.index,
  );
  return scored;
}

function pickTopK(args: { scored: ScoredCandidate[]; pooledFilterTopK: number }): ScoredCandidate[] {
  const topKCount = Math.min(args.pooledFilterTopK, args.scored.length);
  return args.scored.slice(0, topKCount);
}

async function embedQuerySegments(args: {
  fetchLocal: FetchLocalFn;
  query: string;
  opts: ResolvedColbertOpts;
}): Promise<number[][]> {
  const querySegments = segmentText(args.query, args.opts.segmentSize, args.opts.maxSegments);
  if (querySegments.length === 0 || !querySegments[0]) return [];
  const qr = await args.fetchLocal({ inputs: querySegments });
  return qr.vectors;
}

function collectTopKSegments(args: {
  topKCandidates: ScoredCandidate[];
  opts: ResolvedColbertOpts;
}): { topKWithSegments: TopKSegmentEntry[]; allSegments: string[] } {
  const topKWithSegments: TopKSegmentEntry[] = [];
  const allSegments: string[] = [];
  for (const item of args.topKCandidates) {
    const segs = segmentText(
      item.candidate.body || "",
      args.opts.segmentSize,
      args.opts.maxSegments,
    );
    topKWithSegments.push({
      originalIndex: item.index,
      segments: segs,
      segmentStart: allSegments.length,
    });
    allSegments.push(...segs);
  }
  return { topKWithSegments, allSegments };
}

function computeTopKMaxSims(args: {
  topKWithSegments: TopKSegmentEntry[];
  allSegmentVectors: number[][];
  querySegmentVectors: number[][];
  topKCandidates: ScoredCandidate[];
}): TopKMaxSim[] {
  return args.topKWithSegments.map((entry) => {
    const docVectors = args.allSegmentVectors.slice(
      entry.segmentStart,
      entry.segmentStart + entry.segments.length,
    );
    const maxSimScore =
      docVectors.length > 0
        ? computeMaxSim(args.querySegmentVectors, docVectors)
        : 0;
    const candidate = args.topKCandidates.find(
      (sc) => sc.index === entry.originalIndex,
    )!;
    return {
      candidate,
      maxSimScore,
    };
  });
}

function blendTopK(args: {
  topKResults: TopKMaxSim[];
  topKCandidates: ScoredCandidate[];
  colbertW: number;
  rrfW: number;
}): ColbertRerankerResult[] {
  // Normalise RRF scores among the top-K candidates
  const topKRRFScores = args.topKCandidates.map((sc) => sc.rrfScore);
  const normalizedTopKRRF = normalize(topKRRFScores);
  // F-5: Normalise MaxSim scores among the top-K candidates so colbertWeight
  // behaves as a true fraction. Without this, MaxSim is on a different scale
  // than the normalised RRF score and colbertWeight does not mean what it says.
  const topKMaxSims = args.topKResults.map((r) => r.maxSimScore);
  const normalizedTopKMaxSims = normalize(topKMaxSims);
  const blendedTopK: ColbertRerankerResult[] = args.topKResults.map((r, i) => {
    const maxSimScore = r.maxSimScore;
    const pooledCosScore = r.candidate.pooledCosScore;
    const colbertScore =
      args.colbertW * (normalizedTopKMaxSims[i] ?? 0) +
      args.rrfW * (normalizedTopKRRF[i] ?? 0.5);
    return {
      path: r.candidate.candidate.path,
      rerankScore: colbertScore,
      originalRank: r.candidate.index,
      newRank: 0,
      // F-2: changed flag is recomputed after sorting below; placeholder here.
      changed: false,
      signals: {
        rrfWeight: args.rrfW,
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
  return blendedTopK;
}

function assembleColbertResults(args: {
  slice: ColbertRerankerInput[];
  rest: ColbertRerankerInput[];
  blendedTopK: ColbertRerankerResult[];
  topKCandidates: ScoredCandidate[];
  pooledCosScores: number[];
  rrfW: number;
}): ColbertRerankerResult[] {
  const topKFinalIndices = new Set(
    args.topKCandidates.map((sc) => sc.index),
  );
  // Candidates beyond top-K (within slice) get sequential ranks by sorted
  // pooled-cosine order (score desc, slice index asc — same comparator as
  // scoreByPooledCosine). F-6: their rerankScore is normalised pooled-cosine
  // so it lives on the same [0,1] scale as the blended top-K scores.
  const nonTopKIndices: number[] = [];
  const nonTopKScores: number[] = [];
  args.slice.forEach((_c, i) => {
    if (!topKFinalIndices.has(i)) {
      nonTopKIndices.push(i);
      nonTopKScores.push(args.pooledCosScores[i] ?? 0);
    }
  });
  const normalizedNonTopK = normalize(nonTopKScores);
  const normByIndex = new Map(nonTopKIndices.map((idx, k) => [idx, normalizedNonTopK[k] ?? 0]));
  // Rank non-top-K by sorted pooled-cosine order (same comparator as
  // scoreByPooledCosine: score desc, slice index asc), not input order.
  const nonTopKOrder = [...nonTopKIndices].sort(
    (a, b) => (args.pooledCosScores[b] ?? 0) - (args.pooledCosScores[a] ?? 0) || a - b,
  );
  const rankByIndex = new Map(nonTopKOrder.map((idx, pos) => [idx, args.blendedTopK.length + pos]));
  // Candidates beyond maxCandidates: keep original position, sentinel score
  return [
    ...args.slice.map((c, i) => {
      if (!topKFinalIndices.has(i)) {
        // F-3: sequential ranks instead of shared blendedTopK.length + 0
        const newRank = rankByIndex.get(i) ?? args.blendedTopK.length;
        const normalizedScore = normByIndex.get(i) ?? 0;
        return {
          path: c.path,
          rerankScore: normalizedScore,
          originalRank: i,
          newRank,
          // F-4: derive changed from rank comparison, not hardcoded false
          changed: newRank !== i,
          signals: {
            rrfWeight: args.rrfW,
            structuralWeight: 0,
            proximityWeight: 0,
          },
          colbertScore: normalizedScore,
          maxSimScore: 0,
          pooledCosScore: args.pooledCosScores[i] ?? 0,
        };
      }
      return args.blendedTopK.find((r) => r.originalRank === i)!;
    }),
    ...args.rest.map((c, i) => {
      const newRank = args.slice.length + i;
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
          rrfWeight: args.rrfW,
          structuralWeight: 0,
          proximityWeight: 0,
        },
        colbertScore: 0,
        maxSimScore: 0,
        pooledCosScore: 0,
      };
    }),
  ];
}

async function runColbertPipeline(args: {
  query: string;
  slice: ColbertRerankerInput[];
  rest: ColbertRerankerInput[];
  queryEmbedding: number[];
  fetchLocal: FetchLocalFn;
  opts: ResolvedColbertOpts;
}): Promise<{ results: ColbertRerankerResult[]; usedColbert: boolean }> {
  // ── Stage 1: Pooled cosine similarity filter ──────────────────
  // Embed each candidate's full body text as one vector
  const bodyEmbedResult = await args.fetchLocal({
    inputs: args.slice.map((c) => c.body || ""),
  });
  // Compute pooled cosine similarity against query embedding
  const pooledCosScores = bodyEmbedResult.vectors.map((vec) =>
    cosineSimilarity(args.queryEmbedding, vec),
  );
  // Pair each candidate with its pooled score and sort descending
  // originalIndex tiebreaker ensures stable ordering when scores tie.
  const scored = scoreByPooledCosine({ slice: args.slice, pooledCosScores });
  // Keep top K candidates for full MaxSim
  const topKCandidates = pickTopK({ scored, pooledFilterTopK: args.opts.pooledFilterTopK });
  // ── Stage 2: Full MaxSim on top K candidates ──────────────────
  const querySegmentVectors = await embedQuerySegments({
    fetchLocal: args.fetchLocal,
    query: args.query,
    opts: args.opts,
  });
  if (querySegmentVectors.length === 0) {
    throw new Error("query produced no segment vectors");
  }
  // Segment and embed top-K candidate bodies, batched
  const { topKWithSegments, allSegments } = collectTopKSegments({
    topKCandidates,
    opts: args.opts,
  });
  // Batch-embed all segments from all top-K candidates in one call
  let allSegmentVectors: number[][] = [];
  if (allSegments.length > 0) {
    const sr = await args.fetchLocal({ inputs: allSegments });
    allSegmentVectors = sr.vectors;
  }
  // Compute MaxSim for each top-K candidate
  const topKResults = computeTopKMaxSims({
    topKWithSegments,
    allSegmentVectors,
    querySegmentVectors,
    topKCandidates,
  });
  // ── Blend scores ──────────────────────────────────────────
  const colbertW = args.opts.colbertWeight;
  const rrfW = 1 - colbertW;
  const blendedTopK = blendTopK({ topKResults, topKCandidates, colbertW, rrfW });
  const results = assembleColbertResults({
    slice: args.slice,
    rest: args.rest,
    blendedTopK,
    topKCandidates,
    pooledCosScores,
    rrfW,
  });
  return { results, usedColbert: true };
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
  const opts = resolveColbertOpts(candidates.length, options);
  // Try to import local embedding lazily — if unavailable, fall back
  const fetchLocal = await resolveLocalFetcher();
  if (!fetchLocal) {
    // Fall back to structural reranker
    return fallbackToStructural(
      candidates,
      options,
      "local embedding unavailable, fell back to structural reranker",
    );
  }
  const slice = candidates.slice(0, opts.maxCandidates);
  const rest = candidates.slice(opts.maxCandidates);
  try {
    return await runColbertPipeline({ query, slice, rest, queryEmbedding, fetchLocal, opts });
  } catch (err) {
    // Both pipeline failures (including "query produced no segment vectors")
    // and embedding errors fall back to the structural reranker.
    const msg = err instanceof Error ? err.message : String(err);
    return fallbackToStructural(candidates, options, msg);
  }
}
