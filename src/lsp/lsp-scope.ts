/**
 * Workspace scope validation for LSP affordance surfaces.
 *
 * `scope` is a workspace-relative path naming a canonical file or directory
 * INSIDE the chosen workspace root. Validation is fail-closed (caller error
 * before any server request): missing, non-file/dir, realpath failure, or
 * workspace escape all throw. Scope filters result projections only — never
 * explicit dispatch paths.
 *
 * Shared by investigate (round-1) and strict findReferences (round-2) so
 * both surfaces validate and canonicalize identically.
 */
import { realpathSync, statSync } from "node:fs";
import { resolve as resolvePath, sep as pathSep } from "node:path";

export interface AffordanceScope {
  /** Canonical scope path (file or directory), or null when unscoped. */
  scopeAbs: string | null;
  /** True when the scope names a regular file (exact match only). */
  scopeIsFile: boolean;
}

export function isUnderDir(file: string, dir: string): boolean {
  if (file === dir) return true;
  return file.startsWith(dir.endsWith(pathSep) ? dir : dir + pathSep);
}

export function resolveInvestigateScope(scope: unknown, workspaceRoot: string, op = "investigate"): AffordanceScope {
  if (scope === undefined) return { scopeAbs: null, scopeIsFile: false };
  if (typeof scope !== "string" || scope.length === 0) {
    throw new Error(`${op}: "scope" must be a non-empty string`);
  }
  const canonicalRoot = realpathSync(resolvePath(workspaceRoot));
  const abs = resolvePath(canonicalRoot, scope);
  let canonical: string;
  try {
    canonical = realpathSync(abs);
    const rest = statSync(canonical);
    if (!rest.isFile() && !rest.isDirectory()) {
      throw new Error(`${op}: scope is not a file or directory: ${scope}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${op}: scope`)) throw err;
    throw new Error(`${op}: scope does not exist or is inaccessible: ${scope}`);
  }
  if (!isUnderDir(canonical, canonicalRoot)) {
    throw new Error(`${op}: scope escapes the workspace: ${scope}`);
  }
  return { scopeAbs: canonical, scopeIsFile: statSync(canonical).isFile() };
}
