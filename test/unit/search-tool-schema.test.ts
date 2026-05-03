import { describe, expect, it } from "vitest";
import createSearchTool from "../../search-tool.js";

describe("search tool schema", () => {
  it("exposes a top-level object schema for provider compatibility", () => {
    const tool = createSearchTool();
    const schema = tool.parameters as { type?: string };

    expect(schema.type).toBe("object");
  });
});
