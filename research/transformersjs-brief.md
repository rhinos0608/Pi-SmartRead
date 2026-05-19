# Research: @huggingface/transformers.js Integration for Local Embeddings

## Summary

`@huggingface/transformers` (v4.2.0) is the successor to `@xenova/transformers` (v2.17.2), using ONNX Runtime to run transformer models directly in Node.js. It can replace OpenAI-compatible `/embeddings` API calls with local inference using small models like `Xenova/all-MiniLM-L6-v2` (384-dim embeddings). The library supports offline mode (`env.allowRemoteModels = false`, `env.localModelPath`), batch processing with built-in pooling/normalization, and works on Node.js ≥18. Bun support exists but has some stability caveats on Bun 1.3.13+.

---

## Findings

### 1. Package Identity — use `@huggingface/transformers` (not `@xenova/transformers`)

| Package | Version | Status |
|---|---|---|
| `@xenova/transformers` | 2.17.2 (latest) | Superseded, no longer actively developed |
| `@huggingface/transformers` | 4.2.0 (latest) | **Active** — npm, ESM `.mjs` + CJS `.cjs` exports |

The new package (`@huggingface/transformers`) has proper dual-module packaging:
- **Node.js**: `dist/transformers.node.mjs` (ESM) and `dist/transformers.node.cjs` (CJS)
- **Web/browser**: `dist/transformers.web.js`

Dependency chain: `@huggingface/transformers` → `onnxruntime-node` (native N-API addon) + `onnxruntime-web` (WASM fallback). [Source](https://www.npmjs.com/package/@huggingface/transformers)

### 2. Feature-Extraction Pipeline — Initialization and Usage

The `pipeline('feature-extraction', ...)` API is directly analogous to the Python `transformers` library.

```typescript
import { pipeline } from '@huggingface/transformers';

// Create pipeline (loads model + tokenizer — heavyweight, do once at init)
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
  dtype: 'q8',        // 8-bit quantized (~22 MB), fastest for CPU
  // dtype: 'fp16'    // half precision (~43 MB)
  // dtype: 'fp32'    // full precision (~86 MB), default for Node.js
});
```

The task alias `'embeddings'` is also registered:
```typescript
const extractor = await pipeline('embeddings', 'Xenova/all-MiniLM-L6-v2');
// Equivalent to pipeline('feature-extraction', ...)
```

**To get usable sentence embeddings** (not raw token vectors), you **must** pass `pooling` and `normalize` on every call:

```typescript
// Single text → shape [1, 384]
const out = await extractor('Hello world', { pooling: 'mean', normalize: true });
// Tensor { type: 'float32', data: Float32Array(384), dims: [1, 384] }

// Batch texts → shape [N, 384]
const out = await extractor(
  ['Hello world', 'Another text', 'More text'],
  { pooling: 'mean', normalize: true },
);
// Tensor { type: 'float32', data: Float32Array(1152), dims: [3, 384] }
```

Available pooling options: `'none'` (default), `'mean'`, `'cls'`, `'first_token'`, `'last_token'`, `'eos'`. For cosine-similarity-compatible embeddings, always use `{ pooling: 'mean', normalize: true }`. [Source](https://huggingface.co/docs/transformers.js/api/pipelines#module_pipelines.FeatureExtractionPipeline)

### 3. Offline Mode and Local Model Paths

The `env` singleton controls model loading behaviour:

```typescript
import { env } from '@huggingface/transformers';

// === REQUIRED for offline/air-gapped mode ===
env.allowRemoteModels = false;       // prevents any HF Hub HTTP requests
env.allowLocalModels = true;         // true by default in Node.js
env.localModelPath = '/data/models/'; // default: '/models/'

// === Optional tuning ===
env.cacheDir = '/data/.cache';       // where downloaded models are cached (default: './.cache')
env.useFSCache = true;               // cache models on filesystem
env.useBrowserCache = false;         // no-op in Node.js
```

**Local directory layout** (required when `allowRemoteModels = false`):
```
/data/models/Xenova/all-MiniLM-L6-v2/
├── onnx/
│   ├── model.onnx               # FP32   — 86.2 MB
│   ├── model_q8.onnx            # INT8   — 22 MB (match dtype: 'q8')
│   ├── model_fp16.onnx          # FP16   — 43 MB (match dtype: 'fp16')
│   └── model_quantized.onnx     # INT8   — 22 MB (alias)
├── config.json                  # 650 B
├── tokenizer.json               # 712 KB (required)
├── tokenizer_config.json        # 366 B
└── special_tokens_map.json      # 125 B
```

The model ID passed to `pipeline()` is used as a sub-path under `localModelPath`, so the above directory would be referenced as `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')` with `env.localModelPath = '/data/models/'`.

For absolute paths, pass an absolute path (e.g., `/absolute/path/to/model`) instead of a model ID — the library detects it as a local path. [Source](https://huggingface.co/docs/transformers.js/api/env)

### 4. Tensor → `float[][]` Conversion

The pipeline returns `Tensor` objects (from `@huggingface/transformers`), not plain arrays. Conversion:

```typescript
function tensorToVectors(tensor: import('@huggingface/transformers').Tensor): number[][] {
  const data = tensor.data as Float32Array;
  const dims = tensor.dims;      // e.g., [batchSize, 384]
  const stride = dims.at(-1)!;   // 384 for all-MiniLM-L6-v2
  const batchSize = dims.length === 2 ? dims[0] : 1;
  const vectors: number[][] = [];
  for (let i = 0; i < batchSize; i++) {
    vectors.push(Array.from(data.subarray(i * stride, (i + 1) * stride)));
  }
  return vectors;
}
```

The Tensor also has a `.tolist()` method that returns nested JS arrays, but for performance-sensitive code, the `data` property + manual loop is faster because it avoids the deep-copy overhead of `.tolist()`.

**Important**: The raw output (without `pooling`/`normalize`) has shape `[batchSize, sequenceLength, hiddenSize]` — e.g., `[1, 8, 384]` for short text. Pooling collapses the sequence dimension.

### 5. Performance Characteristics (Xenova/all-MiniLM-L6-v2, 384-dim)

| Metric | Value | Notes |
|---|---|---|
| **Startup time (cold)** | 1–4 s | Loading + parsing ONNX model + tokenizer from disk |
| **Startup time (warm)** | 3–10 ms | Pipeline already constructed |
| **First inference** | 100–800 ms | ONNX session first-run optimization (varies by dtype) |
| **Subsequent inference** | 10–50 ms per batch of 1–40 texts | Scales near-linearly with batch size |
| **Model size on disk** | 22 MB (q8/int8), 43 MB (fp16), 86 MB (fp32) | Plus ~700 KB tokenizer |
| **RAM at idle** | ~40–60 MB after model load | Includes tokenizer + ONNX session |
| **Peak RAM (batch of 40)** | ~80–120 MB | Temporary activation tensors |
| **Dim** | 384 | All-MiniLM-L6-v2 |
| **Quality (MTEB)** | ~59.0 (all-MiniLM-L6-v2) | Comparable to `text-embedding-3-small` (~62) |

**Startup cost mitigation**: Construct the pipeline once at init and keep it as a singleton. The pipeline is designed to be reused for all subsequent calls.

**Model dtype recommendation for Node.js**:
- `dtype: 'q8'` (or `'int8'`) → best perf/accuracy trade-off, 22 MB download
- If quality is critical, `dtype: 'fp16'` → 43 MB, marginally better accuracy
- WebAssembly (`device: 'wasm'`) is ~3× slower than native CPU — in Node.js/Bun, the default `device: 'cpu'` uses `onnxruntime-node` native binding which is much faster

[Source](https://huggingface.co/Xenova/all-MiniLM-L6-v2), [ONNX model repository](https://huggingface.co/onnx-community/all-MiniLM-L6-v2-ONNX)

### 6. Adapter Layer Design

The current API interface in the project:

```typescript
// Current (OpenAI-compatible)
interface EmbedRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  inputs: string[];
  timeoutMs?: number;
}
interface EmbedResult { vectors: number[][]; }
```

A local provider adapter should abstract the differences:

```typescript
// Suggested abstraction — add a 'provider' field or separate function
type EmbedProvider = 'openai' | 'local';

interface LocalEmbedOptions {
  modelId: string;              // e.g., 'Xenova/all-MiniLM-L6-v2'
  modelDir?: string;            // overrides env.localModelPath
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  pooling?: 'mean' | 'cls' | 'none';  // default 'mean'
  normalize?: boolean;                  // default true
  device?: 'cpu' | 'wasm';              // default 'cpu' (native)
}

// Singleton wrapper class
class LocalEmbeddingProvider {
  private pipeline: FeatureExtractionPipeline | null = null;
  private options: Required<LocalEmbedOptions>;

  constructor(options: LocalEmbedOptions) { /* store options */ }

  async initialize(): Promise<void> {
    // Configure env for offline mode
    if (this.options.modelDir) {
      env.localModelPath = this.options.modelDir;
      env.allowRemoteModels = false;
    }
    this.pipeline = await pipeline('feature-extraction', this.options.modelId, {
      dtype: this.options.dtype,
    });
  }

  async embed(inputs: string[]): Promise<number[][]> {
    const tensor = await this.pipeline!(inputs, {
      pooling: this.options.pooling,
      normalize: this.options.normalize,
    });
    return tensorToVectors(tensor);
  }
}
```

Key adapter differences from OpenAI API:
- No `apiKey` or `baseUrl` fields
- `modelId` is a HuggingFace model name (not an API model string)
- The pipeline is a long-lived singleton — not recreated per request
- Timeout is irrelevant (local computation)
- The adapter produces `{ vectors: number[][] }` — same shape as `EmbedResult` → **drop-in compatible** with existing `fetchEmbeddingsImpl` injection point

### 7. Bun Compatibility — Known Issues

**Detection**: The library explicitly detects Bun (`typeof globalThis.Bun !== "undefined"`) at source line 23 of the bundled code.

**State**: Multiple issues have been reported and mostly fixed.

| Issue | Status | Impact |
|---|---|---|
| Bun 1.2.x — basic import + pipeline | ✅ Works | Standard `bun run` or `bun test` |
| `BROWSER_ENV` incorrectly true | ✅ Fixed (closed #920) | Now correctly sets `IS_NODE_ENV` |
| Bun `--compile` single binary | ⚠️ Open (#1672) | Three issues: static import of onnxruntime-node, missing `libonnxruntime.so.1` in bundle, `process.cwd()` at init time |
| Segmentation fault on Windows (Bun 1.3.13, onnxruntime-node) | ⚠️ Open (#28008) | Native addon incompatibility |
| `bun test` crashes on shutdown (macOS/Linux, onnxruntime-node 1.24+, Bun ≥1.3.0) | ⚠️ Open (#30431) | C++ exception during cleanup. **Workaround: pin to Bun 1.2.23** |
| Bun `postinstall` hooks for onnxruntime native addon | ✅ Works | The `node ./script/install` postinstall runs correctly in most Bun versions |

**Bottom line for Bun**:
- **Development / dev-server**: Works with Bun 1.2.x and 1.3.x for normal usage (not `--compile`). On macOS, use Bun ≤1.2.23 to avoid the shutdown crash (#30431).
- **Production deployment**: Node.js LTS is more battle-tested. If using Bun, pin to a tested version.
- **CI/CD**: Use `bun-version: 1.2.23` in CI until the shutdown crash is resolved.

---

## Sources

### Kept
- **npm: @huggingface/transformers** — Package metadata, dependencies, version info. Primary source for package identity. (npmjs.com)
- **Transformers.js README** — Official documentation for API usage, env settings, pipeline options. Covers feature-extraction, offline mode, and settings. (npm readme, huggingface.co)
- **Xenova/all-MiniLM-L6-v2 model hub** — Model card, file sizes, ONNX variants, downloads count. (huggingface.co/models/Xenova/all-MiniLM-L6-v2)
- **Transformers.js TypeScript definitions** — Exact type signatures for `pipeline()`, `FeatureExtractionPipeline`, `env`, `Tensor`. Extracted from npm package. (dist/types/)
- **GitHub: huggingface/transformers.js issues** — Bun compatibility tracking (#558, #920, #1333, #1672). (github.com/huggingface/transformers.js)
- **GitHub: oven-sh/bun issues** — onnxruntime-node crash reports (#30431, #28008). (github.com/oven-sh/bun)

### Dropped
- **Various blog posts about Transformers.js** — Opinion content without technical depth beyond what the README covers.
- **@xenova/transformers** (the old package) — Superseded by @huggingface/transformers. The migration path is a simple package swap.

---

## Gaps

1. **Quantized model quality comparison** — No direct MTEB score comparison between `q8` vs `fp16` vs `fp32` for `all-MiniLM-L6-v2` specifically. The quality differences are likely small (≤1 point) but unmeasured for this model.
2. **Exact Bun `--compile` workaround** — Issue #1672 describes the problem but no clean workaround is documented yet. Suggested next step: watch the issue or use Node.js for compiled distribution.
3. **GPU acceleration** — The library supports `device: 'webgpu'` in browsers but in Node.js the default is CPU-only. NVidia CUDA via onnxruntime-node-gpu is possible but not documented for this package.
4. **Persistent embedding cache interaction** — The existing `PersistentEmbeddingCache` caches by `baseUrl + model + inputs`. For the local provider, the cache key should use `modelId` instead of `baseUrl`.

## Supervisor Coordination

No decisions needed — this brief is a standalone research report. If implementing the adapter, consider using `ask_user` or a config flag to let users choose between `provider: "openai"` (current) and `provider: "local"` (new). The `fetchEmbeddingsImpl` dependency injection in `createIntentReadTool` makes this straightforward.
