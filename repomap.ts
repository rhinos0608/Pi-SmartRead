/**
 * RepoMap — Aider-style repository mapping for Pi-SmartRead.
 *
 * This file is a re-export barrel. Implementation is split across:
 * - repomap-pipeline.ts — orchestration, RepoMap class, searchIdentifiers
 * - repomap-ranking.ts  — PageRank, edge weighting, import-based ranking
 * - repomap-render.ts   — token-budgeted rendering, tree-context output
 *
 * External consumers (repomap-tool.ts, deep-search.ts, hook.ts) import from here.
 */

// ── Types ────────────────────────────────────────────────────────

export type {
  RepoMapOptions,
  RepoMapResult,
  RepoMapStats,
  RankedTag,
  SearchResult,
} from "./repomap-pipeline.js";

// ── Shared helpers ──────────────────────────────────────────────

export { FALLBACK_DEFINITION_PATTERNS, getFallbackMatch, sortSearchResults, flattenLSPDocumentSymbols } from "./repomap-pipeline.js";

// Ranking helpers
export { parseTsconfigPaths, buildImportGraph, getRankedTags, getImportRankedTags } from "./repomap-ranking.js";
export type { ImportEdge } from "./repomap-ranking.js";
export type { TsAliasMap } from "./repomap-ranking.js";

// Rendering helpers
export { countTokens, buildMap, renderTags, renderTagsCompact, prependSpecialFiles } from "./repomap-render.js";

// ── Main class ──────────────────────────────────────────────────

export { RepoMap } from "./repomap-pipeline.js";