import { describe, expect, it } from "vitest";
import { createGrepTool } from "../../src/search/grep-tool.js";

describe("search tool schema", () => {
  it("exposes a top-level object schema for provider compatibility", () => {
    const tool = createGrepTool({});
    const schema = tool.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
    };

    expect(tool.name).toBe("grep");
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(["pattern", "queries"]),
    );
  });
});
