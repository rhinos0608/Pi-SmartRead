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
import { cachedManager, type LSPManager } from "./lsp-manager.js";
import type { LSPConnection } from "./lsp-connection.js";
import {
  detectLanguageFromExtension,
  withBudget,
  type LspOutcomeOptions,
} from "./lsp-types.js";

export function toFileUri(filePath: string): string {
  return pathToFileURL(resolve(filePath)).href;
}

/**
 * Convert an LSP location URI to a filesystem path.
 *
 * Handles both `file://` URIs (via fileURLToPath) and raw filesystem paths.
 * Windows drive-letter paths like `D:\src\a.ts` are NOT file URIs and must
 * not be passed to fileURLToPath (which throws on them) — they are returned
 * as-is. Malformed file URIs fall back to the raw string rather than throwing.
 */
export function lspUriToPath(uri: string): string {
  if (typeof uri !== "string" || uri.length === 0) return uri;
  if (uri.startsWith("file:")) {
    try {
      return fileURLToPath(uri);
    } catch {
      // Cross-platform fallback: POSIX file URLs (file:///Users/...) throw
      // ERR_INVALID_FILE_URL_PATH on Windows. Return the decoded pathname.
      try {
        return decodeURIComponent(new URL(uri).pathname);
      } catch {
        return uri;
      }
    }
  }
  // Raw filesystem path (POSIX or Windows drive-letter like D:\...).
  return uri;
}

export function toZeroBased(line1: number): number { return Math.max(0, line1 - 1); }

export const DEFAULT_OUTCOME_TIMEOUT_MS = 5000;

export interface WithServerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  purpose?: "warmup" | "request";
  /** Budget acquisition only; action keeps its own inner budgets (fresh-diagnostics poll). */
  unbudgetedAction?: boolean;
}

/**
 * Acquire a request-scoped server for root+langId and run action.
 * Returns null when no server is available (caller maps to its own
 * unavailable fallback). Budget + abort apply to both acquisition and
 * action when timeoutMs is set; otherwise acquisition is unbounded,
 * matching the legacy fire-and-forget reads. Throws on action error
 * (caller maps to its own degraded fallback).
 */
export async function withServer<T>(
  root: string,
  langId: string,
  action: (server: LSPConnection, mgr: LSPManager) => Promise<T>,
  opts?: WithServerOptions,
): Promise<T | null> {
  const mgr = cachedManager(root);
  if (opts?.timeoutMs === undefined) {
    const server = await mgr.getServer(langId);
    if (!server) return null;
    return action(server, mgr);
  }
  const server = await withBudget(
    mgr.getServer(langId, { purpose: opts.purpose ?? "request" }),
    opts.timeoutMs,
    opts.signal,
  );
  if (!server) return null;
  if (opts.unbudgetedAction) return action(server, mgr);
  return withBudget(action(server, mgr), opts.timeoutMs, opts.signal);
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
 * Takes a single param object. Legacy 9-arg positional calls still work via
 * rest-arg normalization (callers outside this file change untouched).
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

type RunOutcomePositional<Value, Outcome> = [
  filePath: string,
  root: string,
  opts: LspOutcomeOptions | undefined,
  makeUnavailable: () => Outcome,
  makeEmpty: () => Outcome,
  makeConfirmed: (value: Value) => Outcome,
  makeDegraded: () => Outcome,
  isEmpty: (value: Value) => boolean,
  action: (server: LSPConnection) => Promise<Value>,
];

type RunOutcomeArgs<Value, Outcome> =
  | [params: RunOutcomeParams<Value, Outcome>]
  | RunOutcomePositional<Value, Outcome>;

function normalizeRunOutcomeArgs<Value, Outcome>(
  args: RunOutcomeArgs<Value, Outcome>,
): RunOutcomeParams<Value, Outcome> {
  if (args.length === 1) return args[0];
  const [filePath, root, opts, makeUnavailable, makeEmpty, makeConfirmed, makeDegraded, isEmpty, action] =
    args as RunOutcomePositional<Value, Outcome>;
  return { filePath, root, opts, makeUnavailable, makeEmpty, makeConfirmed, makeDegraded, isEmpty, action };
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
  ...args: RunOutcomeArgs<Value, Outcome>
): Promise<Outcome> {
  return executeOutcome(normalizeRunOutcomeArgs(args));
}
