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
import type { Tag } from "../structural/cache.js";
import { filenameToLang } from "../languages.js";
import { pagerank, buildWeightedEdges } from "../ranking/pagerank.js";
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

// note: estimateTokens and countTokens are shared from repomap-render.ts

// ── TS path alias resolution ─────────────────────────────────────

async function readJsonConfig(configPath: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function aliasPrefixOf(alias: string): string | null {
  const m = alias.match(/^([^/*]+)(?:\/(?:\*|\*\*))?$/);
  return m ? m[1]! : null;
}

function targetDirOf(target: unknown): string | null {
  if (typeof target !== "string") return null;
  const m = target.match(/^\.(\/[^/*]+)(?:\/\*|\/\*\*)?$/);
  return m ? "." + m[1] : null;
}

function addAliasEntry(
  alias: string,
  targets: unknown,
  prefixes: Map<string, string>,
): void {
  const prefix = aliasPrefixOf(alias);
  if (!prefix || prefixes.has(prefix)) return;
  const arr = Array.isArray(targets) ? targets : [targets];
  for (const t of arr) {
    const dir = targetDirOf(t);
    if (dir) {
      prefixes.set(prefix, dir);
      return;
    }
  }
}

function collectAliasPrefixes(paths: unknown, prefixes: Map<string, string>): void {
  if (!paths || typeof paths !== "object") return;
  for (const [alias, targets] of Object.entries(paths as Record<string, unknown>)) {
    addAliasEntry(alias, targets, prefixes);
  }
}

/**
 * Parse tsconfig.json (or jsconfig.json) to extract compilerOptions.paths.
 * Returns a map of alias prefixes to directory targets.
 */
export async function parseTsconfigPaths(
  root: string,
): Promise<TsAliasMap | null> {
  const prefixes = new Map<string, string>();

  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const config = await readJsonConfig(path.join(root, name));
    const paths = (config as { compilerOptions?: { paths?: unknown } } | null)
      ?.compilerOptions?.paths;
    collectAliasPrefixes(paths, prefixes);
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

function isBareSpecifier(importPath: string): boolean {
  return !importPath.startsWith(".") && !importPath.startsWith("/");
}

function collectSearchPaths(
  importPath: string,
  fromRelDir: string,
  absRoot: string,
  aliases?: TsAliasMap,
): string[] {
  if (aliases && isBareSpecifier(importPath)) {
    const aliasResolved = resolveViaAlias(importPath, absRoot, aliases);
    if (aliasResolved) return [aliasResolved];
  }
  if (importPath.startsWith("/")) {
    return [path.resolve(absRoot, "." + importPath)];
  }
  return [path.resolve(fromRelDir, importPath)];
}

const RESOLVE_EXTENSIONS = [
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

function tryWithExtension(rel: string, knownFiles: Set<string>): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    if (knownFiles.has(rel + ext)) return rel + ext;
  }
  return null;
}

function tryIndexFile(rel: string, knownFiles: Set<string>): string | null {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = path.join(rel, `index${ext}`);
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function tryResolveAbsPath(
  absPath: string,
  absRoot: string,
  knownFiles: Set<string>,
): string | null {
  const rel = path.relative(absRoot, absPath);
  if (knownFiles.has(rel)) return rel;
  return tryWithExtension(rel, knownFiles) ?? tryIndexFile(rel, knownFiles);
}

interface ResolveImportInput {
  importPath: string;
  fromRelDir: string;
  absRoot: string;
  knownFiles: Set<string>;
  aliases?: TsAliasMap;
}

function resolveImportPath(input: ResolveImportInput): string | null {
  const searchPaths = collectSearchPaths(
    input.importPath,
    input.fromRelDir,
    input.absRoot,
    input.aliases,
  );
  for (const absPath of searchPaths) {
    const resolved = tryResolveAbsPath(absPath, input.absRoot, input.knownFiles);
    if (resolved) return resolved;
  }
  return null;
}

// ── Import extraction helpers ─────────────────────────────────────

const IMPORT_ESM =
  /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))?)\s+from\s+)?['"]([^'"]+)['"]/g;
const IMPORT_CJS =
  /(?:^|[^.\w])(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TS_REF = /\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"]+)['"]/g;
const GO_IMPORT_LINE = /^import\s+"([^"]+)"/gm;
const GO_IMPORT_BLOCK = /import\s*\(([^)]*)\)/g;
const RUST_USE = /^use\s+([a-zA-Z_][a-zA-Z0-9_:*]*);/gm;
const RUST_EXTERN = /^extern\s+crate\s+([a-zA-Z_][a-zA-Z0-9_]*);/gm;
const RUST_MOD = /^mod\s+([a-zA-Z_][a-zA-Z0-9_]*);/gm;
const PY_FROM = /^from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import/mg;
const PY_IMPORT =
  /^import\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*/mg;

function addUnique(imports: string[], seen: Set<string>, p: string | undefined): void {
  if (p && !seen.has(p)) {
    seen.add(p);
    imports.push(p);
  }
}

/** Shared sink for import-collection helpers. */
interface MatchSink {
  seen: Set<string>;
  imports: string[];
}

function collectMatches(
  code: string,
  re: RegExp,
  sink: MatchSink,
  map?: (raw: string) => string | undefined,
): void {
  for (const match of code.matchAll(re)) {
    const raw = match[1] ?? match[0];
    addUnique(sink.imports, sink.seen, map ? map(raw!) : raw);
  }
}

function extractJsImports(code: string, sink: MatchSink): void {
  collectMatches(code, IMPORT_ESM, sink);
  collectMatches(code, IMPORT_CJS, sink);
  collectMatches(code, TS_REF, sink);
}

function extractGoImports(code: string, sink: MatchSink): void {
  collectMatches(code, GO_IMPORT_LINE, sink);
  for (const match of code.matchAll(GO_IMPORT_BLOCK)) {
    const quoted = match[1]!.match(/"([^"]+)"/g);
    if (!quoted) continue;
    for (const q of quoted) addUnique(sink.imports, sink.seen, q.replace(/"/g, ""));
  }
}

const RUST_STD_CRATES = new Set(["std", "core", "alloc"]);

function normalizeRustUse(raw: string): string | undefined {
  const p = raw.replace(/^(crate|self|super)::/, "").replace(/::\*$/, "");
  const parts = p.split("::");
  if (RUST_STD_CRATES.has(parts[0]!)) return undefined;
  return parts.join("/");
}

function extractRustImports(code: string, sink: MatchSink): void {
  collectMatches(code, RUST_USE, sink, normalizeRustUse);
  collectMatches(code, RUST_EXTERN, sink);
  for (const match of code.matchAll(RUST_MOD)) {
    const p = match[1];
    if (p !== "tests") addUnique(sink.imports, sink.seen, p);
  }
}

function extractPythonImports(code: string, sink: MatchSink): void {
  collectMatches(code, PY_FROM, sink, (raw) => {
    const p = raw.replace(/\./g, "/");
    return p === "__future__" ? undefined : p;
  });
  for (const match of code.matchAll(PY_IMPORT)) {
    for (const part of match[0].split(/\s*,\s*/)) {
      const p = part.trim().replace(/^import\s+/, "").replace(/\./g, "/");
      if (!p.startsWith("__")) addUnique(sink.imports, sink.seen, p);
    }
  }
}

function isJsFamily(lang: string): boolean {
  return lang === "javascript" || lang === "typescript" || lang === "tsx";
}

function extractImports(fname: string, code: string): string[] {
  const lang = filenameToLang(fname);
  if (!lang) return [];
  const imports: string[] = [];
  const seen = new Set<string>();
  const sink: MatchSink = { seen, imports };
  if (isJsFamily(lang)) extractJsImports(code, sink);
  else if (lang === "go") extractGoImports(code, sink);
  else if (lang === "rust") extractRustImports(code, sink);
  else if (lang === "python") extractPythonImports(code, sink);
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
    await processGraphFile({ relFname, root, knownRelFiles, processed, queue, edges, inDegrees, aliases });
  }

  for (const relFname of allFiles) {
    if (!inDegrees.has(relFname)) inDegrees.set(relFname, 0);
  }

  return { inDegrees, edges };
}

async function readGraphFile(root: string, relFname: string): Promise<string | null> {
  try {
    return await fs.readFile(path.resolve(root, relFname), "utf-8");
  } catch {
    return null;
  }
}

interface GraphFileCtx {
  relFname: string;
  root: string;
  knownRelFiles: Set<string>;
  processed: Set<string>;
  queue: string[];
  edges: ImportEdge[];
  inDegrees: Map<string, number>;
  aliases?: TsAliasMap;
}

async function processGraphFile(ctx: GraphFileCtx): Promise<void> {
  const code = await readGraphFile(ctx.root, ctx.relFname);
  if (code === null) return;
  const absFname = path.resolve(ctx.root, ctx.relFname);
  for (const imp of extractImports(absFname, code)) {
    const resolved = resolveImportPath({
      importPath: imp,
      fromRelDir: path.dirname(absFname),
      absRoot: ctx.root,
      knownFiles: ctx.knownRelFiles,
      aliases: ctx.aliases,
    });
    if (!resolved || resolved === ctx.relFname) continue;
    ctx.edges.push({ from: ctx.relFname, to: resolved });
    ctx.inDegrees.set(resolved, (ctx.inDegrees.get(resolved) ?? 0) + 1);
    if (!ctx.processed.has(resolved)) ctx.queue.push(resolved);
  }
}

// ── Ranking: tree-sitter + PageRank ─────────────────────────────

interface DefinesReferences {
  defines: Map<string, Set<string>>;
  references: Map<string, string[]>;
}

function recordDefine(tag: Tag, defines: Map<string, Set<string>>): void {
  let set = defines.get(tag.name);
  if (!set) {
    set = new Set();
    defines.set(tag.name, set);
  }
  set.add(tag.relFname);
}

function recordReference(tag: Tag, references: Map<string, string[]>): void {
  let list = references.get(tag.name);
  if (!list) {
    list = [];
    references.set(tag.name, list);
  }
  list.push(tag.relFname);
}

function splitTags(allTags: Tag[]): DefinesReferences {
  const defines = new Map<string, Set<string>>();
  const references = new Map<string, string[]>();
  for (const tag of allTags) {
    if (tag.kind === "def") recordDefine(tag, defines);
    else if (tag.kind === "ref") recordReference(tag, references);
  }
  return { defines, references };
}

function personalizeFocusFiles(
  focusRelFiles: Set<string>,
  personalize: number,
  personalization: Map<string, number>,
): void {
  for (const relFname of focusRelFiles) {
    personalization.set(relFname, (personalization.get(relFname) ?? 0) + personalize);
  }
}

interface PersonalizeCtx {
  input: PersonalizationInput;
  personalize: number;
  personalization: Map<string, number>;
}

function personalizeMentionedFnames(ctx: PersonalizeCtx): void {
  for (const mentionedFname of ctx.input.mentionedFnames) {
    const relPath = path.relative(ctx.input.root, path.resolve(ctx.input.root, mentionedFname));
    if (ctx.input.nodes.has(relPath)) {
      ctx.personalization.set(relPath, (ctx.personalization.get(relPath) ?? 0) + ctx.personalize);
    }
  }
}

function filePathComponents(relFname: string): Set<string> {
  const pathObj = relFname.split("/");
  const basename = pathObj[pathObj.length - 1] ?? "";
  const extIdx = basename.lastIndexOf(".");
  const stem = extIdx >= 0 ? basename.slice(0, extIdx) : basename;
  return new Set([...pathObj, basename, stem]);
}

function personalizeMentionedIdents(ctx: PersonalizeCtx): void {
  for (const relFname of ctx.input.nodes) {
    const components = filePathComponents(relFname);
    for (const ident of ctx.input.mentionedIdents) {
      if (components.has(ident)) {
        ctx.personalization.set(relFname, (ctx.personalization.get(relFname) ?? 0) + ctx.personalize);
        break;
      }
    }
  }
}

function boostDefsOutsideFocus(defFnames: Set<string>, ctx: PersonalizeCtx): void {
  for (const defFname of defFnames) {
    if (ctx.input.focusRelFiles.has(defFname)) continue;
    ctx.personalization.set(
      defFname,
      (ctx.personalization.get(defFname) ?? 0) + ctx.personalize * 0.1,
    );
  }
}

function personalizeFocusConnected(ctx: PersonalizeCtx): void {
  for (const [name, refFnames] of ctx.input.references) {
    const defFnames = ctx.input.defines.get(name);
    if (!defFnames) continue;
    const touchedFromFocus = refFnames.some((f) => ctx.input.focusRelFiles.has(f));
    if (touchedFromFocus) boostDefsOutsideFocus(defFnames, ctx);
  }
}

interface PersonalizationInput {
  root: string;
  nodes: Set<string>;
  focusRelFiles: Set<string>;
  mentionedFnames: string[];
  mentionedIdents: string[];
  defines: Map<string, Set<string>>;
  references: Map<string, string[]>;
}

function buildPersonalization(input: PersonalizationInput): Map<string, number> {
  const ctx: PersonalizeCtx = {
    input,
    personalize: 100 / Math.max(1, input.nodes.size),
    personalization: new Map<string, number>(),
  };
  personalizeFocusFiles(input.focusRelFiles, ctx.personalize, ctx.personalization);
  personalizeMentionedFnames(ctx);
  personalizeMentionedIdents(ctx);
  if (input.focusRelFiles.size > 0) personalizeFocusConnected(ctx);
  return ctx.personalization;
}

interface TagBoosts {
  focusRelFiles: Set<string>;
  priorityRelFiles: Set<string>;
  priorityIdentifiers: Set<string>;
}

function scoreDefinitionTags(
  allTags: Tag[],
  ranks: Map<string, number>,
  boosts: TagBoosts,
): RankedTag[] {
  const rankedTags: RankedTag[] = [];
  for (const tag of allTags) {
    if (tag.kind !== "def") continue;
    const fileRank = ranks.get(tag.relFname) ?? 0;
    let boost = 1.0;
    if (boosts.focusRelFiles.has(tag.relFname)) boost *= 20.0;
    if (boosts.priorityIdentifiers.has(tag.name)) boost *= 10.0;
    if (boosts.priorityRelFiles.has(tag.relFname)) boost *= 5.0;
    rankedTags.push({ rank: fileRank * boost, tag });
  }
  rankedTags.sort((a, b) => b.rank - a.rank);
  return rankedTags;
}

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
  const { defines, references } = splitTags(allTags);

  const nodes = new Set(allFiles.map((f) => path.relative(root, f)));
  const focusRelFiles = new Set(focusFiles.map((f) => path.relative(root, f)));
  const mentionedIdentsSet = new Set(mentionedIdents);

  const personalization = buildPersonalization({
    root,
    nodes,
    focusRelFiles,
    mentionedFnames,
    mentionedIdents,
    defines,
    references,
  });

  const edges = buildWeightedEdges(defines, references, {
    mentionedIdents: mentionedIdentsSet.size > 0 ? mentionedIdentsSet : undefined,
    chatRelFiles: focusRelFiles.size > 0 ? focusRelFiles : undefined,
  });

  const ranks = pagerank(
    nodes,
    edges,
    personalization.size > 0 ? personalization : undefined,
  );

  const priorityRelFiles = new Set(
    Array.from(priorityFiles).map((f) => path.relative(root, f)),
  );

  return scoreDefinitionTags(allTags, ranks, {
    focusRelFiles,
    priorityRelFiles,
    priorityIdentifiers,
  });
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
    rankedTags.push({ rank: scoreImportFile({ relFname, inDegrees, maxDegree, focusRelFiles, priorityRelFiles }), tag: syntheticTagFor(relFname, root) });
  }

  rankedTags.sort((a, b) => b.rank - a.rank);
  return rankedTags;
}

interface ImportScoreCtx {
  relFname: string;
  inDegrees: Map<string, number>;
  maxDegree: number;
  focusRelFiles: Set<string>;
  priorityRelFiles: Set<string>;
}

function scoreImportFile(ctx: ImportScoreCtx): number {
  const inDegree = ctx.inDegrees.get(ctx.relFname) ?? 0;
  let rank = inDegree / ctx.maxDegree;
  if (ctx.focusRelFiles.has(ctx.relFname)) rank += 2.0;
  if (ctx.priorityRelFiles.has(ctx.relFname)) rank += 1.0;
  return rank;
}

function syntheticTagFor(relFname: string, root: string): Tag {
  return {
    relFname,
    fname: path.resolve(root, relFname),
    line: 1,
    name: path.basename(relFname, path.extname(relFname)),
    kind: "def",
  };
}
