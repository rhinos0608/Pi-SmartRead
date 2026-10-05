/**
 * Experimental BM25 ranking knobs for the no-index grep fallback.
 *
 * Each knob is adapted from a mechanism verified in probelabs/probe at
 * commit 10d4a76 (Apache-2.0; see audited mechanisms in
 * /tmp/smartread-ext/probe-ranking-audit.md). All knobs default OFF /
 * to current values, so default behaviour is byte-identical.
 *
 * Knobs (each independent, read via resolveGrepRankingOptions):
 * - PI_SMARTREAD_GREP_RANK_TEST_DEMOTE: score multiplier factor (e.g. 0.7)
 *   applied to test/spec/fixture/__tests__ paths and docs/*.md.
 * - PI_SMARTREAD_GREP_RANK_FILENAME: on/off — prepend a synthetic
 *   `// Filename: <relPath>` header to the BM25 document so path tokens
 *   participate in scoring.
 * - PI_SMARTREAD_GREP_RANK_BM25: 'k1,b' overrides (default "1.2,0.75").
 * - PI_SMARTREAD_GREP_RANK_COVERAGE: on/off — multiply by
 *   1 + cov^1.5 * 2 where cov = fraction of distinct query terms present.
 * - PI_SMARTREAD_GREP_RANK_STOPWORDS: on/off — drop NL + programming
 *   keyword stopwords from the query before scoring.
 */

import { DEFAULT_BM25_B, DEFAULT_BM25_K1, tokenize } from "../scoring.js";

export const GREP_RANK_TEST_DEMOTE_ENV_VAR = "PI_SMARTREAD_GREP_RANK_TEST_DEMOTE";
export const GREP_RANK_FILENAME_ENV_VAR = "PI_SMARTREAD_GREP_RANK_FILENAME";
export const GREP_RANK_BM25_ENV_VAR = "PI_SMARTREAD_GREP_RANK_BM25";
export const GREP_RANK_COVERAGE_ENV_VAR = "PI_SMARTREAD_GREP_RANK_COVERAGE";
export const GREP_RANK_STOPWORDS_ENV_VAR = "PI_SMARTREAD_GREP_RANK_STOPWORDS";

export interface GrepRankingOptions {
  /** Score multiplier for test/spec/doc paths; null = knob off. */
  testDemoteFactor: number | null;
  /** Prepend synthetic filename header to BM25 documents. */
  filenamePrepend: boolean;
  /** BM25 saturation parameter (default 1.2). */
  bm25k1: number;
  /** BM25 length-normalization parameter (default 0.75). */
  bm25b: number;
  /** Apply non-linear query-coverage boost. */
  coverageBoost: boolean;
  /** Drop NL + programming stopwords from the query. */
  stopwords: boolean;
}

function isOn(raw: string | undefined): boolean {
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Parse a demotion factor: finite number strictly between 0 and 1, else null (off). */
export function parseDemoteFactor(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  return n;
}

/** Parse 'k1,b' overrides; invalid/missing parts fall back to current defaults. */
export function parseBm25Params(raw: string | undefined): { k1: number; b: number } {
  const fallback = { k1: DEFAULT_BM25_K1, b: DEFAULT_BM25_B };
  if (raw === undefined || raw.trim() === "") return fallback;
  const [k1Raw, bRaw] = raw.split(",");
  const k1 = Number(k1Raw);
  const b = bRaw === undefined ? NaN : Number(bRaw);
  return {
    k1: Number.isFinite(k1) && k1 > 0 ? k1 : fallback.k1,
    b: Number.isFinite(b) && b >= 0 && b <= 1 ? b : fallback.b,
  };
}

/** Single resolver for all ranking knobs. All default off / current values. */
export function resolveGrepRankingOptions(
  env: Record<string, string | undefined> = process.env,
): GrepRankingOptions {
  const { k1, b } = parseBm25Params(env[GREP_RANK_BM25_ENV_VAR]);
  return {
    testDemoteFactor: parseDemoteFactor(env[GREP_RANK_TEST_DEMOTE_ENV_VAR]),
    filenamePrepend: isOn(env[GREP_RANK_FILENAME_ENV_VAR]),
    bm25k1: k1,
    bm25b: b,
    coverageBoost: isOn(env[GREP_RANK_COVERAGE_ENV_VAR]),
    stopwords: isOn(env[GREP_RANK_STOPWORDS_ENV_VAR]),
  };
}

/** True when every knob is off / at current values (default behaviour). */
export function isDefaultRankingOptions(options: GrepRankingOptions): boolean {
  return (
    options.testDemoteFactor === null &&
    !options.filenamePrepend &&
    options.bm25k1 === DEFAULT_BM25_K1 &&
    options.bm25b === DEFAULT_BM25_B &&
    !options.coverageBoost &&
    !options.stopwords
  );
}

/**
 * Explicit path classifier for the test-demotion knob. A path is demoted when
 * any '/'-separated segment names a test/spec/fixture container
 * (test, tests, __tests__, __test__, spec, specs, fixture, fixtures),
 * the basename is a test file (*.test.*, *.spec.*, *_test.*, test_*.*),
 * or the file is prose documentation (*.md, including docs/*.md).
 * Matching is case-insensitive; separators are normalized to '/'.
 */
const TEST_DIR_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "__test__",
  "spec",
  "specs",
  "fixture",
  "fixtures",
]);

export function isTestOrDocPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments[segments.length - 1] ?? "";
  if (basename.endsWith(".md")) return true;
  for (const segment of segments.slice(0, -1)) {
    if (TEST_DIR_SEGMENTS.has(segment)) return true;
  }
  if (
    basename.includes(".test.") ||
    basename.includes(".spec.") ||
    basename.startsWith("test_") ||
    basename.startsWith("spec_") ||
    basename.endsWith("_test.*") ||
    /_test\.[a-z0-9]+$/.test(basename)
  ) {
    return true;
  }
  return false;
}

// ── Stopword lists ────────────────────────────────────────────────
// Adapted from probelabs/probe src/search/tokenization.rs at commit 10d4a76
// (Apache-2.0): dual ENGLISH_STOP_WORDS + PROGRAMMING_STOP_WORDS filtering
// for natural-language query preprocessing. Curated subset preserving the
// source categories (common English function words; cross-language
// keywords, modifiers, and Go-specific terms noted in the original).

/** Common English function words with little retrieval value in NL queries. */
export const PROBE_ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "have", "has", "had", "having", "will", "would", "can", "could", "should",
  "may", "might", "must", "shall", "of", "at", "by", "for", "with", "about",
  "into", "through", "during", "before", "after", "to", "from", "in", "on",
  "off", "over", "under", "as", "it", "its", "this", "that", "these", "those",
  "i", "you", "he", "she", "we", "they", "them", "his", "her", "our", "their",
  "what", "which", "who", "whom", "where", "how", "why", "not", "no", "so",
  "than", "too", "very", "just", "also",
]);

/** Cross-language programming keywords/modifiers pruned from NL queries. */
export const PROBE_PROGRAMMING_STOP_WORDS: ReadonlySet<string> = new Set([
  "func", "type", "struct", "interface", "chan", "map", "go", "defer",
  "var", "let", "const", "return", "if", "else", "for", "while", "switch",
  "case", "break", "continue", "default", "try", "catch", "finally", "throw",
  "new", "super", "extends", "implements", "function", "class", "method", "this",
  "public", "private", "protected", "static", "final", "async", "await",
]);

/** Drop NL + programming stopwords from already-tokenized query tokens. */
export function filterRankingStopwords(tokens: string[]): string[] {
  return tokens.filter(
    (t) => !PROBE_ENGLISH_STOP_WORDS.has(t) && !PROBE_PROGRAMMING_STOP_WORDS.has(t),
  );
}

/** Tokenize a query, applying stopword filtering only when the knob is on. */
export function tokenizeRankingQuery(pattern: string, options: GrepRankingOptions): string[] {
  const tokens = tokenize(pattern);
  return options.stopwords ? filterRankingStopwords(tokens) : tokens;
}

/**
 * Synthetic filename header so path/basename tokens (split by the shared
 * tokenizer into camelCase/snake_case sub-tokens) participate in BM25.
 */
export function withFilenameHeader(content: string, relFile: string): string {
  return `// Filename: ${relFile}\n${content}`;
}

/**
 * Non-linear query-coverage boost: 1 + cov^1.5 * 2 (max 3x at full
 * coverage), where cov = fraction of distinct query terms present in the
 * lowercased document text.
 */
export function coverageBoostFactor(queryTokens: string[], lowerContent: string): number {
  const distinct = [...new Set(queryTokens)];
  if (distinct.length === 0) return 1;
  let present = 0;
  for (const tok of distinct) if (lowerContent.includes(tok)) present++;
  const coverage = Math.min(1, present / distinct.length);
  return 1 + Math.pow(coverage, 1.5) * 2;
}

/** Names of the knobs that are active (non-default), for result details. */
export function activeRankingKnobs(options: GrepRankingOptions): string[] {
  const knobs: string[] = [];
  if (options.testDemoteFactor !== null) knobs.push(`testDemote=${options.testDemoteFactor}`);
  if (options.filenamePrepend) knobs.push("filename");
  if (options.bm25k1 !== DEFAULT_BM25_K1 || options.bm25b !== DEFAULT_BM25_B) {
    knobs.push(`bm25=${options.bm25k1},${options.bm25b}`);
  }
  if (options.coverageBoost) knobs.push("coverage");
  if (options.stopwords) knobs.push("stopwords");
  return knobs;
}

/**
 * Corpus-cache key segment for ranking knobs. Only knobs that change the
 * indexed document need cache isolation (filename prepending); score-only
 * knobs (demotion, coverage, k1/b, stopwords-as-query-filter) reuse corpora.
 */
export function rankingCorpusKeySegment(options: GrepRankingOptions): string {
  return options.filenamePrepend ? "filename=1" : "";
}
