/**
 * retrieval/rerank-channels.ts — pure scoring stages extracted from intent-ranking.
 *
 * Zero behavior change: these functions implement exactly the BM25 whole-file
 * stage, the RRF fusion stage (hybrid + BM25-only fallback), and the additive
 * ADR boost stage previously inlined in rankCandidates. Embedding I/O,
 * chunking, HyDE, probe/graph signals, and structural rerank stay in
 * src/read/intent-ranking.ts, which delegates to these functions.
 *
 * Layering: imports scoring only (no store/graph/extension dependencies) so
 * both intent-ranking and future kernel runners can depend on it freely.
 */

import { bm25Scores, computeRanks, computeRrfScores } from "../scoring.js";

/** RRF damping constant. Must match computeRrfScores' internal k and the
 * BM25-only fallback divisor previously inlined in rankCandidates. */
export const RRF_K = 60;

/** Minimal ADR shape needed for the boost match (path/tag overlap). */
export interface AdrBoostRecord {
  tags: string[];
}

export interface KeywordStageResult {
  keywordScores: number[];
  keywordRanks: number[];
}

export interface RrfFusionResult {
  rrfScores: number[];
  rrfRanks: number[];
  fusedBy: "hybrid" | "bm25";
}

export interface AdrBoostResult {
  rrfScores: number[];
  rrfRanks: number[];
  adrBoosts: number[];
}

/**
 * Stage 1: BM25 whole-file keyword scores + ranks.
 * Pure wrapper over bm25Scores/computeRanks; order-aligned with bodies/paths.
 */
export function computeKeywordStage(query: string, bodies: string[], paths: string[]): KeywordStageResult {
  const keywordScores = bm25Scores(query, bodies);
  const keywordRanks = computeRanks(keywordScores, paths);
  return { keywordScores, keywordRanks };
}

/**
 * Stage 2: RRF fusion. Hybrid when semantic ranks are present, otherwise the
 * BM25-only fallback 1/(60+rank) previously inlined in rankCandidates.
 * Pass semanticRanks as null/[] when embeddings failed or are unavailable;
 * the caller (rankCandidates) maps embeddingStatus !== "ok" to null.
 */
export function fuseRrfScores(
  keywordRanks: number[],
  semanticRanks: number[] | null,
  paths: string[],
): RrfFusionResult {
  if (semanticRanks !== null && semanticRanks.length > 0) {
    const rrfScores = computeRrfScores(semanticRanks, keywordRanks);
    return { rrfScores, rrfRanks: computeRanks(rrfScores, paths), fusedBy: "hybrid" };
  }
  const rrfScores = keywordRanks.map((kr) => 1 / (RRF_K + kr));
  return { rrfScores, rrfRanks: computeRanks(rrfScores, paths), fusedBy: "bm25" };
}

/**
 * Stage 3: additive ADR boost. A file earns boost once when any accepted ADR
 * tag matches by substring (fp.includes(tag)) or bare basename equality.
 * Scores are copied, never mutated; ranks are recomputed only when at least
 * one accepted ADR exists (matching rankCandidates' original branch).
 */
export function applyAdrBoost(
  rrfScores: number[],
  rrfRanks: number[],
  paths: string[],
  adrs: AdrBoostRecord[],
  boost: number,
): AdrBoostResult {
  const nextScores = [...rrfScores];
  const adrBoosts = new Array<number>(paths.length).fill(0) as number[];
  if (adrs.length === 0) {
    return { rrfScores: nextScores, rrfRanks: [...rrfRanks], adrBoosts };
  }
  for (let i = 0; i < paths.length; i++) {
    const fp = paths[i]!;
    const basename = fp.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
    for (const adr of adrs) {
      if (adr.tags.some((t) => fp.includes(t) || basename === t)) {
        adrBoosts[i] = boost;
        nextScores[i]! += boost;
        break;
      }
    }
  }
  return { rrfScores: nextScores, rrfRanks: computeRanks(nextScores, paths), adrBoosts };
}
