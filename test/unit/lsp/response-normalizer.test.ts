import { describe, expect, it } from "vitest";
import {
  normalizeCodeActions,
  normalizeCompletions,
  normalizeDocumentSymbols,
  normalizeHierarchyItems,
  normalizeHover,
  normalizeIncomingCalls,
  normalizeLocations,
  normalizeOutgoingCalls,
  normalizePrepareRename,
  normalizeSemanticTokens,
  normalizeWorkspaceEdit,
} from "../../../src/lsp/lsp-response-normalizer.js";

const R = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

describe("normalizeLocations — Location | Location[] | LocationLink[]", () => {
  it("wraps a single Location into a one-element array", () => {
    const loc = { uri: "file:///a.ts", range: R(1, 2, 1, 5) };
    expect(normalizeLocations(loc)).toEqual([loc]);
  });

  it("wraps a single LocationLink into a one-element array", () => {
    const link = {
      targetUri: "file:///b.ts",
      targetRange: R(0, 0, 10, 0),
      targetSelectionRange: R(2, 9, 2, 14),
    };
    expect(normalizeLocations(link)).toEqual([{ uri: "file:///b.ts", range: R(2, 9, 2, 14) }]);
  });

  it("normalizes a Location array unchanged", () => {
    const locs = [
      { uri: "file:///a.ts", range: R(0, 0, 0, 3) },
      { uri: "file:///b.ts", range: R(4, 1, 4, 9) },
    ];
    expect(normalizeLocations(locs)).toEqual(locs);
  });

  it("normalizes a LocationLink array, preferring targetSelectionRange", () => {
    expect(
      normalizeLocations([
        { targetUri: "file:///a.ts", targetRange: R(0, 0, 5, 0), targetSelectionRange: R(1, 0, 1, 3) },
        { targetUri: "file:///b.ts", targetRange: R(2, 0, 3, 0), targetSelectionRange: R(2, 4, 2, 7) },
      ]),
    ).toEqual([
      { uri: "file:///a.ts", range: R(1, 0, 1, 3) },
      { uri: "file:///b.ts", range: R(2, 4, 2, 7) },
    ]);
  });

  it("falls back to targetRange when targetSelectionRange is absent", () => {
    expect(normalizeLocations({ targetUri: "file:///a.ts", targetRange: R(0, 0, 5, 0) })).toEqual([
      { uri: "file:///a.ts", range: R(0, 0, 5, 0) },
    ]);
  });

  it("accepts a mixed Location + LocationLink array", () => {
    expect(
      normalizeLocations([
        { uri: "file:///a.ts", range: R(0, 0, 0, 3) },
        { targetUri: "file:///b.ts", targetRange: R(0, 0, 2, 0), targetSelectionRange: R(0, 0, 0, 5) },
      ]),
    ).toEqual([
      { uri: "file:///a.ts", range: R(0, 0, 0, 3) },
      { uri: "file:///b.ts", range: R(0, 0, 0, 5) },
    ]);
  });

  it("maps null, undefined, and empty arrays to an empty list", () => {
    expect(normalizeLocations(null)).toEqual([]);
    expect(normalizeLocations(undefined)).toEqual([]);
    expect(normalizeLocations([])).toEqual([]);
  });

  it("rejects a malformed entry anywhere in an array", () => {
    expect(normalizeLocations([{ uri: "file:///a.ts", range: R(0, 0, 0, 1) }, { uri: 42 }])).toBeNull();
    expect(normalizeLocations([null])).toBeNull();
    expect(normalizeLocations([{ targetUri: "file:///a.ts" }])).toBeNull();
  });

  it("rejects malformed links", () => {
    // targetSelectionRange present but invalid never silently falls back
    expect(
      normalizeLocations({ targetUri: "file:///a.ts", targetRange: R(0, 0, 5, 0), targetSelectionRange: "x" }),
    ).toBeNull();
    // targetRange is required
    expect(normalizeLocations({ targetUri: "file:///a.ts" })).toBeNull();
    expect(normalizeLocations({ targetRange: R(0, 0, 1, 1) })).toBeNull();
  });

  it("rejects malformed locations and non-location values", () => {
    expect(normalizeLocations({ uri: "file:///a.ts" })).toBeNull();
    expect(normalizeLocations({ uri: "", range: R(0, 0, 0, 1) })).toBeNull();
    expect(normalizeLocations({ uri: "file:///a.ts", range: R(1, 0, 0, 1) })).toBeNull();
    expect(normalizeLocations({ foo: 1 })).toBeNull();
    expect(normalizeLocations(42)).toBeNull();
    expect(normalizeLocations("file:///a.ts")).toBeNull();
  });
});

describe("normalizeDocumentSymbols — DocumentSymbol[] | SymbolInformation[]", () => {
  it("normalizes DocumentSymbols with recursive children", () => {
    const child = { name: "m", kind: 6, range: R(2, 2, 2, 10), selectionRange: R(2, 2, 2, 6) };
    const parent = {
      name: "C",
      kind: 5,
      range: R(0, 0, 5, 0),
      selectionRange: R(0, 6, 0, 7),
      children: [child],
    };
    expect(normalizeDocumentSymbols([parent])).toEqual([parent]);
  });

  it("normalizes SymbolInformation onto the DocumentSymbol shape", () => {
    const range = R(3, 0, 3, 9);
    expect(
      normalizeDocumentSymbols([
        { name: "fn", kind: 12, location: { uri: "file:///a.ts", range }, containerName: "ns" },
      ]),
    ).toEqual([{ name: "fn", kind: 12, range, selectionRange: range, uri: "file:///a.ts", containerName: "ns" }]);
  });

  it("accepts a mixed-form array", () => {
    const range = R(0, 0, 1, 0);
    const out = normalizeDocumentSymbols([
      { name: "C", kind: 5, range, selectionRange: R(0, 6, 0, 7) },
      { name: "fn", kind: 12, location: { uri: "file:///a.ts", range } },
    ]);
    expect(out).toHaveLength(2);
    expect(out?.[1]?.uri).toBe("file:///a.ts");
  });

  it("maps null, undefined, and empty arrays to an empty list", () => {
    expect(normalizeDocumentSymbols(null)).toEqual([]);
    expect(normalizeDocumentSymbols(undefined)).toEqual([]);
    expect(normalizeDocumentSymbols([])).toEqual([]);
  });

  it("does not wrap a bare non-array symbol", () => {
    expect(normalizeDocumentSymbols({ name: "C", kind: 5, range: R(0, 0, 1, 0), selectionRange: R(0, 0, 1, 0) })).toBeNull();
  });

  it("rejects malformed DocumentSymbol entries", () => {
    expect(normalizeDocumentSymbols([{ name: "C", kind: 5, range: R(0, 0, 1, 0) }])).toBeNull();
    expect(normalizeDocumentSymbols([{ name: "C", kind: 5, selectionRange: R(0, 0, 1, 0) }])).toBeNull();
    expect(normalizeDocumentSymbols([{ kind: 5, range: R(0, 0, 1, 0), selectionRange: R(0, 0, 1, 0) }])).toBeNull();
    expect(normalizeDocumentSymbols([{ name: "", kind: 5, range: R(0, 0, 1, 0), selectionRange: R(0, 0, 1, 0) }])).toBeNull();
    expect(
      normalizeDocumentSymbols([{ name: "C", kind: 5.5, range: R(0, 0, 1, 0), selectionRange: R(0, 0, 1, 0) }]),
    ).toBeNull();
    expect(
      normalizeDocumentSymbols([{ name: "C", kind: "5", range: R(0, 0, 1, 0), selectionRange: R(0, 0, 1, 0) }]),
    ).toBeNull();
    expect(
      normalizeDocumentSymbols([
        { name: "C", kind: 5, range: R(0, 0, 1, 0), selectionRange: R(0, 0, 1, 0), containerName: 7 },
      ]),
    ).toBeNull();
  });

  it("rejects malformed SymbolInformation entries", () => {
    expect(normalizeDocumentSymbols([{ name: "fn", kind: 12 }])).toBeNull();
    expect(normalizeDocumentSymbols([{ name: "fn", kind: 12, location: { uri: 42, range: R(0, 0, 1, 0) } }])).toBeNull();
    expect(normalizeDocumentSymbols([{ name: "fn", kind: 12, location: { uri: "file:///a.ts" } }])).toBeNull();
    expect(normalizeDocumentSymbols([{ name: "fn", kind: 12, location: "file:///a.ts" }])).toBeNull();
  });

  it("rejects the whole list when any child symbol is malformed", () => {
    expect(
      normalizeDocumentSymbols([
        {
          name: "C",
          kind: 5,
          range: R(0, 0, 5, 0),
          selectionRange: R(0, 6, 0, 7),
          children: [{ name: "m", kind: 6 }],
        },
      ]),
    ).toBeNull();
    expect(
      normalizeDocumentSymbols([
        { name: "C", kind: 5, range: R(0, 0, 5, 0), selectionRange: R(0, 6, 0, 7), children: "nope" },
      ]),
    ).toBeNull();
  });
});

describe("normalizeHover — markup variants", () => {
  it("passes MarkupContent through", () => {
    expect(normalizeHover({ contents: { kind: "markdown", value: "**hi**" } })).toEqual({
      contents: [{ kind: "markdown", value: "**hi**" }],
    });
    expect(normalizeHover({ contents: { kind: "plaintext", value: "hi" } })).toEqual({
      contents: [{ kind: "plaintext", value: "hi" }],
    });
  });

  it("wraps a bare string as plaintext", () => {
    expect(normalizeHover({ contents: "hi" })).toEqual({ contents: [{ kind: "plaintext", value: "hi" }] });
  });

  it("fences the MarkedString object form", () => {
    expect(normalizeHover({ contents: { language: "ts", value: "let x = 1" } })).toEqual({
      contents: [{ kind: "markdown", value: "```ts\nlet x = 1\n```" }],
    });
  });

  it("normalizes a MarkedString[] mixing strings, code, and MarkupContent", () => {
    expect(
      normalizeHover({
        contents: ["line", { language: "js", value: "f()" }, { kind: "plaintext", value: "doc" }],
      }),
    ).toEqual({
      contents: [
        { kind: "plaintext", value: "line" },
        { kind: "markdown", value: "```js\nf()\n```" },
        { kind: "plaintext", value: "doc" },
      ],
    });
  });

  it("carries a valid range and rejects an invalid one", () => {
    expect(normalizeHover({ contents: "x", range: R(1, 0, 1, 3) })).toEqual({
      contents: [{ kind: "plaintext", value: "x" }],
      range: R(1, 0, 1, 3),
    });
    expect(normalizeHover({ contents: "x", range: "nope" })).toBeNull();
    expect(normalizeHover({ contents: "x", range: R(1, 5, 1, 2) })).toBeNull();
  });

  it("returns null for a server-null or empty-object hover", () => {
    expect(normalizeHover(null)).toBeNull();
    expect(normalizeHover(undefined)).toBeNull();
    expect(normalizeHover({})).toBeNull();
  });

  it("keeps an explicitly empty contents array", () => {
    expect(normalizeHover({ contents: [] })).toEqual({ contents: [] });
  });

  it("rejects malformed contents", () => {
    expect(normalizeHover({ contents: 42 })).toBeNull();
    expect(normalizeHover({ contents: [null] })).toBeNull();
    expect(normalizeHover({ contents: { kind: "html", value: "x" } })).toBeNull();
    expect(normalizeHover({ contents: { value: 5 } })).toBeNull();
    expect(normalizeHover({ contents: { language: 7, value: "x" } })).toBeNull();
    expect(normalizeHover({ contents: null })).toBeNull();
    expect(normalizeHover("just a string")).toBeNull();
  });
});

describe("normalizeCompletions — CompletionItem[] | CompletionList", () => {
  it("normalizes a bare CompletionItem[] with item fields preserved", () => {
    const items = [
      { label: "alpha", detail: "fn alpha()", sortText: "1" },
      { label: "beta" },
    ];
    expect(normalizeCompletions(items)).toEqual({ isIncomplete: false, items });
  });

  it("normalizes a bare empty array", () => {
    expect(normalizeCompletions([])).toEqual({ isIncomplete: false, items: [] });
  });

  it("normalizes a CompletionList and preserves itemDefaults", () => {
    const items = [{ label: "x", insertText: "x()" }];
    const itemDefaults = { commitCharacters: ["."] };
    expect(normalizeCompletions({ isIncomplete: true, items, itemDefaults })).toEqual({
      isIncomplete: true,
      items,
      itemDefaults,
    });
  });

  it("returns null for a server-null completion", () => {
    expect(normalizeCompletions(null)).toBeNull();
    expect(normalizeCompletions(undefined)).toBeNull();
  });

  it("rejects malformed CompletionLists", () => {
    expect(normalizeCompletions({ items: [] })).toBeNull();
    expect(normalizeCompletions({ isIncomplete: "yes", items: [] })).toBeNull();
    expect(normalizeCompletions({ isIncomplete: true })).toBeNull();
    expect(normalizeCompletions({ isIncomplete: true, items: "nope" })).toBeNull();
    expect(normalizeCompletions({})).toBeNull();
    expect(normalizeCompletions(42)).toBeNull();
  });

  it("rejects malformed items anywhere in the list", () => {
    expect(normalizeCompletions([{ label: "ok" }, { insertText: "no-label" }])).toBeNull();
    expect(normalizeCompletions([{ label: 42 }])).toBeNull();
    expect(normalizeCompletions(["string-item"])).toBeNull();
    expect(normalizeCompletions({ isIncomplete: false, items: [null] })).toBeNull();
    expect(normalizeCompletions([{ label: "" }])).toBeNull();
  });
});

describe("normalizeWorkspaceEdit — changes | documentChanges, resource ops rejected", () => {
  it("normalizes the changes map form", () => {
    const edits = [{ range: R(0, 0, 0, 3), newText: "bar" }];
    expect(normalizeWorkspaceEdit({ changes: { "file:///a.ts": edits } })).toEqual({
      changes: [{ uri: "file:///a.ts", edits }],
    });
  });

  it("normalizes the documentChanges form and carries version", () => {
    const edits = [{ range: R(1, 0, 1, 4), newText: "x" }];
    expect(
      normalizeWorkspaceEdit({
        documentChanges: [{ textDocument: { uri: "file:///a.ts", version: 3 }, edits }],
      }),
    ).toEqual({ changes: [{ uri: "file:///a.ts", edits, version: 3 }] });
  });

  it("omits a null version", () => {
    const edits = [{ range: R(0, 0, 0, 1), newText: "y" }];
    expect(
      normalizeWorkspaceEdit({ documentChanges: [{ textDocument: { uri: "file:///a.ts", version: null }, edits }] }),
    ).toEqual({ changes: [{ uri: "file:///a.ts", edits }] });
  });

  it("merges documentChanges first, then changes, when both are present", () => {
    const edits = [{ range: R(0, 0, 0, 1), newText: "y" }];
    const out = normalizeWorkspaceEdit({
      documentChanges: [{ textDocument: { uri: "file:///a.ts", version: 1 }, edits }],
      changes: { "file:///b.ts": edits },
    });
    expect(out?.changes.map((c) => c.uri)).toEqual(["file:///a.ts", "file:///b.ts"]);
  });

  it("rejects every resource-operation kind", () => {
    for (const kind of ["create", "rename", "delete"]) {
      expect(
        normalizeWorkspaceEdit({
          documentChanges: [{ kind, uri: "file:///new.ts" }],
        }),
      ).toBeNull();
    }
  });

  it("rejects malformed edit lists", () => {
    expect(normalizeWorkspaceEdit({ changes: { "file:///a.ts": [] } })).toBeNull();
    expect(normalizeWorkspaceEdit({ changes: { "file:///a.ts": [{ range: R(0, 0, 0, 1) }] } })).toBeNull();
    expect(normalizeWorkspaceEdit({ changes: { "file:///a.ts": [{ newText: "x" }] } })).toBeNull();
    expect(normalizeWorkspaceEdit({ changes: { "file:///a.ts": [{ newText: "x", range: "bad" }] } })).toBeNull();
    expect(normalizeWorkspaceEdit({ changes: { "": [{ newText: "x", range: R(0, 0, 0, 1) }] } })).toBeNull();
    expect(normalizeWorkspaceEdit({ changes: { "file:///a.ts": "not-an-array" } })).toBeNull();
  });

  it("rejects malformed documentChanges entries", () => {
    expect(normalizeWorkspaceEdit({ documentChanges: [] })).toBeNull();
    expect(normalizeWorkspaceEdit({ documentChanges: "nope" })).toBeNull();
    expect(normalizeWorkspaceEdit({ documentChanges: [null] })).toBeNull();
    expect(
      normalizeWorkspaceEdit({ documentChanges: [{ textDocument: { uri: "file:///a.ts" }, edits: [] }] }),
    ).toBeNull();
    expect(
      normalizeWorkspaceEdit({
        documentChanges: [{ textDocument: { uri: "" }, edits: [{ newText: "x", range: R(0, 0, 0, 1) }] }],
      }),
    ).toBeNull();
    expect(
      normalizeWorkspaceEdit({
        documentChanges: [{ textDocument: { uri: "file:///a.ts", version: "3" }, edits: [{ newText: "x", range: R(0, 0, 0, 1) }] }],
      }),
    ).toBeNull();
  });

  it("returns null when there is no actionable edit", () => {
    expect(normalizeWorkspaceEdit(null)).toBeNull();
    expect(normalizeWorkspaceEdit({})).toBeNull();
    expect(normalizeWorkspaceEdit({ changes: {} })).toBeNull();
    expect(normalizeWorkspaceEdit(42)).toBeNull();
    expect(normalizeWorkspaceEdit("edit")).toBeNull();
  });
});

describe("normalizeCodeActions — CodeAction | Command", () => {
  it("normalizes a full CodeAction with edit", () => {
    const edits = [{ range: R(0, 0, 0, 3), newText: "foo" }];
    expect(
      normalizeCodeActions([
        {
          title: "Rename to foo",
          kind: "refactor.rewrite",
          isPreferred: true,
          edit: { changes: { "file:///a.ts": edits } },
          data: { id: 7 },
        },
      ]),
    ).toEqual([
      {
        title: "Rename to foo",
        kind: "refactor.rewrite",
        isPreferred: true,
        edit: { changes: [{ uri: "file:///a.ts", edits }] },
        data: { id: 7 },
      },
    ]);
  });

  it("normalizes a plain Command into the embedded-command shape", () => {
    expect(normalizeCodeActions([{ title: "Do it", command: "ext.doIt", arguments: [1, "two"] }])).toEqual([
      { title: "Do it", command: { title: "Do it", command: "ext.doIt", arguments: [1, "two"] } },
    ]);
  });

  it("normalizes a CodeAction carrying a Command object", () => {
    expect(
      normalizeCodeActions([{ title: "Fix", command: { title: "Run fix", command: "ext.fix" } }]),
    ).toEqual([{ title: "Fix", command: { title: "Run fix", command: "ext.fix" } }]);
  });

  it("normalizes the deprecated CodeAction string-command form", () => {
    expect(normalizeCodeActions([{ title: "Fix", kind: "quickfix", command: "ext.fix" }])).toEqual([
      { title: "Fix", kind: "quickfix", command: { title: "Fix", command: "ext.fix" } },
    ]);
  });

  it("carries disabled and rejects a malformed one", () => {
    expect(normalizeCodeActions([{ title: "A", disabled: { reason: "need context" } }])).toEqual([
      { title: "A", disabled: { reason: "need context" } },
    ]);
    expect(normalizeCodeActions([{ title: "A", disabled: { reason: 7 } }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", disabled: "off" }])).toBeNull();
  });

  it("maps null, undefined, and empty arrays to an empty list; does not wrap a bare object", () => {
    expect(normalizeCodeActions(null)).toEqual([]);
    expect(normalizeCodeActions(undefined)).toEqual([]);
    expect(normalizeCodeActions([])).toEqual([]);
    expect(normalizeCodeActions({ title: "A" })).toBeNull();
  });

  it("rejects malformed entries anywhere in the list", () => {
    expect(normalizeCodeActions([{ title: "ok" }, { command: "ext.x" }])).toBeNull();
    expect(normalizeCodeActions([{ title: 42 }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", command: "" }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", command: 42 }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", command: { title: "t", command: "" } }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", command: { command: "ext.x" } }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", kind: 5 }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", isPreferred: "yes" }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", command: "ext.x", arguments: "not-array" }])).toBeNull();
    expect(normalizeCodeActions(["string"])).toBeNull();
  });

  it("rejects an action whose edit is malformed or contains a resource operation", () => {
    expect(normalizeCodeActions([{ title: "A", edit: {} }])).toBeNull();
    expect(normalizeCodeActions([{ title: "A", edit: { changes: { "file:///a.ts": [{ newText: "x" }] } } }])).toBeNull();
    expect(
      normalizeCodeActions([{ title: "A", edit: { documentChanges: [{ kind: "create", uri: "file:///n.ts" }] } }]),
    ).toBeNull();
  });
});

describe("normalizePrepareRename — result variants", () => {
  it("wraps a bare Range", () => {
    expect(normalizePrepareRename(R(2, 5, 2, 8))).toEqual({ range: R(2, 5, 2, 8) });
  });

  it("normalizes the { range, placeholder } form", () => {
    expect(normalizePrepareRename({ range: R(2, 5, 2, 8), placeholder: "newName" })).toEqual({
      range: R(2, 5, 2, 8),
      placeholder: "newName",
    });
  });

  it("normalizes { range } without placeholder", () => {
    expect(normalizePrepareRename({ range: R(0, 0, 0, 4) })).toEqual({ range: R(0, 0, 0, 4) });
  });

  it("drops defaultBehavior", () => {
    expect(normalizePrepareRename({ range: R(0, 0, 0, 4), defaultBehavior: true })).toEqual({
      range: R(0, 0, 0, 4),
    });
  });

  it("rejects a non-string placeholder", () => {
    expect(normalizePrepareRename({ range: R(0, 0, 0, 4), placeholder: 42 })).toBeNull();
  });

  it("rejects malformed ranges in both forms", () => {
    expect(normalizePrepareRename(R(1, 5, 1, 2))).toBeNull();
    expect(normalizePrepareRename({ start: { line: 0, character: 0 } })).toBeNull();
    expect(normalizePrepareRename({ range: R(1, 5, 1, 2) })).toBeNull();
    expect(normalizePrepareRename({ range: "nope" })).toBeNull();
    expect(normalizePrepareRename({})).toBeNull();
  });

  it("returns null for null and non-object results", () => {
    expect(normalizePrepareRename(null)).toBeNull();
    expect(normalizePrepareRename(undefined)).toBeNull();
    expect(normalizePrepareRename("range")).toBeNull();
    expect(normalizePrepareRename(42)).toBeNull();
  });
});

describe("normalizeSemanticTokens — full | range | delta", () => {
  it("normalizes a full (or range) response to kind full", () => {
    expect(normalizeSemanticTokens({ data: [0, 1, 2, 3] })).toEqual({ kind: "full", data: [0, 1, 2, 3] });
    expect(normalizeSemanticTokens({ data: [] })).toEqual({ kind: "full", data: [] });
  });

  it("normalizes a delta response, preserving edit data", () => {
    expect(
      normalizeSemanticTokens({
        edits: [
          { start: 0, deleteCount: 6, data: [1, 2] },
          { start: 12, deleteCount: 0 },
        ],
      }),
    ).toEqual({
      kind: "delta",
      edits: [
        { start: 0, deleteCount: 6, data: [1, 2] },
        { start: 12, deleteCount: 0 },
      ],
    });
    expect(normalizeSemanticTokens({ edits: [] })).toEqual({ kind: "delta", edits: [] });
  });

  it("rejects an ambiguous data+edits shape", () => {
    expect(normalizeSemanticTokens({ data: [1], edits: [] })).toBeNull();
  });

  it("rejects malformed data", () => {
    expect(normalizeSemanticTokens({ data: [-1, 2] })).toBeNull();
    expect(normalizeSemanticTokens({ data: [1.5] })).toBeNull();
    expect(normalizeSemanticTokens({ data: "012" })).toBeNull();
    expect(normalizeSemanticTokens({ data: {} })).toBeNull();
  });

  it("rejects malformed delta edits", () => {
    expect(normalizeSemanticTokens({ edits: [{ start: -1, deleteCount: 0 }] })).toBeNull();
    expect(normalizeSemanticTokens({ edits: [{ start: 0, deleteCount: -2 }] })).toBeNull();
    expect(normalizeSemanticTokens({ edits: [{ start: "0", deleteCount: 1 }] })).toBeNull();
    expect(normalizeSemanticTokens({ edits: [{ start: 0, deleteCount: 1, data: ["x"] }] })).toBeNull();
    expect(normalizeSemanticTokens({ edits: "nope" })).toBeNull();
    expect(normalizeSemanticTokens({ edits: [null] })).toBeNull();
  });

  it("returns null for null and unknown shapes", () => {
    expect(normalizeSemanticTokens(null)).toBeNull();
    expect(normalizeSemanticTokens(undefined)).toBeNull();
    expect(normalizeSemanticTokens({})).toBeNull();
    expect(normalizeSemanticTokens(42)).toBeNull();
  });
});

describe("normalizeHierarchyItems / calls — opaque data preserved", () => {
  const item = (extra: Record<string, unknown> = {}) => ({
    name: "fn",
    kind: 12,
    uri: "file:///a.ts",
    range: R(1, 0, 4, 0),
    selectionRange: R(1, 9, 1, 11),
    ...extra,
  });

  it("preserves opaque data verbatim for call hierarchy items", () => {
    const data = { serverToken: "abc", nested: { list: [1, 2, 3] } };
    expect(normalizeHierarchyItems([item({ data })])).toEqual([item({ data })]);
    expect(normalizeHierarchyItems([item({ data })])?.[0]?.data).toEqual(data);
  });

  it("preserves opaque data for type hierarchy items (same shape)", () => {
    const data = { id: 42 };
    expect(normalizeHierarchyItems([item({ data })])).toEqual([item({ data })]);
  });

  it("omits data when the server sent none", () => {
    const out = normalizeHierarchyItems([item()]);
    expect(out).toEqual([item()]);
    expect(out?.[0]).not.toHaveProperty("data");
  });

  it("carries detail and tags", () => {
    expect(normalizeHierarchyItems([item({ detail: "fn(): void", tags: [1] })])).toEqual([
      item({ detail: "fn(): void", tags: [1] }),
    ]);
  });

  it("maps null, undefined, and empty arrays to an empty list; rejects non-arrays", () => {
    expect(normalizeHierarchyItems(null)).toEqual([]);
    expect(normalizeHierarchyItems(undefined)).toEqual([]);
    expect(normalizeHierarchyItems([])).toEqual([]);
    expect(normalizeHierarchyItems({})).toBeNull();
  });

  it("rejects malformed hierarchy items", () => {
    expect(normalizeHierarchyItems([item({ name: "" })])).toBeNull();
    expect(normalizeHierarchyItems([item({ kind: "12" })])).toBeNull();
    expect(normalizeHierarchyItems([item({ uri: "" })])).toBeNull();
    expect(normalizeHierarchyItems([item({ range: "x" })])).toBeNull();
    expect(normalizeHierarchyItems([item({ selectionRange: null })])).toBeNull();
    expect(normalizeHierarchyItems([item({ detail: 5 })])).toBeNull();
    expect(normalizeHierarchyItems([item({ tags: [1, "x"] })])).toBeNull();
    expect(normalizeHierarchyItems([item(), null])).toBeNull();
  });

  it("normalizes incoming calls and rejects malformed entries", () => {
    const from = item();
    expect(normalizeIncomingCalls([{ from, fromRanges: [R(1, 9, 1, 11)] }])).toEqual([
      { from, fromRanges: [R(1, 9, 1, 11)] },
    ]);
    expect(normalizeIncomingCalls([{ from, fromRanges: [] }])).toEqual([{ from, fromRanges: [] }]);
    expect(normalizeIncomingCalls(null)).toEqual([]);
    expect(normalizeIncomingCalls([{}])).toBeNull();
    expect(normalizeIncomingCalls([{ from: item(), fromRanges: "nope" }])).toBeNull();
    expect(normalizeIncomingCalls([{ from: item(), fromRanges: [{ bad: 1 }] }])).toBeNull();
    expect(normalizeIncomingCalls({})).toBeNull();
  });

  it("normalizes outgoing calls and rejects malformed entries", () => {
    const to = item({ name: "callee" });
    expect(normalizeOutgoingCalls([{ to, fromRanges: [R(2, 0, 2, 6)] }])).toEqual([
      { to, fromRanges: [R(2, 0, 2, 6)] },
    ]);
    expect(normalizeOutgoingCalls(null)).toEqual([]);
    expect(normalizeOutgoingCalls([{}])).toBeNull();
    expect(normalizeOutgoingCalls([{ to: item({ uri: 7 }) , fromRanges: [] }])).toBeNull();
    expect(normalizeOutgoingCalls("nope")).toBeNull();
  });
});

describe("scheme allowlist — only valid file: URIs accepted", () => {
  it("accepts file: URIs", () => {
    expect(normalizeLocations({ uri: "file:///a.ts", range: R(0, 0, 0, 1) })).toHaveLength(1);
  });

  it("rejects https:/untitled:/malformed URIs in locations (whole-list fail)", () => {
    for (const bad of ["https://example.com/a.ts", "untitled:Untitled-1", "file://[::1", "notauri", "ftp://h/x"]) {
      expect(normalizeLocations({ uri: bad, range: R(0, 0, 0, 1) })).toBeNull();
      expect(
        normalizeLocations([{ uri: "file:///a.ts", range: R(0, 0, 0, 1) }, { uri: bad, range: R(0, 0, 0, 1) }]),
      ).toBeNull();
      expect(normalizeLocations({ targetUri: bad, targetRange: R(0, 0, 1, 0) })).toBeNull();
    }
  });

  it("rejects non-file URIs in hierarchy items, symbol locations, and workspace edits", () => {
    const item = {
      name: "fn",
      kind: 12,
      uri: "https://example.com/a.ts",
      range: R(1, 0, 4, 0),
      selectionRange: R(1, 9, 1, 11),
    };
    expect(normalizeHierarchyItems([item])).toBeNull();
    expect(
      normalizeDocumentSymbols([{ name: "fn", kind: 12, location: { uri: "untitled:U-1", range: R(0, 0, 1, 0) } }]),
    ).toBeNull();
    const edits = [{ range: R(0, 0, 0, 3), newText: "bar" }];
    expect(normalizeWorkspaceEdit({ changes: { "https://example.com/a.ts": edits } })).toBeNull();
    expect(
      normalizeWorkspaceEdit({
        documentChanges: [{ textDocument: { uri: "untitled:U-1", version: 1 }, edits }],
      }),
    ).toBeNull();
  });
});
