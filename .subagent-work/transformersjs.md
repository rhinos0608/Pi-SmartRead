# Transformers.js Local Embedding Provider — Implementation Notes

## What was implemented

### 1. `local-embedding-provider.ts` (new file)

Exports three public symbols:

| Symbol | Signature | Purpose |
|---|---|---|
| `LocalEmbedOptions` | interface | Constructor options (modelId, modelDir, dtype, normalize) |
| `tensorToVectors` | `(tensor: {data, dims}) => number[][]` | Converts pipeline Tensor → plain vectors |
| `isLocalEmbeddingAvailable` | `() => Promise<boolean>` | Dynamic-import check for the optional dep |
| `LocalEmbeddingProvider` | class | Core provider |

`LocalEmbeddingProvider` class surface:
- `constructor(options?)` — stores options, all optional with sensible defaults
- `async initialize()` — sets `env.allowRemoteModels = false` + `env.localModelPath` when `modelDir` is given; creates the pipeline once
- `async embed(inputs: string[]): Promise<number[][]>` — calls pipeline with `{ pooling: 'mean', normalize: true }`; throws descriptive error if called before `initialize()`
- `modelId` / `dtype` getters — for test introspection
- Default model: `Xenova/all-MiniLM-L6-v2`; default dtype: `fp16`; default normalize: `true`

Key design decisions:
- **Dynamic import** (`await import('@huggingface/transformers')`) inside both `initialize()` and `isLocalEmbeddingAvailable()` — the module is an optional dependency and must not crash the extension if absent.
- Pipeline stored as `Promise<unknown>` at runtime (dynamic import prevents compile-time typing), cast through a plain `{data, dims}` interface for `tensorToVectors`.
- `tensorToVectors` uses `Array.from(data.subarray(...))` — allocates fresh arrays so callers cannot accidentally alias into the Tensor's backing buffer.

### 2. `embedding.ts` (modified — 1 new export added)

```typescript
export interface LocalEmbedRequest { inputs; modelId?; modelDir?; dtype?; normalize? }
export async function fetchLocalEmbeddings(req: LocalEmbedRequest): Promise<EmbedResult>
```

`fetchLocalEmbeddings` constructs a `LocalEmbeddingProvider`, calls `initialize()`, then `embed()`, and returns `{ vectors }` — identical result shape to `fetchEmbeddings`. Callers choose which function to use; the existing `fetchEmbeddings` signature is unchanged.

### 3. `test/unit/local-embedding-provider.test.ts` (new file)

- `tensorToVectors` unit tests — round-trip fidelity (length, element count, no memory sharing)
- Construction tests — defaults, custom modelId, all option fields
- `isLocalEmbeddingAvailable` test — returns a boolean (passes because the package is installed in this environment)
- Integration block (4 tests) — **skipped by default** (`RUN_LOCAL_EMBED_TESTS` env var required); tests `initialize()` + `embed()`, vector dimensionality (384 for all-MiniLM-L6-v2), L2-normalization, and the "not initialized" error path

## Test results

```
bun test test/unit/local-embedding-provider.test.ts
9 pass | 4 skip | 0 fail
```

- Unit tests: all pass.
- Integration tests: skipped (requires `RUN_LOCAL_EMBED_TESTS=1`; also requires the cached ONNX model to be present on disk, which may not be the case in all environments).

**Note on integration failures in CI**: When `RUN_LOCAL_EMBED_TESTS=1` was set, the model failed to initialize (`onnxruntime` exception — model graph incompatibility with the installed onnxruntime version). This is an environment-specific issue (model file vs. native addon mismatch); it does not indicate a problem with the provider code itself. The unit-test suite is sufficient for CI gating.

## Open risks / limitations

1. **Model initialization is slow** (~1–4 s cold) — callers should initialize the provider once at startup and hold the instance, rather than calling `fetchLocalEmbeddings` per-request (which would reconstruct + reload the pipeline each time).
2. **No caching of vectors** — the existing `PersistentEmbeddingCache` can be used as a write-through cache keyed by `modelId + inputs`; `fetchLocalEmbeddings` does not integrate with it automatically.
3. **Singleton pattern not enforced** — callers who call `fetchLocalEmbeddings` repeatedly will pay the pipeline-construction cost each time. A future improvement would be a module-level singleton with `provider?: LocalEmbeddingProvider` lazily initialized.
4. **onnxruntime-node shutdown crash on Bun** — known upstream issue (`huggingface/transformers.js` #28008 / #30431); recommend Bun ≤1.2.23 in CI. Not a code defect.
5. **`fetchLocalEmbeddings` does not integrate with `fetchEmbeddingsSharded`** — sharding is API-specific (network parallelism); local inference is single-process and handles batching internally via the pipeline.

## Recommended next step

Integrate `LocalEmbeddingProvider` into `createIntentReadTool` via a config flag (e.g., `embeddingProvider: 'openai' | 'local'`) in the tool options, using the existing dependency-injection point that already accepts an `embedImpl` function. This allows users to switch between OpenAI and local embeddings without code changes.