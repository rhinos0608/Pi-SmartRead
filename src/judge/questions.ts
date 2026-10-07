/**
 * Question/criteria templates from the approved designs.
 *
 * - Unit relevance + exists wording: 2026-10-05-grep-judge-design.md.
 * - Signature-card pointer wave uses the same per-unit question over
 *   signature-only cards (same file).
 * - File-judging wording: 2026-10-05-enhanced-find-design.md.
 */
import type { NoulQuestion } from "./types.js";

/** Per-unit relevance noul over `units.<key>` (grep stage + pointer wave). */
export function unitRelevanceQuestion(query: string, stateRef: string): NoulQuestion {
    return {
        type: "noul",
        instructions:
            `Does \`${stateRef}\` substantively implement, define, or explain part of "${query}"? Apply \`criteria\`.`,
        criteria: {
            true: "This unit contains an implementation, definition, or substantive explanation of an important part of the search. A helper implementing one requested step counts even when other steps are elsewhere.",
            false: "This unit only mentions, calls, imports, tests, or configures the subject, or contains unrelated code sharing keywords.",
        },
    };
}

/** Per-query existence noul (TypeSafe semantic_find cookbook thresholds 0.70/0.35). */
export function existsQuestion(query: string): NoulQuestion {
    return {
        type: "noul",
        instructions: `Do any of the units answer "${query}"?`,
    };
}

/**
 * Excerpt-based per-query existence noul (D42, behind
 * PI_SMARTREAD_JUDGE_EXISTS_EVIDENCE=excerpts).
 *
 * Scoped explicitly to the shown candidates only — no claim about the
 * whole repository. Callers pass the excerpt block as part of the noul
 * state so the judge cache key stays content-sensitive.
 */
export function existsExcerptQuestion(query: string): NoulQuestion {
    return {
        type: "noul",
        instructions:
            `Among these candidates, does any unit answer "${query}"? Judge only the excerpts shown; make no claim about the rest of the repository.`,
    };
}

/** Signature-card pointer noul (same question over signature-only cards). */
export function signaturePointerQuestion(query: string, stateRef: string): NoulQuestion {
    return unitRelevanceQuestion(query, stateRef);
}

/** Find file-judging noul: one per file tagged `<key>` in the directory tree. */
export function findFileQuestion(query: string, fileKey: string, filePath: string): NoulQuestion {
    return {
        type: "noul",
        instructions:
            `Is the file tagged ${fileKey} ("${filePath}") likely to contain what this search is looking for: "${query}"? Judge by its path, symbols, and place in \`tree\`; apply \`criteria.file\`.`,
        criteria: {
            true: "A file at this path plausibly contains code, text, or data matching the search.",
            false: "The file is unrelated by name, symbols, and location.",
        },
    };
}
