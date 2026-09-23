import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalizeNavigationItems,
  canonicalizeSingleNavItem,
} from "../../../src/inspect/inspect-runtime.js";

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };
const FILE_URI = pathToFileURL("/tmp/probe.ts").href;

describe("canonicalizeSingleNavItem URI fail-closed", () => {
  it("converts valid file: URIs (location, bare, from/to forms)", () => {
    expect((canonicalizeSingleNavItem({ uri: FILE_URI, range: RANGE }) as any).uri).toMatch(/^file:\/\//);
    expect((canonicalizeSingleNavItem({ location: { uri: FILE_URI, range: RANGE } }) as any).location.uri).toMatch(
      /^file:\/\//,
    );
    expect((canonicalizeSingleNavItem({ from: { uri: FILE_URI, name: "f" } }) as any).from.uri).toMatch(/^file:\/\//);
    expect((canonicalizeSingleNavItem({ to: { uri: FILE_URI, name: "g" } }) as any).to.uri).toMatch(/^file:\/\//);
  });

  it.each([
    ["https", { uri: "https://example.com/x.ts", range: RANGE }],
    ["untitled", { uri: "untitled:Untitled-1", range: RANGE }],
    ["malformed file", { uri: "file://%", range: RANGE }],
    ["bare garbage", { uri: "not-a-uri", range: RANGE }],
    ["location https", { location: { uri: "https://example.com/x.ts", range: RANGE } }],
    ["from git", { from: { uri: "git:/repo/file.ts", name: "f" } }],
    ["to untitled", { to: { uri: "untitled:Untitled-2", name: "g" } }],
  ])("rejects non-file/malformed URI (%s)", (_label, item) => {
    expect(canonicalizeSingleNavItem(item)).toBeNull();
  });

  it.each([
    ["from empty", { from: { uri: "", name: "f" } }],
    ["to non-string", { to: { uri: 123, name: "g" } }],
    ["from https", { from: { uri: "https://x", name: "f" } }],
    ["location non-string", { location: { uri: 123, range: RANGE } }],
    ["location empty", { location: { uri: "", range: RANGE } }],
  ])("rejects present-but-malformed nested URI (%s)", (_label, item) => {
    expect(canonicalizeSingleNavItem(item)).toBeNull();
  });

  it("passes through items with no URI untouched", () => {
    const hover = { contents: "x" };
    expect(canonicalizeSingleNavItem(hover)).toBe(hover);
    expect(canonicalizeSingleNavItem(null)).toBeNull();
  });
});

describe("canonicalizeNavigationItems", () => {
  it("filters rejected entries, keeps valid ones", () => {
    const out = canonicalizeNavigationItems(
      [{ uri: FILE_URI, range: RANGE }, { uri: "https://example.com/x.ts", range: RANGE }],
      "/tmp",
    );
    expect(out).toHaveLength(1);
    expect((out[0] as any).uri).toMatch(/^file:\/\//);
  });

  it.each(["/tmp/a#b.ts", "/tmp/a%b.ts", "/tmp/a b.ts"])("escapes %s and round-trips via fileURLToPath", (p) => {
    const out = canonicalizeSingleNavItem({ uri: pathToFileURL(p).href, range: RANGE }) as { uri: string };
    expect(out.uri).toBe(pathToFileURL(p).href);
    expect(fileURLToPath(out.uri)).toBe(p);
  });
});
