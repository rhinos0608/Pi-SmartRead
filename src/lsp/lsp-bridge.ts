/**
 * LSP Bridge — minimal JSON-RPC LSP client for symbol-level queries.
 *
 * Facade: cache lifecycle (bridge singleton) + public assembly. Operation
 * logic lives in split modules — acquisition/timeout policy in
 * lsp-server-operation.ts, navigation in lsp-navigation-adapter.ts,
 * call hierarchy in lsp-call-hierarchy-adapter.ts. Document/file-tracking,
 * mutations, and fresh-diagnostics stay here, all acquiring via
 * withServer/withManager.
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
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { managerCache } from "./lsp-manager.js";
import {
  detectLanguageFromExtension,
  detectProjectLanguages,
  withBudget,
  type LSPBridge,
  type LSPDiagnostic,
  type LSPRange,
  type LspDiagnosticsOutcome,
  type LspOutcomeOptions,
  type ProjectLSPInfo,
} from "./lsp-types.js";
import {
  DEFAULT_OUTCOME_TIMEOUT_MS,
  toFileUri,
  toZeroBased,
  withManager,
  withServer,
} from "./lsp-server-operation.js";
import * as navigation from "./lsp-navigation-adapter.js";
import * as callHierarchy from "./lsp-call-hierarchy-adapter.js";

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

    goToDefinition: navigation.goToDefinition,
    findReferences: navigation.findReferences,
    getDocumentSymbols: navigation.getDocumentSymbols,
    goToImplementation: navigation.goToImplementation,
    prepareCallHierarchy: callHierarchy.prepareCallHierarchy,
    incomingCalls: callHierarchy.incomingCalls,
    outgoingCalls: callHierarchy.outgoingCalls,
    workspaceSymbol: navigation.workspaceSymbol,
    hover: navigation.hover,

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
        const edit = await withServer(root, langId,
          (server) => server.rename(filePath, line0, char0, newName),
          { timeoutMs });
        return edit ?? null;
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
        const result = await withServer(root, langId,
          (server) => server.prepareRename(filePath, line0, char0),
          { timeoutMs });
        return result ?? null;
      } catch { return null; }
    },
    async organizeImports(filePath: string, root: string): Promise<LspWorkspaceEdit | null> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const edit = await withServer(root, langId,
          (server) => server.organizeImports(filePath),
          { timeoutMs });
        return edit ?? null;
      } catch { return null; }
    },
    async formatting(filePath: string, root: string, tabSize?: number, insertSpaces?: boolean): Promise<LspWorkspaceEdit | null> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const edit = await withServer(root, langId,
          (server) => server.formatting(filePath, tabSize, insertSpaces),
          { timeoutMs });
        return edit ?? null;
      } catch { return null; }
    },
    async codeActions(filePath: string, range: LSPRange, context: { diagnostics?: unknown[]; only?: string[] }, root: string): Promise<Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }>> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return []; }
      if (!langId) return [];
      const timeoutMs = 10_000;
      try {
        const actions = await withServer(root, langId,
          (server) => server.codeActions(filePath, range, context),
          { timeoutMs });
        return actions ?? [];
      } catch { return []; }
    },
    goToDefinitionOutcome: navigation.goToDefinitionOutcome,
    findReferencesOutcome: navigation.findReferencesOutcome,
    getDocumentSymbolsOutcome: navigation.getDocumentSymbolsOutcome,
    goToImplementationOutcome: navigation.goToImplementationOutcome,
    workspaceSymbolOutcome: navigation.workspaceSymbolOutcome,
    hoverOutcome: navigation.hoverOutcome,
    prepareCallHierarchyOutcome: callHierarchy.prepareCallHierarchyOutcome,
    incomingCallsOutcome: callHierarchy.incomingCallsOutcome,
    outgoingCallsOutcome: callHierarchy.outgoingCallsOutcome,

    async getFreshDiagnosticsOutcome(filePath: string, root: string, opts?: LspOutcomeOptions): Promise<LspDiagnosticsOutcome> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const waitMs = opts?.waitMs ?? 1500;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", diagnostics: [] };
      try {
        // Acquisition budgeted; action keeps its own inner budgets (poll + pull).
        const outcome = await withServer(root, langId, async (server, mgr) => {
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
            if (maxPer !== undefined && diagnostics.length > maxPer) return { status: "confirmed", diagnostics: diagnostics.slice(0, maxPer), truncated: true } as LspDiagnosticsOutcome;
            return { status: "confirmed", diagnostics } as LspDiagnosticsOutcome;
          }
          if (hasPublishReceipt || pullSucceeded) return { status: "empty", diagnostics: [] } as LspDiagnosticsOutcome;
          return { status: "degraded", diagnostics: [] } as LspDiagnosticsOutcome;
        }, { timeoutMs, signal: opts?.signal, unbudgetedAction: true });
        if (outcome === null) return { status: "unavailable", diagnostics: [] };
        return outcome;
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
