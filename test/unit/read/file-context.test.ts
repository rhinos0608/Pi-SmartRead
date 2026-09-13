import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildFileContextLines } from "../../src/file-context.js";
import { ContextGraph, EdgeStore } from "../../src/context-graph.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("buildFileContextLines", () => {
  let repo: string;

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(path.join(tmpdir(), "file-context-")));
    git(repo, "init");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", ".");
    // Commit message carries a trailer whose key is in the default
    // showTrailerKeys (["Constraint", "Directive", "Rejected"]).
    git(repo, "commit", "-m", "add a.ts", "-m", "Constraint: keep the public API frozen");
    git(repo, "notes", "--ref=refs/notes/pi-smartread", "add", "-m", "decision: keep a tiny", "HEAD");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("includes recent commits, configured trailers, and git notes for a tracked file", async () => {
    const lines = await buildFileContextLines({ fullPath: path.join(repo, "a.ts"), cwd: repo });
    const text = lines.join("\n");
    expect(text).toContain("🔍 Context for a.ts:");
    expect(text).toContain("Recent commits:");
    expect(text).toContain("add a.ts");
    expect(text).toContain("Constraint: keep the public API frozen");
    expect(text).toContain("Git notes:");
    expect(text).toContain("decision: keep a tiny");
  });

  it("joins top three EdgeStore co-change edges into nearby file rationale", async () => {
    const target = path.join(repo, "a.ts");
    const peers = ["b.ts", "c.ts", "d.ts", "e.ts"];
    for (const peer of peers) writeFileSync(path.join(repo, peer), "export const peer = 1;\n");
    EdgeStore.recordCoChange(repo, target, path.join(repo, "b.ts"), "correlation=0.90", 0.9);
    EdgeStore.recordCoChange(repo, target, path.join(repo, "c.ts"), "correlation=0.80", 0.8);
    EdgeStore.recordCoChange(repo, target, path.join(repo, "d.ts"), "correlation=0.70", 0.7);
    EdgeStore.recordCoChange(repo, target, path.join(repo, "e.ts"), "correlation=0.60", 0.6);

    const text = (await buildFileContextLines({ fullPath: target, cwd: repo })).join("\n");
    expect(text).toContain("Nearby: b.ts");
    expect(text).toContain("Nearby: c.ts");
    expect(text).toContain("Nearby: d.ts");
    expect(text).not.toContain("Nearby: e.ts");
    expect(text).toContain("co-change/history (confidence 0.90, correlation 0.90)");
  });

  it("caps recent history enrichment at three follow commits", async () => {
    const historyRepo = realpathSync(mkdtempSync(path.join(tmpdir(), "file-context-history-")));
    try {
      git(historyRepo, "init");
      git(historyRepo, "config", "user.email", "t@example.com");
      git(historyRepo, "config", "user.name", "t");
      const tracked = path.join(historyRepo, "tracked.ts");
      for (let i = 1; i <= 4; i++) {
        writeFileSync(tracked, `export const version = ${i};\n`);
        git(historyRepo, "add", ".");
        git(historyRepo, "commit", "-m", `commit ${i}`);
      }
      const text = (await buildFileContextLines({ fullPath: tracked, cwd: historyRepo })).join("\n");
      expect((text.match(/commit [1-4]/g) ?? []).length).toBe(3);
    } finally {
      rmSync(historyRepo, { recursive: true, force: true });
    }
  });

  it("returns [] when the file does not exist", async () => {
    const lines = await buildFileContextLines({ fullPath: path.join(repo, "missing.ts"), cwd: repo });
    expect(lines).toEqual([]);
  });

  it("does not create a home-wide tag cache when reading a loose file", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "smartread-home-")));
    const looseFile = path.join(home, "notes.txt");
    writeFileSync(looseFile, "ordinary home-directory file\n");

    try {
      const lines = await buildFileContextLines({ fullPath: looseFile, cwd: home });
      expect(lines).toEqual([]);
      expect(existsSync(path.join(home, ".pi-smartread.tags.cache"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("scopes a home-started read to the nested file project", async () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "smartread-home-project-")));
    const project = path.join(home, "project");
    mkdirSync(project);
    writeFileSync(path.join(project, "package.json"), '{"name":"nested-project"}\n');
    const source = path.join(project, "index.ts");
    writeFileSync(source, "export const nested = true;\n");

    try {
      await buildFileContextLines({ fullPath: source, cwd: home });
      expect(existsSync(path.join(home, ".pi-smartread.tags.cache"))).toBe(false);
      expect(existsSync(path.join(project, ".pi-smartread.tags.cache"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("isolates ContextGraph build failure so later git channels still run", async () => {
    // Mock the structural channel to reject. Without isolation, the throw
    // would bubble past later channels and suppress Recent commits / Git notes.
    const buildSpy = vi
      .spyOn(ContextGraph.prototype, "buildContextGraph")
      .mockRejectedValueOnce(new Error("simulated structural failure"));

    try {
      const lines = await buildFileContextLines({ fullPath: path.join(repo, "a.ts"), cwd: repo });
      const text = lines.join("\n");
      // Structural channel was failing, so no Imports/Imported-by bullet.
      expect(text).not.toContain("Imports:");
      expect(text).not.toContain("Imported by:");
      // Per-channel best-effort contract: git channels MUST still appear.
      expect(text).toContain("Recent commits:");
      expect(text).toContain("add a.ts");
      expect(text).toContain("Constraint: keep the public API frozen");
      expect(text).toContain("Git notes:");
      expect(text).toContain("decision: keep a tiny");
      // And the function must not surface the structural failure as
      // "Context unavailable" — that would defeat the isolation.
      expect(text).not.toContain("Context unavailable");
    } finally {
      buildSpy.mockRestore();
    }
  });
});
