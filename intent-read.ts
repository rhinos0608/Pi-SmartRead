import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type {
  ExtensionContext,
  ReadToolInput,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createReadTool, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { validateEmbeddingConfig } from "./config.js";
import { type EmbedRequest, type EmbedResult, fetchEmbeddings as defaultFetchEmbeddings } from "./embedding.js";
import { PersistentEmbeddingCache } from "./persistent-embedding-cache.js";
import { resolveDirectory, presortPathsByQuery } from "./resolver.js";
import { bm25Scores, computeRanks, computeRrfScores, maxChunkSimilarity } from "./scoring.js";
import {
  findDirectImportNeighbours,
  ContextGraph,
} from "./context-graph.js";
import {
  type FileCandidate,
  buildPlan,
  formatContentBlock,
  measureText,
  validatePath,
  LruCache,
} from "./utils.js";
import { probeQuery, type ProbeResult } from "./query-probe.js";
import { rerank, type RerankerInput } from "./rerank.js";
import { chunkTextAst, type ChunkResult } from "./chunking.js";
import { applyHyde, type HydeResult } from "./hyde.js";

const IntentReadSchema = Type.Object({
  query: Type.String({ description: "The search intent" }),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ description: "Path to the file (relative or absolute)" }),
        offset: Type.Optional(Type.Number({ minimum: 0 })),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      { minItems: 1, maxItems: 20 },
    ),
  ),
  directory: Type.Optional(Type.String({ description: "Directory to scan (non-recursive, max 20 files)" })),
  topK: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Max results to return (default 20)" })),
  stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first read error (default false)" })),
});

type IntentReadInput = Static<typeof IntentReadSchema>;

type InclusionStatus = "full" | "partial" | "omitted" | "not_top_k" | "below_threshold" | "error";
type EmbeddingStatus = "ok" | "failed_fallback_bm25";

const INTENT_READ_CACHE_SIZE = 64;
const MIN_RELEVANCE_SCORE = 0.05;
const MAX_INTENT_READ_FILES = 20;

const contextGraphCache = new LruCache<ContextGraph>(10);

function createEmbeddingCacheKey(config: EmbedRequest, query: string, inputs: string[]): string {
  return JSON.stringify({
    cwdSafeBaseUrl: config.baseUrl.replace(/\/+$/, ""),
    model: config.model,
    query,
    inputs: [...inputs].sort(),
  });
}

function isRelevantCandidate(keywordScore: number, semanticScore: number | undefined, embeddingStatus: EmbeddingStatus): boolean {
  // Keep exact lexical matches even when embeddings disagree. Code search must not
  // drop identifier/API-name hits solely because semantic similarity is low.
  if (keywordScore > 0) return true;
  if (embeddingStatus !== "ok" || semanticScore === undefined) return false;
  return semanticScore >= MIN_RELEVANCE_SCORE;
}

function normalizeCandidatePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

interface IntentReadFileDetail {
  path: string;
  ok: boolean;
  error?: string;
  semanticRank?: number;
  semanticScore?: number;
  keywordRank?: number;
  keywordScore?: number;
  rrfScore?: number;
  selectedForPacking: boolean;
  included: boolean;
  inclusion: InclusionStatus;
  chunkIndex?: number;
  chunkScore?: number;
  rankedBy: "bm25" | "hybrid";
  /** Graph distance from seed files (0 = seed, 1 = import, 2 = symbol neighbour). */
  graphDistance?: number;
  /** Confidence from query probing (1.0 = direct symbol match). */
  probeConfidence?: number;
}

interface IntentReadDetails {
  query: string;
  processedCount: number;
  successCount: number;
  errorCount: number;
  requestedTopK: number;
  effectiveTopK: number;
  candidateCountBeforeCap?: number;
  candidateCountAfterCap?: number;
  capped?: boolean;
  embeddingStatus: EmbeddingStatus;
  embeddingError?: string;
  rankingSignals: { bm25: true; embeddings: boolean };
  chunkingEnabled: boolean;
  /** AST-aware chunking detection (uses web-tree-sitter WASM from smart-edit integration) */
  astChunking?: { usedAst: boolean; wasmAvailable: boolean; parseTimeMs: number; symbolCount: number };
  embeddingCache: { hit: boolean; size: number; maxSize: number; persistent?: boolean; diskEntries?: number };
  filteredBelowThresholdPaths: string[];
  graphAugmentation: { addedPaths: string[]; candidateCountBefore: number; candidateCountAfter: number; edgesUsed?: Array<{ from: string; to: string; type: string; confidence: number }> };
  chunkInfo?: {
    totalChunks: number;
    filesChunked: number;
    bestChunkByFile: {
      path: string;
      chunkIndex: number;
      score: number;
      startChar: number;
      endChar: number;
      preview: string;
    }[];
  };
  probing?: ProbeResult;
  hyde?: HydeResult;
  reranking?: {
    status: "off" | "ok" | "failed_fallback";
    changedOrder: boolean;
    candidateCount: number;
    strategy: string;
  };
  files: IntentReadFileDetail[];
  packing: {
    strategy: string;
    switchedForCoverage: boolean;
    fullIncludedCount: number;
    fullIncludedSuccessCount: number;
    partialIncludedPath?: string;
    omittedPaths: string[];
  };
}

export function createIntentReadTool(
  readToolFactory: typeof createReadTool = createReadTool,
  fetchEmbeddingsImpl: (req: EmbedRequest) => Promise<EmbedResult> = defaultFetchEmbeddings,
): ToolDefinition {
  const embeddingLruCache = new LruCache<EmbedResult>(INTENT_READ_CACHE_SIZE);
  // Persistent cache is lazy-initialized per cwd (disk path depends on cwd).
  // Use LRU to prevent unbounded memory growth across repos.
  const persistentCaches = new LruCache<PersistentEmbeddingCache>(10);

  return {
    name: "intent_read",
    label: "intent_read",
    description: `Read up to 20 files, rank them by hybrid RRF (BM25 keyword + semantic cosine) against a query, and return the top-K relevant files. Combined output respects limits (${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}). Requires embedding config via pi-smartread.config.json or PI_SMARTREAD_EMBEDDING_BASE_URL / PI_SMARTREAD_EMBEDDING_MODEL env vars.`,
    parameters: IntentReadSchema,

    async execute(
      toolCallId: string,
      params: IntentReadInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      // 1. Validate embedding config first (before any reads)
      const embeddingConfig = validateEmbeddingConfig(ctx.cwd);

      // Embedding API tracking (updated after embed call; may degrade to fallback)
      let embeddingStatus: EmbeddingStatus = "ok";
      let embeddingError: string | undefined;
      let embeddingCacheHit = false;

      // Phase 5: reranking metadata (populated after RRF, gated behind config)
      let rerankingResult: { status: "off" | "ok" | "failed_fallback"; changedOrder: boolean; candidateCount: number; strategy: string } | undefined;

      // 2. Validate input
      const query = params.query.trim();
      if (!query) throw new Error("query must not be empty or whitespace-only");

      const hasFiles = Array.isArray(params.files) && params.files.length > 0;
      const hasDirectory = typeof params.directory === "string" && params.directory.length > 0;

      if (hasFiles && hasDirectory) {
        throw new Error("Provide either files or directory, not both");
      }
      if (!hasFiles && !hasDirectory) {
        throw new Error("Provide either files or directory");
      }

      const topK = params.topK ?? 20;

      // 3. Resolve candidates
      interface ResolvedFile { path: string; offset?: number; limit?: number; }
      let resolvedFiles: ResolvedFile[];
      let dirCap: { countBeforeCap: number; countAfterCap: number; capped: boolean } | undefined;

      if (hasDirectory) {
        const resolution = resolveDirectory(normalizeCandidatePath(ctx.cwd, params.directory!));
        if (resolution.capped) {
          dirCap = {
            countBeforeCap: resolution.countBeforeCap,
            countAfterCap: resolution.paths.length,
            capped: true,
          };
        }
        resolvedFiles = resolution.paths.map((p) => ({ path: p }));
        // Phase 4: reorder by filename/path token overlap within capped results
        const pathStrings = resolvedFiles.map((r) => r.path);
        const reordered = presortPathsByQuery(pathStrings, query);
        resolvedFiles = reordered.map((p) => ({ path: p }));
      } else {
        resolvedFiles = params.files!;
      }

      const candidateCountBeforeGraph = resolvedFiles.length;

      // Build shared ContextGraph with symbol index for all graph-aware phases.
      // This pre-builds the symbol → tags index so probing and symbol-neighbour
      // expansion use the fast O(1) lookup path instead of full-repo rescans.
      // Skip for directories that don't look like real projects (e.g. "/" in tests).
      let sharedGraph = contextGraphCache.get(ctx.cwd);
      if (!sharedGraph) {
        sharedGraph = new ContextGraph(ctx.cwd);
        contextGraphCache.set(ctx.cwd, sharedGraph);
      }
      
      const hasProjectMarker =
        existsSync(join(ctx.cwd, ".git")) ||
        existsSync(join(ctx.cwd, "package.json")) ||
        existsSync(join(ctx.cwd, "tsconfig.json")) ||
        existsSync(join(ctx.cwd, "pyproject.toml")) ||
        existsSync(join(ctx.cwd, "Cargo.toml")) ||
        existsSync(join(ctx.cwd, "go.mod"));
      
      if (hasProjectMarker && embeddingConfig.probeEnabled === true) {
        await sharedGraph.buildContextGraph({ forceRefresh: false, includeSymbols: true, includeCalls: true });
      }

      // Tracking sets for structural signals (populated during expansion)
      const probeAddedSet = new Set<string>();
      const graphDistanceMap = new Map<string, number>();

      // Phase 3: Probe phase — extract symbols from query, find definition files.
      // Gated behind config (probeEnabled: true, default off) because probe uses
      // tree-sitter which is expensive and not needed for simple file-scoped queries.
      let probing: ProbeResult | undefined;
      const probeAddedPaths: string[] = [];
      if (embeddingConfig.probeEnabled === true) {
        const probeSlots = Math.max(0, MAX_INTENT_READ_FILES - resolvedFiles.length);
        if (probeSlots > 0) {
          try {
            probing = await probeQuery(query, {
              maxProbeAdded: Math.min(4, probeSlots),
              graph: sharedGraph,
            });
            if (probing.status === "ok" && probing.addedPaths.length > 0) {
              const probeExisting = new Set(resolvedFiles.map((file) => normalizeCandidatePath(ctx.cwd, file.path)));
              for (const probePath of probing.addedPaths) {
                if (probeExisting.has(probePath) || resolvedFiles.length >= MAX_INTENT_READ_FILES) continue;
                probeExisting.add(probePath);
                resolvedFiles.push({ path: probePath });
                probeAddedPaths.push(probePath);
                probeAddedSet.add(normalizeCandidatePath(ctx.cwd, probePath));
              }
            }
          } catch (err) {
            probing = {
              status: "failed",
              strategy: "symbols",
              inferredSymbols: [],
              addedPaths: [],
              warnings: [err instanceof Error ? err.message : String(err)],
            };
          }
        }
      }

      // Phase 2: Graph neighbour expansion (imports + symbols)
      const graphEdges: Array<{ from: string; to: string; type: string; confidence: number }> = [];
      const existingPaths = new Set(resolvedFiles.map((file) => normalizeCandidatePath(ctx.cwd, file.path)));

      // 2a: Import neighbours (fast, regex-based batch scan)
      const importSlots = Math.max(0, MAX_INTENT_READ_FILES - resolvedFiles.length);
      
      // Pre-compute import neighbours for initial seed files to avoid O(n^2) rescans
      const seedFileToImports = new Map<string, string[]>();
      for (const file of resolvedFiles) {
        try {
          seedFileToImports.set(file.path, findDirectImportNeighbours(ctx.cwd, [file.path], MAX_INTENT_READ_FILES));
        } catch {
          seedFileToImports.set(file.path, []);
        }
      }

      const importNeighbourPaths = findDirectImportNeighbours(ctx.cwd, resolvedFiles.map((file) => file.path), importSlots);
      for (const graphPath of importNeighbourPaths) {
        if (existingPaths.has(graphPath) || resolvedFiles.length >= MAX_INTENT_READ_FILES) continue;
        existingPaths.add(graphPath);
        resolvedFiles.push({ path: graphPath });
        
        // Find which seed file imported this path (fallback to cwd if not found)
        const seedFile = resolvedFiles.find(f => {
          const neighbours = seedFileToImports.get(f.path);
          return neighbours ? neighbours.includes(graphPath) : false;
        });
        
        graphEdges.push({ 
          from: seedFile ? seedFile.path : ctx.cwd, 
          to: graphPath, 
          type: "imports", 
          confidence: 1.0 
        });
        graphDistanceMap.set(normalizeCandidatePath(ctx.cwd, graphPath), 1);
      }

      // 2b: Symbol neighbours (uses pre-built symbol index from shared graph)
      const symbolSlots = Math.max(0, MAX_INTENT_READ_FILES - resolvedFiles.length);
      if (symbolSlots > 0 && embeddingConfig.probeEnabled === true) {
        const seedFiles = resolvedFiles.slice(0, candidateCountBeforeGraph);
        for (const seedFile of seedFiles) {
          if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
          try {
            const neighbours = await sharedGraph.getFileNeighbours(seedFile.path, { includeSymbols: true });
            for (const n of neighbours) {
              if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
              const normalized = normalizeCandidatePath(ctx.cwd, n.path);
              if (existingPaths.has(normalized)) continue;
              existingPaths.add(normalized);
              resolvedFiles.push({ path: n.path });
              graphEdges.push({ from: seedFile.path, to: n.path, type: n.provenance.type, confidence: n.provenance.confidence });
              graphDistanceMap.set(normalized, 2);
            }
          } catch { /* skip individual failures */ }
        }
      }
      // 2c: Call graph neighbours (caller/callee expansion for high-confidence function symbols)
      const callSlots = Math.max(0, MAX_INTENT_READ_FILES - resolvedFiles.length);
      if (callSlots > 0 && embeddingConfig.probeEnabled === true) {
        const callSeedFiles = resolvedFiles.slice(0, candidateCountBeforeGraph);
        for (const seedFile of callSeedFiles) {
          if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
          try {
            const neighbours = await sharedGraph.getFileNeighbours(seedFile.path, { includeCalls: true });
            for (const n of neighbours) {
              if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
              const normalized = normalizeCandidatePath(ctx.cwd, n.path);
              if (existingPaths.has(normalized)) continue;
              existingPaths.add(normalized);
              resolvedFiles.push({ path: n.path });
              graphEdges.push({ from: seedFile.path, to: n.path, type: n.provenance.type, confidence: n.provenance.confidence });
              graphDistanceMap.set(normalized, 2);
            }
          } catch { /* skip individual failures */ }
        }
      }
      const addedGraphPaths = resolvedFiles.slice(candidateCountBeforeGraph).map((file) => file.path);

      // 4. Read files
      const readTool = readToolFactory(ctx.cwd);
      interface FileReadResult { path: string; ok: boolean; body?: string; error?: string; }
      const fileResults: FileReadResult[] = [];

      for (let i = 0; i < resolvedFiles.length; i++) {
        if (signal?.aborted) throw new Error("Operation aborted");

        const req = resolvedFiles[i]!;
        try {
          validatePath(req.path);
          const input: ReadToolInput = { path: req.path, offset: req.offset, limit: req.limit };
          const result = await readTool.execute(`${toolCallId}:${i}`, input, signal, undefined);

          const body = result.content
            .filter((item): item is { type: "text"; text: string } => item.type === "text")
            .map((item) => item.text)
            .join("\n");

          fileResults.push({ path: req.path, ok: true, body: body || "[No text content]" });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          fileResults.push({ path: req.path, ok: false, error: message });
          if (params.stopOnError) throw err;
        }
      }

      const successfulFiles = fileResults.filter((f) => f.ok);
      const erroredFiles = fileResults.filter((f) => !f.ok);

      // 5. Embed + score (skip if no successful files)
      const fileDetails = new Map<string, Partial<IntentReadFileDetail>>();
      for (const f of fileResults) {
        fileDetails.set(f.path, { path: f.path, ok: f.ok, error: f.error, rankedBy: "bm25" });
      }

      let rankedSuccessOrder: string[] = []; // paths in RRF rank order (rank 1 first)
      let filteredBelowThresholdPaths: string[] = [];

      // Track chunking observability (may stay at defaults if no files to process)
      let totalChunks = 0;
      let filesChunked = 0;
      const bestChunkByFile: {
        path: string;
        chunkIndex: number;
        score: number;
        startChar: number;
        endChar: number;
        preview: string;
      }[] = [];

      // AST chunking tracking (populated inside the if-block)
      let astChunkingUsed = false;
      let astChunkingStats = { usedAst: false, wasmAvailable: false, parseTimeMs: 0, symbolCount: 0 };

      // HyDE tracking (populated inside the if-block)
      let hydeResult: HydeResult = { document: query, applied: false, pattern: "none", identifiers: [] };

      if (successfulFiles.length > 0) {
        // Chunk each successful file's body
        const chunkSizeChars = embeddingConfig.chunkSizeChars;
        const chunkOverlapChars = embeddingConfig.chunkOverlapChars;
        const maxChunksPerFile = embeddingConfig.maxChunksPerFile;

        // Map file index -> its chunks (using AST-aware chunking when available)
        const fileChunks: ChunkResult[][] = [];
        for (const f of successfulFiles) {
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

        // Collect all chunk texts plus the query
        const allChunkTexts = fileChunks.flatMap((chunks) => chunks.map((c) => c.embeddingText ?? c.text));

        const bodies = successfulFiles.map((f) => f.body!);
        const paths = successfulFiles.map((f) => f.path);

        // Always compute BM25 scores on whole-file bodies
        const keywordScoresArr = bm25Scores(query, bodies);
        const keywordRanks = computeRanks(keywordScoresArr, paths);

        const semanticScores: number[] = [];
        let semanticRanks: number[] = [];

        // HyDE (Hypothetical Document Embeddings): optionally replace the
        // raw query with a generated hypothetical code document for embedding.
        // This improves semantic matching for abstract/natural-language queries.
        hydeResult = applyHyde({
          enabled: embeddingConfig.hydeEnabled === true,
          query,
        });
        const embeddingQuery = hydeResult.applied ? hydeResult.document : query;

        // Attempt embedding — fall back to BM25-only on failure
        try {
          const embeddingRequest = {
            ...embeddingConfig,
            inputs: [embeddingQuery, ...allChunkTexts],
          };
          const embeddingCacheKey = createEmbeddingCacheKey(embeddingRequest, query, allChunkTexts);

          // Check persistent cache first, then memory LRU
          const persistentCache = persistentCaches.get(ctx.cwd) ?? new PersistentEmbeddingCache(ctx.cwd);
          persistentCaches.set(ctx.cwd, persistentCache);

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

          // Call API if no cache hit
          if (!embeddingResult) {
            embeddingResult = await fetchEmbeddingsImpl(embeddingRequest);
          }

          const { vectors } = embeddingResult;
          if (!cachedMemResult) {
            embeddingLruCache.set(embeddingCacheKey, { vectors });
            persistentCache.set(persistentKey, { vectors });
          }

          if (vectors.length === allChunkTexts.length + 1) {
            const queryVec = vectors[0]!;
            const chunkVecs = vectors.slice(1);

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
                const path = successfulFiles[fi]!.path;
                const fileDetail = fileDetails.get(path)!;
                fileDetail.chunkIndex = bestChunkIndex;
                fileDetail.chunkScore = maxScore;
                const bestChunk = fileChunks[fi]![bestChunkIndex]!;
                bestChunkByFile.push({
                  path,
                  chunkIndex: bestChunkIndex,
                  score: maxScore,
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

        let rrfScores: number[];
        let rrfRanks: number[];

        if (embeddingStatus === "ok" && semanticRanks.length > 0) {
          rrfScores = computeRrfScores(semanticRanks, keywordRanks);
          rrfRanks = computeRanks(rrfScores, paths);
        } else {
          // BM25-only fallback
          rrfScores = keywordRanks.map((kr) => 1 / (60 + kr));
          rrfRanks = computeRanks(rrfScores, paths);
        }

        for (let i = 0; i < successfulFiles.length; i++) {
          const base = fileDetails.get(paths[i]!)!;
          base.keywordRank = keywordRanks[i]!;
          base.keywordScore = keywordScoresArr[i];
          base.rrfScore = rrfScores[i];
          if (embeddingStatus === "ok") {
            base.semanticRank = semanticRanks[i]!;
            base.semanticScore = semanticScores[i]!;
            base.rankedBy = "hybrid";
          } else {
            base.rankedBy = "bm25" as "bm25";
          }
        }

        // Apply structural signals to file details for reranking and observability
        for (const path of paths) {
          const detail = fileDetails.get(path)!;
          const normalized = normalizeCandidatePath(ctx.cwd, path);
          if (probeAddedSet.has(normalized)) {
            detail.probeConfidence = 1.0;
            detail.graphDistance = 0;
          } else if (graphDistanceMap.has(normalized)) {
            detail.graphDistance = graphDistanceMap.get(normalized);
          }
        }

        const relevantPaths = new Set<string>();
        for (let i = 0; i < successfulFiles.length; i++) {
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
        if (embeddingConfig.rerankEnabled === true && rankedSuccessOrder.length > 0) {
          const { isRecentlyModified } = await import("./git-history.js");
          
          const rerankInputs: RerankerInput[] = await Promise.all(
            rankedSuccessOrder.map(async (path) => {
              const detail = fileDetails.get(path)!;
              let temporalScore = 0;
              try {
                if (await isRecentlyModified(ctx.cwd, path)) temporalScore = 1.0;
              } catch { /* ignore git errors */ }
              
              return {
                path,
                rrfScore: detail.rrfScore ?? 0,
                keywordScore: detail.keywordScore ?? 0,
                semanticScore: detail.semanticScore,
                graphDistance: detail.graphDistance,
                probeConfidence: detail.probeConfidence,
                temporalScore,
              };
            })
          );
          const rerankResults = rerank(rerankInputs);
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
      }

      const effectiveTopK = Math.min(topK, rankedSuccessOrder.length);
      const topKPaths = new Set(rankedSuccessOrder.slice(0, effectiveTopK));

      // Mark each file's selection status
      for (const f of fileResults) {
        const detail = fileDetails.get(f.path)!;
        detail.selectedForPacking = f.ok && topKPaths.has(f.path);
        if (!f.ok) {
          detail.inclusion = "error";
          detail.included = false;
        } else if (filteredBelowThresholdPaths.includes(f.path)) {
          detail.inclusion = "below_threshold";
          detail.included = false;
        } else if (!topKPaths.has(f.path)) {
          detail.inclusion = "not_top_k";
          detail.included = false;
        }
        // included/inclusion for top-K files is set after packing
      }

      // 6. Pack top-K files using buildPlan (in RRF rank order)
      const topKOrdered = rankedSuccessOrder.slice(0, effectiveTopK);
      const packCandidates: FileCandidate[] = topKOrdered.map((path, i) => {
        const f = successfulFiles.find((x) => x.path === path)!;
        const body = f.body!;
        const fullText = formatContentBlock(path, body, i + 1);
        return {
          index: i,
          path,
          ok: true,
          fullText,
          fullMetrics: measureText(fullText),
          body,
        };
      });

      const requestOrder = packCandidates.map((_, i) => i);
      const smallestFirstOrder = [...requestOrder].sort((a, b) => {
        const d = packCandidates[a]!.fullMetrics.bytes - packCandidates[b]!.fullMetrics.bytes;
        return d !== 0 ? d : a - b;
      });

      // Relevance-first hybrid: guarantee #1 ranked file is included first,
      // then fill remaining space with smallest-first for maximum coverage.
      // Prevents smallest-first from displacing the highest-confidence result.
      const relevanceFirstOrder = packCandidates.length > 0
        ? [0, ...smallestFirstOrder.filter((i) => i !== 0)]
        : [];

      const requestPlan = buildPlan("request-order", requestOrder, packCandidates);
      const smallestPlan = buildPlan("smallest-first", smallestFirstOrder, packCandidates);
      const relevancePlan = buildPlan("relevance-first", relevanceFirstOrder, packCandidates);

      // Pick the plan that includes the most successful files.
      // Tie-break: prefer plans that include the #1 ranked file (index 0).
      const candidates_plans = [
        { plan: requestPlan, name: "request-order" },
        { plan: smallestPlan, name: "smallest-first" },
        { plan: relevancePlan, name: "relevance-first" },
      ];
      const best = candidates_plans.sort((a, b) => {
        const d = b.plan.fullSuccessCount - a.plan.fullSuccessCount;
        if (d !== 0) return d;
        // Tie-break: prefer including the top-ranked file
        const aHasTop = a.plan.fullIncluded.has(0) ? 1 : 0;
        const bHasTop = b.plan.fullIncluded.has(0) ? 1 : 0;
        return bHasTop - aHasTop;
      })[0]!;
      const switchedForCoverage = best.name !== "request-order";
      const plan = best.plan;

      // Build output sections in RRF rank order
      const sections: string[] = [];
      for (let i = 0; i < packCandidates.length; i++) {
        const path = packCandidates[i]!.path;
        if (plan.fullIncluded.has(i)) {
          sections.push(packCandidates[i]!.fullText);
          const d = fileDetails.get(path)!;
          d.inclusion = "full";
          d.included = true;
        } else if (plan.partialSection?.index === i) {
          sections.push(plan.partialSection.text);
          const d = fileDetails.get(path)!;
          d.inclusion = "partial";
          d.included = true;
        } else {
          const d = fileDetails.get(path)!;
          d.inclusion = "omitted";
          d.included = false;
        }
      }

      const outputText = sections.join("\n\n");

      // 7. Build details.files: successful files in RRF order, then errored files in input order
      const allFileDetails: IntentReadFileDetail[] = [
        ...rankedSuccessOrder.map((path: string) => fileDetails.get(path) as IntentReadFileDetail),
        ...filteredBelowThresholdPaths.map((path: string) => fileDetails.get(path) as IntentReadFileDetail),
        ...erroredFiles.map((f: FileReadResult) => fileDetails.get(f.path) as IntentReadFileDetail),
      ];

      const partialIncludedPath =
        plan.partialSection !== undefined
          ? packCandidates[plan.partialSection.index]?.path
          : undefined;

      const details: IntentReadDetails = {
        query,
        processedCount: fileResults.length,
        successCount: successfulFiles.length,
        errorCount: erroredFiles.length,
        requestedTopK: topK,
        effectiveTopK,
        ...(dirCap && {
          candidateCountBeforeCap: dirCap.countBeforeCap,
          candidateCountAfterCap: dirCap.countAfterCap,
          capped: true,
        }),
        embeddingStatus,
        ...(embeddingError && { embeddingError }),
        rankingSignals: {
          bm25: true,
          embeddings: embeddingStatus === "ok",
        },
        chunkingEnabled: embeddingStatus === "ok",
        astChunking: astChunkingUsed ? astChunkingStats : undefined,
        embeddingCache: {
          hit: embeddingCacheHit,
          size: embeddingLruCache.size,
          maxSize: embeddingLruCache.maxSize,
          persistent: persistentCaches.get(ctx.cwd)?.hasPersistence ?? false,
          diskEntries: persistentCaches.get(ctx.cwd)?.diskEntries ?? 0,
        },
        filteredBelowThresholdPaths,
        graphAugmentation: {
          addedPaths: addedGraphPaths,
          candidateCountBefore: candidateCountBeforeGraph,
          candidateCountAfter: resolvedFiles.length,
          ...(graphEdges.length > 0 && { edgesUsed: graphEdges }),
        },
        ...(probing && { probing }),
        ...(hydeResult.applied && { hyde: hydeResult }),
        ...(rerankingResult && { reranking: rerankingResult }),
        ...(embeddingStatus === "ok" && filesChunked > 0 && {
          chunkInfo: {
            totalChunks,
            filesChunked,
            bestChunkByFile,
          },
        }),
        files: allFileDetails,
        packing: {
          strategy: plan.strategy,
          switchedForCoverage,
          fullIncludedCount: plan.fullCount,
          fullIncludedSuccessCount: plan.fullSuccessCount,
          partialIncludedPath,
          omittedPaths: plan.omittedIndexes.map((i: number) => packCandidates[i]!.path),
        },
      };

      return {
        content: [{ type: "text", text: outputText }],
        details,
      };
    },
  } as unknown as ToolDefinition;
}
