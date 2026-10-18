/**
 * TEB (Tool Ergonomics Bench) grader: pure functions over the final answer.
 *
 * Binding inputs: implementer extract §3 (grader) as amended by E10 in
 * `docs/plans/2026-10-07-tool-ergonomics-decision-log.md`, and the §4–§5
 * final-answer contract in `docs/plans/2026-10-07-teb-protocol.md`.
 *
 * Pipeline: extract the LAST fenced json block from the transcript,
 * normalise agent-echoed path prefixes (§4), strict shape validation via
 * `validateFinalAnswer` (malformed → zero), then per-answerType matching.
 * No IO, no network.
 */

import { normalizeTypeString } from "./gold/normalize.js";
import { validateFinalAnswer } from "./schema.js";
import type { TebAnswerType, TebCaller, TebGoldAnswer, TebLocation, TebRoute, TebTask } from "./schema.js";

// Single pinned §5 type-string normaliser: grade.ts uses the gold
// implementation directly (re-exported here so graders keep one import).
export { normalizeTypeString };

export type TebGradeReason = "pass" | "fail" | "malformed";

export interface TebGradeResult {
    pass: boolean;
    reason: TebGradeReason;
    /** Recall/precision/F1 over set-valued answerTypes; null otherwise. */
    recall: number | null;
    precision: number | null;
    f1: number | null;
    /**
     * Continuous secondary score regardless of pass/fail: set-F1 for set
     * types, 1.0/0.5/0.0 for single-location (match / right-file-wrong-line
     * / otherwise), normalized Levenshtein similarity for scalar/type-string,
     * exact 1/0 for file answers.
     */
    secondary: number;
    detail: string;
}

export interface TebSetCounts {
    hits: number;
    predictedSize: number;
    goldSize: number;
}

export interface TebSetThresholds {
    minRecall: number;
    minPrecision: number;
}


/**
 * Extract the LAST fenced ```json block from a transcript. The JSON payload
 * may itself contain fenced code blocks (type-string answers legitimately
 * embed ```typescript fences), so the first ``` after the opener is not
 * necessarily the closer: every later ``` is tried as the closer, longest
 * first, keeping the first candidate that parses as JSON. When nothing
 * parses, the longest candidate is returned so callers report `malformed`.
 */
export function extractLastJsonBlock(transcript: string): { found: boolean; raw: string } {
    const openers = [...transcript.matchAll(/```json[ \t]*\n?/gi)];
    if (openers.length === 0) return { found: false, raw: "" };
    const opener = openers[openers.length - 1]!;
    const bodyStart = (opener.index ?? 0) + opener[0].length;
    const closers: number[] = [];
    let from = bodyStart;
    for (;;) {
        const next = transcript.indexOf("```", from);
        if (next === -1) break;
        closers.push(next);
        from = next + 3;
    }
    if (closers.length === 0) return { found: true, raw: transcript.slice(bodyStart).trim() };
    for (let i = closers.length - 1; i >= 0; i--) {
        const raw = transcript.slice(bodyStart, closers[i]).trim();
        try {
            JSON.parse(raw);
            return { found: true, raw };
        } catch {
            continue;
        }
    }
    return { found: true, raw: transcript.slice(bodyStart, closers[closers.length - 1]).trim() };
}

/**
 * Normalise a path to subpath-relative form (§4) by stripping anchored
 * prefixes only, in order (P1-5): for absolute paths the absolute checkout
 * root up to the repo dir, then the repo dir, then at most one leading
 * `<subpath>/`; for relative paths a leading `<repo>/` then at most one
 * leading `<subpath>/`. Never strips on an unanchored substring: a
 * subpath or repo-dir name appearing mid-path is data, not a prefix.
 * Backslashes → slashes, redundant separators and `.` segments collapsed,
 * case-sensitive throughout. `.js`→`.ts` forgiveness applies only when
 * `extensionForgiveness` is set (prettier discovery tasks).
 */
export function normalizeTebPath(
    raw: string,
    task: Pick<TebTask, "repo" | "subpath">,
    extensionForgiveness: boolean,
): string {
    let p = raw.replace(/\\/g, "/").trim();
    const absolute = p.startsWith("/");
    while (p.startsWith("./")) p = p.slice(2);
    while (p.startsWith("/")) p = p.slice(1);
    p = p.replace(/\/{2,}/g, "/");
    const clean = (s: string): string =>
        s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
    const subpath = clean(task.subpath);
    const repo = clean(task.repo);
    const subPrefix = subpath.length > 0 && subpath !== "." ? `${subpath}/` : "";
    const repoPrefix = repo.length > 0 ? `${repo}/` : "";
    const subSegs = subPrefix.length > 0 ? subPrefix.slice(0, -1).split("/") : [];
    const repoSegs = repo.length > 0 ? repo.split("/") : [];
    if (absolute) {
        // Anchored at the filesystem root: match whole path segments in
        // checkout layout order (repo+subpath, repo, subpath). A bare
        // substring search would strip mid-segment decoys (P1-5):
        // `/tmp/query-core/src/x.ts` must NOT match subpath `core`.
        const candidates: string[][] = [];
        if (repoSegs.length > 0 && subSegs.length > 0) candidates.push([...repoSegs, ...subSegs]);
        if (repoSegs.length > 0) candidates.push(repoSegs);
        if (subSegs.length > 0) candidates.push(subSegs);
        const segs = p.split("/");
        for (const marker of candidates) {
            const idx = findSegmentRun(segs, marker);
            if (idx !== -1) {
                p = segs.slice(idx + marker.length).join("/");
                break;
            }
        }
    } else {
        if (repoPrefix.length > 0 && p.startsWith(repoPrefix)) p = p.slice(repoPrefix.length);
        if (subPrefix.length > 0 && p.startsWith(subPrefix)) p = p.slice(subPrefix.length);
    }
    const parts: string[] = [];
    for (const segment of p.split("/")) {
        if (segment === "" || segment === ".") continue;
        parts.push(segment);
    }
    p = parts.join("/");
    if (extensionForgiveness && p.endsWith(".js")) p = `${p.slice(0, -3)}.ts`;
    return p;
}

/** Whole-segment subsequence search: marker must align on segment boundaries. */
function findSegmentRun(haystack: string[], needle: string[]): number {
    if (needle.length === 0 || needle.length > haystack.length) return -1;
    for (let i = 0; i + needle.length <= haystack.length; i++) {
        if (needle.every((segment, j) => haystack[i + j] === segment)) return i;
    }
    return -1;
}

/** Gold paths are normalised exactly like predicted paths (P1-5). */
function goldPath(
    path: string,
    task: Pick<TebTask, "repo" | "subpath">,
    extensionForgiveness: boolean,
): string {
    return normalizeTebPath(path, task, extensionForgiveness);
}

/**
 * Rewrite agent-echoed path prefixes inside a parsed answer BEFORE strict
 * shape validation: §4 normalisation (stripping `./`, `/`, `<repo>/`,
 * `<subpath>/`, backslashes) is grader behaviour, while the schema
 * validator fail-closes on non-subpath-relative spellings. Non-string
 * path values are left untouched so validation still rejects them.
 */
type PathTask = Pick<TebTask, "repo" | "subpath">;

function normSlot(value: unknown, task: PathTask, forgiveness: boolean): unknown {
    if (typeof value !== "string") return value;
    return normalizeTebPath(value, task, forgiveness);
}

function normRecordKey(entry: unknown, key: string, task: PathTask, forgiveness: boolean): void {
    if (typeof entry !== "object" || entry === null) return;
    const record = entry as Record<string, unknown>;
    if (key in record) record[key] = normSlot(record[key], task, forgiveness);
}

function normArrayKey(items: unknown, key: string, task: PathTask, forgiveness: boolean): void {
    if (!Array.isArray(items)) return;
    for (const item of items) normRecordKey(item, key, task, forgiveness);
}

function withNormalizedPaths(
    answerType: TebAnswerType,
    answer: unknown,
    task: TebTask,
    forgiveness: boolean,
): unknown {
    const clone = JSON.parse(JSON.stringify(answer)) as unknown;
    // A fenced `null` (or other non-object) parses fine but has no
    // `answer` slot: return it untouched so validation below grades it
    // malformed-zero instead of throwing on the dereference.
    if (typeof clone !== "object" || clone === null) return clone;
    const root = clone as Record<string, unknown>;
    const inner = root["answer"];
    switch (answerType) {
        case "single-location":
        case "file":
            normRecordKey(inner, "path", task, forgiveness);
            break;
        case "location-set":
        case "caller-set":
            normArrayKey(inner, "path", task, forgiveness);
            break;
        case "file-set":
            if (typeof inner === "object" && inner !== null) {
                const record = inner as Record<string, unknown>;
                if (Array.isArray(record["files"])) {
                    record["files"] = (record["files"] as unknown[]).map((f) => normSlot(f, task, forgiveness));
                }
            }
            break;
        case "route-set":
            normArrayKey(inner, "file", task, forgiveness);
            break;
        default:
            break;
    }
    return clone;
}

/**
 * Comparison cores over already-normalised paths. The grading pipeline
 * normalises each path exactly once (withNormalizedPaths); these `*Norm`
 * helpers compare directly so a repeated subpath prefix is never stripped
 * twice (`packages/core/packages/core/utils.ts` must not match gold
 * `utils.ts`). The exported wrappers below normalise once for external
 * callers.
 */
function locationMatchesNorm(predicted: TebLocation, gold: TebLocation): boolean {
    return (
        predicted.path === gold.path &&
        predicted.line === gold.line &&
        Math.abs(predicted.character - gold.character) <= 2
    );
}
export function locationMatches(
    predicted: TebLocation,
    gold: TebLocation,
    task: Pick<TebTask, "repo" | "subpath">,
    extensionForgiveness: boolean,
): boolean {
    return locationMatchesNorm(
        { ...predicted, path: normalizeTebPath(predicted.path, task, extensionForgiveness) },
        { ...gold, path: goldPath(gold.path, task, extensionForgiveness) },
    );
}

/** Caller entries match on path+line (normalised inputs) plus trimmed exact name. */
function callerMatchesNorm(predicted: TebCaller, gold: TebCaller): boolean {
    return (
        predicted.name.trim() === gold.name.trim() &&
        predicted.path === gold.path &&
        predicted.line === gold.line
    );
}
export function callerMatches(
    predicted: TebCaller,
    gold: TebCaller,
    task: Pick<TebTask, "repo" | "subpath">,
): boolean {
    return callerMatchesNorm(
        { ...predicted, path: normalizeTebPath(predicted.path, task, false) },
        { ...gold, path: goldPath(gold.path, task, false) },
    );
}

/** Route entries match on upper-cased method + path + file + line (normalised inputs). */
function routeMatchesNorm(predicted: TebRoute, gold: TebRoute): boolean {
    return (
        predicted.method.toUpperCase() === gold.method.toUpperCase() &&
        predicted.path === gold.path &&
        predicted.file === gold.file &&
        predicted.line === gold.line
    );
}
export function routeMatches(
    predicted: TebRoute,
    gold: TebRoute,
    task: Pick<TebTask, "repo" | "subpath">,
): boolean {
    return routeMatchesNorm(
        { ...predicted, file: normalizeTebPath(predicted.file, task, false) },
        { ...gold, file: goldPath(gold.file, task, false) },
    );
}

/** Set-F1; 0 when both sets are empty is defined as 0 (empty P → 0/0). */
export function setF1(precision: number, recall: number): number {
    if (precision + recall <= 0) return 0;
    return (2 * precision * recall) / (precision + recall);
}

/** Normalized Levenshtein similarity in [0,1]; 1 for two empty strings. */
export function levenshteinSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) {
            next[j] = Math.min(
                prev[j]! + 1,
                next[j - 1]! + 1,
                prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        prev = next as number[];
    }
    return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

function malformed(detail: string): TebGradeResult {
    return {
        pass: false,
        reason: "malformed",
        recall: null,
        precision: null,
        f1: null,
        secondary: 0,
        detail,
    };
}

function setResult(counts: TebSetCounts, thresholds: TebSetThresholds, detail: string): TebGradeResult {
    const recall = counts.goldSize === 0 ? 0 : counts.hits / counts.goldSize;
    const precision = counts.predictedSize === 0 ? 0 : counts.hits / counts.predictedSize;
    const f1 = setF1(precision, recall);
    const pass = recall >= thresholds.minRecall && precision >= thresholds.minPrecision;
    return { pass, reason: pass ? "pass" : "fail", recall, precision, f1, secondary: f1, detail };
}

/**
 * Set thresholds are explicit per task (protocol §3/R4): the §5 defaults
 * guide labelers authoring gold, but grading never invents thresholds.
 * Returns null when gold carries none, which the caller grades malformed.
 */
function thresholdsOf(gold: TebGoldAnswer): TebSetThresholds | null {
    if (!("minRecall" in gold) || !("minPrecision" in gold)) return null;
    const { minRecall, minPrecision } = gold;
    if (typeof minRecall !== "number" || typeof minPrecision !== "number") return null;
    return { minRecall, minPrecision };
}

/** Count location-set hits with one-to-one matching (each prediction used once). */
function countLocationHits(
    predicted: TebLocation[],
    gold: TebLocation[],
    task: TebTask,
    forgiveness: boolean,
): TebSetCounts {
    const remaining = [...predicted];
    let hits = 0;
    for (const g of gold) {
        const normGold = { ...g, path: goldPath(g.path, task, forgiveness) };
        const idx = remaining.findIndex((p) => locationMatchesNorm(p, normGold));
        if (idx !== -1) {
            hits++;
            remaining.splice(idx, 1);
        }
    }
    return { hits, predictedSize: predicted.length, goldSize: gold.length };
}

/** Count caller-set hits with one-to-one matching. */
function countCallerHits(predicted: TebCaller[], gold: TebCaller[], task: TebTask): TebSetCounts {
    const remaining = [...predicted];
    let hits = 0;
    for (const g of gold) {
        const normGold = { ...g, path: goldPath(g.path, task, false) };
        const idx = remaining.findIndex((p) => callerMatchesNorm(p, normGold));
        if (idx !== -1) {
            hits++;
            remaining.splice(idx, 1);
        }
    }
    return { hits, predictedSize: predicted.length, goldSize: gold.length };
}

/** Count route-set hits with one-to-one matching. */
function countRouteHits(predicted: TebRoute[], gold: TebRoute[], task: TebTask): TebSetCounts {
    const remaining = [...predicted];
    let hits = 0;
    for (const g of gold) {
        const normGold = { ...g, file: goldPath(g.file, task, false) };
        const idx = remaining.findIndex((p) => routeMatchesNorm(p, normGold));
        if (idx !== -1) {
            hits++;
            remaining.splice(idx, 1);
        }
    }
    return { hits, predictedSize: predicted.length, goldSize: gold.length };
}

/** Count file-set hits with one-to-one matching on normalized paths. */
function countFileHits(predicted: string[], gold: string[], task: TebTask, forgiveness: boolean): TebSetCounts {
    // Predicted paths arrive normalised (withNormalizedPaths); gold is
    // normalised once here — never twice, so a repeated prefix cannot
    // collapse (`packages/core/packages/core/utils.ts` ≠ `utils.ts`).
    const remaining = [...predicted];
    const normalizedGold = gold.map((f) => goldPath(f, task, forgiveness));
    let hits = 0;
    for (const g of normalizedGold) {
        const idx = remaining.indexOf(g);
        if (idx !== -1) {
            hits++;
            remaining.splice(idx, 1);
        }
    }
    return { hits, predictedSize: predicted.length, goldSize: gold.length };
}

function gradeSingleLocation(task: TebTask, answer: unknown, forgiveness: boolean): TebGradeResult {
    if (task.gold.kind !== "single-location") return malformed("gold kind mismatch");
    const predicted = answer as TebLocation;
    const normGold = { ...task.gold.location, path: goldPath(task.gold.location.path, task, forgiveness) };
    if (locationMatchesNorm(predicted, normGold)) {
        return {
            pass: true,
            reason: "pass",
            recall: null,
            precision: null,
            f1: null,
            secondary: 1,
            detail: "point match",
        };
    }
    const sameFile = predicted.path === normGold.path;
    return {
        pass: false,
        reason: "fail",
        recall: null,
        precision: null,
        f1: null,
        secondary: sameFile ? 0.5 : 0,
        detail: sameFile ? "right file, wrong line" : "no match",
    };
}

function gradeFile(task: TebTask, answer: unknown, forgiveness: boolean): TebGradeResult {
    if (task.gold.kind !== "file") return malformed("gold kind mismatch");
    const predicted = (answer as { path: string }).path;
    const match = predicted === goldPath(task.gold.path, task, forgiveness);
    return {
        pass: match,
        reason: match ? "pass" : "fail",
        recall: null,
        precision: null,
        f1: null,
        secondary: match ? 1 : 0,
        detail: match ? "file match" : "file mismatch",
    };
}

function gradeScalar(task: TebTask, answer: unknown): TebGradeResult {
    if (task.gold.kind !== "scalar") return malformed("gold kind mismatch");
    const predicted = (answer as { value: string }).value;
    const caseSensitive = task.caseSensitive ?? false;
    const left = predicted.trim();
    const right = task.gold.value.trim();
    const match = caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase();
    return {
        pass: match,
        reason: match ? "pass" : "fail",
        recall: null,
        precision: null,
        f1: null,
        secondary: match ? 1 : levenshteinSimilarity(left.toLowerCase(), right.toLowerCase()),
        detail: match ? "scalar match" : "scalar mismatch",
    };
}

function gradeTypeString(task: TebTask, answer: unknown): TebGradeResult {
    if (task.gold.kind !== "type-string") return malformed("gold kind mismatch");
    const predicted = (answer as { type: string }).type;
    const normalized = normalizeTypeString(predicted, task.gold.normalization);
    const match = normalized === task.gold.normalized;
    return {
        pass: match,
        reason: match ? "pass" : "fail",
        recall: null,
        precision: null,
        f1: null,
        secondary: match ? 1 : levenshteinSimilarity(normalized, task.gold.normalized),
        detail: match ? "type match" : `type mismatch: ${JSON.stringify(normalized)}`,
    };
}

function gradeSetAnswer(task: TebTask, answer: unknown, forgiveness: boolean): TebGradeResult {
    // Thresholds are explicit per task (protocol §3/R4): no grade-time
    // defaults. Gold without thresholds is malformed, never defaulted.
    const thresholds = thresholdsOf(task.gold);
    if (thresholds === null) return malformed("gold missing explicit thresholds");
    if (task.answerType === "location-set" && task.gold.kind === "location-set") {
        const counts = countLocationHits(answer as TebLocation[], task.gold.locations, task, forgiveness);
        return setResult(counts, thresholds, `${counts.hits}/${task.gold.locations.length} locations`);
    }
    if (task.answerType === "caller-set" && task.gold.kind === "caller-set") {
        const counts = countCallerHits(answer as TebCaller[], task.gold.callers, task);
        return setResult(counts, thresholds, `${counts.hits}/${task.gold.callers.length} callers`);
    }
    if (task.answerType === "file-set" && task.gold.kind === "file-set") {
        const files = (answer as { files: string[] }).files;
        const counts = countFileHits(files, task.gold.files, task, forgiveness);
        return setResult(counts, thresholds, `${counts.hits}/${task.gold.files.length} files`);
    }
    if (task.answerType === "route-set" && task.gold.kind === "route-set") {
        const counts = countRouteHits(answer as TebRoute[], task.gold.routes, task);
        return setResult(counts, thresholds, `${counts.hits}/${task.gold.routes.length} routes`);
    }
    return malformed("gold kind mismatch");
}

/**
 * Grade one task from the agent transcript. Extracts the LAST fenced json
 * block; missing/unparseable/wrong-shape answers score 0 with reason
 * `malformed` (distinct from wrong-answer 0).
 */
export function gradeTebTask(task: TebTask, transcript: string): TebGradeResult {
    const block = extractLastJsonBlock(transcript);
    if (!block.found) return malformed("no fenced json block in transcript");
    let parsed: unknown;
    try {
        parsed = JSON.parse(block.raw) as unknown;
    } catch {
        return malformed("fenced json block is not valid JSON");
    }
    const forgiveness = task.extensionForgiveness ?? false;
    const normalized = withNormalizedPaths(task.answerType, parsed, task, forgiveness);
    const shapeErrors = validateFinalAnswer(task.answerType, normalized);
    if (shapeErrors.length > 0) return malformed(shapeErrors.join("; "));
    const answer = (normalized as Record<string, unknown>)["answer"];
    if (task.answerType === "single-location") return gradeSingleLocation(task, answer, forgiveness);
    if (task.answerType === "file") return gradeFile(task, answer, forgiveness);
    if (task.answerType === "scalar") return gradeScalar(task, answer);
    if (task.answerType === "type-string") return gradeTypeString(task, answer);
    return gradeSetAnswer(task, answer, forgiveness);
}
