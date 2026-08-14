/**
 * Runtime health aggregation for Pi-SmartRead.
 *
 * Deliberately minimal: no monitoring framework, no persistent metrics —
 * just truthful, additive status of the graph/watcher/semantic-index/
 * embedding/LSP subsystems plus a bounded ring buffer of recent retrieval
 * degradation codes. Never exposes raw error messages, URLs, keys, or PII.
 */
import { validateEmbeddingConfig } from "./config.js";
import { currentGraphGeneration } from "./context-graph.js";
import { getSemanticIndex } from "./semantic-index-registry.js";
import { getLSPBridge } from "./lsp-bridge.js";

export type DegradationBackend = "bm25" | "symbol" | "semantic" | "lsp" | "lexical";

export interface DegradationRecord {
  backend: DegradationBackend;
  code: string;
  ts: number;
}

export interface WatcherHealthState {
  active: boolean;
  dirty: boolean;
}

export type SemanticIndexState =
  | "not_initialized"
  | "fresh"
  | "updating"
  | "stale_or_unavailable";

export interface RuntimeHealthReport {
  graph: { generation: number };
  watcher: WatcherHealthState;
  semanticIndex: {
    available: boolean;
    state: SemanticIndexState;
    stats?: { ready: boolean; updating: boolean; dimension: number | null; fileCount: number; chunkCount: number };
  };
  embedding: { enabled: boolean; model: string | null };
  lsp: { available: boolean; stats?: { managerCount: number; totalOpenDocuments: number } };
  recentDegradations: Array<{ backend: DegradationBackend; code: string }>;
}

// ── Bounded degradation ring buffer (cap 20) ──────────────────────
const RECENT_CAP = 20;
const recent: DegradationRecord[] = [];

export function recordDegradation(code: string, backend: DegradationBackend): void {
  recent.push({ backend, code, ts: Date.now() });
  if (recent.length > RECENT_CAP) recent.shift();
}

export function recentDegradations(): DegradationRecord[] {
  return recent.slice();
}

export function resetRuntimeHealth(): void {
  recent.length = 0;
}

export async function getRuntimeHealth(
  cwd: string,
  getWatcherState: () => WatcherHealthState,
): Promise<RuntimeHealthReport> {
  const semanticIndex = getSemanticIndex(cwd);
  const indexStats = semanticIndex?.getStats();

  let embedding: RuntimeHealthReport["embedding"] = { enabled: false, model: null };
  try {
    const cfg = validateEmbeddingConfig(cwd);
    if (cfg?.model) embedding = { enabled: true, model: cfg.model };
  } catch {
    // Invalid numeric config — report disabled rather than throw.
    embedding = { enabled: false, model: null };
  }

  let lsp: RuntimeHealthReport["lsp"] = { available: false };
  try {
    const bridge = await getLSPBridge();
    if (bridge) {
      const stats = bridge.getStats();
      // Availability is derived from per-root connection stats, not the bridge
      // isAvailable() default-manager quirk (which always reports false).
      const available = Object.values(stats.connectionsByRoot).some((count) => count > 0);
      lsp = {
        available,
        stats: { managerCount: stats.managerCount, totalOpenDocuments: stats.totalOpenDocuments },
      };
    }
  } catch {
    lsp = { available: false };
  }

  let semanticState: SemanticIndexState = "not_initialized";
  if (semanticIndex) {
    if (indexStats?.updating) semanticState = "updating";
    else if (indexStats?.ready) semanticState = "fresh";
    else semanticState = "stale_or_unavailable";
  }

  return {
    graph: { generation: currentGraphGeneration() },
    watcher: getWatcherState(),
    semanticIndex: {
      available: semanticIndex?.isAvailable() ?? false,
      state: semanticState,
      stats: indexStats
        ? {
            ready: indexStats.ready,
            updating: indexStats.updating,
            dimension: indexStats.dimension,
            fileCount: indexStats.indexedFileCount,
            chunkCount: indexStats.chunkCount,
          }
        : undefined,
    },
    embedding,
    lsp,
    recentDegradations: recentDegradations().map((d) => ({ backend: d.backend, code: d.code })),
  };
}
