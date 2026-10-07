/**
 * retrieval/types.ts — shared kernel contracts for repository retrieval.
 *
 * Phase 1 of the retrieval-kernel unification (see plan): this module only
 * declares the Channel interface and shared result types. Existing channel
 * implementations stay where they are; thin adapters live in channels.ts.
 * Later phases route retrieveQuery / executeDeepSearch / intent_read through
 * these contracts instead of calling channel functions directly.
 *
 * Layering: this module imports types only (no runtime store/graph
 * dependencies) so channels and entry points can depend on it freely.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type {
  DeepSearchCandidate,
  DeepSearchDepth,
  ChannelName,
} from "../search/deep-search.js";

export type { DeepSearchDepth, ChannelName };

/** Kernel-level candidate. Alias of the deep-search candidate (P3 flips this). */
export type RetrievalCandidate = DeepSearchCandidate;

/** How a channel produced its candidates (semantic-only for now). */
export type RetrievalStrategy = "persistent-index" | "bm25-preselect";

/** Everything a channel may need. Channels pick the fields they require:
 * query-only (structural/grep/symbol/lsp), corpus-dependent (semantic),
 * seed-dependent (graph). */
export interface ChannelContext {
  query: string;
  cwd: string;
  signal: AbortSignal | undefined;
  ctx: ExtensionContext;
  /** Absolute discovered corpus paths (sorted). Required by semantic/graph. */
  discoveredFiles: string[];
  /** Cwd-relative seed files from earlier phases. Required by graph. */
  seedFiles: string[];
  /** Per-channel result budget (deep-search maxChannelResults). */
  maxResults: number;
  /** User-facing result limit (deep-search limit). */
  limit: number;
  depth: DeepSearchDepth;
}

/** Uniform channel outcome. inspected/scanned/strategy are set when the
 * channel can report coverage (semantic does; others leave undefined). */
export interface ChannelResult {
  channel: ChannelName;
  candidates: RetrievalCandidate[];
  inspected?: number;
  scanned?: number;
  strategy?: RetrievalStrategy;
  /** Non-fatal channel note for the degraded[] report (e.g. fallback used). */
  note?: string;
}

/** A retrieval channel: one signal source behind a uniform interface. */
export interface RetrievalChannel {
  readonly name: ChannelName;
  run(context: ChannelContext): Promise<ChannelResult>;
}
