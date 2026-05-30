/**
 * File discovery helpers for code-aware and grep-style search.
 *
 * The search tool needs two different discovery profiles:
 * - code: tree-sitter supported source files only
 * - text: all searchable text files, including configs/docs and extensionless text
 *
 * Both profiles respect repo-local ignore files and Pi-SmartRead's
 * .context-mode-ignore / .context-mode-include rules.
 */
import { promises as fs, existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import ignoreDefault, { type Ignore } from "ignore";
import { getSupportedExtensions, isSupportedFile } from "./languages.js";
import { getFsScanCache } from "./fs-scan-cache.js";
export { getFsScanCache, invalidateFsScanCache } from "./fs-scan-cache.js";

const createIgnore = ignoreDefault as unknown as (options?: {
  allowRelativePaths?: boolean;
}) => Ignore;

export type DiscoveryProfile = "code" | "text";

export interface FileDiscoveryDiagnostics {
  profile: DiscoveryProfile;
  root: string;
  directoriesVisited: number;
  filesConsidered: number;
  filesMatched: number;
  filesSkippedIgnored: number;
  filesSkippedBinary: number;
  filesSkippedUnsupported: number;
}

export interface FileDiscoveryResult {
  files: string[];
  diagnostics: FileDiscoveryDiagnostics;
}

interface IgnoreSource {
  baseDir: string;
  matcher: Ignore;
}

interface ContextState {
  standard: IgnoreSource[];
  contextIgnore: IgnoreSource[];
  contextInclude: IgnoreSource[];
}

const VCS_MARKERS = [".git", ".hg", ".svn", "_darcs"] as const;
const STANDARD_IGNORE_FILES = [".gitignore", ".ignore", ".rgignore"] as const;
const TEXT_SNIFF_BYTES = 8_192;

const HARD_DENY_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "_darcs",
  "node_modules",
  ".pnpm-store",
  ".pi",
  ".pi-smartread",
  ".yarn",
  ".pnp",
  ".pnp.js",
  ".smart-edit-undo",
  ".subagent-work",
  ".turbo",
  ".understand-anything",
  ".cache",
  ".next",
  ".nuxt",
  ".output",
  ".vercel",
  ".parcel-cache",
  ".svelte-kit",
  ".angular",
  "dist",
  "build",
  "coverage",
  ".nyc_output",
  "target",
  ".gradle",
  ".terraform",
  ".serverless",
  ".dart_tool",
  ".pub-cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  "vendor",
  "Pods",
  ".bundle",
  ".gem",
  ".build",
  ".pi-smartread.tags.cache",
  ".pi-smartread.embeddings.cache",
  "graphify-out",
]);

const SEARCHABLE_TEXT_EXTENSIONS = new Set([
  ...getSupportedExtensions(),
  ".adoc",
  ".conf",
  ".csv",
  ".env",
  ".gql",
  ".graphql",
  ".ini",
  ".json",
  ".jsonc",
  ".log",
  ".md",
  ".mdx",
  ".properties",
  ".rst",
  ".sql",
  ".toml",
  ".txt",
  ".yaml",
  ".yml",
]);

const SEARCHABLE_TEXT_BASENAMES = new Set([
  ".context-mode-ignore",
  ".context-mode-include",
  ".editorconfig",
  ".env",
  ".env.example",
  ".eslintrc",
  ".gitignore",
  ".ignore",
  ".npmrc",
  ".prettierrc",
  ".rgignore",
  ".tool-versions",
  ".nvmrc",
  ".node-version",
  "Dockerfile",
  "Gemfile",
  "Jenkinsfile",
  "Makefile",
  "Procfile",
  "README",
]);

function normalizeForMatch(path: string): string {
  return path.replace(/\\/g, "/");
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function filenameHasKnownTextHint(filePath: string): boolean {
  const name = basename(filePath);
  if (SEARCHABLE_TEXT_BASENAMES.has(name)) return true;

  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1) return false;
  return SEARCHABLE_TEXT_EXTENSIONS.has(name.slice(dotIndex).toLowerCase());
}

async function sniffTextFile(filePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(TEXT_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return true;

    let suspicious = 0;
    for (let i = 0; i < bytesRead; i++) {
      const byte = buffer[i]!;
      if (byte === 0) return false;
      if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
    }
    return suspicious / bytesRead < 0.1;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readIgnorePatterns(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split(/\r?\n/g)
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith("#");
      });
  } catch {
    return [];
  }
}

function createIgnoreSource(baseDir: string, patterns: string[]): IgnoreSource | null {
  if (patterns.length === 0) return null;
  return {
    baseDir,
    matcher: createIgnore({ allowRelativePaths: true }).add(patterns),
  };
}

function findVcsRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (VCS_MARKERS.some((marker) => existsSync(join(current, marker)))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

function getPathChain(ceiling: string, leaf: string): string[] {
  const dirs: string[] = [];
  let current = resolve(leaf);
  while (true) {
    dirs.push(current);
    if (current === ceiling) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

async function extendContext(
  parent: ContextState,
  dir: string,
  vcsRoot: string | null,
): Promise<ContextState> {
  const standard = [...parent.standard];
  const contextIgnore = [...parent.contextIgnore];
  const contextInclude = [...parent.contextInclude];

  if (vcsRoot && dir === vcsRoot) {
    const infoExclude = createIgnoreSource(
      dir,
      await readIgnorePatterns(join(dir, ".git", "info", "exclude")),
    );
    if (infoExclude) standard.push(infoExclude);
  }

  for (const filename of STANDARD_IGNORE_FILES) {
    const source = createIgnoreSource(
      dir,
      await readIgnorePatterns(join(dir, filename)),
    );
    if (source) standard.push(source);
  }

  const contextIgnoreSource = createIgnoreSource(
    dir,
    await readIgnorePatterns(join(dir, ".context-mode-ignore")),
  );
  if (contextIgnoreSource) contextIgnore.push(contextIgnoreSource);

  const contextIncludeSource = createIgnoreSource(
    dir,
    await readIgnorePatterns(join(dir, ".context-mode-include")),
  );
  if (contextIncludeSource) contextInclude.push(contextIncludeSource);

  return { standard, contextIgnore, contextInclude };
}

function testSources(
  sources: IgnoreSource[],
  targetPath: string,
): boolean | undefined {
  let state: boolean | undefined;
  for (const source of sources) {
    if (!isSubpath(source.baseDir, targetPath)) continue;
    const rel = normalizeForMatch(relative(source.baseDir, targetPath));
    if (!rel || rel.startsWith("../")) continue;
    const result = source.matcher.test(rel);
    if (result.ignored) state = true;
    if (result.unignored) state = false;
  }
  return state;
}

function shouldIncludePath(fullPath: string, context: ContextState): boolean {
  return testSources(context.contextInclude, fullPath) === true;
}

function isIgnored(fullPath: string, context: ContextState): boolean {
  if (shouldIncludePath(fullPath, context)) return false;
  if (testSources(context.contextIgnore, fullPath) === true) return true;
  return testSources(context.standard, fullPath) === true;
}

async function matchesProfile(filePath: string, profile: DiscoveryProfile): Promise<"match" | "binary" | "unsupported"> {
  if (profile === "code") {
    return isSupportedFile(filePath) ? "match" : "unsupported";
  }

  if (filenameHasKnownTextHint(filePath)) {
    return "match";
  }

  return (await sniffTextFile(filePath)) ? "match" : "binary";
}

export async function discoverFiles(
  rootDir: string,
  profile: DiscoveryProfile,
  maxFiles = 10_000,
  signal?: AbortSignal,
): Promise<FileDiscoveryResult> {
  const resolvedRoot = resolve(rootDir);
  const diagnostics: FileDiscoveryDiagnostics = {
    profile,
    root: resolvedRoot,
    directoriesVisited: 0,
    filesConsidered: 0,
    filesMatched: 0,
    filesSkippedIgnored: 0,
    filesSkippedBinary: 0,
    filesSkippedUnsupported: 0,
  };

  try {
    const stat = await fs.stat(resolvedRoot);
    if (!stat.isDirectory()) {
      return { files: [], diagnostics };
    }
  } catch {
    return { files: [], diagnostics };
  }

  const vcsRoot = findVcsRoot(resolvedRoot);
  let context: ContextState = { standard: [], contextIgnore: [], contextInclude: [] };
  const chain = vcsRoot && isSubpath(vcsRoot, resolvedRoot)
    ? getPathChain(vcsRoot, resolvedRoot)
    : [resolvedRoot];
  for (const dir of chain) {
    context = await extendContext(context, dir, vcsRoot);
  }

  const results: string[] = [];

  async function walk(dir: string, dirContext: ContextState): Promise<void> {
    if (signal?.aborted || results.length >= maxFiles) return;
    diagnostics.directoriesVisited++;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted || results.length >= maxFiles) return;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (HARD_DENY_DIRS.has(entry.name)) continue;
        const childContext = await extendContext(dirContext, fullPath, vcsRoot);
        await walk(fullPath, childContext);
        continue;
      }

      if (!entry.isFile()) continue;

      diagnostics.filesConsidered++;
      if (isIgnored(fullPath, dirContext)) {
        diagnostics.filesSkippedIgnored++;
        continue;
      }

      const matchState = await matchesProfile(fullPath, profile);
      if (matchState === "match") {
        results.push(fullPath);
        diagnostics.filesMatched++;
      } else if (matchState === "binary") {
        diagnostics.filesSkippedBinary++;
      } else {
        diagnostics.filesSkippedUnsupported++;
      }
    }
  }

  await walk(resolvedRoot, context);
  return { files: results, diagnostics };
}

async function getCachedDiscoveryFiles(
  rootDir: string,
  profile: DiscoveryProfile,
  maxFiles = 10_000,
  signal?: AbortSignal,
): Promise<string[]> {
  const cache = getFsScanCache();
  const { entries } = await cache.getOrScan(
    resolve(rootDir),
    async () => (await discoverFiles(rootDir, profile, maxFiles, signal)).files,
    undefined,
    profile,
    maxFiles,
  );

  return entries.length > maxFiles ? entries.slice(0, maxFiles) : entries;
}

export async function findCodeFiles(
  rootDir: string,
  maxFiles = 10_000,
  signal?: AbortSignal,
): Promise<string[]> {
  return getCachedDiscoveryFiles(rootDir, "code", maxFiles, signal);
}

export async function findSearchableTextFiles(
  rootDir: string,
  maxFiles = 10_000,
  signal?: AbortSignal,
): Promise<string[]> {
  return getCachedDiscoveryFiles(rootDir, "text", maxFiles, signal);
}

/**
 * Backward-compatible alias used throughout the codebase for AST-capable files.
 */
export async function findSrcFiles(
  rootDir: string,
  maxFiles = 10_000,
  signal?: AbortSignal,
): Promise<string[]> {
  return findCodeFiles(rootDir, maxFiles, signal);
}

/**
 * Context-mode behavior is now merged into the default discovery path.
 */
export async function findSrcFilesWithContextMode(
  rootDir: string,
  maxFiles = 10_000,
  signal?: AbortSignal,
): Promise<string[]> {
  return findCodeFiles(rootDir, maxFiles, signal);
}

/**
 * Find only source files with names matching identifiers (used for focused scans).
 */
export async function findFilesMatching(
  rootDir: string,
  identifiers: Set<string>,
  maxFiles = 500,
): Promise<string[]> {
  const files = await findCodeFiles(rootDir, 10_000);
  const supportedExts = new Set(getSupportedExtensions());

  return files.filter((fullPath) => {
    if (!supportedExts.has(fullPath.slice(fullPath.lastIndexOf(".")))) return false;

    const name = basename(fullPath);
    const extIdx = name.lastIndexOf(".");
    if (extIdx === -1) return false;
    const stem = name.slice(0, extIdx);

    for (const ident of identifiers) {
      if (stem.includes(ident) || normalizeForMatch(fullPath).includes(ident)) {
        return true;
      }
    }
    return false;
  }).slice(0, maxFiles);
}
