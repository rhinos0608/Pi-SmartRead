/**
 * Centralized per-document sync state (Wave 3 lane).
 *
 * Single owner of URI/canonical path, languageId, open/closed, monotonic
 * version, last sync content/hash, advertised sync mode, diagnostic
 * receipts/resultIds, and mutation generation. Serializes
 * didOpen/didChange/didClose per document. Callers ask prepare-document;
 * the store decides the wire action. No blanket close+reopen.
 */
import { createHash, randomUUID } from "node:crypto";
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

export type PositionEncoding = "utf-8" | "utf-16" | "utf-32";

/**
 * Canonical receipt issued ONLY after local writable submission succeeds.
 * Identifies exact submitted document/version/text hash/generation/stamp/config,
 * plus connection/transport/store/state identity and negotiated encoding.
 * Local writable callback success means local submission, NOT server indexing.
 */
export interface PreparedDocumentReceipt {
  readonly canonicalPath: string;
  readonly uri: string;
  readonly version: number;
  readonly textHash: string;
  readonly mutationGeneration: number;
  readonly submissionStamp: number;
  readonly syncConfig: DocumentSyncConfig;
  readonly connectionId: string;
  readonly transportId: string;
  readonly storeId: string;
  readonly stateId: string;
  readonly descriptorId?: string;
  readonly projectRoot?: string;
  readonly positionEncoding: PositionEncoding;
}

export interface DocumentState {
  canonicalPath: string;
  uri: string;
  languageId: string;
  open: boolean;
  /** Whether this document sends didOpen/didClose lifecycle notifications. */
  openClose: boolean;
  syncMode: LspSyncMode;
  mutationGeneration: number;
  diagnosticReceipt: number | null;
  resultId: string | null;

  /** True if the last submission attempt failed, was aborted, or was interrupted. */
  uncertain: boolean;

  /** The currently SUBMITTED text (confirmed by local writable callback). */
  submittedContent: string | null;
  /** The currently SUBMITTED text sha256 hash. */
  submittedHash: string | null;
  /** The currently SUBMITTED version known to the server. */
  submittedVersion: number;
  /** Monotonic submission counter stamp of the last successful local write. */
  submittedStamp: number;

  /** Opaque state identity token (changes whenever state is mutated or invalidated). */
  stateId: string;

  /** The last valid submitted receipt, or null if closed/invalidated/never submitted. */
  submittedReceipt: PreparedDocumentReceipt | null;
}

export type PreparePlan =
  | {
      action: "none";
      canonicalPath: string;
      receipt: PreparedDocumentReceipt;
      stateId: string;
      mutationGeneration: number;
      initialOpen: boolean;
      storeId: string;
      syncConfig: DocumentSyncConfig;
      connectionId?: string;
      transportId?: string;
    }
  | {
      action: "didOpen";
      canonicalPath: string;
      uri: string;
      languageId: string;
      version: number;
      text: string;
      textHash: string;
      stateId: string;
      mutationGeneration: number;
      initialOpen: boolean;
      storeId: string;
      syncConfig: DocumentSyncConfig;
      connectionId?: string;
      transportId?: string;
    }
  | {
      action: "didChange-full";
      canonicalPath: string;
      uri: string;
      version: number;
      text: string;
      textHash: string;
      stateId: string;
      mutationGeneration: number;
      initialOpen: boolean;
      storeId: string;
      syncConfig: DocumentSyncConfig;
      connectionId?: string;
      transportId?: string;
    }
  | {
      action: "didChange-incremental";
      canonicalPath: string;
      uri: string;
      version: number;
      range: { start: { line: number; character: number }; end: { line: number; character: number } };
      rangeLength: number;
      text: string;
      baseText: string;
      fullText: string;
      textHash: string;
      stateId: string;
      mutationGeneration: number;
      initialOpen: boolean;
      storeId: string;
      syncConfig: DocumentSyncConfig;
      connectionId?: string;
      transportId?: string;
    };

export function freezeReceipt(r: PreparedDocumentReceipt): PreparedDocumentReceipt {
  return Object.freeze({
    ...r,
    syncConfig: Object.freeze({ ...r.syncConfig }),
  });
}

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

export interface CommitContext {
  connectionId: string;
  transportId: string;
  descriptorId?: string;
  projectRoot?: string;
  positionEncoding: PositionEncoding;
}

export class LspDocumentStore {
  readonly storeId = randomUUID();
  private states = new Map<string, DocumentState>();
  private queues = new Map<string, Promise<void>>();
  private receiptCounter = 1;
  private stampCounter = 1;

  private keyOf(filePath: string): string {
    return canonicalPathOrFallback(resolve(filePath));
  }

  get(filePath: string): DocumentState | null {
    return this.states.get(this.keyOf(filePath)) ?? null;
  }

  getSubmittedReceipt(filePath: string): PreparedDocumentReceipt | null {
    const s = this.states.get(this.keyOf(filePath));
    if (!s || !s.open || s.uncertain || !s.submittedReceipt) return null;
    return freezeReceipt(s.submittedReceipt);
  }

  isOpen(filePath: string): boolean {
    return this.states.get(this.keyOf(filePath))?.open === true;
  }

  getVersion(filePath: string): number | null {
    const s = this.states.get(this.keyOf(filePath));
    return s ? s.submittedVersion : null;
  }

  getOpenFilePaths(): string[] {
    const paths: string[] = [];
    for (const [k, s] of this.states) {
      if (s.open) paths.push(k);
    }
    return paths;
  }

  get openDocumentCount(): number {
    let count = 0;
    for (const s of this.states.values()) {
      if (s.open) count++;
    }
    return count;
  }

  setSyncMode(filePath: string, mode: LspSyncMode, openClose?: boolean): void {
    const resolvedOpenClose = openClose ?? (mode === "none" ? false : true);
    const k = this.keyOf(filePath);
    const s = this.states.get(k);
    if (s) {
      if (s.syncMode !== mode || s.openClose !== resolvedOpenClose) {
        s.syncMode = mode;
        s.openClose = resolvedOpenClose;
        s.uncertain = true;
        s.submittedReceipt = null;
        s.stateId = randomUUID();
      }
    } else {
      this.states.set(k, {
        canonicalPath: k,
        uri: pathToFileURL(k).href,
        languageId: detectLanguageFromExtension(k) ?? "plaintext",
        open: false,
        openClose: resolvedOpenClose,
        syncMode: mode,
        mutationGeneration: 0,
        diagnosticReceipt: null,
        resultId: null,
        uncertain: false,
        submittedContent: null,
        submittedHash: null,
        submittedVersion: 0,
        submittedStamp: 0,
        stateId: randomUUID(),
        submittedReceipt: null,
      });
    }
  }

  private ensure(
    filePath: string,
    opts?: { languageId?: string; syncMode?: LspSyncMode; openClose?: boolean; syncConfig?: DocumentSyncConfig },
  ): DocumentState {
    const k = this.keyOf(filePath);
    let s = this.states.get(k);
    const targetSyncMode = opts?.syncConfig?.change ?? opts?.syncMode ?? "full";
    const targetOpenClose = opts?.syncConfig?.openClose ?? opts?.openClose ?? (targetSyncMode === "none" ? false : true);

    if (!s) {
      s = {
        canonicalPath: k,
        uri: pathToFileURL(k).href,
        languageId: opts?.languageId ?? detectLanguageFromExtension(k) ?? "plaintext",
        open: false,
        openClose: targetOpenClose,
        syncMode: targetSyncMode,
        mutationGeneration: 0,
        diagnosticReceipt: null,
        resultId: null,
        uncertain: false,
        submittedContent: null,
        submittedHash: null,
        submittedVersion: 0,
        submittedStamp: 0,
        stateId: randomUUID(),
        submittedReceipt: null,
      };
      this.states.set(k, s);
    } else {
      if (s.syncMode !== targetSyncMode || s.openClose !== targetOpenClose) {
        s.syncMode = targetSyncMode;
        s.openClose = targetOpenClose;
        s.uncertain = true;
        s.submittedReceipt = null;
        s.stateId = randomUUID();
      }
    }
    if (opts?.languageId) s.languageId = opts.languageId;
    return s;
  }

  /**
   * Plan preparation without mutating submitted state.
   * Refuses uncertain state until established new document lifecycle.
   * Refuses no-sync or openClose:false.
   */
  planPrepare(
    filePath: string,
    text: string,
    opts?: {
      languageId?: string;
      syncMode?: LspSyncMode;
      openClose?: boolean;
      syncConfig?: DocumentSyncConfig;
      connectionId?: string;
      transportId?: string;
    },
  ): PreparePlan {
    const s = this.ensure(filePath, opts);

    if (s.uncertain) {
      throw new Error(
        `LSP document state is uncertain for ${s.canonicalPath}; preparation refused until established new document lifecycle`,
      );
    }

    if (!s.openClose || s.syncMode === "none") {
      throw new Error(
        `LSP document preparation cannot produce a valid receipt: synchronization not supported (openClose: ${s.openClose}, syncMode: ${s.syncMode})`,
      );
    }

    const textHash = sha256OfText(text);
    const planIdentity = {
      stateId: s.stateId,
      mutationGeneration: s.mutationGeneration,
      initialOpen: s.open,
      storeId: this.storeId,
      syncConfig: { openClose: s.openClose, change: s.syncMode },
      ...(opts?.connectionId ? { connectionId: opts.connectionId } : {}),
      ...(opts?.transportId ? { transportId: opts.transportId } : {}),
    };

    if (!s.open) {
      const plannedVersion = s.submittedVersion > 0 ? s.submittedVersion + 1 : 1;
      return {
        action: "didOpen",
        canonicalPath: s.canonicalPath,
        uri: s.uri,
        languageId: s.languageId,
        version: plannedVersion,
        text,
        textHash,
        ...planIdentity,
      };
    }

    if (s.submittedReceipt !== null && s.submittedContent === text) {
      return {
        action: "none",
        canonicalPath: s.canonicalPath,
        receipt: s.submittedReceipt,
        ...planIdentity,
      };
    }

    const plannedVersion = s.submittedVersion + 1;
    const canIncremental = s.syncMode === "incremental" && s.submittedContent !== null;

    if (canIncremental) {
      const d = diffRange(s.submittedContent!, text);
      if (d) {
        return {
          action: "didChange-incremental",
          canonicalPath: s.canonicalPath,
          uri: s.uri,
          version: plannedVersion,
          range: d.range,
          rangeLength: d.rangeLength,
          text: d.text,
          baseText: s.submittedContent!,
          fullText: text,
          textHash,
          ...planIdentity,
        };
      }
    }

    return {
      action: "didChange-full",
      canonicalPath: s.canonicalPath,
      uri: s.uri,
      version: plannedVersion,
      text,
      textHash,
      ...planIdentity,
    };
  }

  /**
   * Commit a planned action once local submission succeeds.
   * Validates state, store, config, and transport identity before publishing.
   */
  commitSubmitted(plan: PreparePlan, context: CommitContext): PreparedDocumentReceipt {
    if (plan.action === "none") {
      return plan.receipt;
    }

    const s = this.states.get(plan.canonicalPath);
    if (!s) throw new Error(`Document state not found for ${plan.canonicalPath}`);

    // Verify plan matches current store/state/generation/config/transport identity
    if (
      this.storeId !== plan.storeId ||
      s.stateId !== plan.stateId ||
      s.mutationGeneration !== plan.mutationGeneration ||
      s.open !== plan.initialOpen ||
      s.syncMode !== plan.syncConfig.change ||
      s.openClose !== plan.syncConfig.openClose ||
      (plan.transportId !== undefined && context.transportId !== plan.transportId) ||
      (plan.connectionId !== undefined && context.connectionId !== plan.connectionId)
    ) {
      throw new Error(
        `LSP document commit refused: state identity mismatch for ${plan.canonicalPath} (document was closed, reconfigured, or transport replaced during submission)`,
      );
    }

    const submittedText = plan.action === "didChange-incremental" ? plan.fullText : plan.text;

    s.open = true;
    s.uncertain = false;
    s.submittedVersion = plan.version;
    s.submittedContent = submittedText;
    s.submittedHash = plan.textHash;
    s.submittedStamp = this.stampCounter++;
    s.mutationGeneration += 1;
    s.stateId = randomUUID();
    s.diagnosticReceipt = null;
    s.resultId = null;

    const receipt: PreparedDocumentReceipt = freezeReceipt({
      canonicalPath: s.canonicalPath,
      uri: s.uri,
      version: s.submittedVersion,
      textHash: s.submittedHash,
      mutationGeneration: s.mutationGeneration,
      submissionStamp: s.submittedStamp,
      syncConfig: { openClose: s.openClose, change: s.syncMode },
      connectionId: context.connectionId,
      transportId: context.transportId,
      storeId: this.storeId,
      stateId: s.stateId,
      descriptorId: context.descriptorId,
      projectRoot: context.projectRoot,
      positionEncoding: context.positionEncoding,
    });

    s.submittedReceipt = receipt;
    return receipt;
  }

  /** Invalidate submitted state after a failed write, abort, or uncertain transport state. */
  markUncertain(filePath: string): void {
    const s = this.states.get(this.keyOf(filePath));
    if (s) {
      s.uncertain = true;
      s.submittedReceipt = null;
      s.mutationGeneration += 1;
      s.stateId = randomUUID();
      s.diagnosticReceipt = null;
      s.resultId = null;
    }
  }

  /** Mark document closed. Invalidates submitted receipt and resets submitted state. */
  markClosed(filePath: string): { uri: string } | null {
    const s = this.states.get(this.keyOf(filePath));
    if (!s || !s.open) return null;
    s.open = false;
    s.uncertain = false;
    s.submittedReceipt = null;
    s.submittedContent = null;
    s.submittedHash = null;
    s.submittedVersion = 0;
    s.mutationGeneration += 1;
    s.stateId = randomUUID();
    s.diagnosticReceipt = null;
    s.resultId = null;
    return { uri: s.uri };
  }

  /** Invalidate all documents across this store (e.g. connection closed or replaced). */
  invalidateAll(): void {
    for (const s of this.states.values()) {
      s.uncertain = true;
      s.submittedReceipt = null;
      s.mutationGeneration += 1;
      s.stateId = randomUUID();
      s.diagnosticReceipt = null;
      s.resultId = null;
    }
  }

  recordDiagnosticReceipt(filePath: string, resultId?: string | null): number {
    const k = this.keyOf(filePath);
    let s = this.states.get(k);
    if (!s) {
      s = this.ensure(k);
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
    s.stateId = randomUUID();
    s.diagnosticReceipt = null;
    s.resultId = null;
  }

  /**
   * Serialize async work per document (didOpen/didChange/didClose ordering).
   * Caller settles immediately on cancellation or deadline while prior work is occupied.
   * Tail remains tied to prior lifetime so subsequent work never overtakes prior work.
   */
  serialize<T>(
    filePath: string,
    work: () => Promise<T>,
    opts?: {
      signal?: AbortSignal;
      deadlineMs?: number;
      createCancelError?: (method: string) => Error;
      createTimeoutError?: (method: string) => Error;
    },
  ): Promise<T> {
    const k = this.keyOf(filePath);
    const signal = opts?.signal;
    const deadlineMs = opts?.deadlineMs;
    const makeCancelErr = opts?.createCancelError ?? ((m) => new Error(`LSP ${m} cancelled`));
    const makeTimeoutErr = opts?.createTimeoutError ?? ((m) => new Error(`LSP ${m} timed out`));

    // Immediate check before queue insertion
    if (signal?.aborted) {
      return Promise.reject(makeCancelErr("prepareDocument"));
    }
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
      return Promise.reject(makeTimeoutErr("prepareDocument"));
    }

    const prior = this.queues.get(k) ?? Promise.resolve();

    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    this.queues.set(k, gate);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let rejectCaller!: (err: Error) => void;
    let resolveCaller!: (val: T) => void;

    const callerPromise = new Promise<T>((resolve, reject) => {
      resolveCaller = resolve;
      rejectCaller = reject;
    });

    const cleanupListeners = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    };

    const triggerCancel = (err: Error) => {
      if (cancelled) return;
      cancelled = true;
      cleanupListeners();
      rejectCaller(err);
    };

    if (signal) {
      onAbort = () => triggerCancel(makeCancelErr("prepareDocument"));
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (deadlineMs !== undefined) {
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        triggerCancel(makeTimeoutErr("prepareDocument"));
      } else {
        timer = setTimeout(() => {
          triggerCancel(makeTimeoutErr("prepareDocument"));
        }, remaining);
      }
    }

    // Queue chain: tail remains strictly tied to prior lifetime
    void prior
      .catch(() => {})
      .then(async () => {
        // If cancelled while waiting in queue, skip execution without emitting or committing
        if (cancelled) {
          return;
        }
        if (signal?.aborted) {
          triggerCancel(makeCancelErr("prepareDocument"));
          return;
        }
        if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
          triggerCancel(makeTimeoutErr("prepareDocument"));
          return;
        }

        try {
          const res = await work();
          if (!cancelled) {
            cleanupListeners();
            resolveCaller(res);
          }
        } catch (err) {
          if (!cancelled) {
            cleanupListeners();
            rejectCaller(err instanceof Error ? err : new Error(String(err)));
          }
        }
      })
      .finally(() => {
        cleanupListeners();
        releaseGate();
        if (this.queues.get(k) === gate) {
          this.queues.delete(k);
        }
      });

    return callerPromise;
  }

  snapshot(): DocumentState[] {
    return [...this.states.values()].map((s) => ({
      ...s,
      submittedReceipt: s.submittedReceipt ? { ...s.submittedReceipt, syncConfig: { ...s.submittedReceipt.syncConfig } } : null,
    }));
  }

  clear(): void {
    this.states.clear();
    this.queues.clear();
  }
}
