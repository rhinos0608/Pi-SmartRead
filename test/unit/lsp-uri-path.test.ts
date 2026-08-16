import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { lspUriToPath } from "../../src/index.js";

describe("lspUriToPath", () => {
  it("converts file:// URIs to filesystem paths", () => {
    expect(lspUriToPath("file:///Users/me/src/a.ts")).toBe(fileURLToPath("file:///Users/me/src/a.ts"));
  });

  it("returns raw Windows drive-letter paths as-is (never passed to fileURLToPath)", () => {
    expect(lspUriToPath("D:\\src\\a.ts")).toBe("D:\\src\\a.ts");
  });

  it("returns raw POSIX paths as-is", () => {
    expect(lspUriToPath("/Users/me/src/a.ts")).toBe("/Users/me/src/a.ts");
  });

  it("returns empty string for empty input", () => {
    expect(lspUriToPath("")).toBe("");
  });
});
