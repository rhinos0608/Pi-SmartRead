import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isStateRoot, resolveStateRoot } from "../../../src/workspace/state-root.js";

const cleanupRoots: string[] = [];

afterEach(() => {
  while (cleanupRoots.length > 0) {
    rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
  }
});

/** Realpathed mkdtemp root so expectations match what resolveStateRoot returns. */
function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupRoots.push(root);
  return root;
}

function writeFile(root: string, rel: string, content = '{"name":"fixture"}\n'): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function initGitRepo(dir: string): void {
  git(dir, "init");
  git(dir, "config", "user.name", "State Root Test");
  git(dir, "config", "user.email", "state-root@example.com");
}

describe("resolveStateRoot", () => {
  it("resolves a file under a nested marker dir to the git top level", () => {
    const repo = tempRoot("state-root-git-");
    initGitRepo(repo);
    writeFile(repo, "pkg/test/fixtures/package.json");

    // The old marker walk stopped at fixtures/package.json; git must win.
    expect(resolveStateRoot(join(repo, "pkg", "test", "fixtures", "package.json"))).toBe(repo);
    expect(resolveStateRoot(join(repo, "pkg", "test", "fixtures"))).toBe(repo);
    expect(resolveStateRoot(repo)).toBe(repo);
  });

  it("returns the outermost marker for a non-git snapshot", () => {
    const snap = tempRoot("state-root-snap-");
    writeFile(snap, "package.json");
    writeFile(snap, "packages/a/package.json");

    expect(resolveStateRoot(join(snap, "packages", "a"))).toBe(snap);
    expect(resolveStateRoot(join(snap, "packages", "a", "package.json"))).toBe(snap);
    expect(resolveStateRoot(snap)).toBe(snap);
  });

  it("returns null for a plain directory with no marker", () => {
    const plain = tempRoot("state-root-plain-");
    expect(resolveStateRoot(plain)).toBeNull();
    expect(isStateRoot(plain)).toBe(false);
  });

  it("excludes the home directory, its ancestors, but not descendants", () => {
    const area = tempRoot("state-root-home-");
    const home = join(area, "home");
    mkdirSync(home);
    writeFile(home, "package.json");
    const child = join(home, "child");
    mkdirSync(child);

    // $HOME/package.json alone is not a state root.
    expect(resolveStateRoot(home, { homeDir: home })).toBeNull();
    // A marker above home is excluded too.
    writeFile(area, "package.json");
    expect(resolveStateRoot(child, { homeDir: home })).toBeNull();
    // Descendants of home still qualify as outermost marker.
    const sub = join(home, "sub");
    writeFile(sub, "package.json");
    expect(resolveStateRoot(sub, { homeDir: home })).toBe(sub);
  });

  it("resolves a git worktree (.git as a file) to the worktree dir", () => {
    const area = tempRoot("state-root-wt-");
    const repo = join(area, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    writeFile(repo, "README.md", "readme\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "init");
    const worktree = join(area, "wt");
    git(repo, "worktree", "add", worktree);

    expect(statSync(join(worktree, ".git")).isFile()).toBe(true);
    expect(resolveStateRoot(worktree)).toBe(worktree);
  });

  it("resolves a nested git repo inside a non-git marker dir to the inner repo", () => {
    const outer = tempRoot("state-root-outer-");
    writeFile(outer, "package.json");
    const inner = join(outer, "inner");
    mkdirSync(inner);
    initGitRepo(inner);
    mkdirSync(join(inner, "src"));

    expect(resolveStateRoot(join(inner, "src"))).toBe(inner);
    // The non-git outer dir keeps its own marker root.
    expect(resolveStateRoot(outer)).toBe(outer);
  });

  it("resolves a symlinked target to the realpath of its root", () => {
    const real = tempRoot("state-root-real-");
    writeFile(real, "package.json");
    const link = join(tmpdir(), `state-root-link-${process.pid}-${Date.now()}`);
    rmSync(link, { recursive: true, force: true });
    try {
      symlinkSync(real, link, "dir");
    } catch {
      return; // platforms without symlink support skip gracefully
    }
    try {
      expect(resolveStateRoot(link)).toBe(real);
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  });
});

describe("isStateRoot", () => {
  it("is true only for the canonical root itself", () => {
    const repo = tempRoot("state-root-is-");
    initGitRepo(repo);
    writeFile(repo, "pkg/package.json");

    expect(isStateRoot(repo)).toBe(true);
    expect(isStateRoot(join(repo, "pkg"))).toBe(false);
    expect(isStateRoot(join(repo, "pkg", "package.json"))).toBe(false);
    // Fail closed for unresolvable paths.
    expect(isStateRoot(join(repo, "does-not-exist"))).toBe(false);
  });
});
