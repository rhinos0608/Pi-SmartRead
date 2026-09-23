/**
 * Server → client JSON-RPC request handlers for LSPConnection strict transport.
 *
 * Frames reach this dispatch map only after method-first classification in
 * LSPConnection found both an id and a method (id+method = server request).
 * Server request ids live in the server's own namespace — the connection
 * replies to them directly and never settles a client pending entry from them.
 * Unknown methods never consult this map; the connection answers -32601.
 */

/** Callbacks a handler may use; built per-dispatch by LSPConnection. */
export interface ServerRequestContext {
  /** Workspace folders for workspace/workspaceFolders: null when the connection has no root. */
  workspaceFolders: () => Array<{ uri: string; name: string }> | null;
  /** Retain an unsolicited workspace/applyEdit proposal in memory only — never written to disk. */
  retainApplyEditProposal: (params: unknown) => void;
  /** Session fingerprint settings for workspace/configuration replies. Null when unset. */
  getConfigurationSettings: () => unknown;
  /** Register a window/workDoneProgress/create token; sibling provides via readiness tracker. Optional — handler must never throw when absent. */
  registerWorkDoneToken?: (token: string) => void;
}

export type ServerRequestHandler = (params: unknown, ctx: ServerRequestContext) => unknown;

/**
 * workspace/configuration: ordered reply with one entry per requested item.
 * Returns session fingerprint settings per item when the connection provides
 * them, else null per item (no per-section configuration is exposed).
 */
function handleConfiguration(params: unknown, ctx: ServerRequestContext): unknown {
  const items = (params as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const settings = ctx.getConfigurationSettings();
  return items.map(() => settings ?? null);
}

/**
 * workspace/applyEdit: unsolicited edits are declined with { applied: false }.
 * The proposal is retained in memory for inspection; zero disk writes happen
 * here regardless of what the edit contains.
 */
function handleApplyEdit(params: unknown, ctx: ServerRequestContext): unknown {
  ctx.retainApplyEditProposal(params);
  return { applied: false };
}

/**
 * window/workDoneProgress/create: register the token, reply null.
 * Accepts string or number tokens; missing/invalid tokens reply null
 * without registering. Never throws — malformed server requests must
 * not crash the read loop.
 */
function handleWorkDoneProgressCreate(params: unknown, ctx: ServerRequestContext): unknown {
  const token = (params as { token?: unknown } | undefined)?.token;
  if (typeof token === "string" || typeof token === "number") {
    if (typeof ctx.registerWorkDoneToken === "function") {
      ctx.registerWorkDoneToken(String(token));
    }
  }
  return null;
}

/** Dispatch map for server → client requests, keyed by LSP method. */
export const SERVER_REQUEST_HANDLERS: ReadonlyMap<string, ServerRequestHandler> = new Map<string, ServerRequestHandler>([
  ["workspace/configuration", handleConfiguration],
  ["workspace/workspaceFolders", (_params, ctx) => ctx.workspaceFolders()],
  ["workspace/applyEdit", handleApplyEdit],
  ["window/workDoneProgress/create", handleWorkDoneProgressCreate],
]);
