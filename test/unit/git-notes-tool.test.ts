import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { createGitNotesTools } from "../../src/git-notes-tool.js";

describe("git notes tools", () => {
  it("creates two tools: git_notes_read and git_notes_write", () => {
    const tools = createGitNotesTools();
    expect(tools.length).toBe(2);
    const names = tools.map((t) => t.name);
    expect(names).toContain("git_notes_read");
    expect(names).toContain("git_notes_write");
    expect(typeof tools[0]!.execute).toBe("function");
    expect(typeof tools[1]!.execute).toBe("function");
  });

  it("read tool schema has commit and directory (no required)", () => {
    const readTool = createGitNotesTools().find((t) => t.name === "git_notes_read")!;
    const params = readTool.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, unknown>;
    expect(properties.commit).toBeDefined();
    expect(properties.directory).toBeDefined();
    expect(properties.content).toBeUndefined();
    expect(params.required).toBeUndefined();
  });

  it("write tool schema has content as required", () => {
    const writeTool = createGitNotesTools().find((t) => t.name === "git_notes_write")!;
    const params = writeTool.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, unknown>;
    expect(properties.content).toBeDefined();
    expect(properties.commit).toBeDefined();
    expect(properties.directory).toBeDefined();
    expect(params.required).toContain("content");
  });

  it("read works without content", async () => {
    const readTool = createGitNotesTools().find((t) => t.name === "git_notes_read")!;
    const result = await readTool.execute(
      "id",
      {},
      undefined, undefined,
      { cwd: tmpdir() } as any,
    );
    const text = (result as any).content[0].text;
    expect(text).toContain("No git repository");
  });

  it("write requires content", async () => {
    const writeTool = createGitNotesTools().find((t) => t.name === "git_notes_write")!;
    await expect(
      writeTool.execute(
        "id",
        {},
        undefined, undefined,
        { cwd: tmpdir() } as any,
      ),
    ).rejects.toThrow(/content/i);
  });
});
