import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface MonorepoWorkspace {
  /** Workspace root directory (absolute) */
  root: string;
  /** Workspace type identifier */
  type: "yarn" | "pnpm" | "npm" | "lerna" | "nx" | "turborepo" | "rush" | "poetry";
  /** All package directories (absolute paths) */
  packages: string[];
}

const MONOREPO_MARKERS: Record<string, string[]> = {
  lerna: ["lerna.json"],
  nx: ["nx.json"],
  turborepo: ["turbo.json"],
  rush: ["rush.json"],
};

/**
 * Detect monorepo structure from a root directory.
 * Returns the workspace info or null if not a monorepo.
 */
export function detectMonorepo(rootDir: string): MonorepoWorkspace | null {
  const resolved = resolve(rootDir);
  const workspaces = resolveWorkspaceGlobs(resolved);
  if (workspaces.length === 0) return null;

  const packages = expandWorkspaceGlobs(resolved, workspaces);
  if (packages.length === 0) return null;

  const type = detectMonorepoType(resolved);
  return { root: resolved, type, packages };
}

/**
 * Check if a given directory is inside a monorepo workspace package.
 * Returns the workspace info if so, null otherwise.
 */
export function detectMonorepoFromSubdir(startDir: string): MonorepoWorkspace | null {
  let current = resolve(startDir);
  const home = require("os").homedir();
  while (true) {
    const mono = detectMonorepo(current);
    if (mono && mono.packages.length > 0) return mono;
    const parent = resolve(current, "..");
    if (parent === current || current === home) return null;
    current = parent;
  }
}

/**
 * Expand the working directory to cover all monorepo workspaces.
 * Returns [originalCwd, ...workspacePackageDirs] when monorepo is detected,
 * or just [originalCwd] otherwise.
 */
export function expandToMonorepoRoots(cwd: string): string[] {
  const mono = detectMonorepoFromSubdir(cwd);
  if (!mono) return [cwd];
  return [cwd, ...mono.packages];
}

// ── Internal helpers ────────────────────────────────────────────────

type WorkspaceGlob = string;

function detectMonorepoType(rootDir: string): MonorepoWorkspace["type"] {
  for (const [type, markers] of Object.entries(MONOREPO_MARKERS)) {
    for (const marker of markers) {
      if (existsSync(join(rootDir, marker))) return type as MonorepoWorkspace["type"];
    }
  }
  // Check pnpm-workspace.yaml
  if (existsSync(join(rootDir, "pnpm-workspace.yaml"))) return "pnpm";
  // Check pyproject.toml for poetry
  const pyprojectPath = join(rootDir, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, "utf-8");
      if (content.includes("[tool.poetry]") && content.includes("packages")) return "poetry";
    } catch { /* ignore */ }
  }
  // package.json with workspaces covers yarn, npm
  return "npm";
}

function resolveWorkspaceGlobs(rootDir: string): WorkspaceGlob[] {
  const pkgPath = join(rootDir, "package.json");
  if (!existsSync(pkgPath)) return [];

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const workspaces: string[] = pkg.workspaces ?? pkg.workspaces?.packages ?? [];

    // Lerna-style: lerna.json may have its own packages field
    const lernaPath = join(rootDir, "lerna.json");
    if (existsSync(lernaPath)) {
      try {
        const lerna = JSON.parse(readFileSync(lernaPath, "utf-8"));
        if (Array.isArray(lerna.packages)) {
          workspaces.push(...lerna.packages);
        }
      } catch { /* ignore */ }
    }

    // Pnpm workspace
    const pnpmPath = join(rootDir, "pnpm-workspace.yaml");
    if (existsSync(pnpmPath)) {
      try {
        const content = readFileSync(pnpmPath, "utf-8");
        const yamlLines = content.split("\n");
        let inPackages = false;
        for (const line of yamlLines) {
          const trimmed = line.trim();
          if (trimmed === "packages:") { inPackages = true; continue; }
          if (inPackages && trimmed.startsWith("- ")) {
            workspaces.push(trimmed.slice(2).trim());
          } else if (inPackages && !trimmed.startsWith("- ") && trimmed) {
            inPackages = false;
          }
        }
      } catch { /* ignore */ }
    }

    return [...new Set(workspaces)];
  } catch {
    return [];
  }
}

function expandWorkspaceGlobs(rootDir: string, globs: WorkspaceGlob[]): string[] {
  const packages: string[] = [];

  for (const glob of globs) {
    // Simple glob: "packages/*" → list directories under packages/
    // Also handles: "apps/*", "libs/*", etc.
    const parts = glob.split("/");
    const hasStar = parts.some((p) => p.includes("*"));
    if (!hasStar) {
      // Single directory like "packages/shared"
      const fullPath = join(rootDir, glob);
      if (existsSync(fullPath)) {
        packages.push(fullPath);
      }
      continue;
    }

    // Expand star patterns
    const starIndex = parts.findIndex((p) => p.includes("*"));
    if (starIndex === -1) continue;

    const baseDir = join(rootDir, ...parts.slice(0, starIndex));
    if (!existsSync(baseDir)) continue;

    const starPattern = parts[starIndex]!;
    const prefix = starPattern.replace("*", "");
    const suffix = starPattern.replace("*", "");

    try {
      const entries = require("fs").readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        // Apply prefix/suffix filtering (e.g., "plugin-*")
    if (prefix && !entry.name.startsWith(prefix)) continue;
    if (suffix && !entry.name.endsWith(suffix)) continue;
    if (entry.name) {
      packages.push(join(baseDir, entry.name));
    }
      }
    } catch { /* ignore */ }
  }

  return packages.filter((pkg) => {
    // Must have a package.json or be a recognizable project
    return existsSync(join(pkg, "package.json")) ||
           existsSync(join(pkg, "pyproject.toml")) ||
           existsSync(join(pkg, "Cargo.toml")) ||
           existsSync(join(pkg, "go.mod"));
  });
}
