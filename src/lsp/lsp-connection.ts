/**
 * LSPConnection — minimal JSON-RPC LSP client over stdio.
 *
 * Split from lsp-bridge.ts (Phase B): connection lifecycle, document tracking,
 * semantic actions, plus the fail-closed WorkspaceEdit parser. No behavior change.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { detectLanguageFromExtension, type LSPDiagnostic, type LSPHoverResult, type LSPRange, type LSPWorkspaceSymbol } from "./lsp-types.js";

// ── JSON-RPC connection ────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** A single decoded JSON-RPC message frame from the language server. */
interface LspIncomingMessage {
  id?: number | string | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Fail-closed single-range validator: returns the range iff fully well-formed, else null. */
function validateLspRange(range: unknown): LSPRange | null {
  if (!range || typeof range !== "object") return null;
  const s = (range as Record<string, unknown>).start as Record<string, unknown> | undefined;
  const en = (range as Record<string, unknown>).end as Record<string, unknown> | undefined;
  if (!s || !en || !Number.isInteger(s.line as unknown as number) || (s.line as unknown as number) < 0 || !Number.isInteger(s.character as unknown as number) || (s.character as unknown as number) < 0 || !Number.isInteger(en.line as unknown as number) || (en.line as unknown as number) < 0 || !Number.isInteger(en.character as unknown as number) || (en.character as unknown as number) < 0 || (en.line as unknown as number) < (s.line as unknown as number) || ((en.line as unknown as number) === (s.line as unknown as number) && (en.character as unknown as number) < (s.character as unknown as number))) return null;
  return range as LSPRange;
}

/** Fail-closed single TextEdit parser: returns { range, newText } iff well-formed, else null. */
function parseLspEditEntry(er: unknown): { range: LSPRange; newText: string } | null {
  if (!er || typeof er !== "object") return null;
  const e = er as Record<string, unknown>;
  const newText = e.newText as string | undefined;
  if (typeof newText !== "string") return null;
  const range = validateLspRange(e.range);
  if (!range) return null;
  return { range, newText };
}

type ParsedFileEdits = Array<{ filePath: string; edits: Array<{ range: LSPRange; newText: string }> }>;

/** Fail-closed file URI → path: returns the path iff fileURLToPath succeeds, else null. */
function workspaceUriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
};

/** Fail-closed edit list: null unless every entry parses (one malformed entry rejects the whole list). */
function parseEditList(editsRaw: unknown): Array<{ range: LSPRange; newText: string }> | null {
  if (!Array.isArray(editsRaw) || editsRaw.length === 0) return null;
  const normEdits: Array<{ range: LSPRange; newText: string }> = [];
  for (const er of editsRaw as unknown[]) {
    const parsed = parseLspEditEntry(er);
    if (!parsed) return null;
    normEdits.push(parsed);
  }
  if (normEdits.length === 0) return null;
  return normEdits;
}

function parseDocumentChanges(documentChanges: unknown): ParsedFileEdits | null {
  if (!Array.isArray(documentChanges)) return null;
  const out: ParsedFileEdits = [];
  for (const dc of documentChanges as unknown[]) {
    if (!dc || typeof dc !== "object") return null;
    const entry = dc as Record<string, unknown>;
    // Reject resource operations (CreateFile/RenameFile/DeleteFile) — return null for whole edit
    if (typeof entry.kind === "string") return null;
    const td = entry.textDocument as Record<string, unknown> | undefined;
    const editsRaw = entry.edits as unknown[] | undefined;
    if (!td || typeof td.uri !== "string" || !Array.isArray(editsRaw) || editsRaw.length === 0) return null;
    const fp = workspaceUriToPath(td.uri as string);
    if (!fp) return null;
    const normEdits = parseEditList(editsRaw);
    if (!normEdits) return null;
    out.push({ filePath: fp, edits: normEdits });
  }
  return out;
}

function parseChangesMap(changes: unknown): ParsedFileEdits | null {
  if (!changes || typeof changes !== "object") return null;
  const out: ParsedFileEdits = [];
  for (const [uriKey, editsRaw] of Object.entries(changes as Record<string, unknown>)) {
    const fp = workspaceUriToPath(uriKey);
    if (!fp) return null;
    const normEdits = parseEditList(editsRaw);
    if (!normEdits) return null;
    out.push({ filePath: fp, edits: normEdits });
  }
  return out;
}

/** Duplicate filePath onto every edit entry (SmartEdit mutation RPC contract shape). */
function withDuplicatedFilePath(fileEdits: ParsedFileEdits): LspWorkspaceEdit {
  return { fileEdits: fileEdits.map((fe) => ({ filePath: fe.filePath, edits: fe.edits.map((ed) => ({ filePath: fe.filePath, range: ed.range, newText: ed.newText })) })) } as unknown as LspWorkspaceEdit;
}

function convertWorkspaceEdit(raw: unknown): LspWorkspaceEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const fileEdits: ParsedFileEdits = [];
  if ("documentChanges" in obj && obj.documentChanges !== undefined) {
    const parsed = parseDocumentChanges(obj.documentChanges);
    if (!parsed) return null;
    fileEdits.push(...parsed);
  }
  if (obj.changes && typeof obj.changes === "object") {
    const parsed = parseChangesMap(obj.changes);
    if (!parsed) return null;
    fileEdits.push(...parsed);
  }
  if (fileEdits.length === 0) return null;
  return withDuplicatedFilePath(fileEdits);
}

/** Fail-closed formatting edits: null unless every entry parses. */
function parseFormattingEdits(editsRaw: unknown): Array<{ range: LSPRange; newText: string }> | null {
  if (!Array.isArray(editsRaw) || editsRaw.length === 0) return null;
  const edits: Array<{ range: LSPRange; newText: string }> = [];
  for (const e of editsRaw as unknown[]) {
    const parsed = parseLspEditEntry(e);
    if (!parsed) return null;
    edits.push(parsed);
  }
  if (edits.length === 0) return null;
  return edits;
}

/**
 * PrepareRename variant 1: server returned a bare Range.
 * NOTE: deliberately looser than validateLspRange (numeric fields only, no
 * ordering/non-negativity checks) — do not tighten without approval.
 */
function asDirectPrepareRenameRange(r: Record<string, unknown>): LSPRange | null {
  if (!r.start || !r.end) return null;
  const start = r.start as Record<string, unknown>;
  const end = r.end as Record<string, unknown>;
  if (typeof start.line === "number" && typeof start.character === "number" && typeof end.line === "number" && typeof end.character === "number") {
    return r as unknown as LSPRange;
  }
  return null;
}

/**
 * PrepareRename variant 2: server returned { range, placeholder? }.
 * NOTE: deliberately looser than validateLspRange — do not tighten without approval.
 */
function asWrappedPrepareRenameRange(r: Record<string, unknown>): { range: LSPRange; placeholder?: string } | null {
  if (!r.range || typeof r.range !== "object") return null;
  const range = r.range as LSPRange;
  const placeholder = typeof r.placeholder === "string" ? (r.placeholder as string) : undefined;
  if (range.start && range.end) return { range, placeholder };
  return null;
}

/**
 * Exported for unit testing only (constructing a connection against a mocked
 * child process). Not part of the public LSPBridge surface — external
 * callers should go through getLSPBridge().
 */
export class LSPConnection {
  /** Cap on accumulated stdout buffer size before we force-close the connection. */
  private static readonly BUFFER_LIMIT_BYTES = 50 * 1024 * 1024; // 50MB

  private proc: ReturnType<typeof spawn> | null = null;
  private reqId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private closed = false;

  /** Track which files are open on this connection */
  private openDocuments = new Map<string, number>(); // filePath → version
  private diagnostics = new Map<string, LSPDiagnostic[]>();

  /** Registered handlers for server-initiated notifications, keyed by method */
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();

  /** The language IDs this server handles */
  languageIds: string[] = [];

  private serverCapabilities: Record<string, unknown> | null = null;

  private documentRefreshQueue = new Map<string, Promise<void>>();

  async prepareDocument(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    const prior = this.documentRefreshQueue.get(resolved) ?? Promise.resolve();
    const next = prior.then(async () => {
      if (this.isOpen(resolved)) {
        await this.didClose(resolved);
      }
      await this.openFile(resolved);
    });
    this.documentRefreshQueue.set(resolved, next.catch(() => {}));
    return next;
  }

  getServerCapabilities(): Record<string, unknown> | null { return this.serverCapabilities; }

  async start(command: string, args: string[], rootUri: string): Promise<void> {
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout?.on("data", (chunk: Buffer) => this._onData(chunk));
    this.proc.on("exit", () => { this.closed = true; this._rejectAll(new Error("LSP server exited")); });
    this.proc.on("error", () => { this.closed = true; });

    const initResult = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(resolve(rootUri)).href,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          implementation: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
          callHierarchy: { dynamicRegistration: false },
          rename: { dynamicRegistration: false, prepareSupport: true, honorsChangeAnnotations: false },
          codeAction: { dynamicRegistration: false, codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source.organizeImports", "source.fixAll"] } }, isPreferredSupport: true },
          formatting: { dynamicRegistration: false },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
          workspaceEdit: { documentChanges: true, resourceOperations: [] },
        },
      },
    });
    if (!initResult) throw new Error("LSP initialize failed");
    try {
      const caps = (initResult as Record<string, unknown>)?.capabilities;
      this.serverCapabilities = caps && typeof caps === "object" ? (caps as Record<string, unknown>) : {} as Record<string, unknown>;
    } catch {
      this.serverCapabilities = {} as Record<string, unknown>;
    }
    await this.notify("initialized", {});
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return null;
    const id = this.reqId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`LSP request ${method} timed out`)), REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc?.stdin?.write(header + body);
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    this.proc?.stdin?.write(header + body);
  }

  /**
   * Open a file with the LSP server. Idempotent — if the file is already open,
   * sends didClose + didOpen to refresh its content.
   */
  async openFile(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    if (this.openDocuments.has(resolved)) return;
    const uri = pathToFileURL(resolved).href;
    const text = existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";
    const version = (this.openDocuments.get(resolved) ?? 0) + 1;
    this.openDocuments.set(resolved, version);
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: detectLanguageFromExtension(resolved) ?? "plaintext", version, text },
    });
  }

  /**
   * Send full-text didChange for an open file. If the file is not open yet,
   * sends didOpen with the given content instead (a didChange is only valid
   * once the server has seen a matching didOpen).
   */
  async didChange(filePath: string, text: string): Promise<void> {
    const resolved = resolve(filePath);
    const uri = pathToFileURL(resolved).href;
    // Drop any diagnostics published for the previous document state so a
    // post-edit poll cannot observe stale results from before this update.
    this.diagnostics.delete(resolved);
    if (!this.openDocuments.has(resolved)) {
      const version = 1;
      this.openDocuments.set(resolved, version);
      await this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: detectLanguageFromExtension(resolved) ?? "plaintext", version, text },
      });
      return;
    }
    const currentVersion = this.openDocuments.get(resolved) ?? 0;
    const version = currentVersion + 1;
    this.openDocuments.set(resolved, version);
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /**
   * Close a file on the LSP server.
   */
  async didClose(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    if (!this.openDocuments.has(resolved)) return;
    const uri = pathToFileURL(resolved).href;
    this.openDocuments.delete(resolved);
    await this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  /**
   * Notify the LSP server that an open file was saved. No-op if the file is
   * not currently tracked as open on this connection.
   */
  async didSave(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    if (!this.openDocuments.has(resolved)) return;
    const uri = pathToFileURL(resolved).href;
    await this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  /**
   * Subscribe to server-initiated notifications for a given method (e.g.
   * "window/logMessage"). Multiple handlers may be registered for the same
   * method. Returns an unsubscribe function that removes only this handler.
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = [];
      this.notificationHandlers.set(method, handlers);
    }
    handlers.push(handler);
    return () => {
      const list = this.notificationHandlers.get(method);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  /** Check if a file is currently open on this connection */
  isOpen(filePath: string): boolean {
    return this.openDocuments.has(resolve(filePath));
  }

  /** Get all open file paths on this connection */
  getOpenFilePaths(): string[] {
    return [...this.openDocuments.keys()];
  }

  /** Get latest cached publishDiagnostics results for a document */
  getDiagnostics(filePath: string): LSPDiagnostic[] { return this.diagnostics.get(resolve(filePath)) ?? []; }

  /** Clear cached publishDiagnostics for a document (used before fresh poll to avoid stale confirmed). */
  clearDiagnostics(filePath: string): void { this.diagnostics.delete(resolve(filePath)); }

  /** Whether a publishDiagnostics receipt exists for file (distinguishes confirmed-empty from unconfirmed). */
  hasDiagnostics(filePath: string): boolean { return this.diagnostics.has(resolve(filePath)); }

  /** Get open document count */
  get openDocumentCount(): number {
    return this.openDocuments.size;
  }

  async rename(filePath: string, line0: number, character0: number, newName: string): Promise<LspWorkspaceEdit | null> {
    if (!this.serverCapabilities?.renameProvider) return null;
    await this.prepareDocument(filePath);
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/rename", { textDocument: { uri }, position: { line: line0, character: character0 }, newName });
    } catch {
      return null;
    }
    // Delegate to the shared fail-closed parser (convertWorkspaceEdit) instead of
    // duplicating LSP WorkspaceEdit parsing here — a prior duplicate parser silently
    // fell through to `changes` when `documentChanges` was present but malformed,
    // bypassing the fail-closed contract enforced by convertWorkspaceEdit.
    return convertWorkspaceEdit(result);
  }

  async prepareRename(filePath: string, line0: number, character0: number): Promise<{ range: LSPRange; placeholder?: string } | null> {
    if (!this.serverCapabilities?.renameProvider) return null;
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/prepareRename", { textDocument: { uri }, position: { line: line0, character: character0 } });
    } catch {
      return null;
    }
    if (!result || typeof result !== "object") return null;
    // Server may return Range directly or { range, placeholder, defaultBehavior } etc
    const r = result as Record<string, unknown>;
    // Some servers return a Range directly
    const direct = asDirectPrepareRenameRange(r);
    if (direct) return { range: direct };
    // Others return { range, placeholder? }
    return asWrappedPrepareRenameRange(r);
  }

  async organizeImports(filePath: string): Promise<LspWorkspaceEdit | null> {
    if (!this.serverCapabilities?.codeActionProvider) return null;
    await this.prepareDocument(filePath);
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/codeAction", {
        textDocument: { uri },
        range: { start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER, character: 0 } },
        context: { only: ["source.organizeImports"] },
      });
    } catch {
      return null;
    }
    if (!Array.isArray(result)) return null;
    const actions = result as Array<Record<string, unknown>>;
    let editRaw: unknown = null;
    for (const a of actions) {
      if (a && typeof a === "object" && "edit" in a && (a as Record<string, unknown>).edit) {
        editRaw = (a as Record<string, unknown>).edit;
        break;
      }
    }
    if (!editRaw) return null;
    return convertWorkspaceEdit(editRaw);
  }

  async formatting(filePath: string, tabSize?: number, insertSpaces?: boolean): Promise<LspWorkspaceEdit | null> {
    if (!this.serverCapabilities?.documentFormattingProvider) return null;
    await this.prepareDocument(filePath);
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: tabSize ?? 2, insertSpaces: insertSpaces ?? true },
      });
    } catch {
      return null;
    }
    const edits = parseFormattingEdits(result);
    if (!edits) return null;
    return withDuplicatedFilePath([{ filePath: resolve(filePath), edits }]);
  }

  async codeActions(
    filePath: string,
    range: LSPRange,
    context: { diagnostics?: unknown[]; only?: string[] },
  ): Promise<Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }>> {
    if (!this.serverCapabilities?.codeActionProvider) return [];
    await this.prepareDocument(filePath);
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/codeAction", {
        textDocument: { uri },
        range,
        context,
      });
    } catch {
      return [];
    }
    if (!Array.isArray(result) || result === null) return [];
    const actions = result as Array<Record<string, unknown>>;
    return actions.map((a) => {
      const title = typeof a.title === "string" ? (a.title as string) : "";
      const kind = typeof a.kind === "string" ? (a.kind as string) : undefined;
      const isPreferred = typeof a.isPreferred === "boolean" ? (a.isPreferred as boolean) : undefined;
      let edit: LspWorkspaceEdit | undefined;
      if (a.edit) {
        const converted = convertWorkspaceEdit(a.edit);
        if (converted) edit = converted;
      }
      return { title, kind, edit, isPreferred };
    });
  }

  /**
   * Query workspace/symbol on this server.
   */
  async workspaceSymbol(query: string): Promise<LSPWorkspaceSymbol[]> {
    const result = await this.request("workspace/symbol", { query });
    return (result as LSPWorkspaceSymbol[]) ?? [];
  }

  /**
   * Query textDocument/hover at a position.
   */
  async hover(filePath: string, line: number, character: number): Promise<LSPHoverResult | null> {
    const resolved = resolve(filePath);
    const uri = pathToFileURL(resolved).href;
    const result = await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
    return (result as LSPHoverResult) ?? null;
  }

  shutdown(): void {
    this.closed = true;
    this.request("shutdown", {})
       .catch(() => {})
       .finally(() => this.notify("exit", {}).catch(() => {}));
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("LSP shutdown"));
    }
    this.pending.clear();
    this.openDocuments.clear();
    setTimeout(() => this.proc?.kill(), 1000);
  }

  private _onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.checkFrameBufferOverflow()) return;
    this.drainLspFrames();
  }

  /** True when the frame buffer exceeded the cap; closes the connection and rejects all pending. */
  private checkFrameBufferOverflow(): boolean {
    if (this.buffer.length <= LSPConnection.BUFFER_LIMIT_BYTES) return false;
    console.error(
      `[lsp-bridge] LSP connection stdout buffer exceeded ${LSPConnection.BUFFER_LIMIT_BYTES} bytes ` +
      `without a complete message; forcibly closing the connection to prevent unbounded memory growth.`,
    );
    this.buffer = Buffer.alloc(0);
    this.closed = true;
    this._rejectAll(new Error("LSP connection buffer overflow"));
    try { this.proc?.kill(); } catch { /* best effort */ }
    return true;
  }

  /** Extract the next complete frame body, or null when headers are incomplete/invalid or the body is partial. */
  private extractNextFrameBody(): Buffer | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headerText = this.buffer.subarray(0, headerEnd).toString("utf-8");
    const match = /^Content-Length: (\d+)/.exec(headerText);
    if (!match) return null;
    const contentLength = parseInt(match[1]!, 10);
    const bodyStart = headerEnd + 4;
    if (this.buffer.length < bodyStart + contentLength) return null;
    const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
    this.buffer = this.buffer.subarray(bodyStart + contentLength);
    return body;
  }

  /** Drain all complete frames currently buffered; malformed JSON frames are skipped. */
  private drainLspFrames(): void {
    while (true) {
      const body = this.extractNextFrameBody();
      if (!body) break;
      try {
        this.handleLspMessage(JSON.parse(body.toString("utf-8")) as LspIncomingMessage);
      } catch { /* ignore malformed messages */ }
    }
  }

  private handleLspMessage(msg: LspIncomingMessage): void {
    this.handleDiagnosticsNotification(msg);
    if (msg.id !== undefined && msg.id !== null) {
      this.settlePendingRequest(msg);
    } else if (typeof msg.method === "string") {
      this.dispatchNotification(msg);
    }
  }

  private handleDiagnosticsNotification(msg: LspIncomingMessage): void {
    if (msg.method !== "textDocument/publishDiagnostics") return;
    const params = msg.params as { uri?: unknown; diagnostics?: unknown } | undefined;
    const uri = params?.uri;
    if (typeof uri === "string" && uri.startsWith("file:")) {
      try {
        this.diagnostics.set(resolve(fileURLToPath(uri)), (params?.diagnostics ?? []) as LSPDiagnostic[]);
      } catch {
        // Ignore malformed file URIs without updating the map.
      }
    }
  }

  private settlePendingRequest(msg: LspIncomingMessage): void {
    const pending = this.pending.get(msg.id as number);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id as number);
    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result);
  }

  private dispatchNotification(msg: LspIncomingMessage): void {
    // Server-initiated notification (no id) — dispatch to registered handlers.
    const handlers = this.notificationHandlers.get(msg.method as string);
    if (handlers && handlers.length > 0) {
      for (const handler of [...handlers]) {
        try { handler(msg.params); } catch { /* isolate handler errors from the read loop */ }
      }
    }
  }

  private _rejectAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}
