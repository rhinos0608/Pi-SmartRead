import { readFileSync, existsSync } from "node:fs";
import { relative, resolve, dirname, extname } from "node:path";
import { createRequire } from "node:module";
import type { SignalName, SignalResult, FileSignals } from "./signals-types.js";
import type { TestLinkage } from "./signals-types.js";
import type { ContextGraph } from "../context-graph.js";
import type { DependentInfo } from "./structural-facts-types.js";
import { findImportDependents } from "./structural-facts.js";
import { filenameToLang, type SupportedLanguage } from "../languages.js";
import { fileLastModifiedRelative } from "../git/git-history.js";

import { findTestLinkage, findTestCoverageGaps } from "./test-linkage.js";

export { findTestLinkage, findTestCoverageGaps, linkageCount } from "./test-linkage.js";

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

const GRAMMAR_MODULE_BY_LANG: Record<string, string> = {
  typescript: "tree-sitter-typescript",
  tsx: "tree-sitter-typescript",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
};
function loadGrammar(lang: SupportedLanguage): unknown {
  const moduleName = GRAMMAR_MODULE_BY_LANG[lang];
  if (!moduleName) return null;
  return require(moduleName);
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

function selectTypeSets(absolutePath: string): { branchTypes: Set<string>; funcTypes: Set<string> } {
  const py = isPythonFile(absolutePath);
  return { branchTypes: py ? BRANCH_TYPES_PY : BRANCH_TYPES_TS_JS, funcTypes: py ? FUNCTION_TYPES_PY : FUNCTION_TYPES_TS_JS };
}
function findTopFuncNode(child: any, funcTypes: Set<string>): any | null {
  if (funcTypes.has(child.type)) return child;
  if (child.type !== "export_statement") return null;
  for (let j = 0; j < child.namedChildCount; j++) {
    const inner = child.namedChild(j);
    if (inner && funcTypes.has(inner.type)) return inner;
  }
  return null;
}
function countFuncBranches(funcNode: any, branchTypes: Set<string>, funcTypes: Set<string>): number {
  let total = 0;
  for (let j = 0; j < funcNode.namedChildCount; j++) {
    const body = funcNode.namedChild(j);
    if (body) total += countBranchesRecursive(body, branchTypes, funcTypes);
  }
  return total;
}
function collectPerFnCounts(root: any, branchTypes: Set<string>, funcTypes: Set<string>): number[] {
  const perFn: number[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (!child) continue;
    const funcNode = findTopFuncNode(child, funcTypes);
    if (funcNode) perFn.push(countFuncBranches(funcNode, branchTypes, funcTypes));
    else {
      const count = countBranchesRecursive(child, branchTypes, funcTypes);
      if (count > 0) perFn.push(count);
    }
  }
  return perFn;
}
function astComplexityResult(perFn: number[]): SignalResult {
  const total = perFn.reduce((a, b) => a + b, 0);
  const maxFn = Math.max(...perFn, 0);
  return { name: "complexity", label: complexityLabelAst(maxFn), value: `${total}`, detail: `max ${maxFn} in a single function`, confidence: "high", source: "tree-sitter AST" };
}
async function computeAstComplexity(src: string, lang: SupportedLanguage, absolutePath: string): Promise<SignalResult> {
  const Parser = (await import("tree-sitter")).default;
  const parser = new Parser();
  const grammar = loadGrammar(lang);
  if (!grammar) throw new Error("no grammar loaded");
  parser.setLanguage(grammar as any);
  const root = parser.parse(src).rootNode;
  const { branchTypes, funcTypes } = selectTypeSets(absolutePath);
  return astComplexityResult(collectPerFnCounts(root, branchTypes, funcTypes));
}
function regexComplexityResult(src: string): SignalResult {
  const { total, maxInFunction } = complexityRegex(src);
  return {
    name: "complexity",
    label: complexityLabelRegex(total),
    value: `${total}`,
    detail: `max ${maxInFunction} in a single function (regex)`,
    confidence: "low",
    source: "regex fallback",
  };
}
export async function computeComplexity(
  absolutePath: string,
  source?: string,
): Promise<SignalResult> {
  const src = readSource(absolutePath, source);
  const lang = filenameToLang(absolutePath);
  if (lang !== undefined && AST_LANGS.has(lang)) {
    try {
      return await computeAstComplexity(src, lang, absolutePath);
    } catch {
      // AST failed, fall through to regex
    }
  }
  return regexComplexityResult(src);
}

function complexityLabelAst(maxFn: number): string {
  if (maxFn >= 20) return "High";
  if (maxFn >= 10) return "Medium";
  return "Low";
}
function complexityLabelRegex(total: number): string {
  if (total >= 30) return "High";
  if (total >= 10) return "Medium";
  return "Low";
}
function detectPythonPublicApi(src: string): SignalResult {
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
function detectTsPublicApi(src: string): SignalResult {
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
export function detectPublicApi(absolutePath: string, source?: string): SignalResult {
  const src = readSource(absolutePath, source);
  return isPythonFile(absolutePath) ? detectPythonPublicApi(src) : detectTsPublicApi(src);
}
function unknownReuse(detail: string): SignalResult {
  return { name: "reuse", label: "Unknown", value: "Unknown", detail, confidence: "none", source: "import scan" };
}
function reuseFromImportScan(dependents: DependentInfo[]): SignalResult {
  const count = new Set(dependents.map((dependent) => resolve(dependent.file))).size;
  if (count > 0) {
    const noun = count === 1 ? "file" : "files";
    return {
      name: "reuse",
      label: "Yes",
      value: `Yes (${count} importing ${noun})`,
      detail: `import scan (${count} ${noun}, direct imports/re-exports only)`,
      confidence: "medium",
      source: "import scan",
    };
  }
  return {
    name: "reuse",
    label: "No",
    value: "No importing files found",
    detail: "Import scan found no dependents",
    confidence: "low",
    source: "import scan",
  };
}

async function reuseWithoutGraph(absolutePath: string, precomputedDependents: DependentInfo[] | undefined, cwd: string | undefined): Promise<SignalResult> {
  if (precomputedDependents) return reuseFromImportScan(precomputedDependents);
  const scanCwd = cwd ?? dirname(absolutePath);
  try {
    if (!existsSync(scanCwd)) return unknownReuse("Graph unavailable — could not scan workspace");
    const dependents = await findImportDependents(absolutePath, scanCwd, filenameToLang(absolutePath) as any);
    return reuseFromImportScan(dependents);
  } catch {
    return unknownReuse("Graph unavailable — could not scan workspace");
  }
}
function reuseYesResult(count: number, graphPathsSize: number): SignalResult {
  const noun = count === 1 ? "file" : "files";
  return {
    name: "reuse",
    label: "Yes",
    value: `Yes (${count} importing ${noun})`,
    ...(count > graphPathsSize ? { detail: "context graph supplemented by direct import scan" } : {}),
    confidence: "high",
    source: count > graphPathsSize ? "context graph + import scan" : "context graph",
  };
}
function reuseNoResult(): SignalResult {
  return { name: "reuse", label: "No", value: "No importing files", confidence: "high", source: "context graph + import scan" };
}
function reuseGraphFailure(precomputedDependents: DependentInfo[] | undefined): SignalResult {
  if (precomputedDependents) return reuseFromImportScan(precomputedDependents);
  return { name: "reuse", label: "Unknown", value: "Unknown", detail: "Graph query failed", confidence: "none", source: "context graph" };
}
function reuseWithGraph(absolutePath: string, graph: ContextGraph, precomputedDependents: DependentInfo[] | undefined): SignalResult {
  const targetPath = resolve(absolutePath);
  const graphPaths = new Set(
    graph.getProvenanceEdges()
      .filter((edge) => resolve(edge.to) === targetPath)
      .map((edge) => resolve(edge.from)),
  );
  const scanPaths = new Set((precomputedDependents ?? []).map((dependent) => resolve(dependent.file)));
  const count = new Set([...graphPaths, ...scanPaths]).size;
  if (count === 0) return reuseNoResult();
  if (graphPaths.size === 0 && precomputedDependents) return reuseFromImportScan(precomputedDependents);
  return reuseYesResult(count, graphPaths.size);
}
export async function computeReuseBreadth(
  absolutePath: string,
  graph?: ContextGraph | null,
  precomputedDependents?: DependentInfo[],
  cwd?: string,
): Promise<SignalResult> {
  if (!graph) return reuseWithoutGraph(absolutePath, precomputedDependents, cwd);
  try {
    return reuseWithGraph(absolutePath, graph, precomputedDependents);
  } catch {
    return reuseGraphFailure(precomputedDependents);
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
  precomputedLinkage?: TestLinkage[],
): SignalResult {
  const linkage = (precomputedLinkage ?? findTestLinkage(absolutePath, cwd))[0];
  if (linkage) {
    return {
      name: "tests",
      label: "Yes",
      value: `Yes (${relative(cwd, linkage.testFile).replace(/\\/g, "/")})`,
      detail: linkage.testFile,
      confidence: "medium",
      source: "test file discovery",
    };
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

// Test-linkage candidate discovery + import matching + coverage gaps live in
// ./test-linkage.js (re-exported above). Signal orchestration below computes
// linkage once per run and reuses it.

/** Escape special regex characters in a string for use in RegExp constructor. */
// ── Orchestrator ───────────────────────────────────────────────────────

const ALL_SIGNALS: SignalName[] = [
  "complexity",
  "public-api",
  "reuse",
  "recency",
  "tests",
  "deprecation",
];

interface SignalContext {
  absolutePath: string;
  cwd: string;
  contextGraph?: ContextGraph | null;
  externalDependents?: DependentInfo[];
}
function formatCoverageDetail(linkage: TestLinkage[], gaps: { tested: string[]; unreferenced: string[]; unknown: string[] }): string | null {
  const totalExported = gaps.tested.length + gaps.unreferenced.length + gaps.unknown.length;
  if (totalExported === 0) return null;
  const parts = [`Linked ${linkage.length} tests; ${gaps.tested.length}/${totalExported} exported callables statically referenced`];
  if (gaps.unreferenced.length > 0) {
    const shown = gaps.unreferenced.slice(0, 20);
    const suffix = gaps.unreferenced.length > 20 ? ` (+${gaps.unreferenced.length - 20} more)` : "";
    parts.push(`Unreferenced: ${shown.join(", ")}${suffix}`);
  }
  return parts.join("; ");
}
async function enrichTestsSignal(base: SignalResult, absolutePath: string, cwd: string, linkage: TestLinkage[]): Promise<SignalResult> {
  if (base.confidence === "none") return base;
  try {
    const gaps = await findTestCoverageGaps(absolutePath, cwd, linkage);
    const detail = formatCoverageDetail(linkage, gaps);
    return detail ? { ...base, detail } : base;
  } catch {
    return base;
  }
}
async function computeTestsSignal(ctx: SignalContext): Promise<SignalResult> {
  const linkage = findTestLinkage(ctx.absolutePath, ctx.cwd);
  const base = detectTests(ctx.absolutePath, ctx.cwd, linkage);
  return enrichTestsSignal(base, ctx.absolutePath, ctx.cwd, linkage);
}
async function dispatchSingleSignal(name: SignalName, ctx: SignalContext): Promise<SignalResult> {
  if (name === "complexity") return computeComplexity(ctx.absolutePath);
  if (name === "public-api") return detectPublicApi(ctx.absolutePath);
  if (name === "reuse") return computeReuseBreadth(ctx.absolutePath, ctx.contextGraph, ctx.externalDependents, ctx.cwd);
  if (name === "recency") return computeRecency(ctx.absolutePath, ctx.cwd);
  if (name === "tests") return computeTestsSignal(ctx);
  return detectDeprecation(ctx.absolutePath);
}
function errorSignal(name: SignalName, err: unknown): SignalResult {
  return { name, label: "Error", value: "Error", detail: String(err), confidence: "none", source: "error" };
}
async function runSingleSignal(name: SignalName, ctx: SignalContext, signals: SignalResult[], fallbackNotices: string[]): Promise<void> {
  try {
    const result = await dispatchSingleSignal(name, ctx);
    if (result.confidence === "none" && result.detail) fallbackNotices.push(`${name}: ${result.detail}`);
    signals.push(result);
  } catch (err) {
    fallbackNotices.push(`${name}: unexpected error`);
    signals.push(errorSignal(name, err));
  }
}
export async function computeFileSignals(
  absolutePath: string,
  cwd: string,
  contextGraph?: ContextGraph | null,
  requestedSignals?: SignalName[],
  _signal?: AbortSignal,
  externalDependents?: DependentInfo[],
): Promise<FileSignals> {
  const names = requestedSignals ?? ALL_SIGNALS;
  const signals: SignalResult[] = [];
  const fallbackNotices: string[] = [];
  const ctx: SignalContext = { absolutePath, cwd, contextGraph, externalDependents };
  for (const name of names) {
    await runSingleSignal(name, ctx, signals, fallbackNotices);
  }
  return {
    path: absolutePath,
    signals,
    computedAt: new Date().toISOString(),
    fallbackNotices,
  };
}
