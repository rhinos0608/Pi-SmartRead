// ── Test Linkage (candidate discovery + import matching + coverage gaps) ──
//
// Owns file-name candidate discovery, Python/TS import matching
// (direct vs indirect coverage), and static call-graph coverage-gap
// analysis. Signal orchestration in signals.ts computes linkage once
// per run and reuses it via the optional precomputed params.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, dirname, basename, join, extname } from "node:path";
import type { TestLinkage } from "./signals-types.js";
import { resolveImportPath } from "./structural-imports.js";
import { extractStructuralFacts } from "./structural-facts.js";
import { buildCallGraph, type CallGraphResult } from "./callgraph.js";
import type { StructuralFacts, ChildSymbol } from "./structural-facts-types.js";
import { filenameToLang } from "../languages.js";
import { commonPathRoot } from "../workspace/workspace-boundary.js";

function isPythonFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".py" || ext === ".pyi" || ext === ".pyx";
}

interface CandidateRoots {
  srcDir: string;
  testDir: string;
  testsDir: string;
  srcTestDir: string;
  repoTestDir: string;
  repoTestsDir: string;
}

interface MatchContext {
  candidateDir: string;
  cwd: string;
  absolutePath: string;
  isPy: boolean;
}

function candidateRoots(dir: string, cwd: string): CandidateRoots {
  return {
    srcDir: dir,
    testDir: resolve(dir, "..", "test"),
    testsDir: resolve(dir, "..", "tests"),
    srcTestDir: resolve(dir, "__tests__"),
    repoTestDir: resolve(cwd, "test"),
    repoTestsDir: resolve(cwd, "tests"),
  };
}

function listChildDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => resolve(dir, d.name));
  } catch {
    return [];
  }
}

// Bounded (2-level) subdirectory walk under repo test roots for
// layouts like test/unit/<name>.test.ts.
function collectTestSubDirs(roots: { repoTestDir: string; repoTestsDir: string }): Set<string> {
  const subDirs = new Set<string>();
  for (const root of [roots.repoTestDir, roots.repoTestsDir]) {
    subDirs.add(root);
    for (const d1 of listChildDirs(root)) {
      subDirs.add(d1);
      for (const d2 of listChildDirs(d1)) {
        subDirs.add(d2);
      }
    }
  }
  return subDirs;
}

function addFixedCandidates(
  out: Set<string>,
  ctx: { roots: CandidateRoots; testSubDirs: Set<string>; base: string; ext: string },
): void {
  const { roots, testSubDirs, base, ext } = ctx;
  out.add(resolve(roots.testDir, `${base}.test${ext}`));
  out.add(resolve(roots.testDir, `${base}.spec${ext}`));
  out.add(resolve(roots.testDir, `test_${base}${ext}`));
  out.add(resolve(roots.testDir, `${base}_test${ext}`));
  out.add(resolve(roots.testsDir, `test_${base}${ext}`));
  out.add(resolve(roots.testsDir, `${base}_test${ext}`));
  out.add(resolve(roots.srcDir, `${base}.test${ext}`));
  out.add(resolve(roots.srcDir, `${base}.spec${ext}`));
  out.add(resolve(roots.srcDir, `test_${base}${ext}`));
  out.add(resolve(roots.srcTestDir, `${base}.test${ext}`));
  for (const subDir of testSubDirs) {
    out.add(resolve(subDir, `${base}.test${ext}`));
    out.add(resolve(subDir, `${base}.spec${ext}`));
    out.add(resolve(subDir, `test_${base}${ext}`));
    out.add(resolve(subDir, `${base}_test${ext}`));
  }
  out.add(resolve(roots.repoTestsDir, `test_${base}${ext}`));
}

function buildTestCandidates(args: {
  basenameNoExt: string;
  exts: string[];
  roots: CandidateRoots;
  testSubDirs: Set<string>;
}): Set<string> {
  const out = new Set<string>();
  for (const ext of args.exts) {
    addFixedCandidates(out, { roots: args.roots, testSubDirs: args.testSubDirs, base: args.basenameNoExt, ext });
  }
  return out;
}

function modulePathMatchesAbsolute(modPath: string, absolutePath: string): boolean {
  return modPath + ".py" === absolutePath || join(modPath, "__init__.py") === absolutePath;
}

function moduleNameMatchesFile(args: { modName: string } & MatchContext): boolean {
  const modPath = (baseDir: string): string => join(baseDir, args.modName.replace(/\./g, "/"));
  return modulePathMatchesAbsolute(modPath(args.candidateDir), args.absolutePath)
    || modulePathMatchesAbsolute(modPath(args.cwd), args.absolutePath);
}

function importListMatches(args: { list: string } & MatchContext): boolean {
  for (const mod of args.list.split(",")) {
    const modName = mod.trim();
    if (!modName) continue;
    if (moduleNameMatchesFile({ ...args, modName })) return true;
  }
  return false;
}

function matchPythonImports(args: { testContent: string } & MatchContext): boolean {
  const pyImportRe =
    /^import\s+([a-zA-Z_][\w.]*(?:\s*,\s*[a-zA-Z_][\w.]*)*)\s*$|^from\s+([a-zA-Z_][\w.]+)\s+import\s+/gm;
  pyImportRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pyImportRe.exec(args.testContent)) !== null) {
    if (m[1] && importListMatches({ ...args, list: m[1] })) return true;
    if (m[2] && moduleNameMatchesFile({ ...args, modName: m[2].trim() })) return true;
  }
  return false;
}

function barePythonModuleMatches(args: { specifier: string } & MatchContext): boolean {
  for (const ext of [".py"]) {
    if (join(args.candidateDir, args.specifier + ext) === args.absolutePath) return true;
    if (join(args.candidateDir, args.specifier, "__init__.py") === args.absolutePath) return true;
  }
  return false;
}

function matchesWithExtension(resolved: string, absolutePath: string, exts: string[]): boolean {
  for (const ext of exts) {
    if (resolved + ext === absolutePath) return true;
  }
  return false;
}

function matchesIndexFile(
  args: { resolved: string; resolveExts: string[] } & MatchContext,
): boolean {
  for (const ext of args.resolveExts) {
    if (join(args.resolved, `index${ext}`) === args.absolutePath) return true;
    if (args.isPy && join(args.resolved, "__init__.py") === args.absolutePath) return true;
  }
  return false;
}

function jsToTsTranslatedPath(args: { normalized: string; base: string } & MatchContext): string | undefined {
  if (!/\.(jsx?|mjs|cjs)$/.test(args.normalized)) return undefined;
  // Shared TS resolver maps ./module.js → module.ts on disk (never module.js.ts).
  // Anchor the probe importer at base so leading-slash (cwd) and relative
  // (candidateDir) specifiers resolve against the same directory as above.
  try {
    return resolveImportPath(join(args.base, "__smartread_probe__.ts"), args.normalized) ?? undefined;
  } catch {
    return undefined;
  }
}

function resolvedPathMatches(args: { normalized: string; base: string } & MatchContext): boolean {
  let resolved: string;
  try {
    resolved = resolve(args.base, args.normalized);
  } catch {
    return false;
  }
  if (resolved === args.absolutePath) return true;
  if (jsToTsTranslatedPath(args) === args.absolutePath) return true;
  const resolveExts = args.isPy ? [".py"] : [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  if (matchesWithExtension(resolved, args.absolutePath, resolveExts)) return true;
  return matchesIndexFile({ ...args, resolved, resolveExts });
}

function specifierIsDirect(args: { specifier: string } & MatchContext): boolean {
  const { specifier } = args;
  // Normalize leading slash: resolve relative to cwd, not filesystem root
  const normalized = specifier.startsWith("/") ? "." + specifier : specifier;
  const base = specifier.startsWith("/") ? args.cwd : args.candidateDir;
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    // Bare specifiers only resolve for Python; anything else stays indirect
    if (args.isPy && !specifier.startsWith(".")) {
      return barePythonModuleMatches(args);
    }
    return false;
  }
  return resolvedPathMatches({ ...args, normalized, base });
}

function matchSpecifierImports(args: { testContent: string } & MatchContext): boolean {
  const specifierRe =
    /(?:from\s+['"]([^'"]+)['"])|(?:import\s+['"]([^'"]+)['"])|(?:require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  specifierRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = specifierRe.exec(args.testContent)) !== null) {
    const specifier = m[1] ?? m[2] ?? m[3];
    if (!specifier) continue;
    if (specifierIsDirect({ ...args, specifier })) return true;
  }
  return false;
}

function isDirectCoverage(args: { testContent: string } & MatchContext): boolean {
  if (args.isPy && matchPythonImports(args)) return true;
  return matchSpecifierImports(args);
}

function classifyCandidate(args: { candidate: string } & MatchContext): TestLinkage | null {
  try {
    if (!existsSync(args.candidate)) return null;
    if (!statSync(args.candidate).isFile()) return null;
  } catch {
    return null;
  }
  let coverage: "direct" | "indirect" = "indirect";
  try {
    const testContent = readFileSync(args.candidate, "utf-8");
    if (isDirectCoverage({ ...args, testContent })) coverage = "direct";
  } catch {
    // Read failed — default to indirect
  }
  return { sourceFile: args.absolutePath, testFile: args.candidate, coverage };
}

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

  const roots = candidateRoots(dir, cwd);
  const testSubDirs = collectTestSubDirs(roots);
  const candidates = buildTestCandidates({ basenameNoExt, exts, roots, testSubDirs });

  const results: TestLinkage[] = [];
  for (const candidate of candidates) {
    const linkage = classifyCandidate({
      candidate,
      candidateDir: dirname(candidate),
      cwd,
      absolutePath,
      isPy,
    });
    if (linkage) results.push(linkage);
  }

  return results;
}

/** Count linked test files for a source file. */
export function linkageCount(absolutePath: string, cwd: string): number {
  return findTestLinkage(absolutePath, cwd).length;
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
  precomputedLinkage?: TestLinkage[],
): Promise<{
  tested: string[];
  unreferenced: string[];
  unknown: string[];
}> {
  // (1) Reuse linked tests from findTestLinkage
  const linkage = precomputedLinkage ?? findTestLinkage(absolutePath, cwd);
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
  const root = commonPathRoot([absolutePath, ...testFiles]);
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
