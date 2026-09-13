/**
 * intent-read.ts — context-driven multi-file read with semantic ranking.
 *
 * Import-cycle safety: this module MUST NOT static-import mcp-registry.ts
 * -- doing so creates a circular ES module dependency:
 *   mcp-registry.ts -> grep-tool.ts -> search-tool.ts -> hook.ts ->
 *   read-many.ts -> intent-read.ts -> mcp-registry.ts
 * which breaks runtime loading with a temporal-dead-zone ReferenceError.
 * mcp-registry is instead imported lazily via dynamic `await import()`
 * inside the function that needs it, after the module graph has
 * finished resolving.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type {
  ExtensionContext,
  ReadToolDetails,
  ReadToolInput,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createReadTool, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { validateEmbeddingConfig } from "../config.js";
import { type EmbedRequest, type EmbedResult, fetchEmbeddings as defaultFetchEmbeddings } from "../indexing/embedding.js";
import { PersistentEmbeddingCache } from "../indexing/persistent-embedding-cache.js";
import { resolveDirectory, presortPathsByQuery } from "../search/resolver.js";
import {
  INTENT_READ_CACHE_SIZE,
  normalizeCandidatePath,
  rankCandidates,
  type EmbeddingStatus,
} from "./intent-ranking.js";
import {
  findDirectImportNeighbours,
} from "../context-graph.js";
import {
  type FileCandidate,
  buildPlan,
  ensureHashlineReady,
  formatContentBlock,
  measureText,
  stripHashlineAnchors,
  selectorToOffsetLimit,
  splitPathAndSelector,
  validatePath,
  LruCache,
} from "../utils.js";
import { probeQuery, type ProbeResult } from "../search/query-probe.js";
import { type HydeResult } from "../search/hyde.js";
import { getGraphifyEnricher } from "../graph/graphify-enricher.js";
import {
  classifyConfidence,
  type ConfidenceClass,
  type RelevanceClass,
} from "../ranking/classifiers.js";

const IntentReadSchema = Type.Object({
  query: Type.String({ description: "The search intent" }),
  files: Type.Optional(
    Type.Array(
      Type.Object({
        path: Type.String({ description: "Path to the file (relative or absolute)" }),
        offset: Type.Optional(Type.Number({ minimum: 0 })),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      { minItems: 1, maxItems: 500 },
    ),
  ),
  directory: Type.Optional(Type.String({ description: "Directory to scan (non-recursive, max 20 files)." })),
  topK: Type.Optional(Type.Number({ minimum: 1, maximum: 10000, description: "Max results to return (default 20)" })),
  stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first read error (default false)" })),
  defaultToCwd: Type.Optional(Type.Boolean({ description: "If true, scan current directory when neither files nor directory is provided (default false)" })),
});

type IntentReadInput = Static<typeof IntentReadSchema>;

type InclusionStatus = "full" | "partial" | "omitted" | "not_top_k" | "below_threshold" | "error";

const MAX_INTENT_READ_FILES = 500;


/** True when cwd looks like a project root (gates graph-heavy expansion). */
function hasProjectMarkerDir(cwd: string): boolean {
  return (
    existsSync(join(cwd, ".git")) ||
    existsSync(join(cwd, "package.json")) ||
    existsSync(join(cwd, "tsconfig.json")) ||
    existsSync(join(cwd, "pyproject.toml")) ||
    existsSync(join(cwd, "Cargo.toml")) ||
    existsSync(join(cwd, "go.mod"))
  );
}

/** Deduplicate explicit file requests by path, preserving first occurrence. */
function dedupeFiles<T extends { path: string }>(files: T[]): T[] {
  const seenPaths = new Set<string>();
  return files.filter((f) => {
    if (seenPaths.has(f.path)) return false;
    seenPaths.add(f.path);
    return true;
  });
}

/** Strip internal numeric scores; public output uses discrete classifiers. */
function toPublicFileDetail(detail: Partial<WorkingIntentReadFileDetail>): IntentReadFileDetail {
  const {
    semanticScore: _semanticScore,
    keywordScore: _keywordScore,
    rrfScore: _rrfScore,
    chunkScore: _chunkScore,
    probeConfidenceScore: _probeConfidenceScore,
    ...publicDetail
  } = detail;
  return publicDetail as IntentReadFileDetail;
}

/** Pick the packing plan covering the most files; tie-break prefers #1 ranked file. */
function choosePackingPlan(packCandidates: FileCandidate[]) {
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
  const candidates = [
    { plan: buildPlan("request-order", requestOrder, packCandidates), name: "request-order" },
    { plan: buildPlan("smallest-first", smallestFirstOrder, packCandidates), name: "smallest-first" },
    { plan: buildPlan("relevance-first", relevanceFirstOrder, packCandidates), name: "relevance-first" },
  ];
  const best = candidates.sort((a, b) => {
    const d = b.plan.fullSuccessCount - a.plan.fullSuccessCount;
    if (d !== 0) return d;
    const aHasTop = a.plan.fullIncluded.has(0) ? 1 : 0;
    const bHasTop = b.plan.fullIncluded.has(0) ? 1 : 0;
    return bHasTop - aHasTop;
  })[0]!;
  return { plan: best.plan, switchedForCoverage: best.name !== "request-order" };
}

interface IntentReadFileDetail {
  path: string;
  ok: boolean;
  error?: string;
  semanticRank?: number;
  semanticRelevance?: RelevanceClass;
  keywordRank?: number;
  keywordRelevance?: RelevanceClass;
  fusedRank?: number;
  fusedRelevance?: RelevanceClass;
  selectedForPacking: boolean;
  included: boolean;
  inclusion: InclusionStatus;
  chunkIndex?: number;
  chunkRelevance?: RelevanceClass;
  rankedBy: "bm25" | "hybrid";
  /** Graph distance from seed files (0 = seed, 1 = import, 2 = symbol neighbour). */
  graphDistance?: number;
  /** Confidence from query probing, bucketed for public output. */
  probeConfidence?: ConfidenceClass;
  /** Additive boost from cross-session ADRs (accepted → +ADR_BOOST). */
  adrBoost?: number;
}

interface WorkingIntentReadFileDetail extends IntentReadFileDetail {
  semanticScore?: number;
  keywordScore?: number;
  rrfScore?: number;
  chunkScore?: number;
  probeConfidenceScore?: number;
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
  graphAugmentation: { addedPaths: string[]; candidateCountBefore: number; candidateCountAfter: number; edgesUsed?: Array<{ from: string; to: string; type: string; confidence: ConfidenceClass }> };
  chunkInfo?: {
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
  adrBoostedCount: number;
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
    description: `Find and read files relevant to a natural-language intent, then pack top results under ${DEFAULT_MAX_LINES} lines / ${formatSize(DEFAULT_MAX_BYTES)}. Internal engine for read_files query mode, e.g. { query: "where refresh tokens are validated", directory: "src", topK: 5 }.`,
    parameters: IntentReadSchema,

    async execute(
      toolCallId: string,
      params: IntentReadInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      // 0. Ensure hashline engine is ready
      await ensureHashlineReady();

      // 1. Validate embedding config — null means baseUrl or model is missing.
      // Degrade gracefully to BM25-only with a loud warning instead of hard-failing.
      // This is the right behaviour for an agentic retrieval tool.
      const embeddingConfig = validateEmbeddingConfig(ctx.cwd);

      if (!embeddingConfig) {
        console.warn(
          "[Pi-SmartRead] Semantic ranking unavailable; falling back to BM25-only ranking.",
        );
      }

      // Embedding API tracking (updated after embed call; may degrade to fallback)
      let embeddingStatus: EmbeddingStatus = "ok";
      let embeddingCacheHit = false;


      // 2. Validate input
      const query = params.query.trim();
      if (!query) throw new Error("query must not be empty or whitespace-only");

      const hasFiles = Array.isArray(params.files) && params.files.length > 0;
      let hasDirectory = typeof params.directory === "string" && params.directory.length > 0;

      if (hasFiles && hasDirectory) {
        throw new Error("Provide either files or directory, not both");
      }

      // Default to cwd when neither files nor directory is provided (defaultToCwd option)
      if (!hasFiles && !hasDirectory) {
        if (params.defaultToCwd) {
          params.directory = ".";
          hasDirectory = true;
        } else {
          throw new Error("Provide either files or directory, or set defaultToCwd to scan current directory");
        }
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
        // Deduplicate by path to prevent silent overwrites in detail map
        resolvedFiles = dedupeFiles(params.files!);
      }

      const candidateCountBeforeGraph = resolvedFiles.length;

      // Project marker detection — gates graph-heavy expansion phases
      // (mutation edges, probe) to avoid wasted work on test stubs.
      // MUST run before graph construction so we can skip the expensive
      // buildContextGraph when no project root is present (e.g. cwd="/" in tests).
      const hasProjectMarker = hasProjectMarkerDir(ctx.cwd);

      // Shared ContextGraph from the canonical mcp-registry singleton (revision-gated,
      // concurrent-build-coalescing). Only build when the graph will actually be
      // consumed (probe needs symbol/call index, mutation needs edge store).
      // Unconditionally building for e.g. cwd="/" triggers a full filesystem scan
      // + tree-sitter parse of every source file, which crashes on adversarial files.
      const needsGraph = hasProjectMarker || embeddingConfig?.probeEnabled === true;
      const { getSharedContextGraphAsync } = await import("../mcp-registry.js");
      const sharedGraph = needsGraph
        ? await getSharedContextGraphAsync(ctx.cwd)
        : null;

      // Tracking sets for structural signals (populated during expansion)
      const probeAddedSet = new Set<string>();
      const graphDistanceMap = new Map<string, number>();

      // Phase 3: Probe phase — extract symbols from query, find definition files.
      // Gated behind config (probeEnabled: true, default off) because probe uses
      // tree-sitter which is expensive and not needed for simple file-scoped queries.
      let probing: ProbeResult | undefined;
      const probeAddedPaths: string[] = [];
      if (embeddingConfig?.probeEnabled === true) {
        const probeSlots = Math.max(0, MAX_INTENT_READ_FILES - resolvedFiles.length);
        if (probeSlots > 0) {
          try {
            probing = await probeQuery(query, {
              maxProbeAdded: Math.min(4, probeSlots),
              graph: sharedGraph!,
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
      if (symbolSlots > 0 && embeddingConfig?.probeEnabled === true) {
        const seedFiles = resolvedFiles.slice(0, candidateCountBeforeGraph);
        for (const seedFile of seedFiles) {
          if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
          try {
            const neighbours = await sharedGraph!.getFileNeighbours(seedFile.path, { includeSymbols: true });
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
      if (callSlots > 0 && embeddingConfig?.probeEnabled === true) {
        const callSeedFiles = resolvedFiles.slice(0, candidateCountBeforeGraph);
        for (const seedFile of callSeedFiles) {
          if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
          try {
            const neighbours = await sharedGraph!.getFileNeighbours(seedFile.path, { includeCalls: true });
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
      // 2d: Graphify neighbor expansion (uses graphify-out/graph.json when available)
      // Finds related files through all edge types (calls, imports, references,
      // conceptually_related_to, etc.) — much richer than regex import scanning alone.
      const graphifySlots = Math.max(0, MAX_INTENT_READ_FILES - resolvedFiles.length);
      if (graphifySlots > 0) {
        try {
          const enricher = getGraphifyEnricher(ctx.cwd);
          if (enricher.isAvailable) {
            const graphifySeedFiles = resolvedFiles.slice(0, candidateCountBeforeGraph);
            for (const seedFile of graphifySeedFiles) {
              if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
              try {
                const related = enricher.getRelatedFilesForPath(seedFile.path);
                for (const rel of related) {
                  if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
                  const normalized = normalizeCandidatePath(ctx.cwd, rel.path);
                  if (existingPaths.has(normalized)) continue;
                  existingPaths.add(normalized);
                  resolvedFiles.push({ path: rel.path });
                  graphEdges.push({ from: seedFile.path, to: rel.path, type: rel.relation, confidence: rel.confidenceScore });
                  graphDistanceMap.set(normalized, 2);
                }
              } catch { /* skip individual failures */ }
            }
          }
        } catch { /* graphify unavailable — skip silently */ }
      }
      const addedGraphPaths = resolvedFiles.slice(candidateCountBeforeGraph).map((file) => file.path);

      // 2e: Mutation edge expansion (breakage + co-change from Smart-Edit feedback loop)
      // These edges are observed from post-edit diagnostic cascades and git history co-change
      // analysis — empirical coupling signals not captured by static analysis.
      const mutationSlots = Math.max(0, MAX_INTENT_READ_FILES - resolvedFiles.length);
      if (mutationSlots > 0 && hasProjectMarker) {
        // Use sharedGraph's getMutationNeighbours which reads from EdgeStore
        const mutationSeedFiles = resolvedFiles.slice(0, candidateCountBeforeGraph);
        for (const seedFile of mutationSeedFiles) {
          if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
          try {
            const neighbours = sharedGraph!.getMutationNeighbours(seedFile.path);
            for (const n of neighbours) {
              if (resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
              const normalized = normalizeCandidatePath(ctx.cwd, n.path);
              if (existingPaths.has(normalized)) continue;
              existingPaths.add(normalized);
              resolvedFiles.push({ path: n.path });
              graphEdges.push({
                from: seedFile.path,
                to: n.path,
                type: n.provenance.type,
                confidence: n.provenance.confidence,
              });
              graphDistanceMap.set(normalized, 2);
            }
          } catch { /* skip individual failures */ }
        }
      }

      // 4. Read files
      const readTool = readToolFactory(ctx.cwd);
      interface FileReadResult {
        path: string;
        displayPath: string;
        ok: boolean;
        body?: string;
        renderedBody?: string;
        startLine?: number;
        anchorBody?: boolean;
        error?: string;
      }
      const fileResults: FileReadResult[] = [];

      const CONCURRENCY = 6;
      // Pre-allocate to maintain insertion order across parallel batches
      const orderedResults: (FileReadResult | undefined)[] = new Array(resolvedFiles.length);

      for (let batchStart = 0; batchStart < resolvedFiles.length; batchStart += CONCURRENCY) {
        if (signal?.aborted) throw new Error("Operation aborted");

        const batchEnd = Math.min(batchStart + CONCURRENCY, resolvedFiles.length);
        const batchPromises: Promise<void>[] = [];

        for (let j = batchStart; j < batchEnd; j++) {
          const i = j;
          const req = resolvedFiles[i]!;
          batchPromises.push(
            (async () => {
              try {
                const { path: targetPath, selector } = splitPathAndSelector(req.path);
                validatePath(targetPath);
                const selectorArgs = selectorToOffsetLimit(selector);
                const rawMode = selectorArgs.raw === true;
                const input: ReadToolInput = {
                  path: targetPath,
                  offset: selectorArgs.offset ?? req.offset,
                  limit: selectorArgs.limit ?? req.limit,
                };
                const result = await readTool.execute(`${toolCallId}:${i}`, input, signal, undefined);
                const details = result.details as ReadToolDetails | undefined;
                const displayContent = (
                  details as { displayContent?: { text?: string; startLine?: number } } | undefined
                )?.displayContent;

                const renderedBody = displayContent?.text ?? result.content
                  .filter((item): item is { type: "text"; text: string } => item.type === "text")
                  .map((item) => item.text)
                  .join("\n");
                const firstFewLines = renderedBody.split("\n", 5).join("\n");
                const alreadyAnchored = /^\d+[a-z]{0,2}\|/m.test(firstFewLines);
                let body = displayContent?.text ?? renderedBody;
                const startLine = displayContent?.startLine ?? selectorArgs.offset ?? req.offset ?? 1;
                if (!body) {
                  body = "[No text content]";
                }
                const rawBody = alreadyAnchored ? stripHashlineAnchors(body) : body;
                const displayPath = req.path;

                orderedResults[i] = {
                  path: targetPath,
                  displayPath,
                  ok: true,
                  body: rawBody,
                  renderedBody: body,
                  startLine,
                  anchorBody: rawMode ? false : !alreadyAnchored,
                };
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                orderedResults[i] = { path: req.path, displayPath: req.path, ok: false, error: message };
              }
            })(),
          );
        }

        await Promise.allSettled(batchPromises);

        // stopOnError: throw first error after batch completes
        if (params.stopOnError) {
          for (let j = batchStart; j < batchEnd; j++) {
            const r = orderedResults[j];
            if (r && !r.ok) {
              throw new Error(r.error);
            }
          }
        }
      }

      // Collect results in original order
      for (const r of orderedResults) {
        if (r) fileResults.push(r);
      }

      const successfulFiles = fileResults.filter((f) => f.ok);
      const erroredFiles = fileResults.filter((f) => !f.ok);

      // 5. Embed + score (skip if no successful files)
      const fileDetails = new Map<string, Partial<WorkingIntentReadFileDetail>>();
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
        relevance: RelevanceClass;
        startChar: number;
        endChar: number;
        preview: string;
      }[] = [];

      // AST chunking tracking (populated inside the if-block)
      let astChunkingUsed = false;
      let astChunkingStats = { usedAst: false, wasmAvailable: false, parseTimeMs: 0, symbolCount: 0 };

      // HyDE tracking (populated inside the if-block)
      let hydeResult: HydeResult = { document: query, applied: false, pattern: "none", identifiers: [] };

      // WP-8: ADR boost tracking (populated inside the if-block)
      let adrBoosts: number[] = [];

      const rankResult = await rankCandidates({
        query,
        files: successfulFiles,
        embeddingConfig,
        cwd: ctx.cwd,
        embeddingLruCache,
        persistentCaches,
        fetchEmbeddingsImpl,
        probeAddedSet,
        graphDistanceMap,
        fileDetails,
      });
      embeddingStatus = rankResult.embeddingStatus;
      const embeddingError = rankResult.embeddingError;
      embeddingCacheHit = rankResult.embeddingCacheHit;
      rankedSuccessOrder = rankResult.rankedSuccessOrder;
      filteredBelowThresholdPaths = rankResult.filteredBelowThresholdPaths;
      totalChunks = rankResult.totalChunks;
      filesChunked = rankResult.filesChunked;
      bestChunkByFile.push(...rankResult.bestChunkByFile);
      astChunkingUsed = rankResult.astChunkingUsed;
      astChunkingStats = rankResult.astChunkingStats;
      hydeResult = rankResult.hydeResult;
      adrBoosts = rankResult.adrBoosts;
      const rerankingResult = rankResult.rerankingResult;
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
        const body = f.renderedBody ?? f.body!;
        const displayPath = f.displayPath;
        const fullText = formatContentBlock(displayPath, body, i + 1, {
          anchorBody: f.anchorBody ?? true,
          startLine: f.startLine ?? 1,
        });
        return {
          index: i,
          path,
          ok: true,
          fullText,
          fullMetrics: measureText(fullText),
          body,
        };
      });

      const { plan, switchedForCoverage } = choosePackingPlan(packCandidates);

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

      // 7. Build details.files: successful files in RRF order, then errored files in input order.
      const allFileDetails: IntentReadFileDetail[] = [
        ...rankedSuccessOrder.map((path: string) => toPublicFileDetail(fileDetails.get(path)!)),
        ...filteredBelowThresholdPaths.map((path: string) => toPublicFileDetail(fileDetails.get(path)!)),
        ...erroredFiles.map((f: FileReadResult) => toPublicFileDetail(fileDetails.get(f.path)!)),
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
          ...(graphEdges.length > 0 && {
            edgesUsed: graphEdges.map((edge) => ({
              ...edge,
              confidence: classifyConfidence(edge.confidence),
            })),
          }),
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
        adrBoostedCount: adrBoosts.filter((b) => b > 0).length,
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
