import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
] as const;

/** Return the nearest project root at or above a directory. */
export function findProjectWorkspace(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (
      existsSync(path.join(current, ".git")) ||
      PROJECT_MARKERS.some((marker) => existsSync(path.join(current, marker)))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function isProjectWorkspace(cwd: string): boolean {
  return findProjectWorkspace(cwd) !== null;
}

/** Scope enrichment to the file's project even when Pi was started above it. */
export function projectWorkspaceForFile(fullPath: string): string | null {
  return findProjectWorkspace(path.dirname(path.resolve(fullPath)));
}
