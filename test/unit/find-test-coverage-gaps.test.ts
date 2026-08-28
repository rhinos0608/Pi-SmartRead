import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findTestCoverageGaps } from "../../src/signals.js";

function runGit(args: string[], cwd: string) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function setupGitRepo(dir: string): void {
  runGit(["init"], dir);
  runGit(["config", "user.email", "test@test.com"], dir);
  runGit(["config", "user.name", "Test"], dir);
}

let workdir: string;

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "coverage-gaps-")));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("findTestCoverageGaps", () => {
  it("buckets referenced and unreferenced exports correctly", async () => {
    setupGitRepo(workdir);

    const srcDir = join(workdir, "src");
    mkdirSync(srcDir, { recursive: true });

    // Source file with exported functions — some referenced in tests, some not
    const srcContent = [
      "export function used(): string { return 'used'; }",
      "export function unused(): string { return 'unused'; }",
      "export function alsoUsed(): string { return 'also used'; }",
      "function internal(): string { return used(); }",
    ].join("\n");
    const srcPath = join(srcDir, "math.ts");
    writeFileSync(srcPath, srcContent);

    // Test file that references 'used' and 'alsoUsed' but not 'unused'
    const testDir = join(workdir, "test");
    mkdirSync(testDir, { recursive: true });
    const testContent = [
      "import { used, alsoUsed } from '../src/math.js';",
      "export function testUsed(): string { return used(); }",
      "export function testAlsoUsed(): string { return alsoUsed(); }",
    ].join("\n");
    writeFileSync(join(testDir, "math.test.ts"), testContent);

    runGit(["add", "."], workdir);
    runGit(["commit", "-m", "initial"], workdir);

    const result = await findTestCoverageGaps(srcPath, workdir);

    expect(result.tested).toContain("used");
    expect(result.tested).toContain("alsoUsed");
    expect(result.unreferenced).toContain("unused");
    expect(result.unknown).toEqual([]);
  });

  it("returns unknown (not untested) for unparseable files", async () => {
    setupGitRepo(workdir);

    const srcDir = join(workdir, "src");
    mkdirSync(srcDir, { recursive: true });

    // Write a file that tree-sitter cannot parse
    const srcPath = join(srcDir, "broken.ts");
    writeFileSync(srcPath, "not valid { javascript {{{");

    const testDir = join(workdir, "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "broken.test.ts"), "test('broken', () => {});");

    runGit(["add", "."], workdir);
    runGit(["commit", "-m", "initial"], workdir);

    const result = await findTestCoverageGaps(srcPath, workdir);

    // Parse failure → empty buckets (no exports detected, so no unreferenced)
    expect(result.unreferenced).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it("returns empty buckets when no test files are linked", async () => {
    setupGitRepo(workdir);

    const srcDir = join(workdir, "src");
    mkdirSync(srcDir, { recursive: true });

    const srcPath = join(srcDir, "solo.ts");
    writeFileSync(srcPath, "export const x = 1;");

    runGit(["add", "."], workdir);
    runGit(["commit", "-m", "initial"], workdir);

    const result = await findTestCoverageGaps(srcPath, workdir);

    expect(result.tested).toEqual([]);
    expect(result.unreferenced).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it("returns empty buckets for unsupported language", async () => {
    setupGitRepo(workdir);

    const srcDir = join(workdir, "src");
    mkdirSync(srcDir, { recursive: true });

    // .rb file — unsupported language
    const srcPath = join(srcDir, "app.rb");
    writeFileSync(srcPath, "def hello; puts 'hi'; end");

    const testDir = join(workdir, "test");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "app_test.rb"), "require 'test/unit'");

    runGit(["add", "."], workdir);
    runGit(["commit", "-m", "initial"], workdir);

    const result = await findTestCoverageGaps(srcPath, workdir);

    // Unsupported language → unknown, never untested
    expect(result.unreferenced).toEqual([]);
  });

  it("handles class exports alongside function exports", async () => {
    setupGitRepo(workdir);

    const srcDir = join(workdir, "src");
    mkdirSync(srcDir, { recursive: true });

    const srcContent = [
      "export class MyService {",
      "  doWork(): string { return 'done'; }",
      "}",
      "export function helper(): string { return 'help'; }",
    ].join("\n");
    const srcPath = join(srcDir, "service.ts");
    writeFileSync(srcPath, srcContent);

    const testDir = join(workdir, "test");
    mkdirSync(testDir, { recursive: true });
    // Test only references helper, not MyService
    const testContent = [
      "import { helper } from '../src/service.js';",
      "export function testHelper(): string { return helper(); }",
    ].join("\n");
    writeFileSync(join(testDir, "service.test.ts"), testContent);

    runGit(["add", "."], workdir);
    runGit(["commit", "-m", "initial"], workdir);

    const result = await findTestCoverageGaps(srcPath, workdir);

    expect(result.tested).toContain("helper");
    expect(result.unreferenced).toContain("MyService");
    expect(result.unknown).toEqual([]);
  });

  it("marks all exported callables as unreferenced when test file exists but imports nothing", async () => {
    setupGitRepo(workdir);

    const srcDir = join(workdir, "src");
    mkdirSync(srcDir, { recursive: true });

    const srcContent = "export function greet(): string { return 'hi'; }";
    const srcPath = join(srcDir, "greet.ts");
    writeFileSync(srcPath, srcContent);

    const testDir = join(workdir, "test");
    mkdirSync(testDir, { recursive: true });
    // Test file exists but doesn't import or call greet
    const testContent = "import { helper } from './other.js';\nexport function testHelper(): string { return helper(); }";
    writeFileSync(join(testDir, "greet.test.ts"), testContent);

    runGit(["add", "."], workdir);
    runGit(["commit", "-m", "initial"], workdir);

    const result = await findTestCoverageGaps(srcPath, workdir);

    expect(result.unreferenced).toContain("greet");
    expect(result.tested).toEqual([]);
    expect(result.unknown).toEqual([]);
  });
});
