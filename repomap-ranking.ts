/**
 * RepoMap ranking — PageRank computation, edge weighting, import-based in-degree.
 *
 * Responsibilities:
 * - PageRank computation (via pagerank.js)
 * - buildWeightedEdges for identifier-aware edge weighting
 * - getRankedTags: tree-sitter + PageRank ranking
 * - getImportRankedTags: import-based in-degree ranking
 * - buildImportGraph: import statement extraction and resolution
 * - parseTsconfigPaths: tsconfig path alias resolution
 * - TsAliasMap, ImportEdge, FALLBACK_DEFINITION_PATTERNS types
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import type { Tag } from "./cache.js";
import { filenameToLang } from "./languages.js";
import { pagerank, buildWeightedEdges } from "./pagerank.js";
import type { RankedTag } from "./repomap-pipeline.js";

// ── Re-export RankedTag for repomap-tool.ts consumers ────────────

export type { RankedTag };

// ── Types ────────────────────────────────────────────────────────

/** Directed edge between files (from → to = "from imports to") */
export interface ImportEdge {
  from: string;
  to: string;
}

/** Map of alias prefixes → target dirs, e.g. { "@/*": ["./src/*"] } */
export interface TsAliasMap {
  /** e.g. "@" → "./src" — the prefix without /* */
  prefixes: Map<string, string>;
}

// ── Constants ────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;

/**
 * Regex patterns for text-based definition matching (fallback when tree-sitter unavailable).
 */
export const FALLBACK_DEFINITION_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/i,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/i,
  /^\s*def\s+([A-Za-z_$][\w$]*)/i,
  /^\s*fn\s+([A-Za-z_$][\w$]*)/i,
  /^\s*module\s+([A-Za-z_$][\w$]*)/i,
];

// ── Token counting ─────────────────────────────────────────────

/**
 * Estimate tokens using chars/4 heuristic.
 * Used as fallback when model-aware counting is unavailable.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Model-aware token counting.
 * For texts > 200 chars, sample every ~1% of lines, compute sample token count,
 * and extrapolate to full text. Provides more accurate counts than chars/4.
 *
 * Matches Aider's behavior in repomap.py:
 * ```python
 * if len_text < 200:
 *     return self.main_model.token_count(text)
 * lines = text.splitlines(keepends=True)
 * step = num_lines // 100 or 1
 * lines = lines[::step]
 * sample_tokens = self.main_model.token_count(sample_text)
 * est_tokens = sample_tokens / len(sample_text) * len_text
 * ```
 *
 * @param text - The text to count tokens for
 * @param tokenCountFn - Optional model token count function (e.g., model.token_count)
 * @returns Estimated token count
 */
export function countTokens(
  text: string,
  tokenCountFn?: (t: string) => number,
): number {
  if (!text) return 0;

  if (!tokenCountFn) {
    return estimateTokens(text);
  }

  if (text.length < 200) {
    return tokenCountFn(text);
  }

  const lines = text.split("\n");
  const numLines = lines.length;
  const step = Math.max(1, Math.floor(numLines / 100));
  const sampledLines: string[] = [];
  for (let i = 0; i < numLines; i += step) {
    sampledLines.push(lines[i]!);
  }
  const sampleText = sampledLines.join("\n");

  if (sampleText.length === 0) return estimateTokens(text);

  const sampleTokens = tokenCountFn(sampleText);
  return Math.round((sampleTokens / sampleText.length) * text.length);
}

// ── TS path alias resolution ──────────────────────────────────────

/**
 * Parse tsconfig.json (or jsconfig.json) to extract compilerOptions.paths.
 * Returns a map of alias prefixes to directory targets.
 */
export async function parseTsconfigPaths(
  root: string,
): Promise<TsAliasMap | null> {
  const prefixes = new Map<string, string>();

  const configNames = ["tsconfig.json", "jsconfig.json"];
  for (const name of configNames) {
    const configPath = path.join(root, name);
    let raw: string;
    try {
      raw = await fs.readFile(configPath, "utf-8");
    } catch {
      continue;
    }

    try {
      const config = JSON.parse(raw);
      const paths = config?.compilerOptions?.paths;
      if (!paths || typeof paths !== "object") continue;

      for (const [alias, targets] of Object.entries(paths)) {
        const aliasMatch = alias.match(/^([^/*]+)(?:\/(?:\*|\*\*))?$/);
        if (!aliasMatch) continue;
        const prefix = aliasMatch[1]!;

        const targetArr = Array.isArray(targets) ? targets : [targets];
        for (const t of targetArr) {
          if (typeof t !== "string") continue;
          const dirMatch = t.match(/^\.(\/[^/*]+)(?:\/\*|\/\*\*)?$/);
          if (dirMatch) {
            const targetDir = "." + dirMatch[1];
            if (!prefixes.has(prefix)) {
              prefixes.set(prefix, targetDir);
            }
            break;
          }
        }
      }
    } catch {
      continue;
    }
  }

  if (prefixes.size === 0) return null;
  return { prefixes };
}

function resolveViaAlias(
  importPath: string,
  absRoot: string,
  aliases: TsAliasMap,
): string | null {
  for (const [prefix, targetDir] of aliases.prefixes) {
    if (!importPath.startsWith(prefix)) continue;
    const suffix = importPath.slice(prefix.length);
    if (!suffix.startsWith("/")) continue;
    return path.resolve(absRoot, targetDir + suffix);
  }
  return null;
}

function resolveImportPath(
  importPath: string,
  fromRelDir: string,
  absRoot: string,
  knownFiles: Set<string>,
  aliases?: TsAliasMap,
): string | null {
  const searchPaths: string[] = [];

  if (aliases && !importPath.startsWith(".") && !importPath.startsWith("/")) {
    const aliasResolved = resolveViaAlias(importPath, absRoot, aliases);
    if (aliasResolved) {
      searchPaths.push(aliasResolved);
    }
  }

  if (importPath.startsWith("/")) {
    searchPaths.push(path.resolve(absRoot, "." + importPath));
  } else if (importPath.startsWith(".")) {
    searchPaths.push(path.resolve(fromRelDir, importPath));
  } else {
    searchPaths.push(path.resolve(fromRelDir, importPath));
  }

  const extensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
  ];

  for (const absPath of searchPaths) {
    const rel = path.relative(absRoot, absPath);
    if (knownFiles.has(rel)) return rel;
    for (const ext of extensions) {
      const candidate = rel + ext;
      if (knownFiles.has(candidate)) return candidate;
    }
    for (const ext of extensions) {
      const candidate = path.join(rel, `index${ext}`);
      if (knownFiles.has(candidate)) return candidate;
    }
  }

  return null;
}

// ── Import extraction helpers ─────────────────────────────────────

const IMPORT_ESM =
  /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))?)\s+from\s+)?['"]([^'"]+)['"]/g;
const IMPORT_CJS =
  /(?:^|[^.\w])(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImports(fname: string, code: string): string[] {
  const lang = filenameToLang(fname);
  if (!lang) return [];

  const imports: string[] = [];
  const seen = new Set<string>();

  if (
    lang === "javascript" ||
    lang === "typescript" ||
    lang === "tsx"
  ) {
    for (const match of code.matchAll(IMPORT_ESM)) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
    for (const match of code.matchAll(IMPORT_CJS)) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
    const tsRef = /\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]/g;
    for (const match of code.matchAll(tsRef)) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
  } else if (lang === "go") {
    const goImportLine = /^import\s+"([^"]+)"/gm;
    for (const match of code.matchAll(goImportLine)) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
    const goImportBlock = /import\s*\(([^)]*)\)/g;
    for (const match of code.matchAll(goImportBlock)) {
      const block = match[1]!;
      const quoted = block.match(/"([^"]+)"/g);
      if (quoted) {
        for (const q of quoted) {
          const p = q.replace(/"/g, "");
          if (p && !seen.has(p)) {
            seen.add(p);
            imports.push(p);
          }
        }
      }
    }
  } else if (lang === "rust") {
    const rustUse = /^use\s+([a-zA-Z_][a-zA-Z0-9_:*]*);/gm;
    for (const match of code.matchAll(rustUse)) {
      let p = match[1]!;
      p = p.replace(/^(crate|self|super)::/, "");
      p = p.replace(/::\*$/, "");
      const parts = p.split("::");
      if (
        parts.length >= 1 &&
        parts[0] !== "std" &&
        parts[0] !== "core" &&
        parts[0] !== "alloc"
      ) {
        const modulePath = parts.join("/");
        if (modulePath && !seen.has(modulePath)) {
          seen.add(modulePath);
          imports.push(modulePath);
        }
      }
    }
    const rustExtern = /^extern\s+crate\s+([a-zA-Z_][a-zA-Z0-9_]*);/gm;
    for (const match of code.matchAll(rustExtern)) {
      const p = match[1];
      if (p && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
    const rustMod = /^mod\s+([a-zA-Z_][a-zA-Z0-9_]*);/gm;
    for (const match of code.matchAll(rustMod)) {
      const p = match[1];
      if (p && !seen.has(p) && p !== "tests") {
        seen.add(p);
        imports.push(p);
      }
    }
  } else if (lang === "python") {
    const fromRe = /^from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import/mg;
    for (const match of code.matchAll(fromRe)) {
      const p = match[1]!.replace(/\./g, "/");
      if (p && p !== "__future__" && !seen.has(p)) {
        seen.add(p);
        imports.push(p);
      }
    }
    const importRe =
      /^import\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*/mg;
    for (const match of code.matchAll(importRe)) {
      const parts = match[0].split(/\s*,\s*/);
      for (const part of parts) {
        const p = part
          .trim()
          .replace(/^import\s+/, "")
          .replace(/\./g, "/");
        if (p && !p.startsWith("__") && !seen.has(p)) {
          seen.add(p);
          imports.push(p);
        }
      }
    }
  }

  return imports;
}

/**
 * Build an import graph from source files.
 * Returns in-degree map and list of edges.
 */
export async function buildImportGraph(
  allFiles: string[],
  root: string,
  aliases?: TsAliasMap,
): Promise<{ inDegrees: Map<string, number>; edges: ImportEdge[] }> {
  const knownRelFiles = new Set(allFiles);
  const inDegrees = new Map<string, number>();
  const edges: ImportEdge[] = [];
  const processed = new Set<string>();

  const queue = [...allFiles];
  while (queue.length > 0) {
    const relFname = queue.shift()!;
    if (processed.has(relFname)) continue;
    processed.add(relFname);

    const absFname = path.resolve(root, relFname);
    let code: string;
    try {
      code = await fs.readFile(absFname, "utf-8");
    } catch {
      continue;
    }

    const importPaths = extractImports(absFname, code);

    for (const imp of importPaths) {
      const resolved = resolveImportPath(
        imp,
        path.dirname(absFname),
        root,
        knownRelFiles,
        aliases,
      );
      if (resolved && resolved !== relFname) {
        edges.push({ from: relFname, to: resolved });
        inDegrees.set(resolved, (inDegrees.get(resolved) ?? 0) + 1);

        if (!processed.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  }

  for (const relFname of allFiles) {
    if (!inDegrees.has(relFname)) {
      inDegrees.set(relFname, 0);
    }
  }

  return { inDegrees, edges };
}

// ── Ranking: tree-sitter + PageRank ─────────────────────────────

/**
 * Rank tags using PageRank with personalization and sophisticated edge weighting.
 *
 * Aider-compat features:
 *   - buildWeightedEdges: identifier-aware weighting (snake/camel/kebab/_
 *     prefix/generic names)
 *   - mentioned_idents → file path matching for personalization
 *   - Self-edges for defined-but-unreferenced identifiers
 *   - sqrt(num_refs) sub-linear scaling
 *   - Chat file boost (50x)
 */
export function getRankedTags(
  root: string,
  allTags: Tag[],
  allFiles: string[],
  focusFiles: string[],
  priorityFiles: Set<string>,
  priorityIdentifiers: Set<string>,
  mentionedIdents: string[],
  mentionedFnames: string[],
): RankedTag[] {
  const defines = new Map<string, Set<string>>();
  const references = new Map<string, string[]>();

  for (const tag of allTags) {
    if (tag.kind === "def") {
      let set = defines.get(tag.name);
      if (!set) {
        set = new Set();
        defines.set(tag.name, set);
      }
      set.add(tag.relFname);
    } else if (tag.kind === "ref") {
      let list = references.get(tag.name);
      if (!list) {
        list = [];
        references.set(tag.name, list);
      }
      list.push(tag.relFname);
    }
  }

  const nodes = new Set(allFiles.map((f) => path.relative(root, f)));
  const focusRelFiles = new Set(focusFiles.map((f) => path.relative(root, f)));
  const mentionedIdentsSet = new Set(mentionedIdents);

  const personalization = new Map<string, number>();
  const personalize = 100 / Math.max(1, nodes.size);

  // ── Personalization: focus files ──
  for (const relFname of focusRelFiles) {
    personalization.set(relFname, (personalization.get(relFname) ?? 0) + personalize);
  }

  // ── Personalization: mentioned_fnames path matching ──
  for (const mentionedFname of mentionedFnames) {
    const relPath = path.relative(
      root,
      path.resolve(root, mentionedFname),
    );
    if (nodes.has(relPath)) {
      personalization.set(relPath, (personalization.get(relPath) ?? 0) + personalize);
    }
  }

  // ── Personalization: mentioned_idents → file path matching ──
  for (const relFname of nodes) {
    const pathObj = relFname.split("/");
    const basename = pathObj[pathObj.length - 1] ?? "";
    const extIdx = basename.lastIndexOf(".");
    const basenameWithoutExt = extIdx >= 0 ? basename.slice(0, extIdx) : basename;
    const allComponents = new Set([
      ...pathObj,
      basename,
      basenameWithoutExt,
    ]);

    for (const ident of mentionedIdents) {
      if (allComponents.has(ident)) {
        const current = personalization.get(relFname) ?? 0;
        personalization.set(relFname, current + personalize);
        break;
      }
    }
  }

  // Also personalize toward files connected to focus files
  if (focusRelFiles.size > 0) {
    for (const [name, refFnames] of references) {
      const defFnames = defines.get(name);
      if (!defFnames) continue;

      for (const refFname of refFnames) {
        if (focusRelFiles.has(refFname)) {
          for (const defFname of defFnames) {
            if (!focusRelFiles.has(defFname)) {
              personalization.set(
                defFname,
                (personalization.get(defFname) ?? 0) + personalize * 0.1,
              );
            }
          }
        }
      }
    }
  }

  // ── Build weighted edges ──
  const edges = buildWeightedEdges(defines, references, {
    mentionedIdents: mentionedIdentsSet.size > 0 ? mentionedIdentsSet : undefined,
    chatRelFiles: focusRelFiles.size > 0 ? focusRelFiles : undefined,
  });

  // ── Run PageRank ──
  const ranks = pagerank(
    nodes,
    edges,
    personalization.size > 0 ? personalization : undefined,
  );

  // ── Score each definition tag ──
  const priorityRelFiles = new Set(
    Array.from(priorityFiles).map((f) => path.relative(root, f)),
  );

  const rankedTags: RankedTag[] = [];
  for (const tag of allTags) {
    if (tag.kind !== "def") continue;

    const fileRank = ranks.get(tag.relFname) ?? 0;
    let boost = 1.0;
    if (focusRelFiles.has(tag.relFname)) boost *= 20.0;
    if (priorityIdentifiers.has(tag.name)) boost *= 10.0;
    if (priorityRelFiles.has(tag.relFname)) boost *= 5.0;

    rankedTags.push({ rank: fileRank * boost, tag });
  }

  rankedTags.sort((a, b) => b.rank - a.rank);
  return rankedTags;
}

// ── Ranking: import-based in-degree ─────────────────────────────

/**
 * Rank files by import-based in-degree (how many files import them).
 */
export function getImportRankedTags(
  root: string,
  allFiles: string[],
  focusFiles: string[],
  priorityFiles: Set<string>,
  inDegrees: Map<string, number>,
): RankedTag[] {
  const focusRelFiles = new Set(
    focusFiles.map((f) => path.relative(root, f)),
  );
  const priorityRelFiles = new Set(
    Array.from(priorityFiles).map((f) => path.relative(root, f)),
  );

  let maxDegree = 1;
  for (const val of inDegrees.values()) {
    if (val > maxDegree) maxDegree = val;
  }

  const rankedTags: RankedTag[] = [];
  for (const relFname of allFiles) {
    const absFname = path.resolve(root, relFname);
    const inDegree = inDegrees.get(relFname) ?? 0;
    let rank = inDegree / maxDegree;
    if (focusRelFiles.has(relFname)) rank += 2.0;
    if (priorityRelFiles.has(relFname)) rank += 1.0;

    const syntheticTag: Tag = {
      relFname,
      fname: absFname,
      line: 1,
      name: path.basename(relFname, path.extname(relFname)),
      kind: "def",
    };

    rankedTags.push({ rank, tag: syntheticTag });
  }

  rankedTags.sort((a, b) => b.rank - a.rank);
  return rankedTags;
}