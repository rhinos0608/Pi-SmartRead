import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { createGitNotesTools } from "../../git-notes-tool.js";

describe("git notes tool", () => {
  it("creates a single git_notes tool with action parameter", () => {
    const tools = createGitNotesTools();
    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe("git_notes");
    expect(typeof tools[0]!.execute).toBe("function");
  });

  it("defines schema with action, commit, content, and directory", () => {
    const tool = createGitNotesTools()[0]!;
    const params = tool.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, unknown>;

    expect(properties.action).toBeDefined();
    expect(properties.commit).toBeDefined();
    expect(properties.content).toBeDefined();
    expect(properties.directory).toBeDefined();

    // content is required for write but not for read
    // TypeBox doesn't express conditional required, so required is undefined
    expect(params.required).toBeUndefined();
  });

  it("read action works without content", async () => {
    const tool = createGitNotesTools()[0]!;
    // In a non-git directory, should gracefully report no repo found
    const result = await tool.execute(
      "id",
      { action: "read" },
      undefined, undefined,
      { cwd: tmpdir() } as any,
    );
    const text = (result as any).content[0].text;
    expect(text).toContain("No git repository");
  });

  it("write action requires content", async () => {
    const tool = createGitNotesTools()[0]!;
    await expect(
      tool.execute(
        "id",
        { action: "write" },
        undefined, undefined,
        { cwd: tmpdir() } as any,
      ),
    ).rejects.toThrow(/content/i);
  });
});
