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

const MAX_CANDIDATES = 500;

/**
 * Rank files that match user-provided seed paths/names.
 *
 * Scoring:
 *   - Exact full-path match  → 1.0
 *   - Basename match         → 0.5
 *   - Partial path substring → 0.3
 *
 * Unavailable when no seeds provided.
 */
export function rankExplicitSeed(
  seeds: string[],
  candidateFiles: string[],
): ChannelResult {
  if (!seeds.length) {
    return {
      channel: "explicit-seed",
      candidates: [],
      unavailable: { reason: "no seeds provided" },
    };
  }

  const normalisedSeeds = seeds.map((s) => s.replace(/\\/g, "/").toLowerCase());
  const candidates: ChannelCandidate[] = [];

  for (const file of candidateFiles) {
    const normalisedFile = file.replace(/\\/g, "/").toLowerCase();
    const basename = normalisedFile.split("/").pop() ?? "";

    let bestScore = 0;

    for (const seed of normalisedSeeds) {
      if (normalisedFile === seed) {
        bestScore = 1.0;
        break; // perfect match, no need to check further
      }
      if (basename === seed || basename === seed.split("/").pop()) {
        bestScore = Math.max(bestScore, 0.5);
      } else if (normalisedFile.includes(seed)) {
        bestScore = Math.max(bestScore, 0.3);
      }
    }

    if (bestScore > 0) {
      candidates.push({
        file,
        name: basename,
        kind: "file",
        snippet: "",
        rawScore: bestScore,
      });
    }
  }

  // Sort by rawScore descending, then alphabetically for determinism
  candidates.sort((a, b) => b.rawScore - a.rawScore || a.file.localeCompare(b.file));

  return {
    channel: "explicit-seed",
    candidates: candidates.slice(0, MAX_CANDIDATES),
    metadata: { totalMatches: candidates.length },
  };
}
