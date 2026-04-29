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
  const k1 = 1.2;
  const b = 0.75;
  const N = documents.length;

  if (N === 0) return [];

  const tokenizedDocs = documents.map(tokenize);
  const avgDocLen = tokenizedDocs.reduce((sum, d) => sum + d.length, 0) / N;

  const queryTokens = [...new Set(tokenize(query))];

  // df: number of documents containing each unique query token
  const df = new Map<string, number>();
  for (const token of queryTokens) {
    let count = 0;
    for (const doc of tokenizedDocs) {
      if (doc.includes(token)) count += 1;
    }
    df.set(token, count);
  }

  // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
  const idf = new Map<string, number>();
  for (const token of queryTokens) {
    const d = df.get(token) ?? 0;
    idf.set(token, Math.log((N - d + 0.5) / (d + 0.5) + 1));
  }

  return tokenizedDocs.map((docTokens) => {
    const docLen = docTokens.length;
    // term frequency map for this document
    const tf = new Map<string, number>();
    for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const token of queryTokens) {
      const f = tf.get(token) ?? 0;
      const tfScore = (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docLen / avgDocLen)));
      score += (idf.get(token) ?? 0) * tfScore;
    }
    return score;
  });
}

export function maxChunkSimilarity(queryVec: number[], chunkVecs: number[][]): ChunkScoreResult {
  if (chunkVecs.length === 0) {
    return { maxScore: -Infinity, bestChunkIndex: -1 };
  }
  let maxScore = -Infinity;
  let bestChunkIndex = 0;
  for (let i = 0; i < chunkVecs.length; i++) {
    const score = cosineSimilarity(queryVec, chunkVecs[i]);
    if (score > maxScore) {
      maxScore = score;
      bestChunkIndex = i;
    }
  }
  return { maxScore, bestChunkIndex };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return -Infinity;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeRanks(scores: number[], paths: string[]): number[] {
  const order = scores.map((score, i) => ({ score, i, path: paths[i] }));
  order.sort((a, b) => {
    const d = b.score - a.score;
    if (d > 0 || d < 0) return d;
    if (a.i !== b.i) return a.i - b.i;
    return a.path.localeCompare(b.path);
  });
  const ranks = new Array<number>(scores.length);
  order.forEach((item, rank) => { ranks[item.i] = rank + 1; });
  return ranks;
}

export function computeRrfScores(semanticRanks: number[], keywordRanks: number[]): number[] {
  const k = 60;
  return semanticRanks.map((sr, i) => 1 / (k + sr) + 1 / (k + keywordRanks[i]));
}
