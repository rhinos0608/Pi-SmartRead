# Tool Consolidation Plan

## Current State

**13 tools total** (10 core + 3 experimental):

| # | Tool | Category | Est. Tokens | Notes |
|---|------|----------|-------------|-------|
| 1 | `read` | READ | ~150 | Wraps builtin; has promptSnippet/renderResult contract |
| 2 | `read_files` | READ | ~250 | Batch reader with packing + internal URL routing |
| 3 | `intent_read` | READ | ~300 | Hybrid RRF retrieval (BM25 + embeddings + graph) |
| 4 | `search` | SEARCH | ~400 | Already consolidated (grep/code/deep modes) |
| 5 | `repo_map` | MAP | ~350 | PageRank + tree-sitter AST mapping |
| 6 | `find_symbol` | SYMBOL | ~250 | Name search via AST + LSP |
| 7 | `file_outline` | SYMBOL | ~220 | Single-file symbol listing |
| 8 | `find_references` | SYMBOL | ~230 | All usages of a symbol |
| 9 | `find_declaration` | SYMBOL | ~240 | Canonical definition location |
| 10 | `find_implementations` | SYMBOL | ~260 | Interface/class implementors |
| 11 | `graph_mutate` | MUTATE | ~350 | [EXPERIMENTAL] Edge recording |
| 12 | `git_notes_read` | NOTES | ~200 | [EXPERIMENTAL] Read git notes |
| 13 | `git_notes_write` | NOTES | ~280 | [EXPERIMENTAL] Write git notes |

**Total estimated overhead: ~3,480 tokens** at session start.

## Research Findings

Three patterns from production MCP deployments:

### Pattern 1: Meta-Tool / Progressive Disclosure
- Two meta-tools (`discover_tools` + `call_tool`) replace all schemas
- Model requests schemas on demand via BM25/embedding search
- **98-99% token reduction** at session start
- Threshold: worth building above ~50 tools; below that, load everything
- Source: SynapticLabs, ArtificialCuriosityLabs, GitLab MCP

### Pattern 2: Domain Action Dispatchers
- Group related tools under namespace with `action` parameter
- GitLab MCP: **1022 → 33 tools** via domain dispatchers
- Each dispatcher covers a bounded domain (project, merge_request, pipeline)
- Source: GitLab MCP server ADR-0005

### Pattern 3: Consolidate to Reduce Selection Ambiguity
- "If two tools are always called together, they should be one tool"
- LongFuncEval found expanding tool catalog caused **7-85% accuracy drops**
- "Lost-in-the-middle" effect: correct tool harder to find among distractors
- Source: agentpatterns.ai, Anthropic "Writing Tools for Agents"

## Codebase Review Findings

### What's Already Well-Designed
- **ToolRegistry** (`tool-registry.ts`): singleton, categories, experimental flag — solid foundation
- **Search tool**: already consolidated with 3 modes (grep/code/deep) — model picks by mode param
- **Descriptions**: each symbol tool explicitly contrasts with siblings ("Unlike find_symbol which...")
- **No cross-tool data coupling**: symbol tools return independent `{content, details}` objects

### What Can't Be Merged
| Pair | Reason |
|------|--------|
| `read` + `read_files` | `read` wraps builtin with `promptSnippet`/`renderResult` contract; schema change breaks wrapper |
| `graph_mutate` → any read tool | External Smart-Edit pipeline calls it; `index.ts` hooks on tool name string |
| `git_notes_read` + `git_notes_write` | Mirrors git R/W split; independently useful with different permission semantics |

### What Could Be Merged (With Tradeoffs)
| Candidate | Savings | Risk |
|-----------|---------|------|
| `find_references` → `find_symbol` | 1 tool, ~230 tokens | `find_references` is data superset; loses explicit name guidance |
| 5 symbol tools → 1 dispatcher | 4 tools, ~1,200 tokens | High: 5 distinct LSP paths, distinct parameter shapes, model must pick correct action |

### Ghost Tools in Tests
- `workspace_symbol` and `hover_type` appear in `test/unit/index.test.ts:41-42` and `mcp-server.test.ts:171-172`
- No source file defines these — likely removed without test cleanup
- Safe to delete from test expectations

## Recommended Plan

### Phase 1: Description Compression (Low Risk, High Impact)

**Target: ~600 token savings** without changing any tool boundaries.

Each symbol tool description averages ~500 chars. Compress to ~250 chars while preserving the disambiguation cues.

Before:
```
"Find the canonical definition of a symbol. Returns the single best definition location. 
Unlike find_symbol which lists all name matches, this pinpoints the authoritative declaration. 
Optionally supply a context file to guide LSP-backed lookup."
```

After:
```
"Find canonical definition of a symbol (single best location). Unlike find_symbol (all name matches), 
this pinpoints the authoritative declaration. Optional context file guides LSP lookup."
```

Apply to all 5 symbol tools + `repo_map` + `search`. The `search` description is particularly verbose at ~400 chars.

### Phase 2: Ghost Tool Cleanup (Zero Risk)

Remove `workspace_symbol` and `hover_type` from test expectations in:
- `test/unit/index.test.ts:41-42`
- `test/unit/mcp-server.test.ts:171-172`

### Phase 3: Symbol Tool Consolidation (Medium Risk, Worth Testing)

**Merge 5 symbol tools → 2 tools:**

1. **`find_symbol`** (keep as-is): name search across codebase via AST + LSP
2. **`symbol_info`** (new): merge `file_outline` + `find_declaration` + `find_references` + `find_implementations`

The `symbol_info` tool uses an `action` parameter:

```typescript
{
  name: "symbol_info",
  description: "Query symbol information: outline (file structure), declaration (canonical definition), references (all usages), or implementations (interface/class implementors).",
  parameters: {
    action: { enum: ["outline", "declaration", "references", "implementations"] },
    query: { type: "string" },           // required for declaration/references/implementations
    path: { type: "string" },            // required for outline; optional context for others
    directory: { type: "string" },       // optional root
    include_body: { type: "boolean" },   // optional, declaration/implementations
    maxResults: { type: "number" },      // optional, references/implementations
    childDepth: { type: "number" },      // optional, outline only
  }
}
```

**Savings**: 4 tools → 1, ~1,100 tokens eliminated.

**Tradeoff**: Model must pick correct `action` instead of correct tool name. Mitigated by:
- Clear action names matching existing tool semantics
- Description lists what each action does
- Only 4 choices vs 5 tools (net cognitive load reduction)

**Rollback**: Keep old tools registered under alternate names during testing.

### Phase 4: Meta-Tool Architecture (Future-Proofing)

If tool count grows beyond 15, implement the progressive disclosure pattern:

```
┌─────────────────────────────────────────┐
│  smartread_discover(query: string)      │  ← Always loaded; description contains capability index
│  Returns: matching tool schemas         │
├─────────────────────────────────────────┤
│  smartread_execute(tool, args)          │  ← Always loaded; routes to correct handler
│  Executes any tool by name              │
├─────────────────────────────────────────┤
│  read (always-on)                      │  ← High-frequency tools loaded unconditionally
│  search (always-on)                    │
│  repo_map (always-on)                  │
└─────────────────────────────────────────┘
```

This is NOT needed today (10 tools is well under the ~50 threshold). But the ToolRegistry already has the `category` metadata needed to build the capability index automatically.

## Implementation Status

✅ **Phase 1** — Description compression (shipped)
✅ **Phase 2** — Ghost tool cleanup (shipped)
✅ **Phase 3** — Symbol consolidation 5→2 (shipped)
⬜ **Phase 4** — Meta-tool progressive disclosure (future, if >15 tools)

## Token Budget Impact

| Phase | Tools | Token Overhead | Savings |
|-------|-------|---------------|---------|
| Before | 13 | ~3,480 | — |
| After (all shipped) | 10 | ~1,800 | -1,680 (48%) |

## Test Results

All 47 test files pass, 615 tests pass, 4 skipped, 0 failures.

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Description compression | Low | Preserve disambiguation cues; test model selection accuracy |
| Ghost cleanup | None | Tests already failing or passing incorrectly |
| Symbol consolidation | Medium | Feature flag; keep old names as aliases during transition; measure tool selection accuracy |
| Meta-tool | Low (if needed) | ToolRegistry already has category metadata |

## Decision Points

1. **Phase 3 go/no-go**: Run 50 sessions with consolidated symbol tool. If model selection accuracy drops >5%, revert.
2. **Phase 4 trigger**: Implement when tool count exceeds 15 OR when session-start token overhead exceeds 5,000 tokens.
