import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGraphMutateTool } from "../../src/graph-mutate.js";
import { ContextGraph } from "../../src/context-graph.js";

describe("graph_mutate", () => {
  it("records absolute edge paths outside the selected root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "graph-mutate-unbounded-"));
    const root = join(parent, "repo");
    const outside = join(parent, "outside.ts");
    const target = join(parent, "target.ts");

    try {
      mkdirSync(root);
      writeFileSync(outside, "export const outside = true;\n");
      writeFileSync(target, "export const target = true;\n");

      const tool = createGraphMutateTool();
      const result = await tool.execute(
        "id",
        { from: outside, to: target, directory: root, relation: "breakage" },
        undefined,
        undefined,
        { cwd: root } as any,
      );

      expect((result as { isError?: boolean }).isError).toBeUndefined();
      const graph = new ContextGraph(root);
      await graph.buildContextGraph({ skipGitPopulation: true });
      const neighbours = graph.getMutationNeighbours(outside);
      expect(neighbours.map((n) => n.path)).toContain(target);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("returns isError:true when EdgeStore persistence fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "graph-mutate-fail-"));
    try {
      // A regular file at the EdgeStore log directory path makes the append
      // fail (ENOTDIR on mkdir/appendFileSync), forcing a persistence failure.
      writeFileSync(join(root, ".pi-smartread"), "not-a-directory\n");

      const tool = createGraphMutateTool();
      const result = await tool.execute(
        "id-fail",
        { from: "src/a.ts", to: "src/b.ts", directory: root, relation: "breakage" },
        undefined,
        undefined,
        { cwd: root } as any,
      );

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("Failed to persist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
