# pi-hashline-readmap Integration Research

## Summary

`pi-hashline-readmap` is a drop-in pi extension that replaces stock `read`, `edit`, `grep`, `ls`, `find` tools and adds `write`, `ast_search`, `nu`, with RTK bash output compression. This document compares it against **both** Pi-SmartRead (read/search) and Pi-SmartEdit (edit side) to identify features worth integrating.

**Key decision**: Pi-SmartRead should NOT implement edit — Pi-SmartEdit already handles the full edit lifecycle with a more sophisticated pipeline than pi-hashline-readmap. Pi-SmartRead's role is the read/search/graph side.

---

## Part A: Hashline Engine & Read Side

### 1. Hashline Engine — MODERATE PRIORITY (partial overlap)

Three hash engines exist across the ecosystem:

| Feature | pi-hashline-readmap | Pi-SmartEdit | Pi-SmartRead |
|---------|-------------------|--------------|--------------|
| Hash algorithm | xxHash32 % 16³ → hex 3-char (`abc`) | xxHash32 % 672 → bigram 2-char (`ab`) | xxHash32 % 672 → bigram 2-char (`ab`) |
| Hash length | 3 hex chars (4096 buckets) | 2 chars (672 buckets) | 2 chars (672 buckets) |
| Anchor format | `LINE:HASH\|content` (colon) | `LINE+HASH\|content` (no colon) | `LINE+HASH\|content` (no colon) |
| Inbound parsing | Colon-separated only | Accepts `LINE+HASH`, `LINE\|`, and colon | Not implemented |
| Whitespace normalization | `line.replace(/\s+/g, "")` before hash | Raw trimmed line | Raw trimmed line |
| Structural lines | N/A | Ordinal bigrams (`1st`, `2nd`, `3rd`, `th`) | Ordinal bigrams (`st`, `nd`, `rd`, `th`) |
| Mismatch error | `HashlineMismatchError` + `updatedAnchors: PtcLine[]` | `HashlineMismatchError` + rebase window | Not implemented |
| Auto-relocation | Token-similarity scan ±50 lines | Hash rebase ±5 lines | Not implemented |
| Confusable hyphens | Normalized (Unicode `\u2010`–`\u2212`) | Not normalized | Not normalized |
| Merge detection | Detects conflict markers | Not implemented | Not implemented |

**Verdict**: Pi-SmartRead and Pi-SmartEdit use the same hash algorithm (bigram-based, `LINE+HASH` format). **Do NOT change the hashline engine** — the anchor format is the critical IPC interface between read output (Pi-SmartRead) and edit input (Pi-SmartEdit). Maintain format compatibility.

**What to borrow from pi-hashline-readmap**: The `HashlineMismatchError` pattern with auto-relocation and suggested anchors. This could enhance Pi-SmartEdit's existing rebase window with richer feedback. But this is a **Smart-Edit enhancement**, not a Pi-SmartRead change.

### 2. Read Side Features — LOW PRIORITY (Pi-SmartRead is stronger)

| Feature | pi-hashline-readmap | Pi-SmartRead |
|---------|-------------------|--------------|
| Multi-file read | Single file only (`read`) | `read_multiple_files` (up to 20 files, adaptive packing) |
| Intent-based read | `symbol: "name"` | `intent_read` (BM25 + semantic cosine hybrid RRF) |
| Code search | `grep`, `ast_search` | `search` (symbols, code, callers, resolve) |
| Deep search | Not available | `deep_search` (multi-phase with graph expansion) |
| Repo map | Per-file structural map | `repo_map` (PageRank, full-project perspective) |
| Graph enrichment | Not available | Graphify knowledge graph, neighbor expansion |
| Hashline output on read | `LINE:HASH\|content` on every line | Via `buildHashlineAnchors` in hook |
| Symbol navigation | Per-file symbol lookup | Cross-file symbol resolution via `symbol-resolver` |
| Git-aware recency | Not available | `hook.ts` contextual enrichment with git co-commit recency |

**Verdict**: Pi-SmartRead's read/search tools are already far more powerful than pi-hashline-readmap's. No read-side features need porting.

---

## Part B: Edit Side — pi-hashline-readmap vs Pi-SmartEdit

### This is the critical comparison. Pi-SmartEdit already handles the edit lifecycle.

### 3. Architecture Comparison

```text
pi-hashline-readmap edit flow:
  input → parse edit variants → probe replace_symbol → check anchor overlap
  → validate hashes → apply edits → post-edit verify (optional)
  → syntax regression check (tree-sitter) → diff generation
  → difftastic semantic classification → return

Pi-SmartEdit edit flow:
  input → detect format (search/replace, unified diff, OpenAI patch, Codex, streaming)
  → prepareArguments + legacy compat → validateInput
  → read-cache: checkStale (mtime+size+hash, 3 retries for APFS)
  → read-cache: checkRangeCoverage (must have read the target lines)
  → approval-gating: checkEditSafety (dangerous paths/symbols)
  → conflict-detector: checkConflicts (AST-level across sequential edits)
  → 4-tier matching: exact → indent → whitespace → fuzzy
  → applyEdits → atomicWrite (temp file + rename)
  → LSP diagnostics + compiler fallback diagnostics
  → post-edit evidence pipeline (concurrency, traceability, history)
  → SmartRead bridge: recordBreakage + recordCoChange
  → conflict-detector: recordEdit (track for future conflict detection)
  → diff generation → return
```

### 4. Feature-by-Feature: What Pi-SmartEdit Has That pi-hashline-readmap Doesn't

| Feature | Description | Priority |
|---------|-------------|----------|
| **4-tier matching pipeline** | Exact → indent-normalized → whitespace-normalized → fuzzy substring with scoring. pi-hashline has only `replace` with `fuzzy: true` option | Core |
| **Multi-format input** | search/replace pairs, unified diff, OpenAI patch format, Codex patch format, streaming patch parser. pi-hashline only has anchor-based + replace | Core |
| **Read-range coverage guard** | Rejects edits to lines the model hasn't read. Tracks which line ranges each tool read, validates edit span intersects read span | HIGH |
| **Stale file detection with APFS retries** | mtime+size+content hash, 3 retries with 20/40/80ms backoff for APFS rename race condition | HIGH |
| **AST-level conflict detection** | Tracks edited symbols across sequential edit calls. Detects when two edits target the same function body (semantic conflict, not byte overlap). Modes: warn / error / auto-reread | HIGH |
| **LSP diagnostics** | Post-edit type-check via language server (tsserver, rust-analyzer, gopls, jdtls, pyright). Reports errors in edited AND other files | HIGH |
| **Compiler fallback diagnostics** | When LSP unavailable, dispatches to `tsc --noEmit`, `cargo check`, etc. | MODERATE |
| **Post-edit evidence pipeline** | 3 lanes: concurrency signal detection (async/thread/lock/atomic/channel), traceability analysis (test coverage for changed targets), git history retrieval (blame + recent changes) | MODERATE |
| **Atomic writes** | Temp file + rename with mode preservation. Cross-device fallback to direct write | Core |
| **Approval gating** | Checks file paths against dangerous patterns, edit content against dangerous symbols. Levels: never_prompt / prompt_on_dangerous / prompt_always | LOW |
| **SmartRead bridge (breakage edges)** | After LSP diagnostics find errors in OTHER files, records breakage edges to Pi-SmartRead's graph mutation log. Enables future intent_read to surface the broken file | HIGH |

### 5. Feature-by-Feature: What pi-hashline-readmap Has That Pi-SmartEdit Doesn't

| Feature | Description | Could benefit Pi-SmartEdit? |
|---------|-------------|---------------------------|
| **Primary hashline anchor editing** | `set_line`, `replace_lines`, `insert_after` by LINE:HASH anchor. Pi-SmartEdit has experimental hashline but oldText/newText is primary path | Yes — Pi-SmartEdit has the infrastructure (via `lib/hashline-edit.ts`), just off by default |
| **replace_symbol** | Replace entire function/class/method by name, no anchors. Resolves via readmap, handles indentation, validates syntax regression | Yes — natural UX improvement. Could be added as a convenience variant in Smart-Edit |
| **Write tool** | Creates new files with hashline output. Binary detection. Pi-SmartEdit has no write tool | Yes — new file creation is a missing primitive |
| **Difftastic semantic classification** | Classifies diffs as no-op / whitespace-only / semantic / mixed | Yes — richer diff metadata |
| **Post-edit verify (read-back)** | Optional re-read after write to confirm persisted content matches intended | Partial — Smart-Edit's atomic write is already robust |
| **PTC structured output contract** | Versioned `details.ptcValue` with PtcLine arrays, PtcEditResult, PtcError, PtcWarning. All tools emit structured data alongside text | Yes — would make downstream consumers (context optimizer, renderers) deterministic |
| **Context hygiene (full window stale marking)** | Tracks every tool result, marks context window entries stale when a mutation invalidates them. Much broader than Smart-Edit's per-file stale check | Yes — complementary. Smart-Edit checks at edit time; context hygiene marks ALL stale reads in the full context window |
| **Doom loop detection** | Detects identical repeated calls (3+) and alternating loops. Injects warnings with tool-specific suggestions | Yes — neither Smart-Edit nor Pi-SmartRead has this |
| **RTK bash compression** | Route-specific compression for test runners, git, linters, builds, package managers, docker, HTTP clients, file listings, transfers | Yes — Pi-SmartRead relies on stock bash output |
| **ReadMap structural mapping** | Per-file symbol map (18 languages via tree-sitter/regex/ctags). Appended on read truncation | Partial — Pi-SmartRead has `repo_map` (more powerful, repo-wide) |
| **ls / find tools** | Directory listing and recursive discovery with hashline anchors | Low — existing pi stock tools adequate |

---

## Part C: Integration Recommendations for Pi-SmartRead

### HIGH PRIORITY — Implement in Pi-SmartRead

#### 1. Context Hygiene / Stale Context Tracking

**What**: After any mutation (Pi-SmartEdit writes a file), mark prior read/grep/search results that reference the mutated file as stale. Replace them with `[Stale read context: file content changed...]` placeholders in the context window.

**Why**: Pi-SmartRead currently has zero stale tracking. If Pi-SmartEdit changes a file, prior reads of that file remain in context silently — the LLM may act on stale data.

**How**: Port `context-hygiene.ts` and `context-application.ts` from pi-hashline-readmap. Wire into Pi-SmartRead's `index.ts`:
- `pi.on("tool_result", ...)` to record every tool call
- `pi.on("context", ...)` to apply stale markers before context is sent
- When `graph_mutate` fires, mark affected file reads stale
- When Smart-Edit writes to a file (detectable via the breakage bridge or a new "file written" event), mark stale

**Files to port**: `context-hygiene.ts`, `context-application.ts` (~400 lines total)

#### 2. Doom Loop Detection

**What**: Detect when the LLM makes identical repeated tool calls (3+ identical calls) or alternating loops (A→B→A→B 3+ times). Inject a prominent warning with tool-specific suggestions.

**Why**: Neither Pi-SmartRead nor Pi-SmartEdit has this. LLMs frequently get stuck in loops calling the same search/read tool with identical params. This is a pure safety win with zero impact on existing behavior.

**How**: Port `doom-loop.ts` and `doom-loop-suggestions.ts`. Register on `pi.on("tool_call", ...)`. Add Pi-SmartRead-specific suggestions (e.g., for `deep_search`, `intent_read`, `search`, `repo_map`).

**Files to port**: `doom-loop.ts`, `doom-loop-suggestions.ts` (~200 lines total)

#### 3. Bash Context Guard

**What**: Cap bash output at 2000 lines / 50KB. Write full output to a temp file. Show head (80 lines) + tail (120 lines) preview. Protected notices (doom loop warnings, context guard metadata) are never trimmed.

**Why**: Pi-SmartRead has no bash output processing. Large bash output floods the context window. This is a standalone safety net.

**How**: Port `rtk/bash-context-guard.ts`. Wire into `pi.on("tool_result", ...)` for bash results. ~200 lines.

**Files to port**: `rtk/bash-context-guard.ts` (~200 lines)

### MODERATE PRIORITY — Consider for future

#### 4. PTC Structured Output Pattern

**What**: All tools emit `details.ptcValue` with a versioned, typed data contract (`PtcLine[]`, `PtcEditResult`, `PtcError`, `PtcWarning`). Downstream consumers (renderers, context optimizer, context hygiene) consume structured data instead of parsing text.

**Why**: Pi-SmartRead currently embeds data in text strings or ad-hoc `details` fields. As tool count grows, unstructured output becomes unmaintainable.

**How**: Define a Pi-SmartRead-specific PTC contract. Add `ptcValue` to `read_multiple_files`, `intent_read`, `deep_search`, `search`, `repo_map` results. Start with minimal fields and expand.

#### 5. Enhance SmartRead Bridge (breakage → graph edges)

**What**: Pi-SmartEdit already writes breakage edges to `.pi-smartread/graph-mutations.jsonl` via `smartread-bridge.ts`. Pi-SmartRead's `ContextGraph` reads and replays these edges. This bridge is already active.

**Enhancement**: Add co-change edge recording from Pi-SmartEdit's `post-edit-evidence` git history lane. Add a "file mutated" event type that context hygiene can consume.

### LOW PRIORITY — Not recommended for Pi-SmartRead

#### 6. Full RTK Bash Compression

Too large (~15 files, 2000+ lines). The context guard alone provides 80% of the value. Only port route-specific compressors if specific bash output types become a measurable context budget problem.

#### 7. ReadMap Structural Mapping

Pi-SmartRead's `repo_map` is already more powerful (repo-wide PageRank, token-budgeted, import-based fallback). Adding per-file maps would duplicate functionality. Consider a lightweight "quick struct" field on `read_multiple_files` output (extracted from existing tree-sitter tags cache) instead.

#### 8. ls / find Tools

Pi's stock tools are adequate. Only worth porting if LLM context budget from stock `Bash` (find/fd) output becomes a problem.

---

## Part D: Features to Recommend for Pi-SmartEdit (not Pi-SmartRead)

These are pi-hashline-readmap features that would benefit the edit side:

| Feature | Effort | Why |
|---------|--------|-----|
| `replace_symbol` edit variant | Medium | Name-based symbol replacement, no anchors. Would complement Smart-Edit's existing oldText/newText path |
| Write tool for new files | Small | Pi-SmartEdit has no new-file creation. Smart-Edit's atomic write infrastructure makes this easy |
| Difftastic semantic diff classification | Small | Richer diff metadata (no-op, whitespace-only, semantic, mixed). Smart-Edit already calls tree-sitter |
| Doom loop detection | Small | Neither extension has it. Adding to Smart-Edit covers the full tool suite |
| Context hygiene (stale marking) | Medium | Smart-Edit checks stale at edit time; context hygiene marks OLD reads stale in the full window. Synergistic with Pi-SmartRead's implementation |

---

## Part E: Anchor Format Compatibility

This is the critical interface between all three extensions:

```text
Pi-SmartRead (read output)  →  "42ab|function hello() {"    LINE+HASH
Pi-SmartEdit (edit input)   →  accepts "42ab" or "42:abc"   Both formats
pi-hashline-readmap (edit)  →  "42:abc|function hello() {"  LINE:HASH (colon)
```

**Rule**: Maintain `LINE+HASH` (no colon, bigram-based) as the canonical format. Pi-SmartRead's `hashline.ts` and Pi-SmartEdit's `lib/hashline.ts` already agree on this. Pi-SmartEdit's `lib/hashline-edit.ts` accepts both formats on input (including `LINE|` line-number-only anchors from Pi-SmartRead).

The SmartRead bridge (`graph_mutate`) receives file paths from Smart-Edit, not anchors — so anchor format doesn't affect the bridge.

---

## Part F: The SmartRead Bridge (Existing IPC)

Pi-SmartEdit → Pi-SmartRead communication already exists:

```text
Smart-Edit                           Pi-SmartRead
─────────                           ────────────
post-edit LSP diagnostics           ContextGraph.buildContextGraph()
  ↓                                   ↓
recordBreakage(from, to)           reads .pi-smartread/graph-mutations.jsonl
  ↓                                   ↓
appendFileSync(...jsonl)           EdgeStore.readEdges() → Provenance objects
                                    → graph expansion during intent_read
```

This bridge is **file-level IPC** — no shared imports, no process coupling. The JSONL file is the single interface. Both extensions already agree on the contract.

**What Pi-SmartRead needs to add**: A "file mutated" signal to trigger context-hygiene stale marking. When Smart-Edit writes breakage edges for file X, Pi-SmartRead should mark all prior reads of file X as stale.

---

## Integration Priority Matrix

| # | Feature | Where | Priority | Effort | Dependencies |
|---|---------|-------|----------|--------|-------------|
| 1 | Context Hygiene | Pi-SmartRead | **HIGH** | Medium | Standalone |
| 2 | Doom Loop Detection | Pi-SmartRead | **HIGH** | Small | Standalone |
| 3 | Bash Context Guard | Pi-SmartRead | **HIGH** | Small | Standalone |
| 4 | PTC Structured Output | Pi-SmartRead | MODERATE | Medium | Standalone |
| 5 | `replace_symbol` variant | Pi-SmartEdit | MODERATE | Medium | Smart-Edit AST resolver |
| 6 | Write tool | Pi-SmartEdit | MODERATE | Small | Smart-Edit atomic write |
| 7 | Difftastic classification | Pi-SmartEdit | LOW | Small | difftastic binary |
| 8 | Full RTK compression | Pi-SmartRead | LOW | Large | Standalone |
| 9 | ReadMap structural maps | Pi-SmartRead | LOW | Large | Mapper files |
| 10 | ls/find tools | Pi-SmartRead | LOW | Small | Standalone |

**NOT ported**: Edit tool, replace_symbol, write tool to Pi-SmartRead. Pi-SmartEdit owns the edit lifecycle. Pi-SmartRead owns search/read/graph. Keep responsibilities clean.

---

## Risks and Mitigations

1. **Anchor format drift**: Both Pi-SmartRead and Pi-SmartEdit must stay on the same bigram table (`HASHLINE_BIGRAMS`). Mitigation: Share the bigram table as a single source of truth, or add a cross-extension test.

2. **Context hygiene false positives**: Stale marking could mark reads stale when the edit was whitespace-only or no-op. Mitigation: Check actual content hash, not just mtime. Only mark stale when content changed.

3. **Doom loop false positives**: Could warn on legitimate repeated reads (e.g., reading different offsets of same file). Mitigation: Fingerprint includes params — different offset/limit produce different fingerprints.

4. **Bridge reliability**: JSONL append is advisory (failure is silently ignored). Mitigation: Accept that occasional edge loss is tolerable. The primary diagnostic flow (read → edit → LSP check) works without the bridge.

5. **Extension conflict**: pi-hashline-readmap registers `read`, `edit`, `grep`, `ls`, `find` — all names that Pi-SmartRead and Pi-SmartEdit also register. If all three are loaded, tool name collisions occur. Mitigation: Package as coordinated extensions that know about each other, or use unique tool names.
