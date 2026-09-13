/**
 * Structural import resolution, dependency extraction, dependent scan,
 * and barrel/re-export traversal.
 * Split from structural-facts.ts (Seam5). Own parse infra; no cross-module sharing.
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import Parser from "tree-sitter";
import { createRequire } from "node:module";
import { filenameToLang, type SupportedLanguage } from "../languages.js";
import { findSrcFiles } from "../file-discovery.js";
import { chooseConcurrency } from "../adaptive-concurrency.js";
import type { DependentInfo, DependencyInfo, ReExportInfo } from "./structural-facts-types.js";

const require = createRequire(import.meta.url);
const TypeScriptGrammar = require("tree-sitter-typescript");
const JavaScriptGrammar = require("tree-sitter-javascript");
const PythonGrammar = require("tree-sitter-python");

const grammarCache = new Map<string, any>();
const GRAMMAR_BY_LANG: Record<string, any | undefined> = {
  typescript: TypeScriptGrammar.typescript,
  tsx: TypeScriptGrammar.tsx,
  javascript: JavaScriptGrammar,
  python: PythonGrammar,
};
function loadGrammar(lang: SupportedLanguage): any | null {
  const cached = grammarCache.get(lang);
  if (cached) return cached;
  const grammar = GRAMMAR_BY_LANG[lang];
  if (!grammar) return null;
  grammarCache.set(lang, grammar);
  return grammar;
}

/** Best-effort file-exists check (missing/unreadable → false). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const PARSE_CHUNK_SIZE = 1024;

function parseCode(parser: Parser, code: string): ReturnType<Parser["parse"]> {
  return parser.parse((offset) => code.slice(offset, offset + PARSE_CHUNK_SIZE));
}

const TS_RESOLUTION_EXTENSIONS = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  "/index.ts", "/index.tsx", "/index.js", "/index.mjs",
];
// TS module resolution: ".js" in import specifiers maps to ".ts"/".tsx"/".jsx"
const JS_TO_TS_SUFFIX: [string, string[]][] = [
  [".js", [".ts", ".tsx", ".jsx"]],
  [".mjs", [".mts", ".ts", ".tsx"]],
  [".cjs", [".cts", ".ts", ".tsx"]],
];
function tryDirectExtensions(basePath: string): string | undefined {
  for (const ext of TS_RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}
function tryJsToTsMapping(basePath: string, specifier: string): string | undefined {
  for (const [jsExt, tsExts] of JS_TO_TS_SUFFIX) {
    if (!specifier.endsWith(jsExt)) continue;
    const baseNoExt = basePath.slice(0, -jsExt.length);
    for (const tsExt of tsExts) {
      const candidate = `${baseNoExt}${tsExt}`;
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}
export function resolveImportPath(
  importerPath: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const basePath = resolve(dirname(importerPath), specifier);
  return tryDirectExtensions(basePath) ?? tryJsToTsMapping(basePath, specifier);
}

export interface ReExportCandidate {
  barrelFile: string;
  exportName: string;
  line: number;
  kind: "named" | "wildcard" | "all";
}
export const MAX_REEXPORT_DEPTH = 5;

function walkUpBase(importerPath: string, depth: number): string | undefined {
  let base = dirname(importerPath);
  for (let i = 1; i < depth; i++) {
    const parent = dirname(base);
    if (parent === base) return undefined;
    base = parent;
  }
  return base;
}
function resolveDotOnlyImport(base: string, importedName?: string): string | undefined {
  if (importedName) {
    const importedDirInit = resolve(base, importedName, "__init__.py");
    if (isFile(importedDirInit)) return importedDirInit;
    const importedFile = resolve(base, `${importedName}.py`);
    if (isFile(importedFile)) return importedFile;
  }
  const pkgInit = resolve(base, "__init__.py");
  if (isFile(pkgInit)) return pkgInit;
  return undefined;
}
function resolveNamedModule(base: string, name: string): string | undefined {
  const dirInit = resolve(base, name, "__init__.py");
  if (isFile(dirInit)) return dirInit;
  const fileMod = resolve(base, `${name}.py`);
  if (isFile(fileMod)) return fileMod;
  return undefined;
}
export function resolvePythonImportPath(
  importerPath: string,
  specifier: string,
  importedName?: string,
): string | undefined {
  const dots = specifier.match(/^\.+/)?.[0] ?? "";
  // Absolute (stdlib / third-party) imports are never resolvable to workspace
  // files — keep them unresolved. Only relative imports are resolved here.
  if (!dots) return undefined;
  const name = specifier.slice(dots.length);
  const depth = dots.length;
  const base = walkUpBase(importerPath, depth);
  if (base === undefined) return undefined;
  if (!name) return resolveDotOnlyImport(base, importedName);
  return resolveNamedModule(base, name);
}

function walkTree(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkTree(child, visit);
  }
}
interface TsExportParts {
  sourceNode: Parser.SyntaxNode | null;
  exportClause: Parser.SyntaxNode | null;
  isWildcard: boolean;
}
function updatePartsFromChild(parts: TsExportParts, child: Parser.SyntaxNode): void {
  if (child.isNamed && child.type === "string") parts.sourceNode = child;
  else if (child.isNamed && child.type === "export_clause") parts.exportClause = child;
  else if (!child.isNamed && child.type === "*") parts.isWildcard = true;
}
function splitTsExportParts(node: Parser.SyntaxNode): TsExportParts {
  const parts: TsExportParts = { sourceNode: null, exportClause: null, isWildcard: false };
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) updatePartsFromChild(parts, child);
  }
  return parts;
}
function pushTsNamedExports(exportClause: Parser.SyntaxNode, barrelFile: string, results: ReExportCandidate[]): void {
  for (let i = 0; i < exportClause.namedChildCount; i++) {
    const spec = exportClause.namedChild(i);
    if (!spec || spec.type !== "export_specifier") continue;
    const name = spec.childForFieldName("name");
    if (!name) continue;
    results.push({ barrelFile, exportName: name.text, line: spec.startPosition.row + 1, kind: "named" });
  }
}
function processTsExportStatement(node: Parser.SyntaxNode, filePath: string, results: ReExportCandidate[]): void {
  if (node.type !== "export_statement") return;
  const { sourceNode, exportClause, isWildcard } = splitTsExportParts(node);
  if (!sourceNode) return;
  const sourcePath = sourceNode.text.replace(/^["']|["']$/g, "");
  const resolved = resolveImportPath(filePath, sourcePath);
  const barrelFile = resolved ?? sourcePath;
  if (isWildcard) {
    results.push({ barrelFile, exportName: "*", line: node.startPosition.row + 1, kind: "wildcard" });
    return;
  }
  if (exportClause) pushTsNamedExports(exportClause, barrelFile, results);
}
function extractTSReExportsFromFile(
  filePath: string,
): ReExportCandidate[] {
  const results: ReExportCandidate[] = [];
  let code: string;
  try { code = readFileSync(filePath, "utf-8"); } catch { return []; }

  const lang = filenameToLang(filePath);
  if (!lang) return [];
  const grammar = loadGrammar(lang);
  if (!grammar) return [];

  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parseCode(parser, code);
  const root = tree.rootNode;
  walkTree(root, (node) => processTsExportStatement(node, filePath, results));
  return results;
}

function pushPythonNameList(name: Parser.SyntaxNode, barrelFile: string, results: ReExportCandidate[]): void {
  for (let i = 0; i < name.namedChildCount; i++) {
    const id = name.namedChild(i);
    if (!id) continue;
    results.push({ barrelFile, exportName: id.text, line: id.startPosition.row + 1, kind: "named" });
  }
}
function pushPythonSingleName(name: Parser.SyntaxNode, barrelFile: string, results: ReExportCandidate[]): void {
  if (name.type === "identifier" || name.type === "dotted_name") {
    results.push({ barrelFile, exportName: name.text, line: name.startPosition.row + 1, kind: "named" });
    return;
  }
  if (name.type === "identifier_list" || name.type === "dotted_name_list") {
    pushPythonNameList(name, barrelFile, results);
  }
}
function processPythonImportFrom(node: Parser.SyntaxNode, filePath: string, results: ReExportCandidate[]): void {
  if (node.type !== "import_from_statement") return;
  const moduleName = node.childForFieldName("module_name");
  if (!moduleName) return;
  const sourcePath = moduleName.text;
  const resolved = resolvePythonImportPath(filePath, sourcePath, node.childForFieldName("name")?.text);
  const barrelFile = resolved ?? sourcePath;
  if (node.childForFieldName("wildcard")) {
    results.push({ barrelFile, exportName: "*", line: node.startPosition.row + 1, kind: "wildcard" });
    return;
  }
  const name = node.childForFieldName("name");
  if (name) pushPythonSingleName(name, barrelFile, results);
}
function extractPythonReExportsFromFile(
  filePath: string,
): ReExportCandidate[] {
  const results: ReExportCandidate[] = [];
  let code: string;
  try { code = readFileSync(filePath, "utf-8"); } catch { return []; }

  const grammar = loadGrammar("python");
  if (!grammar) return [];

  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parseCode(parser, code);
  const root = tree.rootNode;
  walkTree(root, (node) => processPythonImportFrom(node, filePath, results));
  return results;
}

function listDirEntryNames(dir: string): string[] | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return null;
  }
}
function reExportsForBarrel(barrelPath: string, lang: SupportedLanguage): ReExportCandidate[] {
  return lang === "python"
    ? extractPythonReExportsFromFile(barrelPath)
    : extractTSReExportsFromFile(barrelPath);
}
function isCandidateBarrel(entryName: string, exts: string[], dir: string, filePath: string): string | null {
  if (!exts.some((ext) => entryName.endsWith(ext))) return null;
  const barrelPath = resolve(dir, entryName);
  if (barrelPath === filePath) return null;
  if (!isFile(barrelPath)) return null;
  return barrelPath;
}
function collectMatchingReExports(reExports: ReExportCandidate[], barrelPath: string, targetNorm: string, lang: SupportedLanguage, visited: Set<string>, depth: number, results: ReExportInfo[]): void {
  for (const re of reExports) {
    if (resolve(re.barrelFile) !== targetNorm) continue;
    results.push({ barrelFile: barrelPath, exportName: re.exportName, line: re.line, kind: re.kind });
    results.push(...findBarrelReExports(barrelPath, lang, visited, depth + 1));
  }
}
function scanDirBarrels(dir: string, filePath: string, targetNorm: string, lang: SupportedLanguage, visited: Set<string>, depth: number, results: ReExportInfo[]): void {
  const files = listDirEntryNames(dir);
  if (!files) return;
  const exts = lang === "python" ? [".py"] : [".ts", ".tsx", ".js", ".mjs", ".jsx"];
  for (const entry of files) {
    const barrelPath = isCandidateBarrel(entry, exts, dir, filePath);
    if (!barrelPath) continue;
    collectMatchingReExports(reExportsForBarrel(barrelPath, lang), barrelPath, targetNorm, lang, visited, depth, results);
  }
}
function scanPythonInitBarrels(dir: string, nameWithoutExt: string, targetNorm: string, lang: SupportedLanguage, visited: Set<string>, depth: number, results: ReExportInfo[]): void {
  for (const barrelName of ["__init__", nameWithoutExt]) {
    const barrelPath = resolve(dir, `${barrelName}.py`);
    if (!isFile(barrelPath)) continue;
    for (const re of extractPythonReExportsFromFile(barrelPath)) {
      const resolved = resolvePythonImportPath(barrelPath, re.barrelFile);
      if (!resolved || resolve(resolved) !== targetNorm) continue;
      results.push({ barrelFile: barrelPath, exportName: re.exportName, line: re.line, kind: re.kind });
      results.push(...findBarrelReExports(barrelPath, lang, visited, depth + 1));
    }
  }
}
export function findBarrelReExports(
  filePath: string,
  lang: SupportedLanguage,
  visited: Set<string>,
  depth: number,
): ReExportInfo[] {
  if (depth > MAX_REEXPORT_DEPTH) return [];
  if (visited.has(filePath)) return [];
  visited.add(filePath);
  const results: ReExportInfo[] = [];
  const dir = dirname(filePath);
  const targetNorm = resolve(filePath);
  scanDirBarrels(dir, filePath, targetNorm, lang, visited, depth, results);
  if (lang === "python") {
    const fileName = basename(filePath);
    const nameWithoutExt = fileName.includes(".")
      ? fileName.slice(0, fileName.lastIndexOf("."))
      : fileName;
    scanPythonInitBarrels(dir, nameWithoutExt, targetNorm, lang, visited, depth, results);
  }
  return results;
}

// ── Import/dependency extraction ───────────────────────────────

/**
 * Shared regex for JS/TS import, require, and re-export patterns.
 * Capture groups:
 *   1 — import ... from '...'
 *   2 — import '...'
 *   3 — require('...')
 *   4 — export { ... } from '...'
 *   5 — export * from '...'
 *   6 — export type { ... } from '...'
 */
export const JS_IMPORT_RE =
  /(?:import\s+[^;]*?from\s+['"]([^'"]+)['"])|(?:import\s+['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))|(?:export\s*\{[^}]*\}\s+from\s+['"]([^'"]+)['"])|(?:export\s*\*\s+from\s+['"]([^'"]+)['"])|(?:export\s+type\s*\{[^}]*\}\s+from\s+['"]([^'"]+)['"])/gm;

function pickSpecifier(match: RegExpExecArray, isPy: boolean): string {
  if (isPy) return match[1] ?? match[3] ?? "";
  return match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? "";
}
function dependencyKind(match: RegExpExecArray, isPy: boolean): DependencyInfo["kind"] {
  if (isPy) return "import";
  if (match[3]) return "require";
  if (match[4] || match[5] || match[6]) return "re-export";
  return "import";
}
function buildDependency(code: string, match: RegExpExecArray, filePath: string, isPy: boolean): DependencyInfo | null {
  const specifier = pickSpecifier(match, isPy);
  if (!specifier || !specifier.startsWith(".")) return null;
  const lineNum = code.slice(0, match.index).split("\n").length;
  const kind = dependencyKind(match, isPy);
  try {
    const resolvedPath = isPy
      ? resolvePythonImportPath(filePath, specifier, match[2])
      : resolveImportPath(filePath, specifier);
    return { specifier, line: lineNum, resolvedPath: resolvedPath ?? undefined, kind };
  } catch {
    return { specifier, line: lineNum, kind };
  }
}
/** Extract import/require/re-export statements from source code with line refs. */
export function extractDependencies(
  code: string,
  filePath: string,
  lang: SupportedLanguage,
): DependencyInfo[] {
  const deps: DependencyInfo[] = [];
  const isPy = lang === "python";
  const importRe = isPy
    ? /^\s*(?:from\s+(\S+)\s+import\s+([A-Za-z_]\w*)|import\s+(\S+))/gm
    : JS_IMPORT_RE;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(code)) !== null) {
    const dep = buildDependency(code, match, filePath, isPy);
    if (dep) deps.push(dep);
  }
  return deps;
}

/**
 * Scan workspace source files for imports of the target file.
 * Returns files (with line refs) that import or re-export the target module.
 * Bounded: scans up to 2000 source files, ignore-aware via findSrcFiles.
 */
function matchDependentsInContent(content: string, srcFile: string, normTarget: string, isPy: boolean): DependentInfo[] {
  const importRe = isPy
    ? /(?:from\s+(\S+)\s+import\s+([A-Za-z_]\w*)|import\s+(\S+))/gm
    : JS_IMPORT_RE;
  let match: RegExpExecArray | null;
  const fileResults: DependentInfo[] = [];
  while ((match = importRe.exec(content)) !== null) {
    const specifier = pickSpecifier(match, isPy);
    if (!specifier || !specifier.startsWith(".")) continue;
    try {
      const resolved = isPy
        ? resolvePythonImportPath(srcFile, specifier, match[2])
        : resolveImportPath(srcFile, specifier);
      if (resolved && resolve(resolved) === normTarget) {
        fileResults.push({ file: srcFile, line: content.slice(0, match.index).split("\n").length, symbolName: "", kind: "import" });
      }
    } catch {
      // skip unresolvable
    }
  }
  return fileResults;
}
async function scanFileForDependents(srcFile: string, absolutePath: string, normTarget: string): Promise<DependentInfo[] | null> {
  if (srcFile === absolutePath) return null;
  let content: string;
  try {
    content = await readFile(srcFile, "utf-8");
  } catch {
    return null;
  }
  const fileResults = matchDependentsInContent(content, srcFile, normTarget, filenameToLang(srcFile) === "python");
  return fileResults.length > 0 ? fileResults : null;
}
function dedupeDependents(results: DependentInfo[]): DependentInfo[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.file)) return false;
    seen.add(r.file);
    return true;
  });
}
export async function findImportDependents(
  absolutePath: string,
  cwd: string,
  _lang: SupportedLanguage,
): Promise<DependentInfo[]> {
  const results: DependentInfo[] = [];

  let srcFiles: string[];
  try {
    srcFiles = await findSrcFiles(cwd, 2000);
  } catch {
    throw new Error("findImportDependents: could not scan workspace");
  }

  const normTarget = resolve(absolutePath);
  const concurrency = chooseConcurrency({ fileCount: srcFiles.length, operation: "parse" });
  for (let i = 0; i < srcFiles.length; i += concurrency) {
    const batch = srcFiles.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((srcFile) => scanFileForDependents(srcFile, absolutePath, normTarget)));
    for (const r of batchResults) {
      if (r) results.push(...r);
    }
  }
  return dedupeDependents(results);
}
