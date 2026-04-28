import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerExtension from "../../index.js";

describe("index extension wiring", () => {
  it("registers read_multiple_files and intent_read tools", () => {
    const registered: { name: string; execute: unknown }[] = [];

    const api = {
      registerTool: (definition: { name: string; execute: unknown }) => {
        registered.push(definition);
      },
    } as unknown as ExtensionAPI;

    registerExtension(api);

    const names = registered.map((t) => t.name);
    expect(names).toContain("read_multiple_files");
    expect(names).toContain("intent_read");
    expect(registered.every((t) => typeof t.execute === "function")).toBe(true);
  });
});