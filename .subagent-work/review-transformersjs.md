## Review
- Correct: `tensorToVectors()` correctly copies pooled 1D/2D tensor rows into `number[][]`; the unit tests cover multi-row output and no shared-memory aliasing (`local-embedding-provider.ts:36-49`, `test/unit/local-embedding-provider.test.ts:8-54`).
- Correct: `isLocalEmbeddingAvailable()` is a simple optional-dependency probe and returns a boolean as expected (`local-embedding-provider.ts:60-66`).
- Verified: `npm run typecheck` passes, and `npx vitest run test/unit/local-embedding-provider.test.ts` passes.
- [BLOCKER] `fetchLocalEmbeddings()` creates a fresh `LocalEmbeddingProvider` and calls `initialize()` on every invocation, so the Transformers pipeline/model is loaded per request instead of reused (`embedding.ts:30-46`). This defeats the singleton reuse recommended for this model and will be very slow in production.
- [WARN] `initialize()` mutates global `env.allowRemoteModels` / `env.localModelPath` but never restores them, so one local-model init can leak offline settings into later providers in the same process (`local-embedding-provider.ts:94-107`).
- [WARN] `fetchLocalEmbeddings()` is not a drop-in for the existing embedding interface: it introduces `LocalEmbedRequest` instead of `EmbedRequest`, so it cannot be passed directly to `createIntentReadTool`’s `fetchEmbeddingsImpl` without an adapter (`embedding.ts:15-46`, `intent-read.ts:174-177`).
- [NIT] `isLocalEmbeddingAvailable()` catches all errors, which is fine for availability probing but also hides non-module-not-found import failures (`local-embedding-provider.ts:60-66`).
- [NIT] The current tests do not exercise `fetchLocalEmbeddings()` or repeated `initialize()` calls, so the slow/reload path is untested (`test/unit/local-embedding-provider.test.ts:96-159`).
