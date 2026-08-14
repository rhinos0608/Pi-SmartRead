# ADR-002: Graph Persistence Strategy — In-Memory Rebuild vs Serialized Store

**Status:** Proposed
**Date:** 2026-07-16
**Deciders:** Pi-SmartRead parity design

## Context

DeusData/codebase-memory-mcp stores its knowledge graph in a persistent SQLite database that survives restarts. Teams share `.codebase-memory/graph.db.zst` artifacts to skip re-indexing after clone.

Pi-SmartRead's `ContextGraph` is rebuilt entirely in-memory on every Pi session start (`buildContextGraph()` called from `hook.ts` during `session_start`). The `EdgeStore` (JSONL log) persists mutation events across sessions, and `IncrementalIndex` (Merkle-tree hashing) skips unchanged files, but the core graph data (symbol index, file index, call edges, import edges) is recomputed from source.

The parity target includes a cross-session graph that does not require full rebuild on every session start. However, the reference's SQLite graph architecture is deeply coupled to its C pipeline (158 grammars, multi-pass indexing, node/edge property schema). Replicating that in TypeScript is a major engineering investment.

## Decision

**Incremental rebuild with warm cache — NOT full graph serialization.**

### Strategy

1. **Keep ContextGraph in-memory** as the canonical runtime graph. Do not serialize the full graph to disk.
2. **Strengthen IncrementalIndex** to serve as the disk-level graph state:
   - Already persists file-content hashes to `.pi-smartread/file-hashes.json`
   - Extend to store per-file symbol counts and edge counts alongside hashes
   - On session start, `IncrementalIndex.diff()` returns only files whose content hash changed since last build
   - `ContextGraph.buildContextGraph()` builds the full graph but only re-parses changed files — unchanged files reuse cached tags from `TagsCache` (which already has a disk cache at `.pi-smartread/tags-cache/`)
3. **Keep EdgeStore as-is** (JSONL log for mutation events, survives restarts, auto-loaded by ContextGraph)
4. **Keep ADR store as-is** (markdown files, survives restarts)
5. **Keep SemanticIndex as-is** (SQLite-vec, survives restarts, model-fingerprinted)

**Edge restoration after restart:** Import and call edges are **not** persisted as a serialized edge set. After restart, `buildContextGraph()` reconstructs them eagerly during session-start via cache-backed reads from `TagsCache` (disk-cached at `.pi-smartread/tags-cache/`). For each file, the tag cache provides pre-parsed AST summaries; `ContextGraph` rebuilds provenance edges (imports, defines, references) by scanning these tags. Call edges are re-derived from the `buildCallGraph()` pass over the same cached tags. Breakage and co-change edges survive via EdgeStore (JSONL log). The net effect: unchanged files contribute their edges from cache (target: ~100ms for 500 files, with parity suites at `test/unit/incremental-index.test.ts` covering diff accuracy, skip-rate parity, and cache invalidation), only modified files trigger re-parsing.

### Rationale

- ContextGraph is a consumer-facing index optimized for O(1) neighbor lookups, not a storage engine. The durable state is: (a) source files (git), (b) tags cache (disk), (c) edge store (JSONL), (d) semantic index (SQLite). Rebuilding the in-memory graph from these sources is ~100ms for a 500-file repo — negligible vs session-start overhead.
- Full graph serialization to SQLite requires: schema design for node/edge tables, migration handling, read/write contention, and is ~2K+ LOC with ongoing maintenance. The benefit (skipping ~100ms rebuild) doesn't justify the cost.
- The "cross-session memory" requirement is satisfied by the durable layers (EdgeStore, ADRs, SemanticIndex, tags cache) — the agent doesn't lose learned relationships or decisions.
- Multi-session team sharing is an explicit non-goal for Pi-SmartRead (CROSS_* edges are out of scope per the capability matrix). Team-shared graph artifacts are irrelevant.

## Consequences

### Positive
- Minimal code change (~200 LOC to extend IncrementalIndex with per-file graph stats)
- No schema migration risk
- No concurrent-access issues (ContextGraph is single-session)
- Preserves existing architecture — no refactor of ContextGraph internals

### Negative
- Still rebuilds symbol/file indices on every session (though only ~100ms for typical repos)
- No team-shared graph snapshot — but this is out of scope
- `TagsCache` disk format must stay stable across versions (already true)

### Alternatives Considered

1. **Full SQLite graph store (rejected):** Too large. Requires ORM or manual SQL, schema migrations, read/write locking. The benefit is only faster startup for very large repos (>5K files), which is infrequent for agent sessions.
2. **Serialized JSON/MessagePack dump (rejected):** Fragile — schema drift causes silent corruption. No query capability. Large files for big repos.
3. **Leverage the existing SemanticIndex SQLite for graph data (rejected):** SemanticIndex has its own SQLite schema (chunk embeddings). Mixing graph data would couple two independent subsystems and create migration hazards.
4. **Redis/Memcached (rejected):** External dependency, inappropriate for local extension.

## Validation

- [ ] `IncrementalIndex.diff()` returns accurate per-file change status across restarts
- [ ] `ContextGraph.buildContextGraph()` skip rate matches `IncrementalIndex.diff()` result
- [ ] TagsCache disk cache invalidates correctly when file hash changes
- [ ] No new files created beyond extending IncrementalIndex metadata format
