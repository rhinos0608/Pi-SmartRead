import { readFileSync } from "node:fs";
import { join } from "node:path";

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

let cache: RawConfig | null = null;

function loadRaw(): RawConfig {
  if (cache !== null) return cache;

  let fromFile: RawConfig = {};
  try {
    const raw = readFileSync(join(process.cwd(), "pi-smartread.config.json"), "utf-8");
    fromFile = JSON.parse(raw) as RawConfig;
  } catch {
    // File absent or unparseable — fall through to env vars
  }

  cache = {
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

  return cache;
}

export function validateEmbeddingConfig(): ResolvedEmbeddingConfig {
  const raw = loadRaw();

  if (!raw.baseUrl) {
    throw new Error(
      "Embedding baseUrl is required. Set it in pi-smartread.config.json " +
        "or via the PI_SMARTREAD_EMBEDDING_BASE_URL environment variable.",
    );
  }
  if (!raw.model) {
    throw new Error(
      "Embedding model is required. Set it in pi-smartread.config.json " +
        "or via the PI_SMARTREAD_EMBEDDING_MODEL environment variable.",
    );
  }

  return { baseUrl: raw.baseUrl, model: raw.model, apiKey: raw.apiKey };
}

export function resetConfigCache(): void {
  cache = null;
}