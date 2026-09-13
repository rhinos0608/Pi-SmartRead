/**
 * Structural facts extraction from source files.
 * Reuses tree-sitter (native), callgraph.ts, and import-resolution patterns.
 */
import { readFileSync, statSync, readdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import Parser from "tree-sitter";
import { createRequire } from "node:module";
import { initParser } from "./tags.js";
import { filenameToLang, type SupportedLanguage } from "../languages.js";
import type { ContextGraph } from "../context-graph.js";
import {
  extractDependencies,
  findImportDependents,
  findBarrelReExports,
} from "./structural-imports.js";
// ── Parse infra (single home; no cross-module sharing) ──

const require = createRequire(import.meta.url);
// Native tree-sitter grammars (same pattern as callgraph.ts)
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

function getLineText(code: string, line: number): string {
  const lines = code.split("\n");
  return lines[line - 1] ?? "";
}
import type {
  StructuralFacts,
  CallerInfo,
  ChildSymbol,
  ParentInfo,
  OverrideInfo,
  DependentInfo,
} from "./structural-facts-types.js";

const MAX_FILE_SIZE = 500 * 1024;

// ── Child extraction ──────────────────────────────────────────

const CHILD_KIND_BY_TYPE: Record<string, ChildSymbol["kind"]> = {
  function_declaration: "function",
  function_definition: "function",
  function_item: "function",
  method_definition: "method",
  class_declaration: "class",
  abstract_class_declaration: "class",
  class_definition: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "type_alias",
  lexical_declaration: "variable",
  variable_declaration: "variable",
  variable_declarator: "variable",
};
const VISIBILITY_BY_KEYWORD: Record<string, ChildSymbol["visibility"]> = {
  public: "public",
  private: "private",
  protected: "protected",
};
/** Single pass over modifiers: visibility keyword + override flag. */
function scanModifiers(node: Parser.SyntaxNode): { visibility: ChildSymbol["visibility"]; isOverride: boolean } {
  let visibility: ChildSymbol["visibility"];
  let isOverride = false;
  for (let j = 0; j < node.namedChildCount; j++) {
    const mod = node.namedChild(j);
    if (!mod) continue;
    if (mod.type === "accessibility_modifier") visibility = VISIBILITY_BY_KEYWORD[mod.text] ?? visibility;
    else if (mod.type === "override_modifier") isOverride = true;
  }
  return { visibility, isOverride };
}
function extractChild(node: Parser.SyntaxNode): ChildSymbol | null {
  const kind = CHILD_KIND_BY_TYPE[node.type];
  if (!kind) return null;
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const { visibility, isOverride } = scanModifiers(node);
  return { name: nameNode.text, kind, line: node.startPosition.row + 1, visibility, isExported: false, isOverride, deprecated: false };
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

interface DeclarationCollection {
  children: ChildSymbol[];
  baseClasses: ParentInfo[];
  interfaces: ParentInfo[];
}

function newDeclarationCollection(): DeclarationCollection {
  return { children: [], baseClasses: [], interfaces: [] };
}

function findHeritageNode(classNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < classNode.namedChildCount; i++) {
    const child = classNode.namedChild(i);
    if (child?.type === "class_heritage") return child;
  }
  return null;
}

function collectClauseNames(clause: Parser.SyntaxNode, kind: ParentInfo["kind"]): ParentInfo[] {
  const out: ParentInfo[] = [];
  for (let j = 0; j < clause.namedChildCount; j++) {
    const entry = clause.namedChild(j);
    if (entry) out.push({ kind, name: entry.text, line: entry.startPosition.row + 1 });
  }
  return out;
}

function extractTsHeritage(
  classNode: Parser.SyntaxNode,
): { baseClasses: ParentInfo[]; interfaces: ParentInfo[] } | null {
  const heritage = findHeritageNode(classNode);
  if (!heritage) return null;
  const baseClasses: ParentInfo[] = [];
  const interfaces: ParentInfo[] = [];
  for (let i = 0; i < heritage.namedChildCount; i++) {
    const clause = heritage.namedChild(i);
    if (!clause) continue;
    if (clause.type === "extends_clause") baseClasses.push(...collectClauseNames(clause, "class"));
    else if (clause.type === "implements_clause") interfaces.push(...collectClauseNames(clause, "interface"));
  }
  return { baseClasses, interfaces };
}

function extractPythonBases(
  classNode: Parser.SyntaxNode,
): { baseClasses: ParentInfo[]; interfaces: ParentInfo[] } {
  const baseClasses: ParentInfo[] = [];
  const superclasses = classNode.childForFieldName("superclasses");
  if (superclasses) {
    for (let i = 0; i < superclasses.namedChildCount; i++) {
      const sc = superclasses.namedChild(i);
      if (sc) baseClasses.push({ kind: "class", name: sc.text, line: sc.startPosition.row + 1 });
    }
  }
  // Python never populates interfaces.
  return { baseClasses, interfaces: [] };
}

function extractHeritage(
  classNode: Parser.SyntaxNode,
): { baseClasses: ParentInfo[]; interfaces: ParentInfo[] } {
  return extractTsHeritage(classNode) ?? extractPythonBases(classNode);
}

// ── Override detection ────────────────────────────────────────

const CLASS_NODE_TYPES = new Set(["class_declaration", "abstract_class_declaration", "class_definition"]);
const MEMBER_NODE_TYPES = new Set(["method_definition", "function_definition", "function_declaration"]);
function collectClasses(root: Parser.SyntaxNode): Map<string, Parser.SyntaxNode> {
  const classes = new Map<string, Parser.SyntaxNode>();
  function walk(node: Parser.SyntaxNode): void {
    if (CLASS_NODE_TYPES.has(node.type)) {
      const name = node.childForFieldName("name")?.text;
      if (name) classes.set(name, node);
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }
  walk(root);
  return classes;
}
function memberNames(node: Parser.SyntaxNode): Set<string> {
  const body = node.childForFieldName("body") ?? node.namedChildren.find((child) => child.type === "class_body" || child.type === "block");
  const names = new Set<string>();
  if (!body) return names;
  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i);
    const name = member?.childForFieldName("name");
    if (member && name && MEMBER_NODE_TYPES.has(member.type)) names.add(name.text);
  }
  return names;
}
function detectOverrides(
  children: ChildSymbol[], baseClasses: ParentInfo[], lang: SupportedLanguage, code: string,
): OverrideInfo[] {
  if (!baseClasses.length) return [];
  const grammar = loadGrammar(lang);
  if (!grammar) return [];
  const parser = new Parser();
  parser.setLanguage(grammar);
  const root = parseCode(parser, code).rootNode;
  const classes = collectClasses(root);
  const methods = children.filter((item) => item.kind === "method");
  const result: OverrideInfo[] = [];
  const seen = new Set<string>();
  for (const base of baseClasses) {
    const parent = classes.get(base.name);
    if (!parent) continue;
    const names = memberNames(parent);
    for (const child of methods) {
      const key = `${base.name}:${child.name}`;
      if (!names.has(child.name) || seen.has(key)) continue;
      seen.add(key);
      result.push({ methodName: child.name, parentName: base.name, line: child.line, isExplicit: lang !== "python" });
    }
  }
  return result;
}

// ── Re-export / barrel resolution lives in ./structural-imports.ts ──

export { findImportDependents } from "./structural-imports.js";


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

function extractCalleeName(fnNode: Parser.SyntaxNode): string | null {
  if (fnNode.type === "identifier") return fnNode.text;
  if (fnNode.type === "member_expression") {
    const prop = fnNode.childForFieldName("property");
    return prop?.type === "property_identifier" ? prop.text : null;
  }
  if (fnNode.type === "attribute") {
    return fnNode.childForFieldName("attribute")?.text ?? null;
  }
  return null;
}

function recordCallSite(
  node: Parser.SyntaxNode,
  code: string,
  filePath: string,
  targetNames: Set<string>,
  seen: Set<string>,
  callers: CallerInfo[],
): void {
  const fnNode = node.childForFieldName("function");
  if (!fnNode) return;
  const calleeName = extractCalleeName(fnNode);
  if (!calleeName || !targetNames.has(calleeName)) return;
  const caller = findEnclosingFunctionName(node) ?? "(top-level)";
  const callLine = node.startPosition.row + 1;
  const key = `${filePath}:${callLine}:${caller}`;
  if (seen.has(key)) return;
  seen.add(key);
  callers.push({
    file: filePath,
    line: callLine,
    symbolName: caller,
    snippet: getLineText(code, callLine),
    confidence: 1.0,
  });
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
      recordCallSite(node, code, filePath, targetNames, seen, callers);
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

// ── Import/dependency extraction lives in ./structural-imports.ts ──

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

/** Extract import/require/re-export statements from source code with line refs. */

/**
 * Scan workspace source files for imports of the target file.
 * Returns files (with line refs) that import or re-export the target module.
 * Bounded: scans up to 2000 source files, ignore-aware via findSrcFiles.
 */

// ── TS/JS fact extraction ─────────────────────────────────────

function unwrapTsExport(node: Parser.SyntaxNode): { decl: Parser.SyntaxNode; isExported: boolean } | null {
  if (node.type !== "export_statement") return { decl: node, isExported: false };
  const firstChild = node.namedChildCount > 0 ? node.namedChild(0) : null;
  if (firstChild && isDeclarationType(firstChild.type)) return { decl: firstChild, isExported: true };
  return null;
}

function pushChild(decl: Parser.SyntaxNode, isExported: boolean, acc: DeclarationCollection): void {
  const child = extractChild(decl);
  if (child) {
    child.isExported = isExported;
    acc.children.push(child);
  }
}

function appendTsClassDecl(decl: Parser.SyntaxNode, isExported: boolean, acc: DeclarationCollection): void {
  pushChild(decl, isExported, acc);
  const heritage = extractHeritage(decl);
  acc.baseClasses.push(...heritage.baseClasses);
  acc.interfaces.push(...heritage.interfaces);
  const body = findClassBody(decl);
  if (!body) return;
  for (const mc of walkClassBody(body)) {
    mc.isExported = isExported;
    acc.children.push(mc);
  }
}

function appendTsLexicalChildren(decl: Parser.SyntaxNode, isExported: boolean, acc: DeclarationCollection): void {
  for (let j = 0; j < decl.namedChildCount; j++) {
    const vd = decl.namedChild(j);
    if (vd?.type === "variable_declarator") pushChild(vd, isExported, acc);
  }
}

function appendTsJsDecl(decl: Parser.SyntaxNode, isExported: boolean, acc: DeclarationCollection): void {
  if (decl.type === "class_declaration" || decl.type === "abstract_class_declaration") {
    appendTsClassDecl(decl, isExported, acc);
  } else if (decl.type === "interface_declaration") {
    pushChild(decl, isExported, acc);
  } else if (decl.type === "function_declaration") {
    pushChild(decl, isExported, acc);
  } else if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
    appendTsLexicalChildren(decl, isExported, acc);
  } else if (decl.type === "enum_declaration" || decl.type === "type_alias_declaration") {
    pushChild(decl, isExported, acc);
  }
}

function collectTsJsDeclarations(root: Parser.SyntaxNode): DeclarationCollection {
  const acc = newDeclarationCollection();
  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;
    const unwrapped = unwrapTsExport(node);
    if (!unwrapped) continue;
    appendTsJsDecl(unwrapped.decl, unwrapped.isExported, acc);
  }
  return acc;
}

function assembleStructuralFacts(
  decls: DeclarationCollection,
  code: string,
  filePath: string,
  lang: SupportedLanguage,
  notices: string[],
): StructuralFacts {
  const parentModule = detectParentModule(filePath);
  const overrides = detectOverrides(decls.children, decls.baseClasses, lang, code);
  const reExportedBy = findBarrelReExports(filePath, lang, new Set<string>(), 0);
  const definedNames = extractDefinedNames(code, lang);
  const intras = findCallersInFile(code, filePath, definedNames);
  const cross = scanCrossFileCallers(definedNames, filePath);
  const allCallers = mergeCallers([...intras, ...cross]);
  const parentClass = decls.baseClasses.length > 0 ? decls.baseClasses[0] : undefined;
  return {
    callers: allCallers,
    dependencies: extractDependencies(code, filePath, lang),
    internalCallSites: intras,
    parentClass,
    parentModule,
    children: decls.children,
    baseClasses: decls.baseClasses,
    interfaces: decls.interfaces,
    overrides,
    reExportedBy,
    notices,
  };
}

function extractTSJSFacts(
  root: Parser.SyntaxNode,
  code: string,
  filePath: string,
  _cwd: string,
  lang: SupportedLanguage,
  notices: string[],
): StructuralFacts {
  return assembleStructuralFacts(collectTsJsDeclarations(root), code, filePath, lang, notices);
}

function findChildByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === type) return child;
  }
  return null;
}
function findClassBody(classNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return findChildByType(classNode, "class_body");
}

// ── Python fact extraction ────────────────────────────────────

function findPythonClassBody(classNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return findChildByType(classNode, "block");
}

function appendPythonClassDecl(node: Parser.SyntaxNode, acc: DeclarationCollection): void {
  const child = extractChild(node);
  if (child) acc.children.push(child);
  const heritage = extractHeritage(node);
  acc.baseClasses.push(...heritage.baseClasses);
  const body = findPythonClassBody(node);
  if (body) acc.children.push(...walkClassBody(body));
}

function appendPythonDecorated(node: Parser.SyntaxNode, acc: DeclarationCollection): void {
  const actualFn = node.namedChild(node.namedChildCount - 1);
  if (actualFn?.type === "function_definition") {
    const child = extractChild(actualFn);
    if (child) acc.children.push(child);
  } else if (actualFn?.type === "class_definition") {
    appendPythonClassDecl(actualFn, acc);
  }
}

function appendPythonNode(node: Parser.SyntaxNode, acc: DeclarationCollection): void {
  if (node.type === "class_definition") {
    appendPythonClassDecl(node, acc);
  } else if (node.type === "function_definition") {
    const child = extractChild(node);
    if (child) acc.children.push(child);
  } else if (node.type === "decorated_definition") {
    appendPythonDecorated(node, acc);
  }
}

function collectPythonDeclarations(root: Parser.SyntaxNode): DeclarationCollection {
  const acc = newDeclarationCollection();
  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;
    appendPythonNode(node, acc);
  }
  return acc;
}

function extractPythonFacts(
  root: Parser.SyntaxNode,
  code: string,
  filePath: string,
  _cwd: string,
  notices: string[],
): StructuralFacts {
  return assembleStructuralFacts(collectPythonDeclarations(root), code, filePath, "python", notices);
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
    if (isFile(barrelPath)) return barrelPath;
  }
  return undefined;
}

function emptyFacts(...notices: string[]): StructuralFacts {
  return {
    callers: [],
    dependencies: [],
    internalCallSites: [],
    children: [],
    baseClasses: [],
    interfaces: [],
    overrides: [],
    reExportedBy: [],
    notices,
  };
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
  let fileSize: number;
  try {
    fileSize = statSync(absolutePath).size;
  } catch {
    return emptyFacts("Cannot stat file");
  }
  if (fileSize > MAX_FILE_SIZE) return emptyFacts("File exceeds 500KB limit — structural facts skipped");

  // Language detection
  const lang = filenameToLang(absolutePath);
  if (!lang) return emptyFacts("Unsupported language for structural facts");

  await initParser();

  const grammar = loadGrammar(lang);
  if (!grammar) return emptyFacts("No grammar available for language: " + lang);

  let code: string;
  try {
    code = readFileSync(absolutePath, "utf-8");
  } catch {
    return emptyFacts("Cannot read file content");
  }

  const parser = new Parser();
  parser.setLanguage(grammar);
  let tree: ReturnType<Parser["parse"]> | null = null;
  try {
    tree = parseCode(parser, code);
  } catch {
    return emptyFacts("Failed to parse file");
  }
  if (!tree) return emptyFacts("Failed to parse file");

  const root = tree.rootNode;

  let facts: StructuralFacts;

  if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
    facts = extractTSJSFacts(root, code, absolutePath, cwd, lang, notices);
  } else if (lang === "python") {
    facts = extractPythonFacts(root, code, absolutePath, cwd, notices);
  } else {
    return emptyFacts(...notices, "Structural facts not yet supported for language: " + lang);
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
