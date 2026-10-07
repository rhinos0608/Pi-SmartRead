/**
 * LSP inspection outcome engine — WP-SR1
 * Wraps LSP navigation + on-demand diagnostics with honesty status.
 * Public positions are 1-based (display coords); the executor seam converts
 * to 0-based protocol coords at this boundary. All requests bounded by timeout + AbortSignal.
 *
 * High-level surfaces over the canonical executor (lsp-executor.ts):
 * every navigation/diagnostics outcome is sourced from executeLspOperation.
 * Legacy bridge paths below are fallback ONLY (executor unavailable /
 * executor throws) — they live outside the executor and must not gain
 * new behavior.
 *
 * Hierarchy convenience (documented): incomingCalls/outgoingCalls take a
 * 1-based position, internally run prepareCallHierarchy via the executor,
 * then issue incoming/outgoingCalls with ONLY the first hierarchy item.
 * Callers needing full fan-out over all items must call prepareCallHierarchy
 * themselves and dispatch per item.
 */

// Extension seam: future mutating autofix/format and external security-scanner triage plugs here — add new status values (e.g. "needs-triage") and result fields without closing switch/default paths.
import type { LSPDiagnostic, LspOutcomeStatus } from "./lsp-bridge.js";
import type { StrictEnvelope, StrictOperation, StrictRequest } from "./lsp-strict-contract.js";
import { LSP_TIMEOUT_MS_DEFAULT } from "@rhinos0608/pi-workspace-protocol";

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

const DEFAULT_TIMEOUT_MS = LSP_TIMEOUT_MS_DEFAULT;
const DEFAULT_DIAG_WAIT_MS = 1500;

type ExecutorFn = (req: unknown, deps?: Record<string, unknown>) => Promise<StrictEnvelope>;

// Test seam: unit tests inject a fake executor; production dynamically
// imports the canonical executor so this module keeps no static transport dep.
let executorOverride: ExecutorFn | null = null;

export function __setLspExecutorForTests(fn: ExecutorFn | null): void {
  executorOverride = fn;
}

export function __resetLspExecutorForTests(): void {
  executorOverride = null;
}

async function runExecutor(req: StrictRequest, opts: { timeoutMs: number; signal?: AbortSignal; cwd: string }): Promise<StrictEnvelope> {
  if (executorOverride) return executorOverride(req, { cwd: opts.cwd, signal: opts.signal });
  const { executeLspOperation } = await import("./lsp-executor.js");
  return executeLspOperation(req, { cwd: opts.cwd, signal: opts.signal });
}

function toZeroBased(n: number | undefined): number | undefined {
  if (n === undefined) return undefined;
  return Math.max(0, n - 1);
}

/** Executor status → legacy outcome vocabulary (callers depend on these strings). */
function mapExecutorStatus(s: string): OutcomeStatus {
  switch (s) {
    case "ok": return "confirmed";
    case "empty": return "empty";
    case "unavailable": return "unavailable";
    case "unsupported": return "empty"; // legacy empty shape: capable-server absence reads as no results
    default: return "degraded"; // not_ready | timeout | cancelled | error | ambiguous
  }
}

const NAV_TO_OP: Record<NavigationOperation, StrictOperation> = {
  definition: "goToDefinition",
  references: "findReferences",
  implementation: "goToImplementation",
  hover: "hover",
  documentSymbols: "documentSymbols",
  workspaceSymbols: "workspaceSymbols",
  prepareCallHierarchy: "prepareCallHierarchy",
  incomingCalls: "incomingCalls",
  outgoingCalls: "outgoingCalls",
};

function buildStrictRequest(input: NavigationInput, timeoutMs: number): StrictRequest | null {
  const op = NAV_TO_OP[input.operation];
  const base = { operation: op, workspace: input.root, timeoutMs } as StrictRequest & Record<string, unknown>;
  switch (input.operation) {
    case "definition":
    case "references":
    case "implementation":
    case "hover":
    case "prepareCallHierarchy": {
      if (input.line === undefined || input.character === undefined) return null;
      return { ...base, path: input.path, position: { line: toZeroBased(input.line)!, character: toZeroBased(input.character)! } } as unknown as StrictRequest;
    }
    case "documentSymbols":
      return { ...base, path: input.path } as unknown as StrictRequest;
    case "workspaceSymbols": {
      if (!input.query) return null;
      return { ...base, query: input.query } as unknown as StrictRequest;
    }
    case "incomingCalls":
    case "outgoingCalls":
      // Position-based convenience handled by dedicated two-step runner below.
      return null;
    default:
      return null;
  }
}

function envelopeItems(operation: NavigationOperation, result: unknown): unknown[] {
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) return result;
  // Single-value ops (definition single location, hover object) wrap verbatim.
  if (operation === "definition" || operation === "hover") return [result];
  return [];
}

export async function inspectNavigation(input: NavigationInput): Promise<NavigationOutcome> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Additive-friendly: unknown operation treated as degraded, not thrown.
  if (!(input.operation in NAV_TO_OP)) {
    const op = (input as unknown as { operation: string }).operation as NavigationOperation;
    return { status: "degraded", operation: op, items: [], truncated: false };
  }
  // Missing required display coords / query degrade without wire work (shape preserved).
  if ((input.operation === "definition" || input.operation === "references" || input.operation === "implementation" || input.operation === "hover" || input.operation === "prepareCallHierarchy" || input.operation === "incomingCalls" || input.operation === "outgoingCalls") && (input.line === undefined || input.character === undefined)) {
    return { status: "degraded", operation: input.operation, items: [], truncated: false };
  }
  if (input.operation === "workspaceSymbols" && !input.query) {
    return { status: "degraded", operation: input.operation, items: [], truncated: false };
  }
  if (input.signal?.aborted) return { status: "degraded", operation: input.operation, items: [], truncated: false };

  // Hierarchy convenience: prepare-then-FIRST-item only (documented contract).
  // incoming/outgoingCalls carry no position in the strict contract — they
  // take an opaque hierarchy item. This surface resolves the position to a
  // prepareCallHierarchy envelope, selects the first item, and dispatches
  // the continuation with that item verbatim (opaque server `data` preserved).
  if (input.operation === "incomingCalls" || input.operation === "outgoingCalls") {
    try {
      const prep = await runExecutor(
        { operation: "prepareCallHierarchy", path: input.path, position: { line: toZeroBased(input.line)!, character: toZeroBased(input.character)! }, workspace: input.root, timeoutMs } as unknown as StrictRequest,
        { timeoutMs, signal: input.signal, cwd: input.root },
      );
      if (prep.status === "unavailable") return legacyNavigation(input, timeoutMs);
      if (prep.status === "unsupported") return { status: "empty", operation: input.operation, items: [], truncated: false };
      if (prep.status !== "ok" && prep.status !== "empty") return { status: mapExecutorStatus(prep.status), operation: input.operation, items: [], truncated: false };
      const prepItems = Array.isArray(prep.result) ? prep.result : [];
      if (prepItems.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
      const first = prepItems[0];
      const contOp: StrictOperation = input.operation === "incomingCalls" ? "incomingCalls" : "outgoingCalls";
      const cont = await runExecutor(
        { operation: contOp, item: first as Record<string, unknown>, workspace: input.root, timeoutMs } as unknown as StrictRequest,
        { timeoutMs, signal: input.signal, cwd: input.root },
      );
      if (cont.status === "unavailable") return legacyNavigation(input, timeoutMs);
      const status = mapExecutorStatus(cont.status);
      const items = Array.isArray(cont.result) ? cont.result : [];
      if (status === "confirmed" || status === "empty") {
        if (items.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(items, input.maxResults), truncated: items.length > (input.maxResults ?? 20) };
      }
      return { status, operation: input.operation, items: sliceLimit(items, input.maxResults), truncated: items.length > (input.maxResults ?? 20) };
    } catch (e: unknown) {
      if ((e as Error)?.message === "invalid cursor") throw e;
      if ((e as { name?: string })?.name === "AbortError" || input.signal?.aborted) return { status: "degraded", operation: input.operation, items: [], truncated: false };
      if (String((e as Error)?.message ?? "").includes("timed out")) return { status: "degraded", operation: input.operation, items: [], truncated: false };
      return legacyNavigation(input, timeoutMs);
    }
  }

  const strictReq = buildStrictRequest(input, timeoutMs);
  if (!strictReq) return { status: "degraded", operation: input.operation, items: [], truncated: false };
  try {
    const env = await runExecutor(strictReq, { timeoutMs, signal: input.signal, cwd: input.root });
    // Fallback outside the executor: no routable session → legacy bridge path.
    if (env.status === "unavailable") return legacyNavigation(input, timeoutMs);
    const status = mapExecutorStatus(env.status);
    // Preserve additive status vocabulary: pass through statuses the legacy
    // switch never enumerated (e.g. "needs-triage") — none arrive from the
    // executor today, but callers depend on pass-through, not throw.
    const items = envelopeItems(input.operation, env.result);
    if (status === "confirmed") {
      if (items.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
      if (input.operation === "hover") return { status, operation: input.operation, items, truncated: false };
      return { status, operation: input.operation, items: sliceLimit(items, input.maxResults), truncated: items.length > (input.maxResults ?? 20) };
    }
    if (status === "empty") return { status, operation: input.operation, items: [], truncated: false };
    if (status === "unavailable") return { status, operation: input.operation, items: [], truncated: false };
    return { status, operation: input.operation, items: sliceLimit(items, input.maxResults), truncated: items.length > (input.maxResults ?? 20) };
  } catch (e: unknown) {
    if ((e as Error)?.message === "invalid cursor") throw e;
    if ((e as { name?: string })?.name === "AbortError" || input.signal?.aborted) return { status: "degraded", operation: input.operation, items: [], truncated: false };
    if (String((e as Error)?.message ?? "").includes("timed out")) return { status: "degraded", operation: input.operation, items: [], truncated: false };
    return legacyNavigation(input, timeoutMs);
  }
}

/** Legacy bridge path — fallback ONLY when the executor is unavailable or throws. */
async function legacyNavigation(input: NavigationInput, timeoutMs: number): Promise<NavigationOutcome> {
  const { getLSPBridge } = await import("./lsp-bridge.js");
  const bridge = await getLSPBridge();
  const bridgeAny = bridge as unknown as Record<string, ((...a: never[]) => Promise<unknown>) | undefined>;
  try {
    switch (input.operation) {
      case "definition": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        const line0 = toZeroBased(input.line)!;
        const char0 = toZeroBased(input.character)!;
        if (bridgeAny["goToDefinitionOutcome"]) {
          const r = await (bridgeAny["goToDefinitionOutcome"] as (p: string, l: number, c: number, root: string, o: unknown) => Promise<{ status: OutcomeStatus; location: unknown }>)((input.path as string), line0 + 1, (input.character as number), input.root, { timeoutMs, signal: input.signal });
          const items = r.location ? [r.location] : [];
          return { status: r.status, operation: input.operation, items: sliceLimit(items, input.maxResults), truncated: (items.length > (input.maxResults ?? 20)) };
        }
        const loc = await withBudget((bridge as unknown as { goToDefinition(p: string, l: number, c: number, r: string): Promise<unknown> }).goToDefinition((input.path as string), line0, char0, input.root), timeoutMs, input.signal);
        if (!loc) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit([loc], input.maxResults), truncated: false };
      }
      case "references": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        const line0 = toZeroBased(input.line)!;
        const char0 = toZeroBased(input.character)!;
        if (bridgeAny["findReferencesOutcome"]) {
          const r = await (bridgeAny["findReferencesOutcome"] as (p: string, l: number, c: number, root: string, o: unknown) => Promise<{ status: OutcomeStatus; locations: unknown[] }>)((input.path as string), (input.line as number), (input.character as number), input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.locations, input.maxResults), truncated: r.locations.length > (input.maxResults ?? 20) };
        }
        const locs = await withBudget((bridge as unknown as { findReferences(p: string, l: number, c: number, r: string): Promise<unknown[]> }).findReferences((input.path as string), line0, char0, input.root), timeoutMs, input.signal);
        if (locs.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(locs, input.maxResults), truncated: locs.length > (input.maxResults ?? 20) };
      }
      case "implementation": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        const line0 = toZeroBased(input.line)!;
        const char0 = toZeroBased(input.character)!;
        if (bridgeAny["goToImplementationOutcome"]) {
          const r = await (bridgeAny["goToImplementationOutcome"] as (p: string, l: number, c: number, root: string, o: unknown) => Promise<{ status: OutcomeStatus; locations: unknown[] }>)((input.path as string), (input.line as number), (input.character as number), input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.locations, input.maxResults), truncated: r.locations.length > (input.maxResults ?? 20) };
        }
        const locs = await withBudget((bridge as unknown as { goToImplementation(p: string, l: number, c: number, r: string): Promise<unknown[]> }).goToImplementation((input.path as string), line0, char0, input.root), timeoutMs, input.signal);
        if (locs.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(locs, input.maxResults), truncated: locs.length > (input.maxResults ?? 20) };
      }
      case "hover": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        const line0 = toZeroBased(input.line)!;
        const char0 = toZeroBased(input.character)!;
        if (bridgeAny["hoverOutcome"]) {
          const r = await (bridgeAny["hoverOutcome"] as (p: string, l: number, c: number, root: string, o: unknown) => Promise<{ status: OutcomeStatus; hover: unknown }>)((input.path as string), (input.line as number), (input.character as number), input.root, { timeoutMs, signal: input.signal });
          const items = r.hover ? [r.hover] : [];
          return { status: r.status, operation: input.operation, items, truncated: false };
        }
        const h = await withBudget((bridge as unknown as { hover(p: string, l: number, c: number, r: string): Promise<unknown> }).hover((input.path as string), line0, char0, input.root), timeoutMs, input.signal);
        if (!h) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: [h], truncated: false };
      }
      case "documentSymbols": {
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny["getDocumentSymbolsOutcome"]) {
          const r = await (bridgeAny["getDocumentSymbolsOutcome"] as (p: string, root: string, o: unknown) => Promise<{ status: OutcomeStatus; symbols: unknown[] }>)((input.path as string), input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.symbols, input.maxResults), truncated: r.symbols.length > (input.maxResults ?? 20) };
        }
        const syms = await withBudget((bridge as unknown as { getDocumentSymbols(p: string, r: string): Promise<unknown[]> }).getDocumentSymbols((input.path as string), input.root), timeoutMs, input.signal);
        if (syms.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(syms, input.maxResults), truncated: syms.length > (input.maxResults ?? 20) };
      }
      case "workspaceSymbols": {
        if (!input.query) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny["workspaceSymbolOutcome"]) {
          const r = await (bridgeAny["workspaceSymbolOutcome"] as (q: string, root: string, o: unknown) => Promise<{ status: OutcomeStatus; symbols: unknown[] }>)((input.query as string), input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.symbols, input.maxResults), truncated: r.symbols.length > (input.maxResults ?? 20) };
        }
        const syms = await withBudget((bridge as unknown as { workspaceSymbol(q: string, r: string): Promise<unknown[]> }).workspaceSymbol((input.query as string), input.root), timeoutMs, input.signal);
        if (syms.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(syms, input.maxResults), truncated: syms.length > (input.maxResults ?? 20) };
      }
      case "prepareCallHierarchy": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny["prepareCallHierarchyOutcome"]) {
          const r = await (bridgeAny["prepareCallHierarchyOutcome"] as (p: string, l: number, c: number, root: string, o: unknown) => Promise<{ status: OutcomeStatus; items: unknown[] }>)((input.path as string), (input.line as number), (input.character as number), input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.items, input.maxResults), truncated: r.items.length > (input.maxResults ?? 20) };
        }
        const prItems = await withBudget((bridge as unknown as { prepareCallHierarchy(p: string, l: number, c: number, r: string): Promise<unknown[]> }).prepareCallHierarchy((input.path as string), toZeroBased(input.line)!, toZeroBased(input.character)!, input.root), timeoutMs, input.signal);
        if (prItems.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(prItems, input.maxResults), truncated: prItems.length > (input.maxResults ?? 20) };
      }
      case "incomingCalls": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny["incomingCallsOutcome"]) {
          const r = await (bridgeAny["incomingCallsOutcome"] as (p: string, l: number, c: number, root: string, o: unknown) => Promise<{ status: OutcomeStatus; calls: unknown[] }>)((input.path as string), (input.line as number), (input.character as number), input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.calls, input.maxResults), truncated: r.calls.length > (input.maxResults ?? 20) };
        }
        // fallback: resolve via prepare then incoming (first item only — documented convenience)
        const icItems = await withBudget((bridge as unknown as { prepareCallHierarchy(p: string, l: number, c: number, r: string): Promise<unknown[]> }).prepareCallHierarchy((input.path as string), toZeroBased(input.line)!, toZeroBased(input.character)!, input.root), timeoutMs, input.signal);
        if (icItems.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        const icCalls = await withBudget((bridge as unknown as { incomingCalls(item: unknown, r: string): Promise<unknown[]> }).incomingCalls(icItems[0], input.root), timeoutMs, input.signal);
        if (icCalls.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(icCalls, input.maxResults), truncated: icCalls.length > (input.maxResults ?? 20) };
      }
      case "outgoingCalls": {
        if (input.line === undefined || input.character === undefined) return { status: "degraded", operation: input.operation, items: [], truncated: false };
        if (!bridge) return { status: "unavailable", operation: input.operation, items: [], truncated: false };
        if (bridgeAny["outgoingCallsOutcome"]) {
          const r = await (bridgeAny["outgoingCallsOutcome"] as (p: string, l: number, c: number, root: string, o: unknown) => Promise<{ status: OutcomeStatus; calls: unknown[] }>)((input.path as string), (input.line as number), (input.character as number), input.root, { timeoutMs, signal: input.signal });
          return { status: r.status, operation: input.operation, items: sliceLimit(r.calls, input.maxResults), truncated: r.calls.length > (input.maxResults ?? 20) };
        }
        const ocItems = await withBudget((bridge as unknown as { prepareCallHierarchy(p: string, l: number, c: number, r: string): Promise<unknown[]> }).prepareCallHierarchy((input.path as string), toZeroBased(input.line)!, toZeroBased(input.character)!, input.root), timeoutMs, input.signal);
        if (ocItems.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        const ocCalls = await withBudget((bridge as unknown as { outgoingCalls(item: unknown, r: string): Promise<unknown[]> }).outgoingCalls(ocItems[0], input.root), timeoutMs, input.signal);
        if (ocCalls.length === 0) return { status: "empty", operation: input.operation, items: [], truncated: false };
        return { status: "confirmed", operation: input.operation, items: sliceLimit(ocCalls, input.maxResults), truncated: ocCalls.length > (input.maxResults ?? 20) };
      }
      default: {
        const op = (input as unknown as { operation: string }).operation as NavigationOperation;
        return { status: "degraded", operation: op, items: [], truncated: false };
      }
    }
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === "AbortError" || input.signal?.aborted) return { status: "degraded", operation: input.operation, items: [], truncated: false };
    if (String((e as Error)?.message ?? "").includes("timed out")) return { status: "degraded", operation: input.operation, items: [], truncated: false };
    return { status: "degraded", operation: input.operation, items: [], truncated: false };
  }
}

export async function inspectDiagnostics(input: DiagnosticsInput): Promise<DiagnosticsOutcome> {
  const timeoutMs = input.timeoutMs ?? (input.waitMs ?? DEFAULT_DIAG_WAIT_MS) + 1000;
  if (input.signal?.aborted) return { status: "degraded", diagnostics: [], truncated: false };
  // Primary: executor diagnostics op (broker pull/push inside the executor).
  try {
    const env = await runExecutor(
      { operation: "diagnostics", path: input.path, workspace: input.root, timeoutMs } as unknown as StrictRequest,
      { timeoutMs, signal: input.signal, cwd: input.root },
    );
    // Fallback outside the executor: no routable session → legacy bridge path.
    if (env.status === "unavailable") return legacyDiagnostics(input, timeoutMs);
    if (env.status === "unsupported") return { status: "empty", diagnostics: [], truncated: false };
    const status = mapExecutorStatus(env.status);
    const diags = (Array.isArray(env.result) ? env.result : []) as LSPDiagnostic[];
    if (status === "confirmed") {
      if (diags.length === 0) return { status: "empty", diagnostics: [], truncated: false };
      const sliced = input.maxPerFile !== undefined ? diags.slice(0, input.maxPerFile) : diags;
      return { status, diagnostics: sliced, truncated: diags.length > sliced.length };
    }
    if (status === "empty") return { status, diagnostics: [], truncated: false };
    if (status === "unavailable") return { status, diagnostics: [], truncated: false };
    return { status, diagnostics: [], truncated: false };
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === "AbortError" || input.signal?.aborted) return { status: "degraded", diagnostics: [], truncated: false };
    if (String((e as Error)?.message ?? "").includes("timed out")) return { status: "degraded", diagnostics: [], truncated: false };
    return legacyDiagnostics(input, timeoutMs);
  }
}

/** Legacy bridge path — fallback ONLY when the executor is unavailable or throws. */
async function legacyDiagnostics(input: DiagnosticsInput, timeoutMs: number): Promise<DiagnosticsOutcome> {
  const { getLSPBridge } = await import("./lsp-bridge.js");
  const bridge = await getLSPBridge();
  const waitMs = input.waitMs ?? DEFAULT_DIAG_WAIT_MS;
  if (!bridge) return { status: "unavailable", diagnostics: [], truncated: false };
  const bridgeAny = bridge as unknown as Record<string, ((...a: never[]) => Promise<unknown>) | undefined>;
  try {
    if (bridgeAny["getFreshDiagnosticsOutcome"]) {
      const r = await (bridgeAny["getFreshDiagnosticsOutcome"] as (p: string, root: string, o: unknown) => Promise<{ status: OutcomeStatus; diagnostics: LSPDiagnostic[]; truncated?: boolean }>)((input.path as string), input.root, { timeoutMs, waitMs, signal: input.signal, maxPerFile: input.maxPerFile });
      const diags = input.maxPerFile !== undefined ? r.diagnostics.slice(0, input.maxPerFile) : r.diagnostics;
      const truncated = r.diagnostics.length > diags.length;
      return { status: r.status, diagnostics: diags, truncated: truncated || !!r.truncated };
    }
    const diags = await withBudget((bridge as unknown as { getDiagnostics(p: string, r: string): Promise<LSPDiagnostic[]> }).getDiagnostics(input.path, input.root), timeoutMs, input.signal);
    if (diags.length === 0) return { status: "empty", diagnostics: [], truncated: false };
    const sliced = input.maxPerFile !== undefined ? diags.slice(0, input.maxPerFile) : diags;
    return { status: "confirmed", diagnostics: sliced, truncated: diags.length > sliced.length };
  } catch (e: unknown) {
    if ((e as { name?: string })?.name === "AbortError" || input.signal?.aborted) return { status: "degraded", diagnostics: [], truncated: false };
    if (String((e as Error)?.message ?? "").includes("timed out")) return { status: "degraded", diagnostics: [], truncated: false };
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
