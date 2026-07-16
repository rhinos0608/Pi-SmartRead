import { readFileSync, existsSync, statSync } from "node:fs";
import { relative, resolve, dirname, extname } from "node:path";
import { createRequire } from "node:module";
import type { SignalName, SignalResult, FileSignals } from "./signals-types.js";
import type { ContextGraph } from "./context-graph.js";
import { filenameToLang, type SupportedLanguage } from "./languages.js";
import { fileLastModifiedRelative } from "./git-history.js";

const require = createRequire(import.meta.url);

// ── Language support for AST complexity ──

const AST_LANGS = new Set<SupportedLanguage>([
  "typescript",
  "tsx",
  "javascript",
  "python",
]);

// Branch node types for tree-sitter per language family
const BRANCH_TYPES_TS_JS = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "for_of_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "ternary_expression",
  "catch_clause",
]);

const BRANCH_TYPES_PY = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "except_clause",
  "case",
  "conditional_expression",
]);

// Function/method node types per language
const FUNCTION_TYPES_TS_JS = new Set([
  "function_declaration",
  "method_definition",
  "arrow_function",
  "function_expression",
  "generator_function_declaration",
  "generator_function_expression",
]);

const FUNCTION_TYPES_PY = new Set([
  "function_definition",
]);

// ── Helpers ────────────────────────────────────────────────────────────

function readSource(path: string, source?: string): string {
  if (source !== undefined) return source;
  return readFileSync(path, "utf-8");
}

function isPythonFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".py" || ext === ".pyi" || ext === ".pyx";
}

// ── Complexity (AST) ───────────────────────────────────────────────────

function loadGrammar(lang: SupportedLanguage): unknown {
  switch (lang) {
    case "typescript":
    case "tsx":
      return require("tree-sitter-typescript");
    case "javascript":
      return require("tree-sitter-javascript");
    case "python":
      return require("tree-sitter-python");
    default:
      return null;
  }
}

function countBranchesRecursive(
  node: unknown,
  branchTypes: Set<string>,
  funcTypes: Set<string>,
): number {
  const n = node as any;
  if (!n || typeof n !== "object" || !n.type) return 0;

  if (funcTypes.has(n.type)) {
    // Don't count branches in nested functions at this level
    return 0;
  }

  let count = branchTypes.has(n.type) ? 1 : 0;
  for (let i = 0; i < n.namedChildCount; i++) {
    const child = n.namedChild(i);
    if (child) {
      count += countBranchesRecursive(child, branchTypes, funcTypes);
    }
  }
  return count;
}

// ── Complexity (regex fallback) ────────────────────────────────────────

function complexityRegex(src: string): { total: number; maxInFunction: number } {
  const branchPattern = /\b(?:if|for|while|case)\b|[&]{2}|[|]{2}|\?|catch/g;
  const matches = src.match(branchPattern);
  const total = matches ? matches.length : 0;

  // Heuristic for max in a function: split by function boundaries
  const fnBlocks = src.split(/\bfunction\b|\bdef\b/);
  let maxInFunction = 0;
  for (const block of fnBlocks) {
    const blockMatches = block.match(branchPattern);
    const count = blockMatches ? blockMatches.length : 0;
    if (count > maxInFunction) maxInFunction = count;
  }

  return { total, maxInFunction };
}

// ── Exported signal functions ──────────────────────────────────────────

export async function computeComplexity(
  absolutePath: string,
  source?: string,
): Promise<SignalResult> {
  const src = readSource(absolutePath, source);
  const lang = filenameToLang(absolutePath);
  const useAst = lang !== undefined && AST_LANGS.has(lang);

  if (useAst) {
    try {
      const Parser = (await import("tree-sitter")).default;
      const parser = new Parser();
      const grammar = loadGrammar(lang);
      if (!grammar) throw new Error("no grammar loaded");
      parser.setLanguage(grammar as any);

      const tree = parser.parse(src);
      const root = tree.rootNode;

      const branchTypes = isPythonFile(absolutePath) ? BRANCH_TYPES_PY : BRANCH_TYPES_TS_JS;
      const funcTypes = isPythonFile(absolutePath) ? FUNCTION_TYPES_PY : FUNCTION_TYPES_TS_JS;

      // Collect per-function and module-level branch counts
      const perFn: number[] = [];
      for (let i = 0; i < root.namedChildCount; i++) {
        const child = root.namedChild(i);
        if (!child) continue;

        let funcNode: any = null;
        if (funcTypes.has(child.type)) {
          funcNode = child;
        } else if (child.type === "export_statement") {
          for (let j = 0; j < child.namedChildCount; j++) {
            const inner = child.namedChild(j);
            if (inner && funcTypes.has(inner.type)) {
              funcNode = inner;
              break;
            }
          }
        }

        if (funcNode) {
          let fnBranches = 0;
          for (let j = 0; j < funcNode.namedChildCount; j++) {
            const body = funcNode.namedChild(j);
            if (body) {
              fnBranches += countBranchesRecursive(body, branchTypes, funcTypes);
            }
          }
          perFn.push(fnBranches);
        } else {
          const count = countBranchesRecursive(child, branchTypes, funcTypes);
          if (count > 0) perFn.push(count);
        }
      }

      const total = perFn.reduce((a, b) => a + b, 0);
      const maxFn = Math.max(...perFn, 0);

      let label: string;
      if (maxFn >= 20) label = "High";
      else if (maxFn >= 10) label = "Medium";
      else label = "Low";

      return {
        name: "complexity",
        label,
        value: `${total}`,
        detail: `max ${maxFn} in a single function`,
        confidence: "high",
        source: "tree-sitter AST",
      };
    } catch {
      // AST failed, fall through to regex
    }
  }

  // Regex fallback
  const { total, maxInFunction } = complexityRegex(src);
  let label: string;
  if (total >= 30) label = "High";
  else if (total >= 10) label = "Medium";
  else label = "Low";

  return {
    name: "complexity",
    label,
    value: `${total}`,
    detail: `max ${maxInFunction} in a single function (regex)`,
    confidence: "low",
    source: "regex fallback",
  };
}

export function detectPublicApi(
  absolutePath: string,
  source?: string,
): SignalResult {
  const src = readSource(absolutePath, source);
  const isPy = isPythonFile(absolutePath);

  if (isPy) {
    // Check for __all__
    const allMatch = src.match(/__all__\s*=\s*\[([^\]]*)\]/);
    if (allMatch) {
      const symbols = allMatch[1]!
        .split(",")
        .map((s) => s.trim().replace(/['"]/g, ""))
        .filter(Boolean);
      return {
        name: "public-api",
        label: symbols.length > 0 ? "Yes" : "No",
        value: `Yes (${symbols.length} symbols in __all__)`,
        detail: symbols.join(", "),
        confidence: "medium",
        source: "python __all__",
      };
    }

    // No __all__: count non-underscore-prefixed top-level definitions
    const publicDefs = src.match(/^(?:async\s+)?def\s+[a-zA-Z]\w*\s*\(|^class\s+[A-Z]\w*/gm);
    const privateDefs = src.match(/^(?:async\s+)?def\s+_\w+\s*\(|^class\s+_\w*/gm);
    const publicCount = publicDefs ? publicDefs.length : 0;
    const privateCount = privateDefs ? privateDefs.length : 0;

    if (publicCount > 0 && privateCount === 0) {
      return {
        name: "public-api",
        label: "Yes",
        value: `Yes (${publicCount} public)`,
        confidence: "medium",
        source: "python underscore convention",
      };
    }
    if (publicCount > 0) {
      return {
        name: "public-api",
        label: "Partial",
        value: `Partial (${publicCount} of ${publicCount + privateCount})`,
        detail: `${publicCount} public, ${privateCount} private`,
        confidence: "medium",
        source: "python underscore convention",
      };
    }
    return {
      name: "public-api",
      label: "No",
      value: "No",
      confidence: "medium",
      source: "python underscore convention",
    };
  }

  // TS/JS: count export keyword at statement level
  const exportMatches = src.match(/export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum|abstract|async)/g);
  const exportCount = exportMatches ? exportMatches.length : 0;

  // Also count re-exports
  const reExportMatches = src.match(/export\s+(?:\{[^}]*\}\s+from|type\s+\{[^}]*\}\s+from|\*\s+from)/g);
  const reExportCount = reExportMatches ? reExportMatches.length : 0;
  const total = exportCount + reExportCount;

  if (total > 0) {
    return {
      name: "public-api",
      label: "Yes",
      value: `Yes (${total} exported)`,
      detail: `${exportCount} declarations, ${reExportCount} re-exports`,
      confidence: "high",
      source: "ts/js export keyword",
    };
  }

  return {
    name: "public-api",
    label: "No",
    value: "No",
    confidence: "high",
    source: "ts/js export keyword",
  };
}

export async function computeReuseBreadth(
  absolutePath: string,
  graph?: ContextGraph | null,
): Promise<SignalResult> {
  if (!graph) {
    return {
      name: "reuse",
      label: "Unknown",
      value: "Unknown",
      detail: "Graph unavailable",
      confidence: "none",
      source: "context graph",
    };
  }

  try {
    const neighbours = await graph.getFileNeighbours(absolutePath);
    const importingFiles = neighbours.filter(
      (n) => n.provenance.type === "imported_by",
    );
    const uniquePaths = new Set(importingFiles.map((n) => n.path));
    const count = uniquePaths.size;

    if (count > 0) {
      return {
        name: "reuse",
        label: "Yes",
        value: `Yes (${count} importing files)`,
        confidence: "high",
        source: "context graph",
      };
    }

    return {
      name: "reuse",
      label: "No",
      value: "No importing files",
      confidence: "high",
      source: "context graph",
    };
  } catch {
    return {
      name: "reuse",
      label: "Unknown",
      value: "Unknown",
      detail: "Graph query failed",
      confidence: "none",
      source: "context graph",
    };
  }
}

export async function computeRecency(
  absolutePath: string,
  cwd: string,
): Promise<SignalResult> {
  try {
    const result = await fileLastModifiedRelative(absolutePath, cwd);
    if (result) {
      return {
        name: "recency",
        label: result.relative,
        value: result.relative,
        detail: result.iso,
        confidence: "high",
        source: "git log",
      };
    }

    // fileLastModifiedRelative returned null — no git history and mtime >= 1 day
    return {
      name: "recency",
      label: "Unknown",
      value: "Unknown",
      confidence: "none",
      source: "mtime fallback",
    };
  } catch {
    return {
      name: "recency",
      label: "Unknown",
      value: "Unknown",
      confidence: "none",
      source: "mtime fallback",
    };
  }
}

export function detectTests(
  absolutePath: string,
  cwd: string,
): SignalResult {
  const parsedPath = absolutePath;
  const basename = parsedPath.split("/").pop() ?? parsedPath.split("\\").pop() ?? "";
  const dir = dirname(parsedPath);
  const filenameNoExt = basename.replace(/\.[^.]+$/, "");

  // Candidate test paths
  const candidates = new Set<string>();

  // Common patterns:
  // src/foo.ts → test/foo.test.ts, test/foo.spec.ts, src/foo.test.ts, src/__tests__/foo.test.ts
  // src/foo.py → tests/test_foo.py, test_foo.py
  const srcDir = dir;
  const testDir = resolve(dir, "..", "test");
  const testsDir = resolve(dir, "..", "tests");
  const srcTestDir = resolve(dir, "__tests__");

  const exts = isPythonFile(parsedPath) ? [".py"] : [".ts", ".tsx", ".js", ".jsx"];

  for (const ext of exts) {
    // test/ dir pattern
    candidates.add(resolve(testDir, `${filenameNoExt}.test${ext}`));
    candidates.add(resolve(testDir, `${filenameNoExt}.spec${ext}`));
    candidates.add(resolve(testDir, `${filenameNoExt}_test${ext}`));
    // tests/ dir pattern (python)
    candidates.add(resolve(testsDir, `test_${filenameNoExt}${ext}`));
    candidates.add(resolve(testsDir, `${filenameNoExt}_test${ext}`));
    // same dir pattern
    candidates.add(resolve(srcDir, `${filenameNoExt}.test${ext}`));
    candidates.add(resolve(srcDir, `${filenameNoExt}.spec${ext}`));
    candidates.add(resolve(srcDir, `test_${filenameNoExt}${ext}`));
    // __tests__ dir pattern
    candidates.add(resolve(srcTestDir, `${filenameNoExt}.test${ext}`));
    // python test_ prefix in same dir
    if (isPythonFile(parsedPath)) {
      candidates.add(resolve(srcDir, `test_${filenameNoExt}.py`));
    }
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return {
          name: "tests",
          label: "Yes",
          value: `Yes (${relative(cwd, candidate)})`,
          detail: candidate,
          confidence: "medium",
          source: "test file discovery",
        };
      }
    } catch {
      continue;
    }
  }

  return {
    name: "tests",
    label: "No",
    value: "No tests found",
    confidence: "medium",
    source: "test file discovery",
  };
}

export function detectDeprecation(
  absolutePath: string,
  source?: string,
): SignalResult {
  const src = readSource(absolutePath, source);

  const matches: string[] = [];
  const depPattern = /@deprecated\s+(.*)$|#\[deprecated\]|\[Obsolete\]|DeprecationWarning/gm;
  let match: RegExpExecArray | null;

  while ((match = depPattern.exec(src)) !== null) {
    const comment = match[1]?.trim() ?? match[0];
    matches.push(comment);
  }

  if (matches.length > 0) {
    return {
      name: "deprecation",
      label: "Yes",
      value: `Yes (${matches.length} markers)`,
      detail: matches.slice(0, 3).join("; "),
      confidence: "medium",
      source: "regex marker detection",
    };
  }

  return {
    name: "deprecation",
    label: "No",
    value: "No markers found",
    confidence: "medium",
    source: "regex marker detection",
  };
}

// ── Orchestrator ───────────────────────────────────────────────────────

const ALL_SIGNALS: SignalName[] = [
  "complexity",
  "public-api",
  "reuse",
  "recency",
  "tests",
  "deprecation",
];

export async function computeFileSignals(
  absolutePath: string,
  cwd: string,
  contextGraph?: ContextGraph | null,
  requestedSignals?: SignalName[],
  _signal?: AbortSignal,
): Promise<FileSignals> {
  const names = requestedSignals ?? ALL_SIGNALS;
  const signals: SignalResult[] = [];
  const fallbackNotices: string[] = [];

  for (const name of names) {
    try {
      let result: SignalResult;
      switch (name) {
        case "complexity":
          result = await computeComplexity(absolutePath);
          break;
        case "public-api":
          result = detectPublicApi(absolutePath);
          break;
        case "reuse":
          result = await computeReuseBreadth(absolutePath, contextGraph);
          break;
        case "recency":
          result = await computeRecency(absolutePath, cwd);
          break;
        case "tests":
          result = detectTests(absolutePath, cwd);
          break;
        case "deprecation":
          result = detectDeprecation(absolutePath);
          break;
      }

      if (result.confidence === "none" && result.detail) {
        fallbackNotices.push(`${name}: ${result.detail}`);
      }

      signals.push(result);
    } catch (err) {
      fallbackNotices.push(`${name}: unexpected error`);
      signals.push({
        name,
        label: "Error",
        value: "Error",
        detail: String(err),
        confidence: "none",
        source: "error",
      });
    }
  }

  return {
    path: absolutePath,
    signals,
    computedAt: new Date().toISOString(),
    fallbackNotices,
  };
}
