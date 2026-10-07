import { describe, expect, it } from "vitest";
import { renderNavigationSection, uriToFsPath } from "../../../src/inspect/inspect-sections.js";

const R = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

describe("uriToFsPath", () => {
  it("resolves valid file: URIs", () => {
    expect(uriToFsPath("file:///a/b.ts")).toBe("/a/b.ts");
  });

  it("returns null for non-file schemes and malformed URIs", () => {
    expect(uriToFsPath("https://example.com/a.ts")).toBeNull();
    expect(uriToFsPath("untitled:Untitled-1")).toBeNull();
    expect(uriToFsPath("notauri")).toBeNull();
    expect(uriToFsPath("")).toBeNull();
  });
});

describe("renderNavigationSection null-path omission", () => {
  const base = { operation: "references", status: "ok" as const, truncated: false };

  it("omits items with invalid URIs", () => {
    const text = renderNavigationSection(
      {
        ...base,
        items: [
          { uri: "https://example.com/a.ts", range: R(0, 0, 0, 1) },
          { uri: "file:///b.ts", range: R(1, 0, 1, 2) },
        ],
      },
      "/",
    );
    expect(text).not.toContain("https://example.com");
    expect(text).toContain("/b.ts");
  });

  it("renders names without location when URI is invalid", () => {
    const text = renderNavigationSection(
      {
        ...base,
        items: [{ name: "fn", kind: 12, location: { uri: "untitled:U-1", range: R(0, 0, 1, 0) } }],
      },
      "/",
    );
    expect(text).toContain("fn");
    expect(text).not.toContain("untitled:U-1");
  });
});
