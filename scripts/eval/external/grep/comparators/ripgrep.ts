/**
 * ripgrep lexical-floor comparator (benchmark harness only, D13/D17).
 *
 * NON-EQUIVALENT NL SEARCH (disclosed): ripgrep has no natural-language
 * search, so the formulation text (issue title or full body — the same source
 * text given to every system) is preprocessed by this EXACT rule:
 *
 *   1. Extract ASCII identifier-like tokens (letter/underscore start,
 *      alphanumerics/underscore continue).
 *   2. Lowercase each token; drop tokens shorter than 3 chars.
 *   3. Drop tokens in RIPGREP_STOPWORDS (English function words + code
 *      filler: see the list below).
 *   4. Rank remaining tokens by frequency (desc), ties by first-appearance
 *      index (asc); keep the first MAX_TERMS (20).
 *   5. Run one case-insensitive fixed-string search per term:
 *      `rg --json -i -F -e <term> -- <snapshotRoot>`
 *      (ripgrep's own .gitignore/.git handling applies; matches inside
 *      `.git/` are discarded).
 *   6. Rank files by total match count (desc), ties broken by file path
 *      (asc). The unit line/text is the file's first observed match.
 *
 * Rendered text: at most RENDERED_MATCHES (50) lines of
 * `<relFile>:<line>:<matchText>` in rank order; the token-cap metric is
 * computed over this text exactly like every other comparator.
 */

import { execFileSync } from "node:child_process";
import { relative, sep } from "node:path";
import { formulationText, type BenchmarkInstance, type Formulation } from "../instance.js";
import type { ComparatorManifest, ComparatorOptions, ComparatorOutput, ComparatorUnit } from "./types.js";

export const RIPGREP_VERSION = "system-rg";
export const RIPGREP_MAX_TERMS = 20;
export const RIPGREP_RENDERED_MATCHES = 50;

/** Disclosed stopword list (step 3 of the search rule). */
export const RIPGREP_STOPWORDS = new Set([
    "the", "and", "for", "with", "from", "that", "this", "when", "where",
    "which", "are", "was", "were", "has", "have", "had", "will", "would",
    "should", "could", "been", "being", "into", "over", "under", "between",
    "about", "after", "before", "because", "also", "than", "then", "them",
    "they", "their", "there", "here", "what", "how", "why", "not", "but",
    "all", "any", "can", "use", "using", "used", "get", "set", "new",
    "expected", "actual", "error", "test", "file", "code",
]);

/** Steps 1-4 of the search rule: formulation text -> ordered query terms. */
export function tokenizeForRipgrep(text: string, maxTerms = RIPGREP_MAX_TERMS): string[] {
    const raw = text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    const counts = new Map<string, { count: number; first: number }>();
    for (let i = 0; i < raw.length; i++) {
        const token = (raw[i] ?? "").toLowerCase();
        if (token.length < 3 || RIPGREP_STOPWORDS.has(token)) continue;
        const entry = counts.get(token);
        if (entry) entry.count += 1;
        else counts.set(token, { count: 1, first: i });
    }
    return [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
        .slice(0, maxTerms)
        .map(([token]) => token);
}

interface FileMatch {
    count: number;
    firstLine: number;
    firstText: string;
}

/**
 * Parse `rg --json` output into per-file match tallies. Paths are
 * relativized against root; matches under `.git/` are discarded.
 */
export function parseRipgrepJson(stdout: string, root: string): Map<string, FileMatch> {
    const files = new Map<string, FileMatch>();
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let event: { type?: string; data?: Record<string, unknown> };
        try {
            event = JSON.parse(trimmed) as { type?: string; data?: Record<string, unknown> };
        } catch {
            continue;
        }
        if (event.type !== "match") continue;
        const data = event.data ?? {};
        const pathObj = (typeof data.path === "object" && data.path !== null ? data.path : {}) as {
            text?: unknown;
        };
        const absPath = typeof pathObj.text === "string" ? pathObj.text : null;
        const lineNumber = typeof data.line_number === "number" ? data.line_number : null;
        if (absPath === null || lineNumber === null) continue;
        const rel = absPath.startsWith(root)
            ? absPath.slice(root.length).replace(/^[/\\]/, "").split(sep).join("/")
            : relative(root, absPath).split(sep).join("/");
        if (rel === "" || rel === ".git" || rel.startsWith(".git/") || rel.startsWith("..")) continue;
        const submatches = Array.isArray(data.submatches) ? data.submatches : [];
        const firstText =
            typeof submatches[0] === "object" && submatches[0] !== null && typeof (submatches[0] as { match?: unknown }).match === "object"
                ? String(((submatches[0] as { match: { text?: unknown } }).match.text ?? "")).trim().slice(0, 200)
                : "";
        const entry = files.get(rel);
        if (entry) {
            entry.count += 1;
            if (lineNumber < entry.firstLine) {
                entry.firstLine = lineNumber;
                if (firstText) entry.firstText = firstText;
            }
        } else {
            files.set(rel, { count: 1, firstLine: lineNumber, firstText });
        }
    }
    return files;
}

/** Step 6 of the search rule: rank files by count desc, path asc. */
export function rankRipgrepFiles(files: Map<string, FileMatch>): ComparatorUnit[] {
    return [...files.entries()]
        .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([relFile, m]) => ({
            relFile,
            line: m.firstLine,
            endLine: m.firstLine,
            name: "",
            text: m.firstText,
        }));
}

/** Render at most RIPGREP_RENDERED_MATCHES rank-ordered match lines. */
export function renderRipgrepText(units: ComparatorUnit[], maxLines = RIPGREP_RENDERED_MATCHES): string {
    return units
        .slice(0, maxLines)
        .map((u) => `${u.relFile}:${u.line}:${u.text ?? ""}`)
        .join("\n");
}

function errorStatus(error: unknown): string {
    if (error instanceof Error) {
        const killed = (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
        const name = /ETIMEDOUT|timed out/i.test(error.message) || killed ? "timeout" : "error";
        const code = error.message.split(":")[0]?.trim().slice(0, 80) || "unknown";
        return `${name}:${code}`;
    }
    return "error:unknown";
}

/** Run the ripgrep floor for one instance+formulation (rg must be on PATH). */
export async function runRipgrep(
    instance: BenchmarkInstance,
    snapshotRoot: string,
    formulation: Formulation,
    options: ComparatorOptions,
): Promise<ComparatorOutput> {
    void instance;
    const terms = tokenizeForRipgrep(formulationText(instance, formulation));
    if (terms.length === 0) {
        return { units: [], renderedText: "", elapsedMs: 0, setupMs: 0, status: "empty-query" };
    }
    const started = performance.now();
    let status = "ok";
    const files = new Map<string, FileMatch>();
    for (const term of terms) {
        let out: Buffer;
        try {
            out = execFileSync("rg", ["--json", "-i", "-F", "-e", term, "--", snapshotRoot], {
                timeout: options.timeoutMs,
                maxBuffer: 256 * 1024 * 1024,
            });
        } catch (error) {
            // rg exits 1 on no matches: skip to the next term, not a failure.
            const code = (error as { status?: unknown })?.status;
            if (code === 1) continue;
            status = errorStatus(error);
            break;
        }
        for (const [rel, m] of parseRipgrepJson(out.toString("utf8"), snapshotRoot)) {
            const entry = files.get(rel);
            if (entry) {
                entry.count += m.count;
                if (m.firstLine < entry.firstLine) {
                    entry.firstLine = m.firstLine;
                    if (m.firstText) entry.firstText = m.firstText;
                }
            } else {
                files.set(rel, { ...m });
            }
        }
    }
    const elapsedMs = performance.now() - started;
    const units = rankRipgrepFiles(files);
    return { units, renderedText: renderRipgrepText(units), elapsedMs, setupMs: 0, status };
}

export function ripgrepManifest(rgVersionLine: string): ComparatorManifest {
    return {
        system: "ripgrep",
        tool: "rg",
        version: rgVersionLine,
        checksumOrCommit: "system-binary",
        binaryPath: "PATH:rg",
        searchRule:
            "tokenize formulation into identifier-like terms " +
            "(/[A-Za-z_][A-Za-z0-9_]*/, lowercase, len>=3, stopword drop, freq-desc " +
            `top-${RIPGREP_MAX_TERMS}); one 'rg --json -i -F -e <term>' per term; ` +
            "rank files by match count desc, path asc; non-equivalent NL search",
        formulationSource: "issue title (primary) / full body (stress), same source text",
        tokenCap: 8000,
    };
}
