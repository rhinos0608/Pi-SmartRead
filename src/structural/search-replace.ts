import * as fs from "fs";

export class RelativeIndenter {
  private marker: string;

  constructor(usedMarkers: string[] = []) {
    this.marker = this.findUnusedMarker(usedMarkers);
  }

  private findUnusedMarker(used: string[]): string {
    const candidates = [
      "←", "↤", "↦", "⋕", "⊸", "⤂", "⤃", "⤈", "⤉", "⤊", "⤋",
      "⬰", "⬱", "⬲", "⬳", "⬴", "⬵", "⬶", "⬷", "⬸", "⬹", "⬺", "⬻", "⬼", "⬽", "⬾", "⬿",
      "⭀", "⭁", "⭂", "⭃", "⭄", "⭅", "⭆", "⭇", "⭈", "⭉", "⭊", "⭋", "⭌",
    ];
    for (const c of candidates) {
      if (!used.includes(c)) return c;
    }
    const fallback = `⋔${Date.now() % 1000}`;
    if (!used.includes(fallback)) return fallback;
    return `⋔${Math.random().toString(36).slice(2, 6)}`;
  }

  makeRelative(text: string): string {
    const lines = text.split("\n");
    if (lines.length === 0) return text;

    const result: string[] = [lines[0] ?? ""];
    let prevIndent = measureIndent(lines[0] ?? "");

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line === "") {
        result.push("");
        continue;
      }

      const currIndent = measureIndent(line);

      if (currIndent < prevIndent) {
        const outdent = prevIndent - currIndent;
        result.push(this.marker.repeat(outdent) + line.trimStart());
      } else {
        const relIndent = currIndent - prevIndent;
        result.push(" ".repeat(relIndent) + line.trimStart());
      }
      prevIndent = currIndent;
    }

    return result.join("\n");
  }

  restoreAbsolute(text: string): string {
    const lines = text.split("\n");
    if (lines.length === 0) return text;

    const result: string[] = [lines[0] ?? ""];
    let prevIndent = measureIndent(lines[0] ?? "");

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line === "") {
        result.push("");
        continue;
      }

      if (line.startsWith(this.marker)) {
        let count = 0;
        for (const ch of line) {
          if (ch === this.marker) count++;
          else break;
        }
        result.push(" ".repeat(Math.max(0, prevIndent - count)) + line.slice(count).trimStart());
        continue;
      }

      const currIndent = measureIndent(line);
      prevIndent = currIndent;
      result.push(line);
    }

    return result.join("\n");
  }
}

function measureIndent(line: string): number {
  let spaces = 0;
  for (const ch of line) {
    if (ch === " ") spaces++;
    else break;
  }
  return spaces;
}

export function doReplace(
  content: string,
  searchBlock: string,
  replaceBlock: string,
): string | null {
  const result = directMatch(content, searchBlock, replaceBlock);
  if (result !== null) return result;

  const trimmed = trimmedMatch(content, searchBlock, replaceBlock);
  if (trimmed !== null) return trimmed;

  const fuzzy = fuzzyMatch(content, searchBlock, replaceBlock);
  if (fuzzy !== null) return fuzzy;

  const lineResult = lineByLineMatch(content, searchBlock, replaceBlock);
  return lineResult;
}

function directMatch(
  content: string,
  searchBlock: string,
  replaceBlock: string,
): string | null {
  const idx = content.indexOf(searchBlock);
  if (idx === -1) return null;
  return content.slice(0, idx) + replaceBlock + content.slice(idx + searchBlock.length);
}

function trimmedMatch(
  content: string,
  searchBlock: string,
  replaceBlock: string,
): string | null {
  const trimmedSearch = searchBlock.trimEnd();
  const idx = content.indexOf(trimmedSearch);
  if (idx === -1) return null;

  const before = content.slice(0, idx);
  const afterSearchEnd = idx + trimmedSearch.length;
  const trailingContent = content.slice(afterSearchEnd);

  return before + replaceBlock + trailingContent;
}

function fuzzyMatch(
  content: string,
  searchBlock: string,
  replaceBlock: string,
): string | null {
  const minLen = Math.min(searchBlock.length, 50);
  if (minLen < 10) return null;

  let bestIdx = -1;
  let bestLen = 0;

  for (let i = 0; i <= content.length - minLen; i++) {
    const windowLen = Math.min(searchBlock.length, content.length - i);
    const contentSlice = content.slice(i, i + windowLen);
    const searchSlice = searchBlock.slice(0, windowLen);

    const score = similarity(searchSlice, contentSlice);
    if (score > 0.85 && windowLen > bestLen) {
      bestLen = windowLen;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return null;

  const matchEnd = bestIdx + bestLen;
  return content.slice(0, bestIdx) + replaceBlock + content.slice(matchEnd);
}

function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const len = Math.min(a.length, b.length);
  let matches = 0;

  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) matches++;
  }

  return matches / Math.max(a.length, b.length);
}

function lineByLineMatch(
  content: string,
  searchBlock: string,
  replaceBlock: string,
): string | null {
  const contentLines = content.split("\n");
  const searchLines = searchBlock.split("\n");

  if (searchLines.length === 0) return null;

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let matchCount = 0;

    for (let j = 0; j < searchLines.length; j++) {
      const sLine = searchLines[j] ?? "";
      const cLine = contentLines[i + j] ?? "";

      if (editDistance(sLine, cLine) <= Math.max(sLine.length, cLine.length) * 0.2) {
        matchCount++;
      }
    }

    const score = matchCount / searchLines.length;
    if (score > bestScore && score >= 0.8) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return null;

  const before = contentLines.slice(0, bestIdx).join("\n");
  const after = contentLines.slice(bestIdx + searchLines.length).join("\n");

  return (before ? before + "\n" : "") + replaceBlock + (after ? "\n" + after : "");
}

function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  let curr = new Array(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;

    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1]!;
      } else {
        curr[j] = 1 + Math.min(prev[j]!, curr[j - 1]!, prev[j - 1]!);
      }
    }

    const temp = prev;
    prev = curr;
    curr = temp;
  }

  return prev[b.length]!;
}

export function findSimilarLines(searchBlock: string, content: string): string {
  const searchLines = searchBlock.split("\n").filter((l) => l.trim() !== "");
  const contentLines = content.split("\n");

  const suggestions: string[] = [];

  for (const sLine of searchLines) {
    let bestMatch = "";
    let bestDist = Infinity;

    for (const cLine of contentLines) {
      const dist = editDistance(sLine, cLine);
      const threshold = Math.max(sLine.length, cLine.length) * 0.4;

      if (dist < bestDist && dist <= threshold) {
        bestDist = dist;
        bestMatch = cLine;
      }
    }

    if (bestMatch) {
      suggestions.push(`Did you mean:\n  ${bestMatch}`);
    }

    if (suggestions.length >= 5) break;
  }

  return suggestions.join("\n\n");
}

export async function applySearchReplace(
  filePath: string,
  searchBlock: string,
  replaceBlock: string,
): Promise<{ updated: boolean; content?: string; error?: string }> {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const updated = doReplace(content, searchBlock, replaceBlock);

    if (updated === null) {
      const similar = findSimilarLines(searchBlock, content);
      return {
        updated: false,
        error: similar ? `No match found.\n\n${similar}` : "No match found.",
      };
    }

    fs.writeFileSync(filePath, updated, "utf-8");
    return { updated: true, content: updated };
  } catch (err) {
    return {
      updated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}