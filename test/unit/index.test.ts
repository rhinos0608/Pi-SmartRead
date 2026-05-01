import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerExtension from "../../index.js";

describe("index extension wiring", () => {
  it("registers all tools: read, read_multiple_files, intent_read, repo_map, search_symbols", () => {
    const registered: { name: string; execute: unknown }[] = [];

    const api = {
      registerTool: (definition: { name: string; execute: unknown }) => {
        registered.push(definition);
      },
    } as unknown as ExtensionAPI;

    registerExtension(api);

    const names = registered.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("read_multiple_files");
    expect(names).toContain("intent_read");
    expect(names).toContain("repo_map");
    expect(names).toContain("search_symbols");
    expect(registered.every((t) => typeof t.execute === "function")).toBe(true);
  });
});