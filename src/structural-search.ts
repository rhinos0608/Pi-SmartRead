/**
 * Structural search engine — ast-grep backed.
 * WP-SR2: engine only, no grep-tool wiring.
 */

import { realpathSync, statSync } from "node:fs";
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

async function getAstGrep(): Promise<any | null> {
  if (cachedMod !== undefined) return cachedMod;
  if (cachedErr !== null) return null;
  try {
    // @ts-ignore — optional dep, types may be absent
    const mod: unknown = await import("@ast-grep/napi");
    if (typeof mod !== "object" || mod === null || !("parse" in mod) || typeof (mod as any).parse !== "function") {
      throw new Error("@ast-grep/napi does not export parse()");
    }
    cachedMod = mod;
    return mod;
  } catch (err) {
    cachedErr = err instanceof Error ? err.message : String(err);
    cachedMod = null;
    return null;
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
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
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

export async function structuralSearch(opts: StructuralSearchOptions): Promise<StructuralSearchResult> {
  // validate pattern
  if (typeof opts.pattern !== "string" || opts.pattern.trim().length === 0) {
    throw new StructuralSearchError("pattern must be a non-empty string", "invalid_pattern");
  }
  const pattern = opts.pattern;

  const skip = opts.skip !== undefined ? clampInt(opts.skip, 0, STRUCTURAL_SEARCH_MAX_SKIP) : 0;
  if (opts.skip !== undefined && (!Number.isFinite(opts.skip) || opts.skip < 0)) {
    throw new StructuralSearchError("skip must be >= 0", "invalid_params");
  }
  const groupByFile = Boolean(opts.groupByFile);
  const limit = opts.limit !== undefined ? clampInt(opts.limit, 1, STRUCTURAL_SEARCH_MAX_LIMIT) : 100;

  let explicitLangName: string | null = null;
  if (opts.language !== undefined) {
    if (typeof opts.language !== "string" || opts.language.trim().length === 0) {
      throw new StructuralSearchError("language must be a non-empty string", "unsupported_language");
    }
    const resolved = resolveStructuralLang(opts.language);
    if (!resolved) {
      throw new StructuralSearchError(`unsupported language: ${opts.language}`, "unsupported_language");
    }
    explicitLangName = resolved;
  }

  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const searchTarget = opts.path ? resolve(cwd, opts.path) : cwd;

  // Validate uninferable exact-file language before availability: invalid
  // params must throw even when the optional engine is unavailable.
  if (!explicitLangName) {
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

  // availability check — explicit unavailable status, never silent zero
  const mod = await getAstGrep();
  if (!mod) {
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

  // discover files before pattern validation so implicit language can be inferred per-file
  const files = await discoverFiles(searchTarget, cwd, opts);

  // if explicit language, we still search only files that could be that language? No — engine
  // parses every discovered file with that language. But we filter discovery to plausible extensions
  // when explicit language is given to avoid parsing unrelated files.
  let candidateFiles = files;
  // Detect exact-file target (discoverFiles preserves single file): used for language-override and uninferable-language contracts.
  let isExactFileTarget = false;
  try {
    isExactFileTarget = statSync(searchTarget).isFile();
  } catch {
    isExactFileTarget = false;
  }
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
  if (explicitLangName) {
    // Keep files whose inferred language equals explicit id OR keep all if inference unknown?
    // Simpler: keep all candidate files; parsing with explicit lang will still run.
    // But filter by known extensions for that language to reduce work.
    const explicitId = opts.language!.toLowerCase();
    const extsForLang = Object.entries(EXT_TO_LANG_ID)
      .filter(([, id]) => id === explicitId || (explicitId === "bash" && id === "shell") || (explicitId === "shell" && id === "bash"))
      .map(([ext]) => ext);
    if (extsForLang.length > 0) {
      const filtered = candidateFiles.filter((f) => extsForLang.includes(f.slice(f.lastIndexOf(".")).toLowerCase()));
      if (isExactFileTarget) {
        // Explicit language overrides inference: retain exact file even with unknown/custom extension.
        const canonicalTarget = tryCanonical(searchTarget);
        const hasTarget = filtered.includes(canonicalTarget);
        candidateFiles = hasTarget ? filtered : files;
      } else {
        candidateFiles = filtered;
      }
    }
  }

  // validate pattern syntax upfront — language inferred per-file (or per-candidate-set), not hardcoded TypeScript
  if (explicitLangName) {
    try {
      const langVal = mod.Lang?.[explicitLangName] ?? explicitLangName;
      const sgRoot = mod.parse(langVal, "");
      sgRoot.root().findAll(pattern);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new StructuralSearchError(`invalid pattern syntax: ${msg}`, "invalid_pattern");
    }
  } else {
    const distinctLangs = new Set<string>();
    for (const f of candidateFiles) {
      const inferredId = inferLanguageId(f);
      if (!inferredId) continue;
      const langName = resolveStructuralLang(inferredId);
      if (langName) distinctLangs.add(langName);
    }
    if (distinctLangs.size > 0) {
      let lastErr: unknown = null;
      let ok = false;
      for (const langName of distinctLangs) {
        try {
          const langVal = mod.Lang?.[langName] ?? langName;
          const sgRoot = mod.parse(langVal, "");
          sgRoot.root().findAll(pattern);
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!ok) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        throw new StructuralSearchError(`invalid pattern syntax: ${msg}`, "invalid_pattern");
      }
    } else {
      // no inferrable candidates (empty dir or only unknown extensions): fall back to generic probe so universally invalid patterns like "$$$" still throw
      try {
        const probe = mod.Lang?.["TypeScript"] ?? "TypeScript";
        const langVal = mod.Lang?.[probe] ?? probe;
        const sgRoot = mod.parse(langVal, "");
        sgRoot.root().findAll(pattern);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new StructuralSearchError(`invalid pattern syntax: ${msg}`, "invalid_pattern");
      }
    }
  }

  const allMatches: StructuralSearchMatch[] = [];
  let rawCeilingHit = false;

  for (const file of candidateFiles) {
    let langName: string | null = explicitLangName;
    if (!langName) {
      const inferredId = inferLanguageId(file);
      if (!inferredId) continue;
      langName = resolveStructuralLang(inferredId);
      if (!langName) continue;
    }

    let content: string;
    try {
      content = await readFile(file, "utf-8");
    } catch {
    // skip unreadable file
    continue;
  }
    if (content.length === 0) continue;
    // size guard — skip huge files (2MB like index)
    if (Buffer.byteLength(content, "utf-8") > 2 * 1024 * 1024) continue;

    try {
      const langVal = mod.Lang?.[langName] ?? langName;
      const sgRoot = mod.parse(langVal, content);
      const root = sgRoot.root();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodes: any[] = root.findAll(pattern) ?? [];
      for (const node of nodes) {
        const rng = node.range?.();
        const text: string = node.text?.() ?? "";
        const sLine: number = (rng?.start?.line ?? 0) + 1;
        const sCol: number = rng?.start?.column ?? 0;
        const eLine: number = (rng?.end?.line ?? 0) + 1;
        const eCol: number = rng?.end?.column ?? 0;
        allMatches.push({
          path: tryCanonical(file),
          line: sLine,
          character: sCol,
          endLine: eLine,
          endCharacter: eCol,
          text,
        });
        if (allMatches.length >= STRUCTURAL_SEARCH_RAW_CEILING) {
          allMatches.length = STRUCTURAL_SEARCH_RAW_CEILING;
          rawCeilingHit = true;
          break;
        }
      }
      if (rawCeilingHit) break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If pattern syntax was already validated, per-file errors are likely parse errors — skip file
      // But if message mentions pattern, rethrow as invalid_pattern
      if (/pattern/i.test(msg) || /rule/i.test(msg)) {
        throw new StructuralSearchError(`invalid pattern syntax: ${msg}`, "invalid_pattern");
      }
      continue;
    }
  }

  // stable sort by path then start location
  allMatches.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.character - b.character;
  });

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

async function discoverFiles(target: string, cwd: string, opts: StructuralSearchOptions): Promise<string[]> {
  // if target is a file, return single file
  try {
    const st = statSync(target);
    if (st.isFile()) return [tryCanonical(target)];
  } catch {
    // fall through to directory discovery
  }

  // respect glob if provided
  const fileGlob = opts.glob;

  // Use file-discovery helper if available; fallback to manual walk
  try {
    const { findSearchableTextFiles } = await import("./file-discovery.js");
    const files = await findSearchableTextFiles(target, 5000);
    if (!fileGlob) return files;
    const { minimatch } = await import("minimatch");
    return files.filter((f) => minimatch(relative(cwd, f).replace(/\\/g, "/"), fileGlob));
  } catch {
    // manual fallback: simple walk (file-discovery unavailable)
    const { promises: fs } = await import("node:fs");
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".pi-smartread")) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          if (out.length >= 5000) return;
          if (fileGlob) {
            const { minimatch } = await import("minimatch");
            if (!minimatch(relative(cwd, full).replace(/\\/g, "/"), fileGlob)) continue;
          }
          out.push(full);
        }
      }
    }
    await walk(target);
    return out;
  }
}
