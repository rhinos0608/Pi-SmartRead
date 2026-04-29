import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export interface ResolvedEmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

interface RawConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

const CONFIG_FILENAME = "pi-smartread.config.json";

/**
 * Walk up from `startDir` toward root to find the first CONFIG_FILENAME.
 * Returns the full path to the found file, or undefined if none exists.
 */
function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  // Safety valve: stop at filesystem root
  const root = dirname(dir); // on Unix this is "/" on the second iteration when dir is "/"
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

  return { baseUrl: raw.baseUrl, model: raw.model, apiKey: raw.apiKey };
}

/** @deprecated No-op — config is always freshly resolved per invocation. */
export function resetConfigCache(): void {
  // No-op: cache was removed in favor of per-call resolution
}
