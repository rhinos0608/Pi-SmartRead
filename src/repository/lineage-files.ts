/**
 * File-level cross-revision lineage matching.
 *
 * Determines how files changed between two revisions: unchanged, moved,
 * moved-and-modified, or completely new/removed.
 *
 * @module lineage-files
 */

// ── Types ──────────────────────────────────────────────────────────────

/** Confidence class for file-level matches. */
export type FileMatchConfidence =
  | "verified"
  | "high"
  | "medium"
  | "POSSIBLE_MATCH";

/** Change kind for a file. */
export type FileChangeKind =
  | "UNCHANGED"
  | "MOVED"
  | "MOVED_AND_MODIFIED"
  | "RENAMED"
  | "MODIFIED"
  | "POSSIBLE_MATCH"
  | "REMOVED"
  | "ADDED";

/** A single file entry for lineage input. */
export interface FileEntry {
  readonly path: string;
  readonly contentHash: string;
  readonly content?: string;
  readonly edges?: ReadonlyArray<{ readonly to: string; readonly type: string }>;
}

/** Change record for a single file. */
export interface FileChange {
  readonly kind: FileChangeKind;
  readonly beforePath?: string;
  readonly afterPath?: string;
  readonly lineageId?: string;
  readonly score?: number;
  readonly confidence: FileMatchConfidence | "removed" | "added";
  readonly changedFacets: readonly string[];
}

/** Full result of computeFileLineage. */
export interface FileLineageResult {
  readonly algorithmVersion: "lineage-v1";
  readonly changes: readonly FileChange[];
  readonly metadata: {
    readonly beforeCount: number;
    readonly afterCount: number;
    readonly matchedCount: number;
    readonly possibleMatchCount: number;
    readonly unmatchedBeforeCount: number;
    readonly unmatchedAfterCount: number;
  };
}

// ── Constants ──────────────────────────────────────────────────────────

const MEDIUM_THRESHOLD = 0.78;
const POSSIBLE_MATCH_THRESHOLD = 0.60;
const ENDPOINT_MARGIN = 0.10;
const TOKEN_SHINGLE_MIN = 0.40;
const BASENAME_MIN = 0.70;

// ── Helpers ────────────────────────────────────────────────────────────

/** Normalize path for comparison: lowercase, forward slashes. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Extract basename from path. */
function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? "";
}

/** Tokenize content into tokens (split on whitespace/punctuation). */
function tokenize(content: string): string[] {
  return content.split(/[\s,;:.()\[\]{}<>=!+\-*/&|?@#$%^~`'"\\]+/).filter(Boolean);
}

/** Generate 5-token shingles from a token array. */
function tokenShingles(content: string): Set<string> {
  const tokens = tokenize(content);
  const shingles = new Set<string>();
  if (tokens.length < 5) {
    if (tokens.length > 0) {
      shingles.add(tokens.join(" "));
    }
    return shingles;
  }
  for (let i = 0; i <= tokens.length - 5; i++) {
    shingles.add(tokens.slice(i, i + 5).join(" "));
  }
  return shingles;
}

/** Jaccard similarity between two sets. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Longest common subsequence length. */
function lcsLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
      } else {
        curr[j] = Math.max(curr[j - 1] ?? 0, prev[j] ?? 0);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[n] ?? 0;
}

/** LCS-based path similarity: LCS / max(len). */
function normalizedPathSimilarity(a: string, b: string): number {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return lcsLength(na, nb) / maxLen;
}

/** Basename similarity: LCS of basename characters / max basename lengths. */
function basenameSimilarity(a: string, b: string): number {
  const ba = basename(a);
  const bb = basename(b);
  if (ba === bb) return 1;
  const maxLen = Math.max(ba.length, bb.length);
  if (maxLen === 0) return 1;
  return lcsLength(ba, bb) / maxLen;
}

/** Edge key set from edges array. */
function edgeKeys(
  edges: ReadonlyArray<{ readonly to: string; readonly type: string }> | undefined,
): Set<string> {
  const keys = new Set<string>();
  if (!edges) return keys;
  for (const e of edges) {
    keys.add(`${e.to}\0${e.type}`);
  }
  return keys;
}

/** Relationship neighborhood Jaccard between two entries. */
function relationshipJaccard(a: FileEntry, b: FileEntry): number {
  const ea = edgeKeys(a.edges);
  const eb = edgeKeys(b.edges);
  if (ea.size === 0 && eb.size === 0) return 0;
  return jaccard(ea, eb);
}

/** Compute candidate match score. */
function computeScore(before: FileEntry, after: FileEntry): number {
  const shinglesA = tokenShingles(before.content ?? before.contentHash);
  const shinglesB = tokenShingles(after.content ?? after.contentHash);

  const tokenJaccard =
    before.contentHash === after.contentHash
      ? 1.0
      : jaccard(shinglesA, shinglesB);

  return (
    0.55 * tokenJaccard +
    0.15 * normalizedPathSimilarity(before.path, after.path) +
    0.10 * basenameSimilarity(before.path, after.path) +
    0.20 * relationshipJaccard(before, after)
  );
}

// ── Matching ───────────────────────────────────────────────────────────

type Candidate = {
  beforeIdx: number;
  afterIdx: number;
  score: number;
  beforePath: string;
  afterPath: string;
};

type PoolEntry = { path: string; contentHash: string; content?: string; edges?: Array<{ to: string; type: string }> };

/**
 * Maximum-weight one-to-one bipartite matching via augmenting paths.
 *
 * 1. Greedy seed (sorted by score desc, deterministic tie-break).
 * 2. For each unmatched before-node, BFS for augmenting path to free after-node.
 * 3. Flip matched/unmatched edges along augmenting path.
 *
 * Node encoding: before-nodes = beforeIdx (>= 0), after-nodes = -(afterIdx + 1) (< 0).
 */
function maxWeightMatching(
  candidates: Candidate[],
  _beforePool: PoolEntry[],
  _afterPool: PoolEntry[],
): Candidate[] {
  if (candidates.length === 0) return [];

  // Deterministic sort for greedy seed
  const sorted = [...candidates].sort((a, b) => {
    const byScore = b.score - a.score;
    if (byScore !== 0) return byScore;
    const byBefore = a.beforePath.localeCompare(b.beforePath);
    if (byBefore !== 0) return byBefore;
    return a.afterPath.localeCompare(b.afterPath);
  });

  // Score lookup
  const scoreMap = new Map<string, Candidate>();
  for (const c of sorted) {
    const key = `${c.beforeIdx},${c.afterIdx}`;
    if (!scoreMap.has(key)) scoreMap.set(key, c);
  }

  const allBefore = [...new Set(candidates.map(c => c.beforeIdx))];

  // Adjacency: beforeIdx → afterIdx[] (candidate edges from this before-node)
  const adjB = new Map<number, number[]>();
  for (const c of candidates) {
    const list = adjB.get(c.beforeIdx);
    if (list) list.push(c.afterIdx);
    else adjB.set(c.beforeIdx, [c.afterIdx]);
  }

  // Greedy initial matching
  const matchA = new Map<number, Candidate>(); // beforeIdx → candidate
  const matchB = new Map<number, Candidate>(); // afterIdx → candidate

  for (const c of sorted) {
    if (matchA.has(c.beforeIdx) || matchB.has(c.afterIdx)) continue;
    matchA.set(c.beforeIdx, c);
    matchB.set(c.afterIdx, c);
  }

  // Augmenting path search for each unmatched before-node
  for (const start of allBefore) {
    if (matchA.has(start)) continue;

    // BFS nodes use encoding: beforeIdx >= 0, afterIdx encoded as -(afterIdx+1) < 0
    const visited = new Set<number>();
    // parent[node] = { prev: parent node (encoded), fromBefore: boolean }
    // fromBefore=true means edge prev→node is a "new" edge (before→after)
    // fromBefore=false means edge prev→node is an existing match edge (after→before)
    const parent = new Map<number, { prev: number; fromBefore: boolean }>();
    const queue: number[] = [start];
    visited.add(start);
    let foundEncoded: number | null = null;

    while (queue.length > 0 && foundEncoded === null) {
      const cur = queue.shift()!;

      if (cur >= 0) {
        // cur is a before-node: explore candidate edges to after-nodes
        const neighbors = adjB.get(cur) ?? [];
        for (const ai of neighbors) {
          const enc = -(ai + 1);
          if (visited.has(enc)) continue;
          visited.add(enc);
          parent.set(enc, { prev: cur, fromBefore: true });
          if (!matchB.has(ai)) {
            // Free after-node found
            foundEncoded = enc;
            break;
          }
          // Follow existing match: after-node ai → its matched before-node
          const matchedCandidate = matchB.get(ai)!;
          const matchedBefore = matchedCandidate.beforeIdx;
          if (!visited.has(matchedBefore)) {
            visited.add(matchedBefore);
            parent.set(matchedBefore, { prev: enc, fromBefore: false });
            queue.push(matchedBefore);
          }
        }
      }
    }

    if (foundEncoded === null) continue;

    // Trace path back from foundEncoded to start, collecting edges
    // Path: start → ... → foundEncoded
    // Edges alternate: new (fromBefore=true), existing match (fromBefore=false), new, ...
    // We flip: new edges become matched, existing match edges become unmatched
    let node = foundEncoded;
    while (node !== start) {
      const p = parent.get(node)!;
      // Edge: p.prev → node
      if (p.fromBefore) {
        // p.prev is beforeIdx, node is encoded afterIdx → ai = -node - 1
        const ai = -node - 1;
        const bIdx = p.prev;
        // This is a "new" edge → should be MATCHED after flip
        const key = `${bIdx},${ai}`;
        const entry = scoreMap.get(key);
        if (entry) {
          // Unmatch previous occupant of bIdx (if any)
          if (matchA.has(bIdx)) {
            const old = matchA.get(bIdx)!;
            matchB.delete(old.afterIdx);
          }
          // Unmatch previous occupant of ai (if any)
          if (matchB.has(ai)) {
            const old = matchB.get(ai)!;
            matchA.delete(old.beforeIdx);
          }
          matchA.set(bIdx, entry);
          matchB.set(ai, entry);
        }
      } else {
        // p.prev is encoded afterIdx, node is beforeIdx → EXISTING match edge
        // This edge should be UNMATCHED after flip
        const bIdx = node;
        const ai = -p.prev - 1;
        matchA.delete(bIdx);
        matchB.delete(ai);
      }
      node = p.prev;
    }
  }

  // Collect matched candidates in deterministic order
  return sorted.filter(c => matchA.has(c.beforeIdx) && matchB.has(c.afterIdx) && matchA.get(c.beforeIdx) === c);
}

/** Check if two candidate pairs are equal competitors (same score, same endpoint). */
function isEqualCompetitor(
  candidate: { beforePath: string; afterPath: string; score: number },
  allCandidates: Array<{ beforePath: string; afterPath: string; score: number }>,
): boolean {
  for (const other of allCandidates) {
    if (other === candidate) continue;
    if (other.score !== candidate.score) continue;
    if (
      other.beforePath === candidate.beforePath ||
      other.afterPath === candidate.afterPath
    ) {
      return true;
    }
  }
  return false;
}

// ── Core ───────────────────────────────────────────────────────────────

/** Stable line ID generator for deterministic output. */
let lineageCounter = 0;
function nextLineageId(): string {
  return `file-${String(lineageCounter++).padStart(6, "0")}`;
}

/**
 * Compute file-level lineage between two sets of file entries.
 *
 * @param before - files from the "before" revision
 * @param after - files from the "after" revision
 */
export function computeFileLineage(
  before: Array<{ path: string; contentHash: string; content?: string; edges?: Array<{ to: string; type: string }> }>,
  after: Array<{ path: string; contentHash: string; content?: string; edges?: Array<{ to: string; type: string }> }>,
): FileLineageResult {
  // Reset counter for deterministic output
  lineageCounter = 0;

  const changes: FileChange[] = [];
  const beforePool = [...before];
  const afterPool = [...after];

  // ── Step 1: Verified unchanged ──
  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();

  for (let i = 0; i < beforePool.length; i++) {
    const b = beforePool[i]!;
    for (let j = 0; j < afterPool.length; j++) {
      if (matchedAfter.has(j)) continue;
      const a = afterPool[j]!;
      if (normalizePath(b.path) === normalizePath(a.path) && b.contentHash === a.contentHash) {
        matchedBefore.add(i);
        matchedAfter.add(j);
        changes.push({
          kind: "UNCHANGED",
          beforePath: b.path,
          afterPath: a.path,
          lineageId: nextLineageId(),
          confidence: "verified",
          changedFacets: [],
        });
        break;
      }
    }
  }

  // ── Step 2: High-confidence moves (Git renames) — skipped per spec ──

  // ── Step 3: Generate candidate pairs ──
  const deletedIndices: number[] = [];
  const addedIndices: number[] = [];

  for (let i = 0; i < beforePool.length; i++) {
    if (!matchedBefore.has(i)) deletedIndices.push(i);
  }
  for (let j = 0; j < afterPool.length; j++) {
    if (!matchedAfter.has(j)) addedIndices.push(j);
  }

  const candidates: Candidate[] = [];

  for (const bi of deletedIndices) {
    const b = beforePool[bi]!;
    for (const ai of addedIndices) {
      const a = afterPool[ai]!;

      const shingleA = tokenShingles(b.content ?? b.contentHash);
      const shingleB = tokenShingles(a.content ?? a.contentHash);
      const tokenJac = jaccard(shingleA, shingleB);
      const bnameSim = basenameSimilarity(b.path, a.path);

      if (tokenJac >= TOKEN_SHINGLE_MIN || bnameSim >= BASENAME_MIN) {
        const score = computeScore(b, a);
        candidates.push({
          beforeIdx: bi,
          afterIdx: ai,
          score,
          beforePath: b.path,
          afterPath: a.path,
        });
      }
    }
  }

  // ── Step 5: Maximum-weight one-to-one matching ──
  const matched = maxWeightMatching(candidates, beforePool, afterPool);

  // ── Step 6: Confidence classification ──
  const usedBefore = new Set<number>(matched.map(m => m.beforeIdx));
  const usedAfter = new Set<number>(matched.map(m => m.afterIdx));

  for (const m of matched) {
    const b = beforePool[m.beforeIdx]!;
    const a = afterPool[m.afterIdx]!;

    // Find margin: best alternative score for each endpoint
    let bestAltBefore = 0;
    let bestAltAfter = 0;

    for (const c of candidates) {
      if (c.beforeIdx === m.beforeIdx && c.afterIdx !== m.afterIdx && c.score > bestAltBefore) {
        bestAltBefore = c.score;
      }
      if (c.afterIdx === m.afterIdx && c.beforeIdx !== m.beforeIdx && c.score > bestAltAfter) {
        bestAltAfter = c.score;
      }
    }

    const margin = Math.min(m.score - bestAltBefore, m.score - bestAltAfter);

    const sameHash = b.contentHash === a.contentHash;
    const samePath = normalizePath(b.path) === normalizePath(a.path);

    let confidence: FileMatchConfidence | "removed" | "added";
    let kind: FileChangeKind;
    const changedFacets: string[] = [];

    if (
      m.score >= MEDIUM_THRESHOLD &&
      margin >= ENDPOINT_MARGIN &&
      !isEqualCompetitor(m, candidates)
    ) {
      confidence = "medium";
      if (sameHash && samePath) {
        kind = "UNCHANGED";
      } else if (sameHash && !samePath) {
        kind = "MOVED";
      } else if (!sameHash && samePath) {
        kind = "MODIFIED";
        changedFacets.push("content");
      } else {
        kind = "MOVED_AND_MODIFIED";
        changedFacets.push("content");
        changedFacets.push("path");
      }
    } else if (m.score >= POSSIBLE_MATCH_THRESHOLD) {
      confidence = "POSSIBLE_MATCH";
      kind = "POSSIBLE_MATCH";
    } else {
      // Below threshold: not a match
      usedBefore.delete(m.beforeIdx);
      usedAfter.delete(m.afterIdx);
      continue;
    }

    changes.push({
      kind,
      beforePath: b.path,
      afterPath: a.path,
      lineageId: nextLineageId(),
      score: m.score,
      confidence,
      changedFacets,
    });
  }

  // ── Step 7: Remaining unmatched → removed/added ──
  for (let i = 0; i < beforePool.length; i++) {
    if (!matchedBefore.has(i) && !usedBefore.has(i)) {
      changes.push({
        kind: "REMOVED",
        beforePath: beforePool[i]!.path,
        lineageId: nextLineageId(),
        confidence: "removed",
        changedFacets: [],
      });
    }
  }
  for (let j = 0; j < afterPool.length; j++) {
    if (!matchedAfter.has(j) && !usedAfter.has(j)) {
      changes.push({
        kind: "ADDED",
        afterPath: afterPool[j]!.path,
        lineageId: nextLineageId(),
        confidence: "added",
        changedFacets: [],
      });
    }
  }

  // ── Sort changes deterministically ──
  changes.sort((a, b) => {
    const pathA = a.beforePath ?? a.afterPath ?? "";
    const pathB = b.beforePath ?? b.afterPath ?? "";
    return pathA.localeCompare(pathB);
  });

  // ── Compute metadata ──
  let matchedCount = 0;
  let possibleMatchCount = 0;
  let unmatchedBeforeCount = 0;
  let unmatchedAfterCount = 0;

  for (const c of changes) {
    if (c.confidence === "verified" || c.confidence === "high" || c.confidence === "medium") {
      matchedCount++;
    } else if (c.confidence === "POSSIBLE_MATCH") {
      possibleMatchCount++;
    }
    if (c.kind === "REMOVED") unmatchedBeforeCount++;
    if (c.kind === "ADDED") unmatchedAfterCount++;
  }

  return {
    algorithmVersion: "lineage-v1",
    changes,
    metadata: {
      beforeCount: before.length,
      afterCount: after.length,
      matchedCount,
      possibleMatchCount,
      unmatchedBeforeCount,
      unmatchedAfterCount,
    },
  };
}
