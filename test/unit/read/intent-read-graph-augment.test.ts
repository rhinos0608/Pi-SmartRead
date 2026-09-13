import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createIntentReadTool } from "../../../src/read/intent-read.js";
import type { EmbedRequest } from "../../../src/indexing/embedding.js";
import { makeEmbedder, makeReadTool, runIntentRead, setupIntentReadEnv } from "./intent-read-helpers.js";

vi.mock("../../../src/mcp-registry.js", () => ({
  getSharedContextGraphAsync: vi.fn().mockResolvedValue({
    getFileNeighbours: vi.fn().mockResolvedValue([]),
    getMutationNeighbours: vi.fn().mockReturnValue([]),
  }),
}));

setupIntentReadEnv();

describe("intent_read: graph-neighbour augmentation", () => {
  it("adds direct relative import neighbours when file mode leaves candidate slots", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-graph-"));
    try {
      const fileA = join(root, "a.ts");
      const fileB = join(root, "b.ts");
      writeFileSync(fileA, "import { helper } from './b';\nexport const auth = helper();\n");
      writeFileSync(fileB, "export function helper() { return 'authentication helper'; }\n");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [fileB]: "authentication helper" }) as any,
        makeEmbedder([[1, 0], [1, 0], [1, 0]]),
      );

      const result = await runIntentRead(tool, { query: "authentication", files: [{ path: fileA }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.graphAugmentation.addedPaths).toEqual([fileB]);
      expect(details.files.map((f: any) => f.path)).toContain(fileB);
      expect((result.content[0] as any).text).toContain(`@${fileB}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("caps graph neighbours at the remaining 20-file budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-graph-cap-"));
    try {
      const files: string[] = [];
      const readMap: Record<string, string> = {};
      for (let i = 0; i < 22; i++) {
        const path = join(root, `${i}.ts`);
        files.push(path);
        readMap[path] = `authentication ${i}`;
      }
      writeFileSync(files[0]!, "import './19';\nimport './20';\nimport './21';\nexport const zero = true;\n");
      for (let i = 1; i < 22; i++) writeFileSync(files[i]!, `export const value${i} = true;\n`);

      const tool = createIntentReadTool(
        () => makeReadTool(readMap) as any,
        async (req: EmbedRequest) => ({ vectors: Array.from({ length: req.inputs.length }, () => [1, 0]) }),
      );

      const result = await runIntentRead(tool, { query: "authentication", files: files.slice(0, 18).map((path) => ({ path })), topK: 20 }, root, "id");

      const details = result.details as any;
      expect(details.processedCount).toBe(21);
      expect(details.graphAugmentation.addedPaths).toEqual([files[19], files[20], files[21]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds graph neighbours outside cwd", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intent-read-graph-escape-"));
    const root = join(parent, "repo");
    try {
      mkdirSync(root);
      const fileA = join(root, "a.ts");
      const outside = join(parent, "outside.ts");
      writeFileSync(fileA, "import '../outside';\nexport const auth = true;\n");
      writeFileSync(outside, "export const secret = true;\n");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [outside]: "secret" }) as any,
        makeEmbedder([[1, 0], [1, 0], [1, 0]]),
      );

      const result = await runIntentRead(tool, { query: "authentication", files: [{ path: fileA }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.graphAugmentation.addedPaths).toEqual([outside]);
      expect(details.files.map((f: any) => f.path)).toContain(outside);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("adds graph neighbours through symlinks that point outside cwd", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intent-read-graph-symlink-"));
    const root = join(parent, "repo");
    try {
      mkdirSync(root);
      const fileA = join(root, "a.ts");
      const outside = join(parent, "outside.ts");
      const link = join(root, "linked.ts");
      writeFileSync(fileA, "import './linked';\nexport const auth = true;\n");
      writeFileSync(outside, "export const secret = true;\n");
      symlinkSync(outside, link);

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [link]: "secret" }) as any,
        makeEmbedder([[1, 0], [1, 0], [1, 0]]),
      );

      const result = await runIntentRead(tool, { query: "authentication", files: [{ path: fileA }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.graphAugmentation.addedPaths).toEqual([link]);
      expect(details.files.map((f: any) => f.path)).toContain(link);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("adds graph neighbours through symlinked directories that point outside cwd", async () => {
    const parent = mkdtempSync(join(tmpdir(), "intent-read-graph-symlink-dir-"));
    const root = join(parent, "repo");
    const outsideDir = join(parent, "outside-dir");
    try {
      mkdirSync(root);
      mkdirSync(outsideDir);
      const fileA = join(root, "a.ts");
      const outside = join(outsideDir, "helper.ts");
      const linkDir = join(root, "linked-dir");
      const linkedFile = join(linkDir, "helper.ts");
      writeFileSync(fileA, "import './linked-dir/helper';\nexport const auth = true;\n");
      writeFileSync(outside, "export const secret = true;\n");
      symlinkSync(outsideDir, linkDir, "dir");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [linkedFile]: "secret" }) as any,
        makeEmbedder([[1, 0], [1, 0], [1, 0]]),
      );

      const result = await runIntentRead(tool, { query: "authentication", files: [{ path: fileA }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.graphAugmentation.addedPaths).toEqual([linkedFile]);
      expect(details.files.map((f: any) => f.path)).toContain(linkedFile);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("intent_read: graph augmentation observability", () => {
  it("reports graphAugmentation metadata with edgesUsed", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-graph-meta-"));
    try {
      const fileA = join(root, "a.ts");
      const fileB = join(root, "b.ts");
      writeFileSync(fileA, "import { helper } from './b';\nexport const auth = helper();\n");
      writeFileSync(fileB, "export function helper() { return 'authentication helper'; }\n");

      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry", [fileB]: "authentication helper" }) as any,
        makeEmbedder([[1, 0], [1, 0], [1, 0]]),
      );

      const result = await runIntentRead(tool, { query: "authentication", files: [{ path: fileA }], topK: 2 }, root, "id");

      const details = result.details as any;
      expect(details.graphAugmentation).toBeDefined();
      expect(details.graphAugmentation.addedPaths).toContain(fileB);
      expect(details.graphAugmentation.candidateCountBefore).toBe(1);
      expect(details.graphAugmentation.candidateCountAfter).toBe(2);
      expect(details.graphAugmentation.edgesUsed).toBeDefined();
      expect(details.graphAugmentation.edgesUsed.length).toBeGreaterThan(0);
      expect(details.graphAugmentation.edgesUsed[0].type).toBe("imports");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("intent_read: graph-provider consolidation (Keystone P1-W3)", () => {
  it("requests the shared graph provider when cwd is a project root", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-shared-graph-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "t" }));
      const fileA = join(root, "a.ts");
      writeFileSync(fileA, "export const auth = 1;\n");
      const mcp = await import("../../../src/mcp-registry.js");
      const provider = vi.mocked(mcp.getSharedContextGraphAsync);
      provider.mockClear();
      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry" }) as any,
        makeEmbedder([[1, 0], [1, 0]]),
      );
      const result = await runIntentRead(tool, { query: "auth", files: [{ path: fileA }] }, root, "id");
      expect(provider).toHaveBeenCalledWith(root);
      expect((result.details as any).graphAugmentation).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips the shared graph provider when cwd has no project marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "intent-read-no-graph-"));
    try {
      const fileA = join(root, "a.ts");
      writeFileSync(fileA, "export const auth = 1;\n");
      const mcp = await import("../../../src/mcp-registry.js");
      const provider = vi.mocked(mcp.getSharedContextGraphAsync);
      provider.mockClear();
      const tool = createIntentReadTool(
        () => makeReadTool({ [fileA]: "authentication entry" }) as any,
        makeEmbedder([[1, 0], [1, 0]]),
      );
      await runIntentRead(tool, { query: "auth", files: [{ path: fileA }] }, root, "id");
      expect(provider).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
