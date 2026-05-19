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
    { text: "try intent_read with a natural language query", toolHint: "intent_read" },
    { text: "use repo_map to discover related files", toolHint: "repo_map" },
  ],
  read_multiple_files: [
    str("try reducing the number of files"),
    str("use offset/limit to narrow focus"),
    str("try intent_read for semantic search instead"),
    { text: "try intent_read with a natural language query", toolHint: "intent_read" },
    { text: "use repo_map to discover related files", toolHint: "repo_map" },
  ],
  intent_read: [
    str("try a more specific query"),
    str("increase topK to get more results"),
    str("try deep_search for multi-phase exploration"),
    { text: "try deep_search with depth 'thorough' for broader exploration", toolHint: "deep_search", toolInput: { depth: "thorough" } },
    { text: "try repo_map first to understand the file layout", toolHint: "repo_map" },
    { text: "narrow the query with specific identifiers", toolHint: "search" },
  ],
  deep_search: [
    str("try a more specific query"),
    str("use quick depth for faster results"),
    str("narrow scope to code or docs"),
    { text: "try search mode 'resolve' to find a specific symbol", toolHint: "search" },
    { text: "check if the file exists with read", toolHint: "read" },
  ],
  search: [
    str("try a different mode (grep, code, deep)"),
    str("resolve specific symbols instead of searching broadly"),
    str("try a narrower filePattern"),
    { text: "try mode 'callers' to trace function callers", toolHint: "search", toolInput: { mode: "callers" } },
    { text: "try mode 'code' for AST-aware search", toolHint: "search", toolInput: { mode: "code" } },
  ],
  repo_map: [
    str("try compact: true for more token-efficient output"),
    str("use focusFiles to personalize ranking"),
    str("try priorityIdentifiers to boost relevant symbols"),
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
  read_multiple_files: [
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
  ],
  search: [
    "try a different mode (grep, code, deep)",
    "resolve specific symbols instead of searching broadly",
    "try a narrower filePattern",
  ],
  repo_map: [
    "try compact: true for more token-efficient output",
    "use focusFiles to personalize ranking",
    "try priorityIdentifiers to boost relevant symbols",
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