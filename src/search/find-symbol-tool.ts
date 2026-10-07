import { existsSync, promises as fs } from "node:fs";
import { isAbsolute, relative } from "node:path";
import Parser from "tree-sitter";
import { initParser, loadLanguage, getQueryPath } from "../structural/tags.js";
import { filenameToLang } from "../languages.js";
import { findSrcFiles } from "../file-discovery.js";
import { expandToMonorepoRoots } from "../workspace/monorepo-detector.js";
import { getLSPBridge, type LSPBridge } from "../lsp/lsp-bridge.js";

// ── Helpers ────────────────────────────────────────────────────────

export interface SymbolEntry {
  name: string;
  kind: string;
  relative_path: string;
  line: number;
  end_line?: number;
  name_path?: string;
  child_count?: number;
  body?: string;
}

function extractSymbolName(node: { childForFieldName: (n: string) => { text: string } | null; namedChildren: ReadonlyArray<{ type: string; text: string; isNamed: boolean }> }): string | null {
  const nameField = node.childForFieldName?.("name");
  if (nameField) return nameField.text;
  for (const child of node.namedChildren) {
    if (child.isNamed && child.type === "identifier") return child.text;
  }
  return null;
}

function buildNamePath(defNode: Parser.SyntaxNode, name: string): string {
  const parts: string[] = [name];
  let parent = defNode.parent;
  let safety = 0;
  while (parent && safety < 10) {
    safety++;
    if (["class_declaration", "class_definition", "interface_declaration",
         "struct_item", "trait_item", "impl_item"].includes(parent.type)) {
      const parentName = extractSymbolName(parent as any);
      if (parentName) parts.unshift(parentName);
    }
    parent = parent.parent;
  }
  return parts.join(".");
}

// ── Handlers ───────────────────────────────────────────────────────

export async function handleSymbol(
  query: string,
  maxResults: number,
  includeBody: boolean,
  root: string,
  cwd: string,
  signal?: AbortSignal,
  fileGlob?: string,
) {
  // Fire off LSP workspace search concurrently with the tree-sitter scan so
  // both strategies contribute without sequential latency cost.
  const lspSearchPromise = searchWorkspaceSymbolsWithLsp(query, root, cwd);

  const { allFiles, matchesGlob } = await discoverAndFilterSymbolFiles(root, cwd, fileGlob, signal);

  await initParser();

  const { matches, totalDefs } = await scanFileDefinitions(allFiles, query, maxResults, includeBody, cwd, signal);

  // Merge LSP results first (typically faster/more accurate for configured
  // language servers), then fill remaining slots with tree-sitter results.
  // Deduplicate by file:line so the same symbol isn't shown twice.
  const lspResultsRaw = await lspSearchPromise;
  const merged = await mergeSymbolMatches(lspResultsRaw, matches, maxResults, matchesGlob);

  return { matches: merged, totalDefs, filesScanned: allFiles.length };
}

/** Start an LSP workspace/symbol search. Never rejects — falls back to []. */
function searchWorkspaceSymbolsWithLsp(query: string, root: string, cwd: string): Promise<SymbolEntry[]> {
  return (async (): Promise<SymbolEntry[]> => {
    try {
      const bridge = await lsp();
      if (!bridge) return [];
      const symbols = await bridge.workspaceSymbol(query, root);
      return symbols.map((s) => ({
        name: s.name,
        kind: symbolKindToString(s.kind),
        relative_path: relative(cwd, decodeURIComponent(s.location.uri.replace(/^file:\/\//, ""))),
        line: s.location.range.start.line + 1,
        name_path: s.containerName ? `${s.containerName}.${s.name}` : s.name,
      }));
    } catch {
      return [];
    }
  })();
}

type GlobMatcher = (filePath: string) => Promise<boolean>;

/**
 * Expand monorepo roots, list source files, and apply the optional fileGlob
 * pre-filter. Glob matching is cwd-relative: absolute filesystem candidates
 * are normalized via relative(cwd, …); LSP results already carry cwd-relative
 * paths and are matched directly. No path/boundary enforcement is applied —
 * reads in this repo are intentionally unrestricted (see AGENTS.md).
 */
async function discoverAndFilterSymbolFiles(
  root: string,
  cwd: string,
  fileGlob: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ allFiles: string[]; matchesGlob: GlobMatcher | undefined }> {
  const searchRoots = expandToMonorepoRoots(root);
  let allFiles: string[] = [];
  for (const sr of searchRoots) {
    const files = await findSrcFiles(sr, 50_000, signal);
    allFiles.push(...files);
  }
  allFiles = [...new Set(allFiles)];
  // Glob pre-filter: constrain candidates before the bounded scan (the
  // post-filter on LSP results in mergeSymbolMatches stays as a safeguard).
  const matchesGlob =
    fileGlob === undefined
      ? undefined
      : async (filePath: string) => {
          const { minimatch } = await import("minimatch");
          // Absolute filesystem candidates are normalized relative to cwd;
          // LSP results already carry cwd-relative paths and must be matched
          // directly (feeding them back through relative(cwd, ...) would
          // resolve against process.cwd() and produce wrong paths).
          const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
          return minimatch(rel.replace(/\\/g, "/"), fileGlob as string);
        };
  if (matchesGlob) {
    const seen = new Set<string>();
    const filtered: string[] = [];
    for (const filePath of allFiles) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      if (await matchesGlob(filePath)) filtered.push(filePath);
    }
    allFiles = filtered;
  }
  return { allFiles, matchesGlob };
}

/** Tree-sitter scan of candidate files for definitions matching the query. */
async function scanFileDefinitions(
  allFiles: string[],
  query: string,
  maxResults: number,
  includeBody: boolean,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ matches: SymbolEntry[]; totalDefs: number }> {
  const matches: SymbolEntry[] = [];
  let totalDefs = 0;

  const queryLower = query.toLowerCase();
  const queryParts = queryLower.split(".");

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matches.length >= maxResults) break;
    const found = await scanSingleFile(filePath, queryLower, queryParts, includeBody, cwd);
    totalDefs += found.defs;
    for (const m of found.matches) {
      if (matches.length >= maxResults) break;
      matches.push(m);
    }
  }

  return { matches, totalDefs };
}

/** Parse one file and return definitions matching the query. Never throws. */
async function scanSingleFile(
  filePath: string,
  queryLower: string,
  queryParts: string[],
  includeBody: boolean,
  cwd: string,
): Promise<{ matches: SymbolEntry[]; defs: number }> {
  const empty = { matches: [] as SymbolEntry[], defs: 0 };
  const lang = filenameToLang(filePath);
  if (!lang) return empty;
  const grammar = loadLanguage(lang);
  if (!grammar) return empty;

  let code: string;
  try { code = await fs.readFile(filePath, "utf-8"); } catch { return empty; }

  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse((offset) => code.slice(offset, offset + 1024));
  if (!tree?.rootNode) return empty;

  const queryPath = getQueryPath(lang);
  if (!queryPath || !existsSync(queryPath)) return empty;

  let tsQuery: Parser.Query;
  try {
    const querySource = await fs.readFile(queryPath, "utf-8");
    tsQuery = new Parser.Query(grammar, querySource);
  } catch { return empty; }

  return extractQueryMatches(tsQuery.matches(tree.rootNode), queryLower, queryParts, includeBody, relative(cwd, filePath));
}

/** Pull (name, definition) captures out of raw query matches and keep query hits. */
function extractQueryMatches(
  tsMatches: Parser.QueryMatch[],
  queryLower: string,
  queryParts: string[],
  includeBody: boolean,
  relFile: string,
): { matches: SymbolEntry[]; defs: number } {
  const matches: SymbolEntry[] = [];
  let defs = 0;
  for (const match of tsMatches) {
    const found = readDefinitionCaptures(match);
    if (!found) continue;
    defs++;
    const { name, defNode, defKind } = found;
    if (!definitionMatchesQuery(name, defNode, queryLower, queryParts)) continue;
    const namePath = buildNamePath(defNode, name);
    matches.push({
      name, kind: defKind, relative_path: relFile,
      line: defNode.startPosition.row + 1,
      end_line: defNode.endPosition.row + 1,
      name_path: namePath,
      body: includeBody ? defNode.text : undefined,
    });
  }
  return { matches, defs };
}

/** Read the name/definition capture pair from one raw query match. */
function readDefinitionCaptures(
  match: Parser.QueryMatch,
): { name: string; defNode: Parser.SyntaxNode; defKind: string } | undefined {
  let name: string | undefined;
  let defNode: Parser.SyntaxNode | undefined;
  let defKind = "definition";
  for (const capture of match.captures) {
    if (capture.name.startsWith("name.definition")) {
      name = capture.node.text;
    } else if (capture.name.startsWith("definition")) {
      defNode = capture.node;
      defKind = capture.name.replace(/^definition\.?/, "") || "definition";
    }
  }
  if (!name || !defNode) return undefined;
  return { name, defNode, defKind };
}

/** Name-path match: substring on path/name, or every dotted part present. */
function definitionMatchesQuery(
  name: string,
  defNode: Parser.SyntaxNode,
  queryLower: string,
  queryParts: string[],
): boolean {
  const namePathLower = buildNamePath(defNode, name).toLowerCase();
  return namePathLower.includes(queryLower) ||
    name.toLowerCase().includes(queryLower) ||
    queryParts.every((part) => namePathLower.includes(part));
}

/**
 * Merge LSP results ahead of tree-sitter matches with `relative_path:line`
 * dedup. Both lists are truncated at maxResults.
 */
async function mergeSymbolMatches(
  lspResultsRaw: SymbolEntry[],
  treeSitterMatches: SymbolEntry[],
  maxResults: number,
  matchesGlob: GlobMatcher | undefined,
): Promise<SymbolEntry[]> {
  let lspResults = lspResultsRaw;
  if (matchesGlob) {
    const filtered: typeof lspResults = [];
    for (const r of lspResults) {
      if (await matchesGlob(r.relative_path)) filtered.push(r);
    }
    lspResults = filtered;
  }
  const seen = new Set<string>();
  const merged: SymbolEntry[] = [];
  for (const r of lspResults) {
    if (merged.length >= maxResults) break;
    const key = `${r.relative_path}:${r.line}`;
    if (!seen.has(key)) { seen.add(key); merged.push(r); }
  }
  for (const m of treeSitterMatches) {
    if (merged.length >= maxResults) break;
    const key = `${m.relative_path}:${m.line}`;
    if (!seen.has(key)) { seen.add(key); merged.push(m); }
  }
  return merged;
}

// ── LSP helpers ────────────────────────────────────────────────────

let _lspBridge: LSPBridge | null | undefined;
async function lsp(): Promise<LSPBridge | null> {
  if (_lspBridge === undefined) _lspBridge = await getLSPBridge();
  return _lspBridge;
}

function symbolKindToString(kind: number): string {
  switch (kind) {
    case 5: return "class";
    case 6: return "method";
    case 7: case 8: return "property";
    case 9: return "method";
    case 10: return "enum";
    case 11: return "interface";
    case 12: return "function";
    case 13: case 14: return "variable";
    case 23: return "class";
    default: return "symbol";
  }
}
