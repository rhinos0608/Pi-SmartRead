/**
 * Query probe — extracts probable identifiers, file paths, and symbols
 * from a user query and resolves them against the repository context graph.
 *
 * Phase 3 of the advanced retrieval plan. See docs/advanced-retrieval-implementation-plan.md
 */
import { tokenize } from "./scoring.js";
import { ContextGraph } from "./context-graph.js";

export interface ProbeResult {
  status: "off" | "ok" | "failed";
  strategy: "symbols" | "model" | "logprob";
  inferredSymbols: string[];
  addedPaths: string[];
  warnings: string[];
}

export interface ProbeOptions {
  maxProbeAdded: number;
  graph: ContextGraph;
}

/**
 * Common English words unlikely to be code identifiers.
 * Helps avoid noisy probe results from natural-language query terms.
 */
const COMMON_WORDS = new Set([
  "the", "this", "that", "these", "those", "with", "from", "file", "code",
  "function", "class", "method", "value", "data", "type", "what", "where",
  "how", "which", "find", "show", "get", "set", "list", "all", "any", "has",
  "not", "and", "for", "are", "can", "use", "using", "used", "implement",
  "implementation", "define", "definition", "reference", "call", "called",
  "calling", "return", "returns", "handle", "handler", "process", "config",
  "configuration", "setting", "options", "param", "params", "argument",
  "arguments", "module", "package", "library", "util", "utility", "helper",
  "base", "main", "app", "application", "server", "client", "route",
  "routes", "middleware", "api", "endpoint", "service", "provider",
  "factory", "manager", "controller", "model", "view", "page", "pages",
  "component", "element", "node", "tree", "graph", "edge", "path", "name",
  "key", "value", "map", "list", "array", "object", "string", "number",
  "bool", "boolean", "int", "integer", "float", "double", "void", "null",
  "undefined", "true", "false", "promise", "async", "await", "try", "catch",
  "throw", "new", "delete", "create", "update", "remove", "insert", "select",
  "search", "query", "filter", "sort", "group", "count", "sum", "avg",
  "min", "max", "total", "index", "key", "primary", "foreign", "unique",
  "constraint", "schema", "table", "column", "row", "field", "property",
  "attribute", "variable", "constant", "expression", "statement", "block",
  "scope", "context", "environment", "session", "cache", "store", "queue",
  "stack", "heap", "pool", "thread", "process", "worker", "task", "job",
  "event", "message", "signal", "hook", "callback", "listener", "observer",
  "publish", "subscribe", "emit", "broadcast", "notify", "trigger", "action",
  "reducer", "dispatch", "state", "effect", "side", "pure", "memo",
  "selector", "resolver", "saga", "thunk", "middleware", "plugin", "addon",
  "extension", "integration", "interface", "contract", "protocol", "adapter",
  "bridge", "proxy", "decorator", "mixin", "trait", "mixin",
]);

/**
 * Deterministic symbol probe — extracts identifiers from the query,
 * looks them up in the context graph, and returns matching files.
 */
export async function probeQuery(
  query: string,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const result: ProbeResult = {
    status: "ok",
    strategy: "symbols",
    inferredSymbols: [],
    addedPaths: [],
    warnings: [],
  };

  if (options.maxProbeAdded <= 0) {
    result.status = "off";
    return result;
  }

  if (!query || query.trim().length === 0) {
    result.warnings.push("empty query");
    return result;
  }

  try {
    const tokens = tokenize(query);

    // Extract probable code identifiers from query tokens
    const identifiers = tokens.filter((t) => {
      if (t.length < 2) return false;
      if (COMMON_WORDS.has(t)) return false;
      if (/^\d+$/.test(t)) return false;
      if (/^[^a-z]/.test(t) && t.length <= 2) return false; // single chars + prefixes
      return true;
    });

    // Deduplicate while preserving order
    const seen = new Set<string>();
    const uniqueIdentifiers: string[] = [];
    for (const id of identifiers) {
      if (!seen.has(id)) {
        seen.add(id);
        uniqueIdentifiers.push(id);
      }
    }

    result.inferredSymbols = uniqueIdentifiers;

    // Search each identifier in the context graph
    let added = 0;
    const addedPathsSet = new Set<string>();
    for (const id of uniqueIdentifiers) {
      if (added >= options.maxProbeAdded) break;
      try {
        const symbolFiles = await options.graph.findSymbolFiles(id);
        for (const sf of symbolFiles) {
          if (added >= options.maxProbeAdded) break;
          if (!addedPathsSet.has(sf.path)) {
            result.addedPaths.push(sf.path);
            addedPathsSet.add(sf.path);
            added++;
          }
        }
      } catch {
        // Individual identifier failures are non-fatal
        continue;
      }
    }
  } catch (err) {
    result.status = "failed";
    result.warnings.push(err instanceof Error ? err.message : String(err));
  }

  return result;
}
