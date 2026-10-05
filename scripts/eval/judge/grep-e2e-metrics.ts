/**
 * Round-1 measurement-fidelity helpers (pure, no IO, no fixture edits).
 *
 * Owns: gate-constant record, legacy vs rendered token estimates,
 * fixture validation with the q02 answerable-without-gold policy, gold
 * overlap helpers, per-gold outcome classification over observable evidence
 * only, and dual-count (declared vs evaluable) summarization.
 *
 * Recall@5 over known golds is a LOWER-BOUND diagnostic over incomplete
 * labels, never universal true recall. Outcome categories explain only what
 * is observable from pre-judge/judge/post-judge snapshots; no causal claim
 * is invented when evidence is absent.
 */

export const GATE_CONSTANTS = {
    /** Full-text keep threshold (GREP_JUDGE_THRESHOLD). */
    keep: 0.4,
    /** Signature-only pointer wave (GREP_JUDGE_POINTER_THRESHOLD). */
    pointer: 0.45,
    /** Existence-gate abstention floor (GREP_JUDGE_EXISTS_ABSENT). */
    exists: 0.35,
    /** Find-mode threshold (unchanged). */
    find: 0.4,
} as const;

export interface EvalRow {
    qid: string;
    query: string;
    answerable: boolean;
    file: string;
    startLine: number;
    endLine: number;
    symbol: string | null;
    label: string;
    why: string;
}

export interface Top5Unit {
    relFile: string;
    line: number;
    endLine: number;
    name: string;
    snippet: string;
}

export type GoldOutcome =
    | "covered"
    | "label_unknown"
    | "not_retrieved"
    | "retrieval_unobserved"
    | "retrieved_wrong_span"
    | "top5_wrong_span"
    | "pool_wrong_span"
    | "below_top5"
    | "judge_dropped"
    | "execution_error"
    | "abstained";

export type QueryOutcomeLabel = GoldOutcome | "covered" | "mixed" | "unanswerable_ok" | "unanswerable_miss" | "error";

export interface QueryOutcome {
    qid: string;
    query: string;
    answerable: boolean;
    goldRows: number;
    coveredGoldRows: number;
    covered: boolean;
    fileHit: boolean;
    renderedChars: number;
    renderedTokens: number;
    /** Legacy harness estimate: ceil(chars/4) over top-5 unit strings only. */
    legacyTop5Tokens: number;
    top5: number;
    abstained: boolean;
    abstentionCorrect: boolean | null;
    outcome: QueryOutcomeLabel;
    status: string;
    elapsedMs: number;
    /** Read-ready span@5 under the rendered-token budget (additive; absent on old rows). */
    readReady?: boolean;
    readReadyTokens?: number;
}

/** Legacy harness token estimate: top-5 snippet strings only, not rendered output. */
export function legacyTop5TokenEstimate(top5: Top5Unit[]): number {
    const chars = top5
        .map((h) => `${h.relFile}:${h.line}-${h.endLine} ${h.name}\n${h.snippet}`.length)
        .reduce((a, b) => a + b, 0);
    return Math.ceil(chars / 4);
}

/** Rendered-output token estimate: exact guarded text length. A note is not zero output. */
export function renderedTokenEstimate(renderedText: string): number {
    return Math.ceil(renderedText.length / 4);
}

export function goldCovered(
    gold: Pick<EvalRow, "file" | "startLine" | "endLine">,
    units: Array<Pick<Top5Unit, "relFile" | "line" | "endLine">>,
): boolean {
    return units.some(
        (h) => h.relFile === gold.file && h.line <= gold.endLine && h.endLine >= gold.startLine,
    );
}

export function goldFileHit(
    gold: Pick<EvalRow, "file">,
    units: Array<Pick<Top5Unit, "relFile">>,
): boolean {
    return units.some((h) => h.relFile === gold.file);
}

export interface ClassifyEvidence {
    judged: boolean;
    abstained: boolean;
    /** Optional execution status; values starting with "error:" force execution_error. */
    executionStatus?: string;
    /** Repo-relative files present in the pre-judge fused pool (when observed). */
    preJudgeFiles?: string[];
    /** Whether the gold span overlapped any pre-judge candidate (when observed). */
    preJudgeCovered?: boolean;
    /** Whether the gold span overlaps shown hits beyond the top-5 window (when observed). */
    shownCovered?: boolean;
}

/**
 * Classify one gold row from observable evidence only. Without pre-judge
 * snapshots, pool-level causes (judge_dropped/below_top5) cannot be claimed
 * and fall back to the directly observed file/span outcome.
 *
 * Abstention is a QUERY-level flag recorded alongside, never a gold-row
 * outcome: abstained queries are still classified from pre-judge evidence
 * (judge_dropped / pool_wrong_span / not_retrieved) so retrieval evidence
 * is never masked. "retrieved_wrong_span" is retained as a legacy alias
 * accepted by readers but no longer emitted: same-file misses now split
 * into "top5_wrong_span" (gold file in rendered top-5, no overlap) vs
 * "pool_wrong_span" (gold file only beyond top-5 in the pre-judge pool).
 */
export function classifyGoldRow(
    gold: Pick<EvalRow, "file" | "startLine" | "endLine">,
    top5: Array<Pick<Top5Unit, "relFile" | "line" | "endLine">>,
    evidence: ClassifyEvidence,
): GoldOutcome {
    if (evidence.executionStatus?.startsWith("error:")) return "execution_error";
    if (goldCovered(gold, top5)) return "covered";
    // NOTE: evidence.abstained is deliberately NOT consulted here. It is a
    // query-level flag; falling through preserves the retrieval evidence.
    if (evidence.shownCovered === true) return "below_top5";
    if (evidence.judged && evidence.preJudgeCovered === true) return "judge_dropped";
    if (goldFileHit(gold, top5)) return "top5_wrong_span";
    if (evidence.preJudgeFiles !== undefined && !evidence.preJudgeFiles.includes(gold.file)) {
        return "not_retrieved";
    }
    if (evidence.preJudgeFiles !== undefined && evidence.preJudgeFiles.includes(gold.file)) {
        return "pool_wrong_span";
    }
    return "retrieval_unobserved";
}

/** Legacy alias: readers of old reports may still see this outcome. */
export function isWrongSpanOutcome(outcome: string): boolean {
    return outcome === "retrieved_wrong_span" || outcome === "top5_wrong_span" || outcome === "pool_wrong_span";
}

export interface FixtureValidation {
    totalRows: number;
    totalQueries: number;
    queryIds: string[];
    declaredAnswerableCount: number;
    evaluableAnswerableCount: number;
    unanswerableCount: number;
    totalGoldRows: number;
    /** q02 policy: "answerable_without_gold" — visible, never dropped or relabeled. */
    q02Disposition: "answerable_without_gold" | "absent" | "has_gold";
    errors: string[];
}

/**
 * Validate fixture rows as-is: 44 query strings, golds, and flags preserved.
 * q02 stays answerable_without_gold; inconsistent qids, malformed ranges,
 * and missing files are reported, never silently excluded.
 */
export function validateFixture(rows: EvalRow[], existingFiles: Set<string>, actualFileEnds?: Map<string, number>): FixtureValidation {
    const errors: string[] = [];
    const ALLOWED = new Set(["gold", "hard_negative", "easy_negative"]);
    const byQid = new Map<string, EvalRow[]>();
    for (const row of rows) {
        const group = byQid.get(row.qid) ?? [];
        group.push(row);
        byQid.set(row.qid, group);
    }
    for (const [qid, group] of byQid) {
        const queries = new Set(group.map((r) => r.query));
        if (queries.size > 1) errors.push(`${qid}: inconsistent query strings (${queries.size} variants)`);
        const flags = new Set(group.map((r) => String(r.answerable)));
        if (flags.size > 1) errors.push(`${qid}: inconsistent answerable flags`);
    }
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (!ALLOWED.has(row.label)) errors.push(`row ${i + 1} (${row.qid}): unknown label "${row.label}"`);
        if (!Number.isInteger(row.startLine) || !Number.isInteger(row.endLine)) {
            errors.push(`row ${i + 1} (${row.qid}): non-integer source range`);
        } else if (row.startLine < 1 || row.endLine < 1 || row.startLine > row.endLine) {
            errors.push(`row ${i + 1} (${row.qid}): malformed source range ${row.startLine}-${row.endLine}`);
        }
        if (row.label === "gold" && !existingFiles.has(row.file)) {
            errors.push(`${row.qid}: gold file missing under corpus root: ${row.file}`);
        }
        const actualEnd = actualFileEnds?.get(row.file);
        if (row.label === "gold" && actualEnd !== undefined && row.endLine > actualEnd) {
            errors.push(`${row.qid}: gold range beyond actual file end (${row.file}: ${row.endLine} > ${actualEnd})`);
        }
    }
    let declaredAnswerableCount = 0;
    let evaluableAnswerableCount = 0;
    let unanswerableCount = 0;
    let totalGoldRows = 0;
    for (const [, group] of byQid) {
        const answerable = group[0]!.answerable;
        const golds = group.filter((r) => r.label === "gold" && r.answerable).length;
        totalGoldRows += golds;
        if (!answerable) {
            unanswerableCount++;
        } else {
            declaredAnswerableCount++;
            if (golds > 0) evaluableAnswerableCount++;
        }
    }
    const q02 = byQid.get("q02");
    const q02Disposition = !q02
        ? "absent"
        : q02.filter((r) => r.label === "gold" && r.answerable).length > 0 ? "has_gold" : "answerable_without_gold";
    return {
        totalRows: rows.length,
        totalQueries: byQid.size,
        queryIds: [...byQid.keys()].sort(),
        declaredAnswerableCount,
        evaluableAnswerableCount,
        unanswerableCount,
        totalGoldRows,
        q02Disposition,
        errors,
    };
}

export interface QuerySummary {
    queries: number;
    errors: number;
    /** Completed judge-degraded runs: coverage kept, counted separately from hard errors. */
    degraded: number;
    meanRenderedTokensPerQuery: number;
    meanLegacyTop5TokensPerQuery: number;
    /** Known-gold item recall (NOT a lower bound of true recall: unknown positives can expand the denominator). */
    knownGoldRecallAt5: number | null;
    coveredGoldRows: number;
    totalGoldRows: number;
    /** Declared answerable set (includes answerable-without-gold q02). */
    declaredQueryCoverage: string;
    /** Evaluable answerable set (queries with >= 1 gold row). */
    evaluableQueryCoverage: string;
    fileHitAt5: string;
    abstentionCorrect: string;
    abstained: number;
    unanswerableReturnedNonempty: number;
    meanElapsedMs: number;
    outcomeCounts: Record<string, number>;
}

/** Dual-count summarization: declared (36 incl. q02) vs evaluable (35). */
export function summarizeQueries(queries: QueryOutcome[]): QuerySummary {
    const isHardError = (q: QueryOutcome): boolean => q.status.startsWith("error:");
    const isDegraded = (q: QueryOutcome): boolean => q.status.startsWith("judge_degraded");
    const answerableAll = queries.filter((q) => q.answerable);
    const evaluableAll = answerableAll.filter((q) => q.goldRows > 0);
    const unanswerable = queries.filter((q) => !q.answerable);
    const coveredOf = (q: QueryOutcome): boolean => !isHardError(q) && q.covered;
    const fileHitOf = (q: QueryOutcome): boolean => !isHardError(q) && q.fileHit;
    const goldRows = answerableAll.reduce((a, q) => a + q.goldRows, 0);
    const coveredRows = answerableAll.reduce((a, q) => a + (isHardError(q) ? 0 : q.coveredGoldRows), 0);
    const outcomeCounts: Record<string, number> = {};
    for (const q of queries) outcomeCounts[q.outcome] = (outcomeCounts[q.outcome] ?? 0) + 1;
    return {
        queries: queries.length,
        errors: queries.filter((q) => q.status.startsWith("error:")).length,
        degraded: queries.filter(isDegraded).length,
        meanRenderedTokensPerQuery: queries.length > 0
            ? queries.reduce((a, q) => a + q.renderedTokens, 0) / queries.length
            : 0,
        meanLegacyTop5TokensPerQuery: queries.length > 0
            ? queries.reduce((a, q) => a + q.legacyTop5Tokens, 0) / queries.length
            : 0,
        knownGoldRecallAt5: goldRows > 0 ? coveredRows / goldRows : null,
        coveredGoldRows: coveredRows,
        totalGoldRows: goldRows,
        declaredQueryCoverage: `${answerableAll.filter(coveredOf).length}/${answerableAll.length}`,
        evaluableQueryCoverage: `${evaluableAll.filter(coveredOf).length}/${evaluableAll.length}`,
        fileHitAt5: `${evaluableAll.filter(fileHitOf).length}/${evaluableAll.length}`,
        abstentionCorrect: `${unanswerable.filter((q) => !isHardError(q) && q.abstentionCorrect === true).length}/${unanswerable.length}`,
        abstained: unanswerable.filter((q) => q.abstained).length,
        unanswerableReturnedNonempty: unanswerable.filter((q) => !isHardError(q) && !q.abstained && q.top5 > 0).length,
        meanElapsedMs: queries.length > 0
            ? queries.reduce((a, q) => a + q.elapsedMs, 0) / queries.length
            : 0,
        outcomeCounts,
    };
}

/** Default rendered-token budget B for readReadySpanAt5. */
export const READ_READY_DEFAULT_BUDGET = 1500;
/** Fixed rendered window K for readReadySpanAt5. */
export const READ_READY_K = 5;

export interface RenderedSpan {
    lines: Set<number>;
}

/**
 * Parse the RENDERED line numbers from a captured card snippet (the
 * line-numbered text actually shown, e.g. "  20 | code") as the exact
 * SET of displayed gutter numbers. Metadata line/endLine ranges are NOT
 * trusted here. Returns null when no gutter numbers are present (the
 * card then contributes no rendered coverage).
 */
export function parseRenderedSpan(snippet: string): RenderedSpan | null {
    const lines = new Set<number>();
    for (const line of snippet.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s*[|:]/.exec(line);
        if (m) lines.add(Number(m[1]));
    }
    if (lines.size === 0) return null;
    return { lines };
}

export interface ReadReadyUnit {
    relFile: string;
    line: number;
    endLine: number;
    name?: string;
    snippet: string;
}

export interface ReadReadyResult {
    success: boolean;
    unitIndex: number | null;
    tokensUsed: number;
    spanLength: number | null;
    precision: number | null;
    iou: number | null;
    /** Rendered cards in the window with no parseable gutter lines. */
    noGutterUnits: number;
    /** True when unit blocks could not be located in captured text. */
    unmeasurable?: boolean;
}

function unitRenderedChars(unit: ReadReadyUnit): number {
    return `${unit.relFile}:${unit.line}-${unit.endLine} ${unit.name ?? ""}\n${unit.snippet}`.length;
}

function spanOverlapMetrics(gold: Pick<EvalRow, "startLine" | "endLine">, span: RenderedSpan): {
    precision: number; iou: number; length: number;
} {
    let overlap = 0;
    for (let line = gold.startLine; line <= gold.endLine; line++) {
        if (span.lines.has(line)) overlap++;
    }
    const unitLen = span.lines.size;
    const goldLen = gold.endLine - gold.startLine + 1;
    const union = unitLen + goldLen - overlap;
    return {
        precision: unitLen > 0 ? overlap / unitLen : 0,
        iou: union > 0 ? overlap / union : 0,
        length: unitLen,
    };
}

/**
 * Read-ready span@K under a fixed rendered-token budget: a gold row
 * succeeds if, within the first K rendered units AND within B tokens of
 * rendered output, some unit's RENDERED lines overlap the gold range.
 * Per-unit cost is ceil(rendered unit chars/4); units that would exceed
 * the budget are not consumed.
 */
export function scoreReadReadySpan(
    gold: Pick<EvalRow, "file" | "startLine" | "endLine">,
    units: ReadReadyUnit[],
    budget = READ_READY_DEFAULT_BUDGET,
    k = READ_READY_K,
): ReadReadyResult {
    let spent = 0;
    let noGutterUnits = 0;
    for (let i = 0; i < Math.min(k, units.length); i++) {
        const unit = units[i]!;
        const cost = Math.ceil(unitRenderedChars(unit) / 4);
        if (spent + cost > budget) break;
        spent += cost;
        if (unit.relFile !== gold.file) continue;
        const span = parseRenderedSpan(unit.snippet);
        if (!span) {
            noGutterUnits++;
            continue;
        }
        let hitsGold = false;
        for (let line = gold.startLine; line <= gold.endLine; line++) {
            if (span.lines.has(line)) { hitsGold = true; break; }
        }
        if (hitsGold) {
            const m = spanOverlapMetrics(gold, span);
            return { success: true, unitIndex: i, tokensUsed: spent, spanLength: m.length, precision: m.precision, iou: m.iou, noGutterUnits };
        }
    }
    return { success: false, unitIndex: null, tokensUsed: spent, spanLength: null, precision: null, iou: null, noGutterUnits };
}

export interface ReadReadySummary {
    queriesSuccess: string;
    coveredGoldRows: number;
    totalGoldRows: number;
    meanPrecision: number | null;
    meanIou: number | null;
    spanLengths: { p50: number | null; p90: number | null; max: number | null };
    singleGoldQueries: string;
    multiGoldQueries: string;
}

/** Summarize read-ready outcomes over evaluable answerable queries. Multi-gold queries reported separately. */
export function summarizeReadReady(
    perQuery: Array<{ answerable: boolean; goldRows: number; readReady?: boolean }>,
    perRow: Array<{ precision: number | null; iou: number | null; spanLength: number | null }>,
): ReadReadySummary {
    const evaluable = perQuery.filter((q) => q.answerable && q.goldRows > 0);
    const ok = evaluable.filter((q) => q.readReady).length;
    const single = evaluable.filter((q) => q.goldRows === 1);
    const multi = evaluable.filter((q) => q.goldRows > 1);
    const precisions = perRow.map((r) => r.precision).filter((v): v is number => v !== null);
    const ious = perRow.map((r) => r.iou).filter((v): v is number => v !== null);
    const lens = perRow.map((r) => r.spanLength).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const quantile = (p: number): number | null => {
        if (lens.length === 0) return null;
        return lens[Math.min(lens.length - 1, Math.floor(p * lens.length))]!;
    };
    return {
        queriesSuccess: `${ok}/${evaluable.length}`,
        coveredGoldRows: perRow.filter((r) => r.precision !== null && (r.precision ?? 0) > 0).length,
        totalGoldRows: perRow.length,
        meanPrecision: precisions.length > 0 ? precisions.reduce((a, b) => a + b, 0) / precisions.length : null,
        meanIou: ious.length > 0 ? ious.reduce((a, b) => a + b, 0) / ious.length : null,
        spanLengths: { p50: quantile(0.5), p90: quantile(0.9), max: lens.length > 0 ? lens[lens.length - 1]! : null },
        singleGoldQueries: `${single.filter((q) => q.readReady).length}/${single.length}`,
        multiGoldQueries: `${multi.filter((q) => q.readReady).length}/${multi.length}`,
    };
}
