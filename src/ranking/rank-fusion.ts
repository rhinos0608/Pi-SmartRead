import { RRF_K } from "./deep-search-constants.js";

export interface ChannelCandidate {
  file: string;
  line?: number;
  endLine?: number;
  name: string;
  kind: string;
  snippet: string;
  rawScore: number;
  metadata?: Record<string, unknown>;
}

export interface ChannelResult {
  channel: string;
  candidates: ChannelCandidate[];
  unavailable?: { reason: string };
  metadata?: Record<string, unknown>;
}

/**
 * Fuse multiple channel results into one sorted list using Reciprocal Rank Fusion.
 *
 * For each candidate appearing in channel c at rank r (1-based),
 * its RRF score = sum over contributing channels of (weight_c / (K + r)).
 * Candidates in multiple channels accumulate higher scores.
 *
 * Skipped: channels with `unavailable` set.
 * Bounded: max 2000 output candidates.
 */
export function fuseChannels(
  results: ChannelResult[],
  options?: { weights?: Record<string, number> },
): ChannelResult {
  const weights = options?.weights ?? {};

  // Map: dedup key -> { candidate, rrfScore, origins[] }
  const map = new Map<
    string,
    { candidate: ChannelCandidate; rrfScore: number; origins: { channel: string; rank: number }[] }
  >();

  for (const ch of results) {
    if (ch.unavailable) continue;
    const w = weights[ch.channel] ?? 1;
    ch.candidates.forEach((cand, idx) => {
      const r = idx + 1; // 1-based rank
      const rrfScore = w / (RRF_K + r);
      const key = `${cand.file}::${cand.name}::${cand.line ?? ""}`;
      const existing = map.get(key);
      if (existing) {
        existing.rrfScore += rrfScore;
        existing.origins.push({ channel: ch.channel, rank: r });
      } else {
        map.set(key, {
          candidate: cand,
          rrfScore,
          origins: [{ channel: ch.channel, rank: r }],
        });
      }
    });
  }

  // Sort descending by RRF score, then by file+name for determinism
  const sorted = [...map.values()].sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore;
    const aKey = `${a.candidate.file}:${a.candidate.name}`;
    const bKey = `${b.candidate.file}:${b.candidate.name}`;
    return aKey.localeCompare(bKey);
  });

  const capped = sorted.slice(0, 2000);

  const candidates: ChannelCandidate[] = capped.map(({ candidate, rrfScore, origins }) => {
    const merged: Record<string, unknown> = { rrfOrigins: origins };
    if (candidate.metadata) Object.assign(merged, candidate.metadata);
    return { ...candidate, rawScore: rrfScore, metadata: merged };
  });

  return { channel: "fused", candidates };
}
