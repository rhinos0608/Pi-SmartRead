/**
 * Natural-language query detection shared by grep's judgment stage and find.
 *
 * Judging only pays off for behavioural descriptions ("where do we retry
 * failed requests"); exact identifiers, paths, globs, and regexes keep the
 * cheap deterministic paths. The heuristic errs toward "not natural language"
 * because a false positive adds judge latency/cost and can drop exact hits.
 */

const GLOB_OR_REGEX_CHARS = /[*?[\]{}|^$\\]/;
const CODE_PUNCTUATION = /[();=<>`"]|=>|::|->/;
const PLAIN_WORD = /^[a-z][a-z'-]*[a-z]?[?.,!]?$/i;
const MIN_WORDS = 3;

export function isNaturalLanguageQuery(pattern: string): boolean {
    // A trailing question mark is sentence punctuation, not a glob wildcard.
    const trimmed = pattern.trim().replace(/\?+$/, "");
    if (trimmed.length === 0) return false;
    if (GLOB_OR_REGEX_CHARS.test(trimmed)) return false;
    if (CODE_PUNCTUATION.test(trimmed)) return false;

    const words = trimmed.split(/\s+/);
    if (words.length < MIN_WORDS) return false;

    // Mostly plain words: code-ish tokens (camelCase, snake_case, dotted or
    // slashed paths) may appear, but must not dominate the query.
    const plain = words.filter((word) => PLAIN_WORD.test(word) && !/[a-z][A-Z]/.test(word)).length;
    return plain >= Math.ceil(words.length * 0.6);
}
