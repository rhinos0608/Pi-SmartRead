import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

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

const PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
] as const;

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
  while (true) {
    const mono = detectMonorepo(current);
    if (mono && mono.packages.length > 0) return mono;
    const parent = resolve(current, "..");
    if (parent === current) return null;
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
  return [...new Set([cwd, ...mono.packages])];
}

// ── Internal helpers ────────────────────────────────────────────────

type WorkspaceGlob = string;

function detectMonorepoType(rootDir: string): MonorepoWorkspace["type"] {
  for (const [type, markers] of Object.entries(MONOREPO_MARKERS)) {
    for (const marker of markers) {
      if (existsSync(join(rootDir, marker))) return type as MonorepoWorkspace["type"];
    }
  }
  if (existsSync(join(rootDir, "pnpm-workspace.yaml"))) return "pnpm";

  const pyprojectPath = join(rootDir, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, "utf-8");
      if (content.includes("[tool.poetry]") && content.includes("packages")) return "poetry";
    } catch {
      // ignore malformed pyproject files
    }
  }

  return "npm";
}

function resolveWorkspaceGlobs(rootDir: string): WorkspaceGlob[] {
  const workspaces: string[] = [];
  const pkgPath = join(rootDir, "package.json");

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      if (Array.isArray(pkg.workspaces)) {
        workspaces.push(...pkg.workspaces);
      } else if (Array.isArray(pkg.workspaces?.packages)) {
        workspaces.push(...pkg.workspaces.packages);
      }
    } catch {
      // ignore malformed package.json
    }
  }

  const lernaPath = join(rootDir, "lerna.json");
  if (existsSync(lernaPath)) {
    try {
      const lerna = JSON.parse(readFileSync(lernaPath, "utf-8")) as { packages?: string[] };
      if (Array.isArray(lerna.packages)) {
        workspaces.push(...lerna.packages);
      }
    } catch {
      // ignore malformed lerna config
    }
  }

  const pnpmPath = join(rootDir, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    try {
      const content = readFileSync(pnpmPath, "utf-8");
      let inPackages = false;
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (line === "packages:") {
          inPackages = true;
          continue;
        }
        if (!inPackages) continue;
        if (line.startsWith("- ")) {
          workspaces.push(line.slice(2).trim().replace(/^['"]|['"]$/g, ""));
          continue;
        }
        if (line.length > 0) {
          inPackages = false;
        }
      }
    } catch {
      // ignore malformed pnpm-workspace.yaml
    }
  }

  return [...new Set(workspaces.filter((pattern) => typeof pattern === "string" && pattern.trim().length > 0))];
}

function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globSegmentToRegex(segment: string): RegExp {
  return new RegExp(`^${escapeRegex(segment).replace(/\*/g, ".*")}$`);
}

function expandPatternSegments(baseDir: string, segments: string[], index: number): string[] {
  if (index >= segments.length) return [baseDir];

  const segment = segments[index]!;
  if (!segment.includes("*")) {
    const nextDir = join(baseDir, segment);
    if (!existsSync(nextDir)) return [];
    return expandPatternSegments(nextDir, segments, index + 1);
  }

  const matcher = globSegmentToRegex(segment);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!matcher.test(entry.name)) continue;
    matches.push(...expandPatternSegments(join(baseDir, entry.name), segments, index + 1));
  }
  return matches;
}

function resolveWorkspacePackageRoot(rootDir: string, candidate: string): string | null {
  let current = resolve(candidate);
  while (isSubpath(rootDir, current)) {
    if (hasProjectMarker(current)) return current;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && rel !== "");
}

// ── Service Boundary Detection ─────────────────────────────────

export interface ServiceBoundary {
  name: string;
  rootPath: string;
  dependencies: string[];
}

export interface BoundaryResult {
  services: ServiceBoundary[];
  source: string;
}

/**
 * Detect service boundaries from monorepo configuration files.
 * Parses package.json workspaces, docker-compose.yml, nx.json, turbo.json.
 */
export function detectServiceBoundaries(rootDir: string): BoundaryResult {
  const resolved = resolve(rootDir);
  const services = new Map<string, ServiceBoundary>();
  const sources = new Set<string>();

  // 1. Parse package.json workspaces
  const pkgPath = join(resolved, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        workspaces?: string[] | { packages?: string[] };
        dependencies?: Record<string, string>;
      };

      let globs: string[] = [];
      if (Array.isArray(pkg.workspaces)) globs = pkg.workspaces;
      else if (Array.isArray(pkg.workspaces?.packages)) globs = pkg.workspaces.packages;

      if (globs.length > 0) {
        sources.add("package.json");
        const expanded = expandWorkspaceGlobs(resolved, globs);
        for (const pkgRoot of expanded) {
          const rp = join(pkgRoot, "package.json");
          if (existsSync(rp)) {
            try {
              const innerPkg = JSON.parse(readFileSync(rp, "utf-8")) as {
                name?: string;
                dependencies?: Record<string, string>;
              };
              const name = innerPkg.name ?? basename(pkgRoot);
              const deps = Object.keys(innerPkg.dependencies ?? {});
              services.set(name, {
                name,
                rootPath: relative(resolved, pkgRoot).replace(/\\/g, "/") || ".",
                dependencies: deps,
              });
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Parse docker-compose.yml — always merge when present
  const dcPath = join(resolved, "docker-compose.yml");
  const dcPathAlt = join(resolved, "docker-compose.yaml");
  const dcFile = existsSync(dcPath) ? dcPath : existsSync(dcPathAlt) ? dcPathAlt : null;
  if (dcFile) {
    try {
      const content = readFileSync(dcFile, "utf-8");
      const lines = content.split("\n");
      let inServices = false;
      let foundServiceBlock = false;
      let indentDetected = false;
      let svcIndent = "  ";

      for (const line of lines) {
        const trimmed = line.trim();
        // Top-level key: non-empty line with no leading whitespace
        if (line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
          if (inServices) break; // next top-level key — stop
          if (/^services\s*:/.test(trimmed)) {
            inServices = true;
            foundServiceBlock = true;
          }
          continue;
        }
        if (!inServices) continue;
        // Detect indentation from first indented line beneath services:
        if (!indentDetected && trimmed.length > 0) {
          const indentMatch = line.match(/^(\s+)\S/);
          if (indentMatch) {
            svcIndent = indentMatch[1]!;
            indentDetected = true;
          }
        }
        // Service name key at detected indentation; accept quoted or unquoted keys with inline value
        // Verify exact indent: strip svcIndent prefix, ensure next char is not whitespace
        if (!line.startsWith(svcIndent)) continue;
        const afterIndent = line.slice(svcIndent.length);
        if (afterIndent.length === 0 || afterIndent[0] === ' ' || afterIndent[0] === '\t') continue;
        const keyMatch = afterIndent.match(/^(['"\u0060]?)([\w][\w.-]*)\1\s*:/);
        if (keyMatch) {
          const name = keyMatch[2]!;
          if (name && !services.has(name)) {
            services.set(name, { name, rootPath: ".", dependencies: [] });
          }
        }
      }

      if (foundServiceBlock) {
        sources.add("docker-compose");
      }
    } catch {
      // ignore
    }
  }

  // 3. Parse nx.json / turbo.json for project names
  for (const [configFile, sourceLabel] of [["nx.json", "nx"], ["turbo.json", "turbo.json"]] as const) {
    const configPath = join(resolved, configFile);
    if (!existsSync(configPath)) continue;
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      // nx.json: projects are defined in workspace config
      // turbo.json: pipeline keys are task names, not project names
      if (configFile === "nx.json" && config.projects) {
        sources.add(sourceLabel);
        const projects: Record<string, string | { root?: string }> = config.projects;
        for (const [name, val] of Object.entries(projects)) {
          if (!services.has(name)) {
            const root = typeof val === "string" ? val : (val?.root ?? ".");
            services.set(name, { name, rootPath: root, dependencies: [] });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 4. Cross-reference dependencies: find which workspace names match dependency keys
  const serviceNames = new Set(services.keys());
  for (const [, svc] of services) {
    svc.dependencies = svc.dependencies.filter((d) => serviceNames.has(d));
  }

  return {
    services: [...services.values()],
    source: [...sources].join("+") || "none",
  };
}

function expandWorkspaceGlobs(rootDir: string, globs: WorkspaceGlob[]): string[] {
  const packages = new Set<string>();

  for (const glob of globs) {
    const normalized = glob.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized) continue;

    const segments = normalized.split("/").filter(Boolean);
    const candidates = segments.some((segment) => segment.includes("*"))
      ? expandPatternSegments(rootDir, segments, 0)
      : [join(rootDir, ...segments)];

    for (const candidate of candidates) {
      const packageRoot = resolveWorkspacePackageRoot(rootDir, candidate);
      if (packageRoot) packages.add(packageRoot);
    }
  }

  return [...packages];
}
