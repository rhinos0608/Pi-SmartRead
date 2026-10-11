import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { convertFormattingTextEdits, convertRawWorkspaceEdit, prepareBoundActionEdit } from "../../../src/lsp/lsp-action-edit-preparation.js";
import type { BoundActionOriginHandoff } from "../../../src/lsp/lsp-action-origin.js";
import { snapshotActionJson } from "../../../src/lsp/lsp-action-json.js";

const fixtureRoot = join(tmpdir(), "pi-smartread-action-edit-fixtures");
const sourcePath = join(fixtureRoot, "source.ts");
const targetPath = join(fixtureRoot, "target.ts");
const sha = createHash("sha256").update("source bytes").digest("hex");

// Typed mocked receipt/origin fixture; it is not a live server or authority to mutate.
function makeOrigin(edit: unknown, extra: Record<string, unknown> = {}): BoundActionOriginHandoff {
  const receipt = {
    canonicalPath: sourcePath, uri: pathToFileURL(sourcePath).href, version: 7, textHash: sha,
    mutationGeneration: 2, submissionStamp: 3, syncConfig: { openClose: true, change: "full" as const },
    connectionId: "fixture-connection", transportId: "fixture-transport", storeId: "fixture-store", stateId: "fixture-state",
    descriptorId: "fixture-server", projectRoot: fixtureRoot, positionEncoding: "utf-16" as const,
  };
  const action = snapshotActionJson({ title: "Fixture", kind: "quickfix", ...(edit === undefined ? {} : { edit }), ...extra });
  return {
    source: { originalPath: join(fixtureRoot, "alias-source.ts"), canonicalPath: sourcePath, rawSha256: sha, textSha256: sha },
    query: { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, context: { diagnostics: [] } },
    selection: { actionId: sha, rawSha256: sha },
    server: { descriptorId: "fixture-server", name: "fixture", languageId: "typescript", projectRoot: fixtureRoot, positionEncoding: "utf-16" },
    receipt,
    originalAction: snapshotActionJson({ title: "Fixture", kind: "quickfix" }),
    resolvedAction: action,
  };
}

const edit1 = { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: "first\n" };
const edit2 = { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: "second" };
const prepared = (edit: unknown) => prepareBoundActionEdit(makeOrigin(edit));

describe("prepareBoundActionEdit", () => {
  it("exposes pure raw and explicitly-targeted formatting edit converters", () => {
    const raw = { changes: { [pathToFileURL(targetPath).href]: [edit1] } };
    const origin = { canonicalPath: sourcePath, rawSha256: sha, receiptVersion: 7 };
    const target = { canonicalPath: targetPath, rawSha256: sha };
    expect(convertRawWorkspaceEdit(raw, origin)).toMatchObject({ kind: "prepared", document: { canonicalPath: sourcePath, sha256: sha } });
    expect(convertFormattingTextEdits([edit1], target)).toMatchObject({ kind: "prepared", document: { canonicalPath: targetPath, sha256: sha }, workspaceEdit: { fileEdits: [{ filePath: targetPath }] } });
  });
  it.each(["", "A".repeat(64), "a".repeat(63)])("refuses invalid source hashes from both converters (%s)", (rawSha256) => {
    const raw = { changes: { [pathToFileURL(targetPath).href]: [edit1] } };
    const origin = { canonicalPath: sourcePath, rawSha256, receiptVersion: 7 };
    const target = { canonicalPath: targetPath, rawSha256 };
    expect(convertRawWorkspaceEdit(raw, origin)).toEqual({ kind: "refusal", reason: "malformed-edit" });
    expect(convertFormattingTextEdits([edit1], target)).toEqual({ kind: "refusal", reason: "malformed-edit" });
  });
  it("refuses a same-start insertion following a replacement", () => {
    const replacement = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "replace" };
    const insertion = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "insert" };
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: [replacement, insertion] } })).toEqual({ kind: "refusal", reason: "malformed-edit" });
  });
  it.each(["line", "character"] as const)("refuses %s outside LSP's uinteger range", (axis) => {
    const position = axis === "line" ? { line: 2 ** 31, character: 0 } : { line: 0, character: 2 ** 31 };
    const edits = [{ range: { start: position, end: { ...position } }, newText: "x" }];
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: edits } })).toEqual({ kind: "refusal", reason: "malformed-edit" });
  });
  it("refuses overlapping raw edits rather than preparing conflicting operations", () => {
    const edits = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: "left" },
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } }, newText: "right" },
    ];
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: edits } })).toMatchObject({ kind: "refusal" });
  });

  it.each(["command", "disabled"] as const)("refuses an original action retaining %s semantics", (key) => {
    const origin = makeOrigin({ changes: { [pathToFileURL(targetPath).href]: [edit1] } });
    const originalAction = snapshotActionJson({ title: "Fixture", kind: "quickfix", [key]: key === "command" ? { title: "Run", command: "fixture.run" } : { reason: "disabled" } });
    expect(prepareBoundActionEdit({ ...origin, originalAction })).toEqual({ kind: "refusal", reason: "command-or-disabled" });
  });
  it("preserves raw changes text, ranges, and order and returns source identity", () => {
    const result = prepared({ changes: { [pathToFileURL(targetPath).href]: [edit1, edit2] } });
    expect(result).toMatchObject({ kind: "prepared", document: { canonicalPath: sourcePath, sha256: sha } });
    expect(makeOrigin({ changes: { [pathToFileURL(targetPath).href]: [edit1] } }).source.originalPath).not.toBe(sourcePath);
    if (result.kind !== "prepared") throw new Error("expected prepared edit");
    expect(result.workspaceEdit.fileEdits[0]?.edits.map(({ newText }) => newText)).toEqual(["first\n", "second"]);
    expect(result.workspaceEdit.fileEdits[0]?.filePath).toBe(targetPath);
    expect(result.workspaceEdit.positionEncoding).toBe("utf-16");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.workspaceEdit)).toBe(true);
    expect(Object.isFrozen(result.workspaceEdit.fileEdits)).toBe(true);
    expect(Object.isFrozen(result.workspaceEdit.fileEdits[0]?.edits[0]?.range.start)).toBe(true);
  });

  it("accepts only explicit UTF-16 and refuses command, disabled, and missing edits", () => {
    expect(prepared(undefined)).toEqual({ kind: "refusal", reason: "no-edit" });
    expect(prepareBoundActionEdit(makeOrigin({ changes: { [pathToFileURL(targetPath).href]: [edit1] } }, { command: "run" }))).toEqual({ kind: "refusal", reason: "command-or-disabled" });
    expect(prepareBoundActionEdit(makeOrigin({ changes: { [pathToFileURL(targetPath).href]: [edit1] } }, { disabled: { reason: "no" } }))).toEqual({ kind: "refusal", reason: "command-or-disabled" });
    const nonUtf16 = makeOrigin({ changes: { [pathToFileURL(targetPath).href]: [edit1] } });
    expect(prepareBoundActionEdit({ ...nonUtf16, server: { ...nonUtf16.server, positionEncoding: "utf-8" } })).toEqual({ kind: "refusal", reason: "unsupported-encoding" });
  });

  it("accepts raw documentChanges with null or matching source version only", () => {
    const documentChanges = [{ textDocument: { uri: pathToFileURL(sourcePath).href, version: 7 }, edits: [edit1] }];
    expect(prepared({ documentChanges }).kind).toBe("prepared");
    expect(prepared({ documentChanges: [{ textDocument: { uri: pathToFileURL(targetPath).href, version: null }, edits: [edit2] }] }).kind).toBe("prepared");
    expect(prepared({ documentChanges: [{ textDocument: { uri: pathToFileURL(sourcePath).href, version: 6 }, edits: [edit1] }] })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
    expect(prepared({ documentChanges: [{ textDocument: { uri: pathToFileURL(targetPath).href, version: 7 }, edits: [edit1] }] })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
  });

  it("rejects projected normalized forms, mixed/bad edits, annotations and resource operations", () => {
    expect(prepared({ changes: [{ uri: pathToFileURL(targetPath).href, edits: [edit1] }] })).toMatchObject({ kind: "refusal" });
    expect(prepared({ changes: {}, documentChanges: [] })).toMatchObject({ kind: "refusal" });
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: [edit1] }, changeAnnotations: {} })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
    expect(prepared({ documentChanges: [{ kind: "create", uri: pathToFileURL(targetPath).href }] })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: [edit1, { ...edit2, range: { start: { line: 4, character: 0 }, end: { line: 3, character: 0 } } }] } })).toMatchObject({ kind: "refusal" });
  });

  it("rejects unsafe ranges, malformed URIs, and duplicate decoded targets all-or-none", () => {
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: [{ ...edit1, range: { ...edit1.range, start: { line: -1, character: 0 } } }] } })).toMatchObject({ kind: "refusal" });
    expect(prepared({ changes: { "https://example.test/file.ts": [edit1] } })).toMatchObject({ kind: "refusal" });
    const alias = pathToFileURL(targetPath).href.replace("target.ts", "%74arget.ts");
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: [edit1], [alias]: [edit2] } })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
  });

  it("detaches prepared output from mutable caller-owned fixture input", () => {
    const raw = { changes: { [pathToFileURL(targetPath).href]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "before" }] } };
    const origin = { ...makeOrigin(raw), resolvedAction: { title: "Fixture", kind: "quickfix", edit: raw } };
    const result = prepareBoundActionEdit(origin);
    raw.changes[pathToFileURL(targetPath).href]![0]!.newText = "after";
    raw.changes[pathToFileURL(targetPath).href]![0]!.range.start.line = 9;
    Reflect.set(origin.source, "canonicalPath", join(fixtureRoot, "session.jsonl"));
    Reflect.set(origin.source, "rawSha256", "0".repeat(64));
    expect(result.kind).toBe("prepared");
    if (result.kind === "prepared") {
      expect(result.workspaceEdit.fileEdits[0]?.edits[0]?.newText).toBe("before");
      expect(result.workspaceEdit.fileEdits[0]?.edits[0]?.range.start.line).toBe(0);
      expect(result.document).toEqual({ canonicalPath: sourcePath, sha256: sha });
    }
  });

  it("refuses malformed workspace edit containers and missing or mismatched encodings", () => {
    for (const edit of [null, [], {}, { changes: {} }, { documentChanges: [] }, { changes: {}, documentChanges: [] }, { changes: null }, { changes: { [pathToFileURL(targetPath).href]: [] } }]) {
      expect(prepared(edit)).not.toMatchObject({ kind: "prepared" });
    }
    for (const encoding of ["utf-8", "utf-32"] as const) {
      const origin = makeOrigin({ changes: { [pathToFileURL(targetPath).href]: [edit1] } });
      expect(prepareBoundActionEdit({ ...origin, server: { ...origin.server, positionEncoding: encoding } })).toEqual({ kind: "refusal", reason: "unsupported-encoding" });
    }
    const missing = makeOrigin({ changes: { [pathToFileURL(targetPath).href]: [edit1] } });
    Reflect.set(missing.server, "positionEncoding", undefined);
    expect(prepareBoundActionEdit(missing)).toEqual({ kind: "refusal", reason: "unsupported-encoding" });
    const mismatch = makeOrigin({ changes: { [pathToFileURL(targetPath).href]: [edit1] } });
    Reflect.set(mismatch.receipt, "positionEncoding", "utf-8");
    expect(prepareBoundActionEdit(mismatch)).toEqual({ kind: "refusal", reason: "unsupported-encoding" });
  });

  it("accepts the uinteger maximum and refuses negative, fractional, and excessive positions", () => {
    const max = 2 ** 31 - 1;
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: [{ range: { start: { line: max, character: max }, end: { line: max, character: max } }, newText: "max" }] } }).kind).toBe("prepared");
    for (const position of [{ line: -1, character: 0 }, { line: 0.5, character: 0 }, { line: 0, character: -0.5 }, { line: max + 1, character: 0 }]) {
      expect(prepared({ changes: { [pathToFileURL(targetPath).href]: [{ range: { start: position, end: position }, newText: "invalid" }] } })).toEqual({ kind: "refusal", reason: "malformed-edit" });
    }
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: [{ range: { start: { line: 1, character: 0 }, end: { line: 0, character: 0 } }, newText: "reversed" }] } })).toEqual({ kind: "refusal", reason: "malformed-edit" });
  });

  it("accepts valid unsorted, cross-line, touching, and ordered same-point inserts without reordering", () => {
    const insertionAtStart = { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, newText: "insert-before" };
    const replacement = { range: { start: { line: 0, character: 2 }, end: { line: 1, character: 0 } }, newText: "replace" };
    const same1 = { range: { start: { line: 2, character: 3 }, end: { line: 2, character: 3 } }, newText: "A" };
    const same2 = { range: { start: { line: 2, character: 3 }, end: { line: 2, character: 3 } }, newText: "B" };
    const touching = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: "touching" };
    const unsorted = [touching, same1, insertionAtStart, same2, replacement];
    const result = prepared({ changes: { [pathToFileURL(targetPath).href]: unsorted } });
    expect(result.kind).toBe("prepared");
    if (result.kind === "prepared") expect(result.workspaceEdit.fileEdits[0]?.edits.map(({ newText }) => newText)).toEqual(["touching", "A", "insert-before", "B", "replace"]);
  });

  it.each([
    ["equal-start replacements", [{ start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }]],
    ["partial overlap", [{ start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } }]],
    ["nested overlap", [{ start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }]],
    ["cross-line overlap", [{ start: { line: 0, character: 3 }, end: { line: 2, character: 0 } }, { start: { line: 1, character: 0 }, end: { line: 2, character: 1 } }]],
    ["insert inside replacement", [{ start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }]],
  ])("refuses %s", (_name, ranges) => {
    const edits = ranges.map((range, index) => ({ range, newText: String(index) }));
    expect(prepared({ changes: { [pathToFileURL(targetPath).href]: edits } })).toMatchObject({ kind: "refusal" });
  });

  it("refuses annotation tables, annotated text edits, and each resource operation", () => {
    const uri = pathToFileURL(targetPath).href;
    expect(prepared({ changes: { [uri]: [edit1] }, changeAnnotations: { confirm: { label: "Confirm", needsConfirmation: true } } })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
    expect(prepared({ changes: { [uri]: [{ ...edit1, annotationId: "confirm" }] } })).toEqual({ kind: "refusal", reason: "malformed-edit" });
    for (const operation of [
      { kind: "create", uri }, { kind: "rename", oldUri: uri, newUri: pathToFileURL(sourcePath).href }, { kind: "delete", uri },
    ]) {
      expect(prepared({ documentChanges: [operation] })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
    }
  });

  it("refuses malformed, non-file, query/fragment, and duplicate-decoded file URIs", () => {
    for (const uri of ["not-a-uri", "file:///bad%ZZ", "https://example.test/file.ts", `${pathToFileURL(targetPath).href}?query=1`, `${pathToFileURL(targetPath).href}#fragment`]) {
      expect(prepared({ changes: { [uri]: [edit1] } })).toEqual({ kind: "refusal", reason: "malformed-edit" });
    }
    const uri = pathToFileURL(targetPath).href;
    const decodedAlias = uri.replace("target.ts", "%74arget.ts");
    expect(prepared({ changes: { [uri]: [edit1], [decodedAlias]: [edit2] } })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
  });

  it("accepts null and matching source versions; refuses missing, mismatch, and foreign numeric versions", () => {
    for (const versionEdit of [
      { textDocument: { uri: pathToFileURL(sourcePath).href, version: 7 }, edits: [edit1] },
      { textDocument: { uri: pathToFileURL(targetPath).href, version: null }, edits: [edit2] },
    ]) expect(prepared({ documentChanges: [versionEdit] }).kind).toBe("prepared");
    for (const versionEdit of [
      { textDocument: { uri: pathToFileURL(sourcePath).href, version: 6 }, edits: [edit1] },
      { textDocument: { uri: pathToFileURL(targetPath).href, version: 7 }, edits: [edit1] },
      { textDocument: { uri: pathToFileURL(sourcePath).href }, edits: [edit1] },
      { textDocument: { uri: pathToFileURL(sourcePath).href, version: 7.5 }, edits: [edit1] },
    ]) expect(prepared({ documentChanges: [versionEdit] })).toEqual({ kind: "refusal", reason: "unsupported-semantics" });
  });
});
