import { describe, expect, it } from "vitest";
import { createRepoTool } from "../../../src/repomap/repomap-tool.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

describe("repo_map tool (createRepoTool)", () => {
  // ── Registration ──

  it("is created with the correct name", () => {
    const tool: ToolDefinition = createRepoTool();
    expect(tool.name).toBe("repo_map");
  });

  it("has a label and description", () => {
    const tool: ToolDefinition = createRepoTool();
    expect(tool.label).toBe("repo_map");
    expect(tool.description).toBeTruthy();
    expect(tool.description).toContain("map");
  });

  it("has an execute function", () => {
    const tool: ToolDefinition = createRepoTool();
    expect(typeof tool.execute).toBe("function");
  });

  it("has a parameter schema", () => {
    const tool: ToolDefinition = createRepoTool();
    const schema = tool.parameters as Record<string, unknown>;
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
  });
});
