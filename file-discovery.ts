/**
 * File discovery — finds source files in a directory,
 * filtering by supported extensions for tree-sitter analysis,
 * and respecting .gitignore patterns.
 */
import { promises as fs, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isSupportedFile, getSupportedExtensions } from "./languages.js";

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "target",
  "build",
  "dist",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  "__pycache__",
  ".pycache",
  "venv",
  ".venv",
  "env",
  ".env",
  "vendor",
  "bower_components",
  ".bundle",
  ".gem",
  ".tox",
  "coverage",
  ".nyc_output",
  ".serverless",
  ".terraform",
  ".pytest_cache",
  ".mypy_cache",
  ".dart_tool",
  ".pub-cache",
  ".gradle",
  "Pods",
  ".build",
  "bin",
  "obj",
  "out",
  ".yarn",
  ".pnp",
  ".pnp.js",
  ".turbo",
  ".vercel",
]);

// ── Gitignore parsing ─────────────────────────────────────────────

interface GitignoreRule {
  /** The raw pattern text (e.g. "*.log") */
  pattern: string;
  /** Whether the pattern is negated (!pattern) */
  negated: boolean;
  /** Whether the pattern is anchored to root (/pattern) */
  anchored: boolean;
  /** Whether the pattern only applies to directories (trailing /) */
  dirOnly: boolean;
  /** Compiled regex for matching relative paths */
  regex: RegExp;
}

/**
 * Escape special regex characters except for gitignore wildcards.
 * * → [^/]*
 * ** → .*
 * ? → [^/]
 */
function gitignoreGlobToRegex(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") {
      // **/ — matches zero or more directory levels
      result += "(?:.+/)?";
      i += 3;
    } else if (ch === "*" && pattern[i + 1] === "*" && i + 2 === pattern.length) {
      // Trailing ** — matches everything
      result += ".*";
      i += 2;
    } else if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] !== undefined) {
      // ** in middle — currently just match .* but this isn't perfect
      result += ".*";
      i += 2;
    } else if (ch === "*") {
      // Single * — matches anything except /
      result += "[^/]*";
      i += 1;
    } else if (ch === "?") {
      result += "[^/]";
      i += 1;
    } else if (ch === "." || ch === "+" || ch === "^" || ch === "$" || ch === "{" || ch === "}" || ch === "(" || ch === ")" || ch === "|" || ch === "[" || ch === "]" || ch === "\\") {
      result += "\\" + ch;
      i += 1;
    } else {
      result += ch;
      i += 1;
    }
  }

  return result;
}

function parseGitignoreLine(line: string): GitignoreRule | null {
  const trimmed = line.trim();

  // Empty lines and comments
  if (!trimmed || trimmed.startsWith("#")) return null;

  let pattern = trimmed;
  let negated = false;

  // Negation
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }

  // Strip leading slash for anchored detection
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }

  // Trailing slash — dir only
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  // If not anchored and doesn't contain a slash, it matches at any depth
  const regexSource = anchored
    ? `^${gitignoreGlobToRegex(pattern)}$`
    : pattern.includes("/")
      ? `^${gitignoreGlobToRegex(pattern)}$`
      : `(?:^|/)${gitignoreGlobToRegex(pattern)}$`;

  try {
    return {
      pattern: trimmed,
      negated,
      anchored,
      dirOnly,
      regex: new RegExp(regexSource),
    };
  } catch {
    return null;
  }
}

/**
 * Load .gitignore rules from a directory, cascading upward.
 * Parent rules are loaded first (prepended) so child rules take precedence
 * (last-match-wins semantics). Stops at the repository root (.git directory).
 */
async function loadGitignoreRules(
  dir: string,
  gitignoreCache: Map<string, GitignoreRule[]>,
): Promise<GitignoreRule[]> {
  const cached = gitignoreCache.get(dir);
  if (cached !== undefined) return cached;

  // Collect parent rules first (bottom-up: grandparent → parent → current)
  let parentRules: GitignoreRule[] = [];
  const parent = resolve(dir, "..");
  if (parent !== dir) {
    // Stop at repository root
    if (existsSync(join(parent, ".git"))) {
      parentRules = [];
    } else {
      parentRules = await loadGitignoreRules(parent, gitignoreCache);
    }
  }

  const rules: GitignoreRule[] = [...parentRules];

  // Collect .gitignore rules from this directory
  const gitignorePath = join(dir, ".gitignore");
  try {
    const stat = await fs.stat(gitignorePath);
    if (stat.isFile()) {
      const content = await fs.readFile(gitignorePath, "utf-8");
      for (const line of content.split("\n")) {
        const rule = parseGitignoreLine(line);
        if (rule) rules.push(rule);
      }
    }
  } catch {
    // Can't read .gitignore or doesn't exist — skip
  }

  gitignoreCache.set(dir, rules);
  return rules;
}

function isGitignored(
  relPath: string,
  isDir: boolean,
  rules: GitignoreRule[],
): boolean {
  // Normalize to forward slashes so regexes work cross-platform
  const normalized = relPath.replace(/\\/g, "/");
  let ignored = false;

  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;

    const matches = rule.regex.test(normalized);
    if (matches) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

// ── Public API ────────────────────────────────────────────────────

export async function findSrcFiles(
  rootDir: string,
  maxFiles = 10_000,
  signal?: AbortSignal,
): Promise<string[]> {
  const results: string[] = [];
  const gitignoreCache = new Map<string, GitignoreRule[]>();
  const resolvedRoot = resolve(rootDir);

  async function walk(dir: string): Promise<void> {
    if (signal?.aborted || results.length >= maxFiles) return;

    let dirHandle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      dirHandle = await fs.opendir(dir);
    } catch {
      return;
    }

    // Load .gitignore rules for this directory
    const gitignoreRules = await loadGitignoreRules(dir, gitignoreCache);

    try {
      for await (const entry of dirHandle) {
        if (signal?.aborted || results.length >= maxFiles) return;

        const fullPath = join(dir, entry.name);
        const relPath = relative(resolvedRoot, fullPath);
        const isDir = entry.isDirectory();

        if (isDir) {
          if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          if (gitignoreRules.length > 0 && isGitignored(relPath, true, gitignoreRules)) continue;
          await walk(fullPath);
        } else if (entry.isFile() && isSupportedFile(fullPath)) {
          // Check gitignore
          if (gitignoreRules.length > 0 && isGitignored(relPath, false, gitignoreRules)) continue;
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore errors during iteration
    } finally {
      // dirHandle is closed automatically by for-await loop
    }
  }

  await walk(resolvedRoot);
  return results;
}

// ── Context-mode ignore/include support (port of graphify's .graphifyignore / .graphifyinclude) ──

interface ContextModeRule {
  pattern: string;
  negated: boolean;
  anchored: boolean;
  regex: RegExp;
}

const VCS_MARKERS = [".git", ".hg", ".svn", "_darcs"] as const;

/** Walk upward from start; return the first directory containing a VCS marker. */
function findVcsRoot(start: string): string | null {
  let current = resolve(start);
  const osModule = require("os");
  const home = osModule.homedir();
  while (true) {
    if (VCS_MARKERS.some((m) => existsSync(join(current, m)))) return current;
    const parent = resolve(current, "..");
    if (parent === current || current === home) return null;
    current = parent;
  }
}

/** Parse a single line from a .context-mode-ignore file (gitignore-like). */
function parseContextModeLine(line: string): ContextModeRule | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  let pattern = trimmed;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  if (pattern.endsWith("/")) {
    pattern = pattern.slice(0, -1);
  }

  // Convert glob to regex (~gitignore semantics)
  const escaped = pattern
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");

  const regexSource = anchored
    ? `^${escaped}$`
    : pattern.includes("/")
      ? `^${escaped}$`
      : `(?:^|/)${escaped}$`;

  try {
    return { pattern: trimmed, negated, anchored, regex: new RegExp(regexSource) };
  } catch {
    return null;
  }
}

/** Load patterns from .context-mode-ignore/.context-mode-include files upward to VCS root. */
function loadContextModeRules(rootDir: string, type: "ignore" | "include"): ContextModeRule[] {
  const filename = type === "ignore" ? ".context-mode-ignore" : ".context-mode-include";
  const root = resolve(rootDir);
  const ceiling = findVcsRoot(root) ?? root;

  // Collect dirs from ceiling down to root
  const dirs: string[] = [];
  let current = root;
  while (true) {
    dirs.push(current);
    if (current === ceiling) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  dirs.reverse(); // ceiling first, root last for last-match-wins

  const rules: ContextModeRule[] = [];
  const seen = new Set<string>();
  const fsMod = require("fs");

  for (const d of dirs) {
    const filePath = join(d, filename);
    if (!existsSync(filePath)) continue;
    try {
      const raw = fsMod.readFileSync(filePath, "utf-8");
      for (const line of raw.split("\n")) {
        const rule = parseContextModeLine(line);
        if (rule && !seen.has(rule.pattern)) {
          seen.add(rule.pattern);
          rules.push(rule);
        }
      }
    } catch {
      // skip unreadable
    }
  }
  return rules;
}

/** Check if a relative path matches any rule using last-match-wins semantics. */
function isMatchedByRules(relPath: string, rules: ContextModeRule[]): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  let matched = false;
  for (const rule of rules) {
    if (rule.regex.test(normalized)) {
      matched = !rule.negated;
    }
  }
  return matched;
}

/**
 * File discovery augmented with .context-mode-ignore and .context-mode-include support.
 * - Ignore rules work like .gitignore: paths matching the final pattern are excluded.
 * - Include rules opt hidden files/dirs back into the scan.
 * These files are looked up from scan root to VCS root (ceiling at .git).
 */
export async function findSrcFilesWithContextMode(
  rootDir: string,
  maxFiles = 10_000,
  signal?: AbortSignal,
): Promise<string[]> {
  const ignoreRules = loadContextModeRules(rootDir, "ignore");
  const includeRules = loadContextModeRules(rootDir, "include");
  const resolvedRoot = resolve(rootDir);

  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (signal?.aborted || results.length >= maxFiles) return;

    let dirHandle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      dirHandle = await fs.opendir(dir);
    } catch {
      return;
    }

    try {
      for await (const entry of dirHandle) {
        if (signal?.aborted || results.length >= maxFiles) return;

        const fullPath = join(dir, entry.name);
        const relPath = relative(resolvedRoot, fullPath);
        const isDir = entry.isDirectory();

        // Check context-mode ignore rules first
        if (ignoreRules.length > 0 && isMatchedByRules(relPath, ignoreRules)) {
          continue;
        }

        if (isDir) {
          const isHidden = entry.name.startsWith(".");
          if (isHidden) {
            // Check include rules for hidden dirs
            if (!isMatchedByRules(relPath, includeRules)) {
              // Could a child path match an include pattern?
              const couldContain = includeRules.some((r) =>
                r.pattern.startsWith(relPath + "/"),
              );
              if (!couldContain) continue;
            }
          }
          if (IGNORE_DIRS.has(entry.name)) continue;
          await walk(fullPath);
        } else if (entry.isFile() && isSupportedFile(fullPath)) {
          // Hidden files need include rule
          if (entry.name.startsWith(".") && !isMatchedByRules(relPath, includeRules)) {
            continue;
          }
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore errors during iteration
    }
  }

  await walk(resolvedRoot);
  return results;
}

/**
 * Find only source files with names matching identifiers (used for focused scans).
 */
export async function findFilesMatching(
  rootDir: string,
  identifiers: Set<string>,
  maxFiles = 500,
): Promise<string[]> {
  const results: string[] = [];
  const supportedExts = getSupportedExtensions();
  const gitignoreCache = new Map<string, GitignoreRule[]>();
  const resolvedRoot = resolve(rootDir);

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxFiles) return;

    let dirHandle: Awaited<ReturnType<typeof fs.opendir>>;
    try {
      dirHandle = await fs.opendir(dir);
    } catch {
      return;
    }

    const gitignoreRules = await loadGitignoreRules(dir, gitignoreCache);

    try {
      for await (const entry of dirHandle) {
        if (results.length >= maxFiles) return;

        const fullPath = join(dir, entry.name);
        const relPath = relative(resolvedRoot, fullPath);
        const isDir = entry.isDirectory();

        if (isDir) {
          if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          if (gitignoreRules.length > 0 && isGitignored(relPath, true, gitignoreRules)) continue;
          await walk(fullPath);
        } else if (entry.isFile()) {
          if (gitignoreRules.length > 0 && isGitignored(relPath, false, gitignoreRules)) continue;

          const extIdx = entry.name.lastIndexOf(".");
          if (extIdx === -1) continue;
          const ext = entry.name.slice(extIdx);
          if (!supportedExts.includes(ext)) continue;

          // Check if any path component matches an identifier
          const basename = entry.name.slice(0, extIdx);
          for (const ident of identifiers) {
            if (basename.includes(ident) || fullPath.includes(ident)) {
              results.push(fullPath);
              break;
            }
          }
        }
      }
    } catch {
      // Ignore errors during iteration
    }
  }

  await walk(resolvedRoot);
  return results;

}