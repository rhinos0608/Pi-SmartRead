/**
 * LSP Bridge — thin executor adapter for symbol-level queries.
 *
 * Facade: cache lifecycle (bridge singleton) + public assembly. Every
 * navigation / diagnostics / proposal method below is a THIN adapter over
 * the canonical executor (`executeLspOperation` in lsp-executor.ts):
 * translate legacy args (1-based→0-based at this seam for the Outcome and
 * proposal entry points; plain navigation keeps its legacy 0-based
 * passthrough) → StrictRequest → executeLspOperation → map the
 * StrictEnvelope back to the legacy return shapes. No parallel protocol
 * logic lives here: no WorkspaceEdit parsing, no diagnostic polling, no
 * routing. Fallback policy (null / [] / degraded) stays outside the
 * executor, mapped from envelope statuses here so legacy vocabulary
 * (confirmed/empty/degraded/unavailable) is preserved EXACTLY.
 *
 * Document/file-tracking lifecycle (openFile/updateFile/closeFile/didSave/
 * getOpenFiles/getDiagnostics) is lifecycle, not semantics, and stays here.
 *
 * Project structure detection:
 *   Scans the project root for config files (package.json, go.mod, Cargo.toml, etc.)
 *   and source files to determine which languages are in use. Only attempts to
 *   start LSP servers relevant to the detected project languages.
 *
 * Server availability:
 *   Checks PATH for each LSP server binary. Only attempts connections when the
 *   binary exists. Never spawns processes that will immediately fail.
 *
 * Document tracking:
 *   Tracks which files are open on each server connection. OpenFile is idempotent
 *   (no-op if already open). DidChange sends full-text sync updates. DidClose
 *   releases the document and lets the server free resources.
 *
 * The LSP protocol is a standard — this module is self-contained and
 * does not import from smart-edit.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { cachedManager, managerCache } from "./lsp-manager.js";
import {
  detectLanguageFromExtension,
  detectProjectLanguages,
  type LSPBridge,
  type LSPCallHierarchyIncomingCall,
  type LSPCallHierarchyItem,
  type LSPCallHierarchyOutgoingCall,
  type LSPDiagnostic,
  type LSPDocumentSymbol,
  type LSPHoverResult,
  type LSPLocation,
  type LSPRange,
  type LSPWorkspaceSymbol,
  type LspCallHierarchyPrepareOutcome,
  type LspDiagnosticsOutcome,
  type LspDocumentSymbolsOutcome,
  type LspHoverOutcome,
  type LspIncomingCallsOutcome,
  type LspNavigationOutcomeList,
  type LspNavigationOutcomeSingle,
  type LspOutgoingCallsOutcome,
  type LspOutcomeOptions,
  type LspWorkspaceSymbolsOutcome,
  type ProjectLSPInfo,
} from "./lsp-types.js";
import {
  DEFAULT_OUTCOME_TIMEOUT_MS,
  toZeroBased,
  withManager,
} from "./lsp-server-operation.js";
import { LSP_TIMEOUT_MS_DEFAULT } from "@rhinos0608/pi-workspace-protocol";
import {
  executeLspOperation,
  type ExecutorDeps,
  type ExecutorManager,
} from "./lsp-executor.js";
import type {
  StrictEnvelope,
  StrictOperation,
  StrictRequest,
} from "./lsp-strict-contract.js";
import type {
  NormalizedCodeAction,
  NormalizedTextEdit,
  NormalizedWorkspaceEdit,
} from "./lsp-response-normalizer.js";

// Facade re-exports: every pre-existing lsp-bridge export keeps resolving here.
export { ALL_SERVER_CONFIGS, detectLanguageFromExtension, detectProjectLanguages, resolvedServerCache, resolvedServerListCache } from "./lsp-types.js";
export type { ResolvedServerEntry } from "./lsp-types.js";
export type {
  LSPBridge,
  LSPCallHierarchyIncomingCall,
  LSPCallHierarchyItem,
  LSPCallHierarchyOutgoingCall,
  LSPDiagnostic,
  LSPDocumentChange,
  LSPDocumentSymbol,
  LSPHoverResult,
  LSPLocation,
  LSPMarkupContent,
  LSPRange,
  LSPWorkspaceSymbol,
  LspCallHierarchyPrepareOutcome,
  LspDiagnosticsOutcome,
  LspDocumentSymbolsOutcome,
  LspHoverOutcome,
  LspIncomingCallsOutcome,
  LspNavigationOutcomeList,
  LspNavigationOutcomeSingle,
  LspOutgoingCallsOutcome,
  LspOutcomeOptions,
  LspOutcomeStatus,
  LspWorkspaceSymbolsOutcome,
  ProjectLSPInfo,
  ServerConfig,
} from "./lsp-types.js";
export { LSPConnection } from "./lsp-connection.js";
export {
  LSPManager,
  evictManagerForRoot,
  invalidateResolvedServerCacheForRoot,
  prepareDocument,
  shutdownAllManagers,
} from "./lsp-manager.js";

const PROPOSAL_TIMEOUT_MS = LSP_TIMEOUT_MS_DEFAULT;

// ── Thin-adapter plumbing ────────────────────────────────────────────
// Executor deps wired to the real manager cache. The executor owns routing,
// capability gating, transport, and normalization; the bridge only maps.

function executorDeps(signal?: AbortSignal): ExecutorDeps {
  const deps: ExecutorDeps = {
    getManager: (root: string): ExecutorManager =>
      cachedManager(root) as unknown as ExecutorManager,
  };
  if (signal) deps.signal = signal;
  return deps;
}

async function runStrict(
  req: StrictRequest,
  opts?: LspOutcomeOptions,
): Promise<StrictEnvelope> {
  return executeLspOperation(req, executorDeps(opts?.signal));
}

/** Plain (non-Outcome) navigation: ok/empty with a value → value, else fallback. Never throws. */
async function runPlain<T>(req: StrictRequest, fallback: T): Promise<T> {
  try {
    const env = await runStrict(req);
    if (env.status === "empty") return fallback;
    if (env.status === "ok" && env.result !== null) return env.result as T;
    return fallback;
  } catch {
    return fallback;
  }
}

function timeoutReq(base: StrictRequest, opts?: LspOutcomeOptions): StrictRequest {
  if (opts?.timeoutMs === undefined) return base;
  return { ...base, timeoutMs: opts.timeoutMs };
}

/** Fail-closed file URI → path for legacy rename adapter: file: only, null otherwise.
 * Rejects non-file/malformed URIs before any resolve() call so resolve() cannot
 * fabricate paths from raw fallback strings (cf. lsp-connection workspaceUriToPath). */
function legacyRenameUriToPath(uri: string): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Executor NormalizedWorkspaceEdit ({changes:[{uri,edits}]}) → legacy LspWorkspaceEdit. Null on any malformed entry (fail-closed, matches convertWorkspaceEdit). */
function toLegacyFormattingEdit(
  filePath: string,
  edits: NormalizedTextEdit[] | null | undefined,
): LspWorkspaceEdit | null {
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const resolved = resolve(filePath);
  return {
    positionEncoding: "utf-16" as const,
    fileEdits: [{
      filePath: resolved,
      edits: edits.map((edit) => ({
        filePath: resolved,
        range: edit.range as LSPRange,
        newText: edit.newText,
      })),
    }],
  };
}

function toLegacyWorkspaceEdit(
  edit: NormalizedWorkspaceEdit | null | undefined,
): LspWorkspaceEdit | null {
  if (!edit || !Array.isArray(edit.changes) || edit.changes.length === 0) return null;
  const fileEdits: Array<{ filePath: string; edits: Array<{ filePath: string; range: LSPRange; newText: string }> }> = [];
  for (const change of edit.changes) {
    if (!change || typeof change.uri !== "string" || !Array.isArray(change.edits)) return null;
    const filePath = legacyRenameUriToPath(change.uri);
    if (!filePath) return null;
    const edits: Array<{ filePath: string; range: LSPRange; newText: string }> = [];
    for (const e of change.edits) {
      if (!e || typeof e.newText !== "string" || !e.range) return null;
      edits.push({ filePath, range: e.range as LSPRange, newText: e.newText });
    }
    fileEdits.push({ filePath, edits });
  }
  if (fileEdits.length === 0) return null;
  return { positionEncoding: "utf-16" as const, fileEdits };
}

/** Executor normalized symbols → legacy LSPWorkspaceSymbol[] (location form). */
function toLegacyWorkspaceSymbols(value: unknown): LSPWorkspaceSymbol[] {
  if (!Array.isArray(value)) return [];
  const out: LSPWorkspaceSymbol[] = [];
  for (const s of value) {
    const sym = s as { name?: unknown; kind?: unknown; range?: unknown; uri?: unknown; containerName?: unknown };
    if (typeof sym?.name !== "string" || typeof sym?.kind !== "number" || !sym?.range) continue;
    if (typeof sym.uri !== "string") continue;
    out.push({
      name: sym.name,
      kind: sym.kind,
      location: { uri: sym.uri, range: sym.range as LSPRange },
      ...(typeof sym.containerName === "string" ? { containerName: sym.containerName } : {}),
    });
  }
  return out;
}

/** Executor NormalizedCodeAction[] → legacy code-action items (title/kind/edit/isPreferred). */
function toLegacyCodeActions(
  value: unknown,
): Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }> {
  if (!Array.isArray(value)) return [];
  return (value as NormalizedCodeAction[]).map((a) => ({
    title: a.title,
    ...(a.kind !== undefined ? { kind: a.kind } : {}),
    ...(a.edit ? { edit: toLegacyWorkspaceEdit(a.edit) ?? undefined } : {}),
    ...(a.isPreferred !== undefined ? { isPreferred: a.isPreferred } : {}),
  }));
}

function asLocationList(value: unknown): LSPLocation[] {
  return (Array.isArray(value) ? value : []) as LSPLocation[];
}

// ── Plain navigation adapters (legacy 0-based passthrough) ───────────

async function goToDefinition(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPLocation | null> {
  const locs = await runPlain<LSPLocation[]>(
    { operation: "goToDefinition", path: filePath, position: { line, character }, workspace: root },
    [],
  );
  return locs[0] ?? null;
}

async function findReferences(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPLocation[]> {
  return runPlain<LSPLocation[]>(
    { operation: "findReferences", path: filePath, position: { line, character }, includeDeclaration: true, workspace: root },
    [],
  );
}

async function getDocumentSymbols(
  filePath: string, root: string,
): Promise<LSPDocumentSymbol[]> {
  return runPlain<LSPDocumentSymbol[]>(
    { operation: "documentSymbols", path: filePath, workspace: root },
    [],
  );
}

async function goToImplementation(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPLocation[]> {
  return runPlain<LSPLocation[]>(
    { operation: "goToImplementation", path: filePath, position: { line, character }, workspace: root },
    [],
  );
}

async function workspaceSymbol(query: string, root: string): Promise<LSPWorkspaceSymbol[]> {
  try {
    const env = await runStrict({ operation: "workspaceSymbols", query, workspace: root });
    if ((env.status === "ok" || env.status === "empty") && env.result !== null) {
      return toLegacyWorkspaceSymbols(env.result);
    }
    return [];
  } catch {
    return [];
  }
}

async function hover(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPHoverResult | null> {
  return runPlain<LSPHoverResult | null>(
    { operation: "hover", path: filePath, position: { line, character }, workspace: root },
    null,
  );
}

async function prepareCallHierarchy(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPCallHierarchyItem[]> {
  return runPlain<LSPCallHierarchyItem[]>(
    { operation: "prepareCallHierarchy", path: filePath, position: { line, character }, workspace: root },
    [],
  );
}

async function incomingCalls(
  item: LSPCallHierarchyItem, root: string,
): Promise<LSPCallHierarchyIncomingCall[]> {
  return runPlain<LSPCallHierarchyIncomingCall[]>(
    { operation: "incomingCalls", item: item as unknown as Record<string, unknown>, workspace: root },
    [],
  );
}

async function outgoingCalls(
  item: LSPCallHierarchyItem, root: string,
): Promise<LSPCallHierarchyOutgoingCall[]> {
  return runPlain<LSPCallHierarchyOutgoingCall[]>(
    { operation: "outgoingCalls", item: item as unknown as Record<string, unknown>, workspace: root },
    [],
  );
}

// ── Outcome adapters (1-based→0-based at this seam) ──────────────────
// Mapping: ok→confirmed, empty→empty, unavailable→unavailable, all else→degraded.

async function goToDefinitionOutcome(
  filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions,
): Promise<LspNavigationOutcomeSingle> {
  if (!detectLanguageFromExtension(filePath)) return { status: "unavailable", location: null };
  try {
    const env = await runStrict(
      timeoutReq({ operation: "goToDefinition", path: filePath, position: { line: toZeroBased(line), character: toZeroBased(character) }, workspace: root }, opts),
      opts,
    );
    if (env.status === "ok") {
      const first = asLocationList(env.result)[0] ?? null;
      if (!first) return { status: "empty", location: null };
      return { status: "confirmed", location: first };
    }
    if (env.status === "empty") return { status: "empty", location: null };
    if (env.status === "unavailable") return { status: "unavailable", location: null };
    return { status: "degraded", location: null };
  } catch {
    return { status: "degraded", location: null };
  }
}

async function locationListOutcome(
  op: StrictOperation,
  filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions,
): Promise<LspNavigationOutcomeList> {
  if (!detectLanguageFromExtension(filePath)) return { status: "unavailable", locations: [] };
  try {
    const env = await runStrict(
      timeoutReq({ operation: op, path: filePath, position: { line: toZeroBased(line), character: toZeroBased(character) }, workspace: root }, opts),
      opts,
    );
    if (env.status === "ok") {
      const items = asLocationList(env.result);
      if (items.length === 0) return { status: "empty", locations: [] };
      return { status: "confirmed", locations: items };
    }
    if (env.status === "empty") return { status: "empty", locations: [] };
    if (env.status === "unavailable") return { status: "unavailable", locations: [] };
    return { status: "degraded", locations: [] };
  } catch {
    return { status: "degraded", locations: [] };
  }
}

async function getDocumentSymbolsOutcome(
  filePath: string, root: string, opts?: LspOutcomeOptions,
): Promise<LspDocumentSymbolsOutcome> {
  if (!detectLanguageFromExtension(filePath)) return { status: "unavailable", symbols: [] };
  try {
    const env = await runStrict(
      timeoutReq({ operation: "documentSymbols", path: filePath, workspace: root }, opts),
      opts,
    );
    if (env.status === "ok") {
      const symbols = (Array.isArray(env.result) ? env.result : []) as LSPDocumentSymbol[];
      if (symbols.length === 0) return { status: "empty", symbols: [] };
      return { status: "confirmed", symbols };
    }
    if (env.status === "empty") return { status: "empty", symbols: [] };
    if (env.status === "unavailable") return { status: "unavailable", symbols: [] };
    return { status: "degraded", symbols: [] };
  } catch {
    return { status: "degraded", symbols: [] };
  }
}

async function workspaceSymbolOutcome(
  query: string, root: string, opts?: LspOutcomeOptions,
): Promise<LspWorkspaceSymbolsOutcome> {
  try {
    const env = await runStrict(
      { operation: "workspaceSymbols", query, workspace: root, timeoutMs: opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS },
      opts,
    );
    if (env.status === "ok") {
      const symbols = toLegacyWorkspaceSymbols(env.result);
      if (symbols.length === 0) return { status: "empty", symbols: [] };
      return { status: "confirmed", symbols };
    }
    if (env.status === "empty") return { status: "empty", symbols: [] };
    if (env.status === "unavailable") return { status: "unavailable", symbols: [] };
    return { status: "degraded", symbols: [] };
  } catch {
    return { status: "degraded", symbols: [] };
  }
}

async function hoverOutcome(
  filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions,
): Promise<LspHoverOutcome> {
  if (!detectLanguageFromExtension(filePath)) return { status: "unavailable", hover: null };
  try {
    const env = await runStrict(
      timeoutReq({ operation: "hover", path: filePath, position: { line: toZeroBased(line), character: toZeroBased(character) }, workspace: root }, opts),
      opts,
    );
    if (env.status === "ok" && env.result !== null) {
      return { status: "confirmed", hover: env.result as LSPHoverResult };
    }
    if (env.status === "empty") return { status: "empty", hover: null };
    if (env.status === "unavailable") return { status: "unavailable", hover: null };
    return { status: "degraded", hover: null };
  } catch {
    return { status: "degraded", hover: null };
  }
}

async function prepareCallHierarchyOutcome(
  filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions,
): Promise<LspCallHierarchyPrepareOutcome> {
  if (!detectLanguageFromExtension(filePath)) return { status: "unavailable", items: [] };
  try {
    const env = await runStrict(
      timeoutReq({ operation: "prepareCallHierarchy", path: filePath, position: { line: toZeroBased(line), character: toZeroBased(character) }, workspace: root }, opts),
      opts,
    );
    if (env.status === "ok") {
      const items = (Array.isArray(env.result) ? env.result : []) as LSPCallHierarchyItem[];
      if (items.length === 0) return { status: "empty", items: [] };
      return { status: "confirmed", items };
    }
    if (env.status === "empty") return { status: "empty", items: [] };
    if (env.status === "unavailable") return { status: "unavailable", items: [] };
    return { status: "degraded", items: [] };
  } catch {
    return { status: "degraded", items: [] };
  }
}

type CallsEnvelope = { status: "ok" | "empty" | "unavailable" | string; result: unknown };

function mapCallsResult<T>(env: CallsEnvelope): { status: string; calls: T[] } {
  if (env.status === "ok") {
    const list = (Array.isArray(env.result) ? env.result : []) as T[];
    if (list.length === 0) return { status: "empty", calls: [] };
    return { status: "confirmed", calls: list };
  }
  if (env.status === "empty") return { status: "empty", calls: [] };
  if (env.status === "unavailable") return { status: "unavailable", calls: [] };
  return { status: "degraded", calls: [] };
}

async function hierarchyCallsOutcome<T>(
  op: "incomingCalls" | "outgoingCalls",
  filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions,
): Promise<{ status: string; calls: T[] }> {
  // Position-based Outcome composes two executor ops: prepare, then the calls
  // op on the first item. Empty prepare resolves to "empty".
  if (!detectLanguageFromExtension(filePath)) return { status: "unavailable", calls: [] };
  const reqBase = { workspace: root, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) };
  try {
    const prep = await runStrict(
      { operation: "prepareCallHierarchy", path: filePath, position: { line: toZeroBased(line), character: toZeroBased(character) }, ...reqBase },
      opts,
    );
    if (prep.status === "unavailable") return { status: "unavailable", calls: [] };
    if (prep.status !== "ok" && prep.status !== "empty") return { status: "degraded", calls: [] };
    const items = (Array.isArray(prep.result) ? prep.result : []) as LSPCallHierarchyItem[];
    if (items.length === 0) return { status: "empty", calls: [] };
    const calls = await runStrict(
      { operation: op, item: items[0] as unknown as Record<string, unknown>, ...reqBase },
      opts,
    );
    return mapCallsResult<T>(calls);
  } catch {
    return { status: "degraded", calls: [] };
  }
}

// ── Proposal adapters (1-based→0-based at this seam; executor proposals) ──

async function rename(
  filePath: string, line: number, character: number, newName: string, root: string,
): Promise<LspWorkspaceEdit | null> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  if (!detectLanguageFromExtension(filePath)) return null;
  try {
    const env = await runStrict({
      operation: "rename", path: filePath,
      position: { line: line0, character: char0 }, newName, workspace: root,
      timeoutMs: PROPOSAL_TIMEOUT_MS,
    });
    if (env.status !== "ok" || env.result === null) return null;
    return toLegacyWorkspaceEdit(env.result as NormalizedWorkspaceEdit);
  } catch {
    return null;
  }
}

async function prepareRename(
  filePath: string, line: number, character: number, root: string,
): Promise<{ range: LSPRange; placeholder?: string } | null> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  if (!detectLanguageFromExtension(filePath)) return null;
  try {
    const env = await runStrict({
      operation: "prepareRename", path: filePath,
      position: { line: line0, character: char0 }, workspace: root,
      timeoutMs: PROPOSAL_TIMEOUT_MS,
    });
    if (env.status !== "ok" || env.result === null) return null;
    return env.result as { range: LSPRange; placeholder?: string };
  } catch {
    return null;
  }
}

async function organizeImports(filePath: string, root: string): Promise<LspWorkspaceEdit | null> {
  if (!detectLanguageFromExtension(filePath)) return null;
  try {
    // organizeImports has no executor op: reuse the codeActions proposal and
    // take the first action carrying an edit (legacy selection rule).
    const env = await runStrict({
      operation: "codeActions", path: filePath,
      range: { start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER, character: 0 } },
      context: { only: ["source.organizeImports"] },
      workspace: root, timeoutMs: PROPOSAL_TIMEOUT_MS,
    });
    if ((env.status !== "ok" && env.status !== "empty") || env.result === null) return null;
    const actions = (env.result ?? []) as NormalizedCodeAction[];
    for (const a of actions) {
      if (a && a.edit) return toLegacyWorkspaceEdit(a.edit);
    }
    return null;
  } catch {
    return null;
  }
}

async function formatting(
  filePath: string, root: string, tabSize?: number, insertSpaces?: boolean,
): Promise<LspWorkspaceEdit | null> {
  if (!detectLanguageFromExtension(filePath)) return null;
  try {
    const env = await runStrict({
      operation: "formatDocument", path: filePath, workspace: root,
      ...((tabSize !== undefined || insertSpaces !== undefined)
        ? { formatting: { tabSize: tabSize ?? 2, insertSpaces: insertSpaces ?? true } }
        : {}),
      timeoutMs: PROPOSAL_TIMEOUT_MS,
    });
    if (env.status !== "ok" || env.result === null) return null;
    return toLegacyFormattingEdit(filePath, env.result as NormalizedTextEdit[]);
  } catch {
    return null;
  }
}

async function codeActions(
  filePath: string, range: LSPRange, context: { diagnostics?: unknown[]; only?: string[] }, root: string,
): Promise<Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }>> {
  if (!detectLanguageFromExtension(filePath)) return [];
  try {
    const env = await runStrict({
      operation: "codeActions", path: filePath, range, context: context as Record<string, unknown>,
      workspace: root, timeoutMs: PROPOSAL_TIMEOUT_MS,
    });
    if ((env.status !== "ok" && env.status !== "empty") || env.result === null) return [];
    return toLegacyCodeActions(env.result);
  } catch {
    return [];
  }
}

// ── Fresh-diagnostics adapter (executor read + freshness mapping) ──────

async function getFreshDiagnosticsOutcome(
  filePath: string, root: string, opts?: LspOutcomeOptions,
): Promise<LspDiagnosticsOutcome> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
  const langId = detectLanguageFromExtension(filePath);
  if (!langId) return { status: "unavailable", diagnostics: [] };
  try {
    // Stale-clear preamble (lifecycle hygiene, not protocol logic): only
    // diagnostics observed after this point count as confirmed. Preserves the
    // pull cache for unchanged-pull replay (clearPush only — never broker
    // clear/invalidate, which would drop lastPull).
    await withManager(root, async (mgr) => {
      let server: { clearDiagnostics(p: string): void; getDiagnosticsBroker(): { clearPush(p: string): void } } | null = null;
      try {
        // Legacy-exact session opts: purpose request, no allowInstall key
        // (matches the pre-rewrite withServer acquisition shape).
        server = await mgr.getServer(langId, { purpose: "request" });
      } catch {
        server = null;
      }
      if (!server) return;
      const resolved = resolve(filePath);
      try {
        server.clearDiagnostics(resolved);
      } catch { /* best effort */ }
      try {
        server.getDiagnosticsBroker().clearPush(resolved);
      } catch { /* best effort */ }
    }).catch(() => undefined);
    const env = await runStrict(
      { operation: "diagnostics", path: filePath, workspace: root, timeoutMs },
      opts,
    );
    if (env.status === "unavailable") return { status: "unavailable", diagnostics: [] };
    // Legacy vocabulary has no not_ready: executor honesty reports unconfirmed
    // diagnostics as not_ready — map to degraded (legacy unconfirmed shape).
    if (env.status === "not_ready") return { status: "degraded", diagnostics: [] };
    // Freshness is the honesty signal: an unconfirmed (unknown-freshness)
    // answer is never empty/confirmed — it is degraded.
    const fresh = (env.meta as { freshness?: { state?: string } })?.freshness?.state === "fresh";
    if (!fresh) return { status: "degraded", diagnostics: [] };
    const diagnostics = (Array.isArray(env.result) ? env.result : []) as LSPDiagnostic[];
    if (env.status === "empty" || diagnostics.length === 0) {
      return { status: "empty", diagnostics: [] };
    }
    const maxPer = opts?.maxPerFile;
    if (maxPer !== undefined && diagnostics.length > maxPer) {
      return { status: "confirmed", diagnostics: diagnostics.slice(0, maxPer), truncated: true };
    }
    return { status: "confirmed", diagnostics };
  } catch {
    return { status: "degraded", diagnostics: [] };
  }
}

// ── Bridge assembly ──────────────────────────────────────────────────

let bridgeInstance: LSPBridge | null = null;
let initAttempted = false;

async function createBridge(): Promise<LSPBridge> {
  return {
    isAvailable: () => {
      try {
        // Evaluate actual cached managers (keyed by workspace root), not the
        // dead `__default__` sentinel that is never inserted into the cache.
        for (const mgr of managerCache.values()) {
          if (mgr.connectedLanguageCount > 0) return true;
        }
        return false;
      } catch {
        return false;
      }
    },

    goToDefinition,
    findReferences,
    getDocumentSymbols,
    goToImplementation,
    prepareCallHierarchy,
    incomingCalls,
    outgoingCalls,
    workspaceSymbol,
    hover,

    async openFile(filePath: string, root: string, purpose?: "warmup" | "request"): Promise<void> {
      try {
        await withManager(root, (mgr) => mgr.openFile(filePath, root, purpose ?? "warmup"));
      } catch { /* best effort */ }
    },

    async updateFile(filePath: string, text: string, root: string): Promise<void> {
      try {
        await withManager(root, (mgr) => mgr.updateFile(filePath, text));
      } catch { /* best effort */ }
    },

    async closeFile(filePath: string, root: string): Promise<void> {
      try {
        await withManager(root, (mgr) => mgr.closeFile(filePath));
      } catch { /* best effort */ }
    },

    async didSave(filePath: string, root: string): Promise<void> {
      try {
        await withManager(root, (mgr) => mgr.didSave(filePath));
      } catch { /* best effort */ }
    },

    async getDiagnostics(filePath: string, root: string): Promise<LSPDiagnostic[]> {
      try {
        return await withManager(root, (mgr) => mgr.getDiagnosticsFor(filePath));
      } catch {
        return [];
      }
    },

    rename,
    prepareRename,
    organizeImports,
    formatting,
    codeActions,
    goToDefinitionOutcome,
    async findReferencesOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList> {
      return locationListOutcome("findReferences", filePath, line, character, root, opts);
    },
    getDocumentSymbolsOutcome,
    async goToImplementationOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList> {
      return locationListOutcome("goToImplementation", filePath, line, character, root, opts);
    },
    workspaceSymbolOutcome,
    hoverOutcome,
    prepareCallHierarchyOutcome,
    async incomingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspIncomingCallsOutcome> {
      return hierarchyCallsOutcome<LspIncomingCallsOutcome["calls"][number]>("incomingCalls", filePath, line, character, root, opts) as Promise<LspIncomingCallsOutcome>;
    },
    async outgoingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspOutgoingCallsOutcome> {
      return hierarchyCallsOutcome<LspOutgoingCallsOutcome["calls"][number]>("outgoingCalls", filePath, line, character, root, opts) as Promise<LspOutgoingCallsOutcome>;
    },
    getFreshDiagnosticsOutcome,

    getOpenFiles(): string[] {
      const files: string[] = [];
      for (const mgr of managerCache.values()) {
        files.push(...mgr.getAllOpenFiles());
      }
      return files;
    },
  };
}

// ── Public API ────────────────────────────────────────────────────

const BRIDGE_INIT_TIMEOUT_MS = 5000;

export async function getLSPBridge(): Promise<LSPBridge | null> {
  if (!initAttempted) {
    initAttempted = true;
    bridgeInstance = await Promise.race([
      createBridge(),
      new Promise<LSPBridge | null>((resolvePromise) => setTimeout(() => resolvePromise(null), BRIDGE_INIT_TIMEOUT_MS)),
    ]);
  }
  return bridgeInstance;
}

export function getProjectLSPInfo(root: string): ProjectLSPInfo {
  return detectProjectLanguages(root);
}

export function resetLSPBridge(): void {
  bridgeInstance = null;
  initAttempted = false;
}
