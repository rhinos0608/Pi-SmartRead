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
    str("if searching for a symbol, use search or repo_map"),
    str("if file keeps being read identically, the content may already be what you expect"),
    { text: "try semantic_read with a natural language query", toolHint: "semantic_read" },
    { text: "use repo_map to discover related files", toolHint: "repo_map" },
  ],
  read_files: [
    str("try reducing the number of files"),
    str("use offset/limit to narrow focus"),
    str("try semantic_read for semantic search instead"),
    { text: "try semantic_read with a natural language query", toolHint: "semantic_read" },
    { text: "use repo_map to discover related files", toolHint: "repo_map" },
  ],
  intent_read: [
    str("try a more specific query"),
    str("increase topK to get more results"),
    { text: "try deep_search for multi-phase exploration", toolHint: "deep_search" },
    { text: "try repo_map first to understand the file layout", toolHint: "repo_map" },
    { text: "narrow the query with specific identifiers", toolHint: "search" },
  ],
  deep_search: [
    str("try a more specific query"),
    str("use quick depth for faster results"),
    str("narrow scope to code or docs"),
    { text: "try find_symbol to find a specific symbol", toolHint: "find_symbol" },
    { text: "check if the file exists with read", toolHint: "read" },
  ],
  find_symbol: [
    str("try a more specific query"),
    { text: "try symbol_info for richer results", toolHint: "symbol_info" },
    { text: "try search for text + code search", toolHint: "search" },
  ],
  symbol_info: [
    str("use action=outline for file structure"),
    str("use action=declaration for canonical definition"),
    str("use action=references to find usages"),
    str("use action=implementations for subclass/impl finding"),
  ],
  search: [
    str("try a more specific query"),
    { text: "try deep_search for multi-channel exploration", toolHint: "deep_search" },
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
  grep: [
    str("try ignoreCase: true"),
    str("try literal: true if pattern has special characters"),
    str("try a narrower path"),
  ],
};

// Legacy string-only fallback (used for backward compatibility)
export const SUGGESTIONS_LEGACY: Record<string, readonly string[]> = {
  read: [
    "if file is large, try offset + limit",
    "if searching for a symbol, use search or repo_map",
    "if file keeps being read identically, the content may already be what you expect",
  ],
  read_files: [
    "try reducing the number of files",
    "use offset/limit to narrow focus",
    "try intent_read for semantic search instead",
  ],
  intent_read: [
    "try a more specific query",
    "increase topK to get more results",
    "try deep_search for multi-phase exploration",
  ],
  deep_search: [
    "try a more specific query",
    "use quick depth for faster results",
    "narrow scope to code or docs",
    "try find_symbol to find a specific symbol",
  ],
  find_symbol: [
    "try a more specific query",
    "try symbol_info for richer results",
    "try search for text + code search",
  ],
  symbol_info: [
    "use action=outline for file structure",
    "use action=declaration for canonical definition",
    "use action=references to find usages",
    "use action=implementations for subclass/impl finding",
  ],
  search: [
    "try a more specific query",
    "try deep_search for multi-channel exploration",
    "narrow the search with a more specific query",
  ],
  repo_map: [
    "try compact: true for more token-efficient output",
    "use focus to boost relevant symbols or files",
  ],
  graph_mutate: [
    "verify the from/to paths exist",
    "use absolute paths for cross-directory edges",
  ],
  grep: [
    "try ignoreCase: true",
    "try literal: true if pattern has special characters",
    "try a narrower path",
  ],
};

export const GENERIC_SUGGESTION = "try a different approach — the repeating call is not making progress";
