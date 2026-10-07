# Advanced Repository Retrieval Research

**Date:** 2026-05-01
**Scope:** GraphRAG/semantic abstraction/MCP, CodeRAG/log-probability probing, and context-engineering/reranking for Pi-SmartRead.

## Executive summary

Pi-SmartRead already implements a strong local baseline: Pi `ToolDefinition` tools for `intent_read`, `repo_map`, `search_symbols`, `resolve_symbol`, and `find_callers`; hybrid BM25 + embedding retrieval; RRF fusion; tree-sitter tags; PageRank repo maps; direct import-neighbour augmentation; and file-system caches.

The external evidence supports three next directions, with caveats:

1. **Graph-backed retrieval is useful for multi-hop repository context**, but Microsoft GraphRAG's primary paper targets query-focused summarization over text corpora, not code. Code-specific evidence is stronger from DraCo and similar repository-completion work.
2. **CodeRAG is relevant but task-specific.** Its log-probability-guided query construction and BestFit reranking are designed for repository-level code completion. Pi-SmartRead can adapt the pattern, but `intent_read` is an agent retrieval tool, not an autocomplete decoder.
3. **Context engineering remains necessary.** Primary evidence for lost-in-the-middle shows position-sensitive degradation in long contexts. Broad “million-token wall” framing is not proven by the sources reviewed here and should not be used as a settled claim.

## Local baseline: what exists today

Pi-SmartRead is currently a TypeScript Pi extension, not a standalone MCP server.

Relevant local components:

| Area | Current implementation | Notes |
|---|---|---|
| Pi tool surface | `index.ts`, `repomap-tool.ts`, `intent-read.ts` | Tools are registered through `ExtensionAPI`/`ToolDefinition`. |
| Hybrid retrieval | `intent-read.ts`, `scoring.ts` | BM25 whole-file scores + chunk embedding cosine scores fused with RRF (`k = 60`). |
| Chunking and compression | `chunking.ts` | Regex/brace-based symbol-boundary chunking; compressed embedding snippets strip imports and keep head/tail. Not full tree-sitter skeletonization. |
| Graph orientation | `repomap.ts`, `tags.ts`, `pagerank.ts` | Tree-sitter tag extraction, definition/reference graph, PageRank ranking, import-based fallback. |
| Direct graph augmentation | `intent-read.ts` | Adds direct relative import neighbours before reading/ranking, capped by the 20-file candidate limit. |
| Call graph | `callgraph.ts` | Tree-sitter AST walk for TypeScript/JavaScript/TSX calls; exposed by `find_callers`. |
| Symbol resolution | `symbol-resolver.ts`, `repomap-tool.ts` | Finds definitions/references and best-guess primary definitions. |
| Caching | `cache.ts`, `persistent-embedding-cache.ts` | Tags and embeddings use file-system-backed caches. |

## External evidence

### CodeRAG: query construction, multi-path retrieval, BestFit reranking

**Source:** Sheng Zhang et al., “CodeRAG: Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion,” arXiv:2509.16112v1, 2025. The arXiv abstract identifies three core components: log-probability-guided query construction, multi-path code retrieval, and preference-aligned BestFit reranking. It evaluates on ReccEval and CCEval and links implementation to `KDEGroup/CodeRAG`.

**Evidence quality:** primary preprint and code repository. Strong evidence for repository-level code completion; weaker evidence for general agent retrieval because the task and latency model differ.

**Fit for Pi-SmartRead:**

- Keep the current user `query` as the primary retrieval intent.
- Add a **probe phase** that can infer missing symbols/files from the query and optional code prefix/context.
- Treat log-probability probing as optional and experimental because Pi-SmartRead does not currently control the generation model or expose token logprobs.
- Adapt “multi-path” retrieval as BM25 + embeddings + graph/symbol/dataflow signals, not as a direct copy of CodeRAG internals.

### DraCo: dataflow-guided retrieval for repository completion

**Source:** Wei Cheng, Yuhan Wu, Wei Hu, “Dataflow-Guided Retrieval Augmentation for Repository-Level Code Completion,” arXiv:2405.19782v1, 2024. The abstract describes parsing private repositories into code entities, building an extended dataflow context graph, and retrieving background knowledge from that graph for code completion. Per the paper's abstract, reported improvements include +3.43% exact match and +3.27% identifier F1 on average versus prior approaches.

**Evidence quality:** primary preprint; codebase-specific but Python-oriented and code-completion-oriented.

**Fit for Pi-SmartRead:**

- Supports a stronger structural retrieval story than simple import neighbours.
- Suggests adding dataflow-like edges after cheaper edges are proven useful.
- Should be phased after definition/reference and call edges because robust TypeScript dataflow analysis is more expensive than the current tree-sitter tag/call stack.

### GraphRAG: global sensemaking over graph-indexed corpora

**Source:** Darren Edge et al., “From Local to Global: A Graph RAG Approach to Query-Focused Summarization,” arXiv:2404.16130v2, 2024. The abstract frames GraphRAG as an approach for global questions over private text corpora. It builds an entity graph, pregenerates community summaries, and uses those summaries for query-focused summarization over roughly million-token datasets.

**Evidence quality:** primary paper from Microsoft Research. Strong for global corpus summarization; indirect for code repositories.

**Fit for Pi-SmartRead:**

- The “global question” motivation maps to repo questions like “what are the main subsystems?” or “what changes if routing changes?”
- Pi-SmartRead already has PageRank and tree-sitter tags, but it does not have durable entity summaries, community summaries, typed semantic edges, or graph traversal tools beyond `find_callers` and symbol search.
- Use GraphRAG as inspiration for **semantic abstraction layers**, not as proof that a generic text-corpus GraphRAG design will outperform existing code-aware retrieval.

### Lost-in-the-middle and context packing

**Source:** Nelson F. Liu et al., “Lost in the Middle: How Language Models Use Long Contexts,” arXiv:2307.03172v3, 2023. The abstract reports degraded performance when relevant information appears in the middle of long contexts, with best performance often at the beginning or end.

**Evidence quality:** primary paper. Strong evidence for position sensitivity. It does not prove a universal long-context limit, nor does it establish exact behaviour for every 2026 long-context model.

**Fit for Pi-SmartRead:**

- Supports continuing to retrieve a small, high-signal set instead of dumping large repo contexts.
- Supports placing highest-confidence evidence near prompt boundaries and preserving source attribution.
- Does not justify arbitrary “top 50 then top 5” defaults without local evaluation.

### MCP as an interface

**Sources:** Anthropic announcement, “Introducing the Model Context Protocol,” 2024-11-25; modelcontextprotocol.io specification pages.

**Evidence quality:** primary protocol/vendor documentation.

**Fit for Pi-SmartRead:**

- MCP is a credible packaging target for exposing repository context tools to non-Pi clients.
- It is not the current integration boundary. Pi-SmartRead currently registers Pi tools through `ExtensionAPI`.
- Any MCP work should be an adapter over shared core services, not a rewrite of the existing Pi extension.

### Comparative tools and weaker sources

The subagent brief also identified examples such as `er77/code-graph-rag-mcp`. These are useful comparative implementation examples, especially for graph-backed code search exposed through MCP-like tools. They are not primary academic evidence and should not be used to claim broad benchmark superiority.

The specific blog claim that “lost-in-the-middle is still real in 2026 even on 1M-token models” is plausible but weaker than primary papers. Use it only as commentary unless backed by reproducible benchmark data.

## Implications for Pi-SmartRead

### What to build from first

1. **Shared repository context graph**: reuse `repomap.ts`, `tags.ts`, `callgraph.ts`, and caches to expose typed edges between files, symbols, calls, imports, and chunks.
2. **Graph-aware candidate expansion**: extend `intent_read` beyond direct import neighbours, but keep deterministic caps and provenance in `details.graphAugmentation`.
3. **Probe phase**: extract likely identifiers, file paths, and symbols from the query and optional code context; resolve them before embeddings.
4. **Reranking phase**: add a post-RRF stage, starting with cheap structural/path/symbol signals before optional external cross-encoder or preference model calls.
5. **Context packing improvements**: keep high-signal snippets small, ordered, and attributed. Avoid assuming longer context is always better.

### What not to claim

- Do not claim Pi-SmartRead already has GraphRAG. It has graph ingredients: tags, PageRank, direct imports, call graph, symbol resolution.
- Do not claim MCP server support exists today. It exposes Pi tools.
- Do not claim full AST-aware skeletonization in `chunking.ts`; it uses text heuristics and brace matching.
- Do not claim a proven universal long-context limit. The reliable claim is position-sensitive degradation and noise sensitivity in long contexts.

## Source list

- Zhang et al., “CodeRAG: Finding Relevant and Necessary Knowledge for Retrieval-Augmented Repository-Level Code Completion,” arXiv:2509.16112v1, 2025 — https://arxiv.org/abs/2509.16112
- Cheng et al., “Dataflow-Guided Retrieval Augmentation for Repository-Level Code Completion,” arXiv:2405.19782v1, 2024 — https://arxiv.org/abs/2405.19782
- Edge et al., “From Local to Global: A Graph RAG Approach to Query-Focused Summarization,” arXiv:2404.16130v2, 2024 — https://arxiv.org/abs/2404.16130
- Liu et al., “Lost in the Middle: How Language Models Use Long Contexts,” arXiv:2307.03172v3, 2023 — https://arxiv.org/abs/2307.03172
- Anthropic, “Introducing the Model Context Protocol,” 2024-11-25 — https://www.anthropic.com/news/model-context-protocol
- Model Context Protocol specification/docs — https://modelcontextprotocol.io/
- KDEGroup/CodeRAG — https://github.com/KDEGroup/CodeRAG
- nju-websoft/DraCo — https://github.com/nju-websoft/DraCo
- er77/code-graph-rag-mcp — https://github.com/er77/code-graph-rag-mcp
