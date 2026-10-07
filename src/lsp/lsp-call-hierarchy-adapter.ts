/**
 * LSP call-hierarchy adapter — prepare/incoming/outgoing plus outcome variants.
 *
 * Split from lsp-bridge.ts: pure operation functions over withServer /
 * runOutcome. Outcome-level incoming/outgoing stay position-based: they
 * internally resolve via prepareCallHierarchy, then issue the calls request.
 * Raw item-based incomingCalls/outgoingCalls remain for callers that
 * already hold an item (avoids redundant prepare).
 */
import {
  detectLanguageFromExtension,
  type LSPCallHierarchyIncomingCall,
  type LSPCallHierarchyItem,
  type LSPCallHierarchyOutgoingCall,
  type LspCallHierarchyPrepareOutcome,
  type LspIncomingCallsOutcome,
  type LspOutgoingCallsOutcome,
  type LspOutcomeOptions,
} from "./lsp-types.js";
import type { LSPConnection } from "./lsp-connection.js";
import {
  lspUriToPath,
  runOutcome,
  toFileUri,
  toZeroBased,
  withServer,
} from "./lsp-server-operation.js";

async function serverPrepareCallHierarchy(
  server: LSPConnection, filePath: string, line: number, character: number,
): Promise<LSPCallHierarchyItem[]> {
  await server.openFile(filePath);
  const result = await server.request("textDocument/prepareCallHierarchy", {
    textDocument: { uri: toFileUri(filePath) },
    position: { line, character },
  }) as LSPCallHierarchyItem[] | null;
  return result ?? [];
}

export async function prepareCallHierarchy(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPCallHierarchyItem[]> {
  const langId = detectLanguageFromExtension(filePath);
  if (!langId) return [];
  try {
    const result = await withServer(root, langId, async (server) =>
      serverPrepareCallHierarchy(server, filePath, line, character));
    return result ?? [];
  } catch { return []; }
}

export async function incomingCalls(
  item: LSPCallHierarchyItem, root: string,
): Promise<LSPCallHierarchyIncomingCall[]> {
  const itemPath = lspUriToPath(item.uri);
  if (!itemPath) return [];
  const langId = detectLanguageFromExtension(itemPath);
  if (!langId) return [];
  try {
    const result = await withServer(root, langId, async (server) => {
      const result = await server.request("callHierarchy/incomingCalls", { item }) as LSPCallHierarchyIncomingCall[] | null;
      return result ?? [];
    });
    return result ?? [];
  } catch { return []; }
}

export async function outgoingCalls(
  item: LSPCallHierarchyItem, root: string,
): Promise<LSPCallHierarchyOutgoingCall[]> {
  const itemPath = lspUriToPath(item.uri);
  if (!itemPath) return [];
  const langId = detectLanguageFromExtension(itemPath);
  if (!langId) return [];
  try {
    const result = await withServer(root, langId, async (server) => {
      const result = await server.request("callHierarchy/outgoingCalls", { item }) as LSPCallHierarchyOutgoingCall[] | null;
      return result ?? [];
    });
    return result ?? [];
  } catch { return []; }
}

export async function prepareCallHierarchyOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspCallHierarchyPrepareOutcome> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  return runOutcome<LSPCallHierarchyItem[], LspCallHierarchyPrepareOutcome>({
    filePath, root, opts,
    makeUnavailable: () => ({ status: "unavailable", items: [] }),
    makeEmpty: () => ({ status: "empty", items: [] }),
    makeConfirmed: (items) => ({ status: "confirmed", items }),
    makeDegraded: () => ({ status: "degraded", items: [] }),
    isEmpty: (items) => items.length === 0,
    action: (server) => serverPrepareCallHierarchy(server, filePath, line0, char0),
  });
}

export async function incomingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspIncomingCallsOutcome> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  // Empty prepare resolves to [] so runOutcome maps it to "empty" (was null → empty).
  return runOutcome<LSPCallHierarchyIncomingCall[], LspIncomingCallsOutcome>({
    filePath, root, opts,
    makeUnavailable: () => ({ status: "unavailable", calls: [] }),
    makeEmpty: () => ({ status: "empty", calls: [] }),
    makeConfirmed: (calls) => ({ status: "confirmed", calls }),
    makeDegraded: () => ({ status: "degraded", calls: [] }),
    isEmpty: (calls) => calls.length === 0,
    action: (server) => (async () => {
      const items = await serverPrepareCallHierarchy(server, filePath, line0, char0);
      if (items.length === 0) return [];
      const item = items[0]!;
      const result = await server.request("callHierarchy/incomingCalls", { item }) as LSPCallHierarchyIncomingCall[] | null;
      return result ?? [];
    })(),
  });
}

export async function outgoingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspOutgoingCallsOutcome> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  // Empty prepare resolves to [] so runOutcome maps it to "empty" (was null → empty).
  return runOutcome<LSPCallHierarchyOutgoingCall[], LspOutgoingCallsOutcome>({
    filePath, root, opts,
    makeUnavailable: () => ({ status: "unavailable", calls: [] }),
    makeEmpty: () => ({ status: "empty", calls: [] }),
    makeConfirmed: (calls) => ({ status: "confirmed", calls }),
    makeDegraded: () => ({ status: "degraded", calls: [] }),
    isEmpty: (calls) => calls.length === 0,
    action: (server) => (async () => {
      const items = await serverPrepareCallHierarchy(server, filePath, line0, char0);
      if (items.length === 0) return [];
      const item = items[0]!;
      const result = await server.request("callHierarchy/outgoingCalls", { item }) as LSPCallHierarchyOutgoingCall[] | null;
      return result ?? [];
    })(),
  });
}
