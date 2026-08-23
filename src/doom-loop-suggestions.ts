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
    { text: 'if searching for a symbol, use inspect { path: "path/to/file.ts" } for structural facts', toolHint: "inspect" },
    { text: 'use read { query: "your intent" } to rank and read relevant files', toolHint: "read", toolInput: { query: "<describe what you are looking for>" } },
    { text: "use inspect to discover related files and repo structure", toolHint: "inspect" },
  ],
  inspect: [
    str("if a file is too large, read { path, offset, limit } to get a focused slice"),
    str("if inspecting a directory, try focus: [\"src/auth.ts\", \"AuthService.login\"] to boost relevant files or symbols"),
    { text: 'use read { query: "your intent" } to rank and read relevant files', toolHint: "read", toolInput: { query: "<describe what you are looking for>" } },
    str("use inspect on a different file to check callers or children"),
    { text: "use grep { pattern, path } to search across files for a name or concept", toolHint: "grep" },
  ],
  grep: [
    str("try a more specific pattern or narrower path"),
    str("try literal: true for exact substring match"),
    str("try ignoreCase: true if casing is uncertain"),
    { text: "use read { query: \"your intent\" } for semantic multi-channel search", toolHint: "read", toolInput: { query: "<describe what you are looking for>" } },
  ],
  graph_mutate: [
    str("verify the from/to paths exist"),
    str("use absolute paths for cross-directory edges"),
  ],
};

export const GENERIC_SUGGESTION = "try a different approach — the repeating call is not making progress";
