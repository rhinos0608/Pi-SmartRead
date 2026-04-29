import { Type, type Static } from "typebox";
import type {
  ExtensionContext,
  ReadToolInput,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createReadTool, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { validateEmbeddingConfig } from "./config.js";
import { type EmbedRequest, type EmbedResult, fetchEmbeddings as defaultFetchEmbeddings } from "./embedding.js";
import { resolveDirectory } from "./resolver.js";
import { bm25Scores, cosineSimilarity, computeRanks, computeRrfScores } from "./scoring.js";
import {
  type FileCandidate,
  buildPlan,
  formatContentBlock,
  measureText,
  validatePath,
} from "./utils.js";

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

type InclusionStatus = "full" | "partial" | "omitted" | "not_top_k" | "error";
type EmbeddingStatus = "ok" | "failed_fallback_bm25";

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
        const resolution = resolveDirectory(params.directory!);
        if (resolution.capped) {
          dirCap = {
            countBeforeCap: resolution.countBeforeCap,
            countAfterCap: resolution.paths.length,
            capped: true,
          };
        }
        resolvedFiles = resolution.paths.map((p) => ({ path: p }));
      } else {
        resolvedFiles = params.files!;
      }

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
        fileDetails.set(f.path, { path: f.path, ok: f.ok, error: f.error });
      }

      let rankedSuccessOrder: string[] = []; // paths in RRF rank order (rank 1 first)

      if (successfulFiles.length > 0) {
        const bodies = successfulFiles.map((f) => f.body!);
        const paths = successfulFiles.map((f) => f.path);

        // Always compute BM25 scores (available for hybrid and fallback paths)
        const keywordScoresArr = bm25Scores(query, bodies);
        const keywordRanks = computeRanks(keywordScoresArr, paths);

        let semanticScores: number[] = [];
        let semanticRanks: number[] = [];
        let rrfScores: number[];
        let rrfRanks: number[];

        // Attempt embedding — fall back to BM25-only on failure
        try {
          const { vectors } = await fetchEmbeddingsImpl({
            ...embeddingConfig,
            inputs: [query, ...bodies],
          });

          if (vectors.length === bodies.length + 1) {
            const queryVec = vectors[0];
            const fileVecs = vectors.slice(1);
            semanticScores = fileVecs.map((v) => cosineSimilarity(queryVec, v));
            semanticRanks = computeRanks(semanticScores, paths);
            embeddingStatus = "ok";
          } else {
            embeddingStatus = "failed_fallback_bm25";
            embeddingError = `Expected ${bodies.length + 1} vectors, got ${vectors.length}`;
          }
        } catch (err) {
          embeddingStatus = "failed_fallback_bm25";
          embeddingError = err instanceof Error ? err.message : String(err);
        }

        if (embeddingStatus === "ok" && semanticRanks.length > 0) {
          rrfScores = computeRrfScores(semanticRanks, keywordRanks);
          rrfRanks = computeRanks(rrfScores, paths);
        } else {
          // BM25-only fallback: single-rank RRF is monotonic with keyword rank
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
          }
        }

        // Sort by RRF rank (ascending rank = descending score)
        rankedSuccessOrder = [...paths].sort((a, b) => {
          const ri = paths.indexOf(a);
          const rj = paths.indexOf(b);
          return rrfRanks[ri] - rrfRanks[rj];
        });
      }

      const effectiveTopK = Math.min(topK, successfulFiles.length);
      const topKPaths = new Set(rankedSuccessOrder.slice(0, effectiveTopK));

      // Mark each file's selection status
      for (const f of fileResults) {
        const detail = fileDetails.get(f.path)!;
        detail.selectedForPacking = f.ok && topKPaths.has(f.path);
        if (!f.ok) {
          detail.inclusion = "error";
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