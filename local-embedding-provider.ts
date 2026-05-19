/**
 * Local embedding provider using @huggingface/transformers.
 * 
 * This provider enables local sentence-embedding inference without an API.
 * Uses dynamic import so the optional dependency fails gracefully with a clear
 * error message if it is not installed.
 */

export interface LocalEmbedOptions {
  /** HuggingFace model ID (default: 'Xenova/all-MiniLM-L6-v2') */
  modelId?: string;
  /** Local model directory — sets env.localModelPath and disallows remote models */
  modelDir?: string;
  /** ONNX dtype (default: 'fp16' — good balance of size/speed/quality) */
  dtype?: "fp32" | "fp16" | "q8";
  /** Whether to L2-normalize output vectors (default: true) */
  normalize?: boolean;
}

const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_DTYPE: LocalEmbedOptions["dtype"] = "fp16";
const DEFAULT_NORMALIZE = true;

// -----------------------------------------------------------------------
// Tensor → number[][] helpers
// -----------------------------------------------------------------------

/**
 * Convert a Tensor returned by the feature-extraction pipeline to a plain
 * array of embedding vectors.
 *
 * The raw output of the pipeline is a 2-D Tensor of shape [batch, hiddenDim]
 * when `pooling: 'mean'` is used.  This function extracts each row into a
 * plain `number[]`.
 */
export function tensorToVectors(tensor: {
  data: ArrayLike<number>;
  dims: number[];
}): number[][] {
  const data = tensor.data as Float32Array;
  const dims = tensor.dims;
  const stride = dims.at(-1)!;
  // Batch size is the first dimension (always ≥ 1 after pooling)
  const batchSize = dims.length >= 2 ? dims[0]! : 1;
  const vectors: number[][] = [];
  for (let i = 0; i < batchSize; i++) {
    vectors.push(Array.from(data.subarray(i * stride, (i + 1) * stride)));
  }
  return vectors;
}

// -----------------------------------------------------------------------
// Availability check
// -----------------------------------------------------------------------

/**
 * Returns true when `@huggingface/transformers` is importable.
 * Use this to decide whether to offer local embeddings as an option.
 */
export async function isLocalEmbeddingAvailable(): Promise<boolean> {
  try {
    await import("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------
// LocalEmbeddingProvider
// -----------------------------------------------------------------------

export class LocalEmbeddingProvider {
  private pipeline: ((inputs: string | string[], options?: Record<string, unknown>) => Promise<unknown>) | null = null;
  private options: { modelId: string; modelDir: string | undefined; dtype: "fp32" | "fp16" | "q8"; normalize: boolean };

  constructor(options: LocalEmbedOptions = {}) {
    this.options = {
      modelId: options.modelId ?? DEFAULT_MODEL_ID,
      modelDir: options.modelDir ?? undefined,
      dtype: (options.dtype ?? DEFAULT_DTYPE) as "fp32" | "fp16" | "q8",
      normalize: options.normalize ?? DEFAULT_NORMALIZE,
    };
  }

  /**
   * Initialise the feature-extraction pipeline.
   *
   * - Sets `env.allowRemoteModels = false` when `modelDir` is provided,
   *   forcing the library to load from the local directory.
   * - Sets `env.localModelPath` to `modelDir` when supplied.
   * - Creates the pipeline once; it is reused for all subsequent calls.
   */
  async initialize(): Promise<void> {
    const { pipeline, env } = await import("@huggingface/transformers");

    if (this.options.modelDir) {
      env.allowRemoteModels = false;
      env.localModelPath = this.options.modelDir;
    }

    this.pipeline = await pipeline(
      "feature-extraction",
      this.options.modelId,
      { dtype: this.options.dtype }
    );
  }

  /**
   * Embed one or more texts into dense vectors.
   *
   * Internally the pipeline is called with `pooling: 'mean'` and the
   * configured `normalize` flag so that cosine similarity can be used
   * on the returned vectors without any further post-processing.
   */
  async embed(inputs: string[]): Promise<number[][]> {
    if (!this.pipeline) {
      throw new Error(
        "LocalEmbeddingProvider is not initialized. Call initialize() first."
      );
    }

    if (inputs.length === 0) {
      return [];
    }

    const result = await this.pipeline(inputs, {
      pooling: "mean",
      normalize: this.options.normalize,
    });

    // Cast through `unknown` because the dynamic import prevents the
    // TypeScript compiler from knowing the exact Tensor type at compile time.
    return tensorToVectors(result as { data: ArrayLike<number>; dims: number[] });
  }

  get modelId(): string {
    return this.options.modelId;
  }

  get dtype(): string {
    return this.options.dtype ?? DEFAULT_DTYPE;
  }
}