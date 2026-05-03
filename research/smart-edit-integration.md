# Smart-Edit Integration: AST-Boundary Chunking & Cross-Extension Bridge

## Overview

This document details the integration between **Pi-SmartRead** (code intelligence reading/retrieval)
and **Pi-SmartEdit** (intelligent editing tool at `extensions/smart-edit`). Both are Pi Coding Agent
extensions loaded in the same process. The integration enables AST-accurate chunking, shared
infrastructure, and deeper code understanding across read and edit operations.

## What Was Implemented

### 1. AST-Boundary Chunking (`ast-chunker.ts`)

**Location**: `./ast-chunker.ts`

A new module that replaces Pi-SmartRead's regex-based symbol boundary extraction with
**web-tree-sitter WASM** — the same parsing infrastructure used by smart-edit.

**Key features**:
- Uses `@vscode/tree-sitter-wasm` + `web-tree-sitter` (same packages as smart-edit)
- Mirrors smart-edit's grammar-loader WASM loading strategy
- Mirrors smart-edit's `ast-resolver.ts` SYMBOL_NODE_TYPES for consistent node classification
- Supports TypeScript, JavaScript, TSX, Python, Rust, Go, Java, C/C++, Ruby, CSS, Bash
- Graceful fallback to regex-based chunking when WASM is unavailable
- Detailed diagnostics for observability (usedAst, wasmAvailable, parseTimeMs, symbolCount)
- Exposes `isAstChunkingAvailable()` for runtime detection

**How it works**:
1. `grammar-loader.ts` lazily loads WASM grammars from `@vscode/tree-sitter-wasm`
2. `ast-chunker.ts::extractSymbolBoundariesAst()` creates a Parser, sets the language,
   parses the content, and walks the AST tree depth-first
3. Symbol nodes (function_declaration, class_declaration, method_definition, etc.)
   are extracted with precise byte ranges from the AST
4. Overlapping spans are merged (larger span wins)
5. Chunks are created at AST boundaries, merging small adjacent chunks

### 2. Grammar Loader (`grammar-loader.ts`)

**Location**: `./grammar-loader.ts`

Mirrors smart-edit's `lib/grammar-loader.ts` with the same:
- Extension-to-WASM mapping (`.ts` → `tree-sitter-typescript.wasm`, etc.)
- WASM loading strategy (fs.readFile + Language.load)
- Lazy initialization + caching
- Graceful downgrade when WASM unavailable

### 3. `chunkTextAst()` Entry Point (`chunking.ts`)

**Location**: `./chunking.ts`

A new async `chunkTextAst()` function that:
- Tries AST-based chunking first when `useSymbolBoundaries` is enabled
- Falls back to sync regex-based chunking when WASM unavailable or error
- Returns `AstChunkResult` with `chunks[]` and `diagnostics` for observability
- Used by `intent-read.ts` for all embedding chunking

### 4. Intent-Read Integration (`intent-read.ts`)

**Location**: `./intent-read.ts`

`intent_read` tool now uses `chunkTextAst()` instead of `chunkText()` for symbol-boundary
chunking. The `IntentReadDetails` output includes an `astChunking` diagnostic field:
```typescript
astChunking?: {
  usedAst: boolean;     // Was AST chunking actually used?
  wasmAvailable: boolean; // Is the WASM infrastructure available?
  parseTimeMs: number;  // Max parse time across all files
  symbolCount: number;  // Max symbol count across all files
}
```

### 5. Shared Dependencies

**Added to `package.json`**:
```json
"optionalDependencies": {
  "@vscode/tree-sitter-wasm": "^0.3.1",
  "web-tree-sitter": "^0.22.6"
}
```

These match smart-edit's exact dependency versions for consistency.
Since they're optional, the codebase works without them (graceful fallback).

## Architecture: How They Connect

```
┌─────────────────────────────────────┐
│          Pi Extension Process        │
│                                       │
│  ┌─ Pi-SmartRead ─────────────────┐  │
│  │  grammar-loader.ts ◀────┐      │  │
│  │         │               │      │  │
│  │  ast-chunker.ts         │      │  │
│  │         │               │      │  │
│  │  chunking.ts            │      │  │
│  │  (chunkTextAst)         │      │  │
│  │         │               │      │  │
│  │  intent-read.ts ────────┤      │  │
│  └─────────────────────────┘      │  │
│                                    │  │
│  ┌─ Smart-Edit ──────────────┐    │  │
│  │  grammar-loader.ts ───────┘    │  │
│  │  ast-resolver.ts               │  │
│  │  lsp-manager.ts                │  │
│  │  semantic-context.ts           │  │
│  │  read-cache.ts                 │  │
│  └────────────────────────────────┘  │
│                                       │
│  ┌─ Shared Infrastructure ───────┐  │
│  │  @vscode/tree-sitter-wasm     │  │
│  │  web-tree-sitter              │  │
│  │  (separately loaded, same     │  │
│  │   WASM files, OS disk cache)  │  │
│  └────────────────────────────────┘  │
└─────────────────────────────────────┘
```

**Key design note**: Each extension loads its own copy of the WASM modules.
They DON'T share memory (grammars are cached per-extension module scope).
But the WASM binary files are read once from disk (OS file cache), so there's
no duplication at the filesystem level.

## Benefits Over Regex Chunking

| Aspect | Regex (before) | AST (now) |
|--------|---------------|-----------|
| String/template literal handling | ❌ Can confuse braces in strings | ✅ Correct |
| Nested scope detection | ❌ State machine is fragile | ✅ Tree-accurate |
| Python support | ❌ No brace-based syntax | ✅ Indentation-aware via grammar |
| Rust support | ❌ No braces for enums/traits | ✅ Full type awareness |
| Method-in-class detection | ❌ Regex can't distinguish | ✅ Tree-accurate |
| Brace-matching edge cases | ❌ Known limitations documented | ✅ Deterministic |
| Granularity control | ❌ Fixed per-type | ✅ Walk any node type |

## Integration Points for Future Work

### A. Cross-Extension Read Cache Sharing

**Smart-edit's `read-cache.ts`** tracks file snapshots with hashline anchors for stale-file
detection and range-coverage validation. **Pi-SmartRead's reads** (via `intent_read`,
`read_multiple_files`) are already tracked by smart-edit via its `tool_result` hook in `index.ts`.

**Status**: Already wired — smart-edit's `tool_result` handler captures all read/intent_read/
read_multiple_files results and populates its read cache with hashline anchors.

### B. LSP-Aware Context Graph

**Smart-edit's LSP manager** can provide precise semantic information (goToDefinition,
findReferences, semantic tokens) that would improve Pi-SmartRead's context-graph neighbour
detection beyond the current regex-based import scanning.

**Possible integration**:
- Replace `findDirectImportNeighbours` regex scanning with LSP goToDefinition
- Use LSP semantic tokens for better keyword extraction in chunking
- Add LSP-powered "used symbols in file" for more accurate context expansion

### C. Shared Symbol Hub

Combine Pi-SmartRead's **PageRank-based file importance** with smart-edit's **LSP symbol resolution**:
- PageRank identifies important files and symbols
- LSP provides precise location data for those symbols
- Result: a unified "this is what matters in this repo" view

### D. Hashline-Enhanced Read Tracking

Smart-edit's **hashline anchors** (LINE+HASH per line) are already computed during reads.
These could be surfaced in Pi-SmartRead's output so the agent can reference them for
subsequent edits — providing a "what was seen" guarantee for edit coverage validation.

## WASM Versions

Both extensions use the same package versions:
- `@vscode/tree-sitter-wasm`: `^0.3.1`
- `web-tree-sitter`: `^0.22.6`

Available WASM grammars: bash, c-sharp, cpp, css, go, ini, java, javascript, php,
powershell, python, regex, ruby, rust, tsx, typescript, yaml.
