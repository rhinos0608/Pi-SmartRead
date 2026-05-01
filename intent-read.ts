import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  type FileCandidate,
  buildPlan,
  formatContentBlock,
  measureText,
  validatePath,
} from "./utils.js";
import { chunkText, type ChunkResult } from "./chunking.js";

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
const IMPORT_SPECIFIER_RE = /^\s*(?:import\s+(?:[^"']+?\s+from\s+)?|import\s*\(|(?:const|let|var)\s+[^=]+?=\s*require\(|export\s+[^"']+?\s+from\s+)["']([^"']+)["']/gm;
const RESOLUTION_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

class LruCache<T> {
  private values = new Map<string, T>();

  constructor(readonly maxSize: number) {}

  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    if (this.values.has(key)) {
      this.values.delete(key);
    }
    this.values.set(key, value);
    while (this.values.size > this.maxSize) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  get size(): number {
    return this.values.size;
  }
}

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

function isPathInside(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const lexicalRel = relative(resolvedRoot, resolvedPath);
  if (lexicalRel === "" || (!lexicalRel.startsWith("..") && !isAbsolute(lexicalRel))) {
    return true;
  }

  try {
    const realRoot = realpathSync(resolvedRoot);
    const realRel = relative(realRoot, resolvedPath);
    return realRel === "" || (!realRel.startsWith("..") && !isAbsolute(realRel));
  } catch {
    return false;
  }
}

function resolveImportSpecifier(cwd: string, importerPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;

  const basePath = resolve(dirname(importerPath), specifier);
  if (!isPathInside(cwd, basePath)) return undefined;
  for (const ext of RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (isReadableWorkspaceFile(cwd, candidate)) return candidate;
  }

  for (const ext of RESOLUTION_EXTENSIONS.slice(1)) {
    const candidate = join(basePath, `index${ext}`);
    if (isReadableWorkspaceFile(cwd, candidate)) return candidate;
  }

  return undefined;
}

function isReadableWorkspaceFile(cwd: string, path: string): boolean {
  try {
    if (!existsSync(path) || !isPathInside(cwd, path)) return false;
    const realPath = realpathSync(path);
    return isPathInside(cwd, realPath) && statSync(realPath).isFile();
  } catch {
    return false;
  }
}

function findDirectImportNeighbours(cwd: string, paths: string[], maxCount: number): string[] {
  if (maxCount <= 0) return [];

  const basePaths = new Set(paths.map((path) => normalizeCandidatePath(cwd, path)));
  const neighbours: string[] = [];
  const seen = new Set<string>(basePaths);

  for (const path of paths) {
    const importerPath = normalizeCandidatePath(cwd, path);
    if (!isPathInside(cwd, importerPath)) continue;

    let text: string;
    try {
      text = readFileSync(importerPath, "utf-8");
    } catch {
      continue;
    }

    for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
      const resolved = resolveImportSpecifier(cwd, importerPath, match[1]);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      neighbours.push(resolved);
      if (neighbours.length >= maxCount) return neighbours;
    }
  }

  return neighbours;
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
  embeddingCache: { hit: boolean; size: number; maxSize: number; persistent?: boolean; diskEntries?: number };
  filteredBelowThresholdPaths: string[];
  graphAugmentation: { addedPaths: string[]; candidateCountBefore: number; candidateCountAfter: number };
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
  // Persistent cache is lazy-initialized per cwd (disk path depends on cwd)
  const persistentCaches = new Map<string, PersistentEmbeddingCache>();

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
      const remainingGraphSlots = Math.max(0, MAX_INTENT_READ_FILES - resolvedFiles.length);
      const graphNeighbourPaths = findDirectImportNeighbours(ctx.cwd, resolvedFiles.map((file) => file.path), remainingGraphSlots);
      if (graphNeighbourPaths.length > 0) {
        const existingPaths = new Set(resolvedFiles.map((file) => normalizeCandidatePath(ctx.cwd, file.path)));
        for (const graphPath of graphNeighbourPaths) {
          if (existingPaths.has(graphPath) || resolvedFiles.length >= MAX_INTENT_READ_FILES) continue;
          existingPaths.add(graphPath);
          resolvedFiles.push({ path: graphPath });
        }
      }
      const addedGraphPaths = resolvedFiles.slice(candidateCountBeforeGraph).map((file) => file.path);

      // 4. Read files
      const readTool = readToolFactory(ctx.cwd);
      interface FileReadResult { path: string; ok: boolean; body?: string; error?: string; }
      const fileResults: FileReadResult[] = [];

      for (let i = 0; i < resolvedFiles.length; i++) {
        if (signal?.aborted) throw new Error("Operation aborted");

        const req = resolvedFiles[i];
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

      if (successfulFiles.length > 0) {
        // Chunk each successful file's body
        const chunkSizeChars = embeddingConfig.chunkSizeChars;
        const chunkOverlapChars = embeddingConfig.chunkOverlapChars;
        const maxChunksPerFile = embeddingConfig.maxChunksPerFile;

        // Map file index -> its chunks
        const fileChunks: ChunkResult[][] = [];
        for (const f of successfulFiles) {
          fileChunks.push(
            chunkText(f.body!, {
              chunkSizeChars,
              chunkOverlapChars,
              maxChunksPerFile,
              filePath: f.path,
              compressForEmbedding: true,
              useSymbolBoundaries: true,
            }),
          );
        }

        // Collect all chunk texts plus the query
        const allChunkTexts = fileChunks.flatMap((chunks) => chunks.map((c) => c.embeddingText ?? c.text));

        const bodies = successfulFiles.map((f) => f.body!);
        const paths = successfulFiles.map((f) => f.path);

        // Always compute BM25 scores on whole-file bodies
        const keywordScoresArr = bm25Scores(query, bodies);
        const keywordRanks = computeRanks(keywordScoresArr, paths);

        let semanticScores: number[] = [];
        let semanticRanks: number[] = [];

        // Attempt embedding — fall back to BM25-only on failure
        try {
          const embeddingRequest = {
            ...embeddingConfig,
            inputs: [query, ...allChunkTexts],
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
            const queryVec = vectors[0];
            const chunkVecs = vectors.slice(1);

            // Map chunk vectors back to parent files, taking max similarity
            let chunkIdx = 0;
            for (let fi = 0; fi < fileChunks.length; fi++) {
              const numChunks = fileChunks[fi].length;
              totalChunks += numChunks;
              if (numChunks > 0) {
                filesChunked++;
                const myChunkVecs = chunkVecs.slice(chunkIdx, chunkIdx + numChunks);
                const { maxScore, bestChunkIndex } = maxChunkSimilarity(queryVec, myChunkVecs);
                semanticScores.push(maxScore);
                const path = successfulFiles[fi].path;
                const fileDetail = fileDetails.get(path)!;
                fileDetail.chunkIndex = bestChunkIndex;
                fileDetail.chunkScore = maxScore;
                const bestChunk = fileChunks[fi][bestChunkIndex];
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
          const base = fileDetails.get(paths[i])!;
          base.keywordRank = keywordRanks[i];
          base.keywordScore = keywordScoresArr[i];
          base.rrfScore = rrfScores[i];
          if (embeddingStatus === "ok") {
            base.semanticRank = semanticRanks[i];
            base.semanticScore = semanticScores[i];
            base.rankedBy = "hybrid";
          } else {
            base.rankedBy = "bm25" as "bm25";
          }
        }

        const relevantPaths = new Set<string>();
        for (let i = 0; i < successfulFiles.length; i++) {
          if (isRelevantCandidate(keywordScoresArr[i], semanticScores[i], embeddingStatus)) {
            relevantPaths.add(paths[i]);
          }
        }
        filteredBelowThresholdPaths = paths.filter((path) => !relevantPaths.has(path));

        const ranksByPath = new Map(paths.map((path, i) => [path, rrfRanks[i]]));

        // Sort by RRF rank
        rankedSuccessOrder = [...paths]
          .filter((path) => relevantPaths.has(path))
          .sort((a, b) => (ranksByPath.get(a) ?? Infinity) - (ranksByPath.get(b) ?? Infinity));
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
        const d = packCandidates[a].fullMetrics.bytes - packCandidates[b].fullMetrics.bytes;
        return d !== 0 ? d : a - b;
      });

      const requestPlan = buildPlan("request-order", requestOrder, packCandidates);
      const smallestPlan = buildPlan("smallest-first", smallestFirstOrder, packCandidates);
      const switchedForCoverage = smallestPlan.fullSuccessCount > requestPlan.fullSuccessCount;
      const plan = switchedForCoverage ? smallestPlan : requestPlan;

      // Build output sections in RRF rank order
      const sections: string[] = [];
      for (let i = 0; i < packCandidates.length; i++) {
        const path = packCandidates[i].path;
        if (plan.fullIncluded.has(i)) {
          sections.push(packCandidates[i].fullText);
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
        },
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
          omittedPaths: plan.omittedIndexes.map((i: number) => packCandidates[i].path),
        },
      };

      return {
        content: [{ type: "text", text: outputText }],
        details,
      };
    },
  } as unknown as ToolDefinition;
}
