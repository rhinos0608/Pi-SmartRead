/**
 * RepositoryRankingService — orchestrates all 9 ranking channels,
 * RRF fusion, workspace view rendering, and relationship evidence.
 *
 * Security: only registered channel names accepted in weights/channel filter.
 * Bounded: max 2000 fused candidates returned.
 */

import type { ChannelCandidate, ChannelResult } from "./rank-fusion.js";
import { fuseChannels } from "./rank-fusion.js";
import {
  renderWorkspaceView,
  type WorkspaceView,
  type WorkspaceViewFormat,
} from "./workspace-view.js";
import {
  getRelationshipEvidence,
  type RelationshipEvidencePage,
} from "./relationship-evidence.js";
import type { Provenance } from "./context-graph.js";

// Channel imports
import { rankSemantic, type SemanticEntry } from "./rank-channels/semantic.js";
import { rankAnnotationProximity } from "./rank-channels/annotation-proximity.js";
import { runChangeProximity } from "./rank-channels/change-proximity.js";
import { rankByDiagnosticProximity, type DiagnosticInput } from "./rank-channels/diagnostic-proximity.js";
import { rankExplicitSeed } from "./rank-channels/explicit-seed.js";
import { runGitCouplingChannel } from "./rank-channels/git-coupling.js";
import { runHistoricalBreakageChannel } from "./rank-channels/historical-breakage.js";
import { structuralPageRank } from "./rank-channels/structural-pagerank.js";
import { runTestFailureProximity, type TestFailure } from "./rank-channels/test-failure-proximity.js";
import type { GraphEdge } from "./pagerank.js";

// ── Public types ───────────────────────────────────────────────

export interface RankResult {
  candidates: ChannelCandidate[];
  channelResults: ChannelResult[];
  assessment: "complete" | "partial";
  truncated: boolean;
}

export interface RankWorkspaceInput {
  query: string;
  seeds?: string[];
  snapshotId: string;
  channels?: string[];
}

export interface RenderViewInput {
  rankedCandidates: ChannelCandidate[];
  format: WorkspaceViewFormat;
  hardBudget: { maxBytes: number; maxLines: number };
}

export interface GetRelationshipEvidenceInput {
  edges: Provenance[];
  from?: string;
  to?: string;
  relationshipTypes?: string[];
  limit: number;
  cursor?: string;
}

/** All data channels may need. Caller populates what it has; channels default to empty. */
export interface WorkspaceContext {
  query: string;
  seeds?: string[];
  snapshotId: string;
  semanticEntries?: SemanticEntry[];
  candidateFiles?: string[];
  changedPaths?: string[];
  provenances?: Provenance[];
  diagnostics?: DiagnosticInput[];
  graphEdges?: GraphEdge[];
  failures?: TestFailure[];
  allFiles?: string[];
  root?: string;
}

// ── Channel registry ───────────────────────────────────────────

interface ChannelRunner {
  name: string;
  run: (ctx: WorkspaceContext) => ChannelResult;
}

const ALL_CHANNELS: ChannelRunner[] = [
  {
    name: "semantic",
    run: (ctx) => rankSemantic(ctx.query, ctx.semanticEntries ?? []),
  },
  {
    name: "annotation-proximity",
    run: (ctx) => rankAnnotationProximity(ctx.candidateFiles ?? []),
  },
  {
    name: "change-proximity",
    run: (ctx) =>
      runChangeProximity({
        changedPaths: ctx.changedPaths ?? [],
        provenances: ctx.provenances ?? [],
      }),
  },
  {
    name: "diagnostic-proximity",
    run: (ctx) => rankByDiagnosticProximity(ctx.diagnostics ?? []),
  },
  {
    name: "explicit-seed",
    run: (ctx) => rankExplicitSeed(ctx.seeds ?? [], ctx.candidateFiles ?? []),
  },
  {
    name: "git-coupling",
    run: (ctx) => runGitCouplingChannel(ctx.root ?? ".", ctx.seeds ?? []),
  },
  {
    name: "historical-breakage",
    run: (ctx) => runHistoricalBreakageChannel(ctx.root ?? "."),
  },
  {
    name: "structural-pagerank",
    run: (ctx) => structuralPageRank(ctx.graphEdges ?? []),
  },
  {
    name: "test-failure-proximity",
    run: (ctx) =>
      runTestFailureProximity({
        failures: ctx.failures ?? [],
        allFiles: ctx.allFiles ?? [],
      }),
  },
];

const REGISTERED_NAMES = new Set(ALL_CHANNELS.map((c) => c.name));

// ── Security: weight validation ────────────────────────────────

function validateWeights(weights: Record<string, number>): void {
  for (const key of Object.keys(weights)) {
    if (!REGISTERED_NAMES.has(key)) {
      throw new Error(
        `Unknown channel "${key}" in weights. Registered: ${[...REGISTERED_NAMES].join(", ")}`,
      );
    }
  }
}

function validateChannelNames(names: string[]): void {
  for (const name of names) {
    if (!REGISTERED_NAMES.has(name)) {
      throw new Error(
        `Unknown channel "${name}". Registered: ${[...REGISTERED_NAMES].join(", ")}`,
      );
    }
  }
}

// ── Constants ──────────────────────────────────────────────────

const MAX_CANDIDATES = 2000;

// ── Service ────────────────────────────────────────────────────

export class RepositoryRankingService {
  private readonly channels: ChannelRunner[];
  private readonly context: WorkspaceContext;
  private readonly weights: Record<string, number>;

  constructor(context: WorkspaceContext, weights?: Record<string, number>) {
    if (weights) validateWeights(weights);
    this.channels = ALL_CHANNELS;
    this.context = context;
    this.weights = weights ?? {};
  }

  /**
   * Run selected channels (all by default), fuse with RRF K=60,
   * return top 2000 candidates with channel contribution metadata.
   */
  async rankWorkspace(input: RankWorkspaceInput): Promise<RankResult> {
    if (input.channels) validateChannelNames(input.channels);

    const selectedNames = new Set(input.channels ?? REGISTERED_NAMES);
    const selectedChannels = this.channels.filter((c) => selectedNames.has(c.name));

    const results: ChannelResult[] = selectedChannels.map((ch) => {
      try {
        return ch.run(this.context);
      } catch {
        return {
          channel: ch.name,
          candidates: [],
          unavailable: { reason: "channel threw an error" },
        };
      }
    });

    const hasUnavailable = results.some((r) => r.unavailable != null);
    const assessment: "complete" | "partial" = hasUnavailable ? "partial" : "complete";

    // Count unique candidates before fusion cap to detect truncation
    const uniqueKeys = new Set<string>();
    for (const ch of results) {
      if (ch.unavailable) continue;
      for (const c of ch.candidates) {
        uniqueKeys.add(`${c.file}::${c.name}::${c.line ?? ""}`);
      }
    }
    const truncated = uniqueKeys.size > MAX_CANDIDATES;

    const fused = fuseChannels(results, { weights: this.weights });
    const candidates = fused.candidates.slice(0, MAX_CANDIDATES);

    return { candidates, channelResults: results, assessment, truncated };
  }

  /** Delegate to workspace-view renderWorkspaceView. */
  renderView(input: RenderViewInput): WorkspaceView {
    return renderWorkspaceView(input);
  }

  /** Delegate to relationship-evidence getRelationshipEvidence. */
  getRelationshipEvidence(input: GetRelationshipEvidenceInput): RelationshipEvidencePage {
    return getRelationshipEvidence(input.edges, {
      from: input.from,
      to: input.to,
      relationshipTypes: input.relationshipTypes,
      limit: input.limit,
      cursor: input.cursor,
    });
  }
}
