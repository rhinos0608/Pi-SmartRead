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
 */
export function classifyGoldRow(
    gold: Pick<EvalRow, "file" | "startLine" | "endLine">,
    top5: Array<Pick<Top5Unit, "relFile" | "line" | "endLine">>,
    evidence: ClassifyEvidence,
): GoldOutcome {
    if (evidence.executionStatus?.startsWith("error:")) return "execution_error";
    if (goldCovered(gold, top5)) return "covered";
    if (evidence.abstained) return "abstained";
    if (goldFileHit(gold, top5)) return "retrieved_wrong_span";
    if (evidence.judged && evidence.preJudgeCovered === true) return "judge_dropped";
    if (evidence.shownCovered === true) return "below_top5";
    if (evidence.preJudgeFiles !== undefined && !evidence.preJudgeFiles.includes(gold.file)) {
        return "not_retrieved";
    }
    if (evidence.preJudgeFiles !== undefined && evidence.preJudgeFiles.includes(gold.file)) {
        return "retrieved_wrong_span";
    }
    return "retrieval_unobserved";
}

/**
 * Last 1-based line number of file text, or 0 when the file is empty.
 * Single owner of the corpus-walk EOF computation: grep-e2e.ts calls
 * this instead of inlining the split/endsWith logic.
 */
export function fileEndLine(text: string): number {
    if (text.length === 0) return 0;
    const parts = text.split("\n");
    return text.endsWith("\n") ? parts.length - 1 : parts.length;
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
