import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import createSearchTool from "../../search-tool.js";
import { resetSessionState } from "../../hook.js";

describe("search tool schema", () => {
  beforeEach(() => {
    resetSessionState();
  });
  it("exposes a top-level object schema for provider compatibility", () => {
    const tool = createSearchTool();
    const schema = tool.parameters as { type?: string; properties?: Record<string, unknown> };

    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("directory");
    expect(schema.properties).toHaveProperty("folder");
  });

  it("limits searching to the requested directory or folder alias", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-search-folder-"));
    try {
      mkdirSync(join(root, "scoped"), { recursive: true });
      writeFileSync(
        join(root, "scoped", "target.ts"),
        "export function scopedOnlySearchTarget() { return true; }\n",
      );
      writeFileSync(
        join(root, "outside.ts"),
        "export function outsideExclusiveIdentifier() { return true; }\n",
      );

      const tool = createSearchTool();
      for (const scopedRoot of [{ directory: "scoped" }, { folder: "scoped" }]) {
        const result = await tool.execute(
          "id",
          { mode: "code", query: "outsideExclusiveIdentifier", enrich: false, ...scopedRoot },
          undefined,
          undefined,
          { cwd: root } as any,
        );

        const text = (result.content[0] as any).text as string;
        const details = result.details as any;

        expect(details.total).toBe(1);
        expect(details.filesScanned).toBe(1);
        expect(text).toContain("target.ts");
        expect(text).toContain("relevance=");
        expect(text).not.toContain("score=");
        expect(text).not.toContain("outside.ts");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting directory and folder roots", async () => {
    const tool = createSearchTool();

    await expect(
      tool.execute(
        "id",
        { mode: "code", query: "anything", directory: "src", folder: "tests" },
        undefined,
        undefined,
        { cwd: "/tmp" } as any,
      ),
    ).rejects.toThrow(/directory.*folder|folder.*directory/i);
  });

  it("shows the low-result hint only once per session", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-smartread-search-hint-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "target.ts"), "export function uniqueSearchTarget() { return true; }\n");

      const tool = createSearchTool();
      const context = { cwd: root } as any;

      const first = await tool.execute(
        "id-1",
        { mode: "code", query: "uniqueSearchTarget" },
        undefined,
        undefined,
        context,
      );
      const firstText = (first.content[0] as any).text as string;
      expect(firstText).toContain("Only 1 result(s) found");

      const second = await tool.execute(
        "id-2",
        { mode: "code", query: "uniqueSearchTarget" },
        undefined,
        undefined,
        context,
      );
      const secondText = (second.content[0] as any).text as string;
      expect(secondText).not.toContain("Only 1 result(s) found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
