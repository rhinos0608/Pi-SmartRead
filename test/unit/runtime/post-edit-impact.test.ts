import { describe, expect, it, vi } from "vitest";
import { formatImpactBlock, runPostEditImpactSummary } from "../../src/post-edit-impact.js";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

function makeGraph(_affectedPaths: string[]) {
  return {
    getFileNeighbours: vi.fn(),
    getMutationNeighbours: vi.fn(),
  } as any;
}

describe("post-edit impact summary", () => {
  it("no-ops when no graph data (null graph)", async () => {
    const result = await runPostEditImpactSummary(
      { toolName: "write", isError: false, input: { path: "src/a.ts" }, content: [{ type: "text", text: "wrote" }], cwd: "/tmp" },
      { getGraph: () => null as any },
    );
    expect(result).toBeUndefined();
  });

  it("no-ops when zero related files", async () => {
    const graph = makeGraph([]);
    const computeImpactFn = vi.fn(async () => ({
      target: "src/a.ts",
      assessment: "complete" as const,
      coverageReasons: [],
      omittedEdgeCount: 0,
      affectedFiles: [],
      affectedSymbols: [],
      blastRadiusDepth: 0,
      callGraphSummary: { directCallers: 0, transitiveCallers: 0, directCallees: 0, transitiveCallees: 0 },
    }));
    const result = await runPostEditImpactSummary(
      { toolName: "write", isError: false, input: { path: "src/a.ts" }, content: [{ type: "text", text: "wrote" }], cwd: "/tmp" },
      { getGraph: () => graph, computeImpactFn: computeImpactFn as any },
    );
    expect(result).toBeUndefined();
  });

  it("formats bounded/truncated block with +N more and advisory marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-impact-"));
    try {
      const graph = makeGraph([]);
      const affectedFiles = Array.from({ length: 8 }, (_, i) => ({
        path: join(dir, `file${i}.ts`),
        risk: "low" as const,
        fanIn: 1,
        depth: 1,
      }));
      const computeImpactFn = vi.fn(async () => ({
        target: join(dir, "a.ts"),
        risk: "low" as const,
        assessment: "complete" as const,
        coverageReasons: [],
        omittedEdgeCount: 0,
        affectedFiles,
        affectedSymbols: [],
        blastRadiusDepth: 1,
        callGraphSummary: { directCallers: 0, transitiveCallers: 0, directCallees: 0, transitiveCallees: 0 },
      }));
      const result = await runPostEditImpactSummary(
        { toolName: "write", isError: false, input: { path: join(dir, "a.ts") }, content: [{ type: "text", text: "wrote" }], cwd: dir },
        { getGraph: () => graph, computeImpactFn: computeImpactFn as any, timeoutMs: 1000 },
      );
      expect(result).toBeDefined();
      const block = (result!.content[1] as { text: string }).text;
      expect(block).toContain("[Possibly affected:");
      expect(block).toContain("(+3 more)");
      expect(block).toContain("advisory, based on prior graph data");
      // Should show at most 5 files explicitly
      const shownCount = (block.match(/file\d\.ts/g) ?? []).length;
      expect(shownCount).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no-ops on timeout (slow computeImpact)", async () => {
    const graph = makeGraph([]);
    const computeImpactFn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return {
        target: "src/a.ts",
        assessment: "complete" as const,
        coverageReasons: [],
        omittedEdgeCount: 0,
        affectedFiles: [{ path: "src/b.ts", risk: "low" as const, fanIn: 1, depth: 1 }],
        affectedSymbols: [],
        blastRadiusDepth: 1,
        callGraphSummary: { directCallers: 0, transitiveCallers: 0, directCallees: 0, transitiveCallees: 0 },
      } as any;
    });
    const result = await runPostEditImpactSummary(
      { toolName: "write", isError: false, input: { path: "src/a.ts" }, content: [{ type: "text", text: "wrote" }], cwd: "/tmp" },
      { getGraph: () => graph, computeImpactFn: computeImpactFn as any, timeoutMs: 20 },
    );
    expect(result).toBeUndefined();
  });

  it("no-ops for non-write/edit tool (read)", async () => {
    const graph = makeGraph([]);
    const computeImpactFn = vi.fn(async () => ({
      target: "src/a.ts",
      assessment: "complete" as const,
      coverageReasons: [],
      omittedEdgeCount: 0,
      affectedFiles: [{ path: "src/b.ts", risk: "low" as const, fanIn: 1, depth: 1 }],
      affectedSymbols: [],
      blastRadiusDepth: 1,
      callGraphSummary: { directCallers: 0, transitiveCallers: 0, directCallees: 0, transitiveCallees: 0 },
    } as any));
    const result = await runPostEditImpactSummary(
      { toolName: "read", isError: false, input: { path: "src/a.ts" }, content: [], cwd: "/tmp" },
      { getGraph: () => graph, computeImpactFn: computeImpactFn as any },
    );
    expect(result).toBeUndefined();
    expect(computeImpactFn).not.toHaveBeenCalled();
  });

  it("no-ops on computeImpact throw", async () => {
    const graph = makeGraph([]);
    const computeImpactFn = vi.fn(async () => { throw new Error("boom"); });
    const result = await runPostEditImpactSummary(
      { toolName: "edit", isError: false, input: { path: "src/a.ts" }, content: [], cwd: "/tmp" },
      { getGraph: () => graph, computeImpactFn: computeImpactFn as any },
    );
    expect(result).toBeUndefined();
  });

  it("formatImpactBlock no-ops on empty", () => {
    expect(formatImpactBlock([], 0, "/tmp")).toBeUndefined();
  });

  it("formatImpactBlock shows (+N more) correctly for truncation", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
    const block = formatImpactBlock(files.slice(0, 5), files.length, "/tmp");
    expect(block).toContain("(+2 more)");
  });

  it("resolves edit via changedResources (no input.path) and produces summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-impact-"));
    try {
      const graph = makeGraph([]);
      const computeImpactFn = vi.fn(async ({ targetFile }) => ({
        target: targetFile,
        assessment: "complete" as const,
        coverageReasons: [],
        omittedEdgeCount: 0,
        affectedFiles: [{ path: join(dir, "related.ts"), risk: "low" as const, fanIn: 1, depth: 1 }],
        affectedSymbols: [],
        blastRadiusDepth: 1,
        callGraphSummary: { directCallers: 0, transitiveCallers: 0, directCallees: 0, transitiveCallees: 0 },
      }));
      // Real edit shape: input.edits, no input.path, details.changedResources carries canonicalPath
      const result = await runPostEditImpactSummary(
        {
          toolName: "edit",
          isError: false,
          input: { edits: [{ path: "src/a.ts" }] } as any,
          details: { changedResources: [{ canonicalPath: join(dir, "a.ts") }] },
          content: [{ type: "text", text: "edited" }],
          cwd: dir,
        },
        { getGraph: () => graph, computeImpactFn: computeImpactFn as any, timeoutMs: 1000 },
      );
      expect(result).toBeDefined();
      const block = (result!.content[1] as { text: string }).text;
      expect(block).toContain("Possibly affected");
      expect(block).toContain("related.ts");
      expect(computeImpactFn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maxFiles override changes rendered count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-impact-"));
    try {
      const graph = makeGraph([]);
      const affectedFiles = Array.from({ length: 10 }, (_, i) => ({
        path: join(dir, `file${i}.ts`),
        risk: "low" as const,
        fanIn: 1,
        depth: 1,
      }));
      const computeImpactFn = vi.fn(async () => ({
        target: join(dir, "a.ts"),
        assessment: "complete" as const,
        coverageReasons: [],
        omittedEdgeCount: 0,
        affectedFiles,
        affectedSymbols: [],
        blastRadiusDepth: 1,
        callGraphSummary: { directCallers: 0, transitiveCallers: 0, directCallees: 0, transitiveCallees: 0 },
      }));
      const resultDefault = await runPostEditImpactSummary(
        { toolName: "write", isError: false, input: { path: join(dir, "a.ts") }, content: [{ type: "text", text: "wrote" }], cwd: dir },
        { getGraph: () => graph, computeImpactFn: computeImpactFn as any, timeoutMs: 1000 },
      );
      const blockDefault = (resultDefault!.content[1] as { text: string }).text;
      expect((blockDefault.match(/file\d\.ts/g) ?? []).length).toBe(5);

      const result8 = await runPostEditImpactSummary(
        { toolName: "write", isError: false, input: { path: join(dir, "a.ts") }, content: [{ type: "text", text: "wrote" }], cwd: dir },
        { getGraph: () => graph, computeImpactFn: computeImpactFn as any, timeoutMs: 1000, maxFiles: 8 },
      );
      const block8 = (result8!.content[1] as { text: string }).text;
      expect((block8.match(/file\d\.ts/g) ?? []).length).toBe(8);
      expect(block8).toContain("(+2 more)");

      // Direct formatter threading check
      const blockFmt = formatImpactBlock(affectedFiles.map((f) => f.path), 10, dir, 8)!;
      expect((blockFmt.match(/file\d\.ts/g) ?? []).length).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
