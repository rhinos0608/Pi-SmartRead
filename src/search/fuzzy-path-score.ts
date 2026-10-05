/**
 * fzf-path-scheme-style fuzzy scorer for find's fuzzy-name mode.
 *
 * Subsequence match with boundary bonuses (after `/` and word
 * separators `_`, `-`, `.`, space), camelCase-boundary bonus,
 * consecutive-match bonus, and per-skipped-char gap penalties.
 * Case-insensitive. Returns -1 when the query is not a subsequence
 * of the target; higher is better.
 *
 * VS Code label preference lives in scoreFuzzyPath: when the query
 * carries no path separator the basename is scored first and the
 * full path is only a fallback.
 */
import { basename } from "node:path";

const WORD_SEPARATORS = new Set(["_", "-", ".", " "]);

function isUpper(code: number): boolean {
    return code >= 65 && code <= 90;
}

function isLower(code: number): boolean {
    return code >= 97 && code <= 122;
}

function boundaryBonus(target: string, index: number): number {
    if (index === 0) return 20;
    const prev = target[index - 1]!;
    if (prev === "/") return 18;
    if (WORD_SEPARATORS.has(prev)) return 12;
    const prevCode = target.charCodeAt(index - 1);
    const curCode = target.charCodeAt(index);
    if (isLower(prevCode) && isUpper(curCode)) return 10;
    return 0;
}

function charsEqual(a: string, b: string): boolean {
    return a.toLowerCase() === b.toLowerCase();
}

/**
 * Optimal-subsequence DP over query/target. dpPrev[j] holds the best
 * score for the query prefix ending exactly at target position j.
 */
function scoreAgainst(query: string, target: string): number {
    if (query.length === 0 || target.length === 0) return -1;
    const m = target.length;
    let dpPrev = new Array<number>(m).fill(Number.NEGATIVE_INFINITY);
    for (let i = 0; i < m; i++) {
        if (charsEqual(query[0]!, target[i]!)) {
            // Leading gap penalty: one point per skipped leading char.
            dpPrev[i] = 10 + boundaryBonus(target, i) - i;
        }
    }
    for (let q = 1; q < query.length; q++) {
        const dpCurr = new Array<number>(m).fill(Number.NEGATIVE_INFINITY);
        for (let i = q; i < m; i++) {
            if (!charsEqual(query[q]!, target[i]!)) continue;
            let best = Number.NEGATIVE_INFINITY;
            for (let j = q - 1; j < i; j++) {
                const prev = dpPrev[j]!;
                if (prev === Number.NEGATIVE_INFINITY) continue;
                const gap = i - j - 1;
                let candidate = prev - gap * 2;
                if (gap === 0) candidate += 12;
                if (candidate > best) best = candidate;
            }
            if (best !== Number.NEGATIVE_INFINITY) {
                dpCurr[i] = 10 + boundaryBonus(target, i) + best;
            }
        }
        dpPrev = dpCurr;
    }
    let best = Number.NEGATIVE_INFINITY;
    for (const value of dpPrev) {
        if (value > best) best = value;
    }
    if (best === Number.NEGATIVE_INFINITY) return -1;
    // Mild length penalty: an exact-length target outranks a longer one
    // with an otherwise identical match (shorter tail wins ties).
    return Math.max(0, best - (target.length - query.length) * 0.25);
}

/**
 * Score a query against a workspace-relative path. Queries without a
 * `/` prefer the basename (VS Code label preference); the full path
 * is the fallback. Queries with a separator score the full path.
 */
export function scoreFuzzyPath(query: string, relPath: string): number {
    if (query.length === 0) return -1;
    if (!query.includes("/")) {
        const baseScore = scoreAgainst(query, basename(relPath));
        if (baseScore >= 0) return baseScore;
        return scoreAgainst(query, relPath);
    }
    return scoreAgainst(query, relPath);
}
