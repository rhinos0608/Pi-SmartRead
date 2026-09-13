/**
 * intent-ranking.ts — ranking engine for intent_read.
 *
 * Owns: rankCandidates + ranking types/constants, BM25/embed/RRF fusion,
 * chunk scoring, embedding cache helpers, HyDE, ADR boost, structural rerank.
 * Candidate resolution, graph expansion, reads, packing, and public assembly
 * stay in intent-read.ts.
 *
 * Score flow (preserved): BM25 whole-file -> chunk embeddings (max chunk
 * similarity per file) -> RRF fusion (or BM25-only fallback) -> ADR additive
 * boost with re-rank -> relevance threshold filter -> RRF-rank sort ->
 * optional structural rerank. Public output uses discrete classifiers only;
 * numeric scores never leave this module boundary except via the internal
 * fileDetails map (stripped by toPublicFileDetail in intent-read.ts).
 */
import { isAbsolute, resolve } from "node:path";
import { type EmbedRequest, type EmbedResult, fetchEmbeddingsSharded, SHARD_SIZE } from "../indexing/embedding.js";
import { embeddingProfileId } from "../indexing/embedding-profile.js";
import { PersistentEmbeddingCache } from "../indexing/persistent-embedding-cache.js";
import { computeRanks, maxChunkSimilarity } from "../scoring.js";
import { applyAdrBoost, computeKeywordStage, fuseRrfScores } from "../retrieval/rerank-channels.js";
import { type ResolvedEmbeddingConfig } from "../config.js";
import { LruCache } from "../utils.js";
import { chunkTextAst } from "../structural/chunking.js";
import { applyHyde, type HydeResult } from "../search/hyde.js";
import { listAdrs } from "../repository/adr-store.js";
import { rerank, type RerankerInput } from "../ranking/rerank.js";
import { enrichRerankSignals } from "../ranking/rerank-signal-bridge.js";
import {
  classifyConfidence,
  classifyRelevanceByScore,
  classifySimilarity,
  type ConfidenceClass,
  type RelevanceClass,
} from "../ranking/classifiers.js";

export type EmbeddingStatus = "ok" | "failed_fallback_bm25";

export const INTENT_READ_CACHE_SIZE = 64;
export const MIN_RELEVANCE_SCORE = 0.05;
export const ADR_BOOST = 0.3;

/** Absolute-path normalization shared by candidate resolution and ranking. */
export function normalizeCandidatePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function createEmbeddingCacheKey(config: EmbedRequest, query: string, inputs: string[]): string {
  return JSON.stringify({
    cwdSafeBaseUrl: config.baseUrl.replace(/\/+$/, ""),
    model: config.model,
    profile: embeddingProfileId(config.model),
    query,
    inputs: [...inputs],
    inputTypes: config.inputTypes,
    inputTitles: config.inputTitles,
  });
}

export function isRelevantCandidate(keywordScore: number, semanticScore: number | undefined, embeddingStatus: EmbeddingStatus): boolean {
  // Keep exact lexical matches even when embeddings disagree. Code search must not
  // drop identifier/API-name hits solely because semantic similarity is low.
  if (keywordScore > 0) return true;
  if (embeddingStatus !== "ok" || semanticScore === undefined) return false;
  return semanticScore >= MIN_RELEVANCE_SCORE;
}

/**
 * Internal per-file ranking state written by rankCandidates. Structural
 * superset contract: intent-read.ts passes its own WorkingIntentReadFileDetail
 * map (generic TFileDetail), which must provide at least these fields.
 */
export interface RankingFileDetail {
  path: string;
  ok: boolean;
  error?: string;
  semanticRank?: number;
  semanticScore?: number;
  semanticRelevance?: RelevanceClass;
  keywordRank?: number;
  keywordScore?: number;
  keywordRelevance?: RelevanceClass;
  fusedRank?: number;
  fusedRelevance?: RelevanceClass;
  rrfScore?: number;
  chunkIndex?: number;
  chunkScore?: number;
  chunkRelevance?: RelevanceClass;
  rankedBy: "bm25" | "hybrid";
  graphDistance?: number;
  probeConfidence?: ConfidenceClass;
  probeConfidenceScore?: number;
  adrBoost?: number;
  selectedForPacking?: boolean;
  included?: boolean;
  inclusion?: string;
}

export interface RankCandidateFile {
  path: string;
  body?: string;
}

export interface RankCandidatesParams<TFileDetail extends RankingFileDetail = RankingFileDetail> {
  query: string;
  files: RankCandidateFile[];
  embeddingConfig: ResolvedEmbeddingConfig | null;
  cwd: string;
  embeddingLruCache: LruCache<EmbedResult>;
  persistentCaches: LruCache<PersistentEmbeddingCache>;
  fetchEmbeddingsImpl: (req: EmbedRequest) => Promise<EmbedResult>;
  probeAddedSet: Set<string>;
  graphDistanceMap: Map<string, number>;
  fileDetails: Map<string, Partial<TFileDetail>>;
}

export interface RankCandidatesResult {
  embeddingStatus: EmbeddingStatus;
  embeddingError: string | undefined;
  embeddingCacheHit: boolean;
  rankedSuccessOrder: string[];
  filteredBelowThresholdPaths: string[];
  totalChunks: number;
  filesChunked: number;
  bestChunkByFile: {
    path: string;
    chunkIndex: number;
    relevance: RelevanceClass;
    startChar: number;
    endChar: number;
    preview: string;
  }[];
  astChunkingUsed: boolean;
  astChunkingStats: { usedAst: boolean; wasmAvailable: boolean; parseTimeMs: number; symbolCount: number };
  hydeResult: HydeResult;
  adrBoosts: number[];
  rerankingResult:
    | { status: "off" | "ok" | "failed_fallback"; changedOrder: boolean; candidateCount: number; strategy: string }
    | undefined;
}

/** Embed + score candidates (BM25 + chunk embeddings + RRF + ADR + optional rerank). */
export async function rankCandidates<TFileDetail extends RankingFileDetail>(
  params: RankCandidatesParams<TFileDetail>,
): Promise<RankCandidatesResult> {
  const {
    query,
    files,
    embeddingConfig,
    cwd,
    embeddingLruCache,
    persistentCaches,
    fetchEmbeddingsImpl,
    probeAddedSet,
    graphDistanceMap,
    fileDetails,
  } = params;
  let embeddingStatus: EmbeddingStatus = "ok";
  let embeddingError: string | undefined;
  let embeddingCacheHit = false;
  let rerankingResult: RankCandidatesResult["rerankingResult"];
  let rankedSuccessOrder: string[] = [];
  let filteredBelowThresholdPaths: string[] = [];
  let totalChunks = 0;
  let filesChunked = 0;
  const bestChunkByFile: RankCandidatesResult["bestChunkByFile"] = [];
  let astChunkingUsed = false;
  let astChunkingStats = { usedAst: false, wasmAvailable: false, parseTimeMs: 0, symbolCount: 0 };
  let hydeResult: HydeResult = { document: query, applied: false, pattern: "none", identifiers: [] };
  let adrBoosts: number[] = [];
  if (files.length === 0) {
    return {
      embeddingStatus,
      embeddingError,
      embeddingCacheHit,
      rankedSuccessOrder,
      filteredBelowThresholdPaths,
      totalChunks,
      filesChunked,
      bestChunkByFile,
      astChunkingUsed,
      astChunkingStats,
      hydeResult,
      adrBoosts,
      rerankingResult,
    };
  }
    // Chunk each successful file's body
    const chunkSizeChars = embeddingConfig?.chunkSizeChars ?? 4096;
    const chunkOverlapChars = embeddingConfig?.chunkOverlapChars ?? 512;
    const maxChunksPerFile = embeddingConfig?.maxChunksPerFile ?? 12;

    // Map file index -> its chunks (using AST-aware chunking when available)
    const fileChunks: Awaited<ReturnType<typeof chunkTextAst>>["chunks"][] = [];
    for (const f of files) {
      const result = await chunkTextAst(f.body!, {
        chunkSizeChars,
        chunkOverlapChars,
        maxChunksPerFile,
        filePath: f.path,
        compressForEmbedding: true,
        useSymbolBoundaries: true,
      });
      fileChunks.push(result.chunks);
      if (result.diagnostics.usedAst) {
        astChunkingUsed = true;
        astChunkingStats = {
          usedAst: true,
          wasmAvailable: result.diagnostics.wasmAvailable,
          parseTimeMs: Math.max(astChunkingStats.parseTimeMs, result.diagnostics.parseTimeMs),
          symbolCount: Math.max(astChunkingStats.symbolCount, result.diagnostics.symbolCount),
        };
      }
    }

    // Collect all chunk texts plus document titles for model-specific retrieval prompts.
    const allChunkTexts = fileChunks.flatMap((chunks) => chunks.map((c) => c.embeddingText ?? c.text));
    const allChunkTitles = fileChunks.flatMap((chunks, fileIndex) =>
      chunks.map(() => files[fileIndex]!.path)
    );

    const bodies = files.map((f) => f.body!);
    const paths = files.map((f) => f.path);

    // Always compute BM25 scores on whole-file bodies (kernel channel stage 1)
    const { keywordScores: keywordScoresArr, keywordRanks } = computeKeywordStage(query, bodies, paths);

    const semanticScores: number[] = [];
    let semanticRanks: number[] = [];

    // HyDE (Hypothetical Document Embeddings): optionally replace the
    // raw query with a generated hypothetical code document for embedding.
    // This improves semantic matching for abstract/natural-language queries.
    hydeResult = applyHyde({
      enabled: embeddingConfig?.hydeEnabled === true,
      query,
    });
    const embeddingQuery = hydeResult.applied ? hydeResult.document : query;

    // Attempt embedding if config is available — fall back to BM25-only on failure
    if (!embeddingConfig) {
      embeddingStatus = "failed_fallback_bm25";
      embeddingError = "embedding config not available";
    } else {
      try {
        const { baseUrl, model, apiKey } = embeddingConfig;
        const embeddingRequest: EmbedRequest = {
          baseUrl,
          model,
          apiKey,
          inputs: [embeddingQuery, ...allChunkTexts],
          inputTypes: ["query", ...allChunkTexts.map(() => "document" as const)],
          inputTitles: [undefined, ...allChunkTitles],
        };
        const embeddingCacheKey = createEmbeddingCacheKey(embeddingRequest, query, allChunkTexts);

        // Check persistent cache first, then memory LRU
        const persistentCache = persistentCaches.get(cwd) ?? new PersistentEmbeddingCache(cwd);
        persistentCaches.set(cwd, persistentCache);

        const persistentKey = PersistentEmbeddingCache.computeKey(embeddingRequest, query, allChunkTexts);
        let embeddingResult: EmbedResult | null = null;

        // Check memory LRU
        const cachedMemResult = embeddingLruCache.get(embeddingCacheKey);
        if (cachedMemResult) {
          embeddingCacheHit = true;
          embeddingResult = cachedMemResult;
        }

        // Check persistent disk cache
        if (!embeddingResult) {
          const persistentResult = persistentCache.get(persistentKey);
          if (persistentResult) {
            embeddingCacheHit = true;
            embeddingResult = persistentResult;
            // Promote to memory
            embeddingLruCache.set(embeddingCacheKey, persistentResult);
          }
        }

        // Call API if no cache hit — use sharded path for large batches
        if (!embeddingResult) {
          if (embeddingRequest.inputs.length > SHARD_SIZE) {
            embeddingResult = await fetchEmbeddingsSharded(embeddingRequest);
          } else {
            embeddingResult = await fetchEmbeddingsImpl(embeddingRequest);
          }
        }

        const { vectors } = embeddingResult;
        if (!cachedMemResult) {
          embeddingLruCache.set(embeddingCacheKey, { vectors });
          persistentCache.set(persistentKey, { vectors });
        }

      if (vectors.length >= allChunkTexts.length + 1) {
        const queryVec = vectors[0]!;
        const chunkVecs = vectors.slice(1, allChunkTexts.length + 1);

        // Map chunk vectors back to parent files, taking max similarity
        let chunkIdx = 0;
        for (let fi = 0; fi < fileChunks.length; fi++) {
          const numChunks = fileChunks[fi]!.length;
          totalChunks += numChunks;
          if (numChunks > 0) {
            filesChunked++;
            const myChunkVecs = chunkVecs.slice(chunkIdx, chunkIdx + numChunks);
            const { maxScore, bestChunkIndex } = maxChunkSimilarity(queryVec, myChunkVecs!);
            semanticScores.push(maxScore);
            const path = files[fi]!.path;
            const fileDetail = fileDetails.get(path)!;
            fileDetail.chunkIndex = bestChunkIndex;
            fileDetail.chunkScore = maxScore;
            fileDetail.chunkRelevance = classifySimilarity(maxScore);
            const bestChunk = fileChunks[fi]![bestChunkIndex]!;
            bestChunkByFile.push({
              path,
              chunkIndex: bestChunkIndex,
              relevance: classifySimilarity(maxScore),
              startChar: bestChunk.startChar,
              endChar: bestChunk.endChar,
              preview: (bestChunk.embeddingText ?? bestChunk.text).substring(0, 120),
            });
          } else {
            semanticScores.push(-Infinity);
          }
          chunkIdx += numChunks;
        }

        semanticRanks = computeRanks(semanticScores, paths);
        embeddingStatus = "ok";
      } else {
        embeddingStatus = "failed_fallback_bm25";
        embeddingError = `Expected ${allChunkTexts.length + 1} vectors, got ${vectors.length}`;
      }
    } catch (err) {
      embeddingStatus = "failed_fallback_bm25";
      embeddingError = err instanceof Error ? err.message : String(err);
    }
    }  // end embedding attempt when config is available

    // RRF fusion (kernel channel stage 2, including the BM25-only fallback)
    const fusion = fuseRrfScores(keywordRanks, embeddingStatus === "ok" ? semanticRanks : null, paths);
    let rrfScores = fusion.rrfScores;
    let rrfRanks = fusion.rrfRanks;

    // WP-8: ADR boost — additive signal from cross-session ADRs (kernel channel stage 3)
    adrBoosts = new Array<number>(files.length).fill(0) as number[];
    try {
      const adrs = listAdrs(cwd, { status: "accepted" });
      const boosted = applyAdrBoost(rrfScores, rrfRanks, paths, adrs, ADR_BOOST);
      rrfScores = boosted.rrfScores;
      rrfRanks = boosted.rrfRanks;
      adrBoosts = boosted.adrBoosts;
    } catch {
      /* fail-safe: corrupt/missing ADR store leaves ranking unchanged */
    }

    const maxKeywordScore = Math.max(...keywordScoresArr, 0);
    const maxRrfScore = Math.max(...rrfScores, 0);
    for (let i = 0; i < files.length; i++) {
      const base = fileDetails.get(paths[i]!)!;
      base.keywordRank = keywordRanks[i]!;
      base.keywordScore = keywordScoresArr[i];
      base.keywordRelevance = classifyRelevanceByScore(base.keywordScore, maxKeywordScore);
      base.rrfScore = rrfScores[i];
      base.fusedRank = rrfRanks[i]!;
      base.fusedRelevance = classifyRelevanceByScore(base.rrfScore, maxRrfScore);
      if (adrBoosts[i]! > 0) base.adrBoost = adrBoosts[i];
      if (embeddingStatus === "ok") {
        base.semanticRank = semanticRanks[i]!;
        base.semanticScore = semanticScores[i]!;
        base.semanticRelevance = classifySimilarity(base.semanticScore);
        base.rankedBy = "hybrid";
      } else {
        base.rankedBy = "bm25" as "bm25";
      }
    }

    // Apply structural signals to file details for reranking and observability
    for (const path of paths) {
      const detail = fileDetails.get(path)!;
      const normalized = normalizeCandidatePath(cwd, path);
      if (probeAddedSet.has(normalized)) {
        detail.probeConfidenceScore = 1.0;
        detail.probeConfidence = classifyConfidence(detail.probeConfidenceScore);
        detail.graphDistance = 0;
      } else if (graphDistanceMap.has(normalized)) {
        detail.graphDistance = graphDistanceMap.get(normalized);
      }
    }

    const relevantPaths = new Set<string>();
    for (let i = 0; i < files.length; i++) {
      if (isRelevantCandidate(keywordScoresArr[i]!, semanticScores[i]!, embeddingStatus)) {
        relevantPaths.add(paths[i]!);
      }
    }
    filteredBelowThresholdPaths = paths.filter((path) => !relevantPaths.has(path));

    const ranksByPath = new Map(paths.map((path, i) => [path, rrfRanks[i]]));

    // Sort by RRF rank
    rankedSuccessOrder = [...paths]
      .filter((path) => relevantPaths.has(path))
      .sort((a, b) => (ranksByPath.get(a) ?? Infinity) - (ranksByPath.get(b) ?? Infinity));

    // Phase 5: optional structural reranker (off by default, gated behind config)
    if (embeddingConfig?.rerankEnabled === true && rankedSuccessOrder.length > 0) {
      const { isRecentlyModified } = await import("../git/git-history.js");

      // Build body-by-path map for the signal bridge (no extra disk reads)
      const bodyByPath = new Map<string, string>();
      for (const f of files) {
        if (f.body) bodyByPath.set(f.path, f.body);
      }

      const rerankInputs: RerankerInput[] = await Promise.all(
        rankedSuccessOrder.map(async (path) => {
          const detail = fileDetails.get(path)!;
          let temporalScore = 0;
          try {
            if (await isRecentlyModified(cwd, path)) temporalScore = 1.0;
          } catch { /* ignore git errors */ }

          return {
            path,
            rrfScore: detail.rrfScore ?? 0,
            keywordScore: detail.keywordScore ?? 0,
            semanticScore: detail.semanticScore,
            graphDistance: detail.graphDistance,
            probeConfidence: detail.probeConfidenceScore,
            temporalScore,
          };
        })
      );

      // WP-7: enrich with halsteadComplexity, astProfile, minHashProximity from file bodies
      const enrichedInputs = await enrichRerankSignals(rerankInputs, bodyByPath);
      const rerankResults = rerank(enrichedInputs);
      const changedCount = rerankResults.filter((r) => r.changed).length;
      if (changedCount > 0) {
        const reordered = [...rerankResults].sort((a, b) => a.newRank - b.newRank);
        rankedSuccessOrder = reordered.map((r) => r.path);
      }
      rerankingResult = {
        status: "ok",
        changedOrder: changedCount > 0,
        candidateCount: rerankResults.length,
        strategy: "structural",
      };
    }
  return {
    embeddingStatus,
    embeddingError,
    embeddingCacheHit,
    rankedSuccessOrder,
    filteredBelowThresholdPaths,
    totalChunks,
    filesChunked,
    bestChunkByFile,
    astChunkingUsed,
    astChunkingStats,
    hydeResult,
    adrBoosts,
    rerankingResult,
  };
}
