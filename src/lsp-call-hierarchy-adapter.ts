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
import {
  lspUriToPath,
  runOutcome,
  toFileUri,
  toZeroBased,
  withServer,
} from "./lsp-server-operation.js";

export async function prepareCallHierarchy(
  filePath: string, line: number, character: number, root: string,
): Promise<LSPCallHierarchyItem[]> {
  const langId = detectLanguageFromExtension(filePath);
  if (!langId) return [];
  try {
    const result = await withServer(root, langId, async (server) => {
      await server.openFile(filePath);
      const result = await server.request("textDocument/prepareCallHierarchy", {
        textDocument: { uri: toFileUri(filePath) },
        position: { line, character },
      }) as LSPCallHierarchyItem[] | null;
      return result ?? [];
    });
    return result ?? [];
  } catch { return []; }
}

export async function incomingCalls(
  item: LSPCallHierarchyItem, root: string,
): Promise<LSPCallHierarchyIncomingCall[]> {
  const langId = detectLanguageFromExtension(lspUriToPath(item.uri));
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
  const langId = detectLanguageFromExtension(lspUriToPath(item.uri));
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
}

export async function incomingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspIncomingCallsOutcome> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  // Empty prepare resolves to [] so runOutcome maps it to "empty" (was null → empty).
  return runOutcome<LSPCallHierarchyIncomingCall[], LspIncomingCallsOutcome>(
    filePath, root, opts,
    () => ({ status: "unavailable", calls: [] }),
    () => ({ status: "empty", calls: [] }),
    (calls) => ({ status: "confirmed", calls }),
    () => ({ status: "degraded", calls: [] }),
    (calls) => calls.length === 0,
    (server) => (async () => {
      await server.openFile(filePath);
      const items = await server.request("textDocument/prepareCallHierarchy", {
        textDocument: { uri: toFileUri(filePath) },
        position: { line: line0, character: char0 },
      }) as LSPCallHierarchyItem[] | null;
      if (!items || items.length === 0) return [];
      const item = items[0]!;
      const result = await server.request("callHierarchy/incomingCalls", { item }) as LSPCallHierarchyIncomingCall[] | null;
      return result ?? [];
    })(),
  );
}

export async function outgoingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspOutgoingCallsOutcome> {
  const line0 = toZeroBased(line);
  const char0 = toZeroBased(character);
  // Empty prepare resolves to [] so runOutcome maps it to "empty" (was null → empty).
  return runOutcome<LSPCallHierarchyOutgoingCall[], LspOutgoingCallsOutcome>(
    filePath, root, opts,
    () => ({ status: "unavailable", calls: [] }),
    () => ({ status: "empty", calls: [] }),
    (calls) => ({ status: "confirmed", calls }),
    () => ({ status: "degraded", calls: [] }),
    (calls) => calls.length === 0,
    (server) => (async () => {
      await server.openFile(filePath);
      const items = await server.request("textDocument/prepareCallHierarchy", {
        textDocument: { uri: toFileUri(filePath) },
        position: { line: line0, character: char0 },
      }) as LSPCallHierarchyItem[] | null;
      if (!items || items.length === 0) return [];
      const item = items[0]!;
      const result = await server.request("callHierarchy/outgoingCalls", { item }) as LSPCallHierarchyOutgoingCall[] | null;
      return result ?? [];
    })(),
  );
}
