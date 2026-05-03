/**
 * HyDE (Hypothetical Document Embeddings) query expansion.
 *
 * Instead of embedding the raw user query, HyDE generates a hypothetical
 * code document that *would* answer the query, then embeds that document.
 * The hypothetical document is semantically closer to actual relevant code
 * than the raw natural-language query.
 *
 * This implementation uses a template-based approach (no LLM required):
 * - Extracts code-like identifiers from the query
 * - Generates a synthetic code document using common patterns
 * - Falls back to raw query on failure
 *
 * See: Gao et al., "Precise Zero-Shot Dense Retrieval without Relevance Labels"
 * (https://arxiv.org/abs/2212.10496)
 */

import { tokenize } from "./scoring.js";

/** Common English words to exclude from identifier extraction. */
const STOP_WORDS = new Set([
  "the", "this", "that", "these", "those", "with", "from", "file", "code",
  "function", "class", "method", "value", "data", "type", "what", "where",
  "how", "which", "find", "show", "get", "set", "list", "all", "any", "has",
  "not", "and", "for", "are", "can", "use", "using", "used", "implement",
  "the", "a", "an", "in", "on", "at", "to", "of", "is", "it", "by", "as",
  "or", "be", "do", "if", "was", "were", "been", "being", "have", "has",
  "had", "having", "would", "could", "should", "might", "must", "shall",
  "will", "may", "need", "want", "like", "about", "into", "through", "during",
  "before", "after", "above", "below", "between", "each", "few", "more",
  "most", "other", "some", "such", "no", "nor", "too", "very", "just",
  "because", "so", "than", "also", "back", "even", "still", "already",
  "well", "here", "there", "when", "while", "why", "who", "whom", "whose",
  "which", "where", "whether", "however", "then", "once", "again", "further",
  "both", "either", "neither", "every", "much", "own", "same", "different",
  "new", "old", "first", "last", "next", "previous", "only", "over", "such",
  "its", "our", "your", "their", "his", "her", "my", "our", "what", "which",
  // Code-specific stop words
  "handle", "handler", "process", "config", "configuration", "setting",
  "options", "param", "params", "argument", "arguments", "module", "package",
  "library", "util", "utility", "helper", "base", "main", "app", "application",
  "server", "client", "route", "routes", "middleware", "api", "endpoint",
  "service", "provider", "factory", "manager", "controller", "model", "view",
  "page", "component", "element", "node", "tree", "graph", "edge", "path",
  "name", "key", "map", "array", "object", "string", "number", "bool",
  "boolean", "int", "integer", "float", "double", "void", "null", "undefined",
  "true", "false", "promise", "async", "await", "try", "catch", "throw",
  "new", "delete", "create", "update", "remove", "insert", "select", "search",
  "query", "filter", "sort", "group", "return", "call", "called", "calling",
]);

/**
 * Extract probable code identifiers from a query string.
 * Returns tokens that look like they could be code identifiers
 * (camelCase, PascalCase, snake_case, or single meaningful words).
 */
function extractIdentifiers(query: string): string[] {
  const tokens = tokenize(query);
  const identifiers: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (token.length < 3) continue;
    if (STOP_WORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    identifiers.push(token);
  }

  return identifiers;
}

/**
 * Detect likely code patterns from the query to generate a more
 * realistic hypothetical document.
 */
function detectQueryPattern(query: string): "function" | "class" | "module" | "config" | "generic" {
  const lower = query.toLowerCase();

  if (/\bclass\b|\btype\b|\binterface\b|\bstruct\b/.test(lower)) return "class";
  if (/\bconfig\b|\bsetting\b|\boption\b|\benv\b/.test(lower)) return "config";
  if (/\bmodule\b|\bpackage\b|\blibrary\b|\bimport\b/.test(lower)) return "module";
  if (/\bfunction\b|\bmethod\b|\bhandler\b|\bprocess\b|\bcall\b/.test(lower)) return "function";

  // Default: function-style (most common in code queries)
  return "function";
}

/**
 * Generate a hypothetical code document from a query.
 *
 * The generated document uses the query's keywords in code-like patterns
 * so that its embedding is semantically closer to actual code files
 * that would answer the query.
 */
export function generateHypotheticalDocument(query: string): string {
  const identifiers = extractIdentifiers(query);
  if (identifiers.length === 0) {
    // No useful identifiers — return the query itself as the document
    return query;
  }

  const pattern = detectQueryPattern(query);
  const primary = identifiers[0]!;
  const secondary = identifiers.slice(1, 4);
  const allIds = identifiers.join(", ");

  // Convert snake_case to PascalCase for class names
  const toPascal = (s: string) =>
    s.replace(/(^|_)([a-z])/g, (_, _p, c) => c.toUpperCase());

  // Convert snake_case to camelCase for method names
  const toCamel = (s: string) => {
    const pascal = toPascal(s);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  };

  switch (pattern) {
    case "class":
      return [
        `class ${toPascal(primary)} {`,
        ...secondary.map((id) => `  ${toCamel(id)}: ${toPascal(id)};`),
        "",
        `  constructor(${allIds}) {`,
        ...secondary.map((id) => `    this.${toCamel(id)} = ${toCamel(id)};`),
        "  }",
        "",
        ...secondary.map((id) => `  get${toPascal(id)}() { return this.${toCamel(id)}; }`),
        "}",
        "",
        `export { ${toPascal(primary)} };`,
      ].join("\n");

    case "config":
      return [
        `// Configuration for ${identifiers.join(", ")}`,
        `export const ${primary}Config = {`,
        ...secondary.map((id) => `  ${id}: undefined,`),
        `  // ${query}`,
        `};`,
        "",
        `export function validate${toPascal(primary)}(config) {`,
        ...secondary.map((id) => `  if (!config.${id}) throw new Error('${id} is required');`),
        "  return config;",
        "}",
      ].join("\n");

    case "module":
      return [
        `// Module: ${primary}`,
        ...secondary.map((id) => `import { ${toPascal(id)} } from './${id}';`),
        "",
        `export class ${toPascal(primary)}Module {`,
        ...secondary.map((id) => `  private ${toCamel(id)}: ${toPascal(id)};`),
        "",
        "  init() {",
        ...secondary.map((id) => `    this.${toCamel(id)} = new ${toPascal(id)}();`),
        "  }",
        "}",
      ].join("\n");

    case "function":
    default:
      return [
        `// ${query}`,
        `export function ${toCamel(primary)}(${secondary.join(", ")}) {`,
        ...secondary.map((id) => `  const ${toCamel(id)} = ${toCamel(id)}Process();`),
        `  return ${secondary.length > 0 ? toCamel(secondary[0]!) : "result"};`,
        "}",
        "",
        ...secondary.map((id) =>
          `function ${toCamel(id)}Process() { return ${toCamel(id)}; }`
        ),
      ].join("\n");
  }
}

export interface HydeOptions {
  /** Whether HyDE expansion is enabled. */
  enabled: boolean;
  /** The original query to expand. */
  query: string;
}

export interface HydeResult {
  /** The hypothetical document text to embed instead of the query. */
  document: string;
  /** Whether HyDE was applied (false = fell back to raw query). */
  applied: boolean;
  /** The detected query pattern. */
  pattern: string;
  /** Extracted identifiers used in the hypothetical document. */
  identifiers: string[];
}

/**
 * Apply HyDE query expansion.
 * Returns a hypothetical document to embed, or the original query as fallback.
 */
export function applyHyde(options: HydeOptions): HydeResult {
  if (!options.enabled || !options.query || options.query.trim().length === 0) {
    return {
      document: options.query,
      applied: false,
      pattern: "none",
      identifiers: [],
    };
  }

  const identifiers = extractIdentifiers(options.query);
  const pattern = detectQueryPattern(options.query);
  const document = generateHypotheticalDocument(options.query);

  // Only apply HyDE if we extracted meaningful identifiers
  if (identifiers.length === 0) {
    return {
      document: options.query,
      applied: false,
      pattern,
      identifiers: [],
    };
  }

  return {
    document,
    applied: true,
    pattern,
    identifiers,
  };
}
