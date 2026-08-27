/**
 * Diagnostic-proximity ranking channel.
 *
 * Ranks files by diagnostic density (errors + warnings per source line).
 * Higher density → higher rawScore, signaling the file is a hotspot for
 * problems worth investigating.
 */

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

export interface DiagnosticInput {
  /** Relative or absolute file path. */
  file: string;
  /** Total number of source lines in the file. */
  lineCount: number;
  /** Number of error-level diagnostics. */
  errors: number;
  /** Number of warning-level diagnostics. */
  warnings: number;
}

const MAX_CANDIDATES = 500;
const CHANNEL_NAME = "diagnostic-proximity";

/**
 * Rank files by diagnostic density.
 *
 * @param inputs - files with their diagnostic counts and line counts
 * @returns ChannelResult ordered from highest density to lowest
 */
export function rankByDiagnosticProximity(inputs: DiagnosticInput[]): ChannelResult {
  if (inputs.length === 0) {
    return {
      channel: CHANNEL_NAME,
      candidates: [],
      unavailable: { reason: "no diagnostics provided" },
    };
  }

  const candidates: ChannelCandidate[] = [];

  for (const input of inputs) {
    const totalDiagnostics = input.errors + input.warnings;
    if (totalDiagnostics === 0) continue;

    const lineCount = Math.max(input.lineCount, 1);
    const density = totalDiagnostics / lineCount;

    const severity =
      input.errors > 0 ? `error:${input.errors}` : `warning:${input.warnings}`;

    candidates.push({
      file: input.file,
      name: input.file,
      kind: severity,
      snippet: `${totalDiagnostics} diagnostics over ${input.lineCount} lines (density: ${density.toFixed(4)})`,
      rawScore: density,
    });
  }

  if (candidates.length === 0) {
    return {
      channel: CHANNEL_NAME,
      candidates: [],
      unavailable: { reason: "all files have zero diagnostics" },
    };
  }

  candidates.sort((a, b) => b.rawScore - a.rawScore);

  const bounded = candidates.slice(0, MAX_CANDIDATES);

  return {
    channel: CHANNEL_NAME,
    candidates: bounded,
    metadata: {
      totalFiles: inputs.length,
      filesWithDiagnostics: bounded.length,
      maxCandidates: MAX_CANDIDATES,
    },
  };
}
