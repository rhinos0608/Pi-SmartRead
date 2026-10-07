/**
 * retrieval/channels.ts — thin kernel adapters over existing channel functions.
 *
 * Phase 1: zero behavior change. Each adapter delegates to the current
 * implementation and shapes its output as a ChannelResult. Error semantics
 * are unchanged (throw-through); orchestration-level degraded[] handling
 * stays with the callers until the kernel runner lands (P3).
 */

import { runSearchChannel } from "../search/deep-search-structural.js";
import { runSymbolChannel } from "../search/deep-search-symbol.js";
import { runSemanticChannel } from "../search/deep-search-semantic.js";
import { MAX_GRAPH_CANDIDATES, runGraphChannel } from "../search/deep-search-graph.js";
import { runLSPChannel } from "../search/deep-search-lsp.js";
import type {
  ChannelContext,
  ChannelResult,
  RetrievalChannel,
} from "./types.js";

export const structuralChannel: RetrievalChannel = {
  name: "structural",
  async run(context: ChannelContext): Promise<ChannelResult> {
    const candidates = await runSearchChannel(
      context.query,
      context.cwd,
      "code",
      context.maxResults,
      context.signal,
      context.ctx,
    );
    return { channel: "structural", candidates };
  },
};

export const grepChannel: RetrievalChannel = {
  name: "structural",
  async run(context: ChannelContext): Promise<ChannelResult> {
    const candidates = await runSearchChannel(
      context.query,
      context.cwd,
      "grep",
      context.maxResults,
      context.signal,
      context.ctx,
    );
    return { channel: "structural", candidates };
  },
};

export const symbolChannel: RetrievalChannel = {
  name: "symbol",
  async run(context: ChannelContext): Promise<ChannelResult> {
    const candidates = await runSymbolChannel(
      context.query,
      context.cwd,
      context.maxResults,
      context.signal,
      context.ctx,
    );
    return { channel: "symbol", candidates };
  },
};

export const semanticChannel: RetrievalChannel = {
  name: "semantic",
  async run(context: ChannelContext): Promise<ChannelResult> {
    const outcome = await runSemanticChannel(
      context.query,
      context.cwd,
      context.discoveredFiles,
      context.limit,
      context.signal,
      context.ctx,
    );
    return {
      channel: "semantic",
      candidates: outcome.candidates,
      inspected: outcome.inspected,
      scanned: outcome.scanned,
      strategy: outcome.strategy,
    };
  },
};

export const graphChannel: RetrievalChannel = {
  name: "graph",
  async run(context: ChannelContext): Promise<ChannelResult> {
    const candidates = await runGraphChannel(
      context.cwd,
      context.seedFiles,
      context.discoveredFiles,
      Math.min(MAX_GRAPH_CANDIDATES, context.maxResults),
      context.signal,
    );
    return { channel: "graph", candidates };
  },
};

export const lspChannel: RetrievalChannel = {
  name: "lsp",
  async run(context: ChannelContext): Promise<ChannelResult> {
    const candidates = await runLSPChannel(
      context.query,
      context.cwd,
      context.depth,
      context.maxResults,
      context.signal,
    );
    return { channel: "lsp", candidates };
  },
};

/** All kernel channels in deep-search phase order (graph last: needs seeds). */
export const allChannels: RetrievalChannel[] = [
  structuralChannel,
  grepChannel,
  symbolChannel,
  semanticChannel,
  lspChannel,
  graphChannel,
];
