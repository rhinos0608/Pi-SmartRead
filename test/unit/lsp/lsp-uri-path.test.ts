import { describe, expect, it } from "vitest";
import { lspUriToPath } from "../../../src/index.js";
import {
  incomingCalls,
  outgoingCalls,
} from "../../../src/lsp/lsp-call-hierarchy-adapter.js";

describe("lspUriToPath", () => {
  it("converts file:// URIs to filesystem paths", () => {
    // Cross-platform: POSIX file URL must decode to a POSIX path on every OS
    // (fileURLToPath throws ERR_INVALID_FILE_URL_PATH for this URL on Windows).
    expect(lspUriToPath("file:///Users/me/src/a.ts")).toBe("/Users/me/src/a.ts");
  });

  it("returns null for https: URIs (fail-closed)", () => {
    expect(lspUriToPath("https://example.com/src/a.ts")).toBeNull();
  });

  it("returns null for untitled: URIs (fail-closed)", () => {
    expect(lspUriToPath("untitled:Untitled-1")).toBeNull();
  });

  it("returns null for malformed URIs (fail-closed)", () => {
    expect(lspUriToPath("file://%zz")).toBeNull();
    expect(lspUriToPath("not a uri at all :::")).toBeNull();
  });

  it("returns null for raw paths (never resolved into paths)", () => {
    expect(lspUriToPath("D:\\src\\a.ts")).toBeNull();
    expect(lspUriToPath("/Users/me/src/a.ts")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(lspUriToPath("")).toBeNull();
  });
});

describe("call-hierarchy URI fail-closed", () => {
  const root = "/Users/me/src";
  it("incomingCalls returns [] for non-file URIs", async () => {
    const item = {
      kind: 12,
      name: "f",
      detail: "",
      uri: "https://example.com/a.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    await expect(incomingCalls(item, root)).resolves.toEqual([]);
  });

  it("outgoingCalls returns [] for non-file URIs", async () => {
    const item = {
      kind: 12,
      name: "f",
      detail: "",
      uri: "untitled:Untitled-1",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    await expect(outgoingCalls(item, root)).resolves.toEqual([]);
  });
});
