# Progress

## Status
In Progress

## Tasks

## Files Changed

## Notes

Researched Orama (@orama/orama) integration for code intelligence hybrid search:
- Package: @orama/orama v3.1.18 (0 deps, Apache 2.0)
- Schema with vector[N] properties, hybrid search with HybridWeights config
- Built-in save()/load() for persistence — critical for extension restart
- Custom Tokenizer interface supports camelCase splitting
- BM25 defaults: k=1.2, b=0.75, d=0.5, configurable per-query
- ~2 KB gzipped, search in μs for small datasets

See research/orama-brief.md

Researched sqlite-vec integration:
- Package: sqlite-vec v0.1.9 (MIT OR Apache), prebuilt binaries, no native compilation
- vec0 virtual tables: float[N], int8[N], bit[N]; metadata columns, partition keys, auxiliary columns
- KNN search with SQL WHERE filters on metadata + partition keys
- Works with better-sqlite3, bun:sqlite, node:sqlite via load()
- Persist in .smartread/vectordb/vectors.db with _schema_version migration
- Bulk insert via transactions; partition keys critical for 10k+ file perf
- Distance metrics: L2 (default), cosine; max 16 metadata + 16 auxiliary + 4 partition columns

See research/sqlite-vec-brief.md

Researched MCP SDK v1.29.0 advanced features:
- Prompts (ListPromptsRequestSchema / GetPromptRequestSchema)
- Resources (ListResourcesRequestSchema / ReadResourceRequestSchema)
- ResourceLink content type for tool results
- completable() for prompt argument autocompletion
- Capabilities object changes needed
- Full integration example with code

See research/mcp-advanced-brief.md

Researched @huggingface/transformers.js for local embedding provider:
- Package: @huggingface/transformers v4.2.0 (successor to @xenova/transformers v2.17.2)
- Feature extraction pipeline with built-in pooling/normalization → float[][]
- Offline mode via env.allowRemoteModels=false, env.localModelPath
- Model: Xenova/all-MiniLM-L6-v2 (384-dim, q8=22MB, fp16=43MB, fp32=86MB)
- ~1-4s cold start, 10-50ms/batch inference after warm
- Bun support present but known issues on 1.3.13+ (shutdown crash #30431)
- Adapter layer can be drop-in via existing fetchEmbeddingsImpl injection point

See research/transformersjs-brief.md
