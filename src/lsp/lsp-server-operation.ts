/**
 * LSP server operation — acquisition, timeout/abort, and error policy.
 *
 * Split from lsp-bridge.ts: single choke point for server acquisition so
 * bridge/adapters never clone the cachedManager + getServer + withBudget
 * sequence. Per-op fallback semantics (null / [] / void / outcome status)
 * stay with the callers — this module only acquires and budgets.
 */
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cachedManager, acquireLease, releaseLease, type LSPManager } from "./lsp-manager.js";
import type { LSPConnection } from "./lsp-connection.js";
import { LSP_TIMEOUT_MS_DEFAULT } from "@rhinos0608/pi-workspace-protocol";
import {
  detectLanguageFromExtension,
  withBudget,
  type LspOutcomeOptions,
} from "./lsp-types.js";

export function toFileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

/**
 * Convert an LSP location URI to a filesystem path (fail-closed).
 *
 * file: scheme only — returns the path iff fileURLToPath succeeds, else null.
 * Non-file/malformed URIs (https:, untitled:, garbage, raw paths) return null
 * so callers can never resolve() a raw fallback string into a path
 * (cf. connection workspaceUriToPath, bridge legacyRenameUriToPath).
 */
export function lspUriToPath(uri: string): string | null {
  if (typeof uri !== "string" || uri.length === 0) return null;
  if (!uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    // Cross-platform fallback: POSIX file URLs (file:///Users/...) throw
    // ERR_INVALID_FILE_URL_PATH on Windows. Return the decoded pathname.
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return null;
    }
  }
}

export function toZeroBased(line1: number): number { return Math.max(0, line1 - 1); }

export const DEFAULT_OUTCOME_TIMEOUT_MS = LSP_TIMEOUT_MS_DEFAULT;

export interface WithServerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  purpose?: "warmup" | "request";
  /** Budget acquisition only; action keeps its own inner budgets (fresh-diagnostics poll). */
  unbudgetedAction?: boolean;
  descriptorId?: string;
  serverId?: string;
  role?: string;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  workspaceFolders?: string[];
  envOverlay?: Record<string, string>;
  allowInstall?: boolean;
  /** LSP method name gating exactly-once retry; retry only when idempotent observational. */
  method?: string;
}

/** Idempotent observational ops safe for exactly-once retry on dead connection. */
const IDEMPOTENT_OBSERVATIONAL_OPS = new Set([
  "workspace/symbol", "textDocument/hover", "textDocument/documentSymbol",
  "textDocument/definition", "textDocument/references", "textDocument/implementation",
]);

function isDeadConnectionError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /LSP server exited|dead|closed|ECONNRESET|EPIPE/i.test(m);
}

/**
 * Acquire a request-scoped server for root+langId and run action.
 * Returns null when no server is available (caller maps to its own
 * unavailable fallback). Budget + abort apply to both acquisition and
 * action when timeoutMs is set; otherwise acquisition is unbounded,
 * matching the legacy fire-and-forget reads. Throws on action error
 * (caller maps to its own degraded fallback).
 */
function toSessionOpts(opts?: WithServerOptions): Record<string, unknown> {
  return { purpose: opts?.purpose ?? "request", descriptorId: opts?.descriptorId, serverId: opts?.serverId, role: opts?.role, initializationOptions: opts?.initializationOptions, settings: opts?.settings, workspaceFolders: opts?.workspaceFolders, envOverlay: opts?.envOverlay, allowInstall: opts?.allowInstall };
}

function isIdempotentRetry(opts?: WithServerOptions): boolean {
  return !!opts?.method && IDEMPOTENT_OBSERVATIONAL_OPS.has(opts.method);
}

async function acquireSessionServer(mgr: LSPManager, langId: string, sessionOpts: Record<string, unknown>, opts?: WithServerOptions): Promise<LSPConnection | null> {
  if (opts?.timeoutMs === undefined) return mgr.getServer(langId, { ...sessionOpts } as any);
  return withBudget(mgr.getServer(langId, { ...sessionOpts } as any), opts.timeoutMs, opts.signal);
}

async function runActionWithLease<T>(server: LSPConnection, mgr: LSPManager, action: (server: LSPConnection, mgr: LSPManager) => Promise<T>, opts?: WithServerOptions): Promise<T> {
  const key = (server as any).sessionKey as string | undefined;
  if (key) acquireLease(key);
  try {
    if (opts?.timeoutMs === undefined || opts.unbudgetedAction) return action(server, mgr);
    return withBudget(action(server, mgr), opts.timeoutMs, opts.signal);
  } finally {
    if (key) releaseLease(key);
  }
}

async function runOnce<T>(mgr: LSPManager, langId: string, sessionOpts: Record<string, unknown>, action: (server: LSPConnection, mgr: LSPManager) => Promise<T>, opts?: WithServerOptions): Promise<T | null> {
  const server = await acquireSessionServer(mgr, langId, sessionOpts, opts);
  if (!server) return null;
  return runActionWithLease(server, mgr, action, opts);
}

export async function withServer<T>(
  root: string,
  langId: string,
  action: (server: LSPConnection, mgr: LSPManager) => Promise<T>,
  opts?: WithServerOptions,
): Promise<T | null> {
  const mgr = cachedManager(root);
  const sessionOpts = toSessionOpts(opts);
  // Exactly-once retry: dead-connection + idempotent observational context only.
  try {
    return await runOnce(mgr, langId, sessionOpts, action, opts);
  } catch (e) {
    if (!isDeadConnectionError(e) || !isIdempotentRetry(opts)) throw e;
    return runOnce(mgr, langId, sessionOpts, action, opts);
  }
}

/** Manager-level operations (workspaceSymbol, hover, file tracking) share one acquisition point. */
export async function withManager<T>(
  root: string,
  action: (mgr: LSPManager) => Promise<T>,
): Promise<T> {
  return action(cachedManager(root));
}

/**
 * Shared outcome skeleton: language check → request-scoped server → budgeted action
 * → empty/confirmed mapping, degraded on any throw. Status strings preserved.
 *
 * Takes a single param object.
 */
export interface RunOutcomeParams<Value, Outcome> {
  filePath: string;
  root: string;
  opts: LspOutcomeOptions | undefined;
  makeUnavailable: () => Outcome;
  makeEmpty: () => Outcome;
  makeConfirmed: (value: Value) => Outcome;
  makeDegraded: () => Outcome;
  isEmpty: (value: Value) => boolean;
  action: (server: LSPConnection) => Promise<Value>;
}

async function executeOutcome<Value, Outcome>(p: RunOutcomeParams<Value, Outcome>): Promise<Outcome> {
  const timeoutMs = p.opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
  const langId = detectLanguageFromExtension(p.filePath);
  if (!langId) return p.makeUnavailable();
  try {
    // Box the value so action-level null/empty never conflates with no-server null.
    const boxed = await withServer(
      p.root,
      langId,
      async (server) => ({ value: await p.action(server) }),
      { timeoutMs, signal: p.opts?.signal },
    );
    if (!boxed) return p.makeUnavailable();
    if (p.isEmpty(boxed.value)) return p.makeEmpty();
    return p.makeConfirmed(boxed.value);
  } catch { return p.makeDegraded(); }
}

export async function runOutcome<Value, Outcome>(
  params: RunOutcomeParams<Value, Outcome>,
): Promise<Outcome> {
  return executeOutcome(params);
}
