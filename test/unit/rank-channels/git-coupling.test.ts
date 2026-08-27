import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGitCouplingChannel } from "../../../src/rank-channels/git-coupling.js";

let root: string;
const LOG_DIR = ".pi-smartread";
const LOG_FILE = "graph-mutations.jsonl";

function ensureFile(relPath: string) {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "// stub\n");
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "smartread-gc-")); mkdirSync(join(root, LOG_DIR), { recursive: true }); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function writeEvents(events: object[]) {
  writeFileSync(join(root, LOG_DIR, LOG_FILE), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function coChange(from: string, to: string, confidence = 0.7, source = "git_history") {
  return { type: "co_change", data: { from, to, confidence, source }, timestamp: Date.now() };
}

describe("git-coupling channel", () => {
  it("returns unavailable when no co-change data", () => {
    const result = runGitCouplingChannel(root, ["src/a.ts"]);
    expect(result.channel).toBe("git-coupling");
    expect(result.unavailable?.reason).toMatch(/no co-change data/);
    expect(result.candidates).toHaveLength(0);
  });

  it("returns unavailable when no seeds provided", () => {
    ensureFile("src/a.ts");
    ensureFile("src/b.ts");
    writeEvents([coChange("src/a.ts", "src/b.ts")]);
    const result = runGitCouplingChannel(root, []);
    expect(result.unavailable?.reason).toMatch(/no seed files/);
  });

  it("ranks coupled files by aggregate confidence", () => {
    ensureFile("src/a.ts");
    ensureFile("src/b.ts");
    ensureFile("src/c.ts");
    writeEvents([
      coChange("src/a.ts", "src/b.ts", 0.9),
      coChange("src/a.ts", "src/b.ts", 0.5),
      coChange("src/a.ts", "src/c.ts", 0.6),
    ]);

    const result = runGitCouplingChannel(root, ["src/a.ts"]);
    expect(result.unavailable).toBeUndefined();
    expect(result.candidates).toHaveLength(2);

    const first = result.candidates[0]!;
    const second = result.candidates[1]!;
    expect(first.file).toBe("src/b.ts");
    expect(first.rawScore).toBeCloseTo(1.4);
    expect(second.file).toBe("src/c.ts");
    expect(second.rawScore).toBeCloseTo(0.6);
  });

  it("handles bidirectional edges (to is seed)", () => {
    ensureFile("src/x.ts");
    ensureFile("src/a.ts");
    writeEvents([coChange("src/x.ts", "src/a.ts", 0.8)]);
    const result = runGitCouplingChannel(root, ["src/a.ts"]);
    expect(result.candidates).toHaveLength(1);
    const c = result.candidates[0]!;
    expect(c.file).toBe("src/x.ts");
    expect(c.rawScore).toBeCloseTo(0.8);
  });

  it("ignores seed-to-seed edges", () => {
    ensureFile("src/a.ts");
    ensureFile("src/b.ts");
    writeEvents([coChange("src/a.ts", "src/b.ts", 0.9)]);
    const result = runGitCouplingChannel(root, ["src/a.ts", "src/b.ts"]);
    expect(result.candidates).toHaveLength(0);
  });

  it("ignores non-git_history source edges", () => {
    ensureFile("src/a.ts");
    ensureFile("src/b.ts");
    writeEvents([coChange("src/a.ts", "src/b.ts", 0.9, "diagnostics")]);
    const result = runGitCouplingChannel(root, ["src/a.ts"]);
    expect(result.candidates).toHaveLength(0);
    expect(result.unavailable?.reason).toMatch(/no co-change data/);
  });

  it("respects maxCandidates bound", () => {
    ensureFile("src/a.ts");
    const files = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);
    files.forEach(ensureFile);
    const events = files.map((f, i) => coChange("src/a.ts", f, 0.5 + i * 0.01));
    writeEvents(events);
    const result = runGitCouplingChannel(root, ["src/a.ts"], 3);
    expect(result.candidates).toHaveLength(3);
  });

  it("includes metadata", () => {
    ensureFile("src/a.ts");
    ensureFile("src/b.ts");
    writeEvents([coChange("src/a.ts", "src/b.ts")]);
    const result = runGitCouplingChannel(root, ["src/a.ts"]);
    expect(result.metadata).toMatchObject({ seedCount: 1, edgeCount: 1, matchedFiles: 1 });
  });
});
