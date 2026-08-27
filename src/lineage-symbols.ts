/**
 * Symbol-level cross-revision lineage matching.
 *
 * Runs INSIDE file lineage results — symbol matching applies only within
 * files matched at medium or better confidence.
 *
 * Deterministic: no randomness, stable sort on ties, fixed-point scoring.
 *
 * @module lineage-symbols
 */

// ── Types ──────────────────────────────────────────────────────────────

/** Confidence class for symbol-level matches. */
export type MatchConfidence =
  | "verified"
  | "high"
  | "medium"
  | "POSSIBLE_MATCH"
  | "removed"
  | "added";

/** Parser availability for a language. */
export type ParserAvailability = "available" | "unavailable";

/** Enriched symbol representation for lineage matching. */
export interface SymbolTag {
  /** Unique symbol id across revisions (assigned externally or by content). */
  readonly id: string;
  /** Language e.g. "typescript", "python". */
  readonly language: string;
  /** Symbol kind: function, class, method, variable, type, etc. */
  readonly kind: string;
  /** Qualified name e.g. "MyClass.myMethod". */
  readonly qualifiedName: string;
  /** Signature hash (deterministic hash of the signature string). */
  readonly signatureHash: string;
  /** Normalized body hash (deterministic hash of stripped body). */
  readonly bodyHash: string;
  /** Token array of the body — for Jaccard similarity. */
  readonly bodyTokens: readonly string[];
  /** Signature string for similarity comparison. */
  readonly signature: string;
  /** Parent symbol qualified name, or null for top-level. */
  readonly parentQualifiedName: string | null;
  /** Outgoing relationship targets (called symbols, used types, etc). */
  readonly relationships: readonly string[];
}

/** Result of a single symbol match or lack thereof. */
export interface SymbolLineageResult {
  /** Matched before-symbol id, or null if added. */
  readonly beforeId: string | null;
  /** Matched after-symbol id, or null if removed. */
  readonly afterId: string | null;
  /** The assigned confidence. */
  readonly confidence: MatchConfidence;
  /** Numerical score (0..1) if computed, else null. */
  readonly score: number | null;
  /** Delta type. */
  readonly delta: "matched" | "modified" | "removed" | "added";
  /** True when parser/structural facts unavailable for this language. */
  readonly partial: boolean;
  /** When partial=true, absence claims must not rely on symbol identity. */
  readonly absenceClaimDisabled: boolean;
}

/** Algorithm metadata recorded per compute run. */
export interface SymbolLineageMetadata {
  readonly tokenizerVersion: string;
  readonly signalAvailability: {
    readonly exactHash: boolean;
    readonly gitLineage: boolean;
    readonly astLineage: boolean;
    readonly bodyTokens: boolean;
    readonly signatureSimilarity: boolean;
    readonly parentIndicator: boolean;
    readonly relationshipNeighborhood: boolean;
  };
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly matchedCount: number;
  readonly mediumThreshold: number;
  readonly possibleMatchThreshold: number;
  readonly endpointMargin: number;
}

/** Full output of computeSymbolLineage. */
export interface SymbolLineageOutput {
  readonly results: readonly SymbolLineageResult[];
  readonly metadata: SymbolLineageMetadata;
}

// ── Constants ──────────────────────────────────────────────────────────

const TOKENIZER_VERSION = "lineage-v1";
const MEDIUM_THRESHOLD = 0.82;
const POSSIBLE_MATCH_THRESHOLD = 0.65;
const ENDPOINT_MARGIN = 0.08;

const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
  verified: 0,
  high: 1,
  medium: 2,
  POSSIBLE_MATCH: 3,
  removed: 4,
  added: 5,
};

// ── Helpers ────────────────────────────────────────────────────────────

/** Stable sort comparator for deterministic output. */
function stableCompare(a: SymbolLineageResult, b: SymbolLineageResult): number {
  const aBefore = a.beforeId ?? "";
  const bBefore = b.beforeId ?? "";
  if (aBefore !== bBefore) return aBefore < bBefore ? -1 : 1;
  const aAfter = a.afterId ?? "";
  const bAfter = b.afterId ?? "";
  if (aAfter !== bAfter) return aAfter < bAfter ? -1 : 1;
  return CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
}

/** Jaccard similarity of two token arrays. */
function tokenJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Bigram-based string similarity (0..1). */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const aBi = bigrams(a.toLowerCase());
  const bBi = bigrams(b.toLowerCase());
  let common = 0;
  for (const bg of aBi) {
    if (bBi.has(bg)) common++;
  }
  const total = aBi.size + bBi.size - common;
  return total === 0 ? 0 : common / total;
}

/** Compute candidate score per architecture §3P. */
function computeCandidateScore(
  before: SymbolTag,
  after: SymbolTag,
  beforeParentMatched: boolean,
  afterParentMatched: boolean,
): number {
  const bodyJaccard = tokenJaccard(before.bodyTokens, after.bodyTokens);
  const sigSimilarity = stringSimilarity(before.signature, after.signature);
  const parentIndicator =
    beforeParentMatched && afterParentMatched ? 1.0 :
    before.parentQualifiedName === null && after.parentQualifiedName === null ? 0.5 :
    0.0;
  const relJaccard = tokenJaccard(before.relationships, after.relationships);

  return (
    0.50 * bodyJaccard +
    0.20 * sigSimilarity +
    0.15 * parentIndicator +
    0.15 * relJaccard
  );
}

/** Find second-best value in array excluding one index. */
function findSecondBest(arr: number[], excludeIdx: number): number {
  let best = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (i === excludeIdx) continue;
    const v = arr[i]!;
    if (v > best) best = v;
  }
  return best;
}

/** Check no other unmatched symbol ties with the given score. */
function noEqualCompetitor(
  costMatrix: number[][],
  row: number,
  col: number,
  myScore: number,
): boolean {
  for (let r = 0; r < costMatrix.length; r++) {
    if (r === row) continue;
    const v = costMatrix[r]![col]!;
    if (v >= myScore) return false;
  }
  const rowVals = costMatrix[row]!;
  for (let c = 0; c < rowVals.length; c++) {
    if (c === col) continue;
    if (rowVals[c]! >= myScore) return false;
  }
  return true;
}

// ── Hungarian algorithm ────────────────────────────────────────────────

/**
 * Maximum-weight one-to-one bipartite matching via Hungarian algorithm.
 * O(n^3) — fine for typical symbol counts.
 */
function hungarianMatch(
  costMatrix: number[][],
  rows: number,
  cols: number,
): Array<{ beforeIdx: number; afterIdx: number; score: number }> {
  const size = Math.max(rows, cols);
  // Large positive sentinel for minimization — delta starts at +∞
  const INF = 1e9;

  // typed arrays avoid noUncheckedIndexedAccess issues
  const u = new Float64Array(size + 1);
  const v = new Float64Array(size + 1);
  const p = new Int32Array(size + 1);
  const way = new Int32Array(size + 1);

  const a: Float64Array[] = [];
  for (let i = 0; i <= size; i++) {
    a.push(new Float64Array(size + 1));
  }

  for (let i = 0; i < rows; i++) {
    const costRow = costMatrix[i]!;
    for (let j = 0; j < cols; j++) {
      a[i + 1]![j + 1] = -costRow[j]!;
    }
  }

  for (let i = 1; i <= size; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(size + 1).fill(INF);
    const used = new Uint8Array(size + 1);

    do {
      used[j0] = 1;
      const i0 = p[j0]!;
      const aRow = a[i0]!;
      let delta = INF;
      let j1 = 0;

      for (let j = 1; j <= size; j++) {
        if (!used[j]) {
          const cur = aRow[j]! - u[i0]! - v[j]!;
          if (cur < minv[j]!) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j]! < delta) {
            delta = minv[j]!;
            j1 = j;
          }
        }
      }

      for (let j = 0; j <= size; j++) {
        if (used[j]) {
          u[p[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const result: Array<{ beforeIdx: number; afterIdx: number; score: number }> = [];
  for (let j = 1; j <= size; j++) {
    const pj = p[j]!;
    if (pj > 0 && pj <= rows && j <= cols) {
      result.push({
        beforeIdx: pj - 1,
        afterIdx: j - 1,
        score: costMatrix[pj - 1]![j - 1]!,
      });
    }
  }

  return result;
}

// ── Grouping ───────────────────────────────────────────────────────────

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const arr = map.get(key);
    if (arr) {
      arr.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

// ── Core ───────────────────────────────────────────────────────────────

/**
 * Compute symbol-level lineage between two sets of symbols.
 *
 * Only call when enclosing file match is medium or better.
 *
 * @param beforeSymbols - symbols from the "before" revision
 * @param afterSymbols - symbols from the "after" revision
 * @param fileConfidence - confidence of the enclosing file match
 * @param parserAvailability - per-language parser availability (defaults to all available)
 * @param hasGitLineage - whether Git/AST lineage signals are available
 */
export function computeSymbolLineage(
  beforeSymbols: readonly SymbolTag[],
  afterSymbols: readonly SymbolTag[],
  fileConfidence: MatchConfidence,
  parserAvailability?: Map<string, ParserAvailability>,
  hasGitLineage?: boolean,
): SymbolLineageOutput {
  // Guard: only runs when enclosing file is medium or better
  if (
    fileConfidence === "removed" ||
    fileConfidence === "added" ||
    fileConfidence === "POSSIBLE_MATCH"
  ) {
    return {
      results: [],
      metadata: buildMetadata(beforeSymbols.length, afterSymbols.length, 0, false, false),
    };
  }

  const availability = parserAvailability ?? new Map<string, ParserAvailability>();
  const gitLineage = hasGitLineage ?? false;

  const beforeByLang = groupBy(beforeSymbols, (s) => s.language);
  const afterByLang = groupBy(afterSymbols, (s) => s.language);
  const allLangs = new Set([...beforeByLang.keys(), ...afterByLang.keys()]);

  const results: SymbolLineageResult[] = [];
  let matchedCount = 0;
  let exactHashSignal = false;
  let anyGitLineage = false;
  let anyAstLineage = false;

  for (const lang of allLangs) {
    const beforeLang = beforeByLang.get(lang) ?? [];
    const afterLang = afterByLang.get(lang) ?? [];
    const avail = availability.get(lang) ?? ("available" as ParserAvailability);

    // §3P:4 — parser unavailable
    if (avail === "unavailable") {
      for (const sym of beforeLang) {
        results.push({
          beforeId: sym.id,
          afterId: null,
          confidence: "removed",
          score: null,
          delta: "removed",
          partial: true,
          absenceClaimDisabled: true,
        });
      }
      for (const sym of afterLang) {
        results.push({
          beforeId: null,
          afterId: sym.id,
          confidence: "added",
          score: null,
          delta: "added",
          partial: true,
          absenceClaimDisabled: true,
        });
      }
      continue;
    }

    // ── Pass 1: Exact match (same lang, kind, qualified name, sig hash, body hash) ──
    const matchedBefore = new Set<string>();
    const matchedAfter = new Set<string>();

    for (const b of beforeLang) {
      for (const a of afterLang) {
        if (matchedAfter.has(a.id)) continue;
        if (
          b.language === a.language &&
          b.kind === a.kind &&
          b.qualifiedName === a.qualifiedName &&
          b.signatureHash === a.signatureHash &&
          b.bodyHash === a.bodyHash
        ) {
          results.push({
            beforeId: b.id,
            afterId: a.id,
            confidence: "verified",
            score: 1.0,
            delta: "matched",
            partial: false,
            absenceClaimDisabled: false,
          });
          matchedBefore.add(b.id);
          matchedAfter.add(a.id);
          exactHashSignal = true;
          matchedCount++;
          break;
        }
      }
    }

    // ── Pass 2: Git/AST lineage + same kind/signature (content, not hash) ──
    // Architecture §3P: "Git/AST lineage plus same kind/signature → high"
    // signature means the actual signature content — renames keep same signature
    if (gitLineage) {
      for (const b of beforeLang) {
        if (matchedBefore.has(b.id)) continue;
        for (const a of afterLang) {
          if (matchedAfter.has(a.id)) continue;
          if (b.kind === a.kind && b.signature === a.signature) {
            const delta: SymbolLineageResult["delta"] = b.bodyHash === a.bodyHash ? "matched" : "modified";
            results.push({
              beforeId: b.id,
              afterId: a.id,
              confidence: "high",
              score: 0.97,
              delta,
              partial: false,
              absenceClaimDisabled: false,
            });
            matchedBefore.add(b.id);
            matchedAfter.add(a.id);
            anyGitLineage = true;
            matchedCount++;
            break;
          }
        }
      }
    }

    // ── Pass 3: Candidate scoring + bipartite matching ──
    const unmatchedBefore = beforeLang.filter((s) => !matchedBefore.has(s.id));
    const unmatchedAfter = afterLang.filter((s) => !matchedAfter.has(s.id));

    if (unmatchedBefore.length > 0 && unmatchedAfter.length > 0) {
      // Precompute parent match status
      const matchedParentBefore = new Set<string>();
      const matchedParentAfter = new Set<string>();
      for (const r of results) {
        if (r.beforeId && r.afterId && r.confidence !== "POSSIBLE_MATCH") {
          const bSym = beforeSymbols.find((s) => s.id === r.beforeId);
          const aSym = afterSymbols.find((s) => s.id === r.afterId);
          if (bSym?.parentQualifiedName) matchedParentBefore.add(bSym.parentQualifiedName);
          if (aSym?.parentQualifiedName) matchedParentAfter.add(aSym.parentQualifiedName);
        }
      }

      const costMatrix: number[][] = [];
      for (const b of unmatchedBefore) {
        const row: number[] = [];
        for (const a of unmatchedAfter) {
          if (b.language !== a.language || b.kind !== a.kind) {
            row.push(0);
            continue;
          }
          const bParentMatched = b.parentQualifiedName ? matchedParentBefore.has(b.parentQualifiedName) : true;
          const aParentMatched = a.parentQualifiedName ? matchedParentAfter.has(a.parentQualifiedName) : true;
          row.push(computeCandidateScore(b, a, bParentMatched, aParentMatched));
        }
        costMatrix.push(row);
      }

      const matching = hungarianMatch(costMatrix, unmatchedBefore.length, unmatchedAfter.length);

      for (const { beforeIdx, afterIdx, score } of matching) {
        if (score <= 0) continue;

        const b = unmatchedBefore[beforeIdx];
        const a = unmatchedAfter[afterIdx];
        if (!b || !a) continue;

        const myRow = costMatrix[beforeIdx]!;
        const myColumn = costMatrix.map((row) => row[afterIdx]!);

        const secondBestRow = findSecondBest(myRow, afterIdx);
        const secondBestCol = findSecondBest(myColumn, beforeIdx);
        const minMargin = Math.min(score - secondBestRow, score - secondBestCol);

        let confidence: MatchConfidence;
        let delta: SymbolLineageResult["delta"];

        if (
          score >= MEDIUM_THRESHOLD &&
          minMargin >= ENDPOINT_MARGIN &&
          noEqualCompetitor(costMatrix, beforeIdx, afterIdx, score)
        ) {
          confidence = "medium";
          delta = b.bodyHash === a.bodyHash ? "matched" : "modified";
          anyAstLineage = true;
          matchedCount++;
        } else if (score >= POSSIBLE_MATCH_THRESHOLD) {
          confidence = "POSSIBLE_MATCH";
          delta = b.bodyHash === a.bodyHash ? "matched" : "modified";
        } else {
          continue;
        }

        results.push({
          beforeId: b.id,
          afterId: a.id,
          confidence,
          score,
          delta,
          partial: false,
          absenceClaimDisabled: false,
        });
      }
    }

    // ── Pass 4: Unmatched → removed/added ──
    for (const b of beforeLang) {
      if (!matchedBefore.has(b.id) && !results.some((r) => r.beforeId === b.id && r.afterId !== null)) {
        results.push({
          beforeId: b.id,
          afterId: null,
          confidence: "removed",
          score: null,
          delta: "removed",
          partial: false,
          absenceClaimDisabled: false,
        });
      }
    }
    for (const a of afterLang) {
      if (!matchedAfter.has(a.id) && !results.some((r) => r.afterId === a.id && r.beforeId !== null)) {
        results.push({
          beforeId: null,
          afterId: a.id,
          confidence: "added",
          score: null,
          delta: "added",
          partial: false,
          absenceClaimDisabled: false,
        });
      }
    }
  }

  results.sort(stableCompare);

  const signalAvailability = {
    exactHash: exactHashSignal,
    gitLineage: anyGitLineage,
    astLineage: anyAstLineage,
    bodyTokens: true,
    signatureSimilarity: true,
    parentIndicator: true,
    relationshipNeighborhood: true,
  };

  return {
    results,
    metadata: {
      tokenizerVersion: TOKENIZER_VERSION,
      signalAvailability,
      beforeCount: beforeSymbols.length,
      afterCount: afterSymbols.length,
      matchedCount,
      mediumThreshold: MEDIUM_THRESHOLD,
      possibleMatchThreshold: POSSIBLE_MATCH_THRESHOLD,
      endpointMargin: ENDPOINT_MARGIN,
    },
  };
}

// ── Metadata builder ───────────────────────────────────────────────────

function buildMetadata(
  beforeCount: number,
  afterCount: number,
  matchedCount: number,
  gitLineage: boolean,
  astLineage: boolean,
): SymbolLineageMetadata {
  return {
    tokenizerVersion: TOKENIZER_VERSION,
    signalAvailability: {
      exactHash: false,
      gitLineage,
      astLineage,
      bodyTokens: true,
      signatureSimilarity: true,
      parentIndicator: true,
      relationshipNeighborhood: true,
    },
    beforeCount,
    afterCount,
    matchedCount,
    mediumThreshold: MEDIUM_THRESHOLD,
    possibleMatchThreshold: POSSIBLE_MATCH_THRESHOLD,
    endpointMargin: ENDPOINT_MARGIN,
  };
}
