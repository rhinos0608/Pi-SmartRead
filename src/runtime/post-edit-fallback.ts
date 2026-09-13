/**
 * Post-edit LSP diagnostics fallback.
 *
 * Pi-SmartEdit owns post-mutation LSP/compiler diagnostics for its own
 * `edit` tool and the native `write` tool. When Pi-SmartEdit is not
 * installed (or simply did not claim a given toolCallId), Pi-SmartRead
 * falls back to collecting *LSP-only* diagnostics (no compiler subprocess
 * — that stays out of scope here) and appends them to the tool result so
 * the model still sees them.
 *
 * This module must never throw out of its public entry point and must
 * never block the tool_result hotpath indefinitely — every LSP call is
 * best-effort and bounded by a hard timeout.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLSPBridge, type LSPDiagnostic } from "./lsp-bridge.js";
import { isDiagnosticsClaimed } from "./mutation-ownership.js";

/** Minimal shape of the native write/edit tool_result event we act on. */
export interface PostEditToolResultEvent {
  toolName: string;
  toolCallId: string;
  isError?: boolean;
  input?: { path?: unknown; [key: string]: unknown };
  content?: unknown[];
  /** Working directory to resolve `input.path` and the LSP project root against. */
  cwd?: string;
}

export interface PostEditFallbackResult {
  content: unknown[];
}

export interface PostEditFallbackOptions {
  /** Max time to wait for fresh diagnostics to arrive, in ms. Default 3000. */
  waitMs?: number;
  /** Poll interval while waiting for diagnostics, in ms. Default 150. */
  pollIntervalMs?: number;
}

const DEFAULT_WAIT_MS = 3000;
const DEFAULT_POLL_INTERVAL_MS = 150;
const MAX_DIAGNOSTIC_LINES = 12;

const SEVERITY_NAMES: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

function severityName(severity: number | undefined): string {
  if (severity === undefined) return "note";
  return SEVERITY_NAMES[severity] ?? "note";
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Format a bounded (<= MAX_DIAGNOSTIC_LINES lines) diagnostics block for
 * appending to tool_result content.
 */
export function formatDiagnosticsBlock(diagnostics: LSPDiagnostic[], filePath: string): string | undefined {
  if (diagnostics.length === 0) return undefined;
  const lines: string[] = [`[LSP diagnostics: ${filePath}]`];
  const maxEntries = MAX_DIAGNOSTIC_LINES - 1; // reserve the header line
  const shown = diagnostics.slice(0, maxEntries);
  for (const d of shown) {
    const loc = d.range ? `${d.range.start.line + 1}:${d.range.start.character + 1}` : "?";
    const message = d.message.replace(/\r\n?|\n/g, " ");
    lines.push(`  ${severityName(d.severity)} ${loc} ${message}`);
  }
  const remaining = diagnostics.length - shown.length;
  if (remaining > 0 && lines.length < MAX_DIAGNOSTIC_LINES) {
    lines.push(`  ...and ${remaining} more`);
  }
  return lines.join("\n");
}

/**
 * Poll bridge.getDiagnostics for up to `waitMs`, returning as soon as a
 * non-empty result shows up (i.e. the server pushed publishDiagnostics for
 * this file), or the last (possibly empty) result once the deadline passes.
 *
 * We poll the cached getDiagnostics() accessor rather than subscribing to
 * onNotification directly: LSPBridge (the public, cross-manager surface)
 * does not expose per-connection notification subscription, and
 * getDiagnostics already returns the same cache that publishDiagnostics
 * populates — polling it avoids reimplementing that plumbing.
 */
async function waitForDiagnostics(
  bridge: { getDiagnostics(filePath: string, root: string): Promise<LSPDiagnostic[]> },
  filePath: string,
  root: string,
  opts: PostEditFallbackOptions,
): Promise<LSPDiagnostic[]> {
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + waitMs;
  let last: LSPDiagnostic[] = [];
  while (true) {
    try {
      last = await bridge.getDiagnostics(filePath, root);
    } catch {
      return [];
    }
    if (last.length > 0) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return last;
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}

/**
 * Run the LSP-only post-edit diagnostics fallback for a successful native
 * write/edit tool_result whose toolCallId was NOT claimed by Pi-SmartEdit.
 *
 * Resolves to `undefined` (no-op) on any failure, unavailability, or when
 * there is simply nothing to report — callers should treat `undefined` as
 * "leave the tool result untouched".
 */
export async function runPostEditDiagnosticsFallback(
  event: PostEditToolResultEvent,
  opts: PostEditFallbackOptions = {},
): Promise<PostEditFallbackResult | undefined> {
  try {
    if (event.isError) return undefined;
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    if (!event.toolCallId) return undefined;
    if (isDiagnosticsClaimed(event.toolCallId)) return undefined;

    const rawPath = event.input?.path;
    if (typeof rawPath !== "string" || !rawPath) return undefined;

    const bridge = await getLSPBridge();
    if (!bridge) return undefined;

    const root = event.cwd ?? process.cwd();
    const resolvedPath = resolve(root, rawPath);
    if (!existsSync(resolvedPath)) return undefined;

    let text: string;
    try {
      text = readFileSync(resolvedPath, "utf-8");
    } catch {
      return undefined;
    }

    try {
      await bridge.openFile(resolvedPath, root);
      await bridge.updateFile(resolvedPath, text, root);
      await bridge.didSave(resolvedPath, root);
    } catch {
      return undefined;
    }

    const diagnostics = await waitForDiagnostics(bridge, resolvedPath, root, opts);
    if (!diagnostics || diagnostics.length === 0) return undefined;

    const block = formatDiagnosticsBlock(diagnostics, rawPath);
    if (!block) return undefined;

    const originalContent = Array.isArray(event.content) ? event.content : [];
    return { content: [...originalContent, { type: "text", text: block }] };
  } catch {
    return undefined;
  }
}
