import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { EdgeStore } from "../context-graph.js";

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
const CHANNEL_NAME = "git-coupling";

/**
 * Rank files by co-change coupling strength to a set of seed files.
 * Reads co-change edges from the EdgeStore and aggregates confidence
 * scores for every file that shares commits with any seed.
 */
export function runGitCouplingChannel(
  root: string,
  seeds: string[],
  maxCandidates = MAX_CANDIDATES,
): ChannelResult {
  if (seeds.length === 0) {
    return { channel: CHANNEL_NAME, candidates: [], unavailable: { reason: "no seed files provided" } };
  }

  const events = EdgeStore.readEdges(root);
  // Only co_change edges from git_history source
  const coEdges = events.filter(
    (e) => e.type === "co_change" && e.data.source === "git_history",
  );

  if (coEdges.length === 0) {
    return { channel: CHANNEL_NAME, candidates: [], unavailable: { reason: "no co-change data in EdgeStore" } };
  }

  // EdgeStore canonicalises paths via realpathSync — match that exactly
  const resolvedRoot = realpathSync(resolve(root));
  const seedSet = new Set(
    seeds.map((s) => realpathSync(resolve(resolvedRoot, s))),
  );

  // Accumulate coupling score per target file (keys are absolute canonical paths)
  const scores = new Map<string, number>();

  for (const ev of coEdges) {
    const from = ev.data.from;
    const to = ev.data.to;
    const confidence = ev.data.confidence ?? 0.7;

    // If from is a seed, to is coupled
    if (seedSet.has(from) && !seedSet.has(to)) {
      scores.set(to, (scores.get(to) ?? 0) + confidence);
    }
    // If to is a seed, from is coupled
    if (seedSet.has(to) && !seedSet.has(from)) {
      scores.set(from, (scores.get(from) ?? 0) + confidence);
    }
  }

  // Sort descending by score, take top N
  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates);

  const candidates: ChannelCandidate[] = sorted.map(([absPath, rawScore]) => {
    const relPath = relative(resolvedRoot, absPath);
    return {
      file: relPath,
      name: relPath,
      kind: "co_change_coupled",
      snippet: `coupling score: ${rawScore.toFixed(2)}`,
      rawScore,
    };
  });

  return {
    channel: CHANNEL_NAME,
    candidates,
    metadata: {
      seedCount: seeds.length,
      edgeCount: coEdges.length,
      matchedFiles: candidates.length,
    },
  };
}
