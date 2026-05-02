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
length + i,
      changed: false,
      signals: { rrfWeight, structuralWeight, proximityWeight },
    })),
  ];
}
