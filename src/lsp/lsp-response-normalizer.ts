/**
 * Canonical LSP response normalization — Workstream G (plan § canonical
 * response normalization).
 *
 * One tested subsystem parses every protocol union the strict LSP surface
 * consumes: Location/LocationLink, DocumentSymbol/SymbolInformation, hover
 * markup, CompletionItem[]/CompletionList, CodeAction/Command, WorkspaceEdit
 * changes/documentChanges, prepareRename variants, semantic tokens, and
 * hierarchy items.
 *
 * Fail-closed contract for every function here:
 * - Malformed input → `null` (one malformed entry rejects the whole list).
 * - Server `null`/`undefined` → empty array for list unions, `null` for
 *   object unions. Two exceptions to "empty for lists" are deliberate and
 *   documented at the function: completion (an empty CompletionList would
 *   fabricate isIncomplete) and WorkspaceEdit (no actionable proposal —
 *   matches the existing convertWorkspaceEdit contract).
 * - Carried fields are validated; opaque carried fields (hierarchy `data`,
 *   completion item extras, command `arguments`) are preserved verbatim;
 *   fields not carried (e.g. CodeAction.diagnostics) are not validated.
 */
import type {
  LSPCallHierarchyIncomingCall,
  LSPCallHierarchyItem,
  LSPCallHierarchyOutgoingCall,
  LSPLocation,
  LSPMarkupContent,
  LSPRange,
} from "./lsp-types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function asPosition(value: unknown): { line: number; character: number } | null {
  if (!isPlainObject(value)) return null;
  if (!isUint(value.line) || !isUint(value.character)) return null;
  return { line: value.line, character: value.character };
}

/** Strict range: both positions well-formed, non-negative, ordered. */
function asRange(value: unknown): LSPRange | null {
  if (!isPlainObject(value)) return null;
  const start = asPosition(value.start);
  const end = asPosition(value.end);
  if (!start || !end) return null;
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) return null;
  return { start, end };
}

function asUintArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const entry of value) {
    if (!isUint(entry)) return null;
    out.push(entry);
  }
  return out;
}

// ── Location | Location[] | LocationLink[] ─────────────────────────

/** Only valid `file:` URIs are accepted; other schemes/malformed reject the entry. */
function isValidFileUri(uri: string): boolean {
  if (!uri.startsWith("file://")) return false;
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:";
  } catch {
    return false;
  }
}

function asLocation(value: unknown): LSPLocation | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.uri !== "string" || value.uri.length === 0) return null;
  if (!isValidFileUri(value.uri)) return null;
  const range = asRange(value.range);
  if (!range) return null;
  return { uri: value.uri, range };
}

/**
 * LocationLink → Location. targetRange is required; targetSelectionRange is
 * required by spec but tolerated when absent (interop), and preferred as the
 * canonical range when present because it identifies the symbol itself.
 * originSelectionRange does not contribute to the output and is not validated.
 */
function asLocationLink(value: unknown): LSPLocation | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.targetUri !== "string" || value.targetUri.length === 0) return null;
  if (!isValidFileUri(value.targetUri)) return null;
  const targetRange = asRange(value.targetRange);
  if (!targetRange) return null;
  let selection: LSPRange | null;
  if (value.targetSelectionRange !== undefined) {
    selection = asRange(value.targetSelectionRange);
    if (!selection) return null;
  } else {
    selection = null;
  }
  return { uri: value.targetUri, range: selection ?? targetRange };
}

/**
 * Normalizes `Location | Location[] | LocationLink[] | null`.
 * A single Location (or LocationLink) wraps to a one-element array;
 * null/undefined and empty arrays map to `[]`.
 */
export function normalizeLocations(result: unknown): LSPLocation[] | null {
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) {
    const out: LSPLocation[] = [];
    for (const entry of result) {
      const loc = asLocation(entry) ?? asLocationLink(entry);
      if (!loc) return null;
      out.push(loc);
    }
    return out;
  }
  const single = asLocation(result) ?? asLocationLink(result);
  return single ? [single] : null;
}

// ── DocumentSymbol[] | SymbolInformation[] ─────────────────────────

export interface NormalizedDocumentSymbol {
  name: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: NormalizedDocumentSymbol[];
  /** Present only for the SymbolInformation form (derived from location.uri). */
  uri?: string;
  containerName?: string;
}

function normalizeSymbolEntry(entry: unknown): NormalizedDocumentSymbol | null {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.name !== "string" || entry.name.length === 0) return null;
  if (!isUint(entry.kind)) return null;

  // DocumentSymbol form: own range + selectionRange (+ optional children).
  if (entry.range !== undefined || entry.selectionRange !== undefined) {
    const range = asRange(entry.range);
    const selectionRange = asRange(entry.selectionRange);
    if (!range || !selectionRange) return null;
    const symbol: NormalizedDocumentSymbol = { name: entry.name, kind: entry.kind, range, selectionRange };
    if (entry.children !== undefined) {
      if (!Array.isArray(entry.children)) return null;
      const children: NormalizedDocumentSymbol[] = [];
      for (const child of entry.children) {
        const normalized = normalizeSymbolEntry(child);
        if (!normalized) return null;
        children.push(normalized);
      }
      symbol.children = children;
    }
    if (entry.containerName !== undefined) {
      if (typeof entry.containerName !== "string") return null;
      symbol.containerName = entry.containerName;
    }
    return symbol;
  }

  // SymbolInformation form: range lives in location; selection collapses onto it.
  if (isPlainObject(entry.location)) {
    const location = entry.location;
    if (typeof location.uri !== "string" || location.uri.length === 0) return null;
    if (!isValidFileUri(location.uri)) return null;
    const range = asRange(location.range);
    if (!range) return null;
    const symbol: NormalizedDocumentSymbol = {
      name: entry.name,
      kind: entry.kind,
      range,
      selectionRange: range,
      uri: location.uri,
    };
    if (entry.containerName !== undefined) {
      if (typeof entry.containerName !== "string") return null;
      symbol.containerName = entry.containerName;
    }
    return symbol;
  }

  return null;
}

/**
 * Normalizes `DocumentSymbol[] | SymbolInformation[] | null` into one shape.
 * null/undefined and empty arrays map to `[]`; a non-array input does not
 * wrap (unlike Location — the protocol never returns a bare symbol here).
 */
export function normalizeDocumentSymbols(result: unknown): NormalizedDocumentSymbol[] | null {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) return null;
  const out: NormalizedDocumentSymbol[] = [];
  for (const entry of result) {
    const symbol = normalizeSymbolEntry(entry);
    if (!symbol) return null;
    out.push(symbol);
  }
  return out;
}

// ── Hover: MarkupContent | MarkedString | MarkedString[] ───────────

export interface NormalizedHover {
  /** Never absent; empty array means the server returned empty contents. */
  contents: LSPMarkupContent[];
  range?: LSPRange;
}

/**
 * MarkupContent passes through; bare strings become plaintext; the
 * MarkedString object form { language, value } becomes a fenced markdown
 * block (the standard client rendering — language and value both survive).
 */
function normalizeMarkupEntry(entry: unknown): LSPMarkupContent | null {
  if (typeof entry === "string") return { kind: "plaintext", value: entry };
  if (!isPlainObject(entry)) return null;
  if (typeof entry.value !== "string") return null;
  if (entry.kind !== undefined) {
    if (entry.kind !== "markdown" && entry.kind !== "plaintext") return null;
    return { kind: entry.kind, value: entry.value };
  }
  if (typeof entry.language === "string") {
    return { kind: "markdown", value: "```" + entry.language + "\n" + entry.value + "\n```" };
  }
  return null;
}

/** Normalizes a Hover result. null/undefined (server: no hover) → null. */
export function normalizeHover(result: unknown): NormalizedHover | null {
  if (!isPlainObject(result)) return null;
  if (!("contents" in result)) return null;
  const raw = result.contents;
  let contents: LSPMarkupContent[];
  if (Array.isArray(raw)) {
    contents = [];
    for (const entry of raw) {
      const normalized = normalizeMarkupEntry(entry);
      if (!normalized) return null;
      contents.push(normalized);
    }
  } else {
    const single = normalizeMarkupEntry(raw);
    if (!single) return null;
    contents = [single];
  }
  const hover: NormalizedHover = { contents };
  if (result.range !== undefined) {
    const range = asRange(result.range);
    if (!range) return null;
    hover.range = range;
  }
  return hover;
}

// ── CompletionItem[] | CompletionList ──────────────────────────────

/** label is the validated spec minimum; all other item fields pass through. */
export interface NormalizedCompletionItem {
  label: string;
  [key: string]: unknown;
}

export interface NormalizedCompletionList {
  isIncomplete: boolean;
  items: NormalizedCompletionItem[];
  itemDefaults?: unknown;
}

function asCompletionItem(item: unknown): NormalizedCompletionItem | null {
  if (!isPlainObject(item)) return null;
  if (typeof item.label !== "string" || item.label.length === 0) return null;
  return item as NormalizedCompletionItem;
}

/**
 * Normalizes `CompletionItem[] | CompletionList | null`.
 * The bare-array form carries no completeness flag (spec predates
 * isIncomplete) and normalizes to isIncomplete: false. Server null stays
 * null — an empty CompletionList would assert completeness the server never
 * stated.
 */
export function normalizeCompletions(result: unknown): NormalizedCompletionList | null {
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) {
    const items: NormalizedCompletionItem[] = [];
    for (const item of result) {
      const normalized = asCompletionItem(item);
      if (!normalized) return null;
      items.push(normalized);
    }
    return { isIncomplete: false, items };
  }
  if (!isPlainObject(result)) return null;
  if (!Array.isArray(result.items)) return null;
  if (typeof result.isIncomplete !== "boolean") return null;
  const items: NormalizedCompletionItem[] = [];
  for (const item of result.items) {
    const normalized = asCompletionItem(item);
    if (!normalized) return null;
    items.push(normalized);
  }
  const list: NormalizedCompletionList = { isIncomplete: result.isIncomplete, items };
  if (result.itemDefaults !== undefined) list.itemDefaults = result.itemDefaults;
  return list;
}

// ── WorkspaceEdit: changes | documentChanges ───────────────────────

export interface NormalizedTextEdit {
  range: LSPRange;
  newText: string;
}

export interface NormalizedWorkspaceFileEdit {
  uri: string;
  edits: NormalizedTextEdit[];
  /** From TextDocumentEdit.textDocument.version; absent for the changes form. */
  version?: number;
}

export interface NormalizedWorkspaceEdit {
  changes: NormalizedWorkspaceFileEdit[];
}

function normalizeTextEdit(raw: unknown): NormalizedTextEdit | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.newText !== "string") return null;
  const range = asRange(raw.range);
  if (!range) return null;
  return { range, newText: raw.newText };
}

/**
 * Normalize the TextEdit[] family returned by formatting methods.
 * Empty arrays are valid and mean "supported, no edits".
 */
export function normalizeTextEdits(raw: unknown): NormalizedTextEdit[] | null {
  if (!Array.isArray(raw)) return null;
  const out: NormalizedTextEdit[] = [];
  for (const entry of raw) {
    const edit = normalizeTextEdit(entry);
    if (!edit) return null;
    out.push(edit);
  }
  return out;
}

/** Null unless every entry parses; an empty list carries no actionable edit. */
function normalizeEditList(raw: unknown): NormalizedTextEdit[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: NormalizedTextEdit[] = [];
  for (const entry of raw) {
    const edit = normalizeTextEdit(entry);
    if (!edit) return null;
    out.push(edit);
  }
  return out;
}

function normalizeDocumentChange(raw: unknown): NormalizedWorkspaceFileEdit | null {
  if (!isPlainObject(raw)) return null;
  // Resource operations (CreateFile/RenameFile/DeleteFile) are rejected:
  // SmartEdit is the sole mutation authority for filesystem effects.
  if (typeof raw.kind === "string") return null;
  const textDocument = raw.textDocument;
  if (!isPlainObject(textDocument)) return null;
  if (typeof textDocument.uri !== "string" || textDocument.uri.length === 0) return null;
  if (!isValidFileUri(textDocument.uri)) return null;
  const edits = normalizeEditList(raw.edits);
  if (!edits) return null;
  const change: NormalizedWorkspaceFileEdit = { uri: textDocument.uri, edits };
  if (textDocument.version !== undefined && textDocument.version !== null) {
    if (!isUint(textDocument.version)) return null;
    change.version = textDocument.version;
  }
  return change;
}

function normalizeChangesMap(raw: unknown): NormalizedWorkspaceFileEdit[] | null {
  if (!isPlainObject(raw)) return null;
  const out: NormalizedWorkspaceFileEdit[] = [];
  for (const [uri, editsRaw] of Object.entries(raw)) {
    if (uri.length === 0) return null;
    if (!isValidFileUri(uri)) return null;
    const edits = normalizeEditList(editsRaw);
    if (!edits) return null;
    out.push({ uri, edits });
  }
  return out;
}

/**
 * Normalizes a WorkspaceEdit proposal (either `changes`, `documentChanges`,
 * or both — both present merges documentChanges first, matching the existing
 * convertWorkspaceEdit order). Returns null for malformed input, resource
 * operations, and valid-but-empty edits alike: all three mean "no actionable
 * proposal", the same contract callers get from convertWorkspaceEdit today.
 */
export function normalizeWorkspaceEdit(result: unknown): NormalizedWorkspaceEdit | null {
  if (!isPlainObject(result)) return null;
  const hasDocumentChanges = result.documentChanges !== undefined;
  const hasChanges = result.changes !== undefined;
  if (!hasDocumentChanges && !hasChanges) return null;
  const changes: NormalizedWorkspaceFileEdit[] = [];
  if (hasDocumentChanges) {
    if (!Array.isArray(result.documentChanges)) return null;
    for (const entry of result.documentChanges) {
      const normalized = normalizeDocumentChange(entry);
      if (!normalized) return null;
      changes.push(normalized);
    }
  }
  if (hasChanges) {
    const normalized = normalizeChangesMap(result.changes);
    if (!normalized) return null;
    changes.push(...normalized);
  }
  if (changes.length === 0) return null;
  return { changes };
}

// ── CodeAction | Command ───────────────────────────────────────────

export interface NormalizedCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

export interface NormalizedCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edit?: NormalizedWorkspaceEdit;
  command?: NormalizedCommand;
  disabled?: { reason: string };
  /** Opaque; required verbatim by codeAction/resolve round-trips. */
  data?: unknown;
}

function asCommand(raw: Record<string, unknown>): NormalizedCommand | null {
  if (typeof raw.title !== "string" || raw.title.length === 0) return null;
  if (typeof raw.command !== "string" || raw.command.length === 0) return null;
  const command: NormalizedCommand = { title: raw.title, command: raw.command };
  if (raw.arguments !== undefined) {
    if (!Array.isArray(raw.arguments)) return null;
    command.arguments = raw.arguments;
  }
  return command;
}

function normalizeCodeActionEntry(entry: unknown): NormalizedCodeAction | null {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.title !== "string" || entry.title.length === 0) return null;
  const action: NormalizedCodeAction = { title: entry.title };

  if (typeof entry.command === "string") {
    // Plain Command, or CodeAction with the deprecated string command form —
    // both normalize into the embedded-command shape (title mirrors the entry).
    if (entry.command.length === 0) return null;
    const command: NormalizedCommand = { title: entry.title, command: entry.command };
    if (entry.arguments !== undefined) {
      if (!Array.isArray(entry.arguments)) return null;
      command.arguments = entry.arguments;
    }
    action.command = command;
  } else if (entry.command !== undefined) {
    if (!isPlainObject(entry.command)) return null;
    const command = asCommand(entry.command);
    if (!command) return null;
    action.command = command;
  }

  if (entry.kind !== undefined) {
    if (typeof entry.kind !== "string") return null;
    action.kind = entry.kind;
  }
  if (entry.isPreferred !== undefined) {
    if (typeof entry.isPreferred !== "boolean") return null;
    action.isPreferred = entry.isPreferred;
  }
  if (entry.edit !== undefined) {
    const edit = normalizeWorkspaceEdit(entry.edit);
    if (!edit) return null;
    action.edit = edit;
  }
  if (entry.disabled !== undefined) {
    if (!isPlainObject(entry.disabled)) return null;
    if (typeof entry.disabled.reason !== "string") return null;
    action.disabled = { reason: entry.disabled.reason };
  }
  if ("data" in entry) action.data = entry.data;
  return action;
}

/**
 * Normalizes `(CodeAction | Command)[] | null` into one uniform list;
 * Commands and CodeActions both surface title/edit/command/kind. null and
 * undefined map to `[]`. A bare non-array object does not wrap — the protocol
 * only ever returns an array here.
 */
export function normalizeCodeActions(result: unknown): NormalizedCodeAction[] | null {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) return null;
  const out: NormalizedCodeAction[] = [];
  for (const entry of result) {
    const action = normalizeCodeActionEntry(entry);
    if (!action) return null;
    out.push(action);
  }
  return out;
}

// ── prepareRename variants ─────────────────────────────────────────

export interface NormalizedPrepareRename {
  range: LSPRange;
  placeholder?: string;
}

/**
 * Normalizes `Range | { range, placeholder? } | { range, defaultBehavior } |
 * null`. The bare-Range form wraps; defaultBehavior (and any other
 * non-carried extra) is dropped; a present non-string placeholder rejects.
 */
export function normalizePrepareRename(result: unknown): NormalizedPrepareRename | null {
  if (!isPlainObject(result)) return null;
  if (result.range !== undefined) {
    const range = asRange(result.range);
    if (!range) return null;
    const out: NormalizedPrepareRename = { range };
    if (result.placeholder !== undefined) {
      if (typeof result.placeholder !== "string") return null;
      out.placeholder = result.placeholder;
    }
    return out;
  }
  const range = asRange(result);
  if (!range) return null;
  return { range };
}

// ── Semantic tokens: full | range | delta ──────────────────────────

export interface NormalizedSemanticTokensEdit {
  start: number;
  deleteCount: number;
  data?: number[];
}

export type NormalizedSemanticTokens =
  | { kind: "full"; data: number[] }
  | { kind: "delta"; edits: NormalizedSemanticTokensEdit[] };

/**
 * Normalizes `SemanticTokens | SemanticTokensDelta | null`. The full and
 * range responses share { data } and both normalize to kind "full"; a delta
 * ({ edits }) normalizes to kind "delta". Both fields present at once is a
 * shape the spec never defines and is rejected.
 */
export function normalizeSemanticTokens(result: unknown): NormalizedSemanticTokens | null {
  if (!isPlainObject(result)) return null;
  if (result.edits !== undefined) {
    if (result.data !== undefined) return null;
    if (!Array.isArray(result.edits)) return null;
    const edits: NormalizedSemanticTokensEdit[] = [];
    for (const raw of result.edits) {
      if (!isPlainObject(raw)) return null;
      if (!isUint(raw.start) || !isUint(raw.deleteCount)) return null;
      const edit: NormalizedSemanticTokensEdit = { start: raw.start, deleteCount: raw.deleteCount };
      if (raw.data !== undefined) {
        const data = asUintArray(raw.data);
        if (!data) return null;
        edit.data = data;
      }
      edits.push(edit);
    }
    return { kind: "delta", edits };
  }
  if (result.data !== undefined) {
    const data = asUintArray(result.data);
    if (!data) return null;
    return { kind: "full", data };
  }
  return null;
}

// ── Hierarchy items (call and type hierarchy share the item shape) ─

function normalizeHierarchyItem(raw: unknown): LSPCallHierarchyItem | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;
  if (!isUint(raw.kind)) return null;
  if (typeof raw.uri !== "string" || raw.uri.length === 0) return null;
  if (!isValidFileUri(raw.uri)) return null;
  const range = asRange(raw.range);
  const selectionRange = asRange(raw.selectionRange);
  if (!range || !selectionRange) return null;
  const item: LSPCallHierarchyItem = {
    name: raw.name,
    kind: raw.kind,
    uri: raw.uri,
    range,
    selectionRange,
  };
  if (raw.detail !== undefined) {
    if (typeof raw.detail !== "string") return null;
    item.detail = raw.detail;
  }
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) return null;
    const tags: number[] = [];
    for (const tag of raw.tags) {
      if (!isUint(tag)) return null;
      tags.push(tag);
    }
    item.tags = tags;
  }
  // Opaque server state: preserved verbatim. Continuation requests
  // (incoming/outgoing/supertypes/subtypes) round-trip it back unchanged.
  if ("data" in raw) item.data = raw.data;
  return item;
}

/**
 * Normalizes prepare results for call and type hierarchy:
 * `HierarchyItem[] | null`. null/undefined and empty arrays map to `[]`.
 */
export function normalizeHierarchyItems(result: unknown): LSPCallHierarchyItem[] | null {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) return null;
  const out: LSPCallHierarchyItem[] = [];
  for (const raw of result) {
    const item = normalizeHierarchyItem(raw);
    if (!item) return null;
    out.push(item);
  }
  return out;
}

function normalizeRangeList(raw: unknown): LSPRange[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LSPRange[] = [];
  for (const entry of raw) {
    const range = asRange(entry);
    if (!range) return null;
    out.push(range);
  }
  return out;
}

/** Normalizes `CallHierarchyIncomingCall[] | null`; null/undefined → []. */
export function normalizeIncomingCalls(result: unknown): LSPCallHierarchyIncomingCall[] | null {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) return null;
  const out: LSPCallHierarchyIncomingCall[] = [];
  for (const raw of result) {
    if (!isPlainObject(raw)) return null;
    const from = normalizeHierarchyItem(raw.from);
    if (!from) return null;
    const fromRanges = normalizeRangeList(raw.fromRanges);
    if (!fromRanges) return null;
    out.push({ from, fromRanges });
  }
  return out;
}

/** Normalizes `CallHierarchyOutgoingCall[] | null`; null/undefined → []. */
export function normalizeOutgoingCalls(result: unknown): LSPCallHierarchyOutgoingCall[] | null {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) return null;
  const out: LSPCallHierarchyOutgoingCall[] = [];
  for (const raw of result) {
    if (!isPlainObject(raw)) return null;
    const to = normalizeHierarchyItem(raw.to);
    if (!to) return null;
    const fromRanges = normalizeRangeList(raw.fromRanges);
    if (!fromRanges) return null;
    out.push({ to, fromRanges });
  }
  return out;
}
