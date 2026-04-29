/**
 * Tree-sitter tag extraction for repo mapping.
 * Uses web-tree-sitter (WASM) to parse source files and extract
 * definitions and references via language-specific .scm query files.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Parser, Language, Query } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import type { Tag } from "./cache.js";
import {
  filenameToLang,
  type SupportedLanguage,
  LANGUAGE_WASM_ALIASES,
  QUERY_NAME_ALIASES,
} from "./languages.js";
import { TagsCache } from "./cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUERIES_DIR = path.resolve(__dirname, "queries");
const LANGUAGE_PACK_DIR = path.join(QUERIES_DIR, "tree-sitter-language-pack");
const LANGUAGES_DIR = path.join(QUERIES_DIR, "tree-sitter-languages");

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, Language>();
const queryCache = new Map<string, Query>();

/**
 * Initialize the web-tree-sitter WASM parser.
 * Must be called once before any tag extraction.
 * Uses a shared promise to prevent concurrent re-initialization.
 */
export async function initParser(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = Parser.init();
  await initPromise;
}

function getWasmPath(lang: SupportedLanguage): string {
  const require = createRequire(import.meta.url);
  const wasmsDir = path.dirname(require.resolve("tree-sitter-wasms/package.json"));
  const wasmName = LANGUAGE_WASM_ALIASES[lang] ?? lang;
  return path.join(wasmsDir, "out", `tree-sitter-${wasmName}.wasm`);
}

async function loadLanguage(lang: SupportedLanguage): Promise<Language> {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  const wasmPath = getWasmPath(lang);
  const language = await Language.load(wasmPath);
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

function loadQuery(language: Language, lang: SupportedLanguage): Query | null {
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

/**
 * Extract tags from a single file using tree-sitter.
 * Returns an array of Tag objects (definitions and references).
 */
export async function getTagsRaw(
  fname: string,
  relFname: string,
): Promise<Tag[]> {
  const lang = filenameToLang(fname);
  if (!lang) return [];

  await initParser();

  let language: Language;
  try {
    language = await loadLanguage(lang);
  } catch {
    return [];
  }

  const query = loadQuery(language, lang);
  if (!query) return [];

  let code: string;
  try {
    code = readFileSync(fname, "utf-8");
  } catch {
    return [];
  }

  const parser = new Parser();
  parser.setLanguage(language);

  let tree: Tree | null = null;
  try {
    tree = parser.parse(code);
    if (!tree) return [];

    const tags: Tag[] = [];
    const captures = query.captures(tree.rootNode);

    for (const capture of captures) {
      const captureName = capture.name;
      let kind: "def" | "ref" | null = null;

      if (captureName.startsWith("name.definition")) {
        kind = "def";
      } else if (captureName.startsWith("name.reference")) {
        kind = "ref";
      }

      if (!kind) continue;

      tags.push({
        relFname,
        fname,
        line: capture.node.startPosition.row + 1,
        name: capture.node.text,
        kind,
      });
    }

    // Deduplicate: same file, line, name, and kind
    const seen = new Set<string>();
    return tags.filter((tag) => {
      const key = `${tag.relFname}:${tag.line}:${tag.name}:${tag.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } finally {
    tree?.delete();
    parser.delete();
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
    const cached = cache.get(fname);
    if (cached) return cached;
  }

  const tags = await getTagsRaw(fname, relFname);

  if (cache) {
    cache.set(fname, tags);
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
): Promise<Tag[]> {
  const results: Tag[] = [];

  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((f) => getTags(f.fname, f.relFname, cache, forceRefresh)),
    );
    for (const tags of batchResults) {
      results.push(...tags);
    }
  }

  return results;
}
