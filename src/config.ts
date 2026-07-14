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
  /** Enable HyDE query expansion (off by default). */
  hydeEnabled?: boolean;
  /** External reranker API configuration (Phase 6, off by default). */
  externalReranker?: ExternalRerankerConfig;
}

export interface ExternalRerankerConfig {
  /** Base URL of the reranker API (e.g., "https://api.cohere.com/v1"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey?: string;
  /** Model name to use (e.g., "rerank-english-v3.0"). */
  model?: string;
  /** Request timeout in milliseconds (default: 10000). */
  timeoutMs?: number;
  /** Maximum number of documents to send per request (default: 20). */
  maxDocuments?: number;
}

export interface SearchEnrichModeConfig {
  /** When this mode's enrichment is enabled, also append callers (default: true). */
  callers?: boolean;
  /** When this mode's enrichment is enabled, also show resolution info (default: true). */
  resolution?: boolean;
  /** When this mode's enrichment is enabled, tag results with symbol metadata (default: true). */
  symbols?: boolean;
}

export interface SearchConfig {
  enrich?: {
    /** Enrichment behaviour for code search. */
    code?: SearchEnrichModeConfig;
  };
}

export interface GitContextConfig {
  enabled?: boolean;
  startupLogLimit?: number;
  coCommitAnalysisLimit?: number;
  coCommitMinCorrelation?: number;
  coCommitMinCount?: number;
  readEnrichmentCommits?: number;
  showTrailerKeys?: string[];
  notesRefs?: string[];
  tokenBudget?: {
    gitLog?: number;
    coCommitHotspots?: number;
    gitNotes?: number;
  };
}

export interface ExperimentalFeaturesConfig {
  /** Enable git notes tool (read/write AI session context on commits). Default: false. */
  gitNotes?: boolean;
  /** Enable graph mutation tool (breakage/co-change edge recording). Default: false. */
  graphMutate?: boolean;
}

export interface ResolvedGitContextConfig {
  enabled: boolean;
  startupLogLimit: number;
  coCommitAnalysisLimit: number;
  coCommitMinCorrelation: number;
  coCommitMinCount: number;
  readEnrichmentCommits: number;
  showTrailerKeys: string[];
  notesRefs: string[];
  tokenBudget: {
    gitLog: number;
    coCommitHotspots: number;
    gitNotes: number;
  };
}

export const DEFAULT_GIT_CONTEXT_CONFIG: ResolvedGitContextConfig = {
  enabled: true,
  startupLogLimit: 30,
  coCommitAnalysisLimit: 100,
  coCommitMinCorrelation: 0.15,
  coCommitMinCount: 2,
  readEnrichmentCommits: 3,
  showTrailerKeys: ["Constraint", "Directive", "Rejected"],
  notesRefs: ["refs/notes/pi-smartread", "refs/notes/lore", "refs/notes/opencode", "refs/notes/commits"],
  tokenBudget: {
    gitLog: 800,
    coCommitHotspots: 400,
    gitNotes: 600,
  },
};

export function loadSearchConfig(cwd?: string): SearchConfig {
  const resolvedCwd = cwd ?? process.cwd();
  const configPath = findConfigFile(resolvedCwd);
  if (!configPath) return {};
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as { search?: SearchConfig };
    return raw.search ?? {};
  } catch {
    return {};
  }
}

export function loadGitContextConfig(cwd?: string): ResolvedGitContextConfig {
  const resolvedCwd = cwd ?? process.cwd();
  const configPath = findConfigFile(resolvedCwd);
  let raw: GitContextConfig = {};

  if (configPath) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as { gitContext?: GitContextConfig };
      raw = parsed.gitContext ?? {};
    } catch {
      raw = {};
    }
  }

  return {
    ...DEFAULT_GIT_CONTEXT_CONFIG,
    ...raw,
    tokenBudget: {
      ...DEFAULT_GIT_CONTEXT_CONFIG.tokenBudget,
      ...raw.tokenBudget,
    },
    showTrailerKeys: raw.showTrailerKeys ?? DEFAULT_GIT_CONTEXT_CONFIG.showTrailerKeys,
    notesRefs: raw.notesRefs ?? DEFAULT_GIT_CONTEXT_CONFIG.notesRefs,
  };
}

export function loadExperimentalConfig(cwd?: string): ExperimentalFeaturesConfig {
  const resolvedCwd = cwd ?? process.cwd();
  const configPath = findConfigFile(resolvedCwd);
  if (!configPath) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as { experimental?: ExperimentalFeaturesConfig };
    return parsed.experimental ?? {};
  } catch {
    return {};
  }
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
  hydeEnabled?: boolean;
  externalReranker?: ExternalRerankerConfig;
  search?: SearchConfig;
  gitContext?: GitContextConfig;
  experimental?: ExperimentalFeaturesConfig;
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

/**
 * Returns true if the host is a loopback or private IP address.
 */
function isPrivateHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("172.16.") ||
    hostname.endsWith(".local")
  );
}

/**
 * Validate that the URL uses HTTPS, unless it's a local/private host.
 * Public internet URLs must use HTTPS.
 */
function validateUrl(url: string, label: string): void {
  try {
    const parsed = new URL(url);
    // Allow HTTP for local/private hosts (e.g. Ollama on localhost)
    if (parsed.protocol === "http:" && isPrivateHost(parsed.hostname)) {
      return;
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`${label} must use HTTPS protocol. Got: ${url}`);
    }
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(`${label} is not a valid URL: ${url}`);
    }
    throw err;
  }
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

  // Security: repo-level config is untrusted for network endpoints.
  // Only use environment variables for baseUrl and API keys.
  // Non-network settings (model, chunk sizes, feature flags) may come from file.
  const baseUrl =
    process.env.PI_SMARTREAD_EMBEDDING_BASE_URL ??
    process.env.EMBEDDING_BASE_URL;

  // When baseUrl comes from the user's env, validate it.
  // Repo-level baseUrl is silently ignored (untrusted).
  if (baseUrl !== undefined) {
    validateUrl(baseUrl, "baseUrl");
  }

  return {
    baseUrl,
    model:
      fromFile.model ??
      process.env.PI_SMARTREAD_EMBEDDING_MODEL ??
      process.env.EMBEDDING_MODEL,
    apiKey: process.env.PI_SMARTREAD_EMBEDDING_API_KEY,
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

/**
 * Validate embedding configuration.
 *
 * Returns null if baseUrl or model is missing, allowing the caller to
 * degrade gracefully to BM25-only mode with a warning instead of hard-failing.
 * Throws only for invalid numeric values (which indicate a config authoring error).
 */
export function validateEmbeddingConfig(cwd?: string): ResolvedEmbeddingConfig | null {
  const raw = loadRaw(cwd);

  if (!raw.baseUrl || !raw.model) {
    return null;
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
    hydeEnabled: raw.hydeEnabled ?? false,
    // Security: repo-level externalReranker config is untrusted for network endpoints.
    // Only env vars supply the reranker baseUrl/apiKey.
    // Model and timeout settings may still come from file config.
    externalReranker: raw.externalReranker
      ? {
          ...raw.externalReranker,
          baseUrl: process.env.PI_SMARTREAD_RERANKER_BASE_URL ?? raw.externalReranker.baseUrl,
          apiKey: process.env.PI_SMARTREAD_RERANKER_API_KEY ?? raw.externalReranker.apiKey,
        }
      : undefined,
  };
}


