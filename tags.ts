/**
 * Tree-sitter tag extraction for repo mapping.
 * Uses native tree-sitter parsers to extract definitions and references
 * via language-specific .scm query files.
 *
 * Implements Pygments-style reference backfill:
 * When tree-sitter produces only def tags (no ref tags), fall back to
 * extracting identifier-like tokens from source text as references.
 * This is critical for C++, Rust, and many languages where .scm files
 * define only definitions. Matches Aider's behavior in repomap.py.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import Parser, { Query } from "tree-sitter";
import type { Tag } from "./cache.js";
import {
  filenameToLang,
  type SupportedLanguage,
  QUERY_NAME_ALIASES,
} from "./languages.js";
import { TagsCache } from "./cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const TypeScriptGrammar = require("tree-sitter-typescript");
const JavaScriptGrammar = require("tree-sitter-javascript");

const QUERIES_DIR = path.resolve(__dirname, "queries");
const LANGUAGE_PACK_DIR = path.join(QUERIES_DIR, "tree-sitter-language-pack");
const LANGUAGES_DIR = path.join(QUERIES_DIR, "tree-sitter-languages");

type Grammar = Parameters<Parser["setLanguage"]>[0];

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Grammar>();
const queryCache = new Map<string, Query>();
const PARSE_CHUNK_SIZE = 1024;

/**
 * Initialize the parser runtime.
 * Native tree-sitter does not need async setup, but the hook keeps the
 * existing API stable.
 */
export async function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = Promise.resolve();
  }
  return initPromise;
}

export function loadLanguage(lang: SupportedLanguage): Grammar | null {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  let language: Grammar | undefined;
  if (lang === "typescript") {
    language = TypeScriptGrammar.typescript as Grammar;
  } else if (lang === "tsx") {
    language = TypeScriptGrammar.tsx as Grammar;
  } else if (lang === "javascript") {
    language = JavaScriptGrammar as Grammar;
  }

  if (!language) return null;

  languageCache.set(lang, language);
  return language;
}

function getQueryPath(lang: SupportedLanguage): string | null {
  const names = QUERY_NAME_ALIASES[lang] ?? [lang];

  // Try tree-sitter-language-pack first (bundled aider queries)
  for (const name of names) {
    const packPath = path.join(LANGUAGE_PACK_DIR, `${name}-tags.scm`);
    if (existsSync(packPath)) return packPath;
  }

  // Fall back to tree-sitter-languages
  for (const name of names) {
    const langPath = path.join(LANGUAGES_DIR, `${name}-tags.scm`);
    if (existsSync(langPath)) return langPath;
  }

  return null;
}

function loadQuery(language: Grammar, lang: SupportedLanguage): Query | null {
  const cached = queryCache.get(lang);
  if (cached) return cached;

  const queryPath = getQueryPath(lang);
  if (!queryPath) return null;

  const source = readFileSync(queryPath, "utf-8");
  try {
    const query = new Query(language, source);
    queryCache.set(lang, query);
    return query;
  } catch {
    return null;
  }
}

function parseCode(parser: Parser, code: string): ReturnType<Parser["parse"]> {
  return parser.parse((offset) => code.slice(offset, offset + PARSE_CHUNK_SIZE));
}

// ── Pygments-style reference backfill ─────────────────────────────

/**
 * Backfill reference tags by extracting all identifier tokens from code.
 *
 * This is the TypeScript equivalent of Aider's Pygments fallback:
 * ```python
 * tokens = list(lexer.get_tokens(code))
 * tokens = [token[1] for token in tokens if token[0] in Token.Name]
 * for token in tokens:
 *     yield Tag(... kind="ref")
 * ```
 *
 * Instead of using Pygments (a Python library), we use a simple regex
 * to extract identifier-like tokens. This covers the common case:
 * function calls, variable references, property accesses.
 *
 * The regex approach is:
 * - Less accurate than Pygments (doesn't distinguish keywords from names)
 * - But sufficient for the reference graph (extra refs just add noise,
 *   they don't break correctness since PageRank handles noise via sqrt scaling)
 */
function backfillRefTags(
  code: string,
  relFname: string,
  fname: string,
  defNames: Set<string>,
): Tag[] {
  const refTags: Tag[] = [];
  const seen = new Set<string>();

  // Only backfill references for identifiers that were defined.
  // This prevents noise from keywords and common names.
  const identRe = /\b([a-zA-Z_][a-zA-Z0-9_]{1,})\b/g;
  let match: RegExpExecArray | null;
  while ((match = identRe.exec(code)) !== null) {
    const name = match[1]!;

    // Only include identifiers that appeared as definitions
    if (!defNames.has(name)) continue;

    // Deduplicate within this file
    if (seen.has(name)) continue;
    seen.add(name);

    // Compute line number from match position
    const charIndex = match.index;
    const line = code.slice(0, charIndex).split("\n").length;

    refTags.push({
      relFname,
      fname,
      line,
      name: name!,
      kind: "ref",
    });
  }

  return refTags;
}

// ── Main tag extraction ───────────────────────────────────────────

/**
 * Extract tags from a single file using tree-sitter.
 * Returns an array of Tag objects (definitions and references).
 *
 * When tree-sitter produces only def tags, falls back to Pygments-style
 * identifier extraction for reference tags.
 */
export async function getTagsRaw(
  fname: string,
  relFname: string,
): Promise<{ tags: Tag[]; parseTimeMs: number }> {
  const parseStart = Date.now();
  const lang = filenameToLang(fname);
  if (!lang) return { tags: [], parseTimeMs: Date.now() - parseStart };

  await initParser();

  const language = loadLanguage(lang);
  if (!language) return { tags: [], parseTimeMs: Date.now() - parseStart };

  const query = loadQuery(language, lang);
  if (!query) return { tags: [], parseTimeMs: Date.now() - parseStart };

  let code: string;
  try {
    code = readFileSync(fname, "utf-8");
  } catch {
    return { tags: [], parseTimeMs: Date.now() - parseStart };
  }

  let tree: ReturnType<Parser["parse"]> | null = null;
  let parser: Parser | null = null;
  try {
    parser = new Parser();
    parser.setLanguage(language);
    tree = parseCode(parser, code);
    if (!tree) return { tags: [], parseTimeMs: Date.now() - parseStart };

    const tags: Tag[] = [];
    const captures = query.captures(tree.rootNode);

    let sawDef = false;
    const defNames = new Set<string>();

    for (const capture of captures) {
      const captureName = capture.name;
      let kind: "def" | "ref" | null = null;

      if (captureName.startsWith("name.definition")) {
        kind = "def";
      } else if (captureName.startsWith("name.reference")) {
        kind = "ref";
      }

      if (!kind) continue;

      const name = capture.node.text;
      const tag: Tag = {
        relFname,
        fname,
        line: capture.node.startPosition.row + 1,
        name,
        kind,
      };

      tags.push(tag);

      if (kind === "def") {
        sawDef = true;
        defNames.add(name);
      }
    }

    // Pygments-style reference backfill:
    // Always run the backfill when we have definitions.
    //
    // The tree-sitter .scm query files for many languages (including
    // typescript) only capture a subset of reference patterns — they
    // may capture type references but miss function calls, variable
    // reads, etc.  Running the backfill unconditionally gives us
    // comprehensive reference coverage.  The dedup step below
    // removes any overlap with tree-sitter's own captures.
    if (sawDef && defNames.size > 0) {
      const refTags = backfillRefTags(code, relFname, fname, defNames);
      tags.push(...refTags);
    }

    // Deduplicate: same file, line, name, and kind
    const seen = new Set<string>();
    const deduped = tags.filter((tag) => {
      const key = `${tag.relFname}:${tag.line}:${tag.name}:${tag.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { tags: deduped, parseTimeMs: Date.now() - parseStart };
  } finally {
    void tree;
    void parser;
  }
}

/**
 * Extract tags with caching support.
 * Uses mtime-based TagsCache to avoid re-parsing unchanged files.
 */
export async function getTags(
  fname: string,
  relFname: string,
  cache: TagsCache | null,
  forceRefresh: boolean,
): Promise<Tag[]> {
  if (cache && !forceRefresh) {
    const cached = await cache.get(fname);
    if (cached) return cached;
  }

  const result = await getTagsRaw(fname, relFname);
  const { tags, parseTimeMs } = result;

  if (cache) {
    await cache.set(fname, tags);
    cache.recordParseTime(fname, parseTimeMs);
  }

  return tags;
}

/**
 * Extract tags from many files in parallel with a concurrency limit.
 */
export async function getTagsBatch(
  files: { fname: string; relFname: string }[],
  cache: TagsCache | null,
  forceRefresh: boolean,
  concurrency = 10,
  signal?: AbortSignal,
): Promise<Tag[]> {
  const results: Tag[] = [];

  for (let i = 0; i < files.length; i += concurrency) {
    if (signal?.aborted) break;

    const batch = files.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (f) => {
        // Per-file error isolation: a single broken file must not
        // kill the entire search.  Log and return empty.
        try {
          return await getTags(f.fname, f.relFname, cache, forceRefresh);
        } catch {
          return [];
        }
      }),
    );
    for (const tags of batchResults) {
      results.push(...tags);
    }
  }

  return results;
}
