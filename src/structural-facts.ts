/**
 * Structural facts extraction from source files.
 * Reuses tree-sitter (native), callgraph.ts, and import-resolution patterns.
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import Parser from "tree-sitter";
import { initParser } from "./tags.js";
import { filenameToLang, type SupportedLanguage } from "./languages.js";
import { createRequire } from "node:module";
import { findSrcFiles } from "./file-discovery.js";
import { chooseConcurrency } from "./adaptive-concurrency.js";
import type { ContextGraph } from "./context-graph.js";

const require = createRequire(import.meta.url);
// Native tree-sitter grammars (same pattern as callgraph.ts)
const TypeScriptGrammar = require("tree-sitter-typescript");
const JavaScriptGrammar = require("tree-sitter-javascript");
const PythonGrammar = require("tree-sitter-python");

const grammarCache = new Map<string, any>();
function loadGrammar(lang: SupportedLanguage): any | null {
  const cached = grammarCache.get(lang);
  if (cached) return cached;
  let grammar: any | undefined;
  if (lang === "typescript") grammar = TypeScriptGrammar.typescript;
  else if (lang === "tsx") grammar = TypeScriptGrammar.tsx;
  else if (lang === "javascript") grammar = JavaScriptGrammar;
  else if (lang === "python") grammar = PythonGrammar;
  if (!grammar) return null;
  grammarCache.set(lang, grammar);
  return grammar;
}
import type {
  StructuralFacts,
  CallerInfo,
  ChildSymbol,
  ParentInfo,
  OverrideInfo,
  ReExportInfo,
  DependentInfo,
  DependencyInfo,
} from "./structural-facts-types.js";

const MAX_FILE_SIZE = 500 * 1024;
const MAX_REEXPORT_DEPTH = 5;
const PARSE_CHUNK_SIZE = 1024;

function parseCode(parser: Parser, code: string): ReturnType<Parser["parse"]> {
  return parser.parse((offset) => code.slice(offset, offset + PARSE_CHUNK_SIZE));
}

function getLineText(code: string, line: number): string {
  const lines = code.split("\n");
  return lines[line - 1] ?? "";
}

// ── Child extraction ──────────────────────────────────────────

function extractChild(node: Parser.SyntaxNode): ChildSymbol | null {
  const type = node.type;
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;

  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  let kind: ChildSymbol["kind"];
  let visibility: ChildSymbol["visibility"] = undefined;

  if (
    type === "function_declaration" ||
    type === "function_definition" ||
    type === "function_item"
  ) {
    kind = "function";
  } else if (type === "method_definition") {
    kind = "method";
  } else if (
    type === "class_declaration" ||
    type === "abstract_class_declaration" ||
    type === "class_definition"
  ) {
    kind = "class";
  } else if (type === "interface_declaration") {
    kind = "interface";
  } else if (type === "enum_declaration") {
    kind = "enum";
  } else if (type === "type_alias_declaration") {
    kind = "type_alias";
  } else if (
    type === "lexical_declaration" ||
    type === "variable_declaration" ||
    type === "variable_declarator"
  ) {
    kind = "variable";
  } else {
    return null;
  }

  // Visibility: tree-sitter emits accessibility_modifier nodes with text = keyword
  for (let j = 0; j < node.namedChildCount; j++) {
    const mod = node.namedChild(j);
    if (!mod) continue;
    if (mod.type === "accessibility_modifier") {
      if (mod.text === "public") visibility = "public";
      else if (mod.text === "private") visibility = "private";
      else if (mod.text === "protected") visibility = "protected";
    }
  }

  // Check for override modifier (named child with type override_modifier)
  let isOverride = false;
  for (let j = 0; j < node.namedChildCount; j++) {
    const mod = node.namedChild(j);
    if (mod && mod.type === "override_modifier") {
      isOverride = true;
      break;
    }
  }

  return { name, kind, line, visibility, isExported: false, isOverride, deprecated: false };
}

function isDeclarationType(type: string): boolean {
  return (
    type === "class_declaration" ||
    type === "abstract_class_declaration" ||
    type === "interface_declaration" ||
    type === "function_declaration" ||
    type === "lexical_declaration" ||
    type === "variable_declaration" ||
    type === "enum_declaration" ||
    type === "type_alias_declaration"
  );
}

function walkClassBody(
  bodyNode: Parser.SyntaxNode,
): ChildSymbol[] {
  const children: ChildSymbol[] = [];
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const child = bodyNode.namedChild(i);
    if (!child) continue;
    // TS/JS: method_definition; Python: function_definition
    if (child.type === "method_definition" || child.type === "function_definition") {
      const cs = extractChild(child);
      if (cs) {
        // Inside a class body, these are methods
        cs.kind = "method";
        children.push(cs);
      }
    }
  }
  return children;
}

// ── Parent class / base classes / interfaces ──────────────────

function extractHeritage(
  classNode: Parser.SyntaxNode,
): { baseClasses: ParentInfo[]; interfaces: ParentInfo[] } {
  const baseClasses: ParentInfo[] = [];
  const interfaces: ParentInfo[] = [];

  // TS/JS: class_heritage child (no field name)
  let heritage: Parser.SyntaxNode | null = null;
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const child = classNode.namedChild(i);
    if (child && child.type === "class_heritage") {
      heritage = child;
      break;
    }
  }

  if (heritage) {
    for (let i = 0; i < heritage.namedChildCount; i++) {
      const clause = heritage.namedChild(i);
      if (!clause) continue;
      if (clause.type === "extends_clause") {
        for (let j = 0; j < clause.namedChildCount; j++) {
          const base = clause.namedChild(j);
          if (base) {
            baseClasses.push({
              kind: "class",
              name: base.text,
              line: base.startPosition.row + 1,
            });
          }
        }
      } else if (clause.type === "implements_clause") {
        for (let j = 0; j < clause.namedChildCount; j++) {
          const iface = clause.namedChild(j);
          if (iface) {
            interfaces.push({
              kind: "interface",
              name: iface.text,
              line: iface.startPosition.row + 1,
            });
          }
        }
      }
    }
    return { baseClasses, interfaces };
  }

  // Python: superclasses field
  const superclasses = classNode.childForFieldName("superclasses");
  if (superclasses) {
    for (let i = 0; i < superclasses.namedChildCount; i++) {
      const sc = superclasses.namedChild(i);
      if (sc) {
        baseClasses.push({
          kind: "class",
          name: sc.text,
          line: sc.startPosition.row + 1,
        });
      }
    }
  }

  return { baseClasses, interfaces };
}

// ── Override detection ────────────────────────────────────────

function detectOverrides(
  children: ChildSymbol[], baseClasses: ParentInfo[], lang: SupportedLanguage, code: string,
): OverrideInfo[] {
  if (!baseClasses.length) return [];
  const grammar = loadGrammar(lang); if (!grammar) return [];
  const parser = new Parser(); parser.setLanguage(grammar); const root = parseCode(parser, code).rootNode;
  const classes = new Map<string, Parser.SyntaxNode>();
  function walk(node: Parser.SyntaxNode): void {
    if (["class_declaration", "abstract_class_declaration", "class_definition"].includes(node.type)) { const name = node.childForFieldName("name")?.text; if (name) classes.set(name, node); }
    for (let i = 0; i < node.namedChildCount; i++) { const child = node.namedChild(i); if (child) walk(child); }
  }
  walk(root);
  function memberNames(node: Parser.SyntaxNode): Set<string> {
    const body = node.childForFieldName("body") ?? node.namedChildren.find(child => child.type === "class_body" || child.type === "block");
    const names = new Set<string>(); if (!body) return names;
    for (let i = 0; i < body.namedChildCount; i++) { const member = body.namedChild(i); const name = member?.childForFieldName("name"); if (member && name && ["method_definition", "function_definition", "function_declaration"].includes(member.type)) names.add(name.text); }
    return names;
  }
  const result: OverrideInfo[] = [];
  for (const base of baseClasses) { const parent = classes.get(base.name); if (!parent) continue; const names = memberNames(parent); for (const child of children.filter(item => item.kind === "method")) if (names.has(child.name) && !result.some(item => item.methodName === child.name && item.parentName === base.name)) result.push({ methodName: child.name, parentName: base.name, line: child.line, isExplicit: lang !== "python" }); }
  return result;
}

// ── Re-export / barrel resolution ──────────────────────────────

interface ReExportCandidate {
  barrelFile: string;
  exportName: string;
  line: number;
  kind: "named" | "wildcard" | "all";
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

function resolveImportPath(
  importerPath: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const basePath = resolve(dirname(importerPath), specifier);
  for (const ext of TS_RESOLUTION_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not found
    }
  }

  // TS module resolution: .js → .ts/.tsx/.jsx
  for (const [jsExt, tsExts] of JS_TO_TS_SUFFIX) {
    if (specifier.endsWith(jsExt)) {
      const baseNoExt = basePath.slice(0, -jsExt.length);
      for (const tsExt of tsExts) {
        const candidate = `${baseNoExt}${tsExt}`;
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch { /* not found */ }
      }
    }
  }

  return undefined;
}

function resolvePythonImportPath(
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
    try { if (statSync(importedDirInit).isFile()) return importedDirInit; } catch { /* not found */ }

    const importedFile = resolve(base, `${importedName}.py`);
    try { if (statSync(importedFile).isFile()) return importedFile; } catch { /* not found */ }
  }

  // Fall back to the package itself when the imported name is a symbol
  // exported from __init__.py or no concrete module exists.
  if (!name) {
    const pkgInit = resolve(base, "__init__.py");
    try { if (statSync(pkgInit).isFile()) return pkgInit; } catch { /* not found */ }
    return undefined;
  }

  // Try directory-based module: <base>/name/__init__.py
  const dirInit = resolve(base, name, "__init__.py");
  try { if (statSync(dirInit).isFile()) return dirInit; } catch { /* not found */ }

  // Try file-based module: <base>/name.py
  const fileMod = resolve(base, `${name}.py`);
  try { if (statSync(fileMod).isFile()) return fileMod; } catch { /* not found */ }

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

function findBarrelReExports(
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
    try { if (!statSync(barrelPath).isFile()) continue; } catch { continue; }

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
      try { if (!statSync(barrelPath).isFile()) continue; } catch { continue; }

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

// ── Caller extraction ─────────────────────────────────────────

function extractDefinedNames(code: string, lang: SupportedLanguage): Set<string> {
  const names = new Set<string>();

  const grammar = loadGrammar(lang);
  if (!grammar) return names;

  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parseCode(parser, code);
  const root = tree.rootNode;

  function walk(node: Parser.SyntaxNode) {
    if (
      node.type === "function_declaration" ||
      node.type === "function_definition" ||
      node.type === "method_definition" ||
      node.type === "function_item" ||
      node.type === "class_declaration" ||
      node.type === "abstract_class_declaration" ||
      node.type === "class_definition"
    ) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) names.add(nameNode.text);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return names;
}

function findCallersInFile(
  code: string,
  filePath: string,
  targetNames: Set<string>,
): CallerInfo[] {
  const callers: CallerInfo[] = [];
  const seen = new Set<string>();

  const lang = filenameToLang(filePath);
  if (!lang) return [];

  const grammar = loadGrammar(lang);
  if (!grammar) return [];

  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parseCode(parser, code);
  const root = tree.rootNode;

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "call_expression" || node.type === "call") {
      const fnNode = node.childForFieldName("function");
      if (!fnNode) return;

      let calleeName: string | null = null;
      if (fnNode.type === "identifier") {
        calleeName = fnNode.text;
      } else if (fnNode.type === "member_expression") {
        const prop = fnNode.childForFieldName("property");
        if (prop?.type === "property_identifier") calleeName = prop.text;
      } else if (fnNode.type === "attribute") {
        const attr = fnNode.childForFieldName("attribute");
        if (attr) calleeName = attr.text;
      }

      if (calleeName && targetNames.has(calleeName)) {
        const caller = findEnclosingFunctionName(node) ?? "(top-level)";
        const callLine = node.startPosition.row + 1;
        const key = `${filePath}:${callLine}:${caller}`;
        if (!seen.has(key)) {
          seen.add(key);
          callers.push({
            file: filePath,
            line: callLine,
            symbolName: caller,
            snippet: getLineText(code, callLine),
            confidence: 1.0,
          });
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return callers;
}

function findEnclosingFunctionName(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (
      current.type === "function_declaration" ||
      current.type === "function_definition" ||
      current.type === "method_definition" ||
      current.type === "function_item"
    ) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) return nameNode.text;
      return "(anonymous)";
    }
    if (
      current.type === "class_declaration" ||
      current.type === "abstract_class_declaration" ||
      current.type === "class_definition" ||
      current.type === "program" ||
      current.type === "module" ||
      current.type === "source_file"
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
}

function scanCrossFileCallers(
  targetNames: Set<string>,
  targetFile: string,
): CallerInfo[] {
  if (targetNames.size === 0) return [];

  const results: CallerInfo[] = [];
  const targetDir = dirname(targetFile);
  let siblingFiles: string[];

  try {
    const entries = readdirSync(targetDir, { withFileTypes: true });
    siblingFiles = entries
      .filter((e) => e.isFile())
      .map((e) => resolve(targetDir, e.name))
      .filter((fp) => fp !== targetFile && filenameToLang(fp));
  } catch {
    return [];
  }

  for (const file of siblingFiles) {
    try {
      const code = readFileSync(file, "utf-8");
      const callers = findCallersInFile(code, file, targetNames);
      for (const c of callers) {
        if (c.file !== targetFile) {
          results.push(c);
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  return results;
}

function mergeCallers(callers: CallerInfo[]): CallerInfo[] {
  const seen = new Set<string>();
  const merged: CallerInfo[] = [];
  for (const c of callers) {
    const key = `${c.file}:${c.line}:${c.symbolName}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }
  return merged;
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
const JS_IMPORT_RE =
  /(?:import\s+[^;]*?from\s+['"]([^'"]+)['"])|(?:import\s+['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))|(?:export\s*\{[^}]*\}\s+from\s+['"]([^'"]+)['"])|(?:export\s*\*\s+from\s+['"]([^'"]+)['"])|(?:export\s+type\s*\{[^}]*\}\s+from\s+['"]([^'"]+)['"])/gm;

/** Extract import/require/re-export statements from source code with line refs. */
function extractDependencies(
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

// ── TS/JS fact extraction ─────────────────────────────────────

function extractTSJSFacts(
  root: Parser.SyntaxNode,
  code: string,
  filePath: string,
  _cwd: string,
  lang: SupportedLanguage,
  notices: string[],
): StructuralFacts {
  let parentClass: ParentInfo | undefined;
  let parentModule: string | undefined;
  const baseClasses: ParentInfo[] = [];
  const interfaces: ParentInfo[] = [];
  const children: ChildSymbol[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    // Determine if this is an exported declaration or a standalone statement
    let decl = node;
    let isExported = false;

    if (node.type === "export_statement") {
      // Get the first named child that is a declaration type
      const firstChild = node.namedChildCount > 0 ? node.namedChild(0) : null;
      if (firstChild && isDeclarationType(firstChild.type)) {
        decl = firstChild;
        isExported = true;
      } else {
        // Re-export or other non-declaration export — skip
        continue;
      }
    }

    if (
      decl.type === "class_declaration" ||
      decl.type === "abstract_class_declaration" ||
      decl.type === "interface_declaration"
    ) {
      const child = extractChild(decl);
      if (child) {
        child.isExported = isExported;
        children.push(child);
      }

      // Class heritage for class_declaration and abstract_class_declaration
      if (
        decl.type === "class_declaration" ||
        decl.type === "abstract_class_declaration"
      ) {
        const heritage = extractHeritage(decl);
        baseClasses.push(...heritage.baseClasses);
        interfaces.push(...heritage.interfaces);

        // Walk class body for methods
        const body = findClassBody(decl);
        if (body) {
          const methodChildren = walkClassBody(body);
          for (const mc of methodChildren) {
            mc.isExported = isExported;
            children.push(mc);
          }
        }
      }
    } else if (
      decl.type === "function_declaration"
    ) {
      const child = extractChild(decl);
      if (child) {
        child.isExported = isExported;
        children.push(child);
      }
    } else if (
      decl.type === "lexical_declaration" ||
      decl.type === "variable_declaration"
    ) {
      // lexical_declaration has no 'name' field — iterate variable_declarator children
      for (let j = 0; j < decl.namedChildCount; j++) {
        const vd = decl.namedChild(j);
        if (vd && vd.type === "variable_declarator") {
          const child = extractChild(vd);
          if (child) {
            child.isExported = isExported;
            children.push(child);
          }
        }
      }
    } else if (
      decl.type === "enum_declaration" ||
      decl.type === "type_alias_declaration"
    ) {
      const child = extractChild(decl);
      if (child) {
        child.isExported = isExported;
        children.push(child);
      }
    }
  }

  parentModule = detectParentModule(filePath);
  const overrides = detectOverrides(children, baseClasses, lang, code);

  const reExportedBy = findBarrelReExports(
    filePath,
    lang,
    new Set<string>(),
    0,
  );

  const definedNames = extractDefinedNames(code, lang);
  const intras = findCallersInFile(code, filePath, definedNames);
  const cross = scanCrossFileCallers(definedNames, filePath);
  const allCallers = mergeCallers([...intras, ...cross]);

  if (baseClasses.length > 0) {
    parentClass = baseClasses[0];
  }

  return {
    callers: allCallers,
    dependencies: extractDependencies(code, filePath, lang),
    internalCallSites: intras,
    parentClass,
    parentModule,
    children,
    baseClasses,
    interfaces,
    overrides,
    reExportedBy,
    notices,
  };
}

function findClassBody(classNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const child = classNode.namedChild(i);
    if (child && child.type === "class_body") return child;
  }
  return null;
}

// ── Python fact extraction ────────────────────────────────────

function findPythonClassBody(classNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const child = classNode.namedChild(i);
    if (child && child.type === "block") return child;
  }
  return null;
}

function extractPythonFacts(
  root: Parser.SyntaxNode,
  code: string,
  filePath: string,
  _cwd: string,
  notices: string[],
): StructuralFacts {
  let parentClass: ParentInfo | undefined;
  let parentModule: string | undefined;
  const baseClasses: ParentInfo[] = [];
  const interfaces: ParentInfo[] = [];
  const children: ChildSymbol[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    if (node.type === "class_definition") {
      const child = extractChild(node);
      if (child) children.push(child);

      const heritage = extractHeritage(node);
      baseClasses.push(...heritage.baseClasses);

      // Python class body is a "block" child (no field name)
      const body = findPythonClassBody(node);
      if (body) {
        const methodChildren = walkClassBody(body);
        children.push(...methodChildren);
      }
    } else if (node.type === "function_definition") {
      const child = extractChild(node);
      if (child) children.push(child);
    } else if (node.type === "decorated_definition") {
      // Last named child is the actual definition
      const actualFn = node.namedChild(node.namedChildCount - 1);
      if (actualFn && actualFn.type === "function_definition") {
        const child = extractChild(actualFn);
        if (child) children.push(child);
      } else if (actualFn && actualFn.type === "class_definition") {
        const child = extractChild(actualFn);
        if (child) children.push(child);
        const heritage = extractHeritage(actualFn);
        baseClasses.push(...heritage.baseClasses);
        const body = findPythonClassBody(actualFn);
        if (body) {
          const methodChildren = walkClassBody(body);
          children.push(...methodChildren);
        }
      }
    }
  }

  parentModule = detectParentModule(filePath);
  const overrides = detectOverrides(children, baseClasses, "python", code);

  const reExportedBy = findBarrelReExports(
    filePath,
    "python",
    new Set<string>(),
    0,
  );

  const definedNames = extractDefinedNames(code, "python");
  const intras = findCallersInFile(code, filePath, definedNames);
  const cross = scanCrossFileCallers(definedNames, filePath);
  const allCallers = mergeCallers([...intras, ...cross]);

  if (baseClasses.length > 0) {
    parentClass = baseClasses[0];
  }

  return {
    callers: allCallers,
    dependencies: extractDependencies(code, filePath, "python"),
    internalCallSites: intras,
    parentClass,
    parentModule,
    children,
    baseClasses,
    interfaces,
    overrides,
    reExportedBy,
    notices,
  };
}

function detectParentModule(filePath: string): string | undefined {
  const fileName = basename(filePath);
  if (
    fileName === "index.ts" ||
    fileName === "index.tsx" ||
    fileName === "index.js" ||
    fileName === "__init__.py"
  ) {
    return undefined;
  }

  const dir = dirname(filePath);
  for (const barrel of ["index.ts", "index.tsx", "index.js", "__init__.py"]) {
    const barrelPath = resolve(dir, barrel);
    try { if (statSync(barrelPath).isFile()) return barrelPath; } catch { continue; }
  }
  return undefined;
}

// ── Exported main function ────────────────────────────────────

export async function extractStructuralFacts(
  absolutePath: string,
  cwd: string,
  _signal?: AbortSignal,
  contextGraph?: ContextGraph,
): Promise<StructuralFacts> {
  const notices: string[] = [];

  // File size check
  try {
    const st = statSync(absolutePath);
    if (st.size > MAX_FILE_SIZE) {
      return {
        callers: [],
        dependencies: [],
        internalCallSites: [],
        children: [],
        baseClasses: [],
        interfaces: [],
        overrides: [],
        reExportedBy: [],
        notices: ["File exceeds 500KB limit — structural facts skipped"],
      };
    }
  } catch {
    return {
      callers: [],
      dependencies: [],
      internalCallSites: [],
      children: [],
      baseClasses: [],
      interfaces: [],
      overrides: [],
      reExportedBy: [],
      notices: ["Cannot stat file"],
    };
  }

  // Language detection
  const lang = filenameToLang(absolutePath);
  if (!lang) {
    return {
      callers: [],
      dependencies: [],
      internalCallSites: [],
      children: [],
      baseClasses: [],
      interfaces: [],
      overrides: [],
      reExportedBy: [],
      notices: ["Unsupported language for structural facts"],
    };
  }

  await initParser();

  const grammar = loadGrammar(lang);
  if (!grammar) {
    return {
      callers: [],
      dependencies: [],
      internalCallSites: [],
      children: [],
      baseClasses: [],
      interfaces: [],
      overrides: [],
      reExportedBy: [],
      notices: ["No grammar available for language: " + lang],
    };
  }

  let code: string;
  try {
    code = readFileSync(absolutePath, "utf-8");
  } catch {
    return {
      callers: [],
      dependencies: [],
      internalCallSites: [],
      children: [],
      baseClasses: [],
      interfaces: [],
      overrides: [],
      reExportedBy: [],
      notices: ["Cannot read file content"],
    };
  }

  const parser = new Parser();
  parser.setLanguage(grammar);
  let tree: ReturnType<Parser["parse"]> | null = null;
  try {
    tree = parseCode(parser, code);
  } catch {
    return {
      callers: [],
      dependencies: [],
      internalCallSites: [],
      children: [],
      baseClasses: [],
      interfaces: [],
      overrides: [],
      reExportedBy: [],
      notices: ["Failed to parse file"],
    };
  }

  if (!tree) {
    return {
      callers: [],
      dependencies: [],
      internalCallSites: [],
      children: [],
      baseClasses: [],
      interfaces: [],
      overrides: [],
      reExportedBy: [],
      notices: ["Failed to parse file"],
    };
  }

  const root = tree.rootNode;

  let facts: StructuralFacts;

  if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
    facts = extractTSJSFacts(root, code, absolutePath, cwd, lang, notices);
  } else if (lang === "python") {
    facts = extractPythonFacts(root, code, absolutePath, cwd, notices);
  } else {
    return {
      callers: [],
      dependencies: [],
      internalCallSites: [],
      children: [],
      baseClasses: [],
      interfaces: [],
      overrides: [],
      reExportedBy: [],
      notices: [...notices, "Structural facts not yet supported for language: " + lang],
    };
  }

  // Async scan for external dependents (best-effort, import-based)
  // Use contextGraph if available, otherwise fall back to file scan
  if (contextGraph && typeof contextGraph.getProvenanceEdges === "function") {
    try {
      const normTarget = resolve(cwd, absolutePath);
      const edges = typeof (contextGraph as any).getImportDependents === "function"
        ? (contextGraph as any).getImportDependents(absolutePath).map((from: string) => ({ from, to: normTarget }))
        : contextGraph.getProvenanceEdges();
      const dependents: DependentInfo[] = [];
      const seen = new Set<string>();
      for (const edge of edges) {
        if (resolve(cwd, edge.to) === normTarget) {
          if (seen.has(edge.from)) continue;
          seen.add(edge.from);
          dependents.push({
            file: edge.from,
            line: 0,
            symbolName: "",
            kind: "import",
          });
        }
      }
      // A built graph is authoritative, including an empty match; do not rescan.
      facts.externalDependents = dependents;
    } catch {
      // best-effort: leave externalDependents empty
    }
  } else {
    try {
      const dependents = await findImportDependents(absolutePath, cwd, lang);
      facts.externalDependents = dependents;
    } catch {
      // best-effort: leave externalDependents empty
    }
  }

  return facts;
}
