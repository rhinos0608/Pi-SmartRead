/**
 * Test-failure-proximity channel.
 *
 * Ranks source files by proximity to test failures:
 *  1. Files appearing directly in stack traces (score 100)
 *  2. Files that import/depend on stack-trace files (score 50)
 *
 * Unavailable when no test failures are provided.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ChannelCandidate {
  file: string;
  line?: number;
  endLine?: number;
  name: string;
  kind: string;
  snippet: string;
  rawScore: number;
}

export interface ChannelResult {
  channel: string;
  candidates: ChannelCandidate[];
  unavailable?: { reason: string };
  metadata?: Record<string, unknown>;
}

export interface TestFailure {
  /** Path to the failing test file */
  testFile: string;
  /** Call stack lines (array of strings, typically from the test runner output) */
  stackTrace: string[];
}

export interface TestFailureProximityOptions {
  failures: TestFailure[];
  allFiles: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────────

const MAX_CANDIDATES = 500;
const CHANNEL_NAME = "test-failure-proximity";

/** Score for files appearing directly in stack traces */
const STACK_TRACE_SCORE = 100;

/** Score for files that import/depend on stack-trace files */
const IMPORTER_SCORE = 50;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract file paths from a stack trace string.
 * Matches patterns like:
 *   at functionName (/path/to/file.ts:10:5)
 *   at /path/to/file.ts:10:5
 *   at Object.<anonymous> (/path/to/file.ts:10:5)
 */
function extractPathsFromStackTrace(stackTrace: string[]): Set<string> {
  const paths = new Set<string>();
  // Match file paths in parentheses or standalone at the end of a line
  const pathPattern = /\(([^)]+:\d+:\d+)\)|at\s+(.+?\.(?:ts|js|tsx|jsx|mjs|cjs)(?::\d+:\d+)?)$/;
  // Also match relative paths like ./src/foo.ts or src/foo.ts
  const relativePattern = /\b((?:\.\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:ts|js|tsx|jsx|mjs|cjs))(?::\d+:\d+)?/g;

  for (const line of stackTrace) {
    // Try the main pattern first
    const mainMatch = line.match(pathPattern);
    if (mainMatch) {
      const raw = mainMatch[1] ?? mainMatch[2];
      if (raw) {
        // Strip line:col suffix
        const filePath = raw.replace(/:\d+:\d+$/, "");
        paths.add(filePath);
      }
    }
    // Try relative pattern for any remaining paths
    const relMatches = line.matchAll(relativePattern);
    for (const m of relMatches) {
      if (m[1]) paths.add(m[1]);
    }
  }
  return paths;
}

/**
 * Simple heuristic: for each file, check if it imports/re-exports any of the
 * stack-trace files. Uses a line-by-line scan for import/export statements.
 */
function buildImporterMap(
  allFiles: string[],
  stackFiles: Set<string>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  // Normalize stack file basenames and full paths for matching
  const stackBasenames = new Set<string>();
  for (const f of stackFiles) {
    stackBasenames.add(f);
    const base = f.split("/").pop();
    if (base) stackBasenames.add(base);
  }

  for (const file of allFiles) {
    if (stackFiles.has(file)) continue;
    // Only scan .ts/.js files
    if (!/\.(ts|js|tsx|jsx)$/.test(file)) continue;

    const importers: string[] = [];
    // Check if basename of this file is referenced in stack files
    const fileBase = file.split("/").pop() ?? file;
    if (stackBasenames.has(fileBase)) {
      importers.push(file);
    }
    // Check the reverse: does this file import any stack-trace file?
    // We use basename matching since we don't read file contents here.
    // Files sharing a directory prefix with a stack-trace file are likely related.
    const fileDir = file.substring(0, file.lastIndexOf("/"));
    for (const sf of stackFiles) {
      const sfDir = sf.substring(0, sf.lastIndexOf("/"));
      if (fileDir && sfDir && fileDir === sfDir) {
        importers.push(sf);
        break;
      }
    }

    if (importers.length > 0) {
      map.set(file, importers);
    }
  }
  return map;
}

// ── Main channel function ──────────────────────────────────────────────────────

export function runTestFailureProximity(
  options: TestFailureProximityOptions,
): ChannelResult {
  const { failures, allFiles } = options;

  if (!failures || failures.length === 0) {
    return {
      channel: CHANNEL_NAME,
      candidates: [],
      unavailable: { reason: "No test failures provided" },
    };
  }

  // 1. Extract all file paths from stack traces
  const stackFiles = new Set<string>();
  for (const failure of failures) {
    stackFiles.add(failure.testFile);
    const paths = extractPathsFromStackTrace(failure.stackTrace);
    for (const p of paths) stackFiles.add(p);
  }

  // 2. Score stack-trace files
  const candidates: ChannelCandidate[] = [];
  const seen = new Set<string>();

  for (const filePath of stackFiles) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    candidates.push({
      file: filePath,
      name: filePath.split("/").pop() ?? filePath,
      kind: "stack-trace",
      snippet: `File appears in test failure stack trace`,
      rawScore: STACK_TRACE_SCORE,
    });
  }

  // 3. Find importers of stack-trace files
  const importers = buildImporterMap(allFiles, stackFiles);
  for (const [file] of importers) {
    if (seen.has(file)) continue;
    seen.add(file);
    candidates.push({
      file,
      name: file.split("/").pop() ?? file,
      kind: "importer",
      snippet: `File imports/relies on a test-failure-adjacent module`,
      rawScore: IMPORTER_SCORE,
    });
  }

  // 4. Sort by rawScore descending, cap at MAX_CANDIDATES
  candidates.sort((a, b) => b.rawScore - a.rawScore);
  const capped = candidates.slice(0, MAX_CANDIDATES);

  return {
    channel: CHANNEL_NAME,
    candidates: capped,
    metadata: {
      stackTraceFiles: stackFiles.size,
      importerFiles: importers.size,
      totalScored: capped.length,
      failuresProcessed: failures.length,
    },
  };
}
