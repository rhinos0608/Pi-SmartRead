import { describe, expect, it } from "vitest";
import { lspUriToPath } from "../../../src/index.js";

describe("lspUriToPath", () => {
  it("converts file:// URIs to filesystem paths", () => {
    // Cross-platform: POSIX file URL must decode to a POSIX path on every OS
    // (fileURLToPath throws ERR_INVALID_FILE_URL_PATH for this URL on Windows).
    expect(lspUriToPath("file:///Users/me/src/a.ts")).toBe("/Users/me/src/a.ts");
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
