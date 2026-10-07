/**
 * LSPConnection — minimal JSON-RPC LSP client over stdio.
 *
 * Split from lsp-bridge.ts (Phase B): connection lifecycle, document tracking,
 * semantic actions, plus the fail-closed WorkspaceEdit parser. No behavior change.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { type LSPDiagnostic, type LSPHoverResult, type LSPRange, type LSPWorkspaceSymbol } from "./lsp-types.js";
import { SERVER_REQUEST_HANDLERS, type ServerRequestContext } from "./lsp-server-request-handlers.js";
import { LspCapabilityRegistry } from "./lsp-capability-registry.js";
import { LspDocumentStore, syncConfigFromCapability } from "./lsp-document-store.js";
import { LspDiagnosticsBroker } from "./lsp-diagnostics-broker.js";
import { LspReadinessTracker, type Readiness } from "./lsp-readiness-tracker.js";
import { convertOffset, positionEncodingsAdvertisement, resolveNegotiatedEncoding, type PositionEncoding } from "./lsp-position-codec.js";

// ── JSON-RPC connection ────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Method that created this request — carried for cancel/timeout error text. */
  method: string;
  signal?: AbortSignal;
  onAbort?: () => void;
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

/** Cap on cancelled-request ids retained to absorb late server responses. */
export const CANCELLED_TOMBSTONE_LIMIT = 256;

/** Cap on unsolicited workspace/applyEdit proposals retained in memory (FIFO, evict-oldest). */
export const APPLY_EDIT_PROPOSAL_LIMIT = 256;

/** Byte cap on retained applyEdit proposals (JSON size). Oldest evicted first; count cap still applies. */
export const APPLY_EDIT_PROPOSAL_BYTES = 1024 * 1024; // 1MB

/** Request exceeded REQUEST_TIMEOUT_MS; the pending entry is removed before this rejects. */
export class LspRequestTimeoutError extends Error {
  constructor(method: string) {
    super(`LSP request ${method} timed out`);
    this.name = "LspRequestTimeoutError";
  }
}

/** Server process exited with requests in flight; every pending entry is rejected and cleared. */
export class LspServerExitError extends Error {
  constructor() {
    super("LSP server exited");
    this.name = "LspServerExitError";
  }
}

/** Request settled via AbortSignal. name stays "AbortError" so existing consumer checks match. */
export class LspRequestCancelledError extends Error {
  constructor(method: string) {
    super(`LSP request ${method} cancelled`);
    this.name = "AbortError";
  }
}
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

/** True only when renameProvider advertises prepare support (object with truthy prepareProvider). */
function hasRenamePrepareSupport(caps: Record<string, unknown> | null): boolean {
  const rp = caps?.renameProvider;
  return !!rp && typeof rp === "object" && !!(rp as Record<string, unknown>).prepareProvider;
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
  /** Bounded FIFO of cancelled request ids; late responses to these ids are absorbed, never settled. */
  private cancelledTombstones = new Set<number>();
  private buffer = Buffer.alloc(0);
  private closed = false;

  /** Track which files are open on this connection */
  private openDocuments = new Map<string, number>(); // filePath → version
  private diagnostics = new Map<string, LSPDiagnostic[]>();

  /** Registered handlers for server-initiated notifications, keyed by method */
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();

  /** Exact session provenance populated by LSPManager. */
  descriptorId?: string;
  name?: string;
  projectRoot?: string;

  /** The language IDs this server handles */
  languageIds: string[] = [];

  /** Session fingerprint settings served to server workspace/configuration requests. */
  sessionSettings: unknown = undefined;

  /** Live capability registry: static initialize result plus dynamic register/unregister. */
  private capabilityRegistry: LspCapabilityRegistry | null = null;

  /** Live registry (null before initialize completes). */
  getCapabilityRegistry(): LspCapabilityRegistry | null { return this.capabilityRegistry; }

  private serverCapabilities: Record<string, unknown> | null = null;

  /** Centralized per-document sync state — callers ask prepare-document, store decides wire. */
  private readonly documentStore = new LspDocumentStore();
  /** Push/pull diagnostics with receipts and resultIds. */
  private readonly diagnosticsBroker = new LspDiagnosticsBroker({
    request: (method, params) => this.request(method, params),
    getCapabilityRegistry: () => this.capabilityRegistry,
    getServerCapabilities: () => this.serverCapabilities,
    supportsPull: () => this.isPullSupported(),
    supportsWorkspacePull: () => this.isWorkspacePullSupported(),
  });
  /** $/progress + work-done token readiness (per-token, never a universal gate). */
  private readonly readinessTracker = new LspReadinessTracker();
  /** Negotiated position encoding (defaults to utf-16). */
  private negotiatedEncoding: PositionEncoding = "utf-16";
  /** Advertised sync config from initialize (defaults to open/close + full). */
  private advertisedSyncConfig: { openClose: boolean; change: "none" | "full" | "incremental" } = {
    openClose: true,
    change: "full",
  };

  getDocumentStore(): LspDocumentStore { return this.documentStore; }
  getDiagnosticsBroker(): LspDiagnosticsBroker { return this.diagnosticsBroker; }
  getReadinessTracker(): LspReadinessTracker { return this.readinessTracker; }
  getNegotiatedEncoding(): PositionEncoding { return this.negotiatedEncoding; }
  readiness(token?: string): Readiness { return this.readinessTracker.readiness(token); }

  /** Convert a position character between encodings via line source (round-trips all three). */
  convertPosition(lineText: string, character: number, from: PositionEncoding, to: PositionEncoding): number {
    return convertOffset(lineText, character, from, to);
  }

  /** Typed-op gate: false when registry (or static caps) lacks feature — unsupported, not empty. */
  isSupported(feature: Parameters<LspCapabilityRegistry["can"]>[0], staticKey: string): boolean {
    const v = this.serverCapabilities?.[staticKey];
    const staticPresent = v !== undefined && v !== null && v !== false;
    if (this.capabilityRegistry) return this.capabilityRegistry.can(feature) || staticPresent;
    return staticPresent;
  }

  private isPullSupported(): boolean {
    const caps = this.serverCapabilities;
    if (!caps) return false;
    const dp = (caps as Record<string, unknown>).diagnosticProvider;
    if (dp === true) return true;
    if (dp && typeof dp === "object") return true;
    return false;
  }

  private isWorkspacePullSupported(): boolean {
    const caps = this.serverCapabilities;
    if (!caps) return false;
    const dp = (caps as Record<string, unknown>).diagnosticProvider as Record<string, unknown> | undefined;
    return !!dp && typeof dp === "object" && (dp as Record<string, unknown>).workspaceDiagnostics === true;
  }

  /** Workspace root path passed to start(); drives workspace/workspaceFolders replies. */
  private rootPath: string | null = null;

  /** Unsolicited workspace/applyEdit proposals retained in memory only — never written to disk. */
  private applyEditProposals: unknown[] = [];
  /** Running JSON-size total of retained proposals, bounded by APPLY_EDIT_PROPOSAL_BYTES. */
  private applyEditProposalBytes = 0;

  private proposalSizeOf(proposal: unknown): number {
    try {
      return Buffer.byteLength(JSON.stringify(proposal) ?? "", "utf-8");
    } catch {
      return 0;
    }
  }

  /** Retain one proposal; evict oldest while over count cap OR byte cap. */
  private retainApplyEditProposal(proposal: unknown): void {
    this.applyEditProposals.push(proposal);
    this.applyEditProposalBytes += this.proposalSizeOf(proposal);
    while (
      this.applyEditProposals.length > APPLY_EDIT_PROPOSAL_LIMIT ||
      (this.applyEditProposals.length > 0 && this.applyEditProposalBytes > APPLY_EDIT_PROPOSAL_BYTES)
    ) {
      const oldest = this.applyEditProposals.shift();
      this.applyEditProposalBytes -= this.proposalSizeOf(oldest);
      if (this.applyEditProposalBytes < 0) this.applyEditProposalBytes = 0;
    }
  }

  /** Current retained-proposal byte total (for tests/observability). */
  getRetainedApplyEditBytes(): number { return this.applyEditProposalBytes; }

  getServerCapabilities(): Record<string, unknown> | null { return this.serverCapabilities; }

  async start(command: string, args: string[], rootUri: string, opts?: { env?: Record<string, string> }): Promise<void> {
    this.lifecycle = "initializing";
    this.initPromise = new Promise<void>((resolve, reject) => { this.initResolve = resolve; this.initReject = reject; });
    // Prevent unhandled rejection for queued waiters that detach via abort before init settles.
    this.initPromise.catch(() => {});
    this.rootPath = resolve(rootUri);
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}) });
    this.proc.stdout?.on("data", (chunk: Buffer) => this._onData(chunk));
    this.proc.on("exit", () => { this.closed = true; if (this.lifecycle === "initializing") { this.lifecycle = "failed"; this.initReject?.(new LspServerExitError()); } this._rejectAll(new LspServerExitError()); });
    this.proc.on("error", () => {
      this.closed = true;
      if (this.lifecycle === "initializing") { this.lifecycle = "failed"; this.initReject?.(new LspServerExitError()); }
      this._rejectAll(new LspServerExitError());
    });

    let initResult: unknown;
    try {
      initResult = await this.requestNow("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(resolve(rootUri)).href,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
          documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
          implementation: { dynamicRegistration: true },
          hover: { dynamicRegistration: true },
          callHierarchy: { dynamicRegistration: true },
          rename: { dynamicRegistration: true, prepareSupport: true, honorsChangeAnnotations: false },
          codeAction: { dynamicRegistration: true, codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source.organizeImports", "source.fixAll"] } }, isPreferredSupport: true },
          formatting: { dynamicRegistration: true },
          declaration: { dynamicRegistration: true },
          typeDefinition: { dynamicRegistration: true },
          diagnostic: { dynamicRegistration: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        workspace: {
          symbol: { dynamicRegistration: true },
          workspaceFolders: true,
          configuration: true,
          workspaceEdit: { documentChanges: true, resourceOperations: [] },
        },
        window: {
          workDoneProgress: true,
        },
        ...(positionEncodingsAdvertisement() ?? {}),
      },
    });
    } catch (err) {
      this.lifecycle = "failed";
      this.initReject?.(err);
      throw err;
    }
    if (!initResult) {
      const err = new Error("LSP initialize failed");
      this.lifecycle = "failed";
      this.initReject?.(err);
      throw err;
    }
    try {
      const caps = (initResult as Record<string, unknown>)?.capabilities;
      this.serverCapabilities = caps && typeof caps === "object" ? (caps as Record<string, unknown>) : {} as Record<string, unknown>;
      this.capabilityRegistry = LspCapabilityRegistry.fromInitializeResult(initResult);
      this.negotiatedEncoding = resolveNegotiatedEncoding(initResult);
      this.advertisedSyncConfig = syncConfigFromCapability(this.serverCapabilities);
    } catch {
      this.serverCapabilities = {} as Record<string, unknown>;
    }
    this.lifecycle = "ready";
    this.initResolve?.();
    await this.notifyNow("initialized", {});
  }

  async request(method: string, params: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> {
    if (this.closed || (this.shutdownStarted && method !== "shutdown")) throw new LspServerExitError();
    const signal = opts?.signal;
    if (signal?.aborted) throw new LspRequestCancelledError(method);
    // Handshake barrier: queue behind initialize; no id alloc, no timer, no wire frame while queued.
    // Server-originated traffic never passes through here, so workspace/configuration stays live during init.
    if (this.lifecycle === "initializing") await this.awaitInitBarrier(signal, method);
    if (this.closed || (this.shutdownStarted && method !== "shutdown")) throw new LspServerExitError();
    if (signal?.aborted) throw new LspRequestCancelledError(method);
    return this.requestNow(method, params, opts);
  }

  /** Ungated request path: no init barrier. Used only for initialize (and shutdown internals). */
  private async requestNow(method: string, params: unknown, opts?: { signal?: AbortSignal }): Promise<unknown> {
    if (this.closed || (this.shutdownStarted && method !== "shutdown")) throw new LspServerExitError();
    const signal = opts?.signal;
    if (signal?.aborted) throw new LspRequestCancelledError(method);
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, method };
      pending.timer = setTimeout(() => {
        // Timeout removes the entry: a late response then finds nothing to settle.
        this.clearPending(id, pending);
        reject(new LspRequestTimeoutError(method));
      }, REQUEST_TIMEOUT_MS);
      if (signal) {
        const onAbort = () => this.cancelPendingRequest(id);
        pending.signal = signal;
        pending.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pending.set(id, pending);
      try {
        this.sendFrame({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.clearPending(id, pending);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    // Gate pre-ready client notifies (didOpen etc.) behind init; initialized/exit always pass through.
    if (this.lifecycle === "initializing" && method !== "initialized" && method !== "exit") {
      try {
        await this.awaitInitBarrier(undefined, method);
      } catch {
        return;
      }
    }
    this.sendFrame({ jsonrpc: "2.0", method, params });
  }

  /** Ungated notify path: no init barrier. Used only for initialized during start(). */
  private async notifyNow(method: string, params: unknown): Promise<void> {
    this.sendFrame({ jsonrpc: "2.0", method, params });
  }

  /** Write one JSON-RPC frame to server stdin. No-op once the connection is closed. */
  private sendFrame(frame: unknown): boolean {
    if (this.closed) return false;
    const body = JSON.stringify(frame);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    this.proc?.stdin?.write(header + body);
    return true;
  }

  /** Remove a pending entry: timer cleared, abort listener detached, map slot freed. */
  private clearPending(id: number, pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
    this.pending.delete(id);
  }

  /** AbortSignal/cancel path: settle cancelled, send $/cancelRequest, tombstone the id for late responses. */
  private cancelPendingRequest(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.clearPending(id, pending);
    while (this.cancelledTombstones.size >= CANCELLED_TOMBSTONE_LIMIT) {
      const oldest = this.cancelledTombstones.values().next().value;
      if (oldest === undefined) break;
      this.cancelledTombstones.delete(oldest);
    }
    this.cancelledTombstones.add(id);
    void this.notify("$/cancelRequest", { id });
    pending.reject(new LspRequestCancelledError(pending.method));
  }

  /** Unsolicited workspace/applyEdit proposals retained in memory only (zero disk writes). */
  getRetainedApplyEditProposals(): readonly unknown[] {
    return this.applyEditProposals;
  }

  /** Convert an incremental range from UTF-16 (store-native) to negotiated encoding via line source. */
  private toNegotiatedRange(
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
    content: string,
  ): { start: { line: number; character: number }; end: { line: number; character: number } } {
    if (this.negotiatedEncoding === "utf-16") return range;
    const lines = content.split("\n");
    const conv = (line: number, character: number): { line: number; character: number } => {
      const text = lines[line] ?? "";
      return { line, character: convertOffset(text, character, "utf-16", this.negotiatedEncoding) };
    };
    return { start: conv(range.start.line, range.start.character), end: conv(range.end.line, range.end.character) };
  }

  /**
   * Open a file with the LSP server. Idempotent — if the file is already open,
   * refreshes via prepareDocument (store decides wire action).
   */
  /**
   * Prepare-document entry: store decides wire action (didOpen / didChange / none).
   * Real incremental/full sync per advertised capability — never blanket close+reopen.
   * The chosen action is observable via getDocumentStore() state and wire messages.
   */
  async prepareDocument(filePath: string, text?: string): Promise<void> {
    const resolved = resolve(filePath);
    const content = text ?? (existsSync(resolved) ? readFileSync(resolved, "utf-8") : "");
    return this.documentStore.serialize(resolved, async () => {
      const syncConfig = this.advertisedSyncConfig;
      const decision = this.documentStore.prepare(resolved, content, {
        syncMode: syncConfig.change,
        openClose: syncConfig.openClose,
      } as Parameters<LspDocumentStore["prepare"]>[2]);
      if (decision.action === "none") {
        const changed: boolean = decision.changed;
        if (changed) {
          this.diagnostics.delete(resolved);
          this.diagnosticsBroker.invalidate(resolved);
        }
        return;
      }
      if (decision.action === "didOpen") {
        this.openDocuments.set(resolved, decision.version);
        await this.notify("textDocument/didOpen", {
          textDocument: { uri: decision.uri, languageId: decision.languageId, version: decision.version, text: decision.text },
        });
        this.documentStore.markSynced(resolved);
        return;
      }
      if (decision.action === "didChange-incremental") {
        this.openDocuments.set(resolved, decision.version);
        this.diagnostics.delete(resolved);
        this.diagnosticsBroker.invalidate(resolved);
        await this.notify("textDocument/didChange", {
          textDocument: { uri: decision.uri, version: decision.version },
          contentChanges: [{ range: this.toNegotiatedRange(decision.range, decision.baseText), rangeLength: decision.rangeLength, text: decision.text }],
        });
        this.documentStore.markSynced(resolved);
        return;
      }
      this.openDocuments.set(resolved, decision.version);
      this.diagnostics.delete(resolved);
      this.diagnosticsBroker.invalidate(resolved);
      await this.notify("textDocument/didChange", {
        textDocument: { uri: decision.uri, version: decision.version },
        contentChanges: [{ text: decision.text }],
      });
      this.documentStore.markSynced(resolved);
    });
  }

  async openFile(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    if (this.openDocuments.has(resolved)) return;
    const text = existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";
    await this.prepareDocument(resolved, text);
  }

  /**
   * Send full-text didChange for an open file. If the file is not open yet,
   * sends didOpen with the given content instead (a didChange is only valid
   * once the server has seen a matching didOpen).
   */
  async didChange(filePath: string, text: string): Promise<void> {
    // Real incremental/full sync per advertised capability via DocumentStore.
    // Never blanket close+reopen: didChange is only valid after didOpen.
    await this.prepareDocument(resolve(filePath), text);
  }

  /**
   * Close a file on the LSP server.
   */
  async didClose(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    await this.documentStore.serialize(resolved, async () => {
      if (!this.openDocuments.has(resolved)) return;
      const closed = this.documentStore.markClosed(resolved);
      const uri = closed?.uri ?? pathToFileURL(resolved).href;
      this.openDocuments.delete(resolved);
      this.diagnosticsBroker.invalidate(resolved);
      await this.notify("textDocument/didClose", { textDocument: { uri } });
    });
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
  /** Forward $/progress to the readiness tracker. Subscriber fan-out lives in dispatchNotification. */
  private fanOutNotification(method: string, params: unknown): void {
    if (method === "$/progress") this.readinessTracker.onProgress(params);
  }

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
    // Unsupported (no capability) returns null — distinct from an empty-but-supported edit.
    if (!this.isSupported("rename", "renameProvider")) return null;
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
    if (!hasRenamePrepareSupport(this.serverCapabilities)) return null;
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

  /** Connection handshake lifecycle: created -> initializing -> ready, failed, shutting-down -> closed. */
  private lifecycle: "created" | "initializing" | "ready" | "failed" | "shutting-down" | "closed" = "created";
  private initPromise: Promise<void> | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((err: unknown) => void) | null = null;

  /** Current handshake lifecycle state (for tests/observability). */
  getLifecycleState(): "created" | "initializing" | "ready" | "failed" | "shutting-down" | "closed" { return this.lifecycle; }

  /** Wait on the initialize barrier. Rejects if init failed; throws cancelled if signal aborts while queued. */
  private async awaitInitBarrier(signal?: AbortSignal, method?: string): Promise<void> {
    const gate = this.initPromise;
    if (!gate) return;
    if (signal?.aborted) throw new LspRequestCancelledError(method ?? "request");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new LspRequestCancelledError(method ?? "request"));
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      gate.then(
        () => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); },
        (err) => { if (signal) signal.removeEventListener("abort", onAbort); reject(err instanceof Error ? err : new Error(String(err))); },
      );
    });
  }

  /** Guard so a second shutdown() while the first is settling does not send a duplicate. */
  private shutdownStarted = false;

  /** Best-effort wait for the server's shutdown response before exit; never blocks callers. */
  private static readonly SHUTDOWN_SETTLE_MS = 2000;

  shutdown(): void {
    if (this.closed || this.shutdownStarted) return;
    this.shutdownStarted = true;
    if (this.lifecycle === "ready" || this.lifecycle === "initializing" || this.lifecycle === "created" || this.lifecycle === "failed") this.lifecycle = "shutting-down";
    const req = this.requestNow("shutdown", {});
    const settle = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, LSPConnection.SHUTDOWN_SETTLE_MS);
      if (typeof (t as unknown as { unref?: unknown }).unref === "function") {
        (t as unknown as { unref: () => void }).unref();
      }
    });
    void Promise.race([req.then(() => undefined, () => undefined), settle]).finally(() => {
      void this.notifyNow("exit", {}).catch(() => {});
      this.closed = true;
      this.lifecycle = "closed";
      for (const [id, pending] of [...this.pending]) {
        this.clearPending(id, pending);
        pending.reject(new Error("LSP shutdown"));
      }
      this.pending.clear();
      this.openDocuments.clear();
      setTimeout(() => this.proc?.kill(), 1000);
    });
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
    if (this.lifecycle === "initializing") { this.lifecycle = "failed"; this.initReject?.(new Error("LSP connection buffer overflow")); }
    this._rejectAll(new Error("LSP connection buffer overflow"));
    try { this.proc?.kill(); } catch { /* best effort */ }
    return true;
  }

  /** Extract the next complete frame body, or null when headers are incomplete/invalid or the body is partial. */
  private extractNextFrameBody(): Buffer | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headerText = this.buffer.subarray(0, headerEnd).toString("ascii");
    // Content-Length is required, but it need not be the first header.
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(headerText);
    if (!match) {
      // No Content-Length: discard past the header terminator so CL-less
      // garbage can never pin the buffer. The 50MB overflow breaker stays
      // as the backstop for a header terminator that never arrives.
      this.buffer = this.buffer.subarray(headerEnd + 4);
      return null;
    }
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
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string") {
      // Method-first classification: id+method is a server → client request,
      // method-only is a notification. Server request ids live in the server's
      // own namespace and must never settle a client pending entry — even when
      // they collide with an in-flight client request id.
      if (hasId) {
        this.handleServerRequest(msg);
        return;
      }
      this.handleDiagnosticsNotification(msg);
      this.dispatchNotification(msg);
      return;
    }
    if (msg.method !== undefined && msg.method !== null) return; // malformed frame — drop
    if (hasId) this.settlePendingRequest(msg); // id-only: response to a client request
  }

  /** Reply to a server → client request via the dispatch map; unknown methods get -32601. */
  private handleServerRequest(msg: LspIncomingMessage): void {
    const id = msg.id as number | string;
    const method = msg.method as string;
    if (method === "client/registerCapability") {
      try { this.capabilityRegistry?.register(msg.params); } catch { /* malformed params are ignored */ }
      this.sendFrame({ jsonrpc: "2.0", id, result: null });
      return;
    }
    if (method === "client/unregisterCapability") {
      try { this.capabilityRegistry?.unregister(msg.params); } catch { /* malformed params are ignored */ }
      this.sendFrame({ jsonrpc: "2.0", id, result: null });
      return;
    }
    const handler = SERVER_REQUEST_HANDLERS.get(method);
    if (!handler) {
      this.sendFrame({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = handler(msg.params, this.serverRequestContext());
      this.sendFrame({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendFrame({ jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: ${message}` } });
    }
  }

  /** Context handed to server-request handlers for this dispatch. */
  private serverRequestContext(): ServerRequestContext {
    return {
      workspaceFolders: () => {
        if (!this.rootPath) return null;
        return [{ uri: pathToFileURL(this.rootPath).href, name: basename(this.rootPath) }];
      },
      retainApplyEditProposal: (proposal) => { this.retainApplyEditProposal(proposal); },
      getConfigurationSettings: () => this.sessionSettings ?? null,
      registerWorkDoneToken: (t) => this.readinessTracker.trackWorkDoneToken(t),
    };
  }

  private handleDiagnosticsNotification(msg: LspIncomingMessage): void {
    if (msg.method !== "textDocument/publishDiagnostics") return;
    const params = msg.params as { uri?: unknown; diagnostics?: unknown } | undefined;
    const uri = params?.uri;
    if (typeof uri === "string" && uri.startsWith("file:")) {
      try {
        const diags = (params?.diagnostics ?? []) as LSPDiagnostic[];
        const resolved = resolve(fileURLToPath(uri));
        this.diagnostics.set(resolved, diags);
        const p = params as { version?: unknown; resultId?: unknown };
        this.diagnosticsBroker.recordPush(resolved, diags, {
          version: typeof p.version === "number" ? p.version : undefined,
          resultId: typeof p.resultId === "string" ? p.resultId : null,
        });
        this.documentStore.recordDiagnosticReceipt(resolved, typeof p.resultId === "string" ? p.resultId : null);
      } catch {
        // Ignore malformed file URIs without updating the map.
      }
    }
  }

  private settlePendingRequest(msg: LspIncomingMessage): void {
    const id = msg.id as number;
    // Late response to a cancelled request: the tombstone absorbs it. When the
    // id was re-registered while the tombstone was live, the late response
    // belongs to the old (cancelled) request — reject and clear the
    // re-registered pending so it can never hang until timeout.
    if (this.cancelledTombstones.delete(id)) {
      const reRegistered = this.pending.get(id);
      if (reRegistered) {
        this.clearPending(id, reRegistered);
        reRegistered.reject(new LspRequestCancelledError(reRegistered.method));
      }
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) return;
    this.clearPending(id, pending);
    if (msg.error) pending.reject(new Error(msg.error.message));
    else pending.resolve(msg.result);
  }

  private dispatchNotification(msg: LspIncomingMessage): void {
    // Server-initiated notification (no id) — track progress/workDone, then dispatch.
    this.fanOutNotification(msg.method as string, msg.params);
    const handlers = this.notificationHandlers.get(msg.method as string);
    if (handlers && handlers.length > 0) {
      for (const handler of [...handlers]) {
        try { handler(msg.params); } catch { /* isolate handler errors from the read loop */ }
      }
    }
  }

  private _rejectAll(err: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.clearPending(id, pending);
      pending.reject(err);
    }
    this.pending.clear();
  }
}
