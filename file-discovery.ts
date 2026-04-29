/**
 * File discovery — finds source files in a directory,
 * filtering by supported extensions for tree-sitter analysis,
 * and respecting .gitignore patterns.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
 * Returns rules from all .gitignore files found on the path to root.
 */
function loadGitignoreRules(
  dir: string,
  gitignoreCache: Map<string, GitignoreRule[]>,
): GitignoreRule[] {
  const cached = gitignoreCache.get(dir);
  if (cached !== undefined) return cached;

  const rules: GitignoreRule[] = [];

  // Collect .gitignore files from this directory upward
  const gitignorePath = join(dir, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, "utf-8");
      for (const line of content.split("\n")) {
        const rule = parseGitignoreLine(line);
        if (rule) rules.push(rule);
      }
    } catch {
      // Can't read .gitignore — skip
    }
  }

  // Cascade upward
  const parent = resolve(dir, "..");
  if (parent !== dir) {
    const parentRules = loadGitignoreRules(parent, gitignoreCache);
    rules.push(...parentRules);
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

export function findSrcFiles(rootDir: string, maxFiles = 10_000): string[] {
  const results: string[] = [];
  const gitignoreCache = new Map<string, GitignoreRule[]>();
  const resolvedRoot = resolve(rootDir);

  function walk(dir: string): void {
    if (results.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    // Load .gitignore rules for this directory
    const gitignoreRules = loadGitignoreRules(dir, gitignoreCache);

    for (const entry of entries) {
      if (results.length >= maxFiles) return;

      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      const relPath = relative(resolvedRoot, fullPath);
      const isDir = stat.isDirectory();

      if (isDir) {
        if (IGNORE_DIRS.has(entry) || entry.startsWith(".")) continue;
        if (gitignoreRules.length > 0 && isGitignored(relPath, true, gitignoreRules)) continue;
        walk(fullPath);
      } else if (stat.isFile() && isSupportedFile(fullPath)) {
        // Check gitignore
        if (gitignoreRules.length > 0 && isGitignored(relPath, false, gitignoreRules)) continue;
        results.push(fullPath);
      }
    }
  }

  walk(resolvedRoot);
  return results;
}

/**
 * Find only source files with names matching identifiers (used for focused scans).
 */
export function findFilesMatching(
  rootDir: string,
  identifiers: Set<string>,
  maxFiles = 500,
): string[] {
  const results: string[] = [];
  const supportedExts = getSupportedExtensions();
  const gitignoreCache = new Map<string, GitignoreRule[]>();

  function walk(dir: string): void {
    if (results.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    const gitignoreRules = loadGitignoreRules(dir, gitignoreCache);
    const relDir = relative(rootDir, dir) || ".";

    for (const entry of entries) {
      if (results.length >= maxFiles) return;

      const fullPath = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      const relPath = relative(rootDir, fullPath);
      const isDir = stat.isDirectory();

      if (isDir) {
        if (IGNORE_DIRS.has(entry) || entry.startsWith(".")) continue;
        if (gitignoreRules.length > 0 && isGitignored(relPath, true, gitignoreRules)) continue;
        walk(fullPath);
      } else if (stat.isFile()) {
        if (gitignoreRules.length > 0 && isGitignored(relPath, false, gitignoreRules)) continue;

        const extIdx = entry.lastIndexOf(".");
        if (extIdx === -1) continue;
        const ext = entry.slice(extIdx);
        if (!supportedExts.includes(ext)) continue;

        // Check if any path component matches an identifier
        const basename = entry.slice(0, extIdx);
        for (const ident of identifiers) {
          if (basename.includes(ident) || fullPath.includes(ident)) {
            results.push(fullPath);
            break;
          }
        }
      }
    }
  }

  walk(rootDir);
  return results;
}
