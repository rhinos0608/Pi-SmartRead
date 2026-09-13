// AST pattern parsing & matching — moved verbatim from search-tool.ts
// (Seam1 split). search-tool.ts re-exports the public names so existing
// `search-tool.js` import paths keep working.

import { promises as fs } from "node:fs";
import Parser from "tree-sitter";
import { loadLanguage } from "../structural/tags.js";

// ── AST Pattern Search ───────────────────────────────────────────

/**
 * Parsed representation of an AST pattern query.
 * Converts user-friendly patterns like "fn * -> Result" into structured filters.
 */
export interface ParsedAstPattern {
  /** Tree-sitter node types to search for */
  nodeTypes: string[];
  /** Whether the node must be async (null = don't care) */
  isAsync: boolean | null;
  /** Glob pattern for node name (null = any, "*" = any, "foo*" = prefix) */
  namePattern: string | null;
  /** Glob pattern for return type annotation (null = skip check) */
  returnTypePattern: string | null;
  /** Glob pattern for extends/superclass (null = skip check) */
  extendsPattern: string | null;
  /** Glob pattern for Rust impl for-type (null = skip check) */
  forTypePattern: string | null;
  /** Field type patterns for body content check (null = skip) */
  bodyFieldPatterns: string[] | null;
  /** Regex fallback for languages without tree-sitter */
  fallbackRegex: RegExp | null;
}

/** Maps user-friendly pattern keywords to tree-sitter node types */
export const AST_KEYWORD_NODE_TYPES: Record<string, string[]> = {
  fn: [
    "function_declaration",
    "function_item",
    "function_definition",
    "method_definition",
    "method_declaration",
    "function_expression",
    "arrow_function",
  ],
  class: [
    "class_declaration",
    "class_definition",
    "class_specifier",
    "class_expression",
  ],
  struct: [
    "struct_item",
    "struct_specifier",
  ],
  impl: [
    "impl_item",
  ],
  trait: [
    "trait_item",
  ],
  enum: [
    "enum_item",
    "enum_specifier",
  ],
  interface: [
    "interface_declaration",
  ],
};

export const AST_KEYWORDS = new Set(Object.keys(AST_KEYWORD_NODE_TYPES));
export const AST_QUALIFIERS = new Set(["async", "static", "pub", "public", "private", "protected", "export"]);
export const AST_RELATIONS = new Set(["extends", "for", "implements", "with", "->"]);

// Parser pool keyed by language to avoid rebuilding parsers per file
const parserPool = new Map<string, Parser>();

/** Pooled tree-sitter parser per language; avoids rebuilding parsers per file. */
function getSharedParser(lang: string, grammar: NonNullable<ReturnType<typeof loadLanguage>>): Parser {
  const cached = parserPool.get(lang);
  if (cached) return cached;
  const parser = new Parser();
  parser.setLanguage(grammar);
  parserPool.set(lang, parser);
  return parser;
}

/** Quiet file read: null on failure so callers can skip without branching. */
async function readTextFileQuiet(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Tokenize an AST pattern into tokens, normalizing parens and braces.
 *   "fn(*) -> Result"        → ["fn", "*", "->", "Result"]
 *   "class * extends Base"   → ["class", "*", "extends", "Base"]
 *   "async fn process_*"     → ["async", "fn", "process_*"]
 *   "impl * for *"           → ["impl", "*", "for", "*"]
 *   "struct * { *: String }" → ["struct", "*", "{", "*:", "String", "}"]
 */
export function tokenizeAstPattern(raw: string): string[] {
  const normalized = raw
    .replace(/\(\s*\*\s*\)/g, " * ")
    .replace(/\(/g, " ( ")
    .replace(/\)/g, " ) ")
    .replace(/\{/g, " { ")
    .replace(/\}/g, " } ");
  return normalized.trim().split(/\s+/).filter(Boolean);
}

/** Escape regex special characters */
export function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a glob pattern (with `*` as wildcard for identifiers) to a regex pattern string.
 * Handles "*", "prefix*", "*suffix", and literal patterns.
 */
export function globToRegexPattern(glob: string): string {
  if (glob === "*" || glob === "") return "[a-zA-Z_][a-zA-Z0-9_]*";
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/\*/g, "[a-zA-Z_][a-zA-Z0-9_]*");
}

/** Check if `text` matches a glob pattern (supports "*" wildcard). */
export function globMatch(text: string, pattern: string): boolean {
  if (pattern === "*" || pattern === null) return true;
  if (pattern === text) return true;
  return testGlobRegex(text, pattern);
}

function testGlobRegex(text: string, pattern: string): boolean {
  const regexStr = `^${globToRegexPattern(pattern)}$`;
  try {
    return new RegExp(regexStr).test(text);
  } catch {
    return text.includes(pattern);
  }
}

// ── Fallback-regex builders ──────────────────────────────────────

function bodyRegexForTokens(bodyTokens: string[]): string {
  if (bodyTokens.length === 0) return `\\s*\\{[^}]*\\}`;
  const literals = bodyTokens.filter((t) => t !== "*" && t !== "*:" && !t.includes("*"));
  if (literals.length === 0) return `\\s*\\{[^}]*\\}`;
  const typeCheck = literals.map((t) => `\\b${escapeRegex(t)}\\b`).join("[^}]*");
  return `\\s*\\{[^}]*${typeCheck}[^}]*\\}`;
}

/** Consume a "{ ... }" body block starting at tokens[i] === "{". Returns next index. */
function appendBodyBlockRegex(parts: string[], tokens: string[], i: number): number {
  let j = i + 1;
  const bodyTokens: string[] = [];
  while (j < tokens.length && tokens[j] !== "}") {
    bodyTokens.push(tokens[j]!);
    j++;
  }
  if (j < tokens.length) j++; // skip "}"
  parts.push(bodyRegexForTokens(bodyTokens));
  return j;
}

function isFallbackKeyword(token: string): boolean {
  return AST_KEYWORDS.has(token) || AST_QUALIFIERS.has(token) || isFallbackRelation(token);
}

function isFallbackRelation(token: string): boolean {
  return token === "extends" || token === "implements" || token === "for" || token === "with";
}

function singleTokenRegex(token: string): string {
  if (isFallbackKeyword(token)) return `\\b${token}\\b`;
  if (token === "*") return `[a-zA-Z_][a-zA-Z0-9_]*`;
  if (token === "*:") return `[a-zA-Z_][a-zA-Z0-9_]*\\s*:`;
  if (token === "->" || token === "(" || token === ")") return parenArrowRegex(token);
  const affix = affixTokenRegex(token);
  if (affix !== null) return affix;
  return `\\b${escapeRegex(token)}\\b`;
}

function parenArrowRegex(token: string): string {
  if (token === "->") return `->`;
  if (token === "(") return `\\(`;
  return `\\)`;
}

/** Prefix/suffix wildcard ("foo*", "*bar") or null when not an affix pattern. */
function affixTokenRegex(token: string): string | null {
  if (token.endsWith("*") && !token.startsWith("*") && token.length > 1) {
    const prefix = escapeRegex(token.slice(0, -1));
    return `${prefix}[a-zA-Z_][a-zA-Z0-9_]*`;
  }
  if (token.startsWith("*") && token.length > 1) {
    const suffix = escapeRegex(token.slice(1));
    return `[a-zA-Z_][a-zA-Z0-9_]*${suffix}`;
  }
  return null;
}

/**
 * Build a fallback regex from a tokenized AST pattern for languages
 * without tree-sitter support. Converts the pattern to a line-matching regex.
 */
export function buildPatternFallbackRegex(tokens: string[]): RegExp {
  const parts: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "{") {
      i = appendBodyBlockRegex(parts, tokens, i);
      continue;
    }
    parts.push(singleTokenRegex(token));
    i++;
  }
  return new RegExp(parts.join("\\s+"));
}

// ── Pattern parser ───────────────────────────────────────────────

interface AstPatternBuilder {
  qualifiers: Set<string>;
  namePattern: string | null;
  returnTypePattern: string | null;
  extendsPattern: string | null;
  forTypePattern: string | null;
  bodyFieldPatterns: string[] | null;
}

function emptyBuilder(): AstPatternBuilder {
  return {
    qualifiers: new Set<string>(),
    namePattern: null,
    returnTypePattern: null,
    extendsPattern: null,
    forTypePattern: null,
    bodyFieldPatterns: null,
  };
}

function findPatternKeyword(tokens: string[]): { keyword: string; idx: number } | null {
  for (let i = 0; i < tokens.length; i++) {
    if (AST_KEYWORDS.has(tokens[i]!)) return { keyword: tokens[i]!, idx: i };
  }
  return null;
}

function collectLeadingQualifiers(tokens: string[], keywordIdx: number, into: Set<string>): void {
  for (let i = 0; i < keywordIdx; i++) {
    if (AST_QUALIFIERS.has(tokens[i]!)) into.add(tokens[i]!);
  }
}

/** Consume "-> Type" at tokens[i]. Returns next index. */
function takeReturnType(tokens: string[], i: number, b: AstPatternBuilder): number {
  const next = tokens[i + 1];
  if (next !== undefined) b.returnTypePattern = next;
  return i + (next !== undefined ? 2 : 1);
}

/** Consume "extends Base" at tokens[i]. Returns next index. */
function takeExtends(tokens: string[], i: number, b: AstPatternBuilder): number {
  const next = tokens[i + 1];
  if (next !== undefined) b.extendsPattern = next;
  return i + (next !== undefined ? 2 : 1);
}

/** Consume "for Type" at tokens[i]. Returns next index. */
function takeForType(tokens: string[], i: number, b: AstPatternBuilder): number {
  const next = tokens[i + 1];
  if (next !== undefined) b.forTypePattern = next;
  return i + (next !== undefined ? 2 : 1);
}

function shouldSkipRelationTarget(tokens: string[], i: number): boolean {
  const t = tokens[i];
  return t !== undefined && t !== "{" && t !== "->" && !AST_RELATIONS.has(t);
}

/** Consume "implements T" / "with T" at tokens[i]. Returns next index. */
function takeImplementsWith(tokens: string[], i: number): number {
  if (shouldSkipRelationTarget(tokens, i + 1)) return i + 2;
  return i + 1;
}

function cleanBodyFieldToken(ft: string): string {
  return ft.endsWith(":") ? ft.slice(0, -1) : ft;
}

function bodyPatternsForFields(fieldTokens: string[]): string[] {
  if (fieldTokens.length === 0) return ["*"];
  const types = fieldTokens.filter((t) => t !== "*" && !AST_KEYWORDS.has(t) && !AST_QUALIFIERS.has(t) && !t.startsWith("*"));
  return types.length > 0 ? types : ["*"];
}

/** Consume "{ ... }" at tokens[i] === "{". Returns next index. */
function takeBodyBlock(tokens: string[], i: number, b: AstPatternBuilder): number {
  let j = i + 1;
  const fieldTokens: string[] = [];
  while (j < tokens.length && tokens[j] !== "}") {
    fieldTokens.push(cleanBodyFieldToken(tokens[j]!));
    j++;
  }
  if (j < tokens.length) j++; // skip "}"
  b.bodyFieldPatterns = bodyPatternsForFields(fieldTokens);
  return j;
}

function isNameToken(token: string): boolean {
  return token === "*:" || token === "*" || token.includes("*") || /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token);
}

function normalizeNameToken(token: string): string {
  if (token === "*:" || token === "*") return "*";
  return token.replace(/:$/, "");
}

/** Record name pattern once. Returns next index. */
function takeNameToken(tokens: string[], i: number, b: AstPatternBuilder): number {
  if (b.namePattern === null && isNameToken(tokens[i]!)) {
    b.namePattern = normalizeNameToken(tokens[i]!);
  }
  return i + 1;
}

function stepTypeRelationToken(tokens: string[], i: number, b: AstPatternBuilder): number {
  const token = tokens[i]!;
  if (token === "->") return takeReturnType(tokens, i, b);
  if (token === "extends") return takeExtends(tokens, i, b);
  if (token === "for") return takeForType(tokens, i, b);
  return -1;
}

function stepBlockRelationToken(tokens: string[], i: number, b: AstPatternBuilder): number {
  const token = tokens[i]!;
  if (token === "implements" || token === "with") return takeImplementsWith(tokens, i);
  if (token === "{") return takeBodyBlock(tokens, i, b);
  if (token === "(" || token === ")") return i + 1;
  return -1;
}

/** Dispatch a relation/structural token at index i. Returns next index, or -1 when not a relation token. */
function stepRelationToken(tokens: string[], i: number, b: AstPatternBuilder): number {
  const typeNext = stepTypeRelationToken(tokens, i, b);
  if (typeNext !== -1) return typeNext;
  return stepBlockRelationToken(tokens, i, b);
}

/** Dispatch one token at index i. Returns next index. */
function stepPatternToken(tokens: string[], i: number, b: AstPatternBuilder): number {
  const token = tokens[i]!;
  if (AST_QUALIFIERS.has(token)) {
    b.qualifiers.add(token);
    return i + 1;
  }
  const relNext = stepRelationToken(tokens, i, b);
  if (relNext !== -1) return relNext;
  return takeNameToken(tokens, i, b);
}

/**
 * Parse a user-friendly AST pattern string into a structured query.
 *
 * Supported patterns:
 *   fn(*) -> Result         — functions returning Result
 *   class * extends Base    — classes extending Base
 *   async fn process_*      — async functions starting with "process_"
 *   impl * for *            — trait implementations
 *   struct * { *: String }  — structs with String fields
 */
export function parseAstPattern(raw: string): ParsedAstPattern | null {
  const tokens = tokenizeAstPattern(raw);
  if (tokens.length === 0) return null;
  const found = findPatternKeyword(tokens);
  if (!found) return null;

  const b = emptyBuilder();
  collectLeadingQualifiers(tokens, found.idx, b.qualifiers);

  let i = found.idx + 1;
  while (i < tokens.length) {
    i = stepPatternToken(tokens, i, b);
  }

  const nodeTypes = AST_KEYWORD_NODE_TYPES[found.keyword] ?? [];
  return {
    nodeTypes,
    isAsync: b.qualifiers.has("async") ? true : null,
    namePattern: b.namePattern,
    returnTypePattern: b.returnTypePattern,
    extendsPattern: b.extendsPattern,
    forTypePattern: b.forTypePattern,
    bodyFieldPatterns: b.bodyFieldPatterns,
    fallbackRegex: buildPatternFallbackRegex([...tokens]),
  };
}

/**
 * Extract the "name" from a tree-sitter AST node.
 * Tries the "name" field first, then "trait" field (Rust impl),
 * then falls back to the first identifier-like child.
 */
export function getNodeName(node: Parser.SyntaxNode): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;
  const traitNode = node.childForFieldName("trait");
  if (traitNode) return traitNode.text;
  return firstIdentifierChildText(node);
}

function firstIdentifierChildText(node: Parser.SyntaxNode): string | null {
  for (const child of node.namedChildren) {
    if (child.type === "identifier" || child.type === "type_identifier" || child.type === "property_identifier") {
      return child.text;
    }
  }
  return null;
}

/**
 * Find the body child of a tree-sitter AST node.
 * Looks for children with body-like type names.
 */
export function findBodyChild(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (isBodyNodeType(child.type)) return child;
  }
  return null;
}

function isBodyNodeType(t: string): boolean {
  return (
    t.endsWith("_body") ||
    t === "body" ||
    t === "block" ||
    t === "statement_block" ||
    t === "declaration_list" ||
    t === "field_declaration_list" ||
    t === "class_body"
  );
}

// ── Node matchers (one filter each) ──────────────────────────────

/**
 * Check whether a tree-sitter AST node matches the parsed AST pattern query.
 * Applies all non-null filters from the query against the node.
 */
export function checkAstNodeMatches(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  return (
    matchesNodeType(node, query) &&
    matchesNodeName(node, query) &&
    matchesNodeAsync(node, query) &&
    matchesNodeReturnType(node, query) &&
    matchesNodeExtends(node, query) &&
    matchesNodeForType(node, query) &&
    matchesNodeBody(node, query)
  );
}

function matchesNodeType(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  return query.nodeTypes.includes(node.type);
}

function matchesNodeName(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  if (query.namePattern === null || query.namePattern === "*") return true;
  const name = getNodeName(node);
  return name !== null && globMatch(name, query.namePattern);
}

function matchesNodeAsync(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  if (query.isAsync !== true) return true;
  const firstLine = node.text.split("\n")[0] ?? "";
  return /\basync\b/.test(firstLine);
}

function matchesNodeReturnType(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  if (query.returnTypePattern === null || query.returnTypePattern === "*") return true;
  const rtNode = node.childForFieldName("return_type");
  if (rtNode) return matchesReturnTypeField(rtNode.text, query.returnTypePattern);
  return matchesReturnTypeText(node.text, query.returnTypePattern);
}

function matchesReturnTypeField(rtText: string, pattern: string): boolean {
  const cleaned = rtText.replace(/^[:\->]\s*/, "");
  return globMatch(cleaned, pattern);
}

function matchesReturnTypeText(nodeText: string, pattern: string): boolean {
  const arrowMatch = nodeText.match(/(?:->|:)\s*([A-Za-z_][A-Za-z0-9_<>[\]]*)/);
  return arrowMatch !== null && arrowMatch[1] !== undefined && globMatch(arrowMatch[1], pattern);
}

function matchesNodeExtends(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  if (query.extendsPattern === null || query.extendsPattern === "*") return true;
  if (extendsInHeritageChild(node, query.extendsPattern)) return true;
  return extendsInText(node.text, query.extendsPattern);
}

function extendsInHeritageChild(node: Parser.SyntaxNode, pattern: string): boolean {
  for (const child of node.children) {
    if (child.type === "class_heritage" || child.type === "superclass") {
      if (child.text.includes(pattern)) return true;
    }
  }
  return false;
}

function extendsInText(nodeText: string, pattern: string): boolean {
  return nodeText.includes(`extends ${pattern}`) || nodeText.includes(`extends${pattern}`);
}

function matchesNodeForType(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  if (query.forTypePattern === null || query.forTypePattern === "*") return true;
  if (node.type === "impl_item") return matchesImplForType(node, query.forTypePattern);
  return matchesForTypeText(node.text, query.forTypePattern);
}

function matchesImplForType(node: Parser.SyntaxNode, pattern: string): boolean {
  const typeNode = node.childForFieldName("type");
  return typeNode !== null && globMatch(typeNode.text, pattern);
}

function matchesForTypeText(nodeText: string, pattern: string): boolean {
  const forMatch = nodeText.match(/\bfor\s+(\S+?)\s*\{/);
  return forMatch !== null && forMatch[1] !== undefined && globMatch(forMatch[1], pattern);
}

function matchesNodeBody(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  if (query.bodyFieldPatterns === null) return true;
  if (query.bodyFieldPatterns.length === 1 && query.bodyFieldPatterns[0] === "*") return true;
  const bodyNode = findBodyChild(node);
  if (!bodyNode) return false;
  return query.bodyFieldPatterns.some((pattern) => bodyFieldTextMatches(bodyNode.text, pattern));
}

function bodyFieldTextMatches(bodyText: string, pattern: string): boolean {
  const re = new RegExp(`:\\s*${globToRegexPattern(pattern)}\\b`);
  return re.test(bodyText);
}

// ── File search ──────────────────────────────────────────────────

function parseTreeRoot(content: string, parser: Parser): Parser.Tree | null {
  const chunkSize = 1024;
  const tree = parser.parse((offset) => content.slice(offset, offset + chunkSize));
  if (!tree?.rootNode) return null;
  return tree;
}

function collectMatchingNodes(root: Parser.SyntaxNode, query: ParsedAstPattern): { node: Parser.SyntaxNode; name: string }[] {
  const results: { node: Parser.SyntaxNode; name: string }[] = [];
  const cursor = root.walk();
  while (true) {
    const node = cursor.currentNode;
    if (node && query.nodeTypes.includes(node.type) && checkAstNodeMatches(node, query)) {
      results.push({ node, name: getNodeName(node) ?? node.type });
    }
    if (advanceCursor(cursor)) continue;
    break;
  }
  return results;
}

/** Advance cursor depth-first. Returns false when traversal is complete. */
function advanceCursor(cursor: Parser.TreeCursor): boolean {
  if (cursor.gotoFirstChild()) return true;
  if (cursor.gotoNextSibling()) return true;
  return climbToNextSibling(cursor);
}

function climbToNextSibling(cursor: Parser.TreeCursor): boolean {
  while (true) {
    if (!cursor.gotoParent()) return false;
    if (cursor.gotoNextSibling()) return true;
  }
}

/**
 * Search a single file for AST nodes matching the parsed pattern.
 * Uses native tree-sitter (synchronous) — only supports grammars loaded
 * by `loadLanguage()` (TypeScript, JavaScript, TSX).
 * Other languages fall through to regex matching.
 */
export async function matchAstNodesInFile(
  filePath: string,
  lang: string,
  query: ParsedAstPattern,
): Promise<{ node: Parser.SyntaxNode; name: string }[]> {
  const grammar = loadLanguage(lang as any);
  if (!grammar) return [];
  const content = await readTextFileQuiet(filePath);
  if (content === null) return [];
  const parser = getSharedParser(lang, grammar);
  const tree = parseTreeRoot(content, parser);
  if (!tree) return [];
  return collectMatchingNodes(tree.rootNode, query);
}
