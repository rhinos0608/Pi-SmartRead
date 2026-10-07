/**
 * Snapshot retention policy and garbage collection.
 *
 * Design invariant: GC is FAIL-CLOSED. If the module cannot determine whether
 * a snapshot is referenced, it does NOT delete it.
 *
 * This module is intentionally decoupled from workspace-snapshot-store:
 * it defines a minimal SnapshotStore interface the store can satisfy,
 * but never imports the store directly.
 */

// ── Branded snapshot identifier ──────────────────────────────────────

declare const __snapshotIdBrand: unique symbol;
export type SnapshotId = string & { readonly [__snapshotIdBrand]: true };

export function snapshotId(raw: string): SnapshotId {
  return raw as SnapshotId;
}

// ── Store interface (satisfied by workspace-snapshot-store) ──────────

export interface SnapshotRecord {
  id: SnapshotId;
  createdAt: number;
  sizeBytes: number;
  pinned: boolean;
}

/**
 * Minimal read-only store interface for retention queries.
 * The real workspace-snapshot-store implements this; retention
 * never imports the store module directly.
 */
export interface SnapshotStore {
  /** List every snapshot, newest first. */
  listSnapshots(): SnapshotRecord[];

  /**
   * Delete a single snapshot by id.
   * Returns true on success, false on failure.
   * Throws only on truly unexpected errors (fail-closed: treat throw as failure).
   */
  deleteSnapshot(id: SnapshotId): Promise<boolean>;
}

// ── Retention policy ────────────────────────────────────────────────

export interface SnapshotRetentionPolicy {
  /** Keep at least this many latest snapshots regardless of other rules. Default 16. */
  latestN: number;
  /** Total byte budget across retained snapshots. 0 = unlimited. */
  maxTotalBytes: number;
  /** Snapshots younger than this are never deleted, even if over budget. Default 24h. */
  retentionGracePeriodMs: number;
}

const DEFAULT_POLICY: SnapshotRetentionPolicy = {
  latestN: 16,
  maxTotalBytes: 0,
  retentionGracePeriodMs: 24 * 60 * 60 * 1000,
};

export function retentionPolicy(overrides: Partial<SnapshotRetentionPolicy> = {}): SnapshotRetentionPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

// ── Core logic ──────────────────────────────────────────────────────

/**
 * Compute snapshot IDs eligible for deletion.
 *
 * Protection rules (all must pass for eligibility):
 * 1. Not in activeRoots (active GoalStore references)
 * 2. Not pinned
 * 3. Older than gracePeriodMs
 * 4. Not within the latestN-protected window
 * 5. If maxTotalBytes > 0, part of the over-budget set (oldest first until within budget)
 *
 * Order: oldest first.
 * Caller must still verify the store can actually delete (fail-closed).
 */
export function computeRetentionCandidates(
  store: SnapshotStore,
  policy: Partial<SnapshotRetentionPolicy> = {},
  activeRoots: Set<SnapshotId> = new Set(),
): SnapshotId[] {
  const p = retentionPolicy(policy);
  const all = store.listSnapshots();

  // Build sorted list: newest first (assumed from store), but verify
  const sorted = [...all].sort((a, b) => b.createdAt - a.createdAt);

  // Always protect latestN
  const protectedIds = new Set<SnapshotId>(sorted.slice(0, p.latestN).map((s) => s.id));

  const now = Date.now();

  // Collect eligible candidates (oldest first for deletion order)
  const eligible: SnapshotRecord[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const snap = sorted[i]!;

    // Protected by latestN rank
    if (protectedIds.has(snap.id)) continue;

    // Active root reference
    if (activeRoots.has(snap.id)) continue;

    // Pinned
    if (snap.pinned) continue;

    // Within grace period
    if (now - snap.createdAt < p.retentionGracePeriodMs) continue;

    eligible.push(snap);
  }

  // eligible is already oldest-first (iterated from end of newest-first list)

  // Apply maxTotalBytes budget
  if (p.maxTotalBytes > 0) {
    // Keep everything that fits within the budget, newest eligible first
    const eligibleNewestFirst = [...eligible].sort((a, b) => b.createdAt - a.createdAt);
    let totalBytes = 0;
    const kept = new Set<SnapshotId>();

    // Sum non-candidate bytes first (protected snapshots count toward budget)
    const protectedBytes = sorted
      .filter((s) => protectedIds.has(s.id) || activeRoots.has(s.id) || s.pinned || (now - s.createdAt < p.retentionGracePeriodMs))
      .reduce((sum, s) => sum + s.sizeBytes, 0);
    totalBytes = protectedBytes;

    // Add eligible snapshots newest-first until budget is filled
    for (const snap of eligibleNewestFirst) {
      if (totalBytes + snap.sizeBytes <= p.maxTotalBytes) {
        totalBytes += snap.sizeBytes;
        kept.add(snap.id);
      }
    }

    // Only those NOT kept are candidates
    return eligible.filter((s) => !kept.has(s.id)).map((s) => s.id);
  }

  return eligible.map((s) => s.id);
}

// ── GC execution ────────────────────────────────────────────────────

export interface GcResult {
  deleted: SnapshotId[];
  errors: string[];
}

/**
 * Garbage-collect snapshots eligible for deletion.
 *
 * FAIL-CLOSED: any error during deletion or uncertainty about references
 * results in that snapshot being skipped (not deleted).
 */
export async function gcSnapshots(
  store: SnapshotStore,
  policy: Partial<SnapshotRetentionPolicy> = {},
  activeRoots: Set<SnapshotId> = new Set(),
): Promise<GcResult> {
  const candidates = computeRetentionCandidates(store, policy, activeRoots);
  const deleted: SnapshotId[] = [];
  const errors: string[] = [];

  for (const id of candidates) {
    try {
      const ok = await store.deleteSnapshot(id);
      if (ok) {
        deleted.push(id);
      } else {
        errors.push(`delete returned false for ${id}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`delete threw for ${id}: ${msg}`);
      // FAIL-CLOSED: do not mark as deleted, continue to next
    }
  }

  return { deleted, errors };
}
