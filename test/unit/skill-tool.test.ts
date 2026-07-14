import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSkillTool } from "../../src/skill-tool.js";
import { toExtensionContext } from "../../src/types.js";

async function makeProjectSkill(): Promise<{ root: string; skillDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "smartread-skill-"));
  const skillDir = join(root, ".pi", "skills", "answer-helper");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: answer-helper",
      "description: Helps answer project questions with precise context.",
      "---",
      "# Answer Helper",
      "Use narrow context first.",
    ].join("\n"),
  );
  await writeFile(join(skillDir, "notes.md"), "Extra notes");
  return { root, skillDir };
}

describe("skill tool", () => {
  it("lists project skills without smartread-prefixed naming", async () => {
    const { root } = await makeProjectSkill();
    const tool = createSkillTool();

    const result = await tool.execute("skill-1", { action: "list" }, undefined, undefined, toExtensionContext(root));
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(tool.name).toBe("skill");
    expect(text).toContain("answer-helper");
    expect(text).not.toContain("smartread_");
  });

  it("searches and reads skill files by ergonomic name", async () => {
    const { root } = await makeProjectSkill();
    const tool = createSkillTool();

    const search = await tool.execute("skill-2", { action: "search", query: "project questions" }, undefined, undefined, toExtensionContext(root));
    const searchText = search.content[0]?.type === "text" ? search.content[0].text : "";
    expect(searchText).toContain("answer-helper");

    const read = await tool.execute("skill-3", { name: "answer", file: "notes.md" }, undefined, undefined, toExtensionContext(root));
    const readText = read.content[0]?.type === "text" ? read.content[0].text : "";
    expect(readText).toContain("<skill name=\"answer-helper\"");
    expect(readText).toContain("Extra notes");
  });
});
