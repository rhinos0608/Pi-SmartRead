export interface ChunkScoreResult {
  maxScore: number;
  bestChunkIndex: number;
}

/**
 * Splits a full token into sub-tokens using underscores, camelCase, PascalCase,
 * and numeric-boundary transitions. Sub-tokens are lowercased and deduplicated.
 * The full token is returned as the first element.
 */
function splitToken(fullToken: string): string[] {
  // Step 1: split on underscores
  const parts = fullToken.split("_");

  const subTokens: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    if (!part) continue;

    // Step 2: split on camelCase/PascalCase boundaries
    // (?<=[a-z])(?=[A-Z]) — split between lowercase and uppercase (camelCase)
    // (?<=[A-Z])(?=[A-Z][a-z]) — split before the last uppercase in an acronym (OAuth → O|Auth)
    // (?<=[a-zA-Z])(?=[0-9]) — split letter→digit (HTML5 → HTML|5)
    // (?<=[0-9])(?=[a-zA-Z]) — split digit→letter (2FA → 2|FA)
    // (?=[A-Z]) — split before every uppercase letter as a fallback, but filter out leading empty
    const camelCaseParts = part.split(
      /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[a-zA-Z])(?=[0-9])|(?<=[0-9])(?=[a-zA-Z])/,
    );

    for (const sp of camelCaseParts) {
      if (!sp) continue;
      // For all-uppercase sequences (e.g., "API" in "OAuthAPI"), split into individual letters
      if (/^[A-Z]+$/.test(sp) && sp.length > 1) {
        for (const ch of sp) {
          const lc = ch.toLowerCase();
          if (!seen.has(lc)) {
            seen.add(lc);
            subTokens.push(lc);
          }
        }
      } else {
        const lc = sp.toLowerCase();
        if (!seen.has(lc)) {
          seen.add(lc);
          subTokens.push(lc);
        }
      }
    }
  }

  // Always include the full token (lowercased) first
  const full = fullToken.toLowerCase();
  if (!seen.has(full)) {
    return [full, ...subTokens];
  }
  return subTokens;
}

/**
 * Tokenizes text for BM25:
 * 1. Normalizes: lowercase, splits on /[^a-z0-9_]+/ keeping underscores
 * 2. For each full token, generates sub-tokens via underscore, camelCase, PascalCase,
 *    and numeric-boundary splitting
 * 3. All sub-tokens lowercased, deduplicated within each expansion
 * 4. Full token always included first
 */
export function tokenize(text: string): string[] {
  // Split on non-alphanumeric, non-underscore (preserves original case for camelCase splitting)
  const rawTokens = text
    .split(/[^a-zA-Z0-9_]+/)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  const seen = new Set<string>();

  for (const full of rawTokens) {
    const subTokens = splitToken(full);
    for (const tok of subTokens) {
      if (!seen.has(tok)) {
        seen.add(tok);
        result.push(tok);
      }
    }
  }

  return result;
}

export function bm25Scores(query: string, documents: string[]): number[] {
  return compileBm25Corpus(documents).score(query);
}

/**
 * Pre-compiled BM25 corpus. Tokenizes each document once and caches term
 * frequencies and document frequencies so repeated queries against the same
 * corpus skip re-tokenization. `score(query)` returns scores in the same
 * order and with identical values to `bm25Scores(query, docs)` over the docs
 * this corpus was compiled from.
 */
export interface Bm25Corpus {
  readonly n: number;
  readonly avgDocLen: number;
  /** Per-document token counts (index-aligned with the source documents). */
  readonly docTokenCounts: number[];
  /** Per-document term-frequency maps (index-aligned with source documents). */
  readonly docTfs: Array<Map<string, number>>;
  /** term -> number of documents containing it. */
  readonly df: Map<string, number>;
  score(query: string): number[];
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Compile a reusable BM25 corpus. For an empty document list, `score` returns
 * an empty array and no division-by-zero occurs.
 */
export function compileBm25Corpus(documents: string[]): Bm25Corpus {
  const tokenizedDocs = documents.map(tokenize);
  const n = documents.length;
  const totalTokens = tokenizedDocs.reduce((sum, d) => sum + d.length, 0);
  const avgDocLen = n === 0 ? 0 : Math.max(1, totalTokens / n);

  const docTokenCounts = tokenizedDocs.map((d) => d.length);
  const docTfs = tokenizedDocs.map((docTokens) => {
    const tf = new Map<string, number>();
    for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });

  // Document frequency over every term present in the corpus (not just query).
  const df = new Map<string, number>();
  for (const docTokens of tokenizedDocs) {
    const seen = new Set(docTokens);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }

  return {
    n,
    avgDocLen,
    docTokenCounts,
    docTfs,
    df,
    score(query: string): number[] {
      if (n === 0) return [];
      const queryTokens = tokenize(query);
      const idf = new Map<string, number>();
      for (const token of queryTokens) {
        const d = df.get(token) ?? 0;
        idf.set(token, Math.log((n - d + 0.5) / (d + 0.5) + 1));
      }
      return docTfs.map((tf, i) => {
        const docLen = docTokenCounts[i]!;
        let score = 0;
        for (const token of queryTokens) {
          const f = tf.get(token) ?? 0;
          const tfScore = (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen)));
          score += (idf.get(token) ?? 0) * tfScore;
        }
        return score;
      });
    },
  };
}

export function maxChunkSimilarity(queryVec: number[], chunkVecs: number[][]): ChunkScoreResult {
  if (chunkVecs.length === 0) {
    return { maxScore: -Infinity, bestChunkIndex: -1 };
  }
  let maxScore = -Infinity;
  let bestChunkIndex = 0;
  for (let i = 0; i < chunkVecs.length; i++) {
    const score = cosineSimilarity(queryVec, chunkVecs[i]!);
    if (score > maxScore) {
      maxScore = score;
      bestChunkIndex = i;
    }
  }
  return { maxScore, bestChunkIndex };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function computeRanks(scores: number[], paths: string[]): number[] {
  const order = scores.map((score, i) => ({ score, i, path: paths[i] }));
  order.sort((a, b) => {
    const d = b.score - a.score;
    if (d > 0 || d < 0) return d;
    if (a.i !== b.i) return a.i - b.i;
    return a.path!.localeCompare(b.path!);
  });
  const ranks = new Array<number>(scores.length);
  order.forEach((item, rank) => { ranks[item.i] = rank + 1; });
  return ranks;
}

export function computeRrfScores(semanticRanks: number[], keywordRanks: number[]): number[] {
  if (semanticRanks.length !== keywordRanks.length) {
    throw new Error(`Length mismatch: semanticRanks (${semanticRanks.length}) and keywordRanks (${keywordRanks.length}) must be equal.`);
  }
  const k = 60;
  return semanticRanks.map((sr, i) => 1 / (k + sr) + 1 / (k + keywordRanks[i]!));
}
