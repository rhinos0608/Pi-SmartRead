export interface ScoredLabel {
    label: "gold" | "hard_negative" | "easy_negative";
    p: number;
}

export interface ThresholdMetrics {
    precision: number;
    recall: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
}

export interface JudgeMetrics {
    count: number;
    positiveCount: number;
    negativeCount: number;
    auroc: number | null;
    ece: number | null;
    thresholds: Record<string, ThresholdMetrics>;
}

export interface RocPoint {
    threshold: number;
    fpr: number;
    tpr: number;
}

export interface RocCurve {
    points: RocPoint[];
    auc: number | null;
}

export interface PrPoint {
    threshold: number;
    precision: number;
    recall: number;
}

export interface PrCurve {
    points: PrPoint[];
    averagePrecision: number | null;
}

export interface SweepRow {
    threshold: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    trueNegatives: number;
    precision: number;
    recall: number;
    f1: number;
}

export interface BestThreshold extends SweepRow {
    cost: number;
    fnCostRatio: number;
}

function calculateAuroc(positives: ScoredLabel[], negatives: ScoredLabel[]): number | null {
    if (positives.length === 0 || negatives.length === 0) return null;
    const wins = positives.reduce((sum, positive) =>
        sum + negatives.reduce((rank, negative) => rank + (positive.p > negative.p ? 1 : positive.p === negative.p ? 0.5 : 0), 0), 0);
    return wins / (positives.length * negatives.length);
}

function calculateEce(rows: ScoredLabel[], bins: number): number | null {
    if (rows.length === 0) return null;
    const calibrationBins = Array.from({ length: bins }, () => ({ count: 0, probability: 0, positives: 0 }));
    for (const row of rows) {
        const index = Math.min(bins - 1, Math.floor(row.p * bins));
        const bin = calibrationBins[index]!;
        bin.count++;
        bin.probability += row.p;
        if (row.label === "gold") bin.positives++;
    }
    return calibrationBins.reduce((sum, bin) => {
        if (bin.count === 0) return sum;
        return sum + bin.count / rows.length * Math.abs(bin.probability / bin.count - bin.positives / bin.count);
    }, 0);
}

function calculateThresholdMetrics(positives: ScoredLabel[], negatives: ScoredLabel[], threshold: number): ThresholdMetrics {
    const truePositives = positives.filter((row) => row.p >= threshold).length;
    const falsePositives = negatives.filter((row) => row.p >= threshold).length;
    const selected = truePositives + falsePositives;
    return {
        precision: selected === 0 ? 0 : truePositives / selected,
        recall: positives.length === 0 ? 0 : truePositives / positives.length,
        truePositives,
        falsePositives,
        falseNegatives: positives.length - truePositives,
    };
}

export function computeJudgeMetrics(rows: ScoredLabel[], thresholds = [0.2, 0.45], bins = 10): JudgeMetrics {
    if (!Number.isInteger(bins) || bins < 1) throw new Error("bins must be a positive integer");
    if (thresholds.some((threshold) => !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
        throw new Error("thresholds must be probabilities");
    }
    for (const row of rows) {
        if (!Number.isFinite(row.p) || row.p < 0 || row.p > 1) throw new Error("scores must be probabilities");
    }

    const positives = rows.filter((row) => row.label === "gold");
    const negatives = rows.filter((row) => row.label !== "gold");
    const thresholdResults = Object.fromEntries(thresholds.map((threshold) => [
        String(threshold), calculateThresholdMetrics(positives, negatives, threshold),
    ]));

    return {
        count: rows.length,
        positiveCount: positives.length,
        negativeCount: negatives.length,
        auroc: calculateAuroc(positives, negatives),
        ece: calculateEce(rows, bins),
        thresholds: thresholdResults,
    };
}

function validateScores(rows: ScoredLabel[]): void {
    for (const row of rows) {
        if (!Number.isFinite(row.p) || row.p < 0 || row.p > 1) throw new Error("scores must be probabilities");
    }
}

function countsAt(rows: ScoredLabel[], threshold: number): SweepRow {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    let trueNegatives = 0;
    for (const row of rows) {
        const positive = row.label === "gold";
        const selected = row.p >= threshold;
        if (positive && selected) truePositives++;
        else if (!positive && selected) falsePositives++;
        else if (positive) falseNegatives++;
        else trueNegatives++;
    }
    const selected = truePositives + falsePositives;
    const precision = selected === 0 ? 0 : truePositives / selected;
    const positives = truePositives + falseNegatives;
    const recall = positives === 0 ? 0 : truePositives / positives;
    const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    return { threshold, truePositives, falsePositives, falseNegatives, trueNegatives, precision, recall, f1 };
}

export function rocCurve(rows: ScoredLabel[]): RocCurve {
    validateScores(rows);
    const positives = rows.filter((row) => row.label === "gold");
    const negatives = rows.filter((row) => row.label !== "gold");
    if (positives.length === 0 || negatives.length === 0) return { points: [], auc: null };
    const distinct = [...new Set(rows.map((row) => row.p))].sort((a, b) => b - a);
    const grid: number[] = [Number.POSITIVE_INFINITY, ...distinct, 0];
    const seen = new Set<string>();
    const points: RocPoint[] = [];
    for (const threshold of grid) {
        const key = String(threshold);
        if (seen.has(key)) continue;
        seen.add(key);
        const counts = countsAt(rows, threshold);
        points.push({
            threshold,
            fpr: counts.falsePositives / negatives.length,
            tpr: counts.truePositives / positives.length,
        });
    }
    let auc = 0;
    for (let i = 1; i < points.length; i++) {
        auc += (points[i]!.fpr - points[i - 1]!.fpr) * (points[i]!.tpr + points[i - 1]!.tpr) / 2;
    }
    return { points, auc };
}

export function prCurve(rows: ScoredLabel[]): PrCurve {
    validateScores(rows);
    const positives = rows.filter((row) => row.label === "gold");
    const negatives = rows.filter((row) => row.label !== "gold");
    if (positives.length === 0 || negatives.length === 0) return { points: [], averagePrecision: null };
    const distinct = [...new Set(rows.map((row) => row.p))].sort((a, b) => b - a);
    const grid: number[] = [Number.POSITIVE_INFINITY, ...distinct, 0];
    const seen = new Set<string>();
    const points: PrPoint[] = [];
    for (const threshold of grid) {
        const key = String(threshold);
        if (seen.has(key)) continue;
        seen.add(key);
        const counts = countsAt(rows, threshold);
        points.push({ threshold, precision: counts.precision, recall: counts.recall });
    }
    let averagePrecision = 0;
    for (let i = 1; i < points.length; i++) {
        averagePrecision += (points[i]!.recall - points[i - 1]!.recall) * points[i]!.precision;
    }
    return { points, averagePrecision };
}

export function thresholdSweep(rows: ScoredLabel[], step = 0.05): SweepRow[] {
    validateScores(rows);
    if (!Number.isFinite(step) || step <= 0 || step > 1) throw new Error("step must be in (0, 1]");
    const thresholds: number[] = [];
    for (let t = 0; t < 1; t += step) thresholds.push(Math.round(t * 100) / 100);
    thresholds.push(1);
    return thresholds.map((threshold) => countsAt(rows, threshold));
}

export function bestThresholdByCost(rows: ScoredLabel[], fnCostRatio: number, step = 0.05): BestThreshold | null {
    validateScores(rows);
    if (!Number.isFinite(fnCostRatio) || fnCostRatio < 0) throw new Error("fnCostRatio must be a non-negative number");
    // Grid-searched over the discrete sweep grid (default 0.00..1.00), not a
    // continuous optimization: the true cost-optimal threshold may lie between grid points.
    const sweep = thresholdSweep(rows, step);
    if (sweep.length === 0) return null;
    let best = sweep[0]!;
    let bestCost = best.falsePositives + fnCostRatio * best.falseNegatives;
    for (const row of sweep.slice(1)) {
        const cost = row.falsePositives + fnCostRatio * row.falseNegatives;
        if (cost < bestCost) {
            best = row;
            bestCost = cost;
        }
    }
    return { ...best, cost: bestCost, fnCostRatio };
}

export function percentile(values: number[], quantile: number): number | null {
    if (values.length === 0) return null;
    if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) throw new Error("quantile must be between 0 and 1");
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}
