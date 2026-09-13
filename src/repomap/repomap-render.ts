/**
 * RepoMap rendering — token-budgeted output, tree-sitter context extraction.
 *
 * Responsibilities:
 * - Token-budgeted binary search on ranked tags
 * - renderTags: group tags by file, sort, render with tree-context
 * - renderTagsCompact: single-line file summaries
 * - prependSpecialFiles: Dockerfile, package.json, etc. prepended to output
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { isImportantFile } from "./special.js";
import { renderTreeContext } from "./tree-context.js";
import type { RankedTag } from "./repomap-pipeline.js";

// ── Token counting ─────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

/**
 * Estimate tokens using chars/4 heuristic.
 * Used as fallback when model-aware counting is unavailable.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Model-aware token counting.
 * For texts > 200 chars, sample every ~1% of lines, compute sample token count,
 * and extrapolate to full text. Provides more accurate counts than chars/4.
 *
 * @param text - The text to count tokens for
 * @param tokenCountFn - Optional model token count function
 * @returns Estimated token count
 */
export function countTokens(
  text: string,
  tokenCountFn?: (t: string) => number,
): number {
  if (!text) return 0;

  if (!tokenCountFn) {
    return estimateTokens(text);
  }

  if (text.length < 200) {
    return tokenCountFn(text);
  }

  const lines = text.split("\n");
  const numLines = lines.length;
  const step = Math.max(1, Math.floor(numLines / 100));
  const sampledLines: string[] = [];
  for (let i = 0; i < numLines; i += step) {
    sampledLines.push(lines[i]!);
  }
  const sampleText = sampledLines.join("\n");

  if (sampleText.length === 0) return estimateTokens(text);

  const sampleTokens = tokenCountFn(sampleText);
  return Math.round((sampleTokens / sampleText.length) * text.length);
}

// ── Map building ────────────────────────────────────────────────

/**
 * Build a token-budgeted map from ranked tags using binary search.
 * Maximizes the number of tags while staying under maxTokens.
 */
export async function buildMap(
  root: string,
  rankedTags: RankedTag[],
  focusFiles: string[],
  _allFiles: string[],
  maxTokens: number,
  compact: boolean,
): Promise<{ map: string; tokenCount: number }> {
  const focusRelFiles = new Set(focusFiles.map((f) => path.relative(root, f)));

  let left = 0;
  let right = rankedTags.length;
  let bestOutput = "";
  let bestTokens = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const subset = rankedTags.slice(0, mid);
    const output = await renderTags(root, subset, focusRelFiles, compact);
    const tokens = countTokens(output);

    if (tokens <= maxTokens) {
      bestOutput = output;
      bestTokens = tokens;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  return { map: bestOutput, tokenCount: bestTokens };
}

/**
 * Render a set of ranked tags into a string.
 * Groups by file, sorts files by max rank, renders tree-context per file.
 */
export async function renderTags(
  root: string,
  tags: RankedTag[],
  focusRelFiles: Set<string>,
  compact: boolean,
): Promise<string> {
  const byFile = new Map<string, RankedTag[]>();
  for (const rt of tags) {
    const existing = byFile.get(rt.tag.relFname) ?? [];
    existing.push(rt);
    byFile.set(rt.tag.relFname, existing);
  }

  const sortedFiles = Array.from(byFile.entries()).sort((a, b) => {
    const maxA = Math.max(...a[1].map((rt) => rt.rank));
    const maxB = Math.max(...b[1].map((rt) => rt.rank));
    return maxB - maxA;
  });

  if (compact) {
    return renderTagsCompact(sortedFiles, focusRelFiles);
  }

  const parts: string[] = [];
  for (const [relFname, fileTags] of sortedFiles) {
    if (focusRelFiles.has(relFname)) continue;

    const lois = fileTags.map((rt) => rt.tag.line);

    let code: string;
    try {
      code = await fs.readFile(path.resolve(root, relFname), "utf-8");
    } catch {
      continue;
    }

    const rendered = await renderTreeContext(
      code,
      lois,
      {
        maxLineWidth: 100,
      },
      path.resolve(root, relFname),
    );
    if (!rendered) continue;

    parts.push(`${relFname}:\n${rendered}`);
  }

  return parts.join("\n\n");
}

/**
 * Compact single-line file summaries.
 */
export function renderTagsCompact(
  sortedFiles: [string, RankedTag[]][],
  focusRelFiles: Set<string>,
): string {
  const parts: string[] = [];
  for (const [relFname, fileTags] of sortedFiles) {
    if (focusRelFiles.has(relFname)) continue;

    const symbols = [...new Set(fileTags.map((rt) => rt.tag.name))];
    const refCount = fileTags.length;
    const symbolList = symbols.slice(0, 8).join(", ");
    const overflow =
      symbols.length > 8 ? ` (+${symbols.length - 8} more)` : "";

    parts.push(`${relFname} (refs: ${refCount}) — ${symbolList}${overflow}`);
  }
  return parts.join("\n");
}

// ── Priority file injection ─────────────────────────────────────

/**
 * Prepends special/important config files (Dockerfile, package.json, etc.)
 * to the repo map output. Matches Aider's filter_important_files behavior.
 */
export async function prependSpecialFiles(
  map: string,
  allFiles: string[],
  root: string,
): Promise<string> {
  const absRoot = root;
  const allRelFiles = allFiles.map((f) => path.relative(absRoot, f));
  const specialFiles = allRelFiles.filter((f) => isImportantFile(f));

  if (specialFiles.length === 0) return map;

  const lines = await Promise.all(
    specialFiles.map(async (f) => {
      let code = "";
      try {
        code = await fs.readFile(path.resolve(absRoot, f), "utf-8");
        const firstLines = code.split("\n").slice(0, 3).join("\n");
        return `${f}:\n${firstLines}`;
      } catch {
        return `${f}:\n[unreadable]`;
      }
    }),
  );

  const specialSection = lines.join("\n\n") + "\n\n";

  if (map && map.length > 0) {
    return specialSection + map;
  }

  return specialSection;
}