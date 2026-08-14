/**
 * Runtime health aggregation for Pi-SmartRead.
 *
 * Deliberately minimal: no monitoring framework, no persistent metrics —
 * just truthful, additive status of the graph/watcher/semantic-index/
 * embedding/LSP subsystems plus a bounded ring buffer of recent retrieval
 * degradation codes. Never exposes raw error messages, URLs, keys, or PII.
 */
import { validateEmbeddingConfig } from "./config.js";
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
  /** Current workspace root identity (cwd). */
  root: string;
  graph: { generation: number; built: boolean };
  watcher: WatcherHealthState;
  semanticIndex: {
    available: boolean;
    state: SemanticIndexState;
    stats?: { ready: boolean; updating: boolean; dimension: number | null; fileCount: number; chunkCount: number; hasLastError?: boolean };
  };
  embedding: { enabled: boolean; model: string | null };
  lsp: { available: boolean; stats?: { managerCount: number; totalOpenDocuments: number } };
  recentDegradations: Array<{ backend: DegradationBackend; code: string }>;
}

export interface GraphHealthState {
  built: boolean;
  generation: number;
}

// ── Bounded degradation ring buffer (cap 20) ──────────────────────
const RECENT_CAP = 20;
const recent: DegradationRecord[] = [];

export function recordDegradation(code: string, backend: DegradationBackend): void {
  // A backend can be unavailable for an entire session (for example when the
  // optional semantic index is not installed). Do not turn every subsequent
  // search into an identical health-history entry; retain a new record when
  // the observed degradation changes or a different backend intervenes.
  const previous = recent[recent.length - 1];
  if (previous?.backend === backend && previous.code === code) {
    previous.ts = Date.now();
    return;
  }
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
  getGraphState?: (cwd: string) => GraphHealthState,
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
      // Scope LSP availability to the current cwd's root, not all roots.
      // A missing manager for this root means LSP is unavailable here. Do not
      // fall back to aggregate stats from another workspace.
      const stats = bridge.getStatsForRoot(cwd);
      if (!stats) {
        lsp = { available: false };
      } else {
        const available = Object.values(stats.connectionsByRoot).some((count) => count > 0);
        lsp = {
          available,
          stats: { managerCount: stats.managerCount, totalOpenDocuments: stats.totalOpenDocuments },
        };
      }
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

  const graph = getGraphState?.(cwd) ?? { built: false, generation: 0 };
  return {
    root: cwd,
    graph,
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
            ...(indexStats.lastError ? { hasLastError: true } : {}),
          }
        : undefined,
    },
    embedding,
    lsp,
    recentDegradations: recentDegradations().map((d) => ({ backend: d.backend, code: d.code })),
  };
}
