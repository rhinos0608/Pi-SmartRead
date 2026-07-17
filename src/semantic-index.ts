import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ResolvedEmbeddingConfig } from "./config.js";
import { validateEmbeddingConfig } from "./config.js";
import { chunkTextAst } from "./chunking.js";
import { fetchEmbeddings, type EmbedRequest, type EmbedResult } from "./embedding.js";
import { discoverFiles, type FileDiscoveryResult } from "./file-discovery.js";
import { bm25Scores, computeRanks } from "./scoring.js";
import {
  SqliteVecStore,
  type Chunk as VecChunk,
  type SearchResult as VecSearchResult,
} from "./sqlite-vec-store.js";

export interface SemanticSearchResult {
  filePath: string;
  symbolKind: string;
  language: string;
  codeSnippet: string;
  lineStart: number;
  lineEnd: number;
  score: number;
}

export interface SemanticSearchOptions {
  topK?: number;
  /** Project-root-relative directory prefix. */
  pathPrefix?: string;
}

export interface SemanticIndexStats {
  ready: boolean;
  updating: boolean;
  dimension: number | null;
  indexedFileCount: number;
  chunkCount: number;
  lastError?: string;
}

export class SemanticUnavailableError extends Error {
  readonly code = "SEMANTIC_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SemanticUnavailableError";
  }
}

interface FileState {
  hash: string;
  mtimeMs: number;
  size: number;
}

interface SemanticMetadata {
  version: 1;
  fingerprint: string;
  dimension: number | null;
  completed: boolean;
  files: Record<string, FileState>;
}

interface CorpusChunk {
  id: number;
  filePath: string;
  symbolKind: string;
  language: string;
  codeSnippet: string;
  lineStart: number;
  lineEnd: number;
}

interface VectorStore {
  readonly chunkCount: number;
  search(queryEmbedding: Float32Array, k: number, filters?: { filePathPrefix?: string }): VecSearchResult[];
  getAllChunks(): CorpusChunk[];
  replaceFileChunks(filePath: string, chunks: VecChunk[]): void;
  deleteByFilePath(filePath: string): void;
  close(): void;
}

export interface SemanticIndexOptions {
  config?: ResolvedEmbeddingConfig | null;
  fetchEmbeddings?: (request: EmbedRequest) => Promise<EmbedResult>;
  discoverFiles?: (
    root: string,
    profile: "text",
    maxFiles: number,
    signal?: AbortSignal,
  ) => Promise<FileDiscoveryResult>;
  storeFactory?: (dbPath: string, dimension: number) => VectorStore;
  maxFiles?: number;
  maxFileBytes?: number;
}

const METADATA_VERSION = 1;
const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const RRF_K = 60;

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function isWithinPrefix(path: string, prefix: string | undefined): boolean {
  if (!prefix) return true;
  const normalizedPath = normalizeRelative(path);
  const normalizedPrefix = normalizeRelative(prefix);
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeChunkId(fingerprint: string, filePath: string, chunkIndex: number, hash: string): number {
  // 13 hex digits fit below Number.MAX_SAFE_INTEGER (2^52 - 1).
  return Number.parseInt(sha256(`${fingerprint}\0${filePath}\0${chunkIndex}\0${hash}`).slice(0, 13), 16);
}

function lineAt(text: string, charOffset: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(text.length, charOffset));
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function emptyMetadata(fingerprint: string): SemanticMetadata {
  return {
    version: METADATA_VERSION,
    fingerprint,
    dimension: null,
    completed: false,
    files: {},
  };
}

export class SemanticIndex {
  readonly root: string;
  private readonly config: ResolvedEmbeddingConfig | null;
  private readonly fingerprint: string;
  private readonly dbPath: string;
  private readonly metadataPath: string;
  private readonly embed: (request: EmbedRequest) => Promise<EmbedResult>;
  private readonly discover: NonNullable<SemanticIndexOptions["discoverFiles"]>;
  private readonly storeFactory: NonNullable<SemanticIndexOptions["storeFactory"]>;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private store: VectorStore | null = null;
  private metadata: SemanticMetadata;
  private ready = false;
  private initialized = false;
  private disposed = false;
  private updatePromise: Promise<void> | null = null;
  private lastError: string | undefined;
  private pendingStalePaths = new Set<string>();

  constructor(root: string, options: SemanticIndexOptions = {}) {
    this.root = resolve(root);
    this.config = options.config === undefined ? validateEmbeddingConfig(this.root) : options.config;
    this.fingerprint = sha256(JSON.stringify({
      baseUrl: this.config?.baseUrl.replace(/\/+$/, "") ?? "",
      model: this.config?.model ?? "",
      chunkSizeChars: this.config?.chunkSizeChars ?? 4096,
      chunkOverlapChars: this.config?.chunkOverlapChars ?? 512,
      maxChunksPerFile: this.config?.maxChunksPerFile ?? 12,
    }));
    const cacheDir = join(this.root, ".pi-smartread");
    const suffix = this.fingerprint.slice(0, 16);
    this.dbPath = join(cacheDir, `semantic-index-${suffix}.db`);
    this.metadataPath = join(cacheDir, `semantic-index-${suffix}.json`);
    this.embed = options.fetchEmbeddings ?? fetchEmbeddings;
    this.discover = options.discoverFiles ?? discoverFiles;
    this.storeFactory = options.storeFactory ?? ((path, dimension) => new SqliteVecStore(path, dimension));
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.metadata = emptyMetadata(this.fingerprint);
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new SemanticUnavailableError("Semantic index is disposed");
    if (this.initialized) return;
    this.initialized = true;
    if (!this.config) return;

    this.metadata = this.readMetadata();
    if (!this.metadata.completed) return;
    if (this.metadata.dimension === null) {
      this.ready = true; // Successfully built empty corpus.
      return;
    }
    if (!existsSync(this.dbPath)) {
      this.metadata = emptyMetadata(this.fingerprint);
      return;
    }

    try {
      this.store = this.storeFactory(this.dbPath, this.metadata.dimension);
      if (this.store.chunkCount === 0 && Object.keys(this.metadata.files).length > 0) {
        this.store.close();
        this.store = null;
        this.metadata = emptyMetadata(this.fingerprint);
        return;
      }
      this.ready = true;
    } catch {
      this.store = null;
      this.ready = false;
      this.metadata = emptyMetadata(this.fingerprint);
    }
  }

  isAvailable(): boolean {
    return !this.disposed && this.ready && this.updatePromise === null;
  }

  getStats(): SemanticIndexStats {
    return {
      ready: this.isAvailable(),
      updating: this.updatePromise !== null,
      dimension: this.metadata.dimension,
      indexedFileCount: Object.keys(this.metadata.files).length,
      chunkCount: this.store?.chunkCount ?? 0,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async updateIndex(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new SemanticUnavailableError("Semantic index is disposed");
    if (!this.config) throw new SemanticUnavailableError("Embedding configuration is unavailable");
    if (!this.initialized) await this.initialize();
    if (this.updatePromise) return this.updatePromise;

    this.updatePromise = this.performUpdate(signal).finally(() => {
      this.updatePromise = null;
    });
    return this.updatePromise;
  }

  private async performUpdate(signal?: AbortSignal): Promise<void> {
    const discovery = await this.discover(this.root, "text", this.maxFiles, signal);
    const current = new Map<string, FileState>();

    for (const absolutePath of discovery.files) {
      if (this.disposed) throw new SemanticUnavailableError("Semantic index was disposed during update");
      if (signal?.aborted) throw new Error("Operation aborted");
      let stat;
      try {
        stat = statSync(absolutePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > this.maxFileBytes) continue;
      const rel = normalizeRelative(relative(this.root, absolutePath));
      if (!rel || rel.startsWith("../")) continue;
      const previous = this.metadata.files[rel];
      const hash = previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size
        ? previous.hash
        : sha256(readFileSync(absolutePath));
      current.set(rel, { hash, mtimeMs: stat.mtimeMs, size: stat.size });
    }

    const nextFiles: Record<string, FileState> = { ...this.metadata.files };
    for (const previousPath of Object.keys(this.metadata.files)) {
      if (current.has(previousPath)) continue;
      this.store?.deleteByFilePath(previousPath);
      delete nextFiles[previousPath];
    }

    let queue = [...current.entries()]
      .filter(([path, state]) => this.metadata.files[path]?.hash !== state.hash)
      .map(([path]) => path);
    const fullRebuild = !this.store && current.size > 0;
    if (fullRebuild) queue = [...current.keys()];

    let cursor = 0;
    while (cursor < queue.length) {
      if (this.disposed) throw new SemanticUnavailableError("Semantic index was disposed during update");
      if (signal?.aborted) throw new Error("Operation aborted");
      const relPath = queue[cursor++]!;
      const state = current.get(relPath);
      if (!state) continue;

      try {
        const absolutePath = join(this.root, relPath);
        const source = readFileSync(absolutePath, "utf-8");
        const chunkResult = await chunkTextAst(source, {
          chunkSizeChars: this.config?.chunkSizeChars ?? 4096,
          chunkOverlapChars: this.config?.chunkOverlapChars ?? 512,
          maxChunksPerFile: this.config?.maxChunksPerFile ?? 12,
          filePath: absolutePath,
          compressForEmbedding: true,
          useSymbolBoundaries: true,
        });
        if (chunkResult.chunks.length === 0) {
          this.store?.deleteByFilePath(relPath);
          nextFiles[relPath] = state;
          continue;
        }

        const texts = chunkResult.chunks.map((chunk) => chunk.embeddingText ?? chunk.text);
        const embedded = await this.embed({
          baseUrl: this.config!.baseUrl,
          model: this.config!.model,
          apiKey: this.config!.apiKey,
          inputs: texts,
        });
        if (this.disposed) throw new SemanticUnavailableError("Semantic index was disposed during update");
        if (embedded.vectors.length !== texts.length || embedded.vectors.length === 0) {
          throw new Error("Embedding response count mismatch");
        }
        const dimension = embedded.vectors[0]!.length;
        if (dimension <= 0 || embedded.vectors.some((vector) => vector.length !== dimension)) {
          throw new Error("Embedding response dimension mismatch");
        }

        if (this.metadata.dimension !== null && this.metadata.dimension !== dimension) {
          this.resetStoreForDimension(dimension);
          for (const key of Object.keys(nextFiles)) delete nextFiles[key];
          queue = [...current.keys()];
          cursor = 0;
          continue;
        }
        if (!this.store) {
          if (fullRebuild) {
            try { rmSync(this.dbPath, { force: true }); } catch { /* advisory cache */ }
          }
          mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });
          this.store = this.storeFactory(this.dbPath, dimension);
          this.metadata.dimension = dimension;
        }

        const chunks: VecChunk[] = chunkResult.chunks.map((chunk, index) => ({
          id: safeChunkId(this.fingerprint, relPath, index, state.hash),
          embedding: new Float32Array(embedded.vectors[index]!),
          filePath: relPath,
          symbolKind: chunk.symbolBoundary?.type ?? "chunk",
          language: extname(relPath).slice(1).toLowerCase() || "text",
          codeSnippet: chunk.text,
          lineStart: chunk.symbolBoundary?.startLine ?? lineAt(source, chunk.startChar),
          lineEnd: chunk.symbolBoundary?.endLine ?? lineAt(source, Math.max(chunk.startChar, chunk.endChar - 1)),
        }));
        this.store.replaceFileChunks(relPath, chunks);
        nextFiles[relPath] = state;
      } catch (error) {
        // Keep previous rows/state on failure. Missing state guarantees retry next startup.
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (this.disposed) throw new SemanticUnavailableError("Semantic index was disposed during update");
    // Drain any files invalidated during this update so the commit
    // doesn't overwrite markFilesStale() effects.
    this.applyPendingStale(nextFiles);
    this.metadata = {
      version: METADATA_VERSION,
      fingerprint: this.fingerprint,
      dimension: this.metadata.dimension,
      completed: current.size === 0 || Object.keys(nextFiles).length > 0,
      files: nextFiles,
    };
    this.writeMetadata();
    this.ready = this.metadata.completed;
  }

  async search(query: string, options: SemanticSearchOptions = {}): Promise<SemanticSearchResult[]> {
    if (!this.isAvailable()) throw new SemanticUnavailableError("Semantic index is unavailable or warming");
    if (!this.config) throw new SemanticUnavailableError("Embedding configuration is unavailable");
    const topK = Math.max(1, Math.min(100, Math.trunc(options.topK ?? 20)));
    const prefix = options.pathPrefix ? normalizeRelative(options.pathPrefix) : undefined;
    if (!this.store) return [];

    const corpus = this.store.getAllChunks().filter((chunk) => isWithinPrefix(chunk.filePath, prefix));
    if (corpus.length === 0) return [];

    let queryVector: number[];
    try {
      const response = await this.embed({
        baseUrl: this.config.baseUrl,
        model: this.config!.model,
        apiKey: this.config.apiKey,
        inputs: [query],
      });
      queryVector = response.vectors[0] ?? [];
    } catch (error) {
      throw new SemanticUnavailableError("Query embedding failed", { cause: error });
    }
    if (queryVector.length === 0) throw new SemanticUnavailableError("Query embedding was empty");
    if (this.metadata.dimension !== queryVector.length) {
      this.resetStoreForDimension(queryVector.length);
      this.writeMetadata();
      throw new SemanticUnavailableError("Embedding dimension changed; semantic index scheduled for rebuild");
    }

    let semanticRows: VecSearchResult[];
    try {
      semanticRows = this.store.search(
        new Float32Array(queryVector),
        corpus.length,
        prefix ? { filePathPrefix: prefix } : undefined,
      );
    } catch (error) {
      throw new SemanticUnavailableError("Vector search failed", { cause: error });
    }

    const chunksByFile = new Map<string, CorpusChunk[]>();
    for (const chunk of corpus) {
      const list = chunksByFile.get(chunk.filePath) ?? [];
      list.push(chunk);
      chunksByFile.set(chunk.filePath, list);
    }
    const filePaths = [...chunksByFile.keys()].sort();
    const bodies = filePaths.map((path) => chunksByFile.get(path)!.map((chunk) => chunk.codeSnippet).join("\n"));
    const lexicalScores = bm25Scores(query, bodies);
    const lexicalRanks = computeRanks(lexicalScores, filePaths);

    const bestSemantic = new Map<string, VecSearchResult>();
    for (const row of semanticRows) {
      const previous = bestSemantic.get(row.filePath);
      if (!previous || row.distance < previous.distance) bestSemantic.set(row.filePath, row);
    }
    const rankedSemanticRows = [...bestSemantic.values()].sort((a, b) => a.distance - b.distance || a.filePath.localeCompare(b.filePath));
    const semanticRankByFile = new Map(rankedSemanticRows.map((row, index) => [row.filePath, index + 1]));
    const missingRank = filePaths.length + 1;

    const ranked = filePaths.map((filePath, index) => ({
      filePath,
      lexicalScore: lexicalScores[index] ?? 0,
      score: 1 / (RRF_K + (lexicalRanks[index] ?? missingRank)) +
        1 / (RRF_K + (semanticRankByFile.get(filePath) ?? missingRank)),
    })).sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath)).slice(0, topK);

    return ranked.map(({ filePath, score, lexicalScore }) => {
      const semantic = bestSemantic.get(filePath);
      const chunks = chunksByFile.get(filePath)!;
      const lexicalChunkScores = bm25Scores(query, chunks.map((chunk) => chunk.codeSnippet));
      const bestLexicalIndex = lexicalChunkScores.reduce((best, value, index) => value > (lexicalChunkScores[best] ?? -Infinity) ? index : best, 0);
      const selected = lexicalScore > 0 ? chunks[bestLexicalIndex]! : (semantic ?? chunks[0]!);
      return {
        filePath,
        symbolKind: selected.symbolKind,
        language: selected.language,
        codeSnippet: selected.codeSnippet.slice(0, 400),
        lineStart: selected.lineStart,
        lineEnd: selected.lineEnd,
        score,
      };
    });
  }

  /**
   * Mark one or more files as stale so the next updateIndex() re-indexes them.
   * Removes cached file state and vector chunks for the given paths (relative to this.root).
   * Safe to call when the index is warming or unavailable (no-op).
   */
  markFilesStale(relPaths: string[]): void {
    if (this.disposed) return;
    if (relPaths.length === 0) return;
    for (const relPath of relPaths) {
      this.pendingStalePaths.add(relPath);
      this.store?.deleteByFilePath(relPath);
    }
    if (!this.updatePromise) {
      this.applyPendingStale(this.metadata.files);
      this.metadata.completed = false;
      this.writeMetadata();
    }
  }

  private applyPendingStale(targetFiles: Record<string, FileState>): void {
    for (const relPath of this.pendingStalePaths) {
      delete targetFiles[relPath];
      this.store?.deleteByFilePath(relPath);
    }
    this.pendingStalePaths.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.initialized = false;
    this.ready = false;
    this.updatePromise = null;
    this.pendingStalePaths.clear();
    this.store?.close();
    this.store = null;
  }

  private resetStoreForDimension(dimension: number): void {
    this.store?.close();
    this.store = null;
    try { rmSync(this.dbPath, { force: true }); } catch { /* advisory cache */ }
    this.metadata = emptyMetadata(this.fingerprint);
    this.metadata.dimension = dimension;
    this.ready = false;
  }

  private readMetadata(): SemanticMetadata {
    try {
      const parsed = JSON.parse(readFileSync(this.metadataPath, "utf-8")) as SemanticMetadata;
      if (parsed.version !== METADATA_VERSION || parsed.fingerprint !== this.fingerprint) return emptyMetadata(this.fingerprint);
      return {
        ...parsed,
        files: parsed.files ?? {},
      };
    } catch {
      return emptyMetadata(this.fingerprint);
    }
  }

  private writeMetadata(): void {
    try {
      mkdirSync(dirname(this.metadataPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.metadataPath, JSON.stringify(this.metadata, null, 2), { mode: 0o600 });
    } catch {
      // Cache persistence is advisory; live index remains usable.
    }
  }
}

export function pathPrefixForDirectory(projectRoot: string, directory: string): string | undefined {
  const rel = normalizeRelative(relative(resolve(projectRoot), resolve(directory)));
  if (!rel) return undefined;
  if (rel.startsWith("../") || isAbsolute(rel)) throw new Error("Directory is outside semantic index root");
  return rel;
}
