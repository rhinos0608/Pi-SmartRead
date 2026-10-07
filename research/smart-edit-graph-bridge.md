# Pi-SmartRead ↔ Smart-Edit Graph Bridge

## Architecture

Connects Pi-SmartRead (retrieval, graph, embeddings) with Smart-Edit (LSP, git, edit pipeline) through three bridges:

### 1. Anchor Bridge (Read Cache)
Pi-SmartRead's `formatContentBlock()` and read tool wrapper now prefix each output line with `LINE|` anchors:

```
42|    return x;
```

Smart-Edit's `parseTag()` supports `LINE|` as a valid anchor. The stale-file guard has retrieval-time version awareness.

### 2. Graph Mutation Bridge (Feedback Loop)
Smart-Edit's post-edit diagnostics and git history analysis write edges back to Pi-SmartRead's context graph.

**File-based IPC:** `.pi-smartread/graph-mutations.jsonl` (append-only JSONL)
- Smart-Edit writes via `smartread-bridge.ts`
- Pi-SmartRead replays via `EdgeStore.readEdges()` during graph construction

### 3. Tool Bridge
`graph_mutate` tool accepts breakage/co-change edges from any source.

### Edge Types
| Type | Source | Confidence | Decay |
|------|--------|-----------|-------|
| `breakage` | Post-edit LSP diagnostics | 0.9-1.0 | Persistent |
| `co_change` | Git history co-change | 0.6-0.7 | 30-day window |

### Files Modified/Added

**Pi-SmartRead:**
- `context-graph.ts` — EdgeType (+breakage/+co_change), EdgeStore class, loadMutationEdges()
- `graph-mutate.ts` (new) — graph_mutate tool
- `hook.ts` — LINE| anchor embedding in normal read tool output
- `utils.ts` — prefixLinesWithAnchors()
- `intent-read.ts` — Phase 2e mutation edge expansion
- `index.ts`, `mcp-server.ts` — tool registration

**Smart-Edit:**
- `lib/hashline-edit.ts` — LINE| anchor parsing, hash-skip for `|` anchors
- `src/smartread-bridge.ts` (new) — writes to EdgeStore JSONL
- `index.ts` — breakage edge recording, evidence pipeline wiring

### Event-Sourcing
Edges are append-only JSONL, replayed on graph construction. Determinism within a retrieval call is preserved because replay happens at graph build time, not during query.
