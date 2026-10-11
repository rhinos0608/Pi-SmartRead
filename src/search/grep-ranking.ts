/**
 * Experimental BM25 ranking knobs for the no-index grep fallback.
 *
 * Each knob is adapted from a mechanism verified in probelabs/probe at
 * commit 10d4a76 (Apache-2.0; see audited mechanisms in
 * /tmp/smartread-ext/probe-ranking-audit.md). All knobs default OFF /
 * to current values, except test/spec/doc demotion which defaults to 0.7
 * (D51: confirmed on the frozen holdout).
 *
 * Knobs (each independent, read via resolveGrepRankingOptions):
 * - PI_SMARTREAD_GREP_RANK_TEST_DEMOTE: score multiplier factor applied
 *   to test/spec/fixture/__tests__ paths and every *.md file. Unset defaults to
 *   0.7; `off`/`0`/`false`/`no` disables demotion; a valid factor in (0,1)
 *   overrides; any other value falls back to 0.7.
 * - PI_SMARTREAD_GREP_RANK_FILENAME: on/off — prepend a synthetic
 *   `// Filename: <relPath>` header to the BM25 document so path tokens
 *   participate in scoring.
 * - PI_SMARTREAD_GREP_RANK_BM25: 'k1,b' overrides (default "1.2,0.75").
 * - PI_SMARTREAD_GREP_RANK_COVERAGE: on/off — multiply by
 *   1 + cov^1.5 * 2 where cov = fraction of distinct query terms present.
 * - PI_SMARTREAD_GREP_RANK_STOPWORDS: on/off — drop NL + programming
 *   keyword stopwords from the query before scoring.
 * - PI_SMARTREAD_GREP_RANK_STEM: on/off (default off) — reduce query and
 *   document tokens with a dependency-free Porter English stemmer
 *   (src/search/english-stemmer.ts) after case/split normalisation.
 *   Applies ONLY to the natural-language BM25 ranking channel
 *   (tokenizeRankingQuery + the BM25 fallback corpus scorer);
 *   identifier/exact/regex/structural channels never stem.
 */

import { DEFAULT_BM25_B, DEFAULT_BM25_K1, tokenize } from "../scoring.js";
import { porterStem } from "./english-stemmer.js";
import { isNaturalLanguageQuery } from "./query-intent.js";

export const GREP_RANK_TEST_DEMOTE_ENV_VAR = "PI_SMARTREAD_GREP_RANK_TEST_DEMOTE";
/** Default test/spec/doc demotion factor (D51: confirmed on the frozen holdout). */
export const DEFAULT_TEST_DEMOTE_FACTOR = 0.7;
export const GREP_RANK_FILENAME_ENV_VAR = "PI_SMARTREAD_GREP_RANK_FILENAME";
export const GREP_RANK_BM25_ENV_VAR = "PI_SMARTREAD_GREP_RANK_BM25";
export const GREP_RANK_COVERAGE_ENV_VAR = "PI_SMARTREAD_GREP_RANK_COVERAGE";
export const GREP_RANK_STOPWORDS_ENV_VAR = "PI_SMARTREAD_GREP_RANK_STOPWORDS";
export const GREP_RANK_STEM_ENV_VAR = "PI_SMARTREAD_GREP_RANK_STEM";

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
  /** Reduce NL BM25 query/document tokens with the Porter stemmer. */
  stemming: boolean;
}

function isOn(raw: string | undefined): boolean {
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/** Values that explicitly disable test/spec/doc demotion (case-insensitive). */
const DEMOTE_OFF_VALUES = new Set(["off", "0", "false", "no"]);

/**
 * Parse a demotion factor. Unset/blank defaults to 0.7 (D51); explicit off
 * values (`off`/`0`/`false`/`no`) disable demotion (null); a finite number
 * strictly between 0 and 1 is used as-is; anything else falls back to 0.7.
 */
export function parseDemoteFactor(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TEST_DEMOTE_FACTOR;
  const normalized = raw.trim().toLowerCase();
  if (DEMOTE_OFF_VALUES.has(normalized)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return DEFAULT_TEST_DEMOTE_FACTOR;
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

/** Single resolver for all ranking knobs. Only non-demotion knobs default off. */
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
    stemming: isOn(env[GREP_RANK_STEM_ENV_VAR]),
  };
}

/** True when every knob is at default values (demote 0.7, rest off / current). */
export function isDefaultRankingOptions(options: GrepRankingOptions): boolean {
  return (
    options.testDemoteFactor === DEFAULT_TEST_DEMOTE_FACTOR &&
    !options.filenamePrepend &&
    options.bm25k1 === DEFAULT_BM25_K1 &&
    options.bm25b === DEFAULT_BM25_B &&
    !options.coverageBoost &&
    !options.stopwords &&
    !options.stemming
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

/** Tokenize then Porter-stem, deduping stems (idempotent). */
export function stemRankingTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of tokens) {
    const stem = porterStem(tok);
    if (!seen.has(stem)) {
      seen.add(stem);
      out.push(stem);
    }
  }
  return out;
}

/** Shared BM25 tokenizer for the NL channel: plain split, or split+stem. */
export function rankingTokenizer(options: GrepRankingOptions): (text: string) => string[] {
  if (!options.stemming) return tokenize;
  return (text: string) => stemRankingTokens(tokenize(text));
}

/**
 * Per-query ranking options: the stemming knob applies ONLY to
 * natural-language-shaped queries (shared isNaturalLanguageQuery
 * classifier, also used by the judge stage and find routing).
 * Identifier-shaped queries (single identifiers, camelCase/snake_case/
 * dotted symbols, code-like patterns) always score unstemmed, so the
 * corpus cache key and scorer stay identical to knob-off for them.
 */
export function resolveRankingForQuery(pattern: string, options: GrepRankingOptions): GrepRankingOptions {
  if (options.stemming && !isNaturalLanguageQuery(pattern)) return { ...options, stemming: false };
  return options;
}

/** Tokenize a query, applying stopword filtering only when the knob is on. Stemming additionally requires an NL-shaped query. */
export function tokenizeRankingQuery(pattern: string, options: GrepRankingOptions): string[] {
  const tokens = tokenize(pattern);
  const filtered = options.stopwords ? filterRankingStopwords(tokens) : tokens;
  // Defense in depth: even callers that pass knob-level options without
  // per-query resolution never stem identifier-shaped queries.
  const stem = options.stemming && isNaturalLanguageQuery(pattern);
  return stem ? stemRankingTokens(filtered) : filtered;
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
export function coverageBoostFactor(queryTokens: string[], lowerContent: string, stem = false): number {
  const distinct = [...new Set(queryTokens)];
  if (distinct.length === 0) return 1;
  let present = 0;
  if (stem) {
    // Stemmed query tokens rarely occur as raw substrings ("poni" vs
    // "ponies"), so compare stemmed token sets on both sides. Off
    // (default) keeps the byte-identical substring check.
    const contentStems = new Set(stemRankingTokens(tokenize(lowerContent)));
    for (const tok of distinct) if (contentStems.has(tok)) present++;
  } else {
    for (const tok of distinct) if (lowerContent.includes(tok)) present++;
  }
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
  if (options.stemming) knobs.push("stem");
  return knobs;
}

/**
 * Corpus-cache key segment for ranking knobs. Knobs that change the
 * indexed document need cache isolation (filename prepending, stemming
 * which changes the token stream); score-only knobs (demotion, coverage,
 * k1/b, stopwords-as-query-filter) reuse corpora.
 */
export function rankingCorpusKeySegment(options: GrepRankingOptions): string {
  const parts: string[] = [];
  if (options.filenamePrepend) parts.push("filename=1");
  if (options.stemming) parts.push("stem=1");
  return parts.join("\u0000");
}
