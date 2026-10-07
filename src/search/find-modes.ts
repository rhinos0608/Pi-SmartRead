/**
 * Find mode selection (Phase A).
 *
 * Glob when the pattern contains a glob metacharacter, natural language
 * when the shared query-intent heuristic fires, fuzzy name otherwise.
 */
import { isNaturalLanguageQuery } from "./query-intent.js";

export type FindMode = "glob" | "fuzzy" | "natural-language";

const GLOB_CHARS = /[*?[{]/;

export const FIND_DEFAULT_LIMIT = 100;
export const FIND_DEFAULT_NL_LIMIT = 20;
export const FIND_MAX_LIMIT = 500;

/** 5s traversal budget: return partial results with a steering notice. */
export const FIND_TRAVERSAL_BUDGET_MS = 5_000;

export function detectFindMode(pattern: string): FindMode {
    if (GLOB_CHARS.test(pattern)) return "glob";
    if (isNaturalLanguageQuery(pattern)) return "natural-language";
    return "fuzzy";
}

export function resolveFindLimit(limit: number | undefined, mode: FindMode): number {
    const fallback = mode === "natural-language" ? FIND_DEFAULT_NL_LIMIT : FIND_DEFAULT_LIMIT;
    if (limit === undefined) return fallback;
    if (!Number.isFinite(limit)) return fallback;
    return Math.max(1, Math.min(FIND_MAX_LIMIT, Math.trunc(limit)));
}

export function findModeLabel(mode: FindMode): string {
    if (mode === "glob") return "glob";
    if (mode === "fuzzy") return "fuzzy name";
    return "natural language";
}
