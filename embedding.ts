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

export async function fetchEmbeddings(req: EmbedRequest): Promise<EmbedResult> {
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
