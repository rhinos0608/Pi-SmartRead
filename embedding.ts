export interface EmbedRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  inputs: string[];
  timeoutMs?: number;
}

export interface EmbedResult {
  vectors: number[][];
}

// Token estimation constants
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
export const MAX_ESTIMATED_TOKENS_PER_INPUT = 2048;
export const MAX_ESTIMATED_TOKENS_PER_BATCH = 32768;

// Sharded embedding constants
export const SHARD_SIZE = 40;
export const MAX_CONCURRENT_SHARDS = 4;

export async function fetchEmbeddings(req: EmbedRequest): Promise<EmbedResult> {
  // Token validation before sending
  let totalTokens = 0;
  for (let i = 0; i < req.inputs.length; i++) {
    const estimatedTokens = Math.ceil((req.inputs[i] ?? "").length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
    totalTokens += estimatedTokens;
    if (estimatedTokens > MAX_ESTIMATED_TOKENS_PER_INPUT) {
      throw new Error(
        `Input at index ${i} exceeds token limit: estimated ${estimatedTokens} tokens, max ${MAX_ESTIMATED_TOKENS_PER_INPUT}`,
      );
    }
  }
  if (totalTokens > MAX_ESTIMATED_TOKENS_PER_BATCH) {
    throw new Error(
      `Batch exceeds token limit: estimated ${totalTokens} tokens, max ${MAX_ESTIMATED_TOKENS_PER_BATCH}`,
    );
  }

  const url = req.baseUrl.replace(/\/+$/, "") + "/embeddings";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (req.apiKey) headers["Authorization"] = `Bearer ${req.apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: req.model, input: req.inputs }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Embedding API request failed: ${msg}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Embedding API returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Embedding API returned malformed JSON");
  }

  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Embedding API response missing data array");
  }

  if (data.length < req.inputs.length) {
    throw new Error(
      `Embedding API returned fewer embeddings than requested: got ${data.length}, expected ${req.inputs.length}`,
    );
  }

  const vectors: number[][] = [];
  let expectedDim: number | undefined;

  for (let i = 0; i < req.inputs.length; i++) {
    const entry = data[i] as { embedding?: unknown };
    const embedding = entry?.embedding;

    if (!Array.isArray(embedding)) {
      throw new Error(`Embedding at index ${i} is not an array`);
    }
    for (const v of embedding) {
      if (typeof v !== "number") {
        throw new Error(`Embedding at index ${i} contains non-numeric values`);
      }
    }
    if (expectedDim === undefined) {
      expectedDim = embedding.length;
    } else if (embedding.length !== expectedDim) {
      throw new Error(
        `Embedding dimension mismatch at index ${i}: expected ${expectedDim}, got ${embedding.length}`,
      );
    }
    vectors.push(embedding as number[]);
  }

  return { vectors };
}

/**
 * Fetch embeddings by sharding inputs into batches of SHARD_SIZE and calling
 * the embedding API in parallel (MAX_CONCURRENT_SHARDS at a time).
 *
 * Validates per-shard token limits upfront. Each shard that fails is retried
 * once. All shard vectors are merged into a single result preserving input order.
 *
 * The parent AbortController timeout adds 5 seconds to the per-request timeout
 * to account for serialized shard execution.
 */
export async function fetchEmbeddingsSharded(req: EmbedRequest): Promise<EmbedResult> {
  // Per-input token validation (same as fetchEmbeddings)
  for (let i = 0; i < req.inputs.length; i++) {
    const estimatedTokens = Math.ceil((req.inputs[i] ?? "").length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
    if (estimatedTokens > MAX_ESTIMATED_TOKENS_PER_INPUT) {
      throw new Error(
        `Input at index ${i} exceeds token limit: estimated ${estimatedTokens} tokens, max ${MAX_ESTIMATED_TOKENS_PER_INPUT}`,
      );
    }
  }

  // Split into shards of SHARD_SIZE
  const shards: string[][] = [];
  for (let i = 0; i < req.inputs.length; i += SHARD_SIZE) {
    shards.push(req.inputs.slice(i, i + SHARD_SIZE));
  }

  // Pre-validate per-shard token totals (fail fast before any network calls)
  for (let s = 0; s < shards.length; s++) {
    const shard = shards[s];
    let shardTokens = 0;
    for (const input of shard!) {
      shardTokens += Math.ceil(input.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
    }
    if (shardTokens > MAX_ESTIMATED_TOKENS_PER_BATCH) {
      throw new Error(
        `Shard ${s} exceeds batch token limit: estimated ${shardTokens} tokens, max ${MAX_ESTIMATED_TOKENS_PER_BATCH}`,
      );
    }
  }

  // Parent AbortController — add 5s buffer beyond per-request timeout
  // so serialized shards have room to complete without the parent timing out first
  const parentController = new AbortController();
  const parentTimeout = setTimeout(
    () => parentController.abort(),
    (req.timeoutMs ?? 30_000) + 5000,
  );

  try {
    // Process shards with concurrency limit
    const results = await mapWithConcurrency(
      shards,
      MAX_CONCURRENT_SHARDS,
      async (shard): Promise<EmbedResult> => {
        if (parentController.signal.aborted) {
          throw new Error("Embedding operation cancelled by parent timeout");
        }
        // Retry once on transient failures (network errors, 5xx).
        // Client errors (4xx — bad API key, invalid model) are not retried.
        try {
          return await fetchEmbeddings({ ...req, inputs: shard });
        } catch (firstErr) {
          const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
          // HTTP 4xx — permanent failure, don't retry
          if (/HTTP 4\d\d/.test(msg)) throw firstErr;
          // Network/timeout/5xx — retry once
          return await fetchEmbeddings({ ...req, inputs: shard });
        }
      },
    );

    // Merge vectors from all shards preserving order
    const vectors: number[][] = [];
    for (const result of results) {
      vectors.push(...result.vectors);
    }
    return { vectors };
  } finally {
    clearTimeout(parentTimeout);
  }
}

/**
 * Map an array of items with a concurrency limit.
 * Runs up to `concurrency` async workers, each pulling from the shared index.
 * Results are returned in original input order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      const item = items[i]!;
      results[i] = await fn(item);
    }
  }

  const workers: Promise<void>[] = [];
  const limit = Math.min(concurrency, items.length);
  for (let w = 0; w < limit; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}
