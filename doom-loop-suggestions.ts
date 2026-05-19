/**
 * Per-tool suggestion table for doom-loop warnings.
 *
 * UPKEEP: when a tool adds/renames a parameter, update the matching entry
 * below so suggestions remain accurate.
 *
 * Adapted from pi-hashline-readmap (MIT, github.com/coctostan/pi-hashline-readmap).
 */

export const SUGGESTIONS: Record<string, readonly string[]> = {
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
