/**
 * Search-level IR metrics and query-level bootstrap (pure, no IO).
 *
 * Ranking inputs are relevance arrays in rank order (`ranked[i] === true`
 * means position i+1 is relevant). Score/label inputs use
 * `{ score, relevant }` pairs. All functions validate at the boundary
 * and throw on empty arrays, NaN, k <= 0, or mismatched ids.
 */

export interface QueryResultCount {
    answerable: boolean;
    resultCount: number;
}

export interface ScoredRelevance {
    score: number;
    relevant: boolean;
}

export interface PrPoint {
    /** Distinct score threshold producing this step (ties emit one point). */
    threshold: number;
    precision: number;
    recall: number;
}

export interface ReliabilityBin {
    bin: number;
    lo: number;
    hi: number;
    count: number;
    meanPredicted: number;
    fracPositive: number;
}

export interface UtilityCosts {
    tp: number;
    tn: number;
    fp: number;
    fn: number;
}

export interface UtilityRow {
    threshold: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    utility: number;
}

export interface BootstrapOptions {
    iterations: number;
    seed: number;
    alpha: number;
    clusters?: string[];
}

export interface ConfidenceInterval {
    estimate: number;
    lower: number;
    upper: number;
    iterations: number;
    alpha: number;
}

export interface PairedScores {
    id: string;
    baseline: number;
    variant: number;
}

function assertRanked(ranked: boolean[], k: number): void {
    if (ranked.length === 0) throw new Error("ranked must be non-empty");
    if (!Number.isInteger(k) || k <= 0) throw new Error("k must be a positive integer");
    for (const r of ranked) {
        if (typeof r !== "boolean") throw new Error("ranked entries must be boolean");
    }
}

/** Precision@k: relevant retrieved in the top-k window / k. */
export function precisionAtK(ranked: boolean[], k: number): number {
    assertRanked(ranked, k);
    const top = ranked.slice(0, k);
    return top.filter(Boolean).length / top.length;
}

/**
 * Recall@k: relevant retrieved in the top-k window / totalRelevant.
 * Returns 0 (not null) when the window is empty.
 */
export function recallAtK(ranked: boolean[], k: number, totalRelevant: number): number {
    assertRanked(ranked, k);
    if (!Number.isInteger(totalRelevant) || totalRelevant <= 0) {
        throw new Error("totalRelevant must be a positive integer");
    }
    const top = ranked.slice(0, k);
    if (top.length === 0) return 0;
    return top.filter(Boolean).length / totalRelevant;
}

/** Reciprocal rank: 1 / rank of the first relevant result, else 0. */
export function reciprocalRank(ranked: boolean[]): number {
    if (ranked.length === 0) throw new Error("ranked must be non-empty");
    const idx = ranked.findIndex(Boolean);
    return idx === -1 ? 0 : 1 / (idx + 1);
}

/** Mean reciprocal rank over per-query rankings. */
export function meanReciprocalRank(rankings: boolean[][]): number {
    if (rankings.length === 0) throw new Error("rankings must be non-empty");
    return rankings.reduce((sum, r) => sum + reciprocalRank(r), 0) / rankings.length;
}

/**
 * nDCG@k with graded or binary gains.
 * DCG = sum gain_i / log2(i+2) over the retrieved top-k window;
 * IDCG@k = DCG of the top-k gains from the ideal ranking, i.e. the k
 * highest gains among ALL known relevant gains for the query (including
 * relevant items that were not retrieved). Pass them via `idealGains`;
 * when absent, the ideal ranking defaults to the full retrieved `gains`
 * array sorted descending (not the top-k slice). nDCG = DCG / IDCG
 * (0 when IDCG = 0, i.e. no relevant items are known).
 */
export function ndcgAtK(gains: number[], k: number, idealGains?: number[]): number {
    if (gains.length === 0) throw new Error("gains must be non-empty");
    if (!Number.isInteger(k) || k <= 0) throw new Error("k must be a positive integer");
    for (const g of gains) {
        if (!Number.isFinite(g) || g < 0) throw new Error("gains must be finite non-negative numbers");
    }
    const idealSource = idealGains ?? gains;
    if (idealSource.length === 0) throw new Error("idealGains must be non-empty");
    for (const g of idealSource) {
        if (!Number.isFinite(g) || g < 0) throw new Error("idealGains must be finite non-negative numbers");
    }
    const top = gains.slice(0, k);
    const dcg = top.reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
    const ideal = [...idealSource].sort((a, b) => b - a).slice(0, k)
        .reduce((sum, g, i) => sum + g / Math.log2(i + 2), 0);
    return ideal === 0 ? 0 : dcg / ideal;
}

function assertQueryCounts(queries: QueryResultCount[]): void {
    if (queries.length === 0) throw new Error("queries must be non-empty");
    for (const q of queries) {
        if (!Number.isInteger(q.resultCount) || q.resultCount < 0) {
            throw new Error("resultCount must be a non-negative integer");
        }
    }
}

/**
 * False no-results rate: fraction of ANSWERABLE queries returning zero
 * results. Null when no answerable query exists.
 */
export function falseNoResultsRate(queries: QueryResultCount[]): number | null {
    assertQueryCounts(queries);
    const answerable = queries.filter((q) => q.answerable);
    if (answerable.length === 0) return null;
    return answerable.filter((q) => q.resultCount === 0).length / answerable.length;
}

/**
 * Correct-abstention rate: fraction of UNANSWERABLE queries returning zero
 * results. Null when no unanswerable query exists.
 */
export function correctAbstentionRate(queries: QueryResultCount[]): number | null {
    assertQueryCounts(queries);
    const unanswerable = queries.filter((q) => !q.answerable);
    if (unanswerable.length === 0) return null;
    return unanswerable.filter((q) => q.resultCount === 0).length / unanswerable.length;
}

function assertPairs(pairs: ScoredRelevance[]): ScoredRelevance[] {
    if (pairs.length === 0) throw new Error("pairs must be non-empty");
    for (const p of pairs) {
        if (!Number.isFinite(p.score)) throw new Error("scores must be finite numbers");
        if (typeof p.relevant !== "boolean") throw new Error("relevant must be boolean");
    }
    return [...pairs].sort((a, b) => b.score - a.score);
}

/**
 * PR curve from (score, relevant) pairs. Tied scores emit a single step
 * evaluated after the whole tie group, so intermediate within-tie points
 * never appear. Average precision = sum over each new relevant hit of
 * precision-at-that-step / total relevant.
 */
export function prCurveFromScores(pairs: ScoredRelevance[]): { points: PrPoint[]; averagePrecision: number } {
    const sorted = assertPairs(pairs);
    const totalRelevant = sorted.filter((p) => p.relevant).length;
    if (totalRelevant === 0) throw new Error("pairs must contain at least one relevant label");
    const points: PrPoint[] = [];
    let seen = 0;
    let hits = 0;
    let ap = 0;
    let i = 0;
    while (i < sorted.length) {
        const threshold = sorted[i]!.score;
        let j = i;
        while (j < sorted.length && sorted[j]!.score === threshold) {
            seen++;
            if (sorted[j]!.relevant) hits++;
            j++;
        }
        const precision = hits / seen;
        if (sorted.slice(i, j).some((p) => p.relevant)) {
            // Add per-hit contribution: each relevant item in the tie group
            // observed at the group precision (standard tie-averaged AP).
            const groupHits = sorted.slice(i, j).filter((p) => p.relevant).length;
            ap += groupHits * precision / totalRelevant;
        }
        points.push({ threshold, precision, recall: hits / totalRelevant });
        i = j;
    }
    return { points, averagePrecision: ap };
}

/** Average precision convenience wrapper over {@link prCurveFromScores}. */
export function averagePrecision(pairs: ScoredRelevance[]): number {
    return prCurveFromScores(pairs).averagePrecision;
}

/**
 * Expected calibration error with fixed equal-width bins (default 10 bins
 * over [0,1]; the last bin is closed on the right). Also returns the
 * per-bin reliability table for plotting.
 */
export function expectedCalibrationError(
    probs: number[],
    labels: boolean[],
    bins = 10,
): { ece: number; bins: ReliabilityBin[] } {
    if (probs.length === 0) throw new Error("probs must be non-empty");
    if (probs.length !== labels.length) throw new Error("probs and labels must have equal length");
    if (!Number.isInteger(bins) || bins <= 0) throw new Error("bins must be a positive integer");
    for (const p of probs) {
        if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("probs must be in [0, 1]");
    }
    const table: ReliabilityBin[] = Array.from({ length: bins }, (_, b) => ({
        bin: b,
        lo: b / bins,
        hi: (b + 1) / bins,
        count: 0,
        meanPredicted: 0,
        fracPositive: 0,
    }));
    probs.forEach((p, i) => {
        const b = Math.min(bins - 1, Math.floor(p * bins));
        const row = table[b]!;
        row.count++;
        row.meanPredicted += p;
        if (labels[i]) row.fracPositive++;
    });
    let ece = 0;
    for (const row of table) {
        if (row.count === 0) continue;
        row.meanPredicted /= row.count;
        row.fracPositive /= row.count;
        ece += row.count / probs.length * Math.abs(row.meanPredicted - row.fracPositive);
    }
    return { ece, bins: table };
}

function assertUtilityInputs(rows: ScoredRelevance[], costs: UtilityCosts): void {
    if (rows.length === 0) throw new Error("rows must be non-empty");
    for (const r of rows) {
        if (!Number.isFinite(r.score)) throw new Error("scores must be finite numbers");
    }
    for (const key of ["tp", "tn", "fp", "fn"] as const) {
        if (!Number.isFinite(costs[key])) throw new Error(`cost ${key} must be a finite number`);
    }
}

/**
 * Expected utility over a threshold sweep.
 * Utility = tp*TP + tn*TN + fp*FP + fn*FN at each distinct score
 * threshold (plus +Infinity = select none, -Infinity = select all);
 * returns the full sweep and the utility-optimal (first-max) threshold.
 */
export function expectedUtility(
    rows: ScoredRelevance[],
    costs: UtilityCosts,
): { sweep: UtilityRow[]; best: UtilityRow } {
    assertUtilityInputs(rows, costs);
    const distinct = [...new Set(rows.map((r) => r.score))].sort((a, b) => b - a);
    const thresholds = [Number.POSITIVE_INFINITY, ...distinct, Number.NEGATIVE_INFINITY];
    const sweep = thresholds.map((threshold) => {
        let tp = 0;
        let fp = 0;
        let fn = 0;
        let tn = 0;
        for (const r of rows) {
            const selected = r.score >= threshold;
            if (r.relevant && selected) tp++;
            else if (!r.relevant && selected) fp++;
            else if (r.relevant) fn++;
            else tn++;
        }
        return {
            threshold,
            truePositives: tp,
            falsePositives: fp,
            falseNegatives: fn,
            trueNegatives: tn,
            utility: costs.tp * tp + costs.tn * tn + costs.fp * fp + costs.fn * fn,
        };
    });
    let best = sweep[0]!;
    for (const row of sweep.slice(1)) {
        if (row.utility > best.utility) best = row;
    }
    return { sweep, best };
}

/** Seeded deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function assertBootstrap(values: number[], statFn: (v: number[]) => number, opts: BootstrapOptions): void {
    if (values.length === 0) throw new Error("values must be non-empty");
    for (const v of values) {
        if (!Number.isFinite(v)) throw new Error("values must be finite numbers");
    }
    if (typeof statFn !== "function") throw new Error("statFn must be a function");
    if (!Number.isInteger(opts.iterations) || opts.iterations <= 0) {
        throw new Error("iterations must be a positive integer");
    }
    if (!Number.isInteger(opts.seed)) throw new Error("seed must be an integer");
    if (!Number.isFinite(opts.alpha) || opts.alpha <= 0 || opts.alpha >= 1) {
        throw new Error("alpha must be in (0, 1)");
    }
    if (opts.clusters !== undefined && opts.clusters.length !== values.length) {
        throw new Error("clusters must align with values");
    }
}

function percentileSorted(sorted: number[], q: number): number {
    return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]!;
}

/**
 * Percentile bootstrap CI over per-query values with a seeded PRNG.
 * Optional `clusters` (e.g. repo ids) resamples clusters with replacement
 * instead of individual queries. Deterministic for a fixed seed.
 */
export function bootstrapCI(
    values: number[],
    statFn: (v: number[]) => number,
    opts: BootstrapOptions,
): ConfidenceInterval {
    assertBootstrap(values, statFn, opts);
    const estimate = statFn(values);
    if (!Number.isFinite(estimate)) throw new Error("statFn must return a finite number");
    const rand = mulberry32(opts.seed);
    const replicates: number[] = [];
    if (opts.clusters === undefined) {
        for (let b = 0; b < opts.iterations; b++) {
            const sample = Array.from(
                { length: values.length },
                () => values[Math.floor(rand() * values.length)]!,
            );
            const s = statFn(sample);
            if (!Number.isFinite(s)) throw new Error("statFn must return a finite number");
            replicates.push(s);
        }
    } else {
        const groups = new Map<string, number[]>();
        opts.clusters.forEach((c, i) => {
            groups.set(c, [...(groups.get(c) ?? []), values[i]!]);
        });
        const keys = [...groups.keys()];
        for (let b = 0; b < opts.iterations; b++) {
            const sample: number[] = [];
            for (let k = 0; k < keys.length; k++) {
                sample.push(...groups.get(keys[Math.floor(rand() * keys.length)]!)!);
            }
            const s = statFn(sample);
            if (!Number.isFinite(s)) throw new Error("statFn must return a finite number");
            replicates.push(s);
        }
    }
    replicates.sort((a, b) => a - b);
    return {
        estimate,
        lower: percentileSorted(replicates, opts.alpha / 2),
        upper: percentileSorted(replicates, 1 - opts.alpha / 2),
        iterations: opts.iterations,
        alpha: opts.alpha,
    };
}

/**
 * Paired bootstrap difference for variant-vs-baseline on matched query
 * ids: resamples pairs with replacement and applies statFn to the
 * per-pair (variant - baseline) differences. Throws on duplicate or
 * non-finite inputs.
 */
export function pairedBootstrapDiff(
    pairs: PairedScores[],
    statFn: (diffs: number[]) => number,
    opts: BootstrapOptions,
): ConfidenceInterval {
    if (pairs.length === 0) throw new Error("pairs must be non-empty");
    const seen = new Set<string>();
    const diffs: number[] = pairs.map((p) => {
        if (seen.has(p.id)) throw new Error(`duplicate query id: ${p.id}`);
        seen.add(p.id);
        if (!Number.isFinite(p.baseline) || !Number.isFinite(p.variant)) {
            throw new Error("baseline and variant must be finite numbers");
        }
        return p.variant - p.baseline;
    });
    return bootstrapCI(diffs, statFn, opts);
}
