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
    { text: "if you do not know the file yet, use grep { pattern, path? } to discover candidates first", toolHint: "grep" },
    { text: "for exact definitions, references, types, hierarchy, hover, or diagnostics, use LSP instead of rereading source", toolHint: "LSP" },
    { text: "for aggregate structural or architectural analysis of a known file/directory, use inspect", toolHint: "inspect" },
    { text: "if this is a dependent multi-hop chase, use inspect { mode: \"script\", script: \"...\" } to compose it in one call", toolHint: "inspect" },
  ],
  inspect: [
    { text: "if you need source text rather than structural metadata, use read { path, offset?, limit? }", toolHint: "read" },
    str("if inspecting a directory, try analysis: { focus: [\"src/auth.ts\", \"AuthService.login\"] } to boost relevant files or symbols"),
    { text: "if you are trying to locate text, names, or candidate files, use grep", toolHint: "grep" },
    { text: "for exact definitions, references, hover, symbols, hierarchy, or diagnostics, use LSP", toolHint: "LSP" },
    str("try a narrower file or directory target when the structural view is too broad"),
    { text: "if this is a dependent multi-hop chase, use inspect { mode: \"script\", script: \"...\" } to compose it in one call", toolHint: "inspect" },
  ],
  grep: [
    str("try a more specific pattern or narrower path"),
    str("try literal: true for exact substring match"),
    str("try ignoreCase: true if casing is uncertain"),
    { text: "after finding the right file, use read { path } to inspect the source", toolHint: "read" },
    { text: "for exact compiler-backed symbol relationships, follow up with LSP", toolHint: "LSP" },
    { text: "if this is a dependent multi-hop chase, use inspect { mode: \"script\", script: \"...\" }", toolHint: "inspect" },
  ],
  graph_mutate: [
    str("verify the from/to paths exist"),
    str("use absolute paths for cross-directory edges"),
  ],
};

export const GENERIC_SUGGESTION = "try a different approach — the repeating call is not making progress";
