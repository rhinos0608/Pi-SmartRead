/**
 * Render code snippets with structural context.
 * Given "lines of interest" (LOIs), shows those lines plus their
 * parent context (class/function headers) based on indentation.
 */

export interface TreeContextOptions {
  color?: boolean;
  margin?: number;
}

/**
 * Renders code lines around points of interest with parent context.
 *
 * For each line of interest, walks upward to find parent scope boundaries
 * (lines with less indentation) and includes them.
 *
 * @param code - Full source code of the file
 * @param linesOfInterest - 1-based line numbers of symbols to highlight
 * @returns Rendered string with context lines
 */
export function renderTreeContext(
  code: string,
  linesOfInterest: number[],
  _options: TreeContextOptions = {},
): string {
  if (linesOfInterest.length === 0) return "";

  const lines = code.split("\n");
  const loiSet = new Set(linesOfInterest);
  const visibleLines = new Set<number>();

  for (const loi of loiSet) {
    if (loi < 1 || loi > lines.length) continue;
    visibleLines.add(loi);
    addParentContext(lines, loi, visibleLines);
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

    const line = lines[lineNum - 1];
    output.push(line);
    lastLine = lineNum;
  }

  return output.join("\n");
}

/**
 * Walks upward from lineNum to find parent scope boundaries
 * (lines with strictly less indentation).
 */
function addParentContext(
  lines: string[],
  lineNum: number,
  visible: Set<number>,
): void {
  const targetIndent = getIndent(lines[lineNum - 1]);
  let currentIndent = targetIndent;

  for (let i = lineNum - 1; i >= 1; i--) {
    const line = lines[i - 1];
    if (line.trim() === "") continue;

    const indent = getIndent(line);
    if (indent < currentIndent) {
      visible.add(i);
      currentIndent = indent;
      if (indent === 0) break;
    }
  }
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}
