import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  initParser: vi.fn(async () => {}),
  getTagsBatch: vi.fn(async () => [] as never[]),
}));

vi.mock("../../tags.js", () => ({
  initParser: mocks.initParser,
  getTagsBatch: mocks.getTagsBatch,
}));

import { RepoMap } from "../../repomap.js";

describe("RepoMap.searchIdentifiers fallback", () => {
  let root: string;

  beforeEach(() => {
    mocks.initParser.mockClear();
    mocks.getTagsBatch.mockClear();

    root = mkdtempSync(join(tmpdir(), "pi-smartread-search-"));
    writeFileSync(
      join(root, "a.ts"),
      [
        "export function calculateTotal(items: number[]) {",
        "  return items.reduce((sum, item) => sum + item, 0);",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "b.ts"),
      [
        "const total = calculateTotal([1, 2, 3]);",
        "export { total };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "c.ts"),
      [
        "export function markRepoMapExplicitlyCalled() {",
        "  return true;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "d.ts"),
      [
        "const another = calculateTotal([4, 5, 6]);",
        "export { another };",
        "",
      ].join("\n"),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses text fallback when tree-sitter yields no tags", async () => {
    const repoMap = new RepoMap(root);
    const results = await repoMap.searchIdentifiers(
      "calculateTotal",
      { maxResults: 10 },
      undefined,
      undefined,
    );

    expect(mocks.initParser).toHaveBeenCalled();
    expect(mocks.getTagsBatch).toHaveBeenCalled();
    expect(results).toHaveLength(3);
    expect(results[0].kind).toBe("def");
    expect(results.filter((result) => result.kind === "ref")).toHaveLength(2);
    expect(results[0].context).toContain("calculateTotal");
    expect(results[1].context).toContain("calculateTotal");
    expect(results[2].context).toContain("calculateTotal");
  });

  it("respects includeDefinitions and includeReferences in fallback mode", async () => {
    const repoMap = new RepoMap(root);
    const results = await repoMap.searchIdentifiers(
      "calculateTotal",
      { includeDefinitions: false, includeReferences: true },
      undefined,
      undefined,
    );

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.kind === "ref")).toBe(true);
    expect(results[0].file).toBe("b.ts");
    expect(results[1].file).toBe("d.ts");
  });

  it("extracts the actual symbol name for substring matches", async () => {
    const repoMap = new RepoMap(root);
    const results = await repoMap.searchIdentifiers(
      "RepoMap",
      { maxResults: 10 },
      undefined,
      undefined,
    );

    expect(results.some((result) => result.name === "markRepoMapExplicitlyCalled")).toBe(true);
    expect(results[0].kind).toBe("def");
  });

  it("limits maxResults after sorting across all files", async () => {
    const repoMap = new RepoMap(root);
    const results = await repoMap.searchIdentifiers(
      "calculateTotal",
      { maxResults: 2 },
      undefined,
      undefined,
    );

    expect(results).toHaveLength(2);
    expect(results[0].kind).toBe("def");
    expect(results[1].kind).toBe("ref");
  });

  it("returns only definitions when includeReferences is false", async () => {
    const repoMap = new RepoMap(root);
    const results = await repoMap.searchIdentifiers(
      "calculateTotal",
      { includeDefinitions: true, includeReferences: false },
      undefined,
      undefined,
    );

    expect(results.every((r) => r.kind === "def")).toBe(true);
    expect(results[0].file).toBe("a.ts");
  });

  it("does not fabricate references for plain text matches", async () => {
    const repoMap = new RepoMap(root);
    const results = await repoMap.searchIdentifiers(
      "return true",
      { maxResults: 10 },
      undefined,
      undefined,
    );

    // "return true" is not a valid identifier; fallback should yield nothing
    expect(results).toHaveLength(0);
  });
});
