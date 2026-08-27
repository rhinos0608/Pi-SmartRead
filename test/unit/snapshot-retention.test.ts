import { describe, expect, it, vi } from "vitest";
import {
  computeRetentionCandidates,
  gcSnapshots,
  retentionPolicy,
  snapshotId,
  type SnapshotRecord,
  type SnapshotStore,
} from "../../src/snapshot-retention.js";

// ── Test helpers ────────────────────────────────────────────────────

function snap(
  id: string,
  overrides: Partial<SnapshotRecord> = {},
): SnapshotRecord {
  return {
    id: snapshotId(id),
    createdAt: Date.now() - 10_000,
    sizeBytes: 1000,
    pinned: false,
    ...overrides,
  };
}

function makeStore(records: SnapshotRecord[]): SnapshotStore {
  const deleted = new Set<string>();
  return {
    listSnapshots: () => records.filter((r) => !deleted.has(r.id)),
    deleteSnapshot: vi.fn(async (id) => {
      deleted.add(id);
      return true;
    }),
  };
}

function makeFailingStore(records: SnapshotRecord[], failIds: Set<string>): SnapshotStore {
  const deleted = new Set<string>();
  return {
    listSnapshots: () => records.filter((r) => !deleted.has(r.id)),
    deleteSnapshot: vi.fn(async (id) => {
      if (failIds.has(id)) throw new Error(`cannot delete ${id}`);
      deleted.add(id);
      return true;
    }),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("retentionPolicy defaults", () => {
  it("applies default values", () => {
    const p = retentionPolicy();
    expect(p.latestN).toBe(16);
    expect(p.retentionGracePeriodMs).toBe(24 * 60 * 60 * 1000);
    expect(p.maxTotalBytes).toBe(0);
  });

  it("overrides defaults", () => {
    const p = retentionPolicy({ latestN: 5, maxTotalBytes: 10_000 });
    expect(p.latestN).toBe(5);
    expect(p.maxTotalBytes).toBe(10_000);
  });
});

describe("computeRetentionCandidates", () => {
  it("returns empty when nothing is eligible (all within latestN)", () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      snap(`s${i}`, { createdAt: Date.now() - i * 1000 }),
    );
    const store = makeStore(records);
    const candidates = computeRetentionCandidates(store, { latestN: 16 });
    expect(candidates).toEqual([]);
  });

  it("respects latestN: keeps newest 16 even if older ones are past grace period", () => {
    const now = Date.now();
    const hourMs = 3600_000;
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, {
        createdAt: now - i * hourMs,
        // s0 is newest, s19 is oldest
      }),
    );
    const store = makeStore(records);
    const candidates = computeRetentionCandidates(
      store,
      { latestN: 16, retentionGracePeriodMs: 0 },
    );
    // s16..s19 are outside latestN = eligible
    expect(candidates).toEqual([
      snapshotId("s19"),
      snapshotId("s18"),
      snapshotId("s17"),
      snapshotId("s16"),
    ]);
  });

  it("respects pins: pinned snapshots are never candidates", () => {
    const now = Date.now();
    const hourMs = 3600_000;
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, {
        createdAt: now - i * hourMs,
        pinned: i >= 16, // oldest 4 are pinned
      }),
    );
    const store = makeStore(records);
    const candidates = computeRetentionCandidates(
      store,
      { latestN: 16, retentionGracePeriodMs: 0 },
    );
    expect(candidates).toEqual([]);
  });

  it("respects activeRoots: snapshots in activeRoots are never candidates", () => {
    const now = Date.now();
    const hourMs = 3600_000;
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, { createdAt: now - i * hourMs }),
    );
    const activeRoots = new Set([snapshotId("s17"), snapshotId("s19")]);
    const store = makeStore(records);
    const candidates = computeRetentionCandidates(
      store,
      { latestN: 16, retentionGracePeriodMs: 0 },
      activeRoots,
    );
    // s16,s18 outside latestN but s17,s19 protected by activeRoots
    expect(candidates).toEqual([snapshotId("s18"), snapshotId("s16")]);
  });

  it("respects grace period: young snapshots are never candidates", () => {
    const now = Date.now();
    const hourMs = 3600_000;
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, { createdAt: now - i * hourMs }),
    );
    // Grace period = 18h: s0..s17 are within grace, s18,s19 are not
    // But s0..s15 are also protected by latestN=16
    // s16,s17 are only protected by grace
    // s18,s19 are eligible
    const store = makeStore(records);
    const candidates = computeRetentionCandidates(
      store,
      { latestN: 16, retentionGracePeriodMs: 18 * hourMs },
    );
    expect(candidates).toEqual([snapshotId("s19"), snapshotId("s18")]);
  });

  it("deletes nothing when nothing eligible", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      snap(`s${i}`, { createdAt: Date.now() - i * 1000 }),
    );
    const store = makeStore(records);
    const candidates = computeRetentionCandidates(store, { latestN: 16 });
    expect(candidates).toEqual([]);
  });

  it("maxTotalBytes budget: keeps eligible snapshots that fit within budget", () => {
    const now = Date.now();
    const hourMs = 3600_000;
    // 20 snapshots of 1000 bytes each, all past grace
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, {
        createdAt: now - i * hourMs,
        sizeBytes: 1000,
      }),
    );
    // latestN=2: s0,s1 protected by rank
    // s2..s19 = 18 candidates × 1000 bytes = 18000 bytes eligible
    // Budget = 5000: keep 5 newest eligible (s2..s6), delete rest (s7..s19)
    const store = makeStore(records);
    const candidates = computeRetentionCandidates(
      store,
      { latestN: 2, retentionGracePeriodMs: 0, maxTotalBytes: 5000 },
    );
    // Protected: s0,s1 (rank) + s2..s6 (budget) = 7 snapshots × 1000 = 7000 bytes
    // Wait: budget is total. Protected rank snapshots count too?
    // Let me re-check the logic...
    // Actually the logic sums protectedBytes (rank + activeRoots + pinned + grace) first,
    // then adds eligible newest-first.
    // Protected by rank: s0,s1 = 2000 bytes
    // Budget = 5000, remaining = 3000
    // Eligible newest first: s2,s3,s4,s5,s6,s7...
    // s2: 2000+1000=3000 <= 5000 → kept. s3: 4000 → kept. s4: 5000 → kept. s5: 6000 > 5000 → NOT kept.
    // So s5..s19 are candidates.
    expect(candidates.length).toBe(15);
    expect(candidates[0]).toBe(snapshotId("s19")); // oldest
    expect(candidates[14]).toBe(snapshotId("s5")); // newest candidate
  });

  it("maxTotalBytes=0 means no byte budget limit", () => {
    const now = Date.now();
    const hourMs = 3600_000;
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, {
        createdAt: now - i * hourMs,
        sizeBytes: 1000,
      }),
    );
    const store = makeStore(records);
    const candidates = computeRetentionCandidates(
      store,
      { latestN: 2, retentionGracePeriodMs: 0, maxTotalBytes: 0 },
    );
    // s2..s19 all eligible
    expect(candidates.length).toBe(18);
  });
});

describe("gcSnapshots", () => {
  it("deletes all candidates and returns them", async () => {
    const now = Date.now();
    const hourMs = 3600_000;
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, { createdAt: now - i * hourMs }),
    );
    const store = makeStore(records);
    const result = await gcSnapshots(store, {
      latestN: 16,
      retentionGracePeriodMs: 0,
    });
    expect(result.deleted.length).toBe(4);
    expect(result.errors).toEqual([]);
    expect(store.deleteSnapshot).toHaveBeenCalledTimes(4);
  });

  it("returns errors for failed deletions (fail-closed)", async () => {
    const now = Date.now();
    const hourMs = 3600_000;
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, { createdAt: now - i * hourMs }),
    );
    const store = makeFailingStore(records, new Set(["s18"]));
    const result = await gcSnapshots(store, {
      latestN: 16,
      retentionGracePeriodMs: 0,
    });
    expect(result.deleted).toContainEqual(snapshotId("s19"));
    expect(result.deleted).toContainEqual(snapshotId("s17"));
    expect(result.deleted).toContainEqual(snapshotId("s16"));
    expect(result.deleted).not.toContainEqual(snapshotId("s18"));
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("s18");
  });

  it("returns empty when nothing eligible", async () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      snap(`s${i}`, { createdAt: Date.now() - i * 1000 }),
    );
    const store = makeStore(records);
    const result = await gcSnapshots(store, { latestN: 16 });
    expect(result.deleted).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("deleteSnapshot returning false counts as error, not deletion", async () => {
    const now = Date.now();
    const hourMs = 3600_000;
    const records = Array.from({ length: 20 }, (_, i) =>
      snap(`s${i}`, { createdAt: now - i * hourMs }),
    );
    const store: SnapshotStore = {
      listSnapshots: () => records,
      deleteSnapshot: vi.fn(async () => false),
    };
    const result = await gcSnapshots(store, {
      latestN: 16,
      retentionGracePeriodMs: 0,
    });
    expect(result.deleted).toEqual([]);
    expect(result.errors.length).toBe(4); // s16..s19
  });
});
