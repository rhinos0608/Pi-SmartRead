import { fdir } from "fdir";
import { resolve } from "node:path";
import { tokenize } from "./scoring.js";

export interface DirectoryResolution {
  paths: string[];
  capped: boolean;
  countBeforeCap: number;
}

export function resolveDirectory(directory: string, cap = 20): DirectoryResolution {
  const resolved = resolve(directory);

  const all = (
    new fdir()
      .withFullPaths()
      .crawlWithOptions(resolved, { maxDepth: 0, excludeSymlinks: true })
      .sync() as string[]
  ).sort((a, b) => a.localeCompare(b));

  return {
    paths: all.slice(0, cap),
    capped: all.length > cap,
    countBeforeCap: all.length,
  };
}

/**
 * Scores a file path by token overlap with a query.
 * Tokenizes: basename + relative path + parent directory names.
 * Returns 0 if no token overlap.
 */
export function scorePathByQuery(path: string, query: string): number {
  // Extract path components: basename + parent dir names (for relative paths use as-is)
  // We tokenize the whole path string, which naturally includes basename and path separators
  // For a path like "src/utils/helper.ts", tokenize gives us: src, utils, helper, ts
  const pathTokens = new Set(tokenize(path));
  const queryTokens = tokenize(query);


  if (pathTokens.size === 0 || queryTokens.length === 0) return 0;

  let score = 0;
  for (const tok of queryTokens) {
    if (pathTokens.has(tok)) score += 1;
  }

  return score;
}


/**
 * Sorts paths by token overlap score descending, keeping stable order for ties.
 * Zero-score paths are placed after positive-score paths (preserving original order).
 */
export function presortPathsByQuery(paths: string[], query: string): string[] {
  if (paths.length === 0 || paths.length === 1) return paths;

  if (!query.trim()) return paths;

  // Assign scores
  const scored = paths.map((path, idx) => ({ path, score: scorePathByQuery(path, query), idx }));

  // Separate positive from zero
  const positive = scored.filter((s) => s.score > 0);
  const zero = scored.filter((s) => s.score === 0);

  // Sort positive by score desc, then original index asc (stable)
  positive.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  // Zero paths keep original order
  zero.sort((a, b) => a.idx - b.idx);

  return [...positive.map((s) => s.path), ...zero.map((s) => s.path)];
}