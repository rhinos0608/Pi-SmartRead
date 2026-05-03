/**
 * Call graph extraction from tree-sitter ASTs.
 *
 * Builds a directed graph of function-call relationships:
 *   function X calls function Y, Z
 *
 * Enables queries like "find all callers of getConfig" or
 * "what does initApp call?"
 *
 * Works by post-processing tree-sitter parsed CSTs for
 * TypeScript/JavaScript/Python/Go/Rust — extracting call_expression
 * nodes and mapping them to the enclosing function definition.
 */

import { readFileSync } from "node:fs";
import Parser from "tree-sitter";
import { initParser } from "./tags.js";
import type { SupportedLanguage } from "./languages.js";
import { filenameToLang } from "./languages.js";

// Re-use grammar loading from tags module
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const TypeScriptGrammar = require("tree-sitter-typescript");
const JavaScriptGrammar = require("tree-sitter-javascript");
const PythonGrammar = require("tree-sitter-python");
const GoGrammar = require("tree-sitter-go");
const RustGrammar = require("tree-sitter-rust");

type Grammar = Parameters<Parser["setLanguage"]>[0];
const languageCache = new Map<string, Grammar>();
const PARSE_CHUNK_SIZE = 1024;

function loadGrammar(lang: SupportedLanguage): Grammar | null {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  let language: Grammar | undefined;
  if (lang === "typescript") language = TypeScriptGrammar.typescript as Grammar;
  else if (lang === "tsx") language = TypeScriptGrammar.tsx as Grammar;
  else if (lang === "javascript") language = JavaScriptGrammar as Grammar;
  else if (lang === "python") language = PythonGrammar as Grammar;
  else if (lang === "go") language = GoGrammar as Grammar;
  else if (lang === "rust") language = RustGrammar as Grammar;

  if (!language) return null;

  languageCache.set(lang, language);
  return language;
}

function parseCode(parser: Parser, code: string): ReturnType<Parser["parse"]> {
  return parser.parse((offset) => code.slice(offset, offset + PARSE_CHUNK_SIZE));
}

// ── Types ─────────────────────────────────────────────────────────

export interface CallEdge {
  /** Fully qualified caller: file:functionName */
  caller: string;
  /** Fully qualified callee: file:functionName (or just name for external calls) */
  callee: string;
  /** True if callee was resolved to a definition somewhere */
  resolved: boolean;
  /** Source line of the call site (0 if unavailable) */
  callerLine?: number;
}

export interface FunctionInfo {
  name: string;
  file: string;
  line: number;
  /** Other functions this function calls */
  calls: string[];
  /** Functions that call this one */
  calledBy: string[];
}

export interface CallGraphResult {
  functions: FunctionInfo[];
  callersOf: (name: string) => FunctionInfo[];
  calleesOf: (name: string) => FunctionInfo[];
  /** Total unique edges in the graph */
  edgeCount: number;
}

// ── Tree-sitter AST walking helpers ───────────────────────────────

/**
 * Find the enclosing function name for a node by walking up the tree.
 *
 * Supports TypeScript/JavaScript, Python, Go, and Rust AST node types.
 */
function findEnclosingFunction(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    // TypeScript/JavaScript: function_declaration, method_definition, etc.
    if (
      current.type === "function_declaration" ||
      current.type === "method_definition" ||
      current.type === "arrow_function" ||
      current.type === "function_expression"
    ) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) return nameNode.text;

      for (let i = 0; i < current.namedChildCount; i++) {
        const child = current.namedChild(i);
        if (child?.type === "property_identifier") {
          return child.text;
        }
      }

      const parent = current.parent;
      if (parent?.type === "variable_declarator") {
        const nameChild = parent.childForFieldName("name");
        if (nameChild) return nameChild.text;
      }

      return "(anonymous)";
    }

    // Python: function_definition (def keyword, indentation-scoped)
    if (current.type === "function_definition") {
      const nameNode = current.childForFieldName("name");
      if (nameNode) return nameNode.text;
      return "(anonymous)";
    }

    // Go: function_declaration and method_declaration
    if (
      current.type === "function_declaration" ||
      current.type === "method_declaration"
    ) {
      const nameNode = current.childForFieldName("name");
      if (nameNode) return nameNode.text;
      return "(anonymous)";
    }

    // Rust: function_item (fn keyword)
    if (current.type === "function_item") {
      const nameNode = current.childForFieldName("name");
      if (nameNode) return nameNode.text;
      return "(anonymous)";
    }

    // Stop at top-level containers
    if (
      current.type === "class_declaration" ||
      current.type === "class_definition" ||
      current.type === "impl_item" ||
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

/**
 * Check if a call expression node's function name is a simple identifier
 * (not a property access or complex expression).
 *
 * Supports TS/JS member_expression, Python attribute, Go selector_expression,
 * and Rust scoped_identifier / field_expression.
 */
function getCallTargetName(callNode: Parser.SyntaxNode): string | null {
  const fnNode = callNode.childForFieldName("function");
  if (!fnNode) return null;

  // Simple identifier: foo()
  if (fnNode.type === "identifier") {
    return fnNode.text;
  }

  // TS/JS member_expression: obj.method()
  if (fnNode.type === "member_expression") {
    const property = fnNode.childForFieldName("property");
    if (property?.type === "property_identifier") {
      return property.text;
    }
  }

  // Python attribute: obj.method() or self.repo.find()
  // The attribute node has an "attribute" field for the method name
  if (fnNode.type === "attribute") {
    const attrNode = fnNode.childForFieldName("attribute");
    if (attrNode) return attrNode.text;
    // Fallback: last child is typically the attribute name
    const lastChild = fnNode.namedChildren[fnNode.namedChildCount - 1];
    if (lastChild) return lastChild.text;
  }

  // Go selector_expression: pkg.Func() or obj.Method()
  if (fnNode.type === "selector_expression") {
    const field = fnNode.childForFieldName("field");
    if (field) return field.text;
    // Fallback: last child is the selected field
    const lastChild = fnNode.namedChildren[fnNode.namedChildCount - 1];
    if (lastChild) return lastChild.text;
  }

  // Rust scoped_identifier: Module::func() or Type::method()
  if (fnNode.type === "scoped_identifier") {
    const lastChild = fnNode.namedChildren[fnNode.namedChildCount - 1];
    if (lastChild) return lastChild.text;
  }

  // Rust field_expression: obj.method()
  if (fnNode.type === "field_expression") {
    const field = fnNode.childForFieldName("field");
    if (field) return field.text;
    const lastChild = fnNode.namedChildren[fnNode.namedChildCount - 1];
    if (lastChild) return lastChild.text;
  }

  return null;
}

/**
 * Walk a parsed tree and extract call edges.
 *
 * Handles call_expression (TS/JS/Python/Go/Rust) and
 * macro_invocation (Rust: println!, vec!, etc.).
 */
function extractCallEdges(tree: Parser.Tree, file: string): CallEdge[] {
  const edges: CallEdge[] = [];
  const seen = new Set<string>();

  function walk(node: Parser.SyntaxNode) {
    // Standard call expressions (all supported languages)
    // Python uses "call" instead of "call_expression"
    if (node.type === "call_expression" || node.type === "call") {
      const caller = findEnclosingFunction(node);
      const callee = getCallTargetName(node);

      if (caller && callee) {
        const key = `${file}:${caller}→${callee}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            caller: `${file}:${caller}`,
            callee,
            resolved: false,
            callerLine: node.startPosition.row + 1,
          });
        }
      }
    }

    // Rust macro invocations: println!("..."), vec![...], format!(...)
    // Treat macro name as a call target for completeness.
    if (node.type === "macro_invocation") {
      const caller = findEnclosingFunction(node);
      const macroNameNode = node.childForFieldName("macro");
      if (caller && macroNameNode) {
        const callee = macroNameNode.text;
        const key = `${file}:${caller}→${callee}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({
            caller: `${file}:${caller}`,
            callee,
            resolved: false,
            callerLine: node.startPosition.row + 1,
          });
        }
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(tree.rootNode);
  return edges;
}

/**
 * Build a call graph from the given files.
 *
 * For each file:
 *   1. Parse with tree-sitter
 *   2. Walk the AST for call_expression nodes
 *   3. Map each call to its enclosing function
 *
 * Returns a graph with query helpers.
 */
export async function buildCallGraph(
  files: string[],
): Promise<CallGraphResult> {
  await initParser();

  const allEdges: CallEdge[] = [];
  const allFunctions = new Map<string, FunctionInfo>();

  for (const file of files) {
    const lang = filenameToLang(file);
    if (!lang) continue;

    const grammar = loadGrammar(lang);
    if (!grammar) continue;

    let code: string;
    try {
      code = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parseCode(parser, code);

    const edges = extractCallEdges(tree, file);
    allEdges.push(...edges);

    // Register functions from caller edges
    for (const edge of edges) {
      if (!allFunctions.has(edge.caller)) {
        const callerIdx = edge.caller.lastIndexOf(":");
        const callerFile = edge.caller.slice(0, callerIdx);
        const name = edge.caller.slice(callerIdx + 1);
        allFunctions.set(edge.caller, {
          name,
          file: callerFile,
          line: edge.callerLine ?? 0,
          calls: [],
          calledBy: [],
        });
      }
    }
  }

  // ── Resolve callees to known functions ──
  const allFunctionNames = new Set<string>();
  for (const [, fn] of allFunctions) {
    allFunctionNames.add(fn.name);
  }

  for (const edge of allEdges) {
    const callerFn = allFunctions.get(edge.caller);
    if (callerFn) {
      callerFn.calls.push(edge.callee);
    }

    // Try to resolve callee to a known function
    const calleeKey = [...allFunctions.keys()].find((k) => k.endsWith(`:${edge.callee}`));
    if (calleeKey) {
      const calleeFn = allFunctions.get(calleeKey);
      if (calleeFn) {
        const callerIdx = edge.caller.lastIndexOf(":");
        calleeFn.calledBy.push(edge.caller.slice(callerIdx + 1));
        edge.resolved = true;
      }
    }
  }

  return {
    functions: [...allFunctions.values()],
    callersOf: (name: string) =>
      [...allFunctions.values()].filter((f) => f.calls.includes(name)),
    calleesOf: (name: string) => {
      const fn = [...allFunctions.values()].find((f) => f.name === name);
      if (!fn) return [];
      return fn.calls
        .map((callee) =>
          [...allFunctions.values()].find((f) => f.name === callee),
        )
        .filter(Boolean) as FunctionInfo[];
    },
    edgeCount: allEdges.length,
  };
}

/**
 * Lightweight: find all callers of a specific function name.
 * This is the most useful query — doesn't need full graph construction.
 */
export async function findCallers(
  files: string[],
  targetFunction: string,
  signal?: AbortSignal,
): Promise<{ file: string; callerFunction: string }[]> {
  await initParser();

  const results: { file: string; callerFunction: string }[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (signal?.aborted) return [];
    const lang = filenameToLang(file);
    if (!lang) continue;

    const grammar = loadGrammar(lang);
    if (!grammar) continue;

    let code: string;
    try {
      code = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parseCode(parser, code);

    function walk(node: Parser.SyntaxNode) {
      if (signal?.aborted) return;
      // Python uses "call" instead of "call_expression"
      if (node.type === "call_expression" || node.type === "call") {
        const callee = getCallTargetName(node);
        if (callee === targetFunction) {
          const caller = findEnclosingFunction(node);
          if (caller) {
            const key = `${file}:${caller}`;
            if (!seen.has(key)) {
              seen.add(key);
              results.push({ file, callerFunction: caller });
            }
          }
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walk(child);
      }
    }

    walk(tree.rootNode);
  }

  return results;
}
