import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";
import type { ContextGraph } from "./context-graph.js";

export type InspectV4Mode = "directory" | "file";

export type CallDirection = "callers" | "callees" | "both";
export type DiffTarget = "unstaged" | "staged" | "HEAD";

export interface InspectV4Input {
  path: string;
  signals?: string[];
  mapTokens?: number;
  focus?: string[];
  compact?: boolean;
  cwd: string;
  sessionFilePath: string;
  signal?: AbortSignal;

  // ── WP-4 new params ────────────────────────────────────────────
  /** BFS call graph traversal depth (1-5). File mode only. */
  callDepth?: number;
  /** Call graph traversal direction. Requires callDepth. File mode only. */
  callDirection?: CallDirection;
  /** Return zero-caller functions in scope. File or directory mode. */
  deadCode?: boolean;
  /** Compute blast radius from target file. File or directory mode. */
  impact?: boolean;
  /** Map git diff to affected symbols with risk classification. */
  diff?: DiffTarget;
  /** Run community detection on import graph. Directory mode only. */
  clusters?: boolean;
  /** Return graph structure summary (node/edge counts, sample names). */
  graphSchema?: boolean;
  /** Top-N functions by fan-in. File or directory mode. */
  hotspots?: boolean;
  /** Detect service boundaries from monorepo config. Directory mode only. */
  boundaries?: boolean;
  /** Extract HTTP route → handler mappings. File or directory mode. */
  routes?: boolean;
  /** Derive architectural layers. Directory mode only. */
  layers?: boolean;

  // ── ContextGraph injection (WP-4 owns the type; WP-5 populates at runtime) ──
  contextGraph?: ContextGraph;
}

export interface InspectV4Result {
  mode: InspectV4Mode;
  contentText: string;
  workspaceEvidence: WorkspaceEvidenceEnvelope;
  lineCount: number;
  byteLength: number;
  truncated: boolean;
  upstreamDetails?: Record<string, unknown>;
}

// ── Re-export compute-module result types for consumers ──
export type { ImpactResult, DeadCodeResult } from "./impact-analysis.js";
export type { ClusterResult } from "./community-detection.js";
export type { RouteInfo } from "./route-extraction.js";
export type { LayerMap } from "./layer-analysis.js";
export type { BoundaryResult } from "./monorepo-detector.js";
