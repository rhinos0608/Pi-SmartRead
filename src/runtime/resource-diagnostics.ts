import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isStateRoot } from "../workspace/state-root.js";

export interface ResourceDiagnosticSample {
  timestamp: number;
  pid: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  activeHandles: number;
  fdCount: number | null;
}

export const DIAGNOSTICS_ENV = "PI_SMARTREAD_DIAGNOSTICS";

function countFileDescriptors(): number | null {
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    try {
      return readdirSync("/dev/fd").length;
    } catch {
      return null;
    }
  }
}

export function collectResourceDiagnosticSample(): ResourceDiagnosticSample {
  const mem = process.memoryUsage();
  return {
    timestamp: Date.now(),
    pid: process.pid,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    activeHandles: typeof (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles === "function"
      ? (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().length
      : 0,
    fdCount: countFileDescriptors(),
  };
}

export function diagnosticsPath(root: string, pid = process.pid): string {
  return join(resolve(root), ".pi-smartread", `diagnostics-${pid}.ndjson`);
}

/**
 * Append one sample, but only at the canonical state root (state-root fix):
 * anywhere else the write is skipped and `null` is returned. Never throws
 * because persistence was skipped.
 */
export function writeResourceDiagnosticSample(root: string, sample = collectResourceDiagnosticSample()): string | null {
  if (!isStateRoot(root)) return null;
  const path = diagnosticsPath(root, sample.pid);
  mkdirSync(join(resolve(root), ".pi-smartread"), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
  return path;
}

let activeTimer: NodeJS.Timeout | null = null;

export function startResourceDiagnostics(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.Timeout | null {
  if (env[DIAGNOSTICS_ENV] !== "1") return null;
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
  // Fail closed: no canonical state root → no diagnostics file, no timer.
  if (writeResourceDiagnosticSample(root) === null) return null;
  activeTimer = setInterval(() => writeResourceDiagnosticSample(root), 5_000);
  activeTimer.unref?.();
  return activeTimer;
}

export function stopResourceDiagnostics(): void {
  if (activeTimer) clearInterval(activeTimer);
  activeTimer = null;
}
