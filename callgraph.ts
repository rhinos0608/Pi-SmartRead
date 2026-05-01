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
 * TypeScript/JavaScript/Python — extracting call_expression
 * nodes and mapping them to the enclosing function definition.
 */

import { readFileSync } from "node:fs";
import Parser from "tree-sitter";
import { initParser } from "./tags.js";
import type { SupportedLanguage } from "./languages.js";
import { filenameToLang } from "./languages.js";

// Re-use grammar loading from tags module
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const TypeScriptGrammar = require("tree-sitter-typescript");
const JavaScriptGrammar = require("tree-sitter-javascript");

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
 */
function findEnclosingFunction(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node;
  while (current) {
    if (
      current.type === "function_declaration" ||
      current.type === "method_definition" ||
      current.type === "arrow_function" ||
      current.type === "function_expression"
    ) {
      // Find the name
      const nameNode = current.childForFieldName("name");
      if (nameNode) return nameNode.text;

      // For methods, get the name from the property
      for (let i = 0; i < current.namedChildCount; i++) {
        const child = current.namedChild(i);
        if (child?.type === "property_identifier") {
          return child.text;
        }
      }

      // Variable assignment: const foo = () => {}
      const parent = current.parent;
      if (parent?.type === "variable_declarator") {
        const nameChild = parent.childForFieldName("name");
        if (nameChild) return nameChild.text;
      }

      return "(anonymous)";
    }

    if (
      current.type === "class_declaration" ||
      current.type === "program" ||
      current.type === "module"
    ) {
      return null; // top level, no enclosing function
    }

    current = current.parent;
  }
  return null;
}

/**
 * Check if a call expression node's function name is a simple identifier
 * (not a property access or complex expression).
 */
function getCallTargetName(callNode: Parser.SyntaxNode): string | null {
  const fnNode = callNode.childForFieldName("function");
  if (!fnNode) return null;

  if (fnNode.type === "identifier") {
    return fnNode.text;
  }

  // member_expression: obj.method()
  if (fnNode.type === "member_expression") {
    const property = fnNode.childForFieldName("property");
    if (property?.type === "property_identifier") {
      return property.text;
    }
  }

  return null;
}

/**
 * Walk a parsed tree and extract call edges.
 */
function extractCallEdges(tree: Parser.Tree, file: string): CallEdge[] {
  const edges: CallEdge[] = [];
  const seen = new Set<string>();

  function walk(node: Parser.SyntaxNode) {
    if (node.type === "call_expression") {
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
        const [callerFile, ...nameParts] = edge.caller.split(":");
        const name = nameParts.join(":");
        allFunctions.set(edge.caller, {
          name,
          file: callerFile!,
          line: 0,
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
        calleeFn.calledBy.push(edge.caller.split(":").slice(1).join(":"));
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
): Promise<{ file: string; callerFunction: string }[]> {
  await initParser();

  const results: { file: string; callerFunction: string }[] = [];
  const seen = new Set<string>();

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

    function walk(node: Parser.SyntaxNode) {
      if (node.type === "call_expression") {
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
