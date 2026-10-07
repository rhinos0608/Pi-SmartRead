/**
 * Centralized per-document sync state (Wave 3 lane).
 *
 * Single owner of URI/canonical path, languageId, open/closed, monotonic
 * version, last sync content/hash, advertised sync mode, diagnostic
 * receipts/resultIds, and mutation generation. Serializes
 * didOpen/didChange/didClose per document. Callers ask prepare-document;
 * the store decides the wire action. No blanket close+reopen.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { detectLanguageFromExtension } from "./lsp-types.js";
import { canonicalPathOrFallback } from "../canonical-path.js";

export type LspSyncMode = "none" | "full" | "incremental";

/**
 * Protocol-faithful sync dimensions (LSP TextDocumentSyncOptions).
 * `openClose` (didOpen/didClose lifecycle) and `change` (didChange mode)
 * are distinct: a server may request open/close with no didChange sync.
 */
export interface DocumentSyncConfig {
  openClose: boolean;
  change: LspSyncMode;
}

export interface DocumentState {
  canonicalPath: string;
  uri: string;
  languageId: string;
  open: boolean;
  /** Whether this document sends didOpen/didClose lifecycle notifications. */
  openClose: boolean;
  version: number;
  lastContent: string | null;
  lastHash: string | null;
  syncMode: LspSyncMode;
  mutationGeneration: number;
  diagnosticReceipt: number | null;
  resultId: string | null;
}

export type PrepareDecision =
  | { action: "none"; state: DocumentState; changed: boolean }
  | { action: "didOpen"; state: DocumentState; uri: string; version: number; text: string; languageId: string }
  | { action: "didChange-full"; state: DocumentState; uri: string; version: number; text: string }
  | {
      action: "didChange-incremental";
      state: DocumentState;
      uri: string;
      version: number;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      rangeLength: number;
      text: string;
      /** Old synchronized text the range was computed against (UTF-16 source for encoding conversion). */
      baseText: string;
    };

export function sha256OfText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** Derive advertised sync mode from server textDocumentSync capability. */
export function syncConfigFromCapability(caps: Record<string, unknown> | null | undefined): DocumentSyncConfig {
  try {
    const sync = (caps as Record<string, unknown> | undefined)?.textDocumentSync as unknown;
    if (sync === undefined || sync === null) return { openClose: true, change: "full" };
    if (typeof sync === "number") {
      if (sync === 2) return { openClose: true, change: "incremental" };
      if (sync === 1) return { openClose: true, change: "full" };
      return { openClose: false, change: "none" };
    }
    if (typeof sync === "object") {
      const o = sync as Record<string, unknown>;
      const change: LspSyncMode = o.change === 2 ? "incremental" : o.change === 1 ? "full" : "none";
      if (o.openClose === false) return { openClose: false, change };
      if (o.openClose === true) return { openClose: true, change };
      return { openClose: false, change };
    }
  } catch {
    void 0;
  }
  return { openClose: true, change: "full" };
}

/** Minimal prefix/suffix diff producing one LSP range edit. Null when full sync is cheaper. */
export interface DiffRangeResult {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  rangeLength: number;
  text: string;
}

export function diffRange(oldText: string, newText: string): DiffRangeResult | null {
  if (oldText === newText) return null;
  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldStart = offsetToPosition(oldText, prefix);
  const oldEnd = offsetToPosition(oldText, oldText.length - suffix);
  const changedNew = newText.slice(prefix, newText.length - suffix);
  return { range: { start: oldStart, end: oldEnd }, rangeLength: oldText.length - prefix - suffix, text: changedNew };
}

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let character = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text[i] === "\n") { line++; character = 0; } else { character++; }
  }
  return { line, character };
}

export class LspDocumentStore {
  private states = new Map<string, DocumentState>();
  private queues = new Map<string, Promise<void>>();
  private receiptCounter = 1;

  private keyOf(filePath: string): string {
    // Symlink coherence (evidence contract): realpath with lexical fallback.
    // Behavior otherwise identical — non-symlink paths resolve as before.
    return canonicalPathOrFallback(resolve(filePath));
  }

  get(filePath: string): DocumentState | null {
    return this.states.get(this.keyOf(filePath)) ?? null;
  }

  isOpen(filePath: string): boolean {
    return this.states.get(this.keyOf(filePath))?.open === true;
  }

  getVersion(filePath: string): number | null {
    const s = this.states.get(this.keyOf(filePath));
    return s ? s.version : null;
  }

  setSyncMode(filePath: string, mode: LspSyncMode, openClose?: boolean): void {
    const resolvedOpenClose = openClose ?? (mode === "none" ? false : true);
    const k = this.keyOf(filePath);
    const s = this.states.get(k);
    if (s) { s.syncMode = mode; s.openClose = resolvedOpenClose; }
    else {
      this.states.set(k, {
        canonicalPath: k,
        uri: pathToFileURL(k).href,
        languageId: detectLanguageFromExtension(k) ?? "plaintext",
        open: false,
        version: 0,
        openClose: resolvedOpenClose,
        lastContent: null,
        lastHash: null,
        syncMode: mode,
        mutationGeneration: 0,
        diagnosticReceipt: null,
        resultId: null,
      });
    }
  }

  /**
   * Caller asks prepare-document with current text. Store decides wire action:
   * closed -> didOpen; open + unchanged content -> none; open + changed ->
   * incremental range edit when advertised, else full.
   */
  private ensure(filePath: string, opts?: { languageId?: string; syncMode?: LspSyncMode; openClose?: boolean; syncConfig?: DocumentSyncConfig }): DocumentState {
    const k = this.keyOf(filePath);
    let s = this.states.get(k);
    if (!s) {
      s = {
        canonicalPath: k,
        uri: pathToFileURL(k).href,
        languageId: opts?.languageId ?? detectLanguageFromExtension(k) ?? "plaintext",
        open: false,
        version: 0,
        openClose: opts?.syncConfig?.openClose ?? opts?.openClose ?? (opts?.syncMode === "none" ? false : true),
        lastContent: null,
        lastHash: null,
        syncMode: opts?.syncConfig?.change ?? opts?.syncMode ?? "full",
        mutationGeneration: 0,
        diagnosticReceipt: null,
        resultId: null,
      };
      this.states.set(k, s);
    }
    if (opts?.syncConfig) { s.syncMode = opts.syncConfig.change; s.openClose = opts.syncConfig.openClose; }
    else {
      if (opts?.syncMode) s.syncMode = opts.syncMode;
      if (opts?.openClose !== undefined) s.openClose = opts.openClose;
    }
    if (opts?.languageId) s.languageId = opts.languageId;
    return s;
  }

  private trackNoSyncChange(s: DocumentState, text: string): PrepareDecision {
    if (s.lastContent === text) return { action: "none", state: { ...s }, changed: false };
    s.mutationGeneration += 1;
    s.diagnosticReceipt = null;
    s.resultId = null;
    s.lastContent = text;
    s.lastHash = sha256OfText(text);
    return { action: "none", state: { ...s }, changed: true };
  }

  private decideChange(s: DocumentState, text: string): PrepareDecision {
    if (!s.openClose || s.syncMode === "none") return this.trackNoSyncChange(s, text);
    s.version += 1;
    s.mutationGeneration += 1;
    s.diagnosticReceipt = null;
    s.resultId = null;
    const prev = s.lastContent ?? "";
    s.lastContent = text;
    s.lastHash = sha256OfText(text);
    if (s.syncMode === "incremental") {
      const d = diffRange(prev, text);
      if (d) return { action: "didChange-incremental", state: { ...s }, uri: s.uri, version: s.version, range: d.range, rangeLength: d.rangeLength, text: d.text, baseText: prev };
    }
    return { action: "didChange-full", state: { ...s }, uri: s.uri, version: s.version, text };
  }

  prepare(filePath: string, text: string, opts?: { languageId?: string; syncMode?: LspSyncMode; openClose?: boolean; syncConfig?: DocumentSyncConfig }): PrepareDecision {
    const s = this.ensure(filePath, opts);
    // openClose:false emits no wire: didChange requires prior didOpen (LSP document
    // lifecycle), which openClose:false forbids. Track content locally instead.
    if (!s.openClose) return this.trackNoSyncChange(s, text);
    if (s.syncMode === "none") {
      // openClose true + change none: first touch still sends didOpen so the
      // server knows the document; later changes track locally with no wire.
      if (!s.open) {
        s.version += 1;
        s.lastContent = text;
        s.lastHash = sha256OfText(text);
        return { action: "didOpen", state: { ...s }, uri: s.uri, version: s.version, text, languageId: s.languageId };
      }
      return this.trackNoSyncChange(s, text);
    }
    if (!s.open) {
      s.version += 1;
      s.lastContent = text;
      s.lastHash = sha256OfText(text);
      return { action: "didOpen", state: { ...s }, uri: s.uri, version: s.version, text, languageId: s.languageId };
    }
    if (s.lastContent === text) return { action: "none", state: { ...s }, changed: false };
    return this.decideChange(s, text);
  }

  /** Record that a wire notification was actually sent (marks open). */
  markSynced(filePath: string): void {
    const s = this.states.get(this.keyOf(filePath));
    if (s && s.openClose) s.open = true;
  }

  markClosed(filePath: string): { uri: string } | null {
    const s = this.states.get(this.keyOf(filePath));
    if (!s || !s.open) return null;
    s.open = false;
    s.mutationGeneration += 1;
    s.diagnosticReceipt = null;
    s.resultId = null;
    return { uri: s.uri };
  }

  recordDiagnosticReceipt(filePath: string, resultId?: string | null): number {
    const k = this.keyOf(filePath);
    let s = this.states.get(k);
    if (!s) {
      s = {
        canonicalPath: k,
        uri: pathToFileURL(k).href,
        languageId: detectLanguageFromExtension(k) ?? "plaintext",
        open: false,
        version: 0,
        openClose: true,
        lastContent: null,
        lastHash: null,
        syncMode: "full",
        mutationGeneration: 0,
        diagnosticReceipt: null,
        resultId: null,
      };
      this.states.set(k, s);
    }
    const receipt = this.receiptCounter++;
    s.diagnosticReceipt = receipt;
    if (resultId !== undefined) s.resultId = resultId;
    return receipt;
  }

  invalidateDiagnostics(filePath: string): void {
    const s = this.states.get(this.keyOf(filePath));
    if (!s) return;
    s.mutationGeneration += 1;
    s.diagnosticReceipt = null;
    s.resultId = null;
  }

  /** Serialize async work per document (didOpen/didChange/didClose ordering). */
  serialize<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const k = this.keyOf(filePath);
    const prior = this.queues.get(k) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const next = prior.then(() => work().finally(() => release()));
    this.queues.set(k, gate.catch(() => {}));
    void gate.then(() => {
      if (this.queues.get(k) === gate) this.queues.delete(k);
    });
    return next;
  }

  snapshot(): DocumentState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  clear(): void {
    this.states.clear();
    this.queues.clear();
  }
}
