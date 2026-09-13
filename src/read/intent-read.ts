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
  type RankCandidatesResult,
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
import type { ContextGraph } from "../context-graph.js";
import {
  classifyConfidence,
  type ConfidenceClass,
  type RelevanceClass,
} from "../ranking/classifiers.js";
import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { aggregateBatchEvidence } from "../evidence/read-many-evidence.js";
import { sessionFileFromContext } from "../inspect/inspect-tool.js";

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

/** Explicit file request with optional hashline selector window. */
interface ResolvedFile { path: string; offset?: number; limit?: number; }

/** Per-file read outcome (raw + rendered bodies plus evidence). */
interface FileReadResult {
  path: string;
  displayPath: string;
  ok: boolean;
  body?: string;
  renderedBody?: string;
  startLine?: number;
  anchorBody?: boolean;
  error?: string;
  evidence?: WorkspaceEvidenceEnvelope;
}

/** Directory-scan cap bookkeeping. */
interface DirCap { countBeforeCap: number; countAfterCap: number; capped: boolean; }

/** Mutable orchestration state shared by execute-phase helpers. */
interface IntentExecuteState {
  toolCallId: string;
  signal: AbortSignal | undefined;
  ctx: ExtensionContext;
  query: string;
  topK: number;
  stopOnError: boolean;
  resolvedFiles: ResolvedFile[];
  candidateCountBeforeGraph: number;
  hasProjectMarker: boolean;
  embeddingConfig: ReturnType<typeof validateEmbeddingConfig>;
  sharedGraph: ContextGraph | null;
  probeAddedSet: Set<string>;
  graphDistanceMap: Map<string, number>;
  graphEdges: Array<{ from: string; to: string; type: string; confidence: number }>;
  existingPaths: Set<string>;
  probing?: ProbeResult;
  probeAddedPaths: string[];
  readToolFactory: typeof createReadTool;
  fetchEmbeddingsImpl: (req: EmbedRequest) => Promise<EmbedResult>;
  publishInspection?: IntentReadToolOptions["publishInspection"];
  embeddingLruCache: LruCache<EmbedResult>;
  persistentCaches: LruCache<PersistentEmbeddingCache>;
}

/** Lazily import the shared context graph (avoids a static import cycle). */
async function importSharedGraph(): Promise<(root: string) => Promise<ContextGraph>> {
  const { getSharedContextGraphAsync } = await import("../mcp-registry.js");
  return getSharedContextGraphAsync;
}

/** Resolve which source supplies candidates; returns default dir instead of mutating params. */
function resolveIntentSource(
  params: IntentReadInput,
  hasFiles: boolean,
  hasDirectory: boolean,
): { hasDirectory: boolean; directory?: string } {
  if (hasFiles && hasDirectory) {
    throw new Error("Provide either files or directory, not both");
  }
  if (hasFiles || hasDirectory) return { hasDirectory, directory: params.directory };
  if (params.defaultToCwd) {
    return { hasDirectory: true, directory: "." };
  }
  throw new Error("Provide either files or directory, or set defaultToCwd to scan current directory");
}

/** Validate intent input; throws on empty query or conflicting sources. */
function validateIntentRequest(params: IntentReadInput): {
  query: string;
  hasFiles: boolean;
  hasDirectory: boolean;
  directory?: string;
  topK: number;
} {
  const query = params.query.trim();
  if (!query) throw new Error("query must not be empty or whitespace-only");
  const hasFiles = Array.isArray(params.files) && params.files.length > 0;
  const { hasDirectory, directory } = resolveIntentSource(
    params,
    hasFiles,
    typeof params.directory === "string" && params.directory.length > 0,
  );
  return { query, hasFiles, hasDirectory, directory, topK: params.topK ?? 20 };
}

/** Resolve explicit files or a scanned directory into candidate paths. */
function resolveIntentCandidates(
  params: IntentReadInput,
  query: string,
  hasDirectory: boolean,
  cwd: string,
  directory?: string,
): { resolvedFiles: ResolvedFile[]; dirCap: DirCap | undefined } {
  if (!hasDirectory) return { resolvedFiles: dedupeFiles(params.files!), dirCap: undefined };
  const resolution = resolveDirectory(normalizeCandidatePath(cwd, directory!));
  const dirCap: DirCap | undefined = resolution.capped
    ? {
      countBeforeCap: resolution.countBeforeCap,
      countAfterCap: resolution.paths.length,
      capped: true,
    }
    : undefined;
  const reordered = presortPathsByQuery(
    resolution.paths.map((p) => p),
    query,
  );
  return { resolvedFiles: reordered.map((p) => ({ path: p })), dirCap };
}

/** Remaining budget before hitting the file cap. */
function intentSlots(state: IntentExecuteState): number {
  return Math.max(0, MAX_INTENT_READ_FILES - state.resolvedFiles.length);
}

/** Arguments for recording a neighbour file (single-param helper shape). */
interface NeighbourRecord {
  seedPath: string;
  neighbourPath: string;
  edgeType: string;
  confidence: number;
  distance: number;
}

/** Record a newly discovered neighbour file with its provenance edge. */
function addNeighbourFile(state: IntentExecuteState, record: NeighbourRecord): boolean {
  const normalized = normalizeCandidatePath(state.ctx.cwd, record.neighbourPath);
  if (state.existingPaths.has(normalized)) return false;
  if (state.resolvedFiles.length >= MAX_INTENT_READ_FILES) return false;
  state.existingPaths.add(normalized);
  state.resolvedFiles.push({ path: record.neighbourPath });
  state.graphEdges.push({
    from: record.seedPath,
    to: record.neighbourPath,
    type: record.edgeType,
    confidence: record.confidence,
  });
  state.graphDistanceMap.set(normalized, record.distance);
  return true;
}

/** Merge successful probe definition files into the candidate list. */
function applyProbeResults(state: IntentExecuteState): void {
  if (state.probing?.status !== "ok" || state.probing.addedPaths.length === 0) return;
  const seen = new Set(state.resolvedFiles.map((file) => normalizeCandidatePath(state.ctx.cwd, file.path)));
  for (const probePath of state.probing.addedPaths) {
    if (seen.has(probePath) || state.resolvedFiles.length >= MAX_INTENT_READ_FILES) continue;
    seen.add(probePath);
    state.resolvedFiles.push({ path: probePath });
    state.probeAddedPaths.push(probePath);
    state.probeAddedSet.add(normalizeCandidatePath(state.ctx.cwd, probePath));
  }
}

/** Record a failed probe outcome without failing the read. */
function markProbeFailed(state: IntentExecuteState, err: unknown): void {
  state.probing = {
    status: "failed",
    strategy: "symbols",
    inferredSymbols: [],
    addedPaths: [],
    warnings: [err instanceof Error ? err.message : String(err)],
  };
}

/** Probe phase: extract symbols from the query, add definition files. */
async function runIntentProbe(state: IntentExecuteState): Promise<void> {
  if (state.embeddingConfig?.probeEnabled !== true) return;
  if (intentSlots(state) <= 0) return;
  try {
    state.probing = await probeQuery(state.query, {
      maxProbeAdded: Math.min(4, intentSlots(state)),
      graph: state.sharedGraph!,
    });
    applyProbeResults(state);
  } catch (err) {
    markProbeFailed(state, err);
  }
}

/** Snapshot per-seed import lists to attribute neighbours without rescans. */
function snapshotSeedImports(state: IntentExecuteState): Map<string, string[]> {
  const seedFileToImports = new Map<string, string[]>();
  for (const file of state.resolvedFiles) {
    try {
      seedFileToImports.set(
        file.path,
        findDirectImportNeighbours(state.ctx.cwd, [file.path], MAX_INTENT_READ_FILES),
      );
    } catch {
      seedFileToImports.set(file.path, []);
    }
  }
  return seedFileToImports;
}

/** Attribute one import neighbour to its seed file and record it. */
function recordImportNeighbour(
  state: IntentExecuteState,
  seedFileToImports: Map<string, string[]>,
  graphPath: string,
): void {
  const seedFile = state.resolvedFiles.find((f) => seedFileToImports.get(f.path)?.includes(graphPath));
  addNeighbourFile(state, {
    seedPath: seedFile ? seedFile.path : state.ctx.cwd,
    neighbourPath: graphPath,
    edgeType: "imports",
    confidence: 1.0,
    distance: 1,
  });
}

/** Import-neighbour expansion (fast regex-based batch scan). */
function expandImportNeighbours(state: IntentExecuteState): void {
  const seedFileToImports = snapshotSeedImports(state);
  const neighbours = findDirectImportNeighbours(
    state.ctx.cwd,
    state.resolvedFiles.map((file) => file.path),
    intentSlots(state),
  );
  for (const graphPath of neighbours) recordImportNeighbour(state, seedFileToImports, graphPath);
}

/** Record one batch of index neighbours for a seed file. */
function recordIndexNeighbours(
  state: IntentExecuteState,
  seedPath: string,
  neighbours: Array<{ path: string; provenance: { type: string; confidence: number } }>,
): void {
  for (const n of neighbours) {
    if (state.resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
    addNeighbourFile(state, {
      seedPath,
      neighbourPath: n.path,
      edgeType: n.provenance.type,
      confidence: n.provenance.confidence,
      distance: 2,
    });
  }
}

/** Index-neighbour expansion via the shared graph (symbols and/or calls). */
async function expandIndexedNeighbours(
  state: IntentExecuteState,
  selector: { includeSymbols?: boolean; includeCalls?: boolean },
): Promise<void> {
  if (intentSlots(state) <= 0 || state.embeddingConfig?.probeEnabled !== true) return;
  for (const seedFile of state.resolvedFiles.slice(0, state.candidateCountBeforeGraph)) {
    if (state.resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
    try {
      recordIndexNeighbours(state, seedFile.path, await state.sharedGraph!.getFileNeighbours(seedFile.path, selector));
    } catch { /* skip individual failures */ }
  }
}

/** Symbol-neighbour expansion via the shared graph index. */
async function expandSymbolNeighbours(state: IntentExecuteState): Promise<void> {
  await expandIndexedNeighbours(state, { includeSymbols: true });
}

/** Call-graph neighbour expansion for high-confidence function symbols. */
async function expandCallNeighbours(state: IntentExecuteState): Promise<void> {
  await expandIndexedNeighbours(state, { includeCalls: true });
}

/** Graphify neighbour expansion (all edge types from graphify-out/graph.json). */
function expandGraphifyNeighbours(state: IntentExecuteState): void {
  if (intentSlots(state) <= 0) return;
  try {
    const enricher = getGraphifyEnricher(state.ctx.cwd);
    if (!enricher.isAvailable) return;
    for (const seedFile of state.resolvedFiles.slice(0, state.candidateCountBeforeGraph)) {
      if (state.resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
      try {
        for (const rel of enricher.getRelatedFilesForPath(seedFile.path)) {
          if (state.resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
          addNeighbourFile(state, {
            seedPath: seedFile.path,
            neighbourPath: rel.path,
            edgeType: rel.relation,
            confidence: rel.confidenceScore,
            distance: 2,
          });
        }
      } catch { /* skip individual failures */ }
    }
  } catch { /* graphify unavailable — skip silently */ }
}

/** Mutation-edge expansion (breakage + co-change from Smart-Edit feedback). */
function expandMutationNeighbours(state: IntentExecuteState): void {
  if (intentSlots(state) <= 0 || !state.hasProjectMarker) return;
  for (const seedFile of state.resolvedFiles.slice(0, state.candidateCountBeforeGraph)) {
    if (state.resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
    try {
      for (const n of state.sharedGraph!.getMutationNeighbours(seedFile.path)) {
        if (state.resolvedFiles.length >= MAX_INTENT_READ_FILES) break;
        addNeighbourFile(state, {
          seedPath: seedFile.path,
          neighbourPath: n.path,
          edgeType: n.provenance.type,
          confidence: n.provenance.confidence,
          distance: 2,
        });
      }
    } catch { /* skip individual failures */ }
  }
}

/** Parsed read request for one candidate file. */
interface ParsedIntentRequest {
  targetPath: string;
  input: ReadToolInput;
  rawMode: boolean;
  selectorOffset?: number;
  reqOffset?: number;
}

/** Split path/selector and validate; throws on bad paths. */
function parseIntentRequest(req: ResolvedFile): ParsedIntentRequest {
  const { path: targetPath, selector } = splitPathAndSelector(req.path);
  validatePath(targetPath);
  const selectorArgs = selectorToOffsetLimit(selector);
  return {
    targetPath,
    input: {
      path: targetPath,
      offset: selectorArgs.offset ?? req.offset,
      limit: selectorArgs.limit ?? req.limit,
    },
    rawMode: selectorArgs.raw === true,
    selectorOffset: selectorArgs.offset,
    reqOffset: req.offset,
  };
}

/** Rendered body parts extracted from a read result. */
interface RenderedIntentBody {
  body: string;
  renderedBody: string;
  startLine: number;
  alreadyAnchored: boolean;
  evidence?: WorkspaceEvidenceEnvelope;
}

/** Extract display body, anchor state, and evidence from a read result. */
function extractIntentBody(
  result: Awaited<ReturnType<ReturnType<typeof createReadTool>["execute"]>>,
  parsed: ParsedIntentRequest,
): RenderedIntentBody {
  const details = result.details as ReadToolDetails | undefined;
  const displayContent = (
    details as { displayContent?: { text?: string; startLine?: number } } | undefined
  )?.displayContent;
  const evidence = (
    result.details as { workspaceEvidence?: WorkspaceEvidenceEnvelope } | undefined
  )?.workspaceEvidence;
  const renderedBody = displayContent?.text ?? result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const firstFewLines = renderedBody.split("\n", 5).join("\n");
  const alreadyAnchored = /^\d+[a-z]{0,2}\|/m.test(firstFewLines);
  const body = displayContent?.text ?? renderedBody;
  return {
    body: body || "[No text content]",
    renderedBody: body || "[No text content]",
    startLine: displayContent?.startLine ?? parsed.selectorOffset ?? parsed.reqOffset ?? 1,
    alreadyAnchored,
    ...(evidence && { evidence }),
  };
}

/** Read one candidate file; returns an ordered result entry. */
async function readIntentFile(
  state: IntentExecuteState,
  readTool: ReturnType<typeof createReadTool>,
  index: number,
): Promise<FileReadResult> {
  const req = state.resolvedFiles[index]!;
  try {
    const parsed = parseIntentRequest(req);
    const result = await readTool.execute(`${state.toolCallId}:${index}`, parsed.input, state.signal, undefined);
    const extracted = extractIntentBody(result, parsed);
    const rawBody = extracted.alreadyAnchored ? stripHashlineAnchors(extracted.body) : extracted.body;
    return {
      path: parsed.targetPath,
      displayPath: req.path,
      ok: true,
      body: rawBody,
      renderedBody: extracted.renderedBody,
      startLine: extracted.startLine,
      anchorBody: parsed.rawMode ? false : !extracted.alreadyAnchored,
      ...(extracted.evidence && { evidence: extracted.evidence }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { path: req.path, displayPath: req.path, ok: false, error: message };
  }
}

/** Throw the first read error in a completed batch when stopOnError is set. */
function throwOnBatchError(
  ordered: (FileReadResult | undefined)[],
  batchStart: number,
  batchEnd: number,
): void {
  for (let j = batchStart; j < batchEnd; j++) {
    const r = ordered[j];
    if (r && !r.ok) throw new Error(r.error);
  }
}

/** Read one batch window concurrently into the shared ordered slots. */
async function readIntentBatch(
  state: IntentExecuteState,
  readTool: ReturnType<typeof createReadTool>,
  ordered: (FileReadResult | undefined)[],
  batchStart: number,
  batchEnd: number,
): Promise<void> {
  const batch: Promise<void>[] = [];
  for (let j = batchStart; j < batchEnd; j++) {
    const i = j;
    batch.push(
      readIntentFile(state, readTool, i).then((r) => {
        ordered[i] = r;
      }),
    );
  }
  await Promise.allSettled(batch);
  if (state.stopOnError) throwOnBatchError(ordered, batchStart, batchEnd);
}

/** Read all candidates in bounded-concurrency batches, preserving order. */
async function readIntentFiles(state: IntentExecuteState): Promise<FileReadResult[]> {
  const readTool = state.readToolFactory(state.ctx.cwd);
  const ordered: (FileReadResult | undefined)[] = new Array(state.resolvedFiles.length);
  const CONCURRENCY = 6;
  for (let batchStart = 0; batchStart < state.resolvedFiles.length; batchStart += CONCURRENCY) {
    if (state.signal?.aborted) throw new Error("Operation aborted");
    await readIntentBatch(
      state,
      readTool,
      ordered,
      batchStart,
      Math.min(batchStart + CONCURRENCY, state.resolvedFiles.length),
    );
  }
  return ordered.filter((r): r is FileReadResult => r !== undefined);
}

/** Mark selection status for files outside the packed top-K. */
function markUnpackedFiles(
  fileResults: FileReadResult[],
  fileDetails: Map<string, Partial<WorkingIntentReadFileDetail>>,
  topKPaths: Set<string>,
  filteredBelowThresholdPaths: string[],
): void {
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
  }
}

/** Pack top-K candidates into output sections in rank order. */
function packIntentSections(
  packCandidates: FileCandidate[],
  plan: ReturnType<typeof buildPlan>,
  fileDetails: Map<string, Partial<WorkingIntentReadFileDetail>>,
): string[] {
  const sections: string[] = [];
  for (let i = 0; i < packCandidates.length; i++) {
    const path = packCandidates[i]!.path;
    const d = fileDetails.get(path)!;
    if (plan.fullIncluded.has(i)) {
      sections.push(packCandidates[i]!.fullText);
      d.inclusion = "full";
      d.included = true;
    } else if (plan.partialSection?.index === i) {
      sections.push(plan.partialSection.text);
      d.inclusion = "partial";
      d.included = true;
    } else {
      d.inclusion = "omitted";
      d.included = false;
    }
  }
  return sections;
}

/** Build pack candidates in RRF rank order with formatted content blocks. */
function buildPackCandidates(
  rankedSuccessOrder: string[],
  successfulFiles: FileReadResult[],
): FileCandidate[] {
  return rankedSuccessOrder.map((path, i) => {
    const f = successfulFiles.find((x) => x.path === path)!;
    const body = f.renderedBody ?? f.body!;
    const fullText = formatContentBlock(f.displayPath, body, i + 1, {
      anchorBody: f.anchorBody ?? true,
      startLine: f.startLine ?? 1,
    });
    return { index: i, path, ok: true, fullText, fullMetrics: measureText(fullText), body };
  });
}

/** Order public file details: ranked successes, filtered, then errors. */
function buildIntentFileDetails(
  rankedSuccessOrder: string[],
  filteredBelowThresholdPaths: string[],
  erroredFiles: FileReadResult[],
  fileDetails: Map<string, Partial<WorkingIntentReadFileDetail>>,
): IntentReadFileDetail[] {
  return [
    ...rankedSuccessOrder.map((path: string) => toPublicFileDetail(fileDetails.get(path)!)),
    ...filteredBelowThresholdPaths.map((path: string) => toPublicFileDetail(fileDetails.get(path)!)),
    ...erroredFiles.map((f: FileReadResult) => toPublicFileDetail(fileDetails.get(f.path)!)),
  ];
}

/** Single-argument bundle for details assembly (avoids excess-arity flags). */
interface IntentDetailsArgs {
  query: string;
  fileResults: FileReadResult[];
  successfulFiles: FileReadResult[];
  erroredFiles: FileReadResult[];
  topK: number;
  effectiveTopK: number;
  dirCap: DirCap | undefined;
  embeddingStatus: EmbeddingStatus;
  embeddingError?: string;
  embeddingCacheHit: boolean;
  embeddingLruCache: LruCache<EmbedResult>;
  persistentCaches: LruCache<PersistentEmbeddingCache>;
  cwd: string;
  filteredBelowThresholdPaths: string[];
  addedGraphPaths: string[];
  candidateCountBeforeGraph: number;
  resolvedCount: number;
  graphEdges: IntentExecuteState["graphEdges"];
  probing?: ProbeResult;
  hydeResult: HydeResult;
  rerankingResult?: RankCandidatesResult["rerankingResult"];
  totalChunks: number;
  filesChunked: number;
  bestChunkByFile: RankCandidatesResult["bestChunkByFile"];
  astChunkingUsed: boolean;
  astChunkingStats: { usedAst: boolean; wasmAvailable: boolean; parseTimeMs: number; symbolCount: number };
  allFileDetails: IntentReadFileDetail[];
  adrBoosts: number[];
  plan: ReturnType<typeof buildPlan>;
  switchedForCoverage: boolean;
  packCandidates: FileCandidate[];
}

/** Assemble the IntentReadDetails object from ranked/packed outcomes. */
function assembleIntentDetails(args: IntentDetailsArgs): IntentReadDetails {
  const partialIncludedPath = args.plan.partialSection !== undefined
    ? args.packCandidates[args.plan.partialSection.index]?.path
    : undefined;
  return {
    query: args.query,
    processedCount: args.fileResults.length,
    successCount: args.successfulFiles.length,
    errorCount: args.erroredFiles.length,
    requestedTopK: args.topK,
    effectiveTopK: args.effectiveTopK,
    ...(args.dirCap && {
      candidateCountBeforeCap: args.dirCap.countBeforeCap,
      candidateCountAfterCap: args.dirCap.countAfterCap,
      capped: true,
    }),
    embeddingStatus: args.embeddingStatus,
    ...(args.embeddingError && { embeddingError: args.embeddingError }),
    rankingSignals: {
      bm25: true,
      embeddings: args.embeddingStatus === "ok",
    },
    chunkingEnabled: args.embeddingStatus === "ok",
    astChunking: args.astChunkingUsed ? args.astChunkingStats : undefined,
    embeddingCache: {
      hit: args.embeddingCacheHit,
      size: args.embeddingLruCache.size,
      maxSize: args.embeddingLruCache.maxSize,
      persistent: args.persistentCaches.get(args.cwd)?.hasPersistence ?? false,
      diskEntries: args.persistentCaches.get(args.cwd)?.diskEntries ?? 0,
    },
    filteredBelowThresholdPaths: args.filteredBelowThresholdPaths,
    graphAugmentation: {
      addedPaths: args.addedGraphPaths,
      candidateCountBefore: args.candidateCountBeforeGraph,
      candidateCountAfter: args.resolvedCount,
      ...(args.graphEdges.length > 0 && {
        edgesUsed: args.graphEdges.map((edge) => ({
          ...edge,
          confidence: classifyConfidence(edge.confidence),
        })),
      }),
    },
    ...(args.probing && { probing: args.probing }),
    ...(args.hydeResult.applied && { hyde: args.hydeResult }),
    ...(args.rerankingResult && { reranking: args.rerankingResult }),
    ...(args.embeddingStatus === "ok" && args.filesChunked > 0 && {
      chunkInfo: {
        totalChunks: args.totalChunks,
        filesChunked: args.filesChunked,
        bestChunkByFile: args.bestChunkByFile,
      },
    }),
    files: args.allFileDetails,
    adrBoostedCount: args.adrBoosts.filter((b) => b > 0).length,
    packing: {
      strategy: args.plan.strategy,
      switchedForCoverage: args.switchedForCoverage,
      fullIncludedCount: args.plan.fullCount,
      fullIncludedSuccessCount: args.plan.fullSuccessCount,
      partialIncludedPath,
      omittedPaths: args.plan.omittedIndexes.map((i: number) => args.packCandidates[i]!.path),
    },
  };
}

/** Collect per-file evidence envelopes for packed indexes. */
function collectPackEvidence(
  packCandidates: FileCandidate[],
  fileResults: FileReadResult[],
): Map<number, WorkspaceEvidenceEnvelope> {
  const perFileByPackIndex = new Map<number, WorkspaceEvidenceEnvelope>();
  for (let i = 0; i < packCandidates.length; i++) {
    const evidence = fileResults.find((f) => f.path === packCandidates[i]!.path)?.evidence;
    if (evidence) perFileByPackIndex.set(i, evidence);
  }
  return perFileByPackIndex;
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

/**
 * Options for {@link createIntentReadTool}. Mirrors the read_files
 * publish hook so a single callback can collect batch evidence from
 * intent reads.
 */
export interface IntentReadToolOptions {
  readonly publishInspection?: (
    envelope: WorkspaceEvidenceEnvelope,
    sessionFilePath: string,
    workspaceRoot: string,
  ) => void;
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
  /**
   * Batch envelope aggregating per-file evidence for fully-included
   * files only (mirrors the read_files contract). Partially-included
   * files are excluded: their packed window is derived after the
   * original read, so no authority is safer than overstated authority.
   * Absent when no per-file read produced a usable envelope.
   */
  workspaceEvidence?: WorkspaceEvidenceEnvelope;
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
  opts: IntentReadToolOptions = {},
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

      // 2. Validate input
      const { query, hasDirectory, directory, topK } = validateIntentRequest(params);

      // 3. Resolve candidates
      const { resolvedFiles, dirCap } = resolveIntentCandidates(params, query, hasDirectory, ctx.cwd, directory);
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
      const getSharedContextGraphAsync = await importSharedGraph();
      const sharedGraph = needsGraph
        ? await getSharedContextGraphAsync(ctx.cwd)
        : null;

      const state: IntentExecuteState = {
        toolCallId,
        signal,
        ctx,
        query,
        topK,
        stopOnError: params.stopOnError ?? false,
        resolvedFiles,
        candidateCountBeforeGraph,
        hasProjectMarker,
        embeddingConfig,
        sharedGraph,
        probeAddedSet: new Set<string>(),
        graphDistanceMap: new Map<string, number>(),
        graphEdges: [],
        existingPaths: new Set(
          resolvedFiles.map((file) => normalizeCandidatePath(ctx.cwd, file.path)),
        ),
        probing: undefined,
        probeAddedPaths: [],
        readToolFactory,
        fetchEmbeddingsImpl,
        publishInspection: opts.publishInspection,
        embeddingLruCache,
        persistentCaches,
      };

      // Phase 3: Probe phase — extract symbols from query, find definition files.
      await runIntentProbe(state);

      // Phase 2: Graph neighbour expansion (imports + symbols)
      // 2a: Import neighbours (fast, regex-based batch scan)
      expandImportNeighbours(state);

      // 2b: Symbol neighbours (uses pre-built symbol index from shared graph)
      await expandSymbolNeighbours(state);
      // 2c: Call graph neighbours (caller/callee expansion for high-confidence function symbols)
      await expandCallNeighbours(state);
      // 2d: Graphify neighbor expansion (uses graphify-out/graph.json when available)
      // Finds related files through all edge types (calls, imports, references,
      // conceptually_related_to, etc.) — much richer than regex import scanning alone.
      expandGraphifyNeighbours(state);
      const addedGraphPaths = state.resolvedFiles.slice(candidateCountBeforeGraph).map((file) => file.path);

      // 2e: Mutation edge expansion (breakage + co-change from Smart-Edit feedback loop)
      // These edges are observed from post-edit diagnostic cascades and git history co-change
      // analysis — empirical coupling signals not captured by static analysis.
      // Uses sharedGraph's getMutationNeighbours which reads from EdgeStore.
      expandMutationNeighbours(state);

      // 4. Read files
      const fileResults = await readIntentFiles(state);
      const successfulFiles = fileResults.filter((f) => f.ok);
      const erroredFiles = fileResults.filter((f) => !f.ok);

      // 5. Embed + score (skip if no successful files)
      const fileDetails = new Map<string, Partial<WorkingIntentReadFileDetail>>();
      for (const f of fileResults) {
        fileDetails.set(f.path, { path: f.path, ok: f.ok, error: f.error, rankedBy: "bm25" });
      }

      const rankResult = await rankCandidates({
        query: state.query,
        files: successfulFiles,
        embeddingConfig: state.embeddingConfig,
        cwd: ctx.cwd,
        embeddingLruCache: state.embeddingLruCache,
        persistentCaches: state.persistentCaches,
        fetchEmbeddingsImpl: state.fetchEmbeddingsImpl,
        probeAddedSet: state.probeAddedSet,
        graphDistanceMap: state.graphDistanceMap,
        fileDetails,
      });
      const rankedSuccessOrder = rankResult.rankedSuccessOrder;
      const filteredBelowThresholdPaths = rankResult.filteredBelowThresholdPaths;
      const effectiveTopK = Math.min(state.topK, rankedSuccessOrder.length);
      const topKPaths = new Set(rankedSuccessOrder.slice(0, effectiveTopK));

      // Mark each file's selection status; top-K inclusion is set after packing.
      markUnpackedFiles(fileResults, fileDetails, topKPaths, filteredBelowThresholdPaths);

      // 6. Pack top-K files using buildPlan (in RRF rank order)
      const packCandidates = buildPackCandidates(rankedSuccessOrder.slice(0, effectiveTopK), successfulFiles);
      const { plan, switchedForCoverage } = choosePackingPlan(packCandidates);

      // Build output sections in RRF rank order
      const sections = packIntentSections(packCandidates, plan, fileDetails);
      const outputText = sections.join("\n\n");

      // 7. Build details.files: successful files in RRF order, then errored files in input order.
      const allFileDetails = buildIntentFileDetails(
        rankedSuccessOrder,
        filteredBelowThresholdPaths,
        erroredFiles,
        fileDetails,
      );

      const details = assembleIntentDetails({
        query: state.query,
        fileResults,
        successfulFiles,
        erroredFiles,
        topK: state.topK,
        effectiveTopK,
        dirCap,
        embeddingStatus: rankResult.embeddingStatus,
        embeddingError: rankResult.embeddingError,
        embeddingCacheHit: rankResult.embeddingCacheHit,
        embeddingLruCache: state.embeddingLruCache,
        persistentCaches: state.persistentCaches,
        cwd: ctx.cwd,
        filteredBelowThresholdPaths,
        addedGraphPaths,
        candidateCountBeforeGraph,
        resolvedCount: state.resolvedFiles.length,
        graphEdges: state.graphEdges,
        probing: state.probing,
        hydeResult: rankResult.hydeResult,
        rerankingResult: rankResult.rerankingResult,
        totalChunks: rankResult.totalChunks,
        filesChunked: rankResult.filesChunked,
        bestChunkByFile: rankResult.bestChunkByFile,
        astChunkingUsed: rankResult.astChunkingUsed,
        astChunkingStats: rankResult.astChunkingStats,
        allFileDetails,
        adrBoosts: rankResult.adrBoosts,
        plan,
        switchedForCoverage,
        packCandidates,
      });

      const batchEvidence = aggregateBatchEvidence({
        cwd: ctx.cwd,
        sessionFilePath: sessionFileFromContext(ctx),
        perFile: collectPackEvidence(packCandidates, fileResults),
        fullIncluded: plan.fullIncluded,
        summarizedIndexes: new Set<number>(),
        outputTruncated: false,
        publishInspection: opts.publishInspection,
      });
      if (batchEvidence) {
        details.workspaceEvidence = batchEvidence;
      }

      return {
        content: [{ type: "text", text: outputText }],
        details,
      };
    },
  } as unknown as ToolDefinition;
}
