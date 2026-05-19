# Progress

## Status
In Progress

## Tasks
- [x] LSP fallback for sparse tree-sitter symbols in RepoMap
- [x] LSP workspace/symbol channel in search-tool.ts code mode
- [x] Add workspace and hover actions to find_symbol tool

## Files Changed

### find-symbol-tool.ts
- Added `'workspace'` and `'hover'` to the action enum in `FindSymbolSchema`
- Added optional `line` and `character` params to schema for hover position
- Added `LSPWorkspaceSymbol` to type imports
- Added `WorkspaceSymbolEntry` interface and `handleWorkspace()` handler — queries LSP workspace/symbol and converts results to a consistent format using `symbolKindToString()`
- Added `HoverResult` interface and `handleHover()` handler — queries LSP hover at a file:line:char and extracts contents (handles string, array, and LSPMarkupContent formats)
- Added `formatWorkspaceResult()` and `formatHoverResult()` formatters
- Added `case "workspace"` and `case "hover"` to the action switch in `execute()`
- Updated tool description to mention workspace and hover actions
- Updated `relative_path` and `query` field descriptions to reference workspace/hover
- No tool-registry.ts changes needed — the tool is registered once as "find_symbol" with action-based dispatch

### search-tool.ts
- Added `getLSPBridge` import from lsp-bridge.js
- Added `lspSymbolKindToString()` helper to convert LSP SymbolKind numbers to string labels
- Added LSP workspace/symbol query as additional result channel in `code` mode, after BM25 scoring but before enrichment
- LSP results are deduplicated against AST-parsed results by `${relFile}:${name}`
- Only runs for queries longer than 2 characters
- Tagged `lspResults` count in response details
- Best-effort: wrapped in try/catch, LSP unavailability is non-fatal

### deep-search.ts
- Added `getLSPBridge` import from `./lsp-bridge.js`
- Extended `ChannelName` type to include `"lsp"`
- Added LSP constants: `LSP_SCORE_BOOST` (0.15), `MAX_LSP_RESULTS` (30), `MAX_HOVER_RESULTS` (3)
- Added `LSP_SYMBOL_KINDS` mapping and `lspKindToString()` for symbol kind conversion
- Added `uriToPath()` helper for `file://` URI to filesystem path conversion
- Added `runLSPChannel()` function — calls `bridge.workspaceSymbol()` best-effort, converts to `DeepSearchCandidate[]` with source tag `'lsp'` and score boost
- For 'thorough' depth, enriches up to 3 results with hover type/signature info
- LSP channel runs in parallel with structural/symbol/semantic channels (independent)
- LSP channel skips queries ≤ 2 characters (avoids noisy results)
- LSP results are ranked alongside other channels via `for channel of [..."lsp"]`
- LSP results treated as exact/precise matches in rendering and escalation logic
- Tool description updated to mention LSP workspace symbol search

### repomap.ts
- Added LSP-based symbol augmentation as fallback when tree-sitter returns < 5 symbols per file
  - Added `getLSPBridge` import from lsp-bridge.ts
  - Added `flattenLSPDocumentSymbols()` helper to convert LSP symbols to Tag format
  - Added `augmentWithLspSymbols()` async function for best-effort LSP fallback
  - Integrated fallback into `generateMap()` after tree-sitter batch processing

## Notes
- LSP is only queried for files where tree-sitter returned < 5 tags
- Uses `filenameToLang()` to skip files without a detected language
- Best-effort: wrapped in try/catch, LSP unavailability is non-fatal
- All 28 repomap-related tests pass (3 test files)
