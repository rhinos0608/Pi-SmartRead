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

  const url = req.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/embeddings";
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
