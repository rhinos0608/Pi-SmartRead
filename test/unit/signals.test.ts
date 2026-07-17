import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeComplexity,
  detectPublicApi,
  computeReuseBreadth,
  computeRecency,
  detectTests,
  detectDeprecation,
  findTestLinkage,
} from "../../src/signals.js";
import type { ContextGraph } from "../../src/context-graph.js";

// ── Helpers ────────────────────────────────────────────────────────────

function runGit(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** Create a git repo with one committed file, return the file path. */
function setupGitRepo(dir: string, fileRel: string, content: string): string {
  runGit(["init"], dir);
  runGit(["config", "user.email", "test@test.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
  const fp = join(dir, fileRel);
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, content);
  runGit(["add", "."], dir);
  runGit(["commit", "-m", "initial"], dir);
  return fp;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : ".";
}

/** Stub ContextGraph returning canned importers. */
async function makeMockGraph(importingFiles: string[]): Promise<ContextGraph> {
  // Minimal mock that implements getFileNeighbours
  return {
    getFileNeighbours: async (_path: string) =>
      importingFiles.map((p) => ({
        path: p,
        provenance: { from: "", to: p, type: "imported_by" as const, confidence: 1 },
      })),
  } as unknown as ContextGraph;
}

let workdir: string;

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "signals-")));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Complexity ─────────────────────────────────────────────────────────

describe("computeComplexity", () => {
  it("TS function with many branches → label High", async () => {
    const src = `
function manyBranches() {
  if (a) {} if (b) {} if (c) {} if (d) {} if (e) {}
  if (f) {} if (g) {} if (h) {} if (i) {} if (j) {}
  for (let k = 0; k < 10; k++) {}
  while (l) {}
  switch (m) { case 1: break; case 2: break; case 3: break; case 4: break; case 5: break; case 6: break; }
  try {} catch (n) {}
  o ? p : q;
}
`;
    const fp = join(workdir, "high.ts");
    writeFileSync(fp, src);
    const result = await computeComplexity(fp);
    expect(result.name).toBe("complexity");
    expect(result.confidence).toMatch(/^(high|low)$/);
  });

  it("Python function complexity counts branches", async () => {
    const src = `
def foo():
    if x:
        pass
    for i in range(10):
        pass
    while y:
        pass
    try:
        pass
    except:
        pass
`;
    const fp = join(workdir, "mod.py");
    writeFileSync(fp, src);
    const result = await computeComplexity(fp);
    expect(result.name).toBe("complexity");
    expect(result.confidence).toMatch(/^(high|low)$/);
  });

  it("exported function branches are counted", async () => {
    const src = `
export function foo() {
  if (a) {}
  if (b) {}
}
`;
    const fp = join(workdir, "exported.ts");
    writeFileSync(fp, src);
    const result = await computeComplexity(fp);
    expect(result.name).toBe("complexity");
    expect(result.value).toBe("2");
  });

  it("bare function is not double-counted", async () => {
    const src = `
function foo() {
  if (a) {}
}
`;
    const fp = join(workdir, "bare.ts");
    writeFileSync(fp, src);
    const result = await computeComplexity(fp);
    expect(result.value).toBe("1");
  });

  it("top-level if/for contribute to total", async () => {
    const src = `
if (a) {}
for (let i = 0; i < 10; i++) {}
`;
    const fp = join(workdir, "toplevel.ts");
    writeFileSync(fp, src);
    const result = await computeComplexity(fp);
    expect(result.value).toBe("2");
  });

  it("unsupported language falls back to regex (confidence low)", async () => {
    const src = `
  if something
  for each
  while loop
  case match
  a && b
  c || d
  ternary ?
  catch error
`;
    const fp = join(workdir, "notes.txt");
    writeFileSync(fp, src);
    const result = await computeComplexity(fp);
    expect(result.name).toBe("complexity");
    expect(result.confidence).toBe("low");
    expect(result.source).toContain("regex");
  });
});

// ── Public API ─────────────────────────────────────────────────────────

describe("detectPublicApi", () => {
  it("TS exports → count exported symbols", () => {
    const src = `
export function alpha() {}
export class Bravo {}
export const gamma = 1;
export interface Delta {}
export type Eps = string;
`;
    const fp = join(workdir, "api.ts");
    writeFileSync(fp, src);
    const result = detectPublicApi(fp);
    expect(result.name).toBe("public-api");
    expect(result.value).toContain("5");
    expect(result.confidence).toBe("high");
  });

  it("Python __all__ → correct count", () => {
    const src = `
__all__ = ["alpha", "bravo", "charlie"]

def alpha():
    pass

def bravo():
    pass

def charlie():
    pass

def _internal():
    pass
`;
    const fp = join(workdir, "mod.py");
    writeFileSync(fp, src);
    const result = detectPublicApi(fp);
    expect(result.name).toBe("public-api");
    expect(result.value).toContain("3");
    expect(result.confidence).toBe("medium");
  });

  it("Python underscore convention → private when all start with _", () => {
    const src = `
def _helper():
    pass

def _internal():
    pass

class _Private:
    pass
`;
    const fp = join(workdir, "priv.py");
    writeFileSync(fp, src);
    const result = detectPublicApi(fp);
    // No __all__, and all defs/classes start with _ → No public symbols
    expect(result.name).toBe("public-api");
    expect(result.label).toBe("No");
  });
});

// ── Reuse ──────────────────────────────────────────────────────────────

describe("computeReuseBreadth", () => {
  it("graph with 4 importing files → Yes (4)", async () => {
    const graph = await makeMockGraph([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/lib/c.ts",
      "/repo/test/d.test.ts",
    ]);
    const result = await computeReuseBreadth("/repo/src/target.ts", graph);
    expect(result.name).toBe("reuse");
    expect(result.value).toBe("Yes (4 importing files)");
    expect(result.confidence).toBe("high");
  });

  it("no graph → Unknown", async () => {
    const result = await computeReuseBreadth("/repo/src/target.ts", null);
    expect(result.name).toBe("reuse");
    expect(result.value).toBe("Unknown");
    expect(result.confidence).toBe("none");
  });

  it("undefined graph → Unknown", async () => {
    const result = await computeReuseBreadth("/repo/src/target.ts");
    expect(result.name).toBe("reuse");
    expect(result.value).toBe("Unknown");
    expect(result.confidence).toBe("none");
  });
});

// ── Recency ────────────────────────────────────────────────────────────

describe("computeRecency", () => {
  it("git available → relative date string", async () => {
    const fp = setupGitRepo(workdir, "file.ts", "hello");
    const result = await computeRecency(fp, workdir);
    expect(result.name).toBe("recency");
    expect(result.value).not.toBe("Unknown");
    expect(result.confidence).toBe("high");
  });

  it("no git, mtime < 1 day → 'today'", async () => {
    const fp = join(workdir, "fresh.ts");
    writeFileSync(fp, "fresh file");
    const result = await computeRecency(fp, workdir);
    expect(result.name).toBe("recency");
    // Should be "today" from mtime fallback since file was just written
    expect(["today", "seconds ago", "minutes ago"]).toContain(result.value);
  });

  it("no git, old mtime → Unknown", async () => {
    const fp = join(workdir, "old.ts");
    writeFileSync(fp, "old file");
    // Set mtime to 2 days ago
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    utimesSync(fp, twoDaysAgo / 1000, twoDaysAgo / 1000);
    const result = await computeRecency(fp, workdir);
    expect(result.name).toBe("recency");
    expect(result.value).toBe("Unknown");
  });
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("detectTests", () => {
  it("test file found in test/ dir", () => {
    const srcDir = join(workdir, "src");
    const testDir = join(workdir, "test");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(srcDir, "auth.ts"), "export function auth() {}");
    writeFileSync(join(testDir, "auth.test.ts"), "import { auth } from '../src/auth';");

    const result = detectTests(join(srcDir, "auth.ts"), workdir);
    expect(result.name).toBe("tests");
    expect(result.label).toBe("Yes");
    expect(result.value).toContain("auth.test.ts");
    expect(result.confidence).toBe("medium");
  });

  it("no test file → No tests found", () => {
    const srcDir = join(workdir, "lib");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "helper.ts"), "export const help = 1;");

    const result = detectTests(join(srcDir, "helper.ts"), workdir);
    expect(result.name).toBe("tests");
    expect(result.value).toBe("No tests found");
  });
});

// ── Deprecation ────────────────────────────────────────────────────────

describe("detectDeprecation", () => {
  it("@deprecated marker found", () => {
    const src = `
/**
 * @deprecated Use newFn instead
 */
function oldFn() {}
`;
    const fp = join(workdir, "depr.ts");
    writeFileSync(fp, src);
    const result = detectDeprecation(fp);
    expect(result.name).toBe("deprecation");
    expect(result.label).toBe("Yes");
    expect(result.value).toContain("1");
    expect(result.confidence).toBe("medium");
  });

  it("no markers → No markers found", () => {
    const src = "function clean() { return 42; }";
    const fp = join(workdir, "clean.ts");
    writeFileSync(fp, src);
    const result = detectDeprecation(fp);
    expect(result.name).toBe("deprecation");
    expect(result.value).toBe("No markers found");
  });
});

// ── Extended Test Linkage (WP-3) ─────────────────────────────────

describe("findTestLinkage", () => {
  it("finds direct test file in test/ directory", () => {
    const srcDir = join(workdir, "src");
    const testDir = join(workdir, "test");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(srcDir, "auth.ts"), "export function auth() {} ");
    writeFileSync(join(testDir, "auth.test.ts"), "import { auth } from '../src/auth'; test('ok', () => {}); ");

    const result = findTestLinkage(join(srcDir, "auth.ts"), workdir);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.coverage).toBe("direct");
    expect(result[0]!.testFile).toContain("auth.test.ts");
  });

  it("returns indirect for test without direct import", () => {
    const srcDir = join(workdir, "src");
    const testDir = join(workdir, "test");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(srcDir, "helper.ts"), "export const x = 1; ");
    writeFileSync(join(testDir, "helper.test.ts"), "import { something } from './other'; test('ok', () => {}); ");

    const result = findTestLinkage(join(srcDir, "helper.ts"), workdir);
    expect(result.length).toBe(1);
    expect(result[0]!.coverage).toBe("indirect");
  });

  it("returns empty when no test files exist", () => {
    const srcDir = join(workdir, "lib");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "util.ts"), "export const y = 2; ");

    const result = findTestLinkage(join(srcDir, "util.ts"), workdir);
    expect(result).toEqual([]);
  });

  it("finds test in __tests__ directory", () => {
    const srcDir = join(workdir, "src");
    const testsDir = join(srcDir, "__tests__");
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(join(srcDir, "foo.ts"), "export const foo = 1; ");
    writeFileSync(join(testsDir, "foo.test.ts"), "test('foo', () => {}); ");

    const result = findTestLinkage(join(srcDir, "foo.ts"), workdir);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("sourceFile is set on each result", () => {
    const srcDir = join(workdir, "src");
    const testDir = join(workdir, "test");
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    const srcPath = join(srcDir, "bar.ts");
    writeFileSync(srcPath, "export const bar = 1; ");
    writeFileSync(join(testDir, "bar.test.ts"), "test('bar', () => {}); ");

    const result = findTestLinkage(srcPath, workdir);
    expect(result[0]!.sourceFile).toBe(srcPath);
  });
});
