/**
 * LSP inspection outcome engine — WP-SR1
 * Wraps LSP navigation + on-demand diagnostics with honesty status.
 * Public positions are 1-based; LSP is 0-based. All requests bounded by timeout + AbortSignal.
 */

// Extension seam: future mutating autofix/format and external security-scanner triage plugs here — add new status values (e.g. "needs-triage") and result fields without closing switch/default paths.
import type { LSPDiagnostic, LspOutcomeStatus } from "./lsp-bridge.js";

export type { LspOutcomeStatus };
export type OutcomeStatus = LspOutcomeStatus;

export type NavigationOperation = "definition" | "references" | "implementation" | "hover" | "documentSymbols" | "workspaceSymbols" | "prepareCallHierarchy" | "incomingCalls" | "outgoingCalls";

export interface NavigationInput {
  path?: string;
  operation: NavigationOperation;
  line?: number; // 1-based
  character?: number; // 1-based
  query?: string;
  root: string;
  timeoutMs?: number;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface NavigationOutcome {
  status: OutcomeStatus;
  operation: NavigationOperation;
  items: unknown[];
  truncated: boolean;
}

export interface DiagnosticsInput {
  path: string;
  root: string;
  waitMs?: number;
  maxPerFile?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DiagnosticsOutcome {
  status: OutcomeStatus;
  diagnostics: LSPDiagnostic[];
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_DIAG_WAIT_MS = 1500;

function toZeroBased(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  return Math.max(0, n - 1);
}

export async function inspectNavigation(input: NavigationInput): Promise<NavigationOutcome> {
  const { getLSPBridge } = await import("./lsp-bridge.js");
  const bridge = await getLSPBridge();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!bridge || !bridge.isAvailable()) {
    // also check per-operation server availability via bridge outcome methods — falls back to unavailable
  }
  const bridgeAny = bridge as any;
  try {
    switch (input.operation) {
      case "definition": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        const line0 = toZeroBased(input.line)!;
        const char0 = toZeroBased(input.character)!;
        if (bridgeAny.goToDefinitionOutcome) {
          const r = await bridgeAny.goToDefinitionOutcome(input.path!, line0 + 1, input.character!, input.root, { timeoutMs, signal: input.signal });
          // bridge expects 1-based per new API — pass through original 1-based
          const items = r.location ? [r.location] : [];
          return { status: r.status, operation: input.operation, items: sliceLimit(items, input.maxResults), truncated: (items.length > (input.maxResults ?? 20)) };
        }
        const loc = await withBudget(bridge.goToDefinition(input.path!, line0, char0, input.root), timeoutMs, input.signal);
        if (!loc) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit([loc], input.maxResults), truncated: false };
      }
      case "references": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        const line0 = toZeroBased(input.line)!;
        const char0 = toZeroBased(input.character)!;
        if (bridgeAny.findReferencesOutcome) {
          const r = await bridgeAny.findReferencesOutcome(input.path!, input.line!, input.character!, input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.locations, input.maxResults), truncated: r.locations.length > (input.maxResults ?? 20) };
        }
        const locs = await withBudget(bridge.findReferences(input.path!, line0, char0, input.root), timeoutMs, input.signal);
        if (locs.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(locs, input.maxResults), truncated: locs.length > (input.maxResults ?? 20) };
      }
      case "implementation": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        const line0 = toZeroBased(input.line)!;
        const char0 = toZeroBased(input.character)!;
        if (bridgeAny.goToImplementationOutcome) {
          const r = await bridgeAny.goToImplementationOutcome(input.path!, input.line!, input.character!, input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.locations, input.maxResults), truncated: r.locations.length > (input.maxResults ?? 20) };
        }
        const locs = await withBudget(bridge.goToImplementation(input.path!, line0, char0, input.root), timeoutMs, input.signal);
        if (locs.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(locs, input.maxResults), truncated: locs.length > (input.maxResults ?? 20) };
      }
      case "hover": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        const line0 = toZeroBased(input.line)!;
        const char0 = toZeroBased(input.character)!;
        if (bridgeAny.hoverOutcome) {
          const r = await bridgeAny.hoverOutcome(input.path!, input.line!, input.character!, input.root, { timeoutMs, signal: input.signal });
          const items = r.hover ? [r.hover] : [];
          return { status: r.status, operation: input.operation, items, truncated: false };
        }
        const h = await withBudget(bridge.hover(input.path!, line0, char0, input.root), timeoutMs, input.signal);
        if (!h) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: [h], truncated: false };
      }
      case "documentSymbols": {
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny.getDocumentSymbolsOutcome) {
          const r = await bridgeAny.getDocumentSymbolsOutcome(input.path!, input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.symbols, input.maxResults), truncated: r.symbols.length > (input.maxResults ?? 20) };
        }
        const syms = await withBudget(bridge.getDocumentSymbols(input.path!, input.root), timeoutMs, input.signal);
        if (syms.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(syms, input.maxResults), truncated: syms.length > (input.maxResults ?? 20) };
      }
      case "workspaceSymbols": {
        if (!input.query) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny.workspaceSymbolOutcome) {
          const r = await bridgeAny.workspaceSymbolOutcome(input.query, input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.symbols, input.maxResults), truncated: r.symbols.length > (input.maxResults ?? 20) };
        }
        const syms = await withBudget(bridge.workspaceSymbol(input.query, input.root), timeoutMs, input.signal);
        if (syms.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(syms, input.maxResults), truncated: syms.length > (input.maxResults ?? 20) };
      }
      case "prepareCallHierarchy": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny.prepareCallHierarchyOutcome) {
          const r = await bridgeAny.prepareCallHierarchyOutcome(input.path!, input.line!, input.character!, input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.items, input.maxResults), truncated: r.items.length > (input.maxResults ?? 20) };
        }
        const _prItems = await withBudget((bridge as any).prepareCallHierarchy(input.path!, toZeroBased(input.line)!, toZeroBased(input.character)!, input.root), timeoutMs, input.signal) as unknown as any[];
        if ((_prItems as any[]).length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(_prItems as unknown[], input.maxResults), truncated: (_prItems as any[]).length > (input.maxResults ?? 20) };
      }
      case "incomingCalls": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny.incomingCallsOutcome) {
          const r = await bridgeAny.incomingCallsOutcome(input.path!, input.line!, input.character!, input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.calls, input.maxResults), truncated: r.calls.length > (input.maxResults ?? 20) };
        }
        // fallback: resolve via prepare then incoming
        const _icItems = await withBudget((bridge as any).prepareCallHierarchy(input.path!, toZeroBased(input.line)!, toZeroBased(input.character)!, input.root), timeoutMs, input.signal) as unknown as any[];
        if ((_icItems as any[]).length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        const _icCalls = await withBudget((bridge as any).incomingCalls((_icItems as any[])[0], input.root), timeoutMs, input.signal) as unknown as any[];
        if ((_icCalls as any[]).length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(_icCalls as unknown[], input.maxResults), truncated: (_icCalls as any[]).length > (input.maxResults ?? 20) };
      }
      case "outgoingCalls": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny.outgoingCallsOutcome) {
          const r = await bridgeAny.outgoingCallsOutcome(input.path!, input.line!, input.character!, input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.calls, input.maxResults), truncated: r.calls.length > (input.maxResults ?? 20) };
        }
        const _ocItems = await withBudget((bridge as any).prepareCallHierarchy(input.path!, toZeroBased(input.line)!, toZeroBased(input.character)!, input.root), timeoutMs, input.signal) as unknown as any[];
        if ((_ocItems as any[]).length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        const _ocCalls = await withBudget((bridge as any).outgoingCalls((_ocItems as any[])[0], input.root), timeoutMs, input.signal) as unknown as any[];
        if ((_ocCalls as any[]).length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(_ocCalls as unknown[], input.maxResults), truncated: (_ocCalls as any[]).length > (input.maxResults ?? 20) };
      }
      default: {
        // additive-friendly: unknown operation treated as degraded, not thrown
        const op = (input as any).operation as string;
        return { status: "degraded", operation: op as NavigationOperation, items: [], truncated: false };
      }
    }
  } catch (e: any) {
    if (e?.name === "AbortError" || input.signal?.aborted) return { status: "degraded", operation: input.operation, items: [], truncated: false };
    if (String(e?.message ?? "").includes("timed out")) return { status: "degraded", operation: input.operation, items: [], truncated: false };
    return { status: "degraded", operation: input.operation, items: [], truncated: false };
  }
}

export async function inspectDiagnostics(input: DiagnosticsInput): Promise<DiagnosticsOutcome> {
  const { getLSPBridge } = await import("./lsp-bridge.js");
  const bridge = await getLSPBridge();
  const timeoutMs = input.timeoutMs ?? (input.waitMs ?? DEFAULT_DIAG_WAIT_MS) + 1000;
  const waitMs = input.waitMs ?? DEFAULT_DIAG_WAIT_MS;
  if (!bridge) return { status: "unavailable", diagnostics: [], truncated: false };
  const bridgeAny = bridge as any;
  try {
    if (bridgeAny.getFreshDiagnosticsOutcome) {
      const r = await bridgeAny.getFreshDiagnosticsOutcome(input.path, input.root, { timeoutMs, waitMs, signal: input.signal, maxPerFile: input.maxPerFile });
      const diags = input.maxPerFile !== undefined ? r.diagnostics.slice(0, input.maxPerFile) : r.diagnostics;
      const truncated = r.diagnostics.length > diags.length;
      return { status: r.status, diagnostics: diags, truncated: truncated || !!r.truncated };
    }
    // fallback: use cached getDiagnostics with budget
    const diags = await withBudget(bridge.getDiagnostics(input.path, input.root), timeoutMs, input.signal);
    // Honesty: empty array from cache without fresh publish is not confirmed clean — treat as empty (not confirmed)
    // If bridge had fresh data it would have returned via outcome method; fallback is degraded honesty
    if (diags.length === 0) return { status: "empty", diagnostics: [], truncated: false };
    const sliced = input.maxPerFile !== undefined ? diags.slice(0, input.maxPerFile) : diags;
    return { status: "confirmed", diagnostics: sliced, truncated: diags.length > sliced.length };
  } catch (e: any) {
    if (e?.name === "AbortError" || input.signal?.aborted) return { status: "degraded", diagnostics: [], truncated: false };
    if (String(e?.message ?? "").includes("timed out")) return { status: "degraded", diagnostics: [], truncated: false };
    return { status: "degraded", diagnostics: [], truncated: false };
  }
}

function sliceLimit<T>(arr: T[], max?: number): T[] {
  const lim = max ?? 20;
  return arr.length > lim ? arr.slice(0, lim) : arr;
}

export interface LspInspectionProvider {
  inspectNavigation: typeof inspectNavigation;
  inspectDiagnostics: typeof inspectDiagnostics;
}

export function createLspInspectionProvider(): LspInspectionProvider {
  return { inspectNavigation, inspectDiagnostics };
}

let sharedLspInspectionProvider: LspInspectionProvider | null = null;

export function getSharedLspInspectionProvider(): LspInspectionProvider {
  if (!sharedLspInspectionProvider) sharedLspInspectionProvider = createLspInspectionProvider();
  return sharedLspInspectionProvider;
}

export function resetSharedLspInspectionProvider(): void {
  sharedLspInspectionProvider = null;
}

async function withBudget<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  return await new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onAbort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
