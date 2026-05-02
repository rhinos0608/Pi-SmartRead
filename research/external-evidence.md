# Research Brief: Advanced RAG and Context Engineering for Repository Intelligence

## Summary
Adapting repository-level intelligence requires moving beyond vector-based RAG toward **GraphRAG** (structural dependency mapping) and **adaptive query construction** (CodeRAG). Evidence for 2026 confirms that "Lost-in-the-Middle" remains a critical bottleneck even in million-token models, necessitating local reranking and positional context engineering. The **Model Context Protocol (MCP)** has emerged as the definitive interface for exposing these graph-backed capabilities to AI agents natively.

## Findings

1. **GraphRAG for Structural & Multi-Hop Reasoning**
   - **Mechanism**: Indexing raw code into a topological knowledge graph (nodes for functions, classes; edges for imports, calls, inheritance) allows models to resolve multi-hop queries (e.g., "blast radius of changing X").
   - **Primary Example**: **GitNexus** uses Tree-sitter to build local knowledge graphs stored in LadybugDB. It outperforms vector RAG by prioritizing execution flows and structural connectivity. [Source](https://byteiota.com/gitnexus-knowledge-graph-for-code-intelligence/)
   - **Multi-hop Strategy**: Strategic-GraphRAG replaces similarity-based retrieval with shortest-path traversal on the knowledge graph, refined by neural reranking. [Source](https://github.com/microsoft/graphrag)

2. **CodeRAG (EMNLP 2025): Log-Probability Guided Probing**
   - **Log-Prob Probing**: Instead of using a fixed window of the last *k* lines, CodeRAG uses the LLM's own log-probabilities (confidence) on the current prefix to identify "unstable" tokens. This triggers a specific retrieval query targeting what the model actually lacks.
   - **Multi-Path Retrieval**: Combines Sparse (BM25), Dense (Embeddings), and **Dataflow** retrieval. This ensures that both variable usage patterns and semantic requirements are captured.
   - **BestFit Reranking**: Utilizes a preference-aligned reranker to select code snippets that the specifically targeted LLM can best utilize for completion. [Source](https://arxiv.org/abs/2509.16112)

3. **Context Engineering & Long-Context Degradation**
   - **Persistence of U-Curve**: Even in 1M-token models (e.g., Claude 4.5/5.0 family), recall degradation is significant when the answer is placed in the middle of a large prompt (Lost-in-the-Middle). 
   - **Positional Optimization**: High-signal/most-relevant chunks should be placed at the very start or very end of the context window. Repeating the instruction/question immediately before the generation turn ("anchoring") significantly improves recall.
   - **Local Reranking**: Vector search should fetch a broad candidate set (e.g., Top 50), which is then narrowed by a local neural reranker to the top 5-10 for prompt inclusion to minimize cost and noise. [Source](https://dev.to/gabrielanhaia/lost-in-the-middle-is-still-real-in-2026-even-on-1m-token-models-2ehj)

4. **MCP as the Interface for Code Intelligence**
   - **Standardization**: MCP provides the "USB-C port" for LLMs to access repository-level tools. 
   - **Capability Exposure**: Advanced tools (like GitNexus) expose 11+ specialized MCP tools (e.g., `impact_analysis`, `trace_execution`, `detect_changes`) that allow AI agents to query the knowledge graph without model-side cost for graph traversal. [Source](https://modelcontextprotocol.io/docs/getting-started/intro)

## Sources
- **Kept**: 
    - [CodeRAG: Finding Relevant and Necessary Knowledge... (EMNLP 2025)](https://arxiv.org/abs/2509.16112) — Primary source for adaptive query construction.
    - [GitNexus: Knowledge Graph for Code Intelligence](https://byteiota.com/gitnexus-knowledge-graph-for-code-intelligence/) — Primary documentation for production implementation of GraphRAG in codebases.
    - [Lost-in-the-Middle Is Still Real in 2026](https://dev.to/gabrielanhaia/lost-in-the-middle-is-still-real-in-2026-even-on-1m-token-models-2ehj) — Recent benchmark data and practical mitigation strategies.
    - [Project GraphRAG - Microsoft Research](https://www.microsoft.com/en-us/research/project/graphrag/) — Authoritative foundation for the GraphRAG paradigm.
- **Dropped**:
    - Various Medium blogs on "How to build a RAG" — redundant and lacked primary benchmark data/specific architectural details for repo-level scale.

## Gaps & Implementation Caveats
- **Latency**: Multi-path retrieval and neural reranking increase per-call latency. Implementation should favor asynchronous pre-indexing and background "stale-index" detection (as seen in GitNexus).
- **Probing Cost**: Log-probability probing requires a fast, local "probe" model or cheap API access if the main LLM is too slow for real-time query refinement.
- **Graph Scalability**: For very large TypeScript repos, full-graph traversal in the prompt turn is unfeasible; the graph must be queried via specific MCP tools to keep context tokens focused.

## Pi-intercom handoff
Research complete. Findings focus on CodeRAG's log-probability probing and GitNexus's MCP-native Graph RAG architecture. Brief saved to `research/external-evidence.md`. Orchestrator: Do you want to dive into specific TypeScript-native implementation patterns for the Dataflow Graph mentioned in CodeRAG?
