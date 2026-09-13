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
import { filenameToLang, type SupportedLanguage } from "./languages.js";
import { findSrcFiles } from "./file-discovery.js";
import { chooseConcurrency } from "./adaptive-concurrency.js";
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
export function resolveImportPath(
  importerPath: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const basePath = resolve(dirname(importerPath), specifier);
  for (const ext of TS_RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (isFile(candidate)) return candidate;
  }

  // TS module resolution: .js → .ts/.tsx/.jsx
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

export interface ReExportCandidate {
  barrelFile: string;
  exportName: string;
  line: number;
  kind: "named" | "wildcard" | "all";
}
export const MAX_REEXPORT_DEPTH = 5;

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

  let base = dirname(importerPath);
  for (let i = 1; i < depth; i++) {
    const parent = dirname(base);
    if (parent === base) return undefined;
    base = parent;
  }

  // Dot-only imports (`from . import x` / `from .. import x`) usually resolve
  // to the walked-up package's __init__.py. If the imported name is itself a
  // sibling module (for example `from .. import top`), prefer that concrete
  // module so dependency and dependent analysis does not stop at __init__.py.
  if (!name && importedName) {
    const importedDirInit = resolve(base, importedName, "__init__.py");
    if (isFile(importedDirInit)) return importedDirInit;
    const importedFile = resolve(base, `${importedName}.py`);
    if (isFile(importedFile)) return importedFile;
  }

  // Fall back to the package itself when the imported name is a symbol
  // exported from __init__.py or no concrete module exists.
  if (!name) {
    const pkgInit = resolve(base, "__init__.py");
    if (isFile(pkgInit)) return pkgInit;
    return undefined;
  }

  // Try directory-based module: <base>/name/__init__.py
  const dirInit = resolve(base, name, "__init__.py");
  if (isFile(dirInit)) return dirInit;

  // Try file-based module: <base>/name.py
  const fileMod = resolve(base, `${name}.py`);
  if (isFile(fileMod)) return fileMod;

  // Unresolvable — never return a non-existent path.
  return undefined;
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

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "export_statement") {
      // Find children by type (no field names for these)
      let sourceNode: Parser.SyntaxNode | null = null;
      let exportClause: Parser.SyntaxNode | null = null;
      let isWildcard = false;

      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.isNamed && child.type === "string") {
          sourceNode = child;
        } else if (child.isNamed && child.type === "export_clause") {
          exportClause = child;
        } else if (!child.isNamed && child.type === "*") {
          isWildcard = true;
        }
      }

      if (!sourceNode) return; // not a re-export (no from clause)

      const sourcePath = sourceNode.text.replace(/^["']|["']$/g, "");
      const resolved = resolveImportPath(filePath, sourcePath);

      if (isWildcard) {
        results.push({
          barrelFile: resolved ?? sourcePath,
          exportName: "*",
          line: node.startPosition.row + 1,
          kind: "wildcard",
        });
      } else if (exportClause) {
        for (let i = 0; i < exportClause.namedChildCount; i++) {
          const spec = exportClause.namedChild(i);
          if (!spec || spec.type !== "export_specifier") continue;
          const name = spec.childForFieldName("name");
          if (name) {
            results.push({
              barrelFile: resolved ?? sourcePath,
              exportName: name.text,
              line: spec.startPosition.row + 1,
              kind: "named",
            });
          }
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return results;
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

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "import_from_statement") {
      const moduleName = node.childForFieldName("module_name");
      if (!moduleName) return;

      const sourcePath = moduleName.text;
      const resolved = resolvePythonImportPath(filePath, sourcePath, node.childForFieldName("name")?.text);
      const wildcard = node.childForFieldName("wildcard");
      const name = node.childForFieldName("name");

      if (wildcard) {
        results.push({
          barrelFile: resolved ?? sourcePath,
          exportName: "*",
          line: node.startPosition.row + 1,
          kind: "wildcard",
        });
      } else if (name) {
        if (name.type === "identifier" || name.type === "dotted_name") {
          results.push({
            barrelFile: resolved ?? sourcePath,
            exportName: name.text,
            line: name.startPosition.row + 1,
            kind: "named",
          });
        } else if (
          name.type === "identifier_list" ||
          name.type === "dotted_name_list"
        ) {
          for (let i = 0; i < name.namedChildCount; i++) {
            const id = name.namedChild(i);
            if (id) {
              results.push({
                barrelFile: resolved ?? sourcePath,
                exportName: id.text,
                line: id.startPosition.row + 1,
                kind: "named",
              });
            }
          }
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return results;
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
  const fileName = basename(filePath);
  const nameWithoutExt = fileName.includes(".")
    ? fileName.slice(0, fileName.lastIndexOf("."))
    : fileName;
  const targetNorm = resolve(filePath);

  // Scan ALL source files in the same directory for re-exports
  let files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const TS_REEXT = [".ts", ".tsx", ".js", ".mjs", ".jsx"];
  const PY_REEXT = [".py"];
  const exts = lang === "python" ? PY_REEXT : TS_REEXT;

  for (const entry of files) {
    const entryName = entry;
    // Must have a known extension
    const matchedExt = exts.find((ext) => entryName.endsWith(ext));
    if (!matchedExt) continue;
    const barrelPath = resolve(dir, entryName);
    if (barrelPath === filePath) continue; // skip self
    if (!isFile(barrelPath)) continue;

    const reExports = lang === "python"
      ? extractPythonReExportsFromFile(barrelPath)
      : extractTSReExportsFromFile(barrelPath);
    for (const re of reExports) {
      const targetPath = resolve(re.barrelFile);
      if (targetPath === targetNorm) {
        results.push({
          barrelFile: barrelPath,
          exportName: re.exportName,
          line: re.line,
          kind: re.kind,
        });
        // Recurse: check if this barrel is itself re-exported
        const upstream = findBarrelReExports(
          barrelPath,
          lang,
          visited,
          depth + 1,
        );
        results.push(...upstream);
      }
    }
  }

  // Python __init__.py barrel
  if (lang === "python") {
    for (const barrelName of ["__init__", nameWithoutExt]) {
      const barrelPath = resolve(dir, `${barrelName}.py`);
      if (!isFile(barrelPath)) continue;

      const reExports = extractPythonReExportsFromFile(barrelPath);
      for (const re of reExports) {
        const resolved = resolvePythonImportPath(barrelPath, re.barrelFile);
        if (!resolved) continue;
        if (resolve(resolved) === targetNorm) {
          results.push({
            barrelFile: barrelPath,
            exportName: re.exportName,
            line: re.line,
            kind: re.kind,
          });
          const upstream = findBarrelReExports(
            barrelPath,
            lang,
            visited,
            depth + 1,
          );
          results.push(...upstream);
        }
      }
    }
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
    const specifier = isPy
      ? (match[1] ?? match[3] ?? "")
      : (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? "");
    if (!specifier) continue;
    if (!specifier.startsWith(".")) continue;
    // Relative import — try to resolve
    const lineNum = code.slice(0, match.index).split("\n").length;
    const kind: DependencyInfo["kind"] = isPy ? "import" : match[3]
      ? "require"
      : match[4] || match[5] || match[6]
        ? "re-export"
        : "import";
    try {
      const resolvedPath = isPy
        ? resolvePythonImportPath(filePath, specifier, match[2])
        : resolveImportPath(filePath, specifier);
      deps.push({ specifier, line: lineNum, resolvedPath: resolvedPath ?? undefined, kind });
    } catch {
      deps.push({ specifier, line: lineNum, kind });
    }
  }
  return deps;
}

/**
 * Scan workspace source files for imports of the target file.
 * Returns files (with line refs) that import or re-export the target module.
 * Bounded: scans up to 2000 source files, ignore-aware via findSrcFiles.
 */
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

  // Process files with bounded concurrency
  for (let i = 0; i < srcFiles.length; i += concurrency) {
    const batch = srcFiles.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (srcFile) => {
        if (srcFile === absolutePath) return null;
        let content: string;
        try {
          content = await readFile(srcFile, "utf-8");
        } catch {
          return null;
        }
        const srcLang = filenameToLang(srcFile);
        const isPy = srcLang === "python";
        const importRe = isPy
          ? /(?:from\s+(\S+)\s+import\s+([A-Za-z_]\w*)|import\s+(\S+))/gm
          : JS_IMPORT_RE;

        let match: RegExpExecArray | null;
        const fileResults: DependentInfo[] = [];
        while ((match = importRe.exec(content)) !== null) {
          const specifier = isPy
            ? (match[1] ?? match[3] ?? "")
            : (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? match[6] ?? "");
          if (!specifier || !specifier.startsWith(".")) continue;
          try {
            const resolved = isPy
              ? resolvePythonImportPath(srcFile, specifier, match[2])
              : resolveImportPath(srcFile, specifier);
            if (resolved && resolve(resolved) === normTarget) {
              const lineNum = content.slice(0, match.index).split("\n").length;
              fileResults.push({
                file: srcFile,
                line: lineNum,
                symbolName: "",
                kind: "import",
              });
            }
          } catch {
            // skip unresolvable
          }
        }
        return fileResults.length > 0 ? fileResults : null;
      }),
    );
    for (const r of batchResults) {
      if (r) results.push(...r);
    }
  }

  // Deduplicate by file
  const seen = new Set<string>();
  return results.filter(r => {
    if (seen.has(r.file)) return false;
    seen.add(r.file);
    return true;
  });
}
