/**
 * D46 runner scoring: pure per-query scoring plus per-class and overall
 * aggregates over sealed D46 queries (D46, D59, D61).
 *
 * Gold paths are relative to the repo's corpusRoot and share a base with
 * system paths (the runner searches with root = <checkout>/<corpusRoot>).
 * Grade semantics are protocol-fixed: grade 1 = primary, 2 = supporting,
 * so gain(grade 1) > gain(grade 2).
 *
 * Depends only on existing metric primitives (no local copies):
 * ndcgAtK/recallAtK/reciprocalRank/precisionAtK from
 * scripts/eval/judge/ir-metrics.ts, and the displayed-lines predicate
 * (unitCoversGold/scoreReadReadySpan) plus the rendered-token budget from
 * scripts/eval/judge/grep-e2e-metrics.ts.
 */
import {
    ndcgAtK,
    recallAtK,
    reciprocalRank,
} from "../judge/ir-metrics.js";
import {
    READ_READY_DEFAULT_BUDGET,
    scoreReadReadySpan,
    unitCoversGold,
} from "../judge/grep-e2e-metrics.js";
import type { D46GoldSpan, D46Query } from "./schema.js";

/** Gain mapping for gold grades (D59: grade 1 outranks grade 2). */
export function gainForGrade(grade: 1 | 2): number {
    return grade === 1 ? 2 : 1;
}

/** One rendered system hit in rank order (top-5 window or wider). */
export interface D46RenderedUnit {
    /** File path relative to the corpusRoot, matching gold paths. */
    file: string;
    line: number;
    endLine: number;
    snippet: string;
}

export interface D46ScoreInput {
    query: D46Query;
    /** Rendered units in rank order (at least the top-5 window). */
    units: D46RenderedUnit[];
    /** Total rendered hits (0 with no output cards). */
    totalHits: number;
    /** Rendered output chars (headers/notes included) for the token budget. */
    renderedChars: number;
    /** Exact rendered tool text (for the measured read-ready cost path). */
    renderedText?: string;
    /** Routing mode recorded by the grep tool (e.g. smart/literal/regex). */
    routingMode: string;
    /** Whether the judge was invoked for this query. */
    judgeInvoked: boolean;
    /** Sanitized status code (`ok` or `error:<code>`). */
    status: string;
    elapsedMs: number;
}

export interface D46ScoredQuery {
    id: string;
    repo: string;
    class: D46Query["class"];
    answerable: boolean;
    /** Distinct rendered files in the top-5 window, first-appearance order. */
    top5Files: string[];
    successAt5: boolean;
    recallAt5: number | null;
    precisionAt5: number | null;
    mrr: number;
    ndcgAt5: number | null;
    readReadyAt5: boolean;
    readReadyTokens: number;
    falseEmpty: boolean;
    /** Absence queries only: any rendered hit is false content. */
    falseContent: boolean | null;
    correctAbstention: boolean | null;
    /** exact_ish only: judge invoked under literal/regex routing. */
    unexpectedJudge: boolean | null;
    routingMode: string;
    judgeInvoked: boolean;
    status: string;
    elapsedMs: number;
}

/**
 * First five distinct files in rendered rank order (same first-appearance
 * semantics as dedupeFilesByFirstAppearance in the external grep harness:
 * dedupe the FULL unit list, then cap at k — never truncate units first).
 */
function distinctTop5Files(units: D46RenderedUnit[], k = 5): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of units) {
        if (out.length >= k) break;
        if (!seen.has(u.file)) {
            seen.add(u.file);
            out.push(u.file);
        }
    }
    return out;
}

function goldFileGrades(gold: D46GoldSpan[]): Map<string, number> {
    const grades = new Map<string, number>();
    for (const span of gold) {
        const gain = gainForGrade(span.grade);
        if ((grades.get(span.path) ?? 0) < gain) grades.set(span.path, gain);
    }
    return grades;
}

export function scoreD46Query(input: D46ScoreInput): D46ScoredQuery {
    const { query, units } = input;
    const answerable = query.class !== "absence";
    const top5 = units.slice(0, 5);
    const top5Files = distinctTop5Files(units);
    const grades = goldFileGrades(query.gold);

    const goldFiles = [...grades.keys()];
    const hitFiles = top5Files.filter((f) => grades.has(f));
    const successAt5 = answerable && goldFiles.length > 0 ? hitFiles.length > 0 : false;

    // File-level relevance in distinct-file rank order for RR/precision/recall.
    const ranked = top5Files.map((f) => grades.has(f));
    // Graded gains in distinct-file rank order; the ideal ranking uses ALL
    // gold files (including unretrieved ones) per the ndcgAtK contract.
    const gains = top5Files.map((f) => grades.get(f) ?? 0);
    const idealGains = goldFiles.map((f) => grades.get(f) ?? 0);

    const hasGold = answerable && goldFiles.length > 0;
    const recallAt5 = hasGold ? recallAtK(ranked.length > 0 ? ranked : [false], 5, goldFiles.length) : null;
    const precisionAt5 = hasGold
        ? top5Files.length > 0
            // D46 column semantics: gold files in the first five distinct
            // rendered files / distinct files shown (<=5). The shared
            // precisionAtK divides by k per its contract, so D46 divides by
            // the shown count directly instead of reusing that helper.
            ? hitFiles.length / top5Files.length
            : 0
        : null;
    const mrr = hasGold ? reciprocalRank(ranked.length > 0 ? ranked : [false]) : 0;
    const ndcgAt5 = hasGold
        ? top5Files.length > 0
            ? ndcgAtK(gains, 5, idealGains)
            : 0
        : null;

    // Read-ready@5: a gold span succeeds when a top-5 unit's RENDERED
    // gutter lines overlap it within the rendered-token budget.
    let readReadyAt5 = false;
    let readReadyTokens = 0;
    if (hasGold) {
        const rows = query.gold.map((g) =>
            scoreReadReadySpan(
                { file: g.path, startLine: g.startLine, endLine: g.endLine },
                top5.map((u) => ({ relFile: u.file, line: u.line, endLine: u.endLine, snippet: u.snippet })),
                READ_READY_DEFAULT_BUDGET,
                5,
                input.renderedText,
            ),
        );
        // Span-level check via the displayed-lines predicate (unitCoversGold)
        // agrees with scoreReadReadySpan on gutter-bearing cards; keep both
        // honest by requiring the predicate too.
        const ok = rows.filter((r) => {
            if (!r.success || r.unitIndex === null) return false;
            const unit = top5[r.unitIndex];
            if (!unit) return false;
            return query.gold.some((g) =>
                g.path === unit.file &&
                unitCoversGold(
                    { file: g.path, startLine: g.startLine, endLine: g.endLine },
                    { relFile: unit.file, line: unit.line, endLine: unit.endLine, snippet: unit.snippet },
                ),
            );
        });
        readReadyAt5 = ok.length > 0;
        if (readReadyAt5) readReadyTokens = Math.min(...ok.map((r) => r.tokensUsed));
    }

    const falseEmpty = answerable && hasGold && input.totalHits === 0;
    const falseContent = answerable ? null : input.totalHits > 0;
    const correctAbstention = answerable ? null : input.totalHits === 0;
    const isLiteralRouting = input.routingMode === "literal" || input.routingMode === "regex";
    const unexpectedJudge = query.class === "exact_ish" ? input.judgeInvoked && isLiteralRouting : null;

    return {
        id: query.id,
        repo: query.repo,
        class: query.class,
        answerable,
        top5Files,
        successAt5,
        recallAt5,
        precisionAt5,
        mrr,
        ndcgAt5,
        readReadyAt5,
        readReadyTokens,
        falseEmpty,
        falseContent,
        correctAbstention,
        unexpectedJudge,
        routingMode: input.routingMode,
        judgeInvoked: input.judgeInvoked,
        status: input.status,
        elapsedMs: input.elapsedMs,
    };
}

export interface D46Aggregate {
    queries: number;
    successAt5: string;
    meanRecallAt5: number | null;
    meanPrecisionAt5: number | null;
    meanMrr: number;
    meanNdcgAt5: number | null;
    readReadyAt5: string;
    falseEmpty: number;
    falseContent: number | null;
    correctAbstention: string | null;
    unexpectedJudge: number | null;
    errors: number;
}

function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

export function aggregateD46(rows: D46ScoredQuery[]): D46Aggregate {
    const answerable = rows.filter((r) => r.answerable && r.recallAt5 !== null);
    const absence = rows.filter((r) => !r.answerable);
    const exactIsh = rows.filter((r) => r.unexpectedJudge !== null);
    return {
        queries: rows.length,
        successAt5: `${answerable.filter((r) => r.successAt5).length}/${answerable.length}`,
        meanRecallAt5: mean(answerable.map((r) => r.recallAt5 ?? 0)),
        meanPrecisionAt5: mean(answerable.map((r) => r.precisionAt5 ?? 0)),
        meanMrr: mean(rows.map((r) => r.mrr)) ?? 0,
        meanNdcgAt5: mean(answerable.map((r) => r.ndcgAt5 ?? 0)),
        readReadyAt5: `${answerable.filter((r) => r.readReadyAt5).length}/${answerable.length}`,
        falseEmpty: rows.filter((r) => r.falseEmpty).length,
        falseContent: absence.length > 0 ? absence.filter((r) => r.falseContent === true).length : null,
        correctAbstention:
            absence.length > 0
                ? `${absence.filter((r) => r.correctAbstention === true).length}/${absence.length}`
                : null,
        unexpectedJudge: exactIsh.length > 0 ? exactIsh.filter((r) => r.unexpectedJudge === true).length : null,
        errors: rows.filter((r) => r.status.startsWith("error:")).length,
    };
}

export interface D46ScoreReport {
    byClass: Record<string, D46Aggregate>;
    overall: D46Aggregate;
}

export function summarizeD46(rows: D46ScoredQuery[]): D46ScoreReport {
    const byClass: Record<string, D46Aggregate> = {};
    for (const row of rows) {
        byClass[row.class] = aggregateD46(rows.filter((r) => r.class === row.class));
    }
    return { byClass, overall: aggregateD46(rows) };
}
