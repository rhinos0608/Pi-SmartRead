import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { relative, resolve, dirname, basename, extname, join } from "node:path";
import { createRequire } from "node:module";
import type { SignalName, SignalResult, FileSignals } from "./signals-types.js";
import type { TestLinkage } from "./signals-types.js";
import type { ContextGraph } from "./context-graph.js";
import type { DependentInfo } from "./structural-facts-types.js";
import { findImportDependents, extractStructuralFacts } from "./structural-facts.js";
import { buildCallGraph, type CallGraphResult } from "./callgraph.js";
import type { StructuralFacts, ChildSymbol } from "./structural-facts-types.js";
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

export async function computeReuseBreadth(
  absolutePath: string,
  graph?: ContextGraph | null,
  precomputedDependents?: DependentInfo[],
  cwd?: string,
): Promise<SignalResult> {
  if (!graph) {
    // Use precomputed dependents if provided (avoids second scan).
    if (precomputedDependents) return reuseFromImportScan(precomputedDependents);
    // Standalone scan: try workspace-wide import resolution
    const scanCwd = cwd ?? dirname(absolutePath);
    try {
      // Quick directory check — findSrcFiles returns [] for non-existent dirs
      // but we need to distinguish "no workspace" from "no dependents"
      if (!existsSync(scanCwd)) {
        return {
          name: "reuse",
          label: "Unknown",
          value: "Unknown",
          detail: "Graph unavailable — could not scan workspace",
          confidence: "none",
          source: "import scan",
        };
      }
      const dependents = await findImportDependents(absolutePath, scanCwd, filenameToLang(absolutePath) as any);
      return reuseFromImportScan(dependents);
    } catch {
      return {
        name: "reuse",
        label: "Unknown",
        value: "Unknown",
        detail: "Graph unavailable — could not scan workspace",
        confidence: "none",
        source: "import scan",
      };
    }
  }

  try {
    const targetPath = resolve(absolutePath);
    const graphPaths = new Set(
      graph.getProvenanceEdges()
        .filter((edge) => resolve(edge.to) === targetPath)
        .map((edge) => resolve(edge.from)),
    );
    const scanPaths = new Set((precomputedDependents ?? []).map((dependent) => resolve(dependent.file)));
    const uniquePaths = new Set([...graphPaths, ...scanPaths]);
    const count = uniquePaths.size;

    if (count > 0) {
      if (graphPaths.size === 0 && precomputedDependents) {
        return reuseFromImportScan(precomputedDependents);
      }
      const noun = count === 1 ? "file" : "files";
      return {
        name: "reuse",
        label: "Yes",
        value: `Yes (${count} importing ${noun})`,
        ...(count > graphPaths.size ? { detail: "context graph supplemented by direct import scan" } : {}),
        confidence: "high",
        source: count > graphPaths.size ? "context graph + import scan" : "context graph",
      };
    }

    return {
      name: "reuse",
      label: "No",
      value: "No importing files",
      confidence: "high",
      source: "context graph + import scan",
    };
  } catch {
    if (precomputedDependents) return reuseFromImportScan(precomputedDependents);
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
  const linkage = findTestLinkage(absolutePath, cwd)[0];
  if (linkage) {
    return {
      name: "tests",
      label: "Yes",
      value: `Yes (${relative(cwd, linkage.testFile)})`,
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

// ── Extended Test Linkage (WP-3) ──────────────────────────────

/**
 * Find test files that cover a given source file.
 * Uses file-name matching + import analysis for direct/indirect coverage.
 */
export function findTestLinkage(
  absolutePath: string,
  cwd: string,
): TestLinkage[] {
  const basenameNoExt = basename(absolutePath).replace(/\.[^.]+$/, "");
  const dir = dirname(absolutePath);
  const isPy = isPythonFile(absolutePath);
  const exts = isPy ? [".py"] : [".ts", ".tsx", ".js", ".jsx"];

  const testCandidates = new Set<string>();
  const srcDir = dir;
  const testDir = resolve(dir, "..", "test");
  const testsDir = resolve(dir, "..", "tests");
  const srcTestDir = resolve(dir, "__tests__");
  const repoTestDir = resolve(cwd, "test");
  const repoTestsDir = resolve(cwd, "tests");

  // Collect bounded subdirectory levels under repo test roots for layouts like test/unit/<name>.test.ts
  const testSubDirs = new Set<string>();
  for (const root of [repoTestDir, repoTestsDir]) {
    testSubDirs.add(root);
    try {
      for (const d1 of readdirSync(root, { withFileTypes: true })) {
        if (d1.isDirectory()) {
          testSubDirs.add(resolve(root, d1.name));
          try {
            for (const d2 of readdirSync(resolve(root, d1.name), { withFileTypes: true })) {
              if (d2.isDirectory()) testSubDirs.add(resolve(root, d1.name, d2.name));
            }
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip if root doesn't exist */ }
  }

  for (const ext of exts) {
    testCandidates.add(resolve(testDir, `${basenameNoExt}.test${ext}`));
    testCandidates.add(resolve(testDir, `${basenameNoExt}.spec${ext}`));
    testCandidates.add(resolve(testDir, `test_${basenameNoExt}${ext}`));
    testCandidates.add(resolve(testDir, `${basenameNoExt}_test${ext}`));
    testCandidates.add(resolve(testsDir, `test_${basenameNoExt}${ext}`));
    testCandidates.add(resolve(testsDir, `${basenameNoExt}_test${ext}`));
    testCandidates.add(resolve(srcDir, `${basenameNoExt}.test${ext}`));
    testCandidates.add(resolve(srcDir, `${basenameNoExt}.spec${ext}`));
    testCandidates.add(resolve(srcDir, `test_${basenameNoExt}${ext}`));
    testCandidates.add(resolve(srcTestDir, `${basenameNoExt}.test${ext}`));
    for (const subDir of testSubDirs) {
      testCandidates.add(resolve(subDir, `${basenameNoExt}.test${ext}`));
      testCandidates.add(resolve(subDir, `${basenameNoExt}.spec${ext}`));
      testCandidates.add(resolve(subDir, `test_${basenameNoExt}${ext}`));
      testCandidates.add(resolve(subDir, `${basenameNoExt}_test${ext}`));
    }
    testCandidates.add(resolve(repoTestsDir, `test_${basenameNoExt}${ext}`));
  }

  const results: TestLinkage[] = [];
  for (const candidate of testCandidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        let coverage: "direct" | "indirect" = "indirect";
        try {
          const testContent = readFileSync(candidate, "utf-8");
          // Parse import/require specifiers and resolve relative paths
          const specifierRe = /(?:from\s+['"]([^'"]+)['"])|(?:import\s+['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
          // Python-specific import patterns: "import package.module" and "from package.module import symbol"
          const pyImportRe = /^import\s+([a-zA-Z_][\w.]*(?:\s*,\s*[a-zA-Z_][\w.]*)*)\s*$|^from\s+([a-zA-Z_][\w.]+)\s+import\s+/gm;
          const candidateDir = dirname(candidate);
          let m: RegExpExecArray | null;
          let found = false;
          // Python: parse import/from statements
          if (isPy) {
            pyImportRe.lastIndex = 0;
            while ((m = pyImportRe.exec(testContent)) !== null) {
              if (m[1]) {
                // "import package.module" — try each comma-separated module
                for (const mod of m[1].split(",")) {
                  const modName = mod.trim();
                  if (!modName) continue;
                  // Try module as file or package from candidateDir and cwd
                  for (const baseDir of [candidateDir, cwd]) {
                    const modPath = join(baseDir, modName.replace(/\./g, "/"));
                    if (modPath + ".py" === absolutePath || join(modPath, "__init__.py") === absolutePath) {
                      found = true; break;
                    }
                  }
                  if (found) break;
                }
              } else if (m[2]) {
                // "from package.module import symbol"
                const modName = m[2].trim();
                for (const baseDir of [candidateDir, cwd]) {
                  const modPath = join(baseDir, modName.replace(/\./g, "/"));
                  if (modPath + ".py" === absolutePath || join(modPath, "__init__.py") === absolutePath) {
                    found = true; break;
                  }
                }
              }
              if (found) break;
            }
          }
          // JS/TS: parse import/require specifiers
          specifierRe.lastIndex = 0;
          while ((m = specifierRe.exec(testContent)) !== null) {
            if (found) break;
            const specifier = m[1] ?? m[2] ?? m[3];
            if (!specifier) continue;
            // Resolve root-relative against cwd, dot-relative against candidateDir
            // Normalize leading slash: resolve relative to cwd, not filesystem root
            const normalized = specifier.startsWith("/") ? "." + specifier : specifier;
            const base = normalized.startsWith("/") ? cwd : candidateDir;
            if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
              // Python: try bare module name resolution
              if (isPy && !specifier.startsWith(".")) {
                // Try module as file or package
                for (const ext of [".py"]) {
                  if (join(candidateDir, specifier + ext) === absolutePath) {
                    found = true; break;
                  }
                  // Try package __init__.py
                  if (join(candidateDir, specifier, "__init__.py") === absolutePath) {
                    found = true; break;
                  }
                }
                if (found) break;
              }
              continue;
            }
            try {
              const resolved = resolve(base, normalized);
              // Try exact path
              let match = resolved === absolutePath;
              // Try extension resolution
              const resolveExts = isPy ? [".py"] : [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
              if (!match) {
                for (const ext of resolveExts) {
                  if (resolved + ext === absolutePath) {
                    match = true;
                    break;
                  }
                }
              }
              // Try index-file resolution (directory → index.*)
              if (!match) {
                for (const ext of resolveExts) {
                  if (join(resolved, `index${ext}`) === absolutePath) {
                    match = true;
                    break;
                  }
                  if (isPy && join(resolved, "__init__.py") === absolutePath) {
                    match = true;
                    break;
                  }
                }
              }
              if (match) { found = true; break; }
            } catch {
              // Path resolution failed, skip
            }
          }
          if (found) {
            coverage = "direct";
          }
        } catch {
          // Read failed — default to indirect
        }
        results.push({ sourceFile: absolutePath, testFile: candidate, coverage });
      }
    } catch {
      continue;
    }
  }

  return results;
}

/** Count linked test files for a source file. */
function linkageCount(absolutePath: string, cwd: string): number {
  return findTestLinkage(absolutePath, cwd).length;
}

/** Compute the longest common root directory from absolute paths. */
function commonRoot(files: string[]): string {
  const paths = files.map(f => resolve(f));
  if (paths.length === 1) return dirname(paths[0]!);
  const parts = paths.map(p => p.split("/"));
  let i = 0;
  while (i < parts[0]!.length && parts.every(p => p[i] === parts[0]![i])) i++;
  return parts[0]!.slice(0, Math.max(1, i)).join("/") || "/";
}

/** Callable-symbol kinds that should appear in coverage gaps. */
const COVERAGE_KINDS = new Set<ChildSymbol["kind"]>(["function", "method", "class"]);

/**
 * Static test-coverage gap analysis.
 *
 * Uses linked test files from findTestLinkage() + extractStructuralFacts()
 * to identify exported callables that are / are not statically referenced
 * from any linked test file via the call graph.
 *
 * Returns three buckets:
 *  - tested:         exported callables referenced from test files
 *  - unreferenced:   exported callables with no test-file reference found
 *  - unknown:        parser ambiguity or unsupported language (never untested)
 *
 * This is static call-graph linkage only — it does NOT detect runtime
 * coverage, dynamic calls, mocks, aliases, or reflection.
 */
export async function findTestCoverageGaps(
  absolutePath: string,
  cwd: string,
): Promise<{
  tested: string[];
  unreferenced: string[];
  unknown: string[];
}> {
  // (1) Reuse linked tests from findTestLinkage
  const linkage = findTestLinkage(absolutePath, cwd);
  if (linkage.length === 0) {
    return { tested: [], unreferenced: [], unknown: [] };
  }
  const testFiles = [...new Set(linkage.map(l => l.testFile))];

  // (2) Use extractStructuralFacts to identify exported/callable symbols
  let facts: StructuralFacts;
  try {
    facts = await extractStructuralFacts(absolutePath, cwd);
  } catch {
    // Parse failure → everything unknown, not untested
    return { tested: [], unreferenced: [], unknown: [] };
  }

  // Unsupported language (parser returned notices about missing support)
  const lang = filenameToLang(absolutePath);
  if (!lang) {
    return { tested: [], unreferenced: [], unknown: [] };
  }

  const exportedCallables = facts.children.filter(
    c => c.isExported && COVERAGE_KINDS.has(c.kind),
  );
  if (exportedCallables.length === 0) {
    return { tested: [], unreferenced: [], unknown: [] };
  }

  // (3) Build call graph with [source, ...directTests]
  let callGraph: CallGraphResult;
  try {
    callGraph = await buildCallGraph([absolutePath, ...testFiles]);
  } catch {
    // Build failure → all exported callables are unknown
    return {
      tested: [],
      unreferenced: [],
      unknown: exportedCallables.map(c => c.name),
    };
  }

  // Compute the common root to resolve relative file paths back to absolute
  const root = commonRoot([absolutePath, ...testFiles]);
  const testFileAbsSet = new Set(testFiles.map(f => resolve(f)));

  const tested: string[] = [];
  const unreferenced: string[] = [];

  // (4) A callable counts as referenced only when a resolved caller
  //     originates in one of the linked test files
  for (const callable of exportedCallables) {
    const callers = callGraph.callersOf(callable.name);
    const hasTestCaller = callers.some(caller => {
      const callerAbs = resolve(root, caller.file);
      return testFileAbsSet.has(callerAbs);
    });
    if (hasTestCaller) {
      tested.push(callable.name);
    } else {
      unreferenced.push(callable.name);
    }
  }

  return { tested, unreferenced, unknown: [] };
}

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
          result = await computeReuseBreadth(absolutePath, contextGraph, externalDependents, cwd);
          break;
        case "recency":
          result = await computeRecency(absolutePath, cwd);
          break;
        case "tests":
          result = detectTests(absolutePath, cwd);
          // WP-8: enrich with static call-graph coverage gaps
          if (result.confidence !== "none") {
            try {
              const gaps = await findTestCoverageGaps(absolutePath, cwd);
              const totalExported = gaps.tested.length + gaps.unreferenced.length + gaps.unknown.length;
              if (totalExported > 0) {
                const referencedCount = gaps.tested.length;
                const detailParts = [
                  `Linked ${linkageCount(absolutePath, cwd)} tests; ${referencedCount}/${totalExported} exported callables statically referenced`,
                ];
                if (gaps.unreferenced.length > 0) {
                  const shown = gaps.unreferenced.slice(0, 20);
                  detailParts.push(`Unreferenced: ${shown.join(", ")}${gaps.unreferenced.length > 20 ? ` (+${gaps.unreferenced.length - 20} more)` : ""}`);
                }
                result = { ...result, detail: detailParts.join("; ") };
              }
            } catch {
              // Best-effort: leave base signal unchanged
            }
          }
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
