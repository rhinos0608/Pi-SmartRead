import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export interface ResolvedEmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  chunkSizeChars?: number;
  chunkOverlapChars?: number;
  maxChunksPerFile?: number;
  /** Enable symbol-based query probing (Phase 3, off by default). */
  probeEnabled?: boolean;
  /** Enable structural reranker after RRF (Phase 5, off by default). */
  rerankEnabled?: boolean;
}

interface RawConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  chunkSizeChars?: number;
  chunkOverlapChars?: number;
  maxChunksPerFile?: number;
  probeEnabled?: boolean;
  rerankEnabled?: boolean;
}

const CONFIG_FILENAME = "pi-smartread.config.json";

/**
 * Walk up from `startDir` toward root to find the first CONFIG_FILENAME.
 * Returns the full path to the found file, or undefined if none exists.
 */
function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  // Safety valve: stop at filesystem root
  let prevDir: string | undefined;

  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) {
      return candidate;
    }
    prevDir = dir;
    dir = dirname(dir);
    // Stop when we reach the root — dirname("/") returns "/" (unchanged)
    if (dir === prevDir) break;
  }

  return undefined;
}

function loadRaw(cwd?: string): RawConfig {
  const resolvedCwd = cwd ?? process.cwd();

  let fromFile: RawConfig = {};
  const configPath = findConfigFile(resolvedCwd);
  if (configPath) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      fromFile = JSON.parse(raw) as RawConfig;
    } catch {
      // File found but unparseable — fall through to env vars
    }
  }

  return {
    baseUrl:
      fromFile.baseUrl ??
      process.env.PI_SMARTREAD_EMBEDDING_BASE_URL ??
      process.env.EMBEDDING_BASE_URL,
    model:
      fromFile.model ??
      process.env.PI_SMARTREAD_EMBEDDING_MODEL ??
      process.env.EMBEDDING_MODEL,
    apiKey: fromFile.apiKey ?? process.env.PI_SMARTREAD_EMBEDDING_API_KEY,
    chunkSizeChars:
      fromFile.chunkSizeChars ??
      (process.env.PI_SMARTREAD_CHUNK_SIZE ? parseInt(process.env.PI_SMARTREAD_CHUNK_SIZE, 10) : undefined),
    chunkOverlapChars:
      fromFile.chunkOverlapChars ??
      (process.env.PI_SMARTREAD_CHUNK_OVERLAP ? parseInt(process.env.PI_SMARTREAD_CHUNK_OVERLAP, 10) : undefined),
    maxChunksPerFile:
      fromFile.maxChunksPerFile ??
      (process.env.PI_SMARTREAD_MAX_CHUNKS ? parseInt(process.env.PI_SMARTREAD_MAX_CHUNKS, 10) : undefined),
    probeEnabled: fromFile.probeEnabled ?? false,
    rerankEnabled: fromFile.rerankEnabled ?? false,
  };
}

export function validateEmbeddingConfig(cwd?: string): ResolvedEmbeddingConfig {
  const raw = loadRaw(cwd);

  if (!raw.baseUrl) {
    throw new Error(
      "Embedding baseUrl is required. Set it in pi-smartread.config.json " +
        "(in the current directory or any parent) or via the " +
        "PI_SMARTREAD_EMBEDDING_BASE_URL environment variable.",
    );
  }
  if (!raw.model) {
    throw new Error(
      "Embedding model is required. Set it in pi-smartread.config.json " +
        "(in the current directory or any parent) or via the " +
        "PI_SMARTREAD_EMBEDDING_MODEL environment variable.",
    );
  }

  if (raw.chunkSizeChars !== undefined && (!Number.isInteger(raw.chunkSizeChars) || raw.chunkSizeChars <= 0)) {
    throw new Error(
      "chunkSizeChars must be a positive integer. Got: " + String(raw.chunkSizeChars),
    );
  }
  if (raw.chunkOverlapChars !== undefined && (!Number.isInteger(raw.chunkOverlapChars) || raw.chunkOverlapChars < 0)) {
    throw new Error(
      "chunkOverlapChars must be a non-negative integer. Got: " + String(raw.chunkOverlapChars),
    );
  }
  if (raw.maxChunksPerFile !== undefined && (!Number.isInteger(raw.maxChunksPerFile) || raw.maxChunksPerFile <= 0)) {
    throw new Error(
      "maxChunksPerFile must be a positive integer. Got: " + String(raw.maxChunksPerFile),
    );
  }

  return {
    baseUrl: raw.baseUrl,
    model: raw.model,
    apiKey: raw.apiKey,
    chunkSizeChars: raw.chunkSizeChars,
    chunkOverlapChars: raw.chunkOverlapChars,
    maxChunksPerFile: raw.maxChunksPerFile,
    probeEnabled: raw.probeEnabled ?? false,
    rerankEnabled: raw.rerankEnabled ?? false,
  };
}


