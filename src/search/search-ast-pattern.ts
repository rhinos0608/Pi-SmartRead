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
  let parser = parserPool.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(grammar);
    parserPool.set(lang, parser);
  }
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
  const regexStr = `^${globToRegexPattern(pattern)}$`;
  try {
    return new RegExp(regexStr).test(text);
  } catch {
    return text.includes(pattern);
  }
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

    // Body block: match { ... } with flexible content
    if (token === "{") {
      i++;
      const bodyTokens: string[] = [];
      while (i < tokens.length && tokens[i] !== "}") {
        bodyTokens.push(tokens[i]!);
        i++;
      }
      if (i < tokens.length) i++; // skip "}"

      if (bodyTokens.length === 0) {
        parts.push(`\\s*\\{[^}]*\\}`);
      } else {
        // Extract literal type names (non-wildcard) for body matching
        const literals = bodyTokens.filter(
          (t) => t !== "*" && t !== "*:" && !t.includes("*"),
        );
        if (literals.length > 0) {
          const typeCheck = literals.map((t) => `\\b${escapeRegex(t)}\\b`).join("[^}]*");
          parts.push(`\\s*\\{[^}]*${typeCheck}[^}]*\\}`);
        } else {
          parts.push(`\\s*\\{[^}]*\\}`);
        }
      }
      continue;
    }

    // Keywords and qualifiers
    if (
      AST_KEYWORDS.has(token) ||
      AST_QUALIFIERS.has(token) ||
      token === "extends" ||
      token === "implements" ||
      token === "for" ||
      token === "with"
    ) {
      parts.push(`\\b${token}\\b`);
    } else if (token === "*") {
      parts.push(`[a-zA-Z_][a-zA-Z0-9_]*`);
    } else if (token === "*:") {
      parts.push(`[a-zA-Z_][a-zA-Z0-9_]*\\s*:`);
    } else if (token === "->") {
      parts.push(`->`);
    } else if (token === "(") {
      parts.push(`\\(`);
    } else if (token === ")") {
      parts.push(`\\)`);
    } else if (token.endsWith("*") && !token.startsWith("*") && token.length > 1) {
      // prefix* → prefix followed by identifier
      const prefix = escapeRegex(token.slice(0, -1));
      parts.push(`${prefix}[a-zA-Z_][a-zA-Z0-9_]*`);
    } else if (token.startsWith("*") && token.length > 1) {
      // *suffix → identifier followed by suffix
      const suffix = escapeRegex(token.slice(1));
      parts.push(`[a-zA-Z_][a-zA-Z0-9_]*${suffix}`);
    } else {
      parts.push(`\\b${escapeRegex(token)}\\b`);
    }
    i++;
  }

  return new RegExp(parts.join("\\s+"));
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

  // Find the structural keyword (fn, class, struct, impl, trait, enum, interface)
  let keyword: string | null = null;
  let keywordIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (AST_KEYWORDS.has(tokens[i]!)) {
      keyword = tokens[i]!;
      keywordIdx = i;
      break;
    }
  }
  if (!keyword) return null;

  const qualifiers = new Set<string>();
  let namePattern: string | null = null;
  let returnTypePattern: string | null = null;
  let extendsPattern: string | null = null;
  let forTypePattern: string | null = null;
  let bodyFieldPatterns: string[] | null = null;

  // Collect qualifiers before keyword
  for (let i = 0; i < keywordIdx; i++) {
    if (AST_QUALIFIERS.has(tokens[i]!)) {
      qualifiers.add(tokens[i]!);
    }
  }

  // Keep full token list for regex fallback building
  const allTokens = [...tokens];

  // Parse tokens after keyword
  let i = keywordIdx + 1;
  while (i < tokens.length) {
    const token = tokens[i]!;

    // Qualifiers can appear after keyword too
    if (AST_QUALIFIERS.has(token)) {
      qualifiers.add(token);
      i++;
      continue;
    }

    // Return type: -> Type
    if (token === "->") {
      i++;
      if (i < tokens.length) {
        returnTypePattern = tokens[i]!;
        i++;
      }
      continue;
    }

    // Extends: extends Base
    if (token === "extends") {
      i++;
      if (i < tokens.length) {
        extendsPattern = tokens[i]!;
        i++;
      }
      continue;
    }

    // For-type (Rust impl): for Type
    if (token === "for") {
      i++;
      if (i < tokens.length) {
        forTypePattern = tokens[i]!;
        i++;
      }
      continue;
    }

    // implements / with — just skip the type name
    if (token === "implements" || token === "with") {
      i++;
      if (
        i < tokens.length &&
        tokens[i] !== "{" &&
        tokens[i] !== "->" &&
        !AST_RELATIONS.has(tokens[i]!)
      ) {
        i++; // skip the type name
      }
      continue;
    }

    // Body block: { field patterns }
    if (token === "{") {
      i++;
      const fieldTokens: string[] = [];
      while (i < tokens.length && tokens[i] !== "}") {
        const ft = tokens[i]!;
        // Strip trailing ":" from field name patterns like "*:"
        fieldTokens.push(ft.endsWith(":") ? ft.slice(0, -1) : ft);
        i++;
      }
      if (i < tokens.length) i++; // skip "}"

      if (fieldTokens.length > 0) {
        // Extract literal type names (non-wildcard tokens) for body field matching
        const types = fieldTokens.filter(
          (t) => t !== "*" && !AST_KEYWORDS.has(t) && !AST_QUALIFIERS.has(t) && !t.startsWith("*"),
        );
        bodyFieldPatterns = types.length > 0 ? types : ["*"];
      } else {
        bodyFieldPatterns = ["*"];
      }
      continue;
    }

    // Skip standalone parens — they're decorative in pattern syntax
    if (token === "(" || token === ")") {
      i++;
      continue;
    }

    // Everything else is a name pattern or wildcard
    if (namePattern === null) {
      if (token === "*:" || token === "*") {
        namePattern = "*";
      } else if (token.includes("*")) {
        namePattern = token.replace(/:$/, "");
      } else if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) {
        namePattern = token;
      }
    }
    i++;
  }

  const nodeTypes = AST_KEYWORD_NODE_TYPES[keyword] ?? [];
  const isAsync = qualifiers.has("async") ? true : null;
  const fallbackRegex = buildPatternFallbackRegex(allTokens);

  return {
    nodeTypes,
    isAsync,
    namePattern,
    returnTypePattern,
    extendsPattern,
    forTypePattern,
    bodyFieldPatterns,
    fallbackRegex,
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

  // For Rust impl_item, use "trait" field
  const traitNode = node.childForFieldName("trait");
  if (traitNode) return traitNode.text;

  // Fallback to first identifier child
  for (const child of node.namedChildren) {
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "property_identifier"
    ) {
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
    const t = child.type;
    if (
      t.endsWith("_body") ||
      t === "body" ||
      t === "block" ||
      t === "statement_block" ||
      t === "declaration_list" ||
      t === "field_declaration_list" ||
      t === "class_body"
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Check whether a tree-sitter AST node matches the parsed AST pattern query.
 * Applies all non-null filters from the query against the node.
 */
export function checkAstNodeMatches(node: Parser.SyntaxNode, query: ParsedAstPattern): boolean {
  // 1. Node type filter
  if (!query.nodeTypes.includes(node.type)) return false;

  // 2. Name filter
  if (query.namePattern !== null && query.namePattern !== "*") {
    const name = getNodeName(node);
    if (!name || !globMatch(name, query.namePattern)) return false;
  }

  // 3. Async filter
  if (query.isAsync === true) {
    const firstLine = node.text.split("\n")[0] ?? "";
    if (!/\basync\b/.test(firstLine)) return false;
  }

  // 4. Return type filter
  if (query.returnTypePattern !== null && query.returnTypePattern !== "*") {
    const rtNode = node.childForFieldName("return_type");
    if (rtNode) {
      // Strip leading ": " (TS/Java) or "-> " (Rust/Swift) from return_type text
      const rtText = rtNode.text.replace(/^[:\->]\s*/, "");
      if (!globMatch(rtText, query.returnTypePattern)) return false;
    } else {
      // Fallback: search for "-> Type" or ": Type" in text
      const arrowMatch = node.text.match(/(?:->|:)\s*([A-Za-z_][A-Za-z0-9_<>[\]]*)/);
      if (!arrowMatch || !globMatch(arrowMatch[1]!, query.returnTypePattern)) return false;
    }
  }

  // 5. Extends / superclass filter
  if (query.extendsPattern !== null && query.extendsPattern !== "*") {
    let found = false;
    for (const child of node.children) {
      if (child.type === "class_heritage" || child.type === "superclass") {
        if (child.text.includes(query.extendsPattern)) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      if (
        !node.text.includes(`extends ${query.extendsPattern}`) &&
        !node.text.includes(`extends${query.extendsPattern}`)
      ) {
        return false;
      }
    }
  }

  // 6. For-type filter (Rust impl_item: impl Trait for Type)
  if (query.forTypePattern !== null && query.forTypePattern !== "*") {
    if (node.type === "impl_item") {
      const typeNode = node.childForFieldName("type");
      if (!typeNode || !globMatch(typeNode.text, query.forTypePattern)) return false;
    } else {
      const forMatch = node.text.match(/\bfor\s+(\S+?)\s*\{/);
      if (!forMatch || !globMatch(forMatch[1]!, query.forTypePattern)) return false;
    }
  }

  // 7. Body field filter
  if (query.bodyFieldPatterns !== null) {
    if (query.bodyFieldPatterns.length === 1 && query.bodyFieldPatterns[0] === "*") {
      // { * } means any body — always matches
    } else {
      const bodyNode = findBodyChild(node);
      if (!bodyNode) return false;

      const bodyText = bodyNode.text;
      const matchesOne = query.bodyFieldPatterns.some((pattern) => {
        const re = new RegExp(`:\\s*${globToRegexPattern(pattern)}\\b`);
        return re.test(bodyText);
      });
      if (!matchesOne) return false;
    }
  }

  return true;
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

  const chunkSize = 1024;
  const tree = parser.parse((offset) => content.slice(offset, offset + chunkSize));
  if (!tree?.rootNode) return [];

  const results: { node: Parser.SyntaxNode; name: string }[] = [];
  const cursor = tree.rootNode.walk();

  while (true) {
    const node = cursor.currentNode;
    if (node && query.nodeTypes.includes(node.type)) {
      if (checkAstNodeMatches(node, query)) {
        const name = getNodeName(node) ?? node.type;
        results.push({ node, name });
      }
    }

    if (cursor.gotoFirstChild()) continue;
    if (cursor.gotoNextSibling()) continue;

    let reachedRoot = false;
    while (true) {
      if (!cursor.gotoParent()) {
        reachedRoot = true;
        break;
      }
      if (cursor.gotoNextSibling()) break;
    }
    if (reachedRoot) break;
  }

  return results;
}
