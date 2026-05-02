# Meta-Prompt: Implement GraphRAG and Query Probing Expansion

## Goal
Enhance the `intent_read` tool with **GraphRAG** (using the existing call graph and reference graph) and **Query Probing** (expanding seed files via symbol discovery). Introduce a **Reranking** pass for high-precision results.

## Context/Evidence
- `intent-read.ts`: Current implementation uses RRF and simple import-neighbor expansion.
- `callgraph.ts`: Provides functional dependency edges via tree-sitter.
- `repomap.ts`: Provides symbol reference edges via PageRank weighting.
- `symbol-resolver.ts`: Logic for finding definitions from symbols.
- `scoring.ts`: Core ranking logic.

## Success Criteria
- `intent_read` candidate set is expanded using call-graph neighbors and symbol definitions.
- Query intent is matched against symbol definitions *before* vector search to "seed" the retrieval.
- Top-50 results are reranked using a secondary signal (e.g., structural centrality or path proximity) before packing.
- `details` observability includes `probingInfo` and `rerankStats`.

## Hard Constraints
- Do not add new external heavy dependencies (maximize use of existing `tree-sitter`).
- Maintain backward compatibility with `pi-smartread.config.json`.
- Latency must remain manageable (use caching for graph results).

## Suggested Approach
1. **Probe Phase**:
   Extract keywords from `params.query` via:
   1. Tokenise by splitting on whitespace and all non-alphanumeric/non-underscore characters.
   2. Split tokens at camelCase and snake_case boundaries (e.g., `myClass` → `my`, `class`).
   3. Lower-case all tokens.
   4. Remove common English stop-words.
   5. Apply optional Porter stemming (as a toggle).
   6. Treat contiguous alphanumeric sequences as multi-word identifiers.
   7. Drop tokens shorter than 3 characters (default).
   Resulting keywords are passed to `searchIdentifiers` and added to the candidate list.
2. **Graph Expansion**: Use `buildCallGraph` (or a cached subset) to add callers/callees of candidates.
### Reranker Pass
If both `bestDefinition` and PageRank signals are present:
- `finalScore = w_def * bestDefinition + w_pr * PageRank`
- Default weights: `w_def=0.7`, `w_pr=0.3` (configurable constants in `intent-read.ts`).
- Fallback: Use the single available signal if one is missing, otherwise fall back to the original RRF score if neither exists.
Reference: `intent-read.ts` (`rerank` function), `symbol-resolver.ts` (`bestDefinition` outputs), and `RepoMap` (`PageRank` values).

## Validation
- `npm test`: All existing unit tests pass.
- New tests in `test/unit/graph-rag.test.ts` verifying neighbor expansion.
- Manual verification: Querying for an identifier name (without filename) should correctly yield its definition as the #1 result.

## Stop/Escalation Rules
- Use `intercom` if the graph size for a repo exceeds memory limits during parsing.
- Stop if tree-sitter bindings fail on a specific language — fall back gracefully to existing regex expansion.
