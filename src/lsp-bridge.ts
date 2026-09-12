/**
 * LSP Bridge — minimal JSON-RPC LSP client for symbol-level queries.
 *
 * Spawns standard language servers over stdio and speaks the Language
 * Server Protocol (LSP) to provide goToDefinition, findReferences,
 * getDocumentSymbols, goToImplementation, workspace/symbol, hover,
 * and incremental document tracking (didOpen/didChange/didClose).
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
import { pathToFileURL } from "node:url";

function toFileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { cachedManager, managerCache } from "./lsp-manager.js";
import type { LSPConnection } from "./lsp-connection.js";
import {
  detectLanguageFromExtension,
  detectProjectLanguages,
  withBudget,
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

// Facade re-exports: every pre-existing lsp-bridge export keeps resolving here.
export { ALL_SERVER_CONFIGS, detectLanguageFromExtension, detectProjectLanguages, resolvedServerCache } from "./lsp-types.js";
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

let bridgeInstance: LSPBridge | null = null;
let initAttempted = false;

function toZeroBased(line1: number): number { return Math.max(0, line1 - 1); }
const DEFAULT_OUTCOME_TIMEOUT_MS = 5000;

/**
 * Shared outcome skeleton: language check → request-scoped server → budgeted action
 * → empty/confirmed mapping, degraded on any throw. Status strings preserved.
 */
async function runOutcome<Value, Outcome>(
  filePath: string,
  root: string,
  opts: LspOutcomeOptions | undefined,
  makeUnavailable: () => Outcome,
  makeEmpty: () => Outcome,
  makeConfirmed: (value: Value) => Outcome,
  makeDegraded: () => Outcome,
  isEmpty: (value: Value) => boolean,
  action: (server: LSPConnection) => Promise<Value>,
): Promise<Outcome> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
  const langId = detectLanguageFromExtension(filePath);
  if (!langId) return makeUnavailable();
  try {
    const mgr = cachedManager(root);
    const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
    if (!server) return makeUnavailable();
    const value = await withBudget(action(server), timeoutMs, opts?.signal);
    if (isEmpty(value)) return makeEmpty();
    return makeConfirmed(value);
  } catch { return makeDegraded(); }
}

async function createBridge(): Promise<LSPBridge | null> {
  return {
    isAvailable: () => {
      try {
        // Evaluate actual cached managers (keyed by workspace root), not the
        // dead `__default__` sentinel that is never inserted into the cache.
        for (const mgr of managerCache.values()) {
          if (mgr.connectedLanguageCount > 0) return true;
        }
        return false;
      } catch { return false; }
    },

    async goToDefinition(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPLocation | null> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return null;
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return null;
        return serverGoToDefinition(server, filePath, line, character);
      } catch { return null; }
    },

    async findReferences(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPLocation[]> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        await server.openFile(filePath);
        const result = await server.request("textDocument/references", {
          textDocument: { uri: toFileUri(filePath) },
          position: { line, character },
          context: { includeDeclaration: true },
        }) as LSPLocation[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async getDocumentSymbols(
      filePath: string, root: string,
    ): Promise<LSPDocumentSymbol[]> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        await server.openFile(filePath);
        const result = await server.request("textDocument/documentSymbol", {
          textDocument: { uri: toFileUri(filePath) },
        }) as LSPDocumentSymbol[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async goToImplementation(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPLocation[]> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        await server.openFile(filePath);
        const result = await server.request("textDocument/implementation", {
          textDocument: { uri: toFileUri(filePath) },
          position: { line, character },
        }) as LSPLocation | LSPLocation[] | null;
        if (!result) return [];
        return Array.isArray(result) ? result : [result];
      } catch { return []; }
    },

    async prepareCallHierarchy(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPCallHierarchyItem[]> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        await server.openFile(filePath);
        const result = await server.request("textDocument/prepareCallHierarchy", {
          textDocument: { uri: toFileUri(filePath) },
          position: { line, character },
        }) as LSPCallHierarchyItem[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async incomingCalls(
      item: LSPCallHierarchyItem, root: string,
    ): Promise<LSPCallHierarchyIncomingCall[]> {
      const langId = detectLanguageFromExtension(item.uri.replace(/^file:\/\//, ""));
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        const result = await server.request("callHierarchy/incomingCalls", { item }) as LSPCallHierarchyIncomingCall[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async outgoingCalls(
      item: LSPCallHierarchyItem, root: string,
    ): Promise<LSPCallHierarchyOutgoingCall[]> {
      const langId = detectLanguageFromExtension(item.uri.replace(/^file:\/\//, ""));
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        const result = await server.request("callHierarchy/outgoingCalls", { item }) as LSPCallHierarchyOutgoingCall[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async workspaceSymbol(query: string, root: string): Promise<LSPWorkspaceSymbol[]> {
      try {
        const mgr = cachedManager(root);
        return mgr.workspaceSymbol(query);
      } catch { return []; }
    },

    async hover(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPHoverResult | null> {
      try {
        const mgr = cachedManager(root);
        return mgr.hover(filePath, line, character);
      } catch { return null; }
    },

    async openFile(filePath: string, root: string, purpose?: "warmup" | "request"): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.openFile(filePath, root, purpose ?? "warmup");
      } catch { /* best effort */ }
    },

    async updateFile(filePath: string, text: string, root: string): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.updateFile(filePath, text);
      } catch { /* best effort */ }
    },

    async closeFile(filePath: string, root: string): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.closeFile(filePath);
      } catch { /* best effort */ }
    },

    async didSave(filePath: string, root: string): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.didSave(filePath);
      } catch { /* best effort */ }
    },

    async getDiagnostics(filePath: string, root: string): Promise<LSPDiagnostic[]> {
      try {
        const mgr = cachedManager(root);
        return await mgr.getDiagnosticsFor(filePath);
      } catch { return []; }
    },

    async rename(filePath: string, line: number, character: number, newName: string, root: string): Promise<LspWorkspaceEdit | null> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      if (line0 < 0 || char0 < 0) return null;
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return null;
        return await withBudget(server.rename(filePath, line0, char0, newName), timeoutMs);
      } catch { return null; }
    },
    async prepareRename(filePath: string, line: number, character: number, root: string): Promise<{ range: LSPRange; placeholder?: string } | null> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      if (line0 < 0 || char0 < 0) return null;
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return null;
        return await withBudget(server.prepareRename(filePath, line0, char0), timeoutMs);
      } catch { return null; }
    },
    async organizeImports(filePath: string, root: string): Promise<LspWorkspaceEdit | null> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return null;
        return await withBudget(server.organizeImports(filePath), timeoutMs);
      } catch { return null; }
    },
    async formatting(filePath: string, root: string, tabSize?: number, insertSpaces?: boolean): Promise<LspWorkspaceEdit | null> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return null;
        return await withBudget(server.formatting(filePath, tabSize, insertSpaces), timeoutMs);
      } catch { return null; }
    },
    async codeActions(filePath: string, range: LSPRange, context: { diagnostics?: unknown[]; only?: string[] }, root: string): Promise<Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }>> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return []; }
      if (!langId) return [];
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return [];
        return await withBudget(server.codeActions(filePath, range, context), timeoutMs);
      } catch { return []; }
    },
    async goToDefinitionOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeSingle> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      return runOutcome<LSPLocation | null, LspNavigationOutcomeSingle>(
        filePath, root, opts,
        () => ({ status: "unavailable", location: null }),
        () => ({ status: "empty", location: null }),
        (loc) => ({ status: "confirmed", location: loc }),
        () => ({ status: "degraded", location: null }),
        (loc) => loc === null,
        (server) => serverGoToDefinition(server, filePath, line0, char0),
      );
    },

    async findReferencesOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      return runOutcome<LSPLocation[], LspNavigationOutcomeList>(
        filePath, root, opts,
        () => ({ status: "unavailable", locations: [] }),
        () => ({ status: "empty", locations: [] }),
        (locs) => ({ status: "confirmed", locations: locs }),
        () => ({ status: "degraded", locations: [] }),
        (locs) => locs.length === 0,
        (server) => (async () => {
          await server.openFile(filePath);
          const result = await server.request("textDocument/references", { textDocument: { uri: toFileUri(filePath) }, position: { line: line0, character: char0 }, context: { includeDeclaration: true } }) as LSPLocation[] | null;
          return result ?? [];
        })(),
      );
    },

    async getDocumentSymbolsOutcome(filePath: string, root: string, opts?: LspOutcomeOptions): Promise<LspDocumentSymbolsOutcome> {
      return runOutcome<LSPDocumentSymbol[], LspDocumentSymbolsOutcome>(
        filePath, root, opts,
        () => ({ status: "unavailable", symbols: [] }),
        () => ({ status: "empty", symbols: [] }),
        (symbols) => ({ status: "confirmed", symbols }),
        () => ({ status: "degraded", symbols: [] }),
        (symbols) => symbols.length === 0,
        (server) => (async () => {
          await server.openFile(filePath);
          const result = await server.request("textDocument/documentSymbol", { textDocument: { uri: toFileUri(filePath) } }) as LSPDocumentSymbol[] | null;
          return result ?? [];
        })(),
      );
    },

    async goToImplementationOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      return runOutcome<LSPLocation[], LspNavigationOutcomeList>(
        filePath, root, opts,
        () => ({ status: "unavailable", locations: [] }),
        () => ({ status: "empty", locations: [] }),
        (locs) => ({ status: "confirmed", locations: locs }),
        () => ({ status: "degraded", locations: [] }),
        (locs) => locs.length === 0,
        (server) => (async () => {
          await server.openFile(filePath);
          const result = await server.request("textDocument/implementation", { textDocument: { uri: toFileUri(filePath) }, position: { line: line0, character: char0 } }) as LSPLocation | LSPLocation[] | null;
          if (!result) return [];
          return Array.isArray(result) ? result : [result];
        })(),
      );
    },

    async workspaceSymbolOutcome(query: string, root: string, opts?: LspOutcomeOptions): Promise<LspWorkspaceSymbolsOutcome> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      try {
        const mgr = cachedManager(root);
        const symbols = await withBudget(mgr.workspaceSymbol(query), timeoutMs, opts?.signal);
        if (symbols.length === 0) {
          // distinguish no server vs empty: if no connected languages then unavailable
          if (!mgr.connectedLanguageCount) return { status: "unavailable", symbols: [] };
          return { status: "empty", symbols: [] };
        }
        return { status: "confirmed", symbols };
      } catch { return { status: "degraded", symbols: [] }; }
    },

    async hoverOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspHoverOutcome> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      return runOutcome<LSPHoverResult | null, LspHoverOutcome>(
        filePath, root, opts,
        () => ({ status: "unavailable", hover: null }),
        () => ({ status: "empty", hover: null }),
        (result) => ({ status: "confirmed", hover: result }),
        () => ({ status: "degraded", hover: null }),
        (result) => result === null,
        (server) => (async () => {
          await server.openFile(filePath);
          return server.hover(filePath, line0, char0);
        })(),
      );
    },

    async prepareCallHierarchyOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspCallHierarchyPrepareOutcome> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      return runOutcome<LSPCallHierarchyItem[], LspCallHierarchyPrepareOutcome>(
        filePath, root, opts,
        () => ({ status: "unavailable", items: [] }),
        () => ({ status: "empty", items: [] }),
        (items) => ({ status: "confirmed", items }),
        () => ({ status: "degraded", items: [] }),
        (items) => items.length === 0,
        (server) => (async () => {
          await server.openFile(filePath);
          const result = await server.request("textDocument/prepareCallHierarchy", {
            textDocument: { uri: toFileUri(filePath) },
            position: { line: line0, character: char0 },
          }) as LSPCallHierarchyItem[] | null;
          return result ?? [];
        })(),
      );
    },

    // Design choice: outcome-level incoming/outgoing are position-based.
    // They internally call prepareCallHierarchy to resolve the CallHierarchyItem, then call the calls request.
    // Raw item-based incomingCalls/outgoingCalls remain available for callers that already have an item (avoiding redundant prepare).
    async incomingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspIncomingCallsOutcome> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", calls: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", calls: [] };
        const calls = await withBudget((async () => {
          await server.openFile(filePath);
          const items = await server.request("textDocument/prepareCallHierarchy", {
            textDocument: { uri: toFileUri(filePath) },
            position: { line: line0, character: char0 },
          }) as LSPCallHierarchyItem[] | null;
          if (!items || items.length === 0) return null;
          const item = items[0]!;
          const result = await server.request("callHierarchy/incomingCalls", { item }) as LSPCallHierarchyIncomingCall[] | null;
          return result ?? [];
        })(), timeoutMs, opts?.signal);
        if (calls === null) return { status: "empty", calls: [] };
        if (calls.length === 0) return { status: "empty", calls: [] };
        return { status: "confirmed", calls };
      } catch { return { status: "degraded", calls: [] }; }
    },

    async outgoingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspOutgoingCallsOutcome> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", calls: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", calls: [] };
        const calls = await withBudget((async () => {
          await server.openFile(filePath);
          const items = await server.request("textDocument/prepareCallHierarchy", {
            textDocument: { uri: toFileUri(filePath) },
            position: { line: line0, character: char0 },
          }) as LSPCallHierarchyItem[] | null;
          if (!items || items.length === 0) return null;
          const item = items[0]!;
          const result = await server.request("callHierarchy/outgoingCalls", { item }) as LSPCallHierarchyOutgoingCall[] | null;
          return result ?? [];
        })(), timeoutMs, opts?.signal);
        if (calls === null) return { status: "empty", calls: [] };
        if (calls.length === 0) return { status: "empty", calls: [] };
        return { status: "confirmed", calls };
      } catch { return { status: "degraded", calls: [] }; }
    },

    async getFreshDiagnosticsOutcome(filePath: string, root: string, opts?: LspOutcomeOptions): Promise<LspDiagnosticsOutcome> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const waitMs = opts?.waitMs ?? 1500;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", diagnostics: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", diagnostics: [] };
        const resolved = resolve(filePath);
        // clear stale cached diagnostics before refresh — only diagnostics observed after this point count as confirmed
        server.clearDiagnostics(resolved);
        // force refresh if already open (openFile is idempotent otherwise)
        if (server.isOpen(resolved)) {
          try { await withBudget(server.didClose(resolved), Math.min(500, timeoutMs), opts?.signal); } catch {}
        }
        await withBudget(server.openFile(filePath), timeoutMs, opts?.signal);
        const start = Date.now();
        let pullSucceeded = false;
        // poll cached diagnostics with budget respecting waitMs + timeout; distinguish confirmed-empty (receipt exists) from unconfirmed
        const poll = async (): Promise<LSPDiagnostic[]> => {
          while (Date.now() - start < waitMs) {
            if (opts?.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
            const hasReceipt = server.hasDiagnostics(resolved);
            if (hasReceipt) return server.getDiagnostics(resolved);
            const diags = await mgr.getDiagnosticsFor(filePath);
            if (diags.length > 0) return diags;
            await new Promise((r) => setTimeout(r, 50));
          }
          return await mgr.getDiagnosticsFor(filePath);
        };
        let diagnostics = await withBudget(poll(), timeoutMs, opts?.signal);
        const hasPublishReceipt = server.hasDiagnostics(resolved);
        // pull fallback: try textDocument/diagnostic if no publish receipt and no diagnostics yet
        if (diagnostics.length === 0 && !hasPublishReceipt) {
          try {
            const uri = toFileUri(resolved);
            const pull = await withBudget((server as any).request("textDocument/diagnostic", { textDocument: { uri }, previousResultId: "" }), Math.min(400, timeoutMs), opts?.signal) as any;
            if (pull !== null) {
              pullSucceeded = true;
              const items: LSPDiagnostic[] = pull?.items ?? pull?.diagnostics ?? (Array.isArray(pull) ? pull : []);
              if (items.length > 0) diagnostics = items;
            }
            // empty items with successful pull counts as confirmed-empty via pullSucceeded
          } catch {}
        }
        if (diagnostics.length > 0) {
          const maxPer = opts?.maxPerFile;
          if (maxPer !== undefined && diagnostics.length > maxPer) return { status: "confirmed", diagnostics: diagnostics.slice(0, maxPer), truncated: true };
          return { status: "confirmed", diagnostics };
        }
        if (hasPublishReceipt || pullSucceeded) return { status: "empty", diagnostics: [] };
        return { status: "degraded", diagnostics: [] };
      } catch { return { status: "degraded", diagnostics: [] }; }
    },

    getOpenFiles(): string[] {
      const files: string[] = [];
      for (const mgr of managerCache.values()) {
        files.push(...mgr.getAllOpenFiles());
      }
      return files;
    },
  };
}

async function serverGoToDefinition(
  server: LSPConnection, filePath: string, line: number, character: number,
): Promise<LSPLocation | null> {
  await server.openFile(filePath);
  const result = await server.request("textDocument/definition", {
    textDocument: { uri: toFileUri(filePath) },
    position: { line, character },
  }) as LSPLocation | LSPLocation[] | null;
  if (!result) return null;
  const locations = Array.isArray(result) ? result : [result];
  return locations[0] ?? null;
}

// ── Public API ────────────────────────────────────────────────────

const BRIDGE_INIT_TIMEOUT_MS = 5000;

export async function getLSPBridge(): Promise<LSPBridge | null> {
  if (!initAttempted) {
    initAttempted = true;
    bridgeInstance = await Promise.race([
      createBridge(),
      new Promise<LSPBridge | null>((resolve) => setTimeout(() => resolve(null), BRIDGE_INIT_TIMEOUT_MS)),
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
