/**
 * Per-tool suggestion table for doom-loop warnings.
 *
 * Each suggestion can be either:
 * - A plain string (for backward compatibility)
 * - A DoomLoopSuggestion object with optional tool hint and pre-filled input
 *
 * UPKEEP: when a tool adds/renames a parameter, update the matching entry
 * below so suggestions remain accurate.
 *
 * Adapted from pi-hashline-readmap (MIT, github.com/coctostan/pi-hashline-readmap).
 */

export interface DoomLoopSuggestion {
  text: string;
  toolHint?: string; // optional tool name to suggest calling
  toolInput?: Record<string, unknown>; // optional pre-filled tool input
}

// Unified suggestion type — strings are wrapped as simple objects
export type Suggestion = DoomLoopSuggestion | string;

// Convenience: convert a string suggestion to DoomLoopSuggestion shape
function str(text: string): DoomLoopSuggestion {
  return { text };
}

// ── Per-tool suggestions ──────────────────────────────────────────────────────

export const SUGGESTIONS: Record<string, readonly Suggestion[]> = {
  read: [
    str("if file is large, try offset + limit"),
    str("if file keeps being read identically, the content may already be what you expect"),
    { text: 'if searching for a symbol, use symbol { query: "name" }', toolHint: "symbol" },
    { text: 'use read_files with query: "your intent" to rank and read relevant files', toolHint: "read_files", toolInput: { query: "<describe what you are looking for>" } },
    { text: "use repo_map to discover related files", toolHint: "repo_map" },
  ],
  read_files: [
    str("try reducing the number of files or use offset/limit to narrow focus"),
    { text: 'add query: "your intent" to rank files by relevance instead of reading everything', toolHint: "read_files", toolInput: { query: "<describe what you are looking for>" } },
    { text: "use repo_map to discover related files", toolHint: "repo_map" },
  ],
  symbol: [
    str('try a shorter or unqualified name (e.g. "login" instead of "AuthService.login")'),
    str("use action=outline for file structure, action=references for usages, action=implementations for subclass/impl finding"),
    { text: 'try search with depth: "deep" when the symbol name is uncertain', toolHint: "search", toolInput: { depth: "deep" } },
  ],
  search: [
    str("try a more specific query"),
    str("try matchMode=literal if regex characters are accidental"),
    str("try reducing contextLines or narrowing directory"),
    { text: 'retry with depth: "deep" for grep + AST + semantic + symbol + graph + LSP search', toolHint: "search", toolInput: { depth: "deep" } },
    { text: 'use symbol { query: "name" } if this is a known identifier', toolHint: "symbol" },
  ],
  repo_map: [
    str("try compact: true for more token-efficient output"),
    str("use focus to boost relevant symbols or files"),
    str("use mapTokens to increase the token budget for larger repos"),
  ],
  graph_mutate: [
    str("verify the from/to paths exist"),
    str("use absolute paths for cross-directory edges"),
  ],
};

export const GENERIC_SUGGESTION = "try a different approach — the repeating call is not making progress";
