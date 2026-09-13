/**
 * LSP navigation adapter — definition/references/symbols/implementation/
 * workspace-symbol/hover plus honesty-labeled outcome variants.
 *
 * Split from lsp-bridge.ts: pure operation functions over withServer /
 * withManager / runOutcome. No cache lifecycle here; assembly lives in
 * lsp-bridge.ts createBridge.
 */
import type { LSPConnection } from "./lsp-connection.js";
import {
  detectLanguageFromExtension,
  withBudget,
  type LSPDocumentSymbol,
  type LSPHoverResult,
  type LSPLocation,
  type LspDocumentSymbolsOutcome,
  type LspHoverOutcome,
  type LspNavigationOutcomeList,
  type LspNavigationOutcomeSingle,
  type LspOutcomeOptions,
  type LspWorkspaceSymbolsOutcome,
  type LSPWorkspaceSymbol,
} from "./lsp-types.js";
import {
  DEFAULT_OUTCOME_TIMEOUT_MS,
  runOutcome,
  toFileUri,
  toZeroBased,
  withManager,
  withServer,
} from "./lsp-server-operation.js";

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

export async function goToDefinition(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPLocation | null> {
  const langId = detectLanguageFromExtension(filePath);
  if (!langId) return null;
  try {
    return (await withServer(root, langId,
      (server) => serverGoToDefinition(server, filePath, line, character))) ?? null;
  } catch { return null; }
}

async function serverFindReferences(
  server: LSPConnection, filePath: string, line: number, character: number,
): Promise<LSPLocation[]> {
  await server.openFile(filePath);
  const result = await server.request("textDocument/references", {
    textDocument: { uri: toFileUri(filePath) },
    position: { line, character },
    context: { includeDeclaration: true },
  }) as LSPLocation[] | null;
  return result ?? [];
}

export async function findReferences(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPLocation[]> {
  const langId = detectLanguageFromExtension(filePath);
  if (!langId) return [];
  try {
    const result = await withServer(root, langId, (server) =>
      serverFindReferences(server, filePath, line, character));
    return result ?? [];
  } catch { return []; }
}

async function serverGetDocumentSymbols(
  server: LSPConnection, filePath: string,
): Promise<LSPDocumentSymbol[]> {
  await server.openFile(filePath);
  const result = await server.request("textDocument/documentSymbol", {
    textDocument: { uri: toFileUri(filePath) },
  }) as LSPDocumentSymbol[] | null;
  return result ?? [];
}

export async function getDocumentSymbols(
  filePath: string, root: string,
): Promise<LSPDocumentSymbol[]> {
  const langId = detectLanguageFromExtension(filePath);
  if (!langId) return [];
  try {
    const result = await withServer(root, langId, (server) =>
      serverGetDocumentSymbols(server, filePath));
    return result ?? [];
  } catch { return []; }
}

async function serverGoToImplementation(
  server: LSPConnection, filePath: string, line: number, character: number,
): Promise<LSPLocation[]> {
  await server.openFile(filePath);
  const result = await server.request("textDocument/implementation", {
    textDocument: { uri: toFileUri(filePath) },
    position: { line, character },
  }) as LSPLocation | LSPLocation[] | null;
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function goToImplementation(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPLocation[]> {
  const langId = detectLanguageFromExtension(filePath);
  if (!langId) return [];
  try {
    const result = await withServer(root, langId, (server) =>
      serverGoToImplementation(server, filePath, line, character));
    return result ?? [];
  } catch { return []; }
}

export async function workspaceSymbol(query: string, root: string): Promise<LSPWorkspaceSymbol[]> {
  try {
    return await withManager(root, (mgr) => mgr.workspaceSymbol(query));
  } catch { return []; }
}

export async function hover(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPHoverResult | null> {
  try {
    return await withManager(root, (mgr) => mgr.hover(filePath, line, character));
  } catch { return null; }
}

export async function goToDefinitionOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeSingle> {
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
}

export async function findReferencesOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  return runOutcome<LSPLocation[], LspNavigationOutcomeList>(
    filePath, root, opts,
    () => ({ status: "unavailable", locations: [] }),
    () => ({ status: "empty", locations: [] }),
    (locs) => ({ status: "confirmed", locations: locs }),
    () => ({ status: "degraded", locations: [] }),
    (locs) => locs.length === 0,
    (server) => serverFindReferences(server, filePath, line0, char0),
  );
}

export async function getDocumentSymbolsOutcome(filePath: string, root: string, opts?: LspOutcomeOptions): Promise<LspDocumentSymbolsOutcome> {
  return runOutcome<LSPDocumentSymbol[], LspDocumentSymbolsOutcome>(
    filePath, root, opts,
    () => ({ status: "unavailable", symbols: [] }),
    () => ({ status: "empty", symbols: [] }),
    (symbols) => ({ status: "confirmed", symbols }),
    () => ({ status: "degraded", symbols: [] }),
    (symbols) => symbols.length === 0,
    (server) => serverGetDocumentSymbols(server, filePath),
  );
}

export async function goToImplementationOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  return runOutcome<LSPLocation[], LspNavigationOutcomeList>(
    filePath, root, opts,
    () => ({ status: "unavailable", locations: [] }),
    () => ({ status: "empty", locations: [] }),
    (locs) => ({ status: "confirmed", locations: locs }),
    () => ({ status: "degraded", locations: [] }),
    (locs) => locs.length === 0,
    (server) => serverGoToImplementation(server, filePath, line0, char0),
  );
}

export async function workspaceSymbolOutcome(query: string, root: string, opts?: LspOutcomeOptions): Promise<LspWorkspaceSymbolsOutcome> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
  try {
    return await withManager(root, async (mgr) => {
      const symbols = await withBudget(mgr.workspaceSymbol(query), timeoutMs, opts?.signal);
      if (symbols.length === 0) {
        // distinguish no server vs empty: if no connected languages then unavailable
        if (!mgr.connectedLanguageCount) return { status: "unavailable", symbols: [] };
        return { status: "empty", symbols: [] };
      }
      return { status: "confirmed", symbols };
    });
  } catch { return { status: "degraded", symbols: [] }; }
}

export async function hoverOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspHoverOutcome> {
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
}
