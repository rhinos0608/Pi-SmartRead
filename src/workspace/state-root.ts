/**
 * Canonical state root — one root for every on-disk SmartRead writer.
 *
 * Contract (design: SmartRead state-root fix):
 * - Inside git: the first directory up the tree containing `.git` (directory
 *   or file — submodules/worktrees) is the state root.
 * - Not inside git: the **outermost** ancestor (inclusive) with a project
 *   marker, excluding the home directory itself, any ancestor of it, and the
 *   filesystem root. If nothing qualifies, there is no state root and writers
 *   must persist nothing.
 *
 * Pure apart from read-only filesystem queries (`existsSync`/`statSync`/
 * `realpathSync`); never writes, never throws. Fail-closed: an unresolvable
 * target yields `null`.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalPathOrNull } from "../canonical-path.js";

/** The same 7 project markers `workspace-scope.ts` uses. */
const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

export interface StateRootOptions {
  /** Home-directory override (tests). Defaults to `os.homedir()`. */
  homeDir?: string;
}

/** True when `ancestor` is a strict directory ancestor of `target`. */
function isStrictAncestor(ancestor: string, target: string): boolean {
  const rel = path.relative(ancestor, target);
  if (rel === "" || path.isAbsolute(rel)) return false;
  // Inside the ancestor → no ".." prefix; outside → ".." or "../...".
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolve the canonical state root for `target`.
 *
 * `target` may be a directory or a file; it is canonicalized with `realpath`
 * first, so symlinked paths resolve to the real root. Returns the git top
 * level when inside git, the outermost qualifying project marker otherwise,
 * or `null` when no canonical state root applies (persist nothing).
 */
export function resolveStateRoot(target: string, opts?: StateRootOptions): string | null {
  const real = canonicalPathOrNull(target);
  if (real === null) return null;

  let start = real;
  try {
    if (statSync(real).isFile()) start = path.dirname(real);
  } catch {
    return null;
  }

  const homeRaw = opts?.homeDir ?? homedir();
  const home = canonicalPathOrNull(homeRaw) ?? homeRaw;
  const fsRoot = path.parse(real).root;

  const excludedFromMarker = (dir: string): boolean =>
    dir === fsRoot || dir === home || isStrictAncestor(dir, home);

  let markerRoot: string | null = null;
  let current = start;
  while (true) {
    // `.git` as directory (repo) or file (worktree/submodule) — git wins outright.
    if (existsSync(path.join(current, ".git"))) return current;
    if (!excludedFromMarker(current) && PROJECT_MARKERS.some((marker) => existsSync(path.join(current, marker)))) {
      // Bottom-up walk: each higher match overwrites, leaving the outermost root.
      markerRoot = current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return markerRoot;
}

/** True when `dir` IS the canonical state root for itself (writers fail closed otherwise). */
export function isStateRoot(dir: string): boolean {
  const real = canonicalPathOrNull(dir);
  if (real === null) return false;
  return resolveStateRoot(dir) === real;
}
