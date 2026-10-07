/**
 * Structural search engine — ast-grep backed.
 * WP-SR2: engine only, no grep-tool wiring.
 */

import { statSync } from "node:fs";
import { canonicalPathOrFallback } from "../canonical-path.js";
import { resolve, relative, join } from "node:path";
import { readFile } from "node:fs/promises";

// ── Language mapping — duplicated from Pi-SmartEdit's astgrep-anchor.ts ──
// Separate npm packages must not cross-import; mapping duplicated for consistency.
const LANG_MAP: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
  python: "Python",
  json: "Json",
  css: "Css",
  html: "Html",
  markdown: "Markdown",
  yaml: "Yaml",
  sql: "Sql",
  rust: "Rust",
  go: "Go",
  java: "Java",
  ruby: "Ruby",
  php: "Php",
  c: "C",
  cpp: "Cpp",
  csharp: "CSharp",
  bash: "Bash",
  shell: "Bash",
  swift: "Swift",
  kotlin: "Kotlin",
};

export const SUPPORTED_STRUCTURAL_LANGUAGES = Object.keys(LANG_MAP) as string[];
export const STRUCTURAL_SEARCH_MAX_LIMIT = 1000;
export const STRUCTURAL_SEARCH_MAX_SKIP = 10_000_000; // raised from 1_000_000 — pagination must progress beyond 1M matches
export const STRUCTURAL_SEARCH_RAW_CEILING = 10_000_000; // hard cap on total raw matches considered — prevents skip-clamp repetition above ceiling

// Extension -> languageId (SmartEdit id) for inference when no explicit language given
const EXT_TO_LANG_ID: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".tsx": "tsx",
  ".py": "python",
  ".pyi": "python",
  ".pyx": "python",
  ".json": "json",
  ".jsonc": "json",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sql": "sql",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
};

// ── Types ───────────────────────────────────────────────────────────────

export interface StructuralSearchMatch {
  path: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

export interface StructuralSearchOptions {
  pattern: string;
  language?: string;
  skip?: number;
  limit?: number;
  groupByFile?: boolean;
  cwd?: string;
  /** file or directory to search in, relative to cwd */
  path?: string;
  glob?: string;
}

export interface StructuralSearchResult {
  status: "ok" | "unavailable";
  /** present when unavailable */
  reason?: string;
  matches: StructuralSearchMatch[];
  totalMatches: number;
  shownMatches: number;
  truncated: boolean;
  skip: number;
  groupByFile: boolean;
  groupedByFile?: Record<string, StructuralSearchMatch[]>;
}

export class StructuralSearchError extends Error {
  readonly code: "invalid_pattern" | "unsupported_language" | "invalid_params";
  constructor(message: string, code: StructuralSearchError["code"]) {
    super(message);
    this.name = "StructuralSearchError";
    this.code = code;
  }
}

// ── Module loading ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedMod: any | null | undefined = undefined;
let cachedErr: string | null = null;

function isValidAstGrepModule(mod: unknown): boolean {
  if (typeof mod !== "object" || mod === null) return false;
  if (!("parse" in mod)) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return typeof (mod as any).parse === "function";
}

async function loadAstGrepModule(): Promise<unknown> {
  // @ts-ignore — optional dep, types may be absent
  return await import("@ast-grep/napi");
}

function recordAstGrepFailure(err: unknown): null {
  cachedErr = err instanceof Error ? err.message : String(err);
  cachedMod = null;
  return null;
}

async function getAstGrep(): Promise<any | null> {
  if (cachedMod !== undefined) return cachedMod;
  if (cachedErr !== null) return null;
  try {
    const mod: unknown = await loadAstGrepModule();
    if (!isValidAstGrepModule(mod)) {
      throw new Error("@ast-grep/napi does not export parse()");
    }
    cachedMod = mod;
    return mod;
  } catch (err) {
    return recordAstGrepFailure(err);
  }
}

export function _resetAstGrepCacheForTests(): void {
  cachedMod = undefined;
  cachedErr = null;
}

export function _setUnavailableForTests(reason = "mocked unavailable"): void {
  cachedMod = null;
  cachedErr = reason;
}

export async function isStructuralSearchAvailable(): Promise<boolean> {
  const mod = await getAstGrep();
  return mod !== null;
}

export function getUnavailableReason(): string | null {
  return cachedErr;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function tryCanonical(p: string): string {
  return canonicalPathOrFallback(p);
}

export function resolveStructuralLang(languageId: string): string | null {
  return LANG_MAP[languageId.toLowerCase()] ?? null;
}

export function inferLanguageId(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return EXT_TO_LANG_ID[ext] ?? null;
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

// ── Main engine ─────────────────────────────────────────────────────────

// ── Param resolution ──────────────────────────────────────────────────

function validatedPattern(opts: StructuralSearchOptions): string {
  if (typeof opts.pattern !== "string" || opts.pattern.trim().length === 0) {
    throw new StructuralSearchError("pattern must be a non-empty string", "invalid_pattern");
  }
  return opts.pattern;
}

function resolvedSkip(opts: StructuralSearchOptions): number {
  if (opts.skip !== undefined && (!Number.isFinite(opts.skip) || opts.skip < 0)) {
    throw new StructuralSearchError("skip must be >= 0", "invalid_params");
  }
  return opts.skip !== undefined ? clampInt(opts.skip, 0, STRUCTURAL_SEARCH_MAX_SKIP) : 0;
}

function resolvedLimit(opts: StructuralSearchOptions): number {
  return opts.limit !== undefined ? clampInt(opts.limit, 1, STRUCTURAL_SEARCH_MAX_LIMIT) : 100;
}

function resolvedExplicitLang(opts: StructuralSearchOptions): string | null {
  if (opts.language === undefined) return null;
  if (typeof opts.language !== "string" || opts.language.trim().length === 0) {
    throw new StructuralSearchError("language must be a non-empty string", "unsupported_language");
  }
  const resolved = resolveStructuralLang(opts.language);
  if (!resolved) {
    throw new StructuralSearchError(`unsupported language: ${opts.language}`, "unsupported_language");
  }
  return resolved;
}

function searchContext(opts: StructuralSearchOptions): { cwd: string; searchTarget: string } {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  return { cwd, searchTarget: opts.path ? resolve(cwd, opts.path) : cwd };
}

export async function structuralSearch(opts: StructuralSearchOptions): Promise<StructuralSearchResult> {
  const pattern = validatedPattern(opts);
  const skip = resolvedSkip(opts);
  const groupByFile = Boolean(opts.groupByFile);
  const limit = resolvedLimit(opts);
  const explicitLangName = resolvedExplicitLang(opts);
  const { cwd, searchTarget } = searchContext(opts);

  // Validate uninferable exact-file language before availability: invalid
  // params must throw even when the optional engine is unavailable.
  assertFileTargetInferable(searchTarget, explicitLangName);

  // availability check — explicit unavailable status, never silent zero
  const mod = await getAstGrep();
  if (!mod) return unavailableResult(skip, groupByFile);

  // discover files before pattern validation so implicit language can be inferred per-file
  const files = await discoverFiles(searchTarget, cwd, opts);
  const { candidateFiles } = selectCandidateFiles(files, searchTarget, explicitLangName, opts.language);

  validatePatternSyntax(mod, pattern, explicitLangName, candidateFiles);

  const { matches: allMatches, rawCeilingHit } = await collectFileMatches(mod, candidateFiles, explicitLangName, pattern);
  sortMatchesInPlace(allMatches);
  return buildOkResult(allMatches, skip, limit, groupByFile, rawCeilingHit);
}

function assertFileTargetInferable(searchTarget: string, explicitLangName: string | null): void {
  if (explicitLangName) return;
  try {
    if (statSync(searchTarget).isFile() && !inferLanguageId(searchTarget)) {
      throw new StructuralSearchError(
        `cannot infer language for file: ${searchTarget} — pass language explicitly`,
        "unsupported_language",
      );
    }
  } catch (e) {
    if (e instanceof StructuralSearchError) throw e;
  }
}

function unavailableResult(skip: number, groupByFile: boolean): StructuralSearchResult {
  return {
    status: "unavailable",
    reason: cachedErr ?? "@ast-grep/napi not available",
    matches: [],
    totalMatches: 0,
    shownMatches: 0,
    truncated: false,
    skip,
    groupByFile,
  };
}

function isExactFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function extensionsForLanguageId(languageOpt: string): string[] {
  const explicitId = languageOpt.toLowerCase();
  return Object.entries(EXT_TO_LANG_ID)
    .filter(([, id]) => id === explicitId || (explicitId === "bash" && id === "shell") || (explicitId === "shell" && id === "bash"))
    .map(([ext]) => ext);
}

function filterByLanguageExtensions(candidateFiles: string[], languageOpt: string): string[] {
  const extsForLang = extensionsForLanguageId(languageOpt);
  if (extsForLang.length === 0) return candidateFiles;
  return candidateFiles.filter((f) => extsForLang.includes(f.slice(f.lastIndexOf(".")).toLowerCase()));
}

function applyExplicitLangFilter(
  files: string[],
  searchTarget: string,
  isExactFileTarget: boolean,
  languageOpt: string | undefined,
): string[] {
  if (!languageOpt) return files;
  const filtered = filterByLanguageExtensions(files, languageOpt);
  if (!isExactFileTarget) return filtered;
  // Explicit language overrides inference: retain exact file even with unknown/custom extension.
  const canonicalTarget = tryCanonical(searchTarget);
  return filtered.includes(canonicalTarget) ? filtered : files;
}

function selectCandidateFiles(
  files: string[],
  searchTarget: string,
  explicitLangName: string | null,
  languageOpt: string | undefined,
): { candidateFiles: string[]; isExactFileTarget: boolean } {
  // Detect exact-file target (discoverFiles preserves single file): used for language-override and uninferable-language contracts.
  const isExactFileTarget = isExactFile(searchTarget);
  // Spec: uninferable exact file without explicit language is invalid (not silent zero).
  if (isExactFileTarget && !explicitLangName) {
    const sole = files[0];
    if (sole && !inferLanguageId(sole)) {
      throw new StructuralSearchError(
        `cannot infer language for file: ${sole} — pass language explicitly`,
        "unsupported_language",
      );
    }
  }
  // if explicit language, we still search only files that could be that language? No — engine
  // parses every discovered file with that language. But we filter discovery to plausible extensions
  // when explicit language is given to avoid parsing unrelated files.
  const candidateFiles = explicitLangName
    ? applyExplicitLangFilter(files, searchTarget, isExactFileTarget, languageOpt)
    : files;
  return { candidateFiles, isExactFileTarget };
}

function probePatternSyntax(mod: any, langName: string, pattern: string): void {
  try {
    const langVal = mod.Lang?.[langName] ?? langName;
    const sgRoot = mod.parse(langVal, "");
    sgRoot.root().findAll(pattern);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new StructuralSearchError(`invalid pattern syntax: ${msg}`, "invalid_pattern");
  }
}

function distinctCandidateLangs(candidateFiles: string[]): Set<string> {
  const distinctLangs = new Set<string>();
  for (const f of candidateFiles) {
    const inferredId = inferLanguageId(f);
    if (!inferredId) continue;
    const langName = resolveStructuralLang(inferredId);
    if (langName) distinctLangs.add(langName);
  }
  return distinctLangs;
}

function validatePatternForInferredLangs(mod: any, pattern: string, candidateFiles: string[]): void {
  const distinctLangs = distinctCandidateLangs(candidateFiles);
  if (distinctLangs.size === 0) {
    // no inferrable candidates (empty dir or only unknown extensions): fall back to generic probe so universally invalid patterns like "$$$" still throw
    probePatternSyntax(mod, mod.Lang?.["TypeScript"] ?? "TypeScript", pattern);
    return;
  }
  let lastErr: unknown = null;
  for (const langName of distinctLangs) {
    try {
      const langVal = mod.Lang?.[langName] ?? langName;
      const sgRoot = mod.parse(langVal, "");
      sgRoot.root().findAll(pattern);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new StructuralSearchError(`invalid pattern syntax: ${msg}`, "invalid_pattern");
}

function validatePatternSyntax(mod: any, pattern: string, explicitLangName: string | null, candidateFiles: string[]): void {
  // validate pattern syntax upfront — language inferred per-file (or per-candidate-set), not hardcoded TypeScript
  if (explicitLangName) probePatternSyntax(mod, explicitLangName, pattern);
  else validatePatternForInferredLangs(mod, pattern, candidateFiles);
}

function langNameForFile(file: string, explicitLangName: string | null): string | null {
  if (explicitLangName) return explicitLangName;
  const inferredId = inferLanguageId(file);
  if (!inferredId) return null;
  return resolveStructuralLang(inferredId);
}

async function readSearchableContent(file: string): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(file, "utf-8");
  } catch {
    // skip unreadable file
    return null;
  }
  if (content.length === 0) return null;
  // size guard — skip huge files (2MB like index)
  if (Buffer.byteLength(content, "utf-8") > 2 * 1024 * 1024) return null;
  return content;
}

function rangeStartPoint(rng: any): { line: number; character: number } {
  return { line: (rng?.start?.line ?? 0) + 1, character: rng?.start?.column ?? 0 };
}

function rangeEndPoint(rng: any): { endLine: number; endCharacter: number } {
  return { endLine: (rng?.end?.line ?? 0) + 1, endCharacter: rng?.end?.column ?? 0 };
}

function nodeToMatch(file: string, node: any): StructuralSearchMatch {
  const rng = node.range?.();
  const text: string = node.text?.() ?? "";
  const start = rangeStartPoint(rng);
  const end = rangeEndPoint(rng);
  return {
    path: tryCanonical(file),
    line: start.line,
    character: start.character,
    endLine: end.endLine,
    endCharacter: end.endCharacter,
    text,
  };
}

/** Append node matches; returns true when the raw ceiling is hit. */
function appendNodeMatches(allMatches: StructuralSearchMatch[], file: string, nodes: any[]): boolean {
  for (const node of nodes) {
    allMatches.push(nodeToMatch(file, node));
    if (allMatches.length >= STRUCTURAL_SEARCH_RAW_CEILING) {
      allMatches.length = STRUCTURAL_SEARCH_RAW_CEILING;
      return true;
    }
  }
  return false;
}

function handleFileSearchError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  // If pattern syntax was already validated, per-file errors are likely parse errors — skip file
  // But if message mentions pattern, rethrow as invalid_pattern
  if (/pattern/i.test(msg) || /rule/i.test(msg)) {
    throw new StructuralSearchError(`invalid pattern syntax: ${msg}`, "invalid_pattern");
  }
}

async function searchSingleFile(
  mod: any,
  file: string,
  langName: string,
  pattern: string,
  allMatches: StructuralSearchMatch[],
): Promise<boolean> {
  const content = await readSearchableContent(file);
  if (content === null) return false;
  try {
    const langVal = mod.Lang?.[langName] ?? langName;
    const sgRoot = mod.parse(langVal, content);
    const root = sgRoot.root();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes: any[] = root.findAll(pattern) ?? [];
    return appendNodeMatches(allMatches, file, nodes);
  } catch (e) {
    handleFileSearchError(e);
    return false;
  }
}

async function collectFileMatches(
  mod: any,
  candidateFiles: string[],
  explicitLangName: string | null,
  pattern: string,
): Promise<{ matches: StructuralSearchMatch[]; rawCeilingHit: boolean }> {
  const allMatches: StructuralSearchMatch[] = [];
  for (const file of candidateFiles) {
    const langName = langNameForFile(file, explicitLangName);
    if (!langName) continue;
    const ceilingHit = await searchSingleFile(mod, file, langName, pattern, allMatches);
    if (ceilingHit) return { matches: allMatches, rawCeilingHit: true };
  }
  return { matches: allMatches, rawCeilingHit: false };
}

function sortMatchesInPlace(allMatches: StructuralSearchMatch[]): void {
  // stable sort by path then start location
  allMatches.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.character - b.character;
  });
}

function buildOkResult(
  allMatches: StructuralSearchMatch[],
  skip: number,
  limit: number,
  groupByFile: boolean,
  rawCeilingHit: boolean,
): StructuralSearchResult {
  const totalMatches = allMatches.length;
  const sliced = allMatches.slice(skip, skip + limit);
  const shownMatches = sliced.length;
  const truncated = rawCeilingHit ? true : skip + shownMatches < totalMatches;
  const result: StructuralSearchResult = {
    status: "ok",
    matches: sliced,
    totalMatches,
    shownMatches,
    truncated,
    skip,
    groupByFile,
  };
  if (groupByFile) {
    const grouped: Record<string, StructuralSearchMatch[]> = {};
    for (const m of sliced) {
      (grouped[m.path] ??= []).push(m);
    }
    result.groupedByFile = grouped;
  }
  return result;
}

function singleFileTarget(target: string): string[] | null {
  // if target is a file, return single file
  try {
    const st = statSync(target);
    if (st.isFile()) return [tryCanonical(target)];
  } catch {
    // fall through to directory discovery
  }
  return null;
}

async function filterFilesByGlob(files: string[], cwd: string, fileGlob: string): Promise<string[]> {
  const { minimatch } = await import("minimatch");
  return files.filter((f) => minimatch(relative(cwd, f).replace(/\\/g, "/"), fileGlob));
}

async function discoverViaHelper(target: string, cwd: string, fileGlob: string | undefined): Promise<string[] | null> {
  // Use file-discovery helper if available; fallback to manual walk
  try {
    const { findSearchableTextFiles } = await import("../file-discovery.js");
    const files = await findSearchableTextFiles(target, 5000);
    if (!fileGlob) return files;
    return await filterFilesByGlob(files, cwd, fileGlob);
  } catch {
    return null;
  }
}

function isSkippableEntry(name: string): boolean {
  return name === "node_modules" || name === ".git" || name.startsWith(".pi-smartread");
}

async function readDirEntries(fs: { readdir: Function }, dir: string): Promise<any[] | null> {
  try {
    return await (fs.readdir as Function)(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function walkInto(out: string[], dir: string, cwd: string, fileGlob: string | undefined, fs: { readdir: Function }): Promise<void> {
  const entries = await readDirEntries(fs, dir);
  if (!entries) return;
  for (const e of entries) {
    if (isSkippableEntry(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkInto(out, full, cwd, fileGlob, fs);
    else if (e.isFile()) await collectWalkFile(out, full, cwd, fileGlob);
    if (out.length >= 5000) return;
  }
}

async function collectWalkFile(out: string[], full: string, cwd: string, fileGlob: string | undefined): Promise<void> {
  if (out.length >= 5000) return;
  if (fileGlob) {
    const { minimatch } = await import("minimatch");
    if (!minimatch(relative(cwd, full).replace(/\\/g, "/"), fileGlob)) return;
  }
  out.push(full);
}

async function walkFallback(target: string, cwd: string, fileGlob: string | undefined): Promise<string[]> {
  // manual fallback: simple walk (file-discovery unavailable)
  const { promises: fs } = await import("node:fs");
  const out: string[] = [];
  await walkInto(out, target, cwd, fileGlob, fs);
  return out;
}

async function discoverFiles(target: string, cwd: string, opts: StructuralSearchOptions): Promise<string[]> {
  const single = singleFileTarget(target);
  if (single) return single;
  // respect glob if provided
  const fileGlob = opts.glob;
  const viaHelper = await discoverViaHelper(target, cwd, fileGlob);
  if (viaHelper) return viaHelper;
  return await walkFallback(target, cwd, fileGlob);
}
