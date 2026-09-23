/**
 * DiagnosticsBroker (Wave 3 lane).
 *
 * Push cache with receipts, pull via textDocument/diagnostic when supported,
 * dynamic pull registration, workspace/diagnostic when supported, resultId
 * handling, post-edit invalidation, bounded settle evidence. Every result
 * states source pull|push|workspace-pull. Version stays optional. Never
 * translates absent cache into confirmed-clean.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { LspCapabilityRegistry } from "./lsp-capability-registry.js";
import type { LSPDiagnostic } from "./lsp-types.js";

export type DiagnosticSource = "pull" | "push" | "workspace-pull";

export interface DiagnosticResult {
  source: DiagnosticSource;
  diagnostics: LSPDiagnostic[];
  /** Present only when the server confirmed a receipt (push version or pull resultId). */
  receipt: number | null;
  resultId: string | null;
  /** Push receipt version; null for pull/workspace/unknown. */
  version: number | null;
  /** True when this result confirms current state; false = unconfirmed, never clean. */
  confirmed: boolean;
}

export interface WorkspaceDocumentReport {
  uri: string | null;
  version?: number | null;
  resultId: string | null;
  kind: string;
  diagnostics: LSPDiagnostic[];
}

export interface WorkspaceDiagnosticResult extends DiagnosticResult {
  reports: WorkspaceDocumentReport[];
  resultIds: Array<{ uri: string | null; value: string | null }>;
}

interface PushEntry {
  diagnostics: LSPDiagnostic[];
  receipt: number;
  version?: number;
  resultId: string | null;
  generation: number;
}

interface PullEntry {
  diagnostics: LSPDiagnostic[];
  resultId: string | null;
}

export interface WorkspacePullEntry {
  uri: string;
  diagnostics: LSPDiagnostic[];
  resultId: string | null;
  version: number | null;
}

interface BrokerDeps {
  request: (method: string, params: unknown) => Promise<unknown>;
  getCapabilityRegistry: () => LspCapabilityRegistry | null;
  getServerCapabilities: () => Record<string, unknown> | null;
  supportsPull: () => boolean;
  supportsWorkspacePull: () => boolean;
}

function asDiagnostics(raw: unknown): LSPDiagnostic[] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const items = obj.items;
  if (!Array.isArray(items)) return null;
  return items as LSPDiagnostic[];
}

/**
 * file: URI or absolute path → filesystem path. fileURLToPath throws on
 * Windows for drive-less URIs (file:///tmp/x.ts), so fall back to the
 * decoded URL pathname — it resolves exactly like "/tmp/x.ts" and keeps
 * absolute-path and URI lookups on one cache key on all platforms.
 */
function toFsPath(uriOrPath: string): string {
  if (!uriOrPath.startsWith("file:")) return uriOrPath;
  try {
    return fileURLToPath(uriOrPath);
  } catch {
    try {
      return decodeURIComponent(new URL(uriOrPath).pathname);
    } catch {
      return uriOrPath;
    }
  }
}

export class LspDiagnosticsBroker {
  private push = new Map<string, PushEntry>();
  private lastPull = new Map<string, PullEntry>();
  private lastWorkspacePull = new Map<string, WorkspacePullEntry>();
  private receiptCounter = 1;
  private generation = new Map<string, number>();

  constructor(private readonly deps: BrokerDeps) {}

  private keyOf(filePath: string): string {
    return resolve(toFsPath(filePath));
  }

  private pullKey(uriOrPath: string): string {
    return resolve(toFsPath(uriOrPath));
  }

  /** FROZEN: cached last-pull state by resolved path (absolute path or file:// URI). Copy or null. */
  getPullState(filePath: string): { resultId: string | null; diagnostics: LSPDiagnostic[] } | null {
    const e = this.lastPull.get(this.pullKey(filePath));
    if (!e) return null;
    return { resultId: e.resultId, diagnostics: [...e.diagnostics] };
  }

  /** Push path: cache publishDiagnostics with receipt. Version optional. */
  recordPush(filePath: string, diagnostics: LSPDiagnostic[], opts?: { version?: number; resultId?: string | null }): number {
    const k = this.keyOf(filePath);
    const receipt = this.receiptCounter++;
    const gen = this.generation.get(k) ?? 0;
    this.push.set(k, { diagnostics: [...diagnostics], receipt, version: opts?.version, resultId: opts?.resultId ?? null, generation: gen });
    return receipt;
  }

  /** Post-edit invalidation: drop push cache, bump generation. Never confirmed-clean. */
  invalidate(filePath: string): void {
    const k = this.keyOf(filePath);
    this.push.delete(k);
    this.lastPull.delete(k);
    this.lastPull.delete(this.pullKey(filePath));
    this.generation.set(k, (this.generation.get(k) ?? 0) + 1);
  }

  clearPush(filePath: string): void {
    this.push.delete(this.keyOf(filePath));
  }

  clear(filePath: string): void {
    const k = this.keyOf(filePath);
    this.push.delete(k);
    this.lastPull.delete(k);
    this.lastPull.delete(this.pullKey(filePath));
  }

  hasReceipt(filePath: string): boolean {
    return this.push.has(this.keyOf(filePath));
  }

  getPush(filePath: string): PushEntry | null {
    return this.push.get(this.keyOf(filePath)) ?? null;
  }

  private pullSupported(): boolean {
    try {
      if (this.deps.supportsPull()) return true;
    } catch (err) { void err; }
    try {
      const caps = this.deps.getServerCapabilities();
      const dp = caps?.diagnosticProvider as unknown;
      if (dp === true) return true;
      if (dp && typeof dp === "object") return true;
    } catch (err) { void err; }
    try {
      const reg = this.deps.getCapabilityRegistry();
      const dyn = reg?.liveDynamicFeatures();
      if (dyn?.has("diagnostics")) return true;
    } catch (err) { void err; }
    return false;
  }

  private workspacePullSupported(): boolean {
    try {
      if (this.deps.supportsWorkspacePull()) return true;
    } catch (err) { void err; }
    try {
      const caps = this.deps.getServerCapabilities();
      const dp = (caps?.diagnosticProvider as Record<string, unknown> | undefined)?.workspaceDiagnostics;
      if (dp === true) return true;
    } catch (err) { void err; }
    try {
      const reg = this.deps.getCapabilityRegistry();
      const dyn = reg?.liveDynamicFeatures();
      if (dyn?.has("workspaceDiagnostics")) return true;
    } catch (err) { void err; }
    return false;
  }

  /** Pull path: textDocument/diagnostic. Null transport failure -> unconfirmed, never empty. */
  async pullDocument(uri: string, opts?: { identifier?: string; previousResultId?: string | null }): Promise<DiagnosticResult> {
    if (!this.pullSupported()) {
      return { source: "pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false };
    }
    let raw: unknown;
    try {
      raw = await this.deps.request("textDocument/diagnostic", {
        textDocument: { uri },
        ...(opts?.identifier ? { identifier: opts.identifier } : {}),
        ...(opts?.previousResultId ? { previousResultId: opts.previousResultId } : {}),
      });
    } catch (err) { void err; return { source: "pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false }; }
    if (raw === null || raw === undefined) return { source: "pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false };
    if (typeof raw === "object" && (raw as Record<string, unknown>).kind === "unchanged") {
      const rid = typeof (raw as Record<string, unknown>).resultId === "string" ? (raw as Record<string, unknown>).resultId as string : null;
      const cached = this.lastPull.get(this.pullKey(uri));
      if (cached) {
        return { source: "pull", diagnostics: [...cached.diagnostics], receipt: null, resultId: rid ?? cached.resultId, version: null, confirmed: true };
      }
      return { source: "pull", diagnostics: [], receipt: null, resultId: rid ?? opts?.previousResultId ?? null, version: null, confirmed: false };
    }
    const items = asDiagnostics(raw);
    if (!items) return { source: "pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false };
    const rid = typeof (raw as Record<string, unknown>).resultId === "string" ? ((raw as Record<string, unknown>).resultId as string) : null;
    this.lastPull.set(this.pullKey(uri), { diagnostics: [...items], resultId: rid });
    return { source: "pull", diagnostics: items, receipt: null, resultId: rid, version: null, confirmed: true };
  }

  /** Workspace pull path: workspace/diagnostic. previousResultIds auto-built from cache. */
  async pullWorkspace(opts?: { identifier?: string; previousResultIds?: Array<{ uri: string; value: string }> }): Promise<WorkspaceDiagnosticResult> {
    if (!this.workspacePullSupported()) {
      return { source: "workspace-pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false, reports: [], resultIds: [] };
    }
    const autoPrev: Array<{ uri: string; value: string }> = [];
    for (const e of this.lastWorkspacePull.values()) {
      if (e.resultId !== null) autoPrev.push({ uri: e.uri, value: e.resultId });
    }
    const prevIds = opts?.previousResultIds ?? (autoPrev.length > 0 ? autoPrev : undefined);
    let raw: unknown;
    try {
      raw = await this.deps.request("workspace/diagnostic", {
        ...(opts?.identifier ? { identifier: opts.identifier } : {}),
        ...(prevIds ? { previousResultIds: prevIds } : {}),
      });
    } catch (err) { void err; return { source: "workspace-pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false, reports: [], resultIds: [] }; }
    if (raw === null || raw === undefined) return { source: "workspace-pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false, reports: [], resultIds: [] };
    const items = (raw as Record<string, unknown>)?.items;
    if (!Array.isArray(items)) return { source: "workspace-pull", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false, reports: [], resultIds: [] };
    const flat: LSPDiagnostic[] = [];
    const reports: WorkspaceDocumentReport[] = [];
    const resultIds: Array<{ uri: string | null; value: string | null }> = [];
    let workspaceResultId: string | null = null;
    let unconfirmed = false;
    for (const entry of items as Array<Record<string, unknown>>) {
      const uri = typeof entry.uri === "string" ? (entry.uri as string) : null;
      const version = typeof entry.version === "number" ? (entry.version as number) : null;
      const entryResultId = typeof entry.resultId === "string" ? (entry.resultId as string) : null;
      const kind = typeof entry.kind === "string" ? (entry.kind as string) : "full";
      if (entryResultId !== null && workspaceResultId === null) workspaceResultId = entryResultId;
      resultIds.push({ uri, value: entryResultId });
      if (kind === "unchanged") {
        const cached = uri !== null ? this.lastWorkspacePull.get(uri) : undefined;
        if (cached) {
          const diags = [...cached.diagnostics];
          flat.push(...diags);
          reports.push({ uri, version: version ?? cached.version, resultId: entryResultId ?? cached.resultId, kind, diagnostics: diags });
        } else {
          unconfirmed = true;
          reports.push({ uri, version, resultId: entryResultId, kind, diagnostics: [] });
        }
        continue;
      }
      const entryItems = entry.items;
      const diags = Array.isArray(entryItems) ? (entryItems as LSPDiagnostic[]) : [];
      flat.push(...diags);
      reports.push({ uri, version, resultId: entryResultId, kind, diagnostics: [...diags] });
      if (uri !== null) this.lastWorkspacePull.set(uri, { uri, diagnostics: [...diags], resultId: entryResultId, version });
    }
    if (unconfirmed) return { source: "workspace-pull", diagnostics: [], receipt: null, resultId: workspaceResultId, version: null, confirmed: false, reports, resultIds };
    return { source: "workspace-pull", diagnostics: flat, receipt: null, resultId: workspaceResultId, version: null, confirmed: true, reports, resultIds };
  }

  /**
   * Bounded settle: poll `observe` until `isSettled` or deadlineMs.
   * Evidence is the observed receipt/generation, never a fixed sleep.
   */
  async settle<T>(observe: () => T | Promise<T>, isSettled: (v: T) => boolean, opts?: { deadlineMs?: number; intervalMs?: number; signal?: AbortSignal }): Promise<{ settled: boolean; value: T }> {
    const deadlineMs = opts?.deadlineMs ?? 800;
    const intervalMs = opts?.intervalMs ?? 25;
    const start = Date.now();
    let value = await observe();
    if (isSettled(value)) return { settled: true, value };
    while (Date.now() - start < deadlineMs) {
      if (opts?.signal?.aborted) return { settled: isSettled(value), value };
      await new Promise((r) => setTimeout(r, intervalMs));
      value = await observe();
      if (isSettled(value)) return { settled: true, value };
    }
    return { settled: isSettled(value), value };
  }

  /** Push-backed read: returns cached push as confirmed, or unconfirmed when absent. */
  readPush(filePath: string): DiagnosticResult {
    const entry = this.push.get(this.keyOf(filePath));
    if (!entry) return { source: "push", diagnostics: [], receipt: null, resultId: null, version: null, confirmed: false };
    return { source: "push", diagnostics: [...entry.diagnostics], receipt: entry.receipt, resultId: entry.resultId, version: entry.version ?? null, confirmed: true };
  }
}
