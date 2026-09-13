/**
 * Staged helpers for the ContextGraph build pipeline (P2.6).
 *
 * `ContextGraph.buildContextGraph()` in context-graph.ts owns the lifecycle
 * (parser/tag-cache init, force-refresh reset, call-graph trigger, fast-path
 * short-circuit, and the single build-result commit). The historical,
 * decision, indexing, telemetry, and edge stages below are pure with respect
 * to graph state: they take explicit inputs and return explicit results, so
 * the graph publishes symbol/file indices, import edges, and the file-count
 * watermark in exactly one commit point. No helper mutates graph fields.
 */

import { relative } from "node:path";
import { findSrcFiles } from "./file-discovery.js";
import type { Tag } from "./cache.js";
import { LruCache } from "./utils.js";
import { autoPopulateEdgeStore, extractCoCommitPairs, findGitRoot } from "./git-context.js";
import { loadGitContextConfig } from "./config.js";
import { getIncrementalIndex, type IndexChangeSet } from "./incremental-index.js";
import { writeCoverage } from "./index-coverage.js";
import { writeSnapshot, computeSourceHash } from "./index-snapshot.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface HistoricalPopulateHooks {
  loadMutationEdges: () => void;
  mutationEdgeCount: () => number;
}

export interface BuildInputs {
  allFiles: string[];
  incrementalChanges: IndexChangeSet | null;
  fileCountChanged: boolean;
  incrementalHasChanges: boolean;
  needsRebuild: boolean;
}

export interface BuiltIndices {
  symbolIndex: LruCache<Tag[]>;
  fileIndex: LruCache<Tag[]>;
}

export interface BuildResult extends BuiltIndices {
  importEdges: Array<{ from: string; to: string }>;
  fileCount: number;
}

// ── Stage 1: historical populate ──────────────────────────────────────

/**
 * Load persisted mutation edges, then opportunistically backfill them from
 * git co-commit history when the store is empty. Git population is bounded
 * by a 10s timeout and non-fatal: timeouts or failures leave the graph
 * without git edges rather than blocking the build.
 */
export async function populateHistoricalEdges(
  root: string,
  options: { skipGitPopulation?: boolean },
  hooks: HistoricalPopulateHooks,
): Promise<void> {
  hooks.loadMutationEdges();

  if (hooks.mutationEdgeCount() === 0 && !options.skipGitPopulation) {
    const GIT_POPULATION_TIMEOUT_MS = 10_000;
    const config = loadGitContextConfig(root);
    const limit = config.coCommitAnalysisLimit ?? 100;
    const gitPromise = findGitRoot(root).then(async (gitRoot) => {
      if (!gitRoot) return;
      const pairs = await extractCoCommitPairs(gitRoot, limit);
      await autoPopulateEdgeStore(gitRoot, pairs);
      hooks.loadMutationEdges();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        gitPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("git population timed out")), GIT_POPULATION_TIMEOUT_MS);
        }),
      ]).catch(() => {
        // Timeout or failure is non-fatal — graph proceeds without git edges
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// ── Stage 2: rebuild decision ─────────────────────────────────────────

/**
 * Discover the current source-file set and decide whether the symbol/file
 * indices need rebuilding. Rebuilds when ANY of the following are true:
 *   - No symbol index has ever been built (first build / force-refresh).
 *   - Incremental index reports added/modified/deleted files.
 *   - File count diverged from the previous build (safety net for
 *     filesystems that don't propagate child changes to ancestor mtimes).
 *
 * The caller owns incremental-index invalidation on fileCountChanged; it is
 * flagged here but applied by the lifecycle so all mutations stay in one
 * place.
 */
export async function collectBuildInputs(
  root: string,
  options: { incrementalIndex?: boolean },
  lastBuildFilesLength: number,
  hasSymbolIndex: boolean,
): Promise<BuildInputs> {
  // Always compute the current source-file set so the file-count safety
  // net below can detect divergence from the previous build (F-2 fix).
  const allFiles = await findSrcFiles(root);

  // When incremental indexing is enabled, query it for content-level changes.
  // The incremental index is the primary signal; the file-count delta below
  // is a secondary check that catches cases where the index missed something.
  let incrementalChanges: IndexChangeSet | null = null;
  if (options.incrementalIndex) {
    const idx = getIncrementalIndex(root);
    incrementalChanges = idx.getChanges();
  }

  // File-count safety net: if the source-file count diverges from the previous
  // build, the incremental index may have drifted. The caller forces a full
  // re-scan to guarantee the indices reflect the actual tree.
  const fileCountChanged =
    lastBuildFilesLength >= 0 && allFiles.length !== lastBuildFilesLength;

  const incrementalHasChanges =
    incrementalChanges !== null &&
    (incrementalChanges.added.length > 0 ||
      incrementalChanges.modified.length > 0 ||
      incrementalChanges.deleted.length > 0);

  const needsRebuild = !hasSymbolIndex || incrementalHasChanges || fileCountChanged;

  return { allFiles, incrementalChanges, fileCountChanged, incrementalHasChanges, needsRebuild };
}

/** Invalidate the incremental index after file-count drift (F-3 fix). */
export function invalidateIncrementalIndex(root: string): void {
  getIncrementalIndex(root).invalidate();
}

// ── Stage 3: index build ──────────────────────────────────────────────

/** Empty indices for workspaces with no source files. */
export function emptyIndices(): BuiltIndices {
  return { symbolIndex: new LruCache<Tag[]>(1), fileIndex: new LruCache<Tag[]>(1) };
}

/** Build symbol → tags and file → tags indices with memory caps. */
export function buildTagIndices(allTags: Tag[]): BuiltIndices {
  const symbolIndex = new LruCache<Tag[]>(20_000);
  const fileIndex = new LruCache<Tag[]>(5_000);
  for (const tag of allTags) {
    let list = symbolIndex.get(tag.name);
    if (!list) {
      list = [];
      symbolIndex.set(tag.name, list);
    }
    list.push(tag);

    let fileList = fileIndex.get(tag.fname);
    if (!fileList) {
      fileList = [];
      fileIndex.set(tag.fname, fileList);
    }
    fileList.push(tag);
  }
  return { symbolIndex, fileIndex };
}

// ── Stage 4: coverage + snapshot telemetry ────────────────────────────

/** Record per-file index coverage and the graph snapshot (side-effect only). */
export function recordBuildTelemetry(root: string, allFiles: string[], allTags: Tag[]): void {
  const taggedFiles = new Set(allTags.map((t) => t.fname));
  writeCoverage(
    root,
    allFiles.map((file) => ({
      file: relative(root, file),
      phase: "context-graph",
      status: taggedFiles.has(file) ? ("indexed" as const) : ("partial" as const),
      updatedAt: Date.now(),
    })),
  );

  writeSnapshot(
    root,
    "graph",
    { tagCount: allTags.length, fileCount: allFiles.length },
    {
      fileCount: allFiles.length,
      tagCount: allTags.length,
      sourceHash: computeSourceHash(allFiles),
    },
  );
}

// ── Stage 5: import edges ─────────────────────────────────────────────

/**
 * Build import adjacency from actual import relationships. Produces typed
 * IMPORT edges for buildImportEdges consumers (community detection, layer
 * analysis). Rebuilt only on a full rebuild; preserved across unchanged
 * fast-path builds by the caller.
 */
export function collectImportEdges(
  allFiles: string[],
  getImportNeighbours: (file: string) => string[],
): Array<{ from: string; to: string }> {
  const importEdges: Array<{ from: string; to: string }> = [];
  for (const file of allFiles) {
    const neighbours = getImportNeighbours(file);
    for (const n of neighbours) {
      importEdges.push({ from: file, to: n });
    }
  }
  return importEdges;
}
