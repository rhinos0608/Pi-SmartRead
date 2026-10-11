/**
 * Per-model judge method selection (owner ruling D-80, 2026-10-12).
 *
 * - `openai/gpt-6-luna-decisions` → M1 (singleton noul: one request per
 *   candidate, score = the wire probability).
 * - `perplexity/pplx-decider-v1.1-27b` → M2 (forward packed request plus
 *   the exact-reverse packed request, score = (forward + reverse) / 2).
 * - `~typesafe/jev-latest` and any other/unknown model → M0 (packed
 *   request, the long-standing production behavior).
 *
 * Matching is by exact model id; unknown models fail safe to M0. The
 * persistent verdict cache key includes the method for M1/M2
 * (`judgeCacheKey`), so verdicts cached before a model's method changed
 * are never served; M0 keys are unchanged.
 */
export type JudgeMethod = "M0" | "M1" | "M2";

/** Luna's confirmed method is M1. */
export const LUNA_JUDGE_MODEL = "openai/gpt-6-luna-decisions";

/** PPLX decider's confirmed method is M2. */
export const PPLX_JUDGE_MODEL = "perplexity/pplx-decider-v1.1-27b";

export function judgeMethodForModel(model: string): JudgeMethod {
    if (model === LUNA_JUDGE_MODEL) return "M1";
    if (model === PPLX_JUDGE_MODEL) return "M2";
    return "M0";
}
