import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkspaceSnapshotStore,
  computeSnapshotId,
  WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  snapshotDir,
} from "../../src/workspace-snapshot-store.js";
import type { SnapshotId } from "../../src/repository-intelligence-types.js";

let root: string;
let store: WorkspaceSnapshotStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smartread-wss-"));
  store = new WorkspaceSnapshotStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SAMPLE_MANIFEST = {
  snapshotId: "" as SnapshotId,
  workspaceRootHash: "abc123",
  sourceHash: "deadbeef01",
  graphRevision: 1,
  createdAt: "2025-01-15T10:00:00Z" as import("../../src/repository-intelligence-types.js").ISO8601,
  capabilityDigest: "cap0",
};

function makeManifest(overrides: Record<string, unknown> = {}) {
  const sourceHash = (overrides.sourceHash as string) ?? SAMPLE_MANIFEST.sourceHash;
  return { ...SAMPLE_MANIFEST, ...overrides, snapshotId: computeSnapshotId(sourceHash) };
}

// ── Round-trip ─────────────────────────────────────────────────────────────

describe("WorkspaceSnapshotStore", () => {
  it("write/read round-trip with data", () => {
    const manifest = makeManifest();
    const data = { files: ["a.ts", "b.ts"], edges: 3 };

    store.writeSnapshot(manifest, data);
    const result = store.getSnapshot(manifest.snapshotId);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot.manifest.snapshotId).toBe(manifest.snapshotId);
    expect(result.snapshot.manifest.sourceHash).toBe("deadbeef01");
    expect(result.snapshot.manifest.workspaceRootHash).toBe("abc123");
    expect(result.snapshot.manifest.graphRevision).toBe(1);
    expect(result.snapshot.manifest.schemaVersion).toBe(WORKSPACE_SNAPSHOT_SCHEMA_VERSION);
    expect(result.snapshot.data).toEqual(data);
  });

  it("write/read round-trip without data", () => {
    const manifest = makeManifest({ sourceHash: "nodata01" });
    store.writeSnapshot(manifest);
    const result = store.getSnapshot(manifest.snapshotId);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot.data).toBeUndefined();
  });

  it("returns missing for nonexistent snapshot", () => {
    const result = store.getSnapshot("nonexistent" as SnapshotId);
    expect(result.status).toBe("missing");
  });

  // ── Idempotency ────────────────────────────────────────────────────────

  it("same source hash produces same snapshot ID", () => {
    const sourceHash = "samehash001";
    const id1 = computeSnapshotId(sourceHash);
    const id2 = computeSnapshotId(sourceHash);
    expect(id1).toBe(id2);
  });

  it("write is idempotent — second write is no-op", () => {
    const manifest = makeManifest({ sourceHash: "idem01" });
    store.writeSnapshot(manifest, { v: 1 });
    store.writeSnapshot(manifest, { v: 2 }); // should be ignored

    const result = store.getSnapshot(manifest.snapshotId);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot.data).toEqual({ v: 1 }); // original preserved
  });

  // ── Corruption detection ───────────────────────────────────────────────

  it("returns corrupt on tampered manifest file", () => {
    const manifest = makeManifest({ sourceHash: "corrupt01" });
    store.writeSnapshot(manifest, { v: 1 });

    // Tamper with manifest on disk
    const mPath = join(snapshotDir(root, manifest.snapshotId), "manifest.json.gz");
    const raw = JSON.parse(
      gunzipSync(readFileSync(mPath)).toString("utf-8"),
    );
    raw.sourceHash = "TAMPERED";
    writeFileSync(mPath, gzipSync(Buffer.from(JSON.stringify(raw))));

    const result = store.getSnapshot(manifest.snapshotId);
    expect(result.status).toBe("corrupt");
  });

  it("returns corrupt on garbage file", () => {
    const id = computeSnapshotId("garbage01");
    const dir = snapshotDir(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json.gz"), Buffer.from([0x00, 0x01, 0x02]));

    const result = store.getSnapshot(id);
    expect(result.status).toBe("corrupt");
  });

  it("returns corrupt on schema version mismatch", () => {
    const manifest = makeManifest({ sourceHash: "vermismatch" });
    store.writeSnapshot(manifest);

    const mPath = join(snapshotDir(root, manifest.snapshotId), "manifest.json.gz");
    const raw = JSON.parse(
      gunzipSync(readFileSync(mPath)).toString("utf-8"),
    );
    raw.schemaVersion = 999;
    writeFileSync(mPath, gzipSync(Buffer.from(JSON.stringify(raw))));

    const result = store.getSnapshot(manifest.snapshotId);
    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("schema-version-mismatch");
  });

  it("returns corrupt on snapshot ID mismatch", () => {
    const manifest = makeManifest({ sourceHash: "idmismatch" });
    store.writeSnapshot(manifest);

    const mPath = join(snapshotDir(root, manifest.snapshotId), "manifest.json.gz");
    const raw = JSON.parse(
      gunzipSync(readFileSync(mPath)).toString("utf-8"),
    );
    raw.snapshotId = "fake-id-that-does-not-match";
    writeFileSync(mPath, gzipSync(Buffer.from(JSON.stringify(raw))));

    const result = store.getSnapshot(manifest.snapshotId);
    expect(result.status).toBe("corrupt");
    if (result.status !== "corrupt") return;
    expect(result.reason).toBe("snapshot-id-mismatch");
  });

  // ── Pin / unpin lifecycle ──────────────────────────────────────────────

  it("pinSnapshot / listPins / unpinSnapshot lifecycle", () => {
    const manifest = makeManifest({ sourceHash: "pinlifecycle" });
    store.writeSnapshot(manifest);

    store.pinSnapshot(manifest.snapshotId, {
      pinId: "pin-a",
      owner: "keystone",
      purpose: "R0",
      createdAt: "2025-01-15T10:00:00Z" as any,
    });
    store.pinSnapshot(manifest.snapshotId, {
      pinId: "pin-b",
      owner: "keystone",
      purpose: "CHECKPOINT",
      createdAt: "2025-01-15T11:00:00Z" as any,
    });

    const pins1 = store.listPins(manifest.snapshotId);
    expect(pins1).toHaveLength(2);
    expect(pins1[0]?.pinId).toBe("pin-a");
    expect(pins1[1]?.pinId).toBe("pin-b");

    store.unpinSnapshot(manifest.snapshotId, "pin-a");
    const pins2 = store.listPins(manifest.snapshotId);
    expect(pins2).toHaveLength(1);
    expect(pins2[0]?.pinId).toBe("pin-b");

    store.unpinSnapshot(manifest.snapshotId, "pin-b");
    const pins3 = store.listPins(manifest.snapshotId);
    expect(pins3).toHaveLength(0);
  });

  it("unpinSnapshot is no-op for nonexistent pinId", () => {
    const manifest = makeManifest({ sourceHash: "unpinnoop" });
    store.writeSnapshot(manifest);
    store.unpinSnapshot(manifest.snapshotId, "nonexistent");
    expect(store.listPins(manifest.snapshotId)).toHaveLength(0);
  });

  it("pinSnapshot throws for nonexistent snapshot", () => {
    expect(() =>
      store.pinSnapshot("nosuchid" as SnapshotId, {
        pinId: "x",
        owner: "test",
        createdAt: "2025-01-15T10:00:00Z" as any,
      }),
    ).toThrow("Snapshot nosuchid not found");
  });

  it("duplicate pinId replaces existing pin", () => {
    const manifest = makeManifest({ sourceHash: "pinreplace" });
    store.writeSnapshot(manifest);

    store.pinSnapshot(manifest.snapshotId, {
      pinId: "dup",
      owner: "v1",
      createdAt: "2025-01-15T10:00:00Z" as any,
    });
    store.pinSnapshot(manifest.snapshotId, {
      pinId: "dup",
      owner: "v2",
      purpose: "RN",
      createdAt: "2025-01-15T11:00:00Z" as any,
    });

    const pins = store.listPins(manifest.snapshotId);
    expect(pins).toHaveLength(1);
    expect(pins[0]?.owner).toBe("v2");
    expect(pins[0]?.purpose).toBe("RN");
  });

  // ── Concurrent writes ──────────────────────────────────────────────────

  it("concurrent writes with different IDs don't corrupt", async () => {
    const writes = Array.from({ length: 10 }, (_, i) => {
      const manifest = makeManifest({ sourceHash: `concurrent${i}` });
      return store.writeSnapshot(manifest, { index: i });
    });

    // All should have returned successfully
    expect(writes).toHaveLength(10);

    // Each should be independently readable
    for (let i = 0; i < 10; i++) {
      const manifest = makeManifest({ sourceHash: `concurrent${i}` });
      const result = store.getSnapshot(manifest.snapshotId);
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.snapshot.data).toEqual({ index: i });
      }
    }
  });
});
