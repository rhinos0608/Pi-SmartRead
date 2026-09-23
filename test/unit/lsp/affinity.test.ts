import { describe, expect, it } from "vitest";
import {
  LSP_AFFINITY_MAX_DESCRIPTORS_PER_SCOPE,
  LSP_AFFINITY_MAX_SCOPES,
  LspAffinity,
} from "../../../src/lsp/lsp-affinity.js";

function scope(n: number): string {
  return `/root::lang${n}`;
}

describe("LspAffinity", () => {
  it("hit prefers last success", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    affinity.noteSuccess("root::ts", "b");
    expect(affinity.preferred("root::ts", ["a", "b"])).toBe("b");
  });

  it("re-notes move descriptor to front", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    affinity.noteSuccess("root::ts", "b");
    affinity.noteSuccess("root::ts", "a");
    expect(affinity.preferred("root::ts", ["a", "b"])).toBe("a");
  });

  it("miss on unknown scope returns null", () => {
    const affinity = new LspAffinity();
    expect(affinity.preferred("root::ts", ["a", "b"])).toBeNull();
  });

  it("miss when remembered descriptor removed from candidates returns null", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    expect(affinity.preferred("root::ts", ["b", "c"])).toBeNull();
  });

  it("miss on empty candidates returns null", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    expect(affinity.preferred("root::ts", [])).toBeNull();
  });

  it("falls back to older remembered descriptor when newest absent", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    affinity.noteSuccess("root::ts", "b");
    expect(affinity.preferred("root::ts", ["a", "c"])).toBe("a");
  });

  it("preferred() is advisory: executor explicit selection wins", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    const hint = affinity.preferred("root::ts", ["a", "b"]);
    // Executor owns selection; explicit choice overrides any hint.
    const explicit = "b";
    const selected = explicit ?? hint;
    expect(hint).toBe("a");
    expect(selected).toBe("b");
  });

  it("preferred() is advisory: ambiguity reporting unaffected", () => {
    const affinity = new LspAffinity();
    // No success noted: executor must still report ambiguity itself.
    const hint = affinity.preferred("root::ts", ["a", "b"]);
    expect(hint).toBeNull();
  });

  it("scopes are independent", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    affinity.noteSuccess("root::py", "b");
    expect(affinity.preferred("root::ts", ["a", "b"])).toBe("a");
    expect(affinity.preferred("root::py", ["a", "b"])).toBe("b");
  });

  it("65th scope evicts oldest", () => {
    const affinity = new LspAffinity();
    for (let i = 0; i < LSP_AFFINITY_MAX_SCOPES; i += 1) {
      affinity.noteSuccess(scope(i), `d${i}`);
    }
    affinity.noteSuccess(scope(LSP_AFFINITY_MAX_SCOPES), "new");
    expect(affinity.preferred(scope(0), ["d0"])).toBeNull();
    expect(affinity.preferred(scope(1), ["d1"])).toBe("d1");
    expect(affinity.preferred(scope(LSP_AFFINITY_MAX_SCOPES), ["new"])).toBe("new");
  });

  it("9th descriptor evicts oldest within scope", () => {
    const affinity = new LspAffinity();
    for (let i = 0; i < LSP_AFFINITY_MAX_DESCRIPTORS_PER_SCOPE + 1; i += 1) {
      affinity.noteSuccess("root::ts", `d${i}`);
    }
    // d0 was oldest and must be evicted; newest d8 preferred.
    expect(affinity.preferred("root::ts", ["d0"])).toBeNull();
    expect(affinity.preferred("root::ts", [`d${LSP_AFFINITY_MAX_DESCRIPTORS_PER_SCOPE}`, "d1"])).toBe(
      `d${LSP_AFFINITY_MAX_DESCRIPTORS_PER_SCOPE}`,
    );
  });

  it("clear(scope) removes only that scope", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    affinity.noteSuccess("root::py", "b");
    affinity.clear("root::ts");
    expect(affinity.preferred("root::ts", ["a"])).toBeNull();
    expect(affinity.preferred("root::py", ["b"])).toBe("b");
  });

  it("clear() removes all scopes", () => {
    const affinity = new LspAffinity();
    affinity.noteSuccess("root::ts", "a");
    affinity.noteSuccess("root::py", "b");
    affinity.clear();
    expect(affinity.preferred("root::ts", ["a"])).toBeNull();
    expect(affinity.preferred("root::py", ["b"])).toBeNull();
  });
});
