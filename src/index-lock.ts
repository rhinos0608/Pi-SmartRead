import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface IndexLockOptions {
  staleMs?: number;
}

export interface IndexLockStatus {
  locked: boolean;
  path: string;
  owner?: { pid?: number; createdAt?: number; name?: string };
}

const LOCK_DIR = ".pi-smartread";
const DEFAULT_STALE_MS = 5 * 60_000;

function lockPath(root: string, name: string): string {
  return join(resolve(root), LOCK_DIR, `${name}.lock`);
}

function readOwner(path: string): IndexLockStatus["owner"] {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as IndexLockStatus["owner"];
  } catch {
    return undefined;
  }
}

function isStale(owner: IndexLockStatus["owner"], staleMs: number): boolean {
  if (!owner?.createdAt) return true;
  return Date.now() - owner.createdAt > staleMs;
}

export function getIndexLockStatus(root: string, name = "index"): IndexLockStatus {
  const path = lockPath(root, name);
  if (!existsSync(path)) return { locked: false, path };
  return { locked: true, path, owner: readOwner(path) };
}

export function withIndexLockSync<T>(
  root: string,
  name: string,
  fn: () => T,
  options: IndexLockOptions = {},
): T {
  const path = lockPath(root, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  if (existsSync(path)) {
    const owner = readOwner(path);
    if (isStale(owner, staleMs)) {
      rmSync(path, { force: true });
    } else {
      throw new Error(`Index lock is already held: ${path}`);
    }
  }

  writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: Date.now(), name }), { flag: "wx", mode: 0o600 });
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}
