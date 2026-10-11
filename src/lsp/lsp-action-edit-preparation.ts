import { fileURLToPath } from "node:url";
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import type { BoundActionOriginHandoff } from "./lsp-action-origin.js";
import { envelopeResultToWorkspaceEdit } from "./lsp-workspace-edit.js";

export type ActionEditRefusal =
  | "no-edit"
  | "unsupported-encoding"
  | "command-or-disabled"
  | "malformed-edit"
  | "unsupported-semantics";

export type PreparedBoundActionEdit =
  | { readonly kind: "prepared"; readonly workspaceEdit: LspWorkspaceEdit; readonly document: { readonly canonicalPath: string; readonly sha256: string } }
  | { readonly kind: "refusal"; readonly reason: ActionEditRefusal };

const refusal = (reason: ActionEditRefusal): PreparedBoundActionEdit => Object.freeze({ kind: "refusal", reason });
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

interface Position { readonly line: number; readonly character: number }
interface RawTextEdit { readonly range: { readonly start: Position; readonly end: Position }; readonly newText: string }

const MAX_UINTEGER = 2 ** 31 - 1;
function validPosition(value: unknown): value is Position {
  return isRecord(value) && hasOnlyKeys(value, ["line", "character"]) &&
    Number.isInteger(value.line) && (value.line as number) >= 0 && (value.line as number) <= MAX_UINTEGER &&
    Number.isInteger(value.character) && (value.character as number) >= 0 && (value.character as number) <= MAX_UINTEGER;
}

function comparePosition(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

function validEdits(value: unknown): value is RawTextEdit[] {
  if (!Array.isArray(value) || value.length === 0 || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const edits: RawTextEdit[] = [];
  for (const item of value) {
    if (!isRecord(item) || !hasOnlyKeys(item, ["range", "newText"]) || typeof item.newText !== "string" || !isRecord(item.range) || !hasOnlyKeys(item.range, ["start", "end"])) return false;
    const { start, end } = item.range;
    if (!validPosition(start) || !validPosition(end) || comparePosition(start, end) > 0) return false;
    edits.push({ range: { start, end }, newText: item.newText });
  }
  const ordered = [...edits].sort((a, b) => comparePosition(a.range.start, b.range.start));
  let previousEnd: Position | undefined;
  for (const edit of ordered) {
    if (previousEnd && comparePosition(edit.range.start, previousEnd) < 0) return false;
    previousEnd = edit.range.end;
  }
  return true;
}

function hasCommandOrDisabled(action: unknown): boolean {
  return isRecord(action) && (Object.hasOwn(action, "command") || Object.hasOwn(action, "disabled"));
}

function decodeFileUri(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:" || parsed.search || parsed.hash) return null;
    return fileURLToPath(parsed);
  } catch { return null; }
}

/** Converts a raw WorkspaceEdit after rejecting unsupported protocol semantics. */
export function convertRawWorkspaceEdit(
  rawValue: unknown,
  origin: { readonly canonicalPath: string; readonly rawSha256: string; readonly receiptVersion: number },
): PreparedBoundActionEdit {
  const { canonicalPath: originCanonicalPath, rawSha256: originSha256, receiptVersion: originReceiptVersion } = origin;
  if (!originCanonicalPath || !/^[0-9a-f]{64}$/.test(originSha256) || !isRecord(rawValue)) return refusal("malformed-edit");
  const raw = rawValue;
  if (!hasOnlyKeys(raw, ["changes", "documentChanges"])) return refusal("unsupported-semantics");
  const hasChanges = Object.hasOwn(raw, "changes");
  const hasDocumentChanges = Object.hasOwn(raw, "documentChanges");
  if (hasChanges === hasDocumentChanges) return refusal("malformed-edit");
  const targetPaths: string[] = [];
  if (hasChanges) {
    if (!isRecord(raw.changes)) return refusal("malformed-edit");
    const entries = Object.entries(raw.changes);
    if (!entries.length) return refusal("malformed-edit");
    for (const [uri, edits] of entries) {
      const path = decodeFileUri(uri);
      if (!path || !validEdits(edits)) return refusal("malformed-edit");
      targetPaths.push(path);
    }
  } else {
    if (!Array.isArray(raw.documentChanges) || !raw.documentChanges.length || Object.getPrototypeOf(raw.documentChanges) !== Array.prototype) return refusal("malformed-edit");
    for (const change of raw.documentChanges) {
      if (!isRecord(change)) return refusal("malformed-edit");
      if (!hasOnlyKeys(change, ["textDocument", "edits"])) return refusal("unsupported-semantics");
      if (!isRecord(change.textDocument) || !hasOnlyKeys(change.textDocument, ["uri", "version"])) return refusal("unsupported-semantics");
      const { uri, version } = change.textDocument;
      const path = decodeFileUri(uri);
      if (!path || !validEdits(change.edits)) return refusal("malformed-edit");
      if (version !== null && (typeof version !== "number" || !Number.isSafeInteger(version))) return refusal("unsupported-semantics");
      if (typeof version === "number" && (path !== originCanonicalPath || version !== originReceiptVersion)) return refusal("unsupported-semantics");
      targetPaths.push(path);
    }
  }
  if (new Set(targetPaths).size !== targetPaths.length) return refusal("unsupported-semantics");
  const converted = envelopeResultToWorkspaceEdit({ edit: raw });
  if (!converted) return refusal("malformed-edit");
  const workspaceEdit = Object.freeze({
    positionEncoding: "utf-16" as const,
    fileEdits: Object.freeze(converted.fileEdits.map((file) => Object.freeze({
      filePath: file.filePath,
      edits: Object.freeze(file.edits.map((edit) => Object.freeze({
        filePath: edit.filePath,
        range: Object.freeze({ start: Object.freeze({ ...edit.range.start }), end: Object.freeze({ ...edit.range.end }) }),
        newText: edit.newText,
      }))),
    }))),
  });
  return Object.freeze({ kind: "prepared", workspaceEdit, document: Object.freeze({ canonicalPath: originCanonicalPath, sha256: originSha256 }) });
}

/** Converts formatting edits for the request's explicitly selected canonical target. */
export function convertFormattingTextEdits(
  edits: unknown,
  target: { readonly canonicalPath: string; readonly rawSha256: string },
): PreparedBoundActionEdit {
  const { canonicalPath: targetCanonicalPath, rawSha256 } = target;
  if (!targetCanonicalPath || !/^[0-9a-f]{64}$/.test(rawSha256) || !validEdits(edits)) return refusal("malformed-edit");
  const fileEdits = Object.freeze([Object.freeze({
    filePath: targetCanonicalPath,
    edits: Object.freeze(edits.map((edit) => Object.freeze({ filePath: targetCanonicalPath,
      range: Object.freeze({ start: Object.freeze({ ...edit.range.start }), end: Object.freeze({ ...edit.range.end }) }), newText: edit.newText }))),
  })]);
  return Object.freeze({ kind: "prepared", workspaceEdit: Object.freeze({ positionEncoding: "utf-16" as const, fileEdits }), document: Object.freeze({ canonicalPath: targetCanonicalPath, sha256: rawSha256 }) });
}

/** Encoding/action metadata checks remain at the caller; preparation itself is pure. */
export function prepareBoundActionEdit(origin: BoundActionOriginHandoff): PreparedBoundActionEdit {
  if (origin.server.positionEncoding !== "utf-16" || origin.receipt.positionEncoding !== "utf-16" ||
      origin.server.positionEncoding !== origin.receipt.positionEncoding) return refusal("unsupported-encoding");
  const action = origin.resolvedAction;
  if (hasCommandOrDisabled(origin.originalAction) || hasCommandOrDisabled(action)) return refusal("command-or-disabled");
  if (!isRecord(action)) return refusal("malformed-edit");
  if (!Object.hasOwn(action, "edit")) return refusal("no-edit");
  return convertRawWorkspaceEdit(action.edit, { canonicalPath: origin.source.canonicalPath, rawSha256: origin.source.rawSha256, receiptVersion: origin.receipt.version });
}
