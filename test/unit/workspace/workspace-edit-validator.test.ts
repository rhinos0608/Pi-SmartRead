import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateWorkspaceEdit } from "../../src/workspace-edit-validator.js";

let dir: string;
let fileA: string;
let fileB: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-workspace-edit-validator-"));
  fileA = join(dir, "a.ts");
  fileB = join(dir, "b.ts");
  writeFileSync(fileA, "export const a = 1;\n", "utf-8");
  writeFileSync(fileB, "export const b = 2;\n", "utf-8");
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function validEdit(filePath: () => string = () => fileA, newText = "foo") {
  return {
    fileEdits: [
      {
        filePath: filePath(),
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText }],
      },
    ],
  };
}

describe("validateWorkspaceEdit", () => {
  it("valid single-file single-edit", () => {
    const r = validateWorkspaceEdit(validEdit());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fileEdits[0]!.filePath).toBeDefined();
  });
  it("valid multi-file rename", () => {
    const r = validateWorkspaceEdit({
      fileEdits: [
        { filePath: fileA, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }] },
        { filePath: fileB, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" }] },
      ],
    });
    expect(r.ok).toBe(true);
  });
  it("reject non-file URIs", () => {
    const r = validateWorkspaceEdit({
      fileEdits: [{ filePath: "https://example.com/a.ts", edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }] }],
    });
    expect(r.ok).toBe(false);
  });
  it("reject overlapping edits in same file", () => {
    const r = validateWorkspaceEdit({
      fileEdits: [
        {
          filePath: fileA,
          edits: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "x" },
            { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } }, newText: "y" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "overlapping_edits")).toBe(true);
  });
  it("reject exceeding maxFiles", () => {
    // Nonexistent paths are fine here — the cap is enforced before per-file realpath checks.
    const fileEdits = Array.from({ length: 51 }, (_, i) => ({
      filePath: `/tmp/pi-workspace-edit-validator-nonexistent-a${i}.ts`,
      edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }],
    }));
    const r = validateWorkspaceEdit({ fileEdits }, { maxFiles: 50 });
    expect(r.ok).toBe(false);
  });
  it("reject exceeding maxEdits", () => {
    const edits = Array.from({ length: 10 }, () => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }));
    const fileEdits = [{ filePath: fileA, edits }];
    const r = validateWorkspaceEdit({ fileEdits }, { maxEdits: 5 });
    expect(r.ok).toBe(false);
  });
  it("reject duplicate canonical paths", () => {
    const r = validateWorkspaceEdit({
      fileEdits: [
        { filePath: fileA, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }] },
        { filePath: fileA, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" }] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "duplicate_path")).toBe(true);
  });
  it("handle empty fileEdits array", () => {
    const r = validateWorkspaceEdit({ fileEdits: [] });
    expect(r.ok).toBe(false);
  });
  it("valid zero-width insertion start==end", () => {
    const r = validateWorkspaceEdit({
      fileEdits: [{ filePath: fileA, edits: [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, newText: "ins" }] }],
    });
    expect(r.ok).toBe(true);
  });
  it("reject negative line/character", () => {
    const r = validateWorkspaceEdit({
      fileEdits: [{ filePath: fileA, edits: [{ range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }] }],
    });
    expect(r.ok).toBe(false);
  });
  it("reject resource operations", () => {
    const r = validateWorkspaceEdit({
      fileEdits: [{ filePath: fileA, kind: "create", edits: [] } as unknown as never],
    });
    expect(r.ok).toBe(false);
  });
  it("reject overlapping unsorted should still detect", () => {
    const r = validateWorkspaceEdit({
      fileEdits: [
        {
          filePath: fileA,
          edits: [
            { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } }, newText: "b" },
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "a" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(false);
  });
  it("reject exceeds maxTotalBytes", () => {
    const big = "x".repeat(1024);
    const r = validateWorkspaceEdit(validEdit(() => fileA, big), { maxTotalBytes: 10 });
    expect(r.ok).toBe(false);
  });
});
