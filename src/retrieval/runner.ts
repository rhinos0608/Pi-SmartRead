/**
 * retrieval/runner.ts — generic retrieval-kernel fanout.
 *
 * runQueryChannels executes RetrievalChannel adapters in parallel, concatenates
 * fulfilled candidates in channel order, records non-abort failures as degraded
 * notes, and propagates cancellation. Public read-query retrieval was removed;
 * this runner now serves active deep-search/retrieval workflows only.
 */

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
