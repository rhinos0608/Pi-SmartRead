import { describe, expect, it, beforeEach } from "vitest";
import { setupExtension, type IndexHarness } from "./index-fixture.js";

let harness: IndexHarness;

beforeEach(async () => {
  harness = await setupExtension();
});

describe("index extension registration", () => {
  it("registers all tools for the Pi extension path", () => {
    const { registered } = harness;
    const names = registered.map((t) => t.name);
    // v3: inspect + skill + read (re-registered for evidence + enrichment)
    // are registered. read_files/search/repo_map/symbol remain consolidated
    // into inspect modes.
    expect(names).toContain("inspect");
    expect(names).toContain("skill");
    expect(names).toContain("read");
    expect(names).not.toContain("read_files");
    expect(names).not.toContain("search");
    expect(names).not.toContain("repo_map");
    expect(names).not.toContain("symbol");
    expect(names).not.toContain("intent_read");
    expect(names).not.toContain("find_symbol");
    expect(names).not.toContain("symbol_info");
    expect(names).not.toContain("deep_search");
    expect(names.every((name) => !name.startsWith("smartread_"))).toBe(true);
    // context_graph is not exposed as an agent-facing tool
    expect(names).not.toContain("context_graph");
    // graph_mutate and git_notes are experimental — disabled by default
    expect(names).not.toContain("graph_mutate");
    expect(names).not.toContain("git_notes_read");
    expect(names).not.toContain("git_notes_write");
    expect(registered.every((t) => typeof t.execute === "function")).toBe(true);
  });
});
