import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export const ACTION_SOURCE_MAX_BYTES = 1024 * 1024;
export const ACTION_SEMANTIC_EDIT_MAX_BYTES = 4 * 1024 * 1024;

export interface ActionSourceSnapshot {
  readonly canonicalPath: string;
  readonly bytes: Buffer;
  readonly text: string;
  readonly rawSha256: string;
  readonly textSha256: string;
}

export type ActionSourceFailure = "unavailable" | "invalid-utf8" | "too-large" | "cancelled" | "timeout" | "stale";
export type ActionSourceResult =
  | { readonly ok: true; readonly snapshot: ActionSourceSnapshot }
  | { readonly ok: false; readonly reason: ActionSourceFailure };

export interface ActionSourceIO {
  realpath(path: string): Promise<string>;
  open(path: string, flags: number): Promise<{
    stat(): Promise<{ isFile(): boolean; dev: number; ino: number; size: number }>;
    read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  }>;
  stat(path: string): Promise<{ isFile(): boolean; dev: number; ino: number }>;
}

const nodeIO: ActionSourceIO = { realpath, open, stat };

function aborted(signal?: AbortSignal, deadlineMs?: number, now = Date.now): ActionSourceFailure | null {
  if (signal?.aborted) return "cancelled";
  if (deadlineMs !== undefined && now() >= deadlineMs) return "timeout";
  return null;
}

export async function snapshotActionSource(
  path: string,
  options: { signal?: AbortSignal; deadlineMs: number; now?: () => number; io?: ActionSourceIO; maxBytes?: number },
): Promise<ActionSourceResult> {
  const { signal, deadlineMs, now = Date.now, io = nodeIO, maxBytes = ACTION_SOURCE_MAX_BYTES } = options;
  const check = (): ActionSourceFailure | null => aborted(signal, deadlineMs, now);
  if (!Number.isFinite(deadlineMs)) return { ok: false, reason: "timeout" };
  const before = check();
  if (before) return { ok: false, reason: before };
  const named = resolve(path);
  let handle: Awaited<ReturnType<ActionSourceIO["open"]>> | undefined;
  let result: ActionSourceResult;
  try {
    result = await (async (): Promise<ActionSourceResult> => {
      const canonical = await io.realpath(named);
      const afterRealpath = check();
      if (afterRealpath) return { ok: false, reason: afterRealpath };

      handle = await io.open(canonical, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      const afterOpen = check();
      if (afterOpen) return { ok: false, reason: afterOpen };

      const opened = await handle.stat();
      const afterFstat = check();
      if (afterFstat) return { ok: false, reason: afterFstat };
      if (!opened.isFile()) return { ok: false, reason: "unavailable" };
      if (opened.size > maxBytes) return { ok: false, reason: "too-large" };

      const parts: Buffer[] = [];
      let total = 0;
      while (true) {
        const interrupted = check();
        if (interrupted) return { ok: false, reason: interrupted };
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        const afterRead = check();
        if (afterRead) return { ok: false, reason: afterRead };
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maxBytes) return { ok: false, reason: "too-large" };
        parts.push(buffer.subarray(0, bytesRead));
      }

      const bytes = Buffer.concat(parts, total);
      const rebound = await io.realpath(named);
      const afterRebound = check();
      if (afterRebound) return { ok: false, reason: afterRebound };
      const namedInfo = await io.stat(named);
      const afterNamedStat = check();
      if (afterNamedStat) return { ok: false, reason: afterNamedStat };
      const canonicalInfo = await io.stat(canonical);
      const afterCanonicalStat = check();
      if (afterCanonicalStat) return { ok: false, reason: afterCanonicalStat };
      if (rebound !== canonical || !namedInfo.isFile() || !canonicalInfo.isFile() ||
          opened.dev !== namedInfo.dev || opened.ino !== namedInfo.ino ||
          opened.dev !== canonicalInfo.dev || opened.ino !== canonicalInfo.ino) {
        return { ok: false, reason: "stale" };
      }

      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { return { ok: false, reason: "invalid-utf8" }; }
      const finished = check();
      if (finished) return { ok: false, reason: finished };
      return { ok: true, snapshot: {
        canonicalPath: canonical,
        bytes,
        text,
        rawSha256: createHash("sha256").update(bytes).digest("hex"),
        textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
      } };
    })();
  } catch {
    const interrupted = check();
    result = { ok: false, reason: interrupted ?? "unavailable" };
  } finally {
    if (handle) await handle.close();
  }
  const afterClose = check();
  if (afterClose) return { ok: false, reason: afterClose };
  return result;
}
