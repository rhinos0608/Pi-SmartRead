export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
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
    if (d !== 0) return d;
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
