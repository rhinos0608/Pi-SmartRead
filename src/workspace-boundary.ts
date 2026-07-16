import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const ALLOWED_ROOT_ENV = "PI_SMARTREAD_ALLOWED_ROOT";
export const CBM_ALLOWED_ROOT_ENV = "CBM_ALLOWED_ROOT";

export interface WorkspaceBoundaryOptions {
  mustExist?: boolean;
  kind?: "file" | "directory" | "path";
  env?: NodeJS.ProcessEnv;
}

export function canonicalPath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  }
}

export function isWithinRoot(root: string, target: string): boolean {
  const canonicalRoot = canonicalPath(root) ?? resolve(root);
  const canonicalTarget = canonicalPath(target) ?? resolve(target);
  const rel = relative(canonicalRoot, canonicalTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function getAllowedRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[ALLOWED_ROOT_ENV]?.trim() || env[CBM_ALLOWED_ROOT_ENV]?.trim();
  if (!raw) return null;

  const candidate = resolve(cwd, raw);
  const canonical = canonicalPath(candidate);
  if (!canonical) {
    throw new Error(`Allowed root does not exist or is not readable: ${candidate}`);
  }
  return canonical;
}

export function resolveWorkspacePath(
  cwd: string,
  requestedPath: string,
  options: WorkspaceBoundaryOptions = {},
): string {
  if (!requestedPath || !requestedPath.trim()) {
    throw new Error("Path must not be empty");
  }

  const resolved = resolve(cwd, requestedPath);
  const mustExist = options.mustExist ?? true;
  const canonical = canonicalPath(resolved);

  if (mustExist && !canonical) {
    throw new Error(`Path does not exist or is not readable: ${requestedPath}`);
  }

  const target = canonical ?? resolved;

  if (canonical && options.kind && options.kind !== "path") {
    const stat = statSync(canonical);
    if (options.kind === "file" && !stat.isFile()) {
      throw new Error(`Path is not a regular file: ${requestedPath}`);
    }
    if (options.kind === "directory" && !stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${requestedPath}`);
    }
  }

  return target;
}

export function resolveWorkspaceFile(cwd: string, requestedPath: string): string {
  return resolveWorkspacePath(cwd, requestedPath, { kind: "file", mustExist: true });
}

export function resolveWorkspaceDirectory(cwd: string, requestedPath?: string): string {
  const raw = requestedPath?.trim() ? requestedPath.trim() : ".";
  return resolveWorkspacePath(cwd, raw, { kind: "directory", mustExist: true });
}
