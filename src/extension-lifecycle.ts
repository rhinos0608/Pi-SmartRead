/**
 * Extension lifecycle — shared activation state, watcher, shutdown.
 *
 * Owns the ordered bootstrap prerequisites: shared state creation,
 * synchronous evidence-resolver bind, file-watcher start (with
 * revision-based invalidation order), and session_shutdown cleanup.
 * All best-effort catches and the watcher invalidation order match the
 * original src/index.ts activation path.
 */
import { resetContextHygieneTracker } from "./runtime/context-hygiene.js";
import { createDoomLoopState } from "./runtime/doom-loop.js";
import { resolveBashContextGuardConfig } from "./runtime/bash-context-guard.js";
import { loadExperimentalConfig, resolveBashMisuseHintsEnabled } from "./config.js";
import { invalidateFsScanCache } from "./workspace/fs-scan-cache.js";
import { startWatching } from "./runtime/file-watcher.js";
import type { ContextGraph } from "./context-graph.js";
import {
  getSharedEvidenceResolver,
  getSharedContextGraphAsync,
  invalidateSharedGraph,
  resetSharedContextGraph,
} from "./mcp-registry.js";
import { getSemanticIndex } from "./indexing/semantic-index-registry.js";
import { getIncrementalIndex } from "./indexing/incremental-index.js";
import { resetLSPBridge, shutdownAllManagers } from "./lsp/lsp-bridge.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface ActivationState {
  hygieneTracker: ReturnType<typeof resetContextHygieneTracker>;
  doomLoopState: ReturnType<typeof createDoomLoopState>;
  bashContextGuardConfig: ReturnType<typeof resolveBashContextGuardConfig>;
  bashMisuseHintsEnabled: boolean;
  watchState: { stop: (() => void) | undefined };
  freshGraphGetter: (root?: string) => Promise<ContextGraph>;
  languageIntelligenceDispose: (() => void) | null;
  /** Set true once the runtime grep tool is registered; read at event time. */
  grepRegisteredRef: { current: boolean };
}

export function createActivationState(): ActivationState {
  return {
    hygieneTracker: resetContextHygieneTracker(),
    doomLoopState: createDoomLoopState(),
    bashContextGuardConfig: resolveBashContextGuardConfig(),
    bashMisuseHintsEnabled: resolveBashMisuseHintsEnabled(loadExperimentalConfig()),
    watchState: { stop: undefined },
    // WP-5: single lazy ContextGraph getter so a graph-dependent call never
    // receives an unbuilt graph. Invalidation is revision-based inside
    // mcp-registry rather than a boolean flag; concurrent calls coalesce.
    freshGraphGetter: async (root = process.cwd()) => getSharedContextGraphAsync(root),
    languageIntelligenceDispose: null,
    grepRegisteredRef: { current: false },
  };
}

/** Bind the live evidence resolver synchronously when a bus is present. Best-effort. */
export function bindEvidenceResolverSync(pi: {
  events?: unknown;
}): void {
  const events = pi.events as
    | { emit: (c: string, d: unknown) => void; on: (c: string, h: (d: unknown) => void) => () => void }
    | undefined;
  if (events && typeof events.on === "function") {
    try {
      getSharedEvidenceResolver(events);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Start the file watcher. Invalidation order is authoritative:
 * fs-scan cache → semantic index → incremental index → shared graph.
 */
export function startFileWatcher(state: ActivationState): void {
  try {
    state.watchState.stop = startWatching(process.cwd(), (dirtyPaths) => {
      for (const p of dirtyPaths) {
        invalidateFsScanCache(p);
      }
      // WP-5: invalidate semantic index file states for affected paths
      try {
        const semIdx = getSemanticIndex(process.cwd());
        if (semIdx && typeof semIdx.markFilesStale === "function") {
          semIdx.markFilesStale(dirtyPaths);
        }
      } catch {
        /* semantic index may not exist */
      }
      // WP-5: invalidate incremental index cache entries
      try {
        const incIdx = getIncrementalIndex(process.cwd());
        incIdx.invalidate();
      } catch {
        /* incremental index may not exist */
      }
      // WP-5: the workspace changed — the shared graph is stale until rebuilt.
      invalidateSharedGraph();
    });
  } catch (err) {
    console.warn(`[SmartRead] File watcher failed to start: ${(err as Error).message}`);
  }
}

/** Language servers are long-lived; stop them on session_shutdown. */
export function registerShutdownHandler(
  pi: ExtensionAPI,
  state: ActivationState,
): void {
  pi.on("session_shutdown", async () => {
    try {
      state.languageIntelligenceDispose?.();
    } catch {
      /* ignore */
    }
    state.languageIntelligenceDispose = null;
    state.watchState.stop?.();
    state.watchState.stop = undefined;
    try {
      resetSharedContextGraph();
    } catch {
      /* may not be loaded */
    }
    await shutdownAllManagers();
    resetLSPBridge();
  });
}
