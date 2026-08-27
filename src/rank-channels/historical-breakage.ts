/**
 * Historical-breakage ranking channel.
 *
 * Ranks files by breakage frequency and recency from EdgeStore mutation events.
 * More recent and more frequent breakage → higher rawScore.
 */

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
const CHANNEL_NAME = "historical-breakage";

/**
 * Rank files by historical breakage frequency and recency.
 *
 * Each breakage event contributes: confidence * recencyWeight to the target file.
 * recencyWeight = 1 / (1 + ageInDays / HALF_LIFE_DAYS) — recent events score higher.
 * Final rawScore = total weighted breakage count for the file.
 *
 * @param root - Project root directory for EdgeStore lookup.
 * @param maxCandidates - Max results (default 500).
 */
export function runHistoricalBreakageChannel(
  root: string,
  maxCandidates = MAX_CANDIDATES,
): ChannelResult {
  const events = EdgeStore.readEdges(root);
  const breakages = events.filter((e) => e.type === "breakage");

  if (breakages.length === 0) {
    return {
      channel: CHANNEL_NAME,
      candidates: [],
      unavailable: { reason: "no breakage events in EdgeStore" },
    };
  }

  const now = Date.now();
  const HALF_LIFE_DAYS = 7;
  const HALF_LIFE_MS = HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

  // Accumulate weighted breakage score per target file
  const scores = new Map<string, number>();
  // Track most recent breakage timestamp per file for snippet
  const latestTs = new Map<string, number>();
  // Track breakage count per file
  const counts = new Map<string, number>();

  for (const ev of breakages) {
    const file = ev.data.to;
    const confidence = ev.data.confidence ?? 1.0;
    const ageMs = now - ev.timestamp;
    const recencyWeight = 1 / (1 + ageMs / HALF_LIFE_MS);
    const contribution = confidence * recencyWeight;

    scores.set(file, (scores.get(file) ?? 0) + contribution);
    counts.set(file, (counts.get(file) ?? 0) + 1);

    const prev = latestTs.get(file) ?? 0;
    if (ev.timestamp > prev) latestTs.set(file, ev.timestamp);
  }

  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxCandidates);

  const candidates: ChannelCandidate[] = sorted.map(([file, rawScore]) => {
    const count = counts.get(file) ?? 0;
    const ts = latestTs.get(file) ?? now;
    const ageDays = Math.round((now - ts) / (24 * 60 * 60 * 1000));
    return {
      file,
      name: file,
      kind: "breakage",
      snippet: `${count} breakage event${count > 1 ? "s" : ""}, last ${ageDays}d ago (score: ${rawScore.toFixed(2)})`,
      rawScore,
    };
  });

  return {
    channel: CHANNEL_NAME,
    candidates,
    metadata: {
      totalBreakageEvents: breakages.length,
      matchedFiles: candidates.length,
      maxCandidates,
    },
  };
}
