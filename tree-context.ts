/**
 * Render code snippets with structural context.
 *
 * Given "lines of interest" (LOIs), shows those lines plus their
 * parent context (class/function headers) based on indentation.
 *
 * Improvements over simple indent-walker:
 * - Mtime-based tree context caching (avoid re-parsing unchanged files)
 * - Line number display option
 * - LOI padding (show N lines above/below each LOI)
 * - TOP-of-file display (show file header if LOI is deep)
 * - Line truncation at 100 chars to avoid minified code bloat
 */

import { statSync } from "node:fs";

export interface TreeContextOptions {
  /** Show line numbers in output (default: false) */
  lineNumbers?: boolean;

  /** Number of extra lines above/below each LOI (default: 0) */
  loiPad?: number;

  /** Maximum line width before truncation (default: 100, 0 = no truncation) */
  maxLineWidth?: number;

  /** Show top-of-file parent scope headers (default: false) */
  showTopOfFile?: boolean;

  /** Maximum number of header lines to show from top of file (default: 0) */
  headerMax?: number;
}

/** Cache entry for tree context */
interface TreeContextCacheEntry {
  mtime: number;
  indentLevels: number[];
  /** Cached parent context for each line number */
  contextLines: Map<number, number[]>;
  lastAccessedAt: number;
}

/** Maximum number of cached files kept in memory */
const MAX_TREE_CONTEXT_CACHE = 500;

/** Module-level tree context cache */
const treeContextCache = new Map<string, TreeContextCacheEntry>();

function touchTreeContextCache(fname: string, entry: TreeContextCacheEntry): void {
  entry.lastAccessedAt = Date.now();
  treeContextCache.delete(fname);
  treeContextCache.set(fname, entry);
}

function evictOldestIfNeeded(): void {
  while (treeContextCache.size > MAX_TREE_CONTEXT_CACHE) {
    let oldestKey: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;
    for (const [key, entry] of treeContextCache) {
      if (entry.lastAccessedAt < oldestSeen) {
        oldestSeen = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    treeContextCache.delete(oldestKey);
  }
}

/**
 * Get file mtime for cache invalidation.
 */
function getMtime(fname: string): number {
  try {
    return statSync(fname).mtimeMs;
  } catch {
    return Date.now();
  }
}

/**
 * Build indentation levels for all non-empty lines.
 */
function buildIndentLevels(lines: string[]): number[] {
  return lines.map((line) => {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  });
}

/**
 * Pre-compute parent context for a specific line.
 * Walks upward to find lines with less indentation (parent scopes).
 */
function computeParentContext(
  lines: string[],
  indentLevels: number[],
  lineNum: number,
): number[] {
  const parents: number[] = [];
  const targetIndent = indentLevels[lineNum - 1];

  if (targetIndent === undefined) return parents;

  let currentIndent = targetIndent;

  for (let i = lineNum - 1; i >= 1; i--) {
    const line = lines[i - 1];
    if (line.trim() === "") continue;

    const indent = indentLevels[i - 1];
    if (indent < currentIndent) {
      parents.unshift(i);
      currentIndent = indent;
      if (indent === 0) break;
    }
  }

  return parents;
}

/**
 * Compute parent context for a line, using cache when available.
 */
function getParentContext(
  lines: string[],
  indentLevels: number[],
  lineNum: number,
  cacheEntry?: TreeContextCacheEntry,
): number[] {
  if (cacheEntry) {
    const cached = cacheEntry.contextLines.get(lineNum);
    if (cached) return cached;

    const parents = computeParentContext(lines, indentLevels, lineNum);
    cacheEntry.contextLines.set(lineNum, parents);
    return parents;
  }

  return computeParentContext(lines, indentLevels, lineNum);
}

/**
 * Renders code lines around points of interest with parent context.
 *
 * For each line of interest, walks upward to find parent scope boundaries
 * (lines with less indentation) and includes them.
 *
 * @param code - Full source code of the file
 * @param linesOfInterest - 1-based line numbers of symbols to highlight
 * @param options - Rendering options
 * @returns Rendered string with context lines
 */
export function renderTreeContext(
  code: string,
  linesOfInterest: number[],
  options: TreeContextOptions = {},
  fname?: string,
): string {
  const {
    lineNumbers = false,
    loiPad = 0,
    maxLineWidth = 100,
    showTopOfFile = false,
    headerMax = 0,
  } = options;

  if (linesOfInterest.length === 0) return "";

  const lines = code.split("\n");
  const loiSet = new Set(linesOfInterest);
  const visibleLines = new Set<number>();

  // Build indent levels (with mtime cache when fname is provided)
  let indentLevels: number[];
  let cacheEntry: TreeContextCacheEntry | undefined;

  if (fname) {
    const mtime = getMtime(fname);
    const cached = treeContextCache.get(fname);
    if (cached && cached.mtime === mtime) {
      indentLevels = cached.indentLevels;
      cacheEntry = cached;
      touchTreeContextCache(fname, cached);
    } else {
      indentLevels = buildIndentLevels(lines);
      cacheEntry = { mtime, indentLevels, contextLines: new Map(), lastAccessedAt: Date.now() };
      treeContextCache.set(fname, cacheEntry);
      evictOldestIfNeeded();
    }
  } else {
    indentLevels = buildIndentLevels(lines);
    cacheEntry = undefined;
  }

  for (const loi of loiSet) {
    if (loi < 1 || loi > lines.length) continue;
    visibleLines.add(loi);

    // Add parent context
    const parents = getParentContext(lines, indentLevels, loi, cacheEntry);
    for (const p of parents) {
      visibleLines.add(p);
    }

    // Add padding above/below LOI
    if (loiPad > 0) {
      for (let i = 1; i <= loiPad; i++) {
        if (loi - i >= 1) visibleLines.add(loi - i);
        if (loi + i <= lines.length) visibleLines.add(loi + i);
      }
    }
  }

  // Add top-of-file header lines if requested (independent of LOI proximity)
  if (showTopOfFile && headerMax > 0) {
    for (let i = 1; i <= Math.min(headerMax, lines.length); i++) {
      visibleLines.add(i);
    }
  }

  const sortedVisible = Array.from(visibleLines).sort((a, b) => a - b);
  const output: string[] = [];
  let lastLine = -1;

  for (const lineNum of sortedVisible) {
    if (lineNum < 1 || lineNum > lines.length) continue;

    if (lastLine !== -1 && lineNum > lastLine + 1) {
      const indent = getIndent(lines[lineNum - 1]);
      output.push(`${" ".repeat(indent)}⋮...`);
    }

    let line = lines[lineNum - 1];

    // Truncate long lines
    if (maxLineWidth > 0 && line.length > maxLineWidth) {
      line = line.slice(0, maxLineWidth - 3) + "...";
    }

    if (lineNumbers) {
      output.push(`${String(lineNum).padStart(4)}: ${line}`);
    } else {
      output.push(line);
    }
    lastLine = lineNum;
  }

  const result = output.join("\n");
  // Truncate the entire output if it's still too long
  // (guards against minified JS or generated code)
  const MAX_OUTPUT = 50_000;
  if (result.length > MAX_OUTPUT) {
    return result.slice(0, MAX_OUTPUT) + "\n... [truncated]";
  }

  return result;
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}
