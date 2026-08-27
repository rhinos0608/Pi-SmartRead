/**
 * Immutable multi-revision snapshot store for workspace state.
 *
 * Snapshots are CAS blobs stored under `.pi-smartread/snapshots/<snapshotId>/`.
 * Each snapshot contains a manifest (matching ARCHITECTURE.md §3P SnapshotRef)
 * and optional typed data. Files are gzip-compressed JSON, following the same
 * pattern as index-snapshot.ts.
 *
 * snapshotId = sha256(sourceHash) — deterministic, idempotent.
 * Pins prevent GC deletion (actual GC lives in snapshot-retention.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { SnapshotId, ISO8601 } from "./repository-intelligence-types.js";

// ── Schema ─────────────────────────────────────────────────────────────────

export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Manifest for a workspace snapshot. Field set matches ARCHITECTURE.md §3P
 * SnapshotRef exactly — no additions, no renames, no reordering.
 */
export interface WorkspaceSnapshotManifest {
  schemaVersion: number;
  snapshotId: SnapshotId;
  parentSnapshotId?: SnapshotId;
  workspaceRootHash: string;
  sourceHash: string; // sha256 of sorted (path + content-hash) pairs
  graphRevision: number;
  createdAt: ISO8601;
  capabilityDigest: string;
}

export interface WorkspaceSnapshot<T = unknown> {
  manifest: WorkspaceSnapshotManifest;
  data: T;
}

export interface SnapshotPin {
  pinId: string;
  owner: string;
  purpose?: string;
  createdAt: ISO8601;
}

export type SnapshotReadResult<T = unknown> =
  | { status: "ok"; snapshot: WorkspaceSnapshot<T> }
  | { status: "missing" }
  | { status: "corrupt"; reason: string };

// ── Identity ───────────────────────────────────────────────────────────────

export function computeSnapshotId(sourceHash: string): SnapshotId {
  return createHash("sha256").update(sourceHash).digest("hex") as SnapshotId;
}

// ── Paths ──────────────────────────────────────────────────────────────────

const SNAPSHOTS_DIR = ".pi-smartread/snapshots";

export function snapshotDir(root: string, snapshotId: string): string {
  return join(resolve(root), SNAPSHOTS_DIR, snapshotId);
}

function manifestPath(root: string, snapshotId: string): string {
  return join(snapshotDir(root, snapshotId), "manifest.json.gz");
}

function dataPath(root: string, snapshotId: string): string {
  return join(snapshotDir(root, snapshotId), "data.json.gz");
}

function pinsPath(root: string, snapshotId: string): string {
  return join(snapshotDir(root, snapshotId), "pins.json");
}

// ── Store ──────────────────────────────────────────────────────────────────

export class WorkspaceSnapshotStore {
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Read snapshot manifest + optional data.
   * Returns corrupt on any validation failure — never partial data.
   */
  getSnapshot<T = unknown>(snapshotId: string): SnapshotReadResult<T> {
    const mPath = manifestPath(this.root, snapshotId);

    if (!existsSync(mPath)) return { status: "missing" };

    try {
      const manifestRaw = gunzipSync(readFileSync(mPath)).toString("utf-8");
      const manifest = JSON.parse(manifestRaw) as WorkspaceSnapshotManifest;

      // Validate manifest fields
      if (manifest.schemaVersion !== WORKSPACE_SNAPSHOT_SCHEMA_VERSION) {
        return { status: "corrupt", reason: "schema-version-mismatch" };
      }
      if (manifest.snapshotId !== snapshotId) {
        return { status: "corrupt", reason: "snapshot-id-mismatch" };
      }
      if (typeof manifest.sourceHash !== "string" || manifest.sourceHash.length === 0) {
        return { status: "corrupt", reason: "missing-source-hash" };
      }
      if (typeof manifest.workspaceRootHash !== "string") {
        return { status: "corrupt", reason: "missing-workspace-root-hash" };
      }
      if (typeof manifest.graphRevision !== "number") {
        return { status: "corrupt", reason: "missing-graph-revision" };
      }
      if (typeof manifest.createdAt !== "string") {
        return { status: "corrupt", reason: "missing-created-at" };
      }
      if (typeof manifest.capabilityDigest !== "string") {
        return { status: "corrupt", reason: "missing-capability-digest" };
      }

      // CAS integrity: snapshotId must equal sha256(sourceHash)
      if (computeSnapshotId(manifest.sourceHash) !== manifest.snapshotId) {
        return { status: "corrupt", reason: "source-hash-integrity-violation" };
      }

      // Optional data blob
      let data: T = undefined as T;
      const dPath = dataPath(this.root, snapshotId);
      if (existsSync(dPath)) {
        const dataRaw = gunzipSync(readFileSync(dPath)).toString("utf-8");
        data = JSON.parse(dataRaw) as T;
      }

      return { status: "ok", snapshot: { manifest, data } };
    } catch {
      return { status: "corrupt", reason: "read-or-parse-failure" };
    }
  }

  /**
   * Write an immutable snapshot blob. Idempotent — if snapshot with same
   * snapshotId already exists, this is a no-op and returns the existing path.
   *
   * Returns the directory path for the snapshot.
   */
  writeSnapshot<T = unknown>(
    manifest: Omit<WorkspaceSnapshotManifest, "schemaVersion">,
    data?: T,
  ): string {
    const fullManifest: WorkspaceSnapshotManifest = {
      ...manifest,
      schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
    };

    const dir = snapshotDir(this.root, fullManifest.snapshotId);
    const mPath = manifestPath(this.root, fullManifest.snapshotId);

    // Idempotent: skip if already exists
    if (existsSync(mPath)) return dir;

    mkdirSync(dir, { recursive: true, mode: 0o700 });

    writeFileSync(
      mPath,
      gzipSync(Buffer.from(JSON.stringify(fullManifest))),
      { mode: 0o600 },
    );

    if (data !== undefined) {
      writeFileSync(
        dataPath(this.root, fullManifest.snapshotId),
        gzipSync(Buffer.from(JSON.stringify(data))),
        { mode: 0o600 },
      );
    }

    return dir;
  }

  // ── Pin management ─────────────────────────────────────────────────────

  /**
   * Add a pin to a snapshot. Idempotent for same pinId.
   * Creates the pin file if it doesn't exist.
   */
  pinSnapshot(snapshotId: string, pin: SnapshotPin): void {
    const dir = snapshotDir(this.root, snapshotId);
    if (!existsSync(dir)) {
      throw new Error(`Snapshot ${snapshotId} not found`);
    }

    const pins = this.readPins(snapshotId);
    const existing = pins.findIndex((p) => p.pinId === pin.pinId);
    if (existing >= 0) {
      pins[existing] = pin;
    } else {
      pins.push(pin);
    }
    this.writePins(snapshotId, pins);
  }

  /**
   * Remove a pin from a snapshot. No-op if pinId doesn't exist.
   */
  unpinSnapshot(snapshotId: string, pinId: string): void {
    const pins = this.readPins(snapshotId);
    const filtered = pins.filter((p) => p.pinId !== pinId);
    this.writePins(snapshotId, filtered);
  }

  /**
   * List all pins for a snapshot.
   */
  listPins(snapshotId: string): SnapshotPin[] {
    return this.readPins(snapshotId);
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private readPins(snapshotId: string): SnapshotPin[] {
    const path = pinsPath(this.root, snapshotId);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as SnapshotPin[];
    } catch {
      return [];
    }
  }

  private writePins(snapshotId: string, pins: SnapshotPin[]): void {
    writeFileSync(
      pinsPath(this.root, snapshotId),
      JSON.stringify(pins),
      { mode: 0o600 },
    );
  }
}
