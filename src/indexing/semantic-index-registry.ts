import { resolve } from "node:path";
import { SemanticIndex, type SemanticIndexOptions } from "./semantic-index.js";
import { findProjectWorkspace } from "./workspace-scope.js";
import { canonicalPath, getAllowedRoot, isWithinRoot } from "./workspace-boundary.js";

const indexes = new Map<string, SemanticIndex>();

function registryRoot(path: string): string {
  const root = resolve(path);
  return canonicalPath(root) ?? root;
}

/** Clamp semantic indexing to project/allowed-root intersection. */
export function effectiveSemanticRoot(cwd: string, projectRoot = findProjectWorkspace(cwd) ?? cwd): string | null {
  const canonicalProject = registryRoot(projectRoot);
  const allowedRoot = getAllowedRoot(cwd);
  if (!allowedRoot) return canonicalProject;
  if (isWithinRoot(allowedRoot, canonicalProject)) return canonicalProject;
  if (isWithinRoot(canonicalProject, allowedRoot)) return registryRoot(allowedRoot);
  return null;
}

export function getOrCreateSemanticIndex(root: string, options?: SemanticIndexOptions): SemanticIndex {
  const key = registryRoot(root);
  let index = indexes.get(key);
  if (!index) {
    index = new SemanticIndex(key, options);
    indexes.set(key, index);
  }
  return index;
}

/** Resolve a path to its exact or nearest registered ancestor index. */
export function getSemanticIndex(path: string): SemanticIndex | null {
  const target = registryRoot(path);
  const exact = indexes.get(target);
  if (exact) return exact;

  let nearest: { root: string; index: SemanticIndex } | null = null;
  for (const [root, index] of indexes) {
    if (!isWithinRoot(root, target)) continue;
    if (!nearest || root.length > nearest.root.length) nearest = { root, index };
  }
  return nearest?.index ?? null;
}

/** Dispose live handles without deleting persistent cache files. */
export function disposeSemanticIndexes(root?: string): void {
  if (root) {
    const key = registryRoot(root);
    indexes.get(key)?.dispose();
    indexes.delete(key);
    return;
  }
  for (const index of indexes.values()) index.dispose();
  indexes.clear();
}

export function semanticIndexRegistrySize(): number {
  return indexes.size;
}
