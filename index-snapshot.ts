import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

export const SNAPSHOT_SCHEMA_VERSION = 1;

export interface IndexSnapshotManifest {
  schemaVersion: number;
  createdAt: number;
  root: string;
  kind: string;
  fileCount: number;
  tagCount?: number;
  edgeCount?: number;
  sourceHash: string;
}

export interface IndexSnapshot<T = unknown> {
  manifest: IndexSnapshotManifest;
  data: T;
}

export interface SnapshotVerification {
  status: "ok" | "missing" | "invalid" | "degraded";
  reason?: string;
  manifest?: IndexSnapshotManifest;
}

export function snapshotPath(root: string, kind: string): string {
  return join(resolve(root), ".pi-smartread", `${kind}-snapshot.json.gz`);
}

export function computeSourceHash(paths: string[]): string {
  return createHash("sha256").update([...paths].sort().join("\0")).digest("hex");
}

export function writeSnapshot<T>(root: string, kind: string, data: T, manifest: Omit<IndexSnapshotManifest, "schemaVersion" | "createdAt" | "root" | "kind">): string {
  const path = snapshotPath(root, kind);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const snapshot: IndexSnapshot<T> = {
    manifest: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      createdAt: Date.now(),
      root: resolve(root),
      kind,
      ...manifest,
    },
    data,
  };
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(snapshot))), { mode: 0o600 });
  return path;
}

export function readSnapshot<T = unknown>(root: string, kind: string): IndexSnapshot<T> | null {
  const path = snapshotPath(root, kind);
  if (!existsSync(path)) return null;
  try {
    const raw = gunzipSync(readFileSync(path)).toString("utf-8");
    const snapshot = JSON.parse(raw) as IndexSnapshot<T>;
    if (snapshot.manifest?.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
    if (snapshot.manifest.root !== resolve(root)) return null;
    if (snapshot.manifest.kind !== kind) return null;
    return snapshot;
  } catch {
    return null;
  }
}

export function verifySnapshot(root: string, kind: string, expected: { fileCount?: number; sourceHash?: string } = {}): SnapshotVerification {
  const snapshot = readSnapshot(root, kind);
  if (!snapshot) return { status: existsSync(snapshotPath(root, kind)) ? "invalid" : "missing" };

  const { manifest } = snapshot;
  if (expected.sourceHash && manifest.sourceHash !== expected.sourceHash) {
    return { status: "invalid", reason: "source-hash-mismatch", manifest };
  }
  if (expected.fileCount !== undefined && manifest.fileCount < Math.floor(expected.fileCount * 0.5)) {
    return { status: "degraded", reason: "file-count-ratio-below-threshold", manifest };
  }
  return { status: "ok", manifest };
}
