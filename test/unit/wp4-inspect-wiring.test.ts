/**
 * WP-4 unit tests: inspect param wiring + symbol read dispatch.
 *
 * Tests:
 *   1. New InspectV4Input type fields are accepted
 *   2. inspect-tool.ts schema includes all new params
 *   3. Dir-only param validation (clusters/boundaries/layers on file → error)
 *   4. callDirection without callDepth → error
 *   5. callDepth on directory → error
 *   6. Token budget truncation in output
 *   7. Dead code section rendering (file mode)
 *   8. Hotspots section rendering (directory mode)
 *   9. Routes section rendering (file + directory mode)
 *  10. Impact section renders with/without contextGraph
 *  11. Clusters/layers/boundaries section rendering (directory mode)
 *  12. Graph schema section rendering
 *  13. Evidence envelope resources for new params
 *  14. Symbol read: resolveSymbol DI in hook.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeInspectV4,
  executeFileInspect,
  executeDirectoryInspect,
} from "../../src/inspect.js";
import { createInspectV4Tool } from "../../src/inspect-tool.js";
import type { InspectV4Input } from "../../src/inspect-types.js";

let workdir: string;
let file: string;
let subdir: string;

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "wp4-inspect-")));
  mkdirSync(workdir, { recursive: true });
  file = join(workdir, "hello.ts");
  writeFileSync(file, "export const hello = 'world';\n", "utf8");
  subdir = join(workdir, "src");
  mkdirSync(subdir, { recursive: true });
  writeFileSync(join(subdir, "index.ts"), "export const a = 1;\nexport const b = 2;\n", "utf8");
  writeFileSync(join(subdir, "util.ts"), "export function helper() { return 42; }\n", "utf8");
  mkdirSync(join(subdir, "routes"), { recursive: true });
  writeFileSync(
    join(subdir, "routes", "auth.ts"),
    'app.post("/api/auth/login", handleLogin);\napp.get("/api/auth/me", handleMe);\n',
    "utf8",
  );
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeCtx(): any {
  return { cwd: workdir, sessionManager: undefined };
}

// ── 1. Type extension tests ──────────────────────────────────────

describe("WP-4 InspectV4Input type extensions", () => {
  it("accepts all new optional fields", () => {
    const input: InspectV4Input = {
      path: "src/",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      callDepth: 3,
      callDirection: "callers",
      deadCode: true,
      impact: true,
      diff: "unstaged",
      clusters: true,
      graphSchema: true,
      hotspots: true,
      boundaries: true,
      routes: true,
      layers: true,
    };
    expect(input.callDepth).toBe(3);
    expect(input.callDirection).toBe("callers");
  });

  it("all new fields are optional", () => {
    const input: InspectV4Input = {
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
    };
    expect(input.callDepth).toBeUndefined();
    expect(input.callDirection).toBeUndefined();
  });
});

// ── 2. Schema extension tests ────────────────────────────────────

describe("inspect tool schema has new params", () => {
  it("schema includes callDepth", () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/s.jsonl" });
    const schema = tool.parameters as Record<string, any>;
    expect(schema.properties.callDepth).toBeDefined();
    expect(schema.properties.callDepth.minimum).toBe(1);
    expect(schema.properties.callDepth.maximum).toBe(5);
  });

  it("schema includes callDirection", () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/s.jsonl" });
    const schema = tool.parameters as Record<string, any>;
    expect(schema.properties.callDirection).toBeDefined();
  });

  it("schema includes deadCode, impact, diff, clusters, graphSchema, hotspots, boundaries, routes, layers", () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/s.jsonl" });
    const schema = tool.parameters as Record<string, any>;
    const expected = ["deadCode", "impact", "diff", "clusters", "graphSchema", "hotspots", "boundaries", "routes", "layers"];
    for (const param of expected) {
      expect(schema.properties[param]).toBeDefined();
    }
  });
});

// ── 3. Dir-only param validation ─────────────────────────────────

describe("dir-only param validation", () => {
  it("clusters on file → error", async () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/test.jsonl" });
    await expect(
      tool.execute("t1", { path: "hello.ts", clusters: true } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/clusters.*requires a directory target/);
  });

  it("boundaries on file → error", async () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/test.jsonl" });
    await expect(
      tool.execute("t2", { path: "hello.ts", boundaries: true } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/boundaries.*requires a directory target/);
  });

  it("layers on file → error", async () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/test.jsonl" });
    await expect(
      tool.execute("t3", { path: "hello.ts", layers: true } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/layers.*requires a directory target/);
  });

  it("clusters on directory → ok", async () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/test.jsonl" });
    const result = await tool.execute("t4", { path: "src", clusters: true } as any, undefined, undefined, makeCtx());
    expect((result as any).details.mode).toBe("directory");
  });
});

// ── 4. callDirection without callDepth → error ──────────────────

describe("callDirection requires callDepth", () => {
  it("callDirection without callDepth → error", async () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/test.jsonl" });
    await expect(
      tool.execute("t5", { path: "hello.ts", callDirection: "callers" } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/callDirection requires callDepth/);
  });
});

// ── 5. callDepth on directory → error ────────────────────────────

describe("callDepth requires file target", () => {
  it("callDepth on directory → error", async () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/test.jsonl" });
    await expect(
      tool.execute("t6", { path: "src", callDepth: 3 } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/callDepth requires a file target/);
  });

  it("callDirection on directory → error (callDirection without callDepth triggers first)", async () => {
    const tool = createInspectV4Tool({ getSessionFilePath: () => "/sessions/test.jsonl" });
    await expect(
      tool.execute("t7", { path: "src", callDirection: "callees" } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/callDirection requires callDepth/);
  });
});

// ── 6. Token budget truncation ───────────────────────────────────

function buildTokenBudgetFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 35; i++) {
    const id = String(i).padStart(3, "0");
    const lines: string[] = [];
    for (let j = 1; j <= 3; j++) {
      lines.push(`export function f${id}_${j}(): number { return ${j}; }`);
    }
    writeFileSync(join(dir, `file-${id}.ts`), lines.join("\n") + "\n", "utf8");
  }
}

describe("token budget", () => {
  it("truncates output when budget is very small and shows omission hint", async () => {
    const fixtureDir = join(workdir, "big-fixture");
    buildTokenBudgetFixture(fixtureDir);
    const result = await executeInspectV4({
      path: fixtureDir,
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      mapTokens: 256,
      graphSchema: true,
      clusters: true,
    });
    expect(result.truncated).toBe(true);
    expect(result.contentText).toContain("rerun with higher mapTokens");
  });

  it("large budget renders all sections", async () => {
    const result = await executeInspectV4({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      mapTokens: 100_000,
      hotspots: true,
      routes: true,
    });
    expect(result.truncated).toBe(false);
    expect(result.contentText).toContain("## HTTP Routes");
    expect(result.contentText).toContain("## Hotspots");
  });
});

// ── 7. Dead code section rendering ───────────────────────────────

describe("deadCode rendering", () => {
  it("file mode deadCode renders section when functions found", async () => {
    // Create file with unreachable function
    writeFileSync(
      join(workdir, "dead.ts"),
      "function neverCalled() { return 1; }\nexport function used() { return 2; }\n",
      "utf8",
    );
    const result = await executeFileInspect({
      path: "dead.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      deadCode: true,
    });
    expect(result.contentText).toContain("## Dead Code");
  });

  it("directory mode deadCode renders section", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      deadCode: true,
    });
    expect(result.contentText).toContain("## Dead Code");
  });
});

// ── 8. Hotspots section rendering ────────────────────────────────

describe("hotspots rendering", () => {
  it("directory mode hotspots renders section", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      hotspots: true,
    });
    expect(result.contentText).toContain("## Hotspots");
  });

  it("file mode hotspots renders section", async () => {
    const result = await executeFileInspect({
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      hotspots: true,
    });
    expect(result.contentText).toContain("## Hotspots");
  });
});

// ── 9. Routes section rendering ──────────────────────────────────

describe("routes rendering", () => {
  it("file mode routes extracts Express routes", async () => {
    const result = await executeFileInspect({
      path: "src/routes/auth.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      routes: true,
    });
    expect(result.contentText).toContain("## HTTP Routes");
    expect(result.contentText).toContain("/api/auth/login");
    expect(result.contentText).toContain("POST");
  });

  it("directory mode routes scans all files", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      routes: true,
    });
    expect(result.contentText).toContain("## HTTP Routes");
    expect(result.contentText).toContain("/api/auth/login");
  });
});

// ── 10. Impact section rendering ─────────────────────────────────

describe("impact rendering", () => {
  it("file mode impact without contextGraph falls back to standalone compute", async () => {
    const result = await executeFileInspect({
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      impact: true,
    });
    expect(result.contentText).toContain("## Impact Analysis");
  });
});

// ── 11. Clusters/layers/boundaries section rendering ────────────

describe("directory-only sections", () => {
  it("clusters renders section", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      clusters: true,
    });
    expect(result.contentText).toContain("## Community Clusters");
  });

  it("layers renders section", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      layers: true,
    });
    expect(result.contentText).toContain("## Architectural Layers");
  });

  it("boundaries renders section", async () => {
    const result = await executeDirectoryInspect({
      path: ".",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      boundaries: true,
    });
    expect(result.contentText).toContain("## Service Boundaries");
  });
});

// ── 12. Graph schema section rendering ───────────────────────────

describe("graphSchema rendering", () => {
  it("renders graph schema section without contextGraph", async () => {
    const result = await executeFileInspect({
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      graphSchema: true,
    });
    expect(result.contentText).toContain("## Graph Schema");
    expect(result.contentText).toMatch(/not available|no graph/i);
    // No longer says '"not built"'
    expect(result.contentText).not.toContain('"not built"');
  });
});

// ── 13. Evidence envelope resources ──────────────────────────────

describe("evidence envelope for new params", () => {
  it("directory mode with deadCode returns map mode envelope", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      deadCode: true,
    });
    expect(result.workspaceEvidence.mode).toBe("map");
  });

  it("file mode returns symbol mode envelope", async () => {
    const result = await executeFileInspect({
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      impact: true,
    });
    expect(result.workspaceEvidence.mode).toBe("symbol");
    expect(result.workspaceEvidence.schemaVersion).toBe(3);
  });

  it("file mode with deadCode + callDepth produces non-empty resources with search-match coverage", async () => {
    const result = await executeFileInspect({
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      deadCode: true,
      callDepth: 2,
    });
    expect(result.workspaceEvidence.mode).toBe("symbol");
    expect(result.workspaceEvidence.resources.length).toBeGreaterThan(0);
    expect(result.workspaceEvidence.resources.every((r: any) => r.coverage === "search-match")).toBe(true);
  });
});

// ── 14. Symbol read dispatch in hook.ts ──────────────────────────

describe("symbol read in hook", () => {
  it("read with symbol uses resolveSymbol when provided", async () => {
    const { createExtendedReadTool } = await import("../../src/hook.js");
    writeFileSync(join(workdir, "target.ts"), "export function myFunc() { return 1; }\n");

    const tool = createExtendedReadTool({
      resolveSymbol: async (sym: string) => {
        if (sym === "myFunc") return { path: join(workdir, "target.ts"), line: 1 };
        return null;
      },
    });
    const result = await tool.execute(
      "t1",
      { symbol: "myFunc" } as any,
      undefined,
      undefined,
      makeCtx(),
    );
    const text = (result as any).content?.[0]?.text ?? "";
    expect(text).toContain("export function myFunc()");
  });

  it("read with symbol throws when not found", async () => {
    const { createExtendedReadTool } = await import("../../src/hook.js");

    const tool = createExtendedReadTool({
      resolveSymbol: async () => null,
    });
    await expect(
      tool.execute("t2", { symbol: "nonexistent" } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/not found in workspace/);
  });

  it("read with symbol throws when resolveSymbol not provided", async () => {
    const { createExtendedReadTool } = await import("../../src/hook.js");

    const tool = createExtendedReadTool();
    await expect(
      tool.execute("t3", { symbol: "anything" } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/not found in workspace/);
  });

  it("symbol takes precedence over path", async () => {
    const { createExtendedReadTool } = await import("../../src/hook.js");
    writeFileSync(join(workdir, "symbol-target.ts"), "export const fromSymbol = true;\n");

    const tool = createExtendedReadTool({
      resolveSymbol: async (sym: string) => {
        if (sym === "fromSymbol") return { path: join(workdir, "symbol-target.ts"), line: 1 };
        return null;
      },
    });
    // Pass both symbol and path — symbol should win
    const result = await tool.execute(
      "t4",
      { symbol: "fromSymbol", path: "hello.ts" } as any,
      undefined,
      undefined,
      makeCtx(),
    );
    const text = (result as any).content?.[0]?.text ?? "";
    expect(text).toContain("export const fromSymbol");
  });
});

// ── 15. Combined params ──────────────────────────────────────────

describe("combined params", () => {
  it("multiple dir-mode params work together", async () => {
    const result = await executeDirectoryInspect({
      path: "src",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      clusters: true,
      layers: true,
      hotspots: true,
      routes: true,
    });
    expect(result.contentText).toContain("## Community Clusters");
    expect(result.contentText).toContain("## Architectural Layers");
    expect(result.contentText).toContain("## Hotspots");
    expect(result.contentText).toContain("## HTTP Routes");
  });

  it("token budget omission includes 'rerun with higher mapTokens' hint", async () => {
    const bigDir = join(workdir, "big-dir");
    buildTokenBudgetFixture(bigDir);
    const result = await executeDirectoryInspect({
      path: bigDir,
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      mapTokens: 256,
      graphSchema: true,
      clusters: true,
    });
    expect(result.truncated).toBe(true);
    expect(result.contentText).toContain("rerun with higher mapTokens");
  });

  it("diff: unstaged changes renders section with a git repo", async () => {
    const gitDir = realpathSync(mkdtempSync(join(tmpdir(), "diff-test-")));
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "test.ts"), "export function foo() { return 1; }\n", "utf8");
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: gitDir, encoding: "utf-8" });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: gitDir, encoding: "utf-8" });
      execFileSync("git", ["config", "user.name", "test"], { cwd: gitDir, encoding: "utf-8" });
      execFileSync("git", ["add", "."], { cwd: gitDir, encoding: "utf-8" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: gitDir, encoding: "utf-8" });
      // Make unstaged change
      writeFileSync(join(gitDir, "test.ts"), "export function foo() { return 2; }\nexport function bar() { return 3; }\n", "utf8");

      const result = await executeFileInspect({
        path: "test.ts",
        cwd: gitDir,
        sessionFilePath: "/sessions/test.jsonl",
        diff: "unstaged",
      });
      expect(result.contentText).toContain("## Diff Impact");
      expect(result.contentText).toContain("test.ts");
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it("evidence: directory mode envelope has resources:[] with matching inspectionId", async () => {
    const result = await executeDirectoryInspect({
      path: workdir,
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      mapTokens: 1024,
    });
    expect(result.workspaceEvidence.mode).toBe("map");
    expect(result.workspaceEvidence.resources).toEqual([]);
    // inspectionId should hash empty resources
    const { inspectionIdFor } = await import("@rhinos0608/pi-workspace-protocol");
    const expectedId = inspectionIdFor({
      sessionId: result.workspaceEvidence.sessionId,
      workspaceRoot: result.workspaceEvidence.workspaceRoot,
      resources: [],
    });
    expect(result.workspaceEvidence.inspectionId).toBe(expectedId);
  });

  it("callDepth without callDirection produces call graph section", async () => {
    const result = await executeFileInspect({
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      callDepth: 2,
    });
    expect(result.contentText).toContain("## Call Graph");
  });

  it("file mode combined params render all sections", async () => {
    const result = await executeFileInspect({
      path: "hello.ts",
      cwd: workdir,
      sessionFilePath: "/sessions/test.jsonl",
      impact: true,
      deadCode: true,
      routes: true,
      graphSchema: true,
    });
    expect(result.contentText).toContain("## Impact Analysis");
    expect(result.contentText).toContain("## Dead Code");
    expect(result.contentText).toContain("## HTTP Routes");
    expect(result.contentText).toContain("## Graph Schema");
  });
});
