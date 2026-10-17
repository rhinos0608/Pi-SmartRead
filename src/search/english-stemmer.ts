/**
 * Minimal dependency-free English stemmer (Porter algorithm) for the
 * NL-only BM25 ranking channel (borrow B2/C4, mechanism-level only).
 *
 * Applied identically to query and document tokens AFTER case/split
 * normalisation, only when the `PI_SMARTREAD_GREP_RANK_STEM` knob is on
 * (default OFF). Identifier/exact/regex/structural channels never call
 * this module.
 *
 * Implementation follows the published Porter (1980) five-step
 * description: consonant/vowel sequences define the measure m, and each
 * step strips or rewrites suffixes only when m exceeds a threshold, with
 * small-word guards (*v*, *d, *o). Written from the algorithm
 * description; no third-party source copied.
 */

/** True for a single consonant letter (y counts as consonant iff preceded by a vowel). */
function isConsonant(word: string, i: number): boolean {
    const ch = word[i]!;
    if (ch === "a" || ch === "e" || ch === "i" || ch === "o" || ch === "u") return false;
    if (ch !== "y") return true;
    return i === 0 ? true : !isConsonant(word, i - 1);
}

/** Consonant-vowel sequence measure m of the first n chars. */
function measure(prefix: string): number {
    let m = 0;
    let i = 0;
    const n = prefix.length;
    while (i < n && isConsonant(prefix, i)) i++;
    while (i < n) {
        while (i < n && !isConsonant(prefix, i)) i++;
        if (i >= n) break;
        m++;
        while (i < n && isConsonant(prefix, i)) i++;
    }
    return m;
}

/** True when the first n chars contain a vowel. */
function containsVowel(prefix: string): boolean {
    for (let i = 0; i < prefix.length; i++) {
        if (!isConsonant(prefix, i)) return true;
    }
    return false;
}

/** True when the word ends with a double consonant (e.g. -tt, -ss). */
function endsDoubleConsonant(word: string): boolean {
    if (word.length < 2) return false;
    const a = word[word.length - 1]!;
    const b = word[word.length - 2]!;
    return a === b && isConsonant(word, word.length - 1);
}

/** True for a short *o ending: consonant-vowel-consonant, final not w/x/y. */
function endsCvc(word: string): boolean {
    if (word.length < 3) return false;
    const n = word.length;
    if (!isConsonant(word, n - 1) || isConsonant(word, n - 2) || !isConsonant(word, n - 3)) return false;
    const last = word[n - 1]!;
    return last !== "w" && last !== "x" && last !== "y";
}

function step1a(word: string): string {
    if (word.endsWith("sses")) return `${word.slice(0, -2)}`;
    if (word.endsWith("ies")) return `${word.slice(0, -2)}`;
    if (word.endsWith("ss")) return word;
    if (word.endsWith("s")) return word.slice(0, -1);
    return word;
}

function step1b(word: string): string {
    let stem = word;
    let extended = false;
    if (stem.endsWith("eed")) {
        const base = stem.slice(0, -3);
        if (measure(base) > 0) stem = `${base}ee`;
        return stem;
    }
    for (const suffix of ["ed", "ing"]) {
        if (stem.endsWith(suffix) && containsVowel(stem.slice(0, -suffix.length))) {
            stem = stem.slice(0, -suffix.length);
            extended = true;
            break;
        }
    }
    if (!extended) return stem;
    if (stem.endsWith("at") || stem.endsWith("bl") || stem.endsWith("iz")) return `${stem}e`;
    if (endsDoubleConsonant(stem) && !/[lsz]$/.test(stem)) return stem.slice(0, -1);
    if (measure(stem) === 1 && endsCvc(stem)) return `${stem}e`;
    return stem;
}

function step1c(word: string): string {
    if (word.endsWith("y") && containsVowel(word.slice(0, -1))) return `${word.slice(0, -1)}i`;
    return word;
}

const STEP2_RULES: Array<[string, string]> = [
    ["ational", "ate"],
    ["tional", "tion"],
    ["enci", "ence"],
    ["anci", "ance"],
    ["izer", "ize"],
    ["bli", "ble"],
    ["alli", "al"],
    ["entli", "ent"],
    ["eli", "e"],
    ["ousli", "ous"],
    ["ization", "ize"],
    ["ation", "ate"],
    ["ator", "ate"],
    ["alism", "al"],
    ["iveness", "ive"],
    ["fulness", "ful"],
    ["ousness", "ous"],
    ["aliti", "al"],
    ["iviti", "ive"],
    ["biliti", "ble"],
    ["logi", "log"],
];

function step2(word: string): string {
    for (const [suffix, replacement] of STEP2_RULES) {
        if (word.endsWith(suffix)) {
            const base = word.slice(0, -suffix.length);
            if (measure(base) > 0) return base + replacement;
            return word;
        }
    }
    return word;
}

const STEP3_RULES: Array<[string, string]> = [
    ["icate", "ic"],
    ["ative", ""],
    ["alize", "al"],
    ["iciti", "ic"],
    ["ical", "ic"],
    ["ful", ""],
    ["ness", ""],
];

function step3(word: string): string {
    for (const [suffix, replacement] of STEP3_RULES) {
        if (word.endsWith(suffix)) {
            const base = word.slice(0, -suffix.length);
            if (measure(base) > 0) return base + replacement;
            return word;
        }
    }
    return word;
}

const STEP4_SUFFIXES = [
    "al", "ance", "ence", "er", "ic", "able", "ible", "ant", "ement",
    "ment", "ent", "ion", "ou", "ism", "ate", "iti", "ous", "ive", "ize",
];

function step4(word: string): string {
    for (const suffix of STEP4_SUFFIXES) {
        if (!word.endsWith(suffix)) continue;
        const base = word.slice(0, -suffix.length);
        if (suffix === "ion") {
            if (base.endsWith("s") || base.endsWith("t")) {
                if (measure(base) > 1) return base;
            }
            continue;
        }
        if (measure(base) > 1) return base;
    }
    return word;
}

function step5(word: string): string {
    let stem = word;
    if (stem.endsWith("e")) {
        const base = stem.slice(0, -1);
        const m = measure(base);
        if (m > 1 || (m === 1 && !endsCvc(base))) stem = base;
    }
    if (stem.endsWith("ll") && measure(stem) > 1) stem = stem.slice(0, -1);
    return stem;
}

/**
 * Reduce a single lowercased token to its Porter stem. Inputs of length
 * <= 2 are returned unchanged (small-word guard); longer tokens run the
 * five steps in order.
 */
export function porterStem(token: string): string {
    if (token.length <= 2) return token;
    let word = token.toLowerCase();
    word = step1a(word);
    word = step1b(word);
    word = step1c(word);
    word = step2(word);
    word = step3(word);
    word = step4(word);
    word = step5(word);
    return word.length === 0 ? token.toLowerCase() : word;
}

/** Stem every token; dedupe stems while preserving first-seen order. */
export function stemTokens(tokens: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tok of tokens) {
        const stem = porterStem(tok);
        if (!seen.has(stem)) {
            seen.add(stem);
            out.push(stem);
        }
    }
    return out;
}
