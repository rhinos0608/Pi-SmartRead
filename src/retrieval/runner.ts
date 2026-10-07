/**
 * retrieval/runner.ts — generic kernel runner + minimal persistent-index channel.
 *
 * runQueryChannels is the Phase 2 kernel fanout: parallel Promise.allSettled
 * over any RetrievalChannel list, fulfilled candidates concatenated, rejections
 * recorded as `${name} channel failed: ${reason}` (deep-search phase-1
 * convention). AbortSignal errors propagate (rethrow, never degraded).
 *
 * persistentIndexChannel exists because query-retrieval must NOT reuse the
 * kernel semanticChannel adapter: that adapter needs discoveredFiles (a full
 * corpus discovery query-retrieval deliberately skips) and falls back to
 * intent_read with DeepSearchCandidate shaping, which would change
 * query-retrieval's contract (QueryRetrievalHit shape, "hybrid" strategy,
 * scope filtering). This channel instead queries the already-resolved
 * persistent index directly — no discovery, no intent_read — and projects
 * each index hit losslessly onto RetrievalCandidate (file/line/endLine carry
 * the hit fields), so the caller-side hit mapping stays byte-identical.
 *
 * Layering: imports types only (plus node:path). No static import of
 * mcp-registry or src/read modules — the index handle is injected by the
 * caller, so this module stays cycle-free.
 */

import { resolve } from "node:path";
import type {
  ChannelContext,
  ChannelResult,
  RetrievalCandidate,
  RetrievalChannel,
} from "./types.js";

export interface RunQueryChannelsResult {
  candidates: RetrievalCandidate[];
  degraded: string[];
  results: ChannelResult[];
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (name === "AbortError") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /abort/i.test(message);
}

/**
 * Fan out over channels in parallel. Abort errors rethrow; every other
 * rejection becomes a degraded entry. Resolution order is channel order.
 */
export async function runQueryChannels(
  channels: RetrievalChannel[],
  context: ChannelContext,
): Promise<RunQueryChannelsResult> {
  const candidates: RetrievalCandidate[] = [];
  const degraded: string[] = [];
  const results: ChannelResult[] = [];
  const pending = Promise.allSettled(channels.map((channel) => channel.run(context)));
  // Fail fast on abort instead of waiting for every channel to settle.
  // Non-abort rejections still settle into degraded entries below.
  const outcomes = context.signal
    ? await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          const onAbort = (): void => {
            reject(context.signal!.reason ?? new Error("Operation aborted"));
          };
          context.signal!.addEventListener("abort", onAbort, { once: true });
        }),
      ])
    : await pending;
  for (let index = 0; index < outcomes.length; index++) {
    const outcome = outcomes[index]!;
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
      candidates.push(...outcome.value.candidates);
      if (outcome.value.note) degraded.push(outcome.value.note);
      continue;
    }
    // AbortSignal errors propagate — never recorded as degraded.
    if (context.signal?.aborted || isAbortError(outcome.reason)) throw outcome.reason;
    const name = channels[index]!.name;
    const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    degraded.push(`${name} channel failed: ${reason}`);
  }
  return { candidates, degraded, results };
}

/** Minimal raw hit from a persistent semantic index search. */
export interface PersistentIndexHit {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  symbolKind: string;
  codeSnippet: string;
  score: number;
}

/** Structural minimum the index channel needs (real SemanticIndex satisfies this). */
export interface PersistentIndexLike {
  readonly root: string;
  search(query: string, options: { topK: number; pathPrefix?: string }): Promise<PersistentIndexHit[]>;
}

export function persistentIndexChannel(
  index: PersistentIndexLike,
  options: { topK: number; pathPrefix?: string },
): RetrievalChannel {
  return {
    name: "semantic",
    async run(context: ChannelContext): Promise<ChannelResult> {
      const results = await index.search(context.query, {
        topK: options.topK,
        pathPrefix: options.pathPrefix,
      });
      const candidates: RetrievalCandidate[] = results.map((result, position) => ({
        file: resolve(index.root, result.filePath),
        line: result.lineStart,
        endLine: result.lineEnd,
        name: result.symbolKind,
        kind: result.symbolKind,
        snippet: result.codeSnippet,
        channel: "semantic",
        rawScore: result.score,
        rank: position + 1,
      }));
      return { channel: "semantic", candidates, inspected: candidates.length, strategy: "persistent-index" };
    },
  };
}
