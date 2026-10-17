/**
 * TEB (Tool Ergonomics Bench) secondary metrics: pure functions over one
 * extracted run plus its task.
 *
 * Binding inputs: §10 of `docs/plans/2026-10-07-teb-protocol.md` as
 * amended by E10.4 in
 * `docs/plans/2026-10-07-tool-ergonomics-decision-log.md`:
 * specialist-call matching follows the §2 "counts as specialist use"
 * column (real tool contracts, not fictional inspect queries);
 * "first correct evidence" is the first successful non-`unavailable`
 * tool result whose rendered text (or, for strict LSP, the stringified
 * envelope result) contains a gold location/file, excluding strings
 * already present in that call's own arguments; `unavailable` envelopes
 * are counted separately from errors; post-error success asserts only
 * temporal succession, not recovery of the failed intent.
 *
 * No metric primitives are copied here: family membership comes from
 * `FAMILY_TABLE` in `schema.js`.
 */

import { FAMILY_TABLE } from "./schema.js";
import type { TebFamily, TebTask } from "./schema.js";
import { isFailedCall } from "./extract.js";
import type { TebExtractedRun, TebToolCall } from "./extract.js";

/** LSP operations that count as specialist use for each LSP family. */
const LSP_SPECIALIST_OPS: Record<string, readonly string[]> = {
    definition: ["goToDefinition"],
    "all-references": ["findReferences"],
    implementations: ["goToImplementation"],
    callers: ["prepareCallHierarchy", "incomingCalls"],
    "type-of-symbol": ["hover"],
};

function lspOperation(args: Record<string, unknown>): string | null {
    return typeof args["operation"] === "string" ? args["operation"] : null;
}

function inspectMode(args: Record<string, unknown>): string | null {
    return typeof args["mode"] === "string" ? args["mode"] : null;
}

function inspectRoutes(args: Record<string, unknown>): boolean {
    const analysis = args["analysis"];
    return (
        typeof analysis === "object" &&
        analysis !== null &&
        (analysis as Record<string, unknown>)["routes"] === true
    );
}

/**
 * Whether one tool call counts as specialist use for the given family
 * (the §2 "counts as specialist use" column):
 * - LSP families: `LSP` with the family-mapped `args.operation`.
 * - `direct-importers`: structural `grep` (`args.structural` present) or
 *   `LSP findReferences` — no exhaustive inspect importer view exists,
 *   so inspect never counts here (E13.5).
 * - `package-exports`: `inspect` directory-mode call.
 * - `http-routes`: `inspect` with `args.analysis.routes == true`, or
 *   pattern `grep`.
 * - Negative-control families: never (no specialist use exists).
 */
export function isSpecialistCallForFamily(
    family: TebFamily,
    toolName: string,
    args: Record<string, unknown>,
): boolean {
    const mapped = LSP_SPECIALIST_OPS[family];
    if (mapped) {
        const op = lspOperation(args);
        return toolName === "LSP" && op !== null && mapped.includes(op);
    }
    switch (family) {
        case "direct-importers":
            return (
                (toolName === "grep" && "structural" in args) ||
                (toolName === "LSP" && lspOperation(args) === "findReferences")
            );
        case "package-exports":
            return toolName === "inspect" && inspectMode(args) === "directory";
        case "http-routes":
            return (
                (toolName === "inspect" && inspectRoutes(args)) || toolName === "grep"
            );
        default:
            // Negative-control families (and any unknown family): no
            // specialist use exists.
            return false;
    }
}

/**
 * Whether a call counts as specialist use for ANY family. Plain `grep`
 * is excluded here even though it counts for `http-routes` via
 * `isSpecialistCallForFamily`: literal grep is the first-line route on
 * negative-control tasks, so counting every grep as specialist would
 * manufacture over-routing in precision and negative-overuse numbers.
 * The family-specific matcher stays authoritative for opportunity recall.
 */
export function isSpecialistCall(toolName: string, args: Record<string, unknown>): boolean {
    if (toolName === "grep" && !("structural" in args)) return false;
    return (Object.keys(FAMILY_TABLE) as TebFamily[]).some((family) =>
        isSpecialistCallForFamily(family, toolName, args),
    );
}

/** Marker prefixing the read/grep enrichment footer (see `src/hook.ts`). */
export const ENRICHMENT_FOOTER_MARKER = "\n---\n\ud83d\udd0d Context for";

/**
 * Strips the read/grep enrichment footer before evidence matching. The
 * footer lists nearby files, recent commits, and LSP symbols from
 * elsewhere in the repo, so matching against it credits evidence the
 * result never showed (E11).
 */
export function stripEnrichmentFooter(text: string): string {
    const at = text.indexOf(ENRICHMENT_FOOTER_MARKER);
    return at === -1 ? text : text.slice(0, at);
}

/**
 * Gold evidence needles: strings whose presence in a tool result counts
 * as showing gold (E10.4, E13.4). Line-bearing paths match only as
 * `path:line` with a numeric trailing boundary; caller names and route
 * paths never stand alone — `caller-set`/`route-set` evidence requires
 * the path+line location context, not the bare name. Scalar/type-string
 * gold matches case-insensitively unless the task is case-sensitive
 * (matching the grader).
 */
export interface TebGoldNeedle {
    text: string;
    caseSensitive: boolean;
    /** Location needles match structurally against LSP `uri`+range; others match text tokens. */
    kind: "location" | "token";
    /** 1-based gold line for `path:line` location needles; null for file-only. */
    line: number | null;
}

/** Structural gold locations derived from location-bearing gold kinds. */
export interface TebGoldLocation {
    path: string;
    /** 1-based line; null for file-only gold. */
    line: number | null;
}

export function goldNeedles(task: TebTask): TebGoldNeedle[] {
    const needles: TebGoldNeedle[] = [];
    const pathNeedle = (path: string, line?: number): void => {
        // Line-bearing gold matches only with its line (`path:line` text or
        // the structural uri+range check): a result pointing at the right
        // file but the wrong line is not evidence (E11).
        if (line !== undefined) {
            needles.push({ text: `${path}:${line}`, caseSensitive: true, kind: "location", line });
            return;
        }
        needles.push({ text: path, caseSensitive: true, kind: "location", line: null });
        const base = path.split("/").pop();
        if (base && base !== path)
            needles.push({ text: base, caseSensitive: true, kind: "location", line: null });
    };
    const tokenNeedle = (text: string, caseSensitive: boolean): void => {
        if (text.length > 0) needles.push({ text, caseSensitive, kind: "token", line: null });
    };
    const gold = task.gold;
    switch (gold.kind) {
        case "single-location":
            pathNeedle(gold.location.path, gold.location.line);
            break;
        case "location-set":
            for (const location of gold.locations) pathNeedle(location.path, location.line);
            break;
        case "caller-set":
            // Names alone do not qualify (E13.4): only the path+line
            // location context counts as caller evidence.
            for (const caller of gold.callers) {
                pathNeedle(caller.path, caller.line);
            }
            break;
        case "file-set":
            for (const file of gold.files) pathNeedle(file);
            break;
        case "file":
            pathNeedle(gold.path);
            break;
        case "route-set":
            // Route paths alone do not qualify (E13.4): only the
            // file+line location context counts as route evidence.
            for (const route of gold.routes) {
                pathNeedle(route.file, route.line);
            }
            break;
        case "scalar": {
            const caseSensitive = task.caseSensitive === true;
            tokenNeedle(gold.value, caseSensitive);
            break;
        }
        case "type-string":
            tokenNeedle(collapseWhitespace(gold.normalized), false);
            break;
    }
    return needles;
}

/** Location-bearing gold as structural entries (path + 1-based line). */
export function goldLocations(task: TebTask): TebGoldLocation[] {
    const gold = task.gold;
    switch (gold.kind) {
        case "single-location":
            return [{ path: gold.location.path, line: gold.location.line }];
        case "location-set":
            return gold.locations.map((l) => ({ path: l.path, line: l.line }));
        case "caller-set":
            return gold.callers.map((c) => ({ path: c.path, line: c.line }));
        case "file-set":
            return gold.files.map((path) => ({ path, line: null }));
        case "file":
            return [{ path: gold.path, line: null }];
        case "route-set":
            return gold.routes.map((r) => ({ path: r.file, line: r.line }));
        default:
            return [];
    }
}

function collapseWhitespace(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

function containsNeedle(haystack: string, needle: TebGoldNeedle): boolean {
    if (needle.text.length === 0) return false;
    if (needle.kind === "location") {
        // Line-bearing locations match with a numeric trailing boundary
        // (E13.4): `src/index.ts:10` must not match `src/index.ts:100`.
        if (needle.line !== null) {
            const path = needle.text.includes(":")
                ? needle.text.slice(0, needle.text.lastIndexOf(":"))
                : needle.text;
            return containsLocation(haystack, path, needle.line);
        }
        if (needle.caseSensitive) return haystack.includes(needle.text);
        return haystack.toLowerCase().includes(needle.text.toLowerCase());
    }
    return containsToken(haystack, needle.text, needle.caseSensitive);
}

/**
 * `path:line` text match with a numeric trailing boundary (E13.4): the
 * line number must not be followed by another digit, so gold
 * `src/index.ts:10` does not match text `src/index.ts:100`.
 */
export function containsLocation(haystack: string, path: string, line: number): boolean {
    const re = new RegExp(`${escapeRegExp(path)}:${line}(?![0-9])`);
    return re.test(haystack);
}

/**
 * Minimum needle length for boundary-regex matching. Shorter token
 * needles (e.g. scalar gold `"3"`) must equal a full delimited token:
 * bare-substring matching credits unrelated text (`"30"`).
 */
export const MIN_TOKEN_NEEDLE_LENGTH = 3;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Exact-token/word-boundary match for scalar, caller-name, route-path,
 * and type-string needles (E11). `"3"` must not match `"30"`;
 * `"build"` must not match `"rebuild"`.
 */
export function containsToken(haystack: string, text: string, caseSensitive: boolean): boolean {
    if (text.length === 0) return false;
    if (text.length < MIN_TOKEN_NEEDLE_LENGTH) {
        const normHay = caseSensitive ? haystack : haystack.toLowerCase();
        const normNeedle = caseSensitive ? text : text.toLowerCase();
        return normHay.split(/[^a-z0-9_]+/i).some((token) => token === normNeedle);
    }
    const flags = caseSensitive ? "" : "i";
    const re = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(text)}(?:$|[^A-Za-z0-9_])`, flags);
    return re.test(haystack);
}

/**
 * Evidence text actually graded for first-correct: for strict-LSP results
 * the stringified envelope result (plus rendered text); otherwise the
 * rendered text. The enrichment footer is stripped in both cases: it
 * names files the result never showed.
 */
export function evidenceText(call: TebToolCall): string {
    const rendered = stripEnrichmentFooter(call.renderedText);
    if (call.lspResultJson) return `${call.lspResultJson}\n${rendered}`;
    return rendered;
}

/** One structural location parsed from a strict-LSP envelope result. */
export interface TebLspLocation {
    /** Decoded path from the result `uri` (absolute when the server sent `file://`). */
    uriPath: string;
    /** 0-based `range.start.line`; null when the item carries no range. */
    line0: number | null;
}

function uriToPath(uri: string): string {
    if (uri.startsWith("file://")) {
        try {
            return decodeURIComponent(uri.slice("file://".length));
        } catch {
            return uri.slice("file://".length);
        }
    }
    return uri;
}

/** Whether a result `uri` names the gold path (absolute or repo-relative). */
export function uriMatchesGoldPath(uri: string, goldPath: string): boolean {
    const p = uriToPath(uri);
    return p === goldPath || p.endsWith(`/${goldPath}`);
}

/**
 * Structural locations from a stringified LSP envelope result.
 * Navigation results are `Location`/`LocationLink`-shaped items with a
 * `uri` (or `targetUri`) plus a 0-based `range` (or `targetRange` /
 * `targetSelectionRange`); symbol results without a range yield a
 * path-only entry. Unparseable JSON yields no locations, never a match.
 */
export function lspResultLocations(lspResultJson: string | null): TebLspLocation[] {
    if (!lspResultJson) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(lspResultJson);
    } catch {
        return [];
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const out: TebLspLocation[] = [];
    for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        const uri = rec["uri"] ?? rec["targetUri"];
        if (typeof uri !== "string" || uri.length === 0) continue;
        const range = rec["range"] ?? rec["targetRange"] ?? rec["targetSelectionRange"];
        let line0: number | null = null;
        if (typeof range === "object" && range !== null) {
            const start = (range as Record<string, unknown>)["start"];
            if (typeof start === "object" && start !== null) {
                const line = (start as Record<string, unknown>)["line"];
                if (typeof line === "number" && Number.isInteger(line) && line >= 0) line0 = line;
            }
        }
        out.push({ uriPath: uriToPath(uri), line0 });
    }
    return out;
}

/**
 * Structural location match: result `uri` names the gold path and, when
 * the gold carries a line, the 0-based result line + 1 equals it
 * (strict-LSP positions are 0-based; task gold is 1-based). A result
 * pointing at the right file but the wrong line is not evidence.
 */
export function matchesGoldLocation(
    locations: TebLspLocation[],
    gold: TebGoldLocation,
): boolean {
    return locations.some((loc) => {
        if (!uriMatchesGoldPath(loc.uriPath, gold.path)) return false;
        if (gold.line === null) return true;
        return loc.line0 !== null && loc.line0 + 1 === gold.line;
    });
}

/** Non-alphanumeric token match for an echoed line number in call args. */
function argsContainLine(argsText: string, line: number): boolean {
    const re = new RegExp(`(?:^|[^0-9])${line}(?:$|[^0-9])`);
    return re.test(argsText);
}

/**
 * Arg-echo exclusion for one location needle (E10.4). Echoing the
 * prompt's path back is not evidence — but when only the path is
 * echoed, the line is still compared: a same-file jump to the gold
 * line counts, while the bare path or a wrong line does not. Line
 * comparison uses the numeric-boundary matcher (E13.4), so an echoed
 * `src/index.ts:1670` does not exclude gold line 167.
 */
export function locationNeedleEchoed(argsText: string, needle: TebGoldNeedle): boolean {
    if (needle.line === null) return argsText.includes(needle.text);
    const path = needle.text.includes(":")
        ? needle.text.slice(0, needle.text.lastIndexOf(":"))
        : needle.text;
    if (!argsText.includes(path)) return false;
    return containsLocation(argsText, path, needle.line);
}

/**
 * Successful means ended, non-error, non-`unavailable`, and without a
 * failed strict-LSP envelope status (`error`, `timeout`, `not_ready`,
 * `unsupported`, `cancelled`, `ambiguous`).
 *
 * Note: `empty` LSP results pass this filter but never satisfy
 * first-correct — only `ok` envelopes qualify there (E13.4).
 */
export function isSuccessfulCall(call: TebToolCall): boolean {
    return call.ended && !call.unavailable && !isFailedCall(call);
}

/**
 * First successful call whose evidence text contains a gold needle that
 * does NOT already appear in that call's own arguments (arg-echo
 * exclusion: the agent echoing the prompt back is not evidence).
 * Returns the 1-based call index and cost cut-points, or null if never.
 */
export interface TebFirstCorrect {
    /** 1-based index into the run's tool-call list. */
    callIndex: number;
    toolCallId: string;
    toolName: string;
    callsTo: number;
    tokensTo: number | null;
    timeToMs: number | null;
}

export function firstCorrectEvidence(
    run: TebExtractedRun,
    task: TebTask,
): TebFirstCorrect | null {
    const needles = goldNeedles(task);
    const locations = goldLocations(task);
    if (needles.length === 0 && locations.length === 0) return null;
    const calls = run.calls;
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        if (!isSuccessfulCall(call)) continue;
        // E13.4: LSP results qualify only with
        // `details.envelope.status == "ok"` — `empty` and envelope-less
        // results never count, even when their rendered text names gold.
        if (call.toolName === "LSP" && call.envelopeStatus !== "ok") continue;
        const argsJson = JSON.stringify(call.args);
        const argsCollapsed = collapseWhitespace(argsJson);
        let text = evidenceText(call);
        text = collapseWhitespace(text);
        // Structural LSP match: result `uri` + 0-based line (E11). A
        // result pointing at the right file but the wrong line is not
        // evidence.
        const parsedLocations = lspResultLocations(call.lspResultJson);
        const structuralHit = locations.some((gold) => {
            if (!matchesGoldLocation(parsedLocations, gold)) return false;
            // Echo rule mirrored from the text needles: a path echoed in
            // args still counts when the gold line is shown and not echoed.
            if (!argsCollapsed.includes(gold.path)) return true;
            if (gold.line === null) return false;
            return !argsContainLine(argsCollapsed, gold.line);
        });
        const textHit = needles.some((needle) => {
            const collapsed: TebGoldNeedle = {
                text: collapseWhitespace(needle.text),
                caseSensitive: needle.caseSensitive,
                kind: needle.kind,
                line: needle.line,
            };
            if (!containsNeedle(text, collapsed)) return false;
            // Arg-echo exclusion on the same normalized basis. For
            // location needles the line is compared too: echoing the path
            // alone does not exclude a `path:line` hit whose line is shown
            // and not echoed.
            if (needle.kind === "location") {
                return !locationNeedleEchoed(argsCollapsed, collapsed);
            }
            return !containsToken(argsCollapsed, collapsed.text, collapsed.caseSensitive);
        });
        const hit = structuralHit || textHit;
        if (hit) {
            return {
                callIndex: i + 1,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                callsTo: i + 1,
                tokensTo: call.tokensBefore,
                timeToMs:
                    run.startRt !== null && call.endRt !== null ? call.endRt - run.startRt : null,
            };
        }
    }
    return null;
}

export interface TebRunMetrics {
    taskId: string;
    family: TebFamily;
    toolCalls: number;
    errors: number;
    unavailable: number;
    /** Ended failed calls (tool `isError` or failed LSP envelope) per tool request. */
    invalidCallRate: number;
    specialistCalls: number;
    /** Non-negative families: was the family specialist tool called. */
    opportunityRecall: boolean | null;
    /**
     * Fraction of runs with ≥1 error/`unavailable` that later record a
     * successful call of any tool (temporal succession only). Null when
     * the run had no error or `unavailable`.
     */
    postErrorSuccess: boolean | null;
    firstCorrect: TebFirstCorrect | null;
    /** Negative-control tasks: ≥1 specialist call (over-routing). */
    negativeOveruse: boolean | null;
    totalTokens: number;
    costTotal: number;
}

/** Per-run secondary metrics for one task×arm×replicate. */
export function scoreRunMetrics(task: TebTask, run: TebExtractedRun): TebRunMetrics {
    const entry = FAMILY_TABLE[task.family];
    const calls = run.calls;
    // Errors cover tool error ends AND failed strict-LSP envelope statuses
    // (E11): server-side failures arrive with `isError:false`.
    const errors = calls.filter((call) => call.ended && isFailedCall(call)).length;
    const unavailable = calls.filter((call) => call.unavailable).length;
    const specialistFlags = calls.map((call) =>
        isSpecialistCallForFamily(task.family, call.toolName, call.args),
    );
    const specialistCalls = specialistFlags.filter(Boolean).length;

    let postErrorSuccess: boolean | null = null;
    const firstBad = calls.findIndex(
        (call) => (call.ended && isFailedCall(call)) || call.unavailable,
    );
    if (firstBad !== -1) {
        postErrorSuccess = calls
            .slice(firstBad + 1)
            .some((call) => isSuccessfulCall(call));
    }

    const anySpecialist = calls.some((call) => isSpecialistCall(call.toolName, call.args));

    return {
        taskId: task.id,
        family: task.family,
        toolCalls: calls.length,
        errors,
        unavailable,
        invalidCallRate: calls.length === 0 ? 0 : errors / calls.length,
        specialistCalls,
        opportunityRecall: entry.negativeControl ? null : specialistCalls > 0,
        postErrorSuccess,
        firstCorrect: firstCorrectEvidence(run, task),
        negativeOveruse: entry.negativeControl ? anySpecialist : null,
        totalTokens: run.usage.totalTokens,
        costTotal: run.usage.costTotal,
    };
}

export interface TebAggregateMetrics {
    runs: number;
    meanToolCalls: number;
    meanInvalidCallRate: number;
    meanUnavailable: number;
    opportunityRecall: number | null;
    specialistPrecision: number | null;
    postErrorSuccessRate: number | null;
    meanCallsToFirstCorrect: number | null;
    meanTokensToFirstCorrect: number | null;
    meanTimeToFirstCorrectMs: number | null;
    /**
     * Fraction of runs that showed correct evidence at all. The
     * `mean*ToFirstCorrect` values average survivors only, so an arm
     * that fails more often can look faster; always read them with
     * this fraction (E11).
     */
    firstCorrectSuccessRate: number;
    negativeOveruse: number | null;
    totalTokens: number;
    costTotal: number;
}

function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregates per-run metrics. `tasksById` supplies the opportunity tool
 * lists for the specialist-precision denominator: over all specialist
 * calls, the fraction on tasks whose opportunity lists that tool
 * (1 − over-routing rate).
 */
export function aggregateRunMetrics(
    scored: Array<{ task: TebTask; run: TebExtractedRun; metrics: TebRunMetrics }>,
): TebAggregateMetrics {
    let specialistListed = 0;
    let specialistTotal = 0;
    for (const { task, run } of scored) {
        for (const call of run.calls) {
            if (!isSpecialistCall(call.toolName, call.args)) continue;
            specialistTotal += 1;
            if (task.opportunity.tools.includes(call.toolName)) specialistListed += 1;
        }
    }
    const nonNegative = scored.filter((s) => !FAMILY_TABLE[s.task.family].negativeControl);
    const negatives = scored.filter((s) => FAMILY_TABLE[s.task.family].negativeControl);
    const withPostError = scored.filter((s) => s.metrics.postErrorSuccess !== null);
    const withFirst = scored.filter((s) => s.metrics.firstCorrect !== null);
    const firstCorrectSuccessRate = scored.length === 0 ? 0 : withFirst.length / scored.length;
    return {
        runs: scored.length,
        meanToolCalls: mean(scored.map((s) => s.metrics.toolCalls)) ?? 0,
        meanInvalidCallRate: mean(scored.map((s) => s.metrics.invalidCallRate)) ?? 0,
        meanUnavailable: mean(scored.map((s) => s.metrics.unavailable)) ?? 0,
        opportunityRecall:
            nonNegative.length === 0
                ? null
                : nonNegative.filter((s) => s.metrics.opportunityRecall).length / nonNegative.length,
        specialistPrecision: specialistTotal === 0 ? null : specialistListed / specialistTotal,
        postErrorSuccessRate:
            withPostError.length === 0
                ? null
                : withPostError.filter((s) => s.metrics.postErrorSuccess).length /
                  withPostError.length,
        meanCallsToFirstCorrect: mean(withFirst.map((s) => s.metrics.firstCorrect?.callsTo ?? 0)),
        meanTokensToFirstCorrect: mean(
            withFirst
                .map((s) => s.metrics.firstCorrect?.tokensTo)
                .filter((v): v is number => v !== null && v !== undefined),
        ),
        meanTimeToFirstCorrectMs: mean(
            withFirst
                .map((s) => s.metrics.firstCorrect?.timeToMs)
                .filter((v): v is number => v !== null && v !== undefined),
        ),
        firstCorrectSuccessRate,
        negativeOveruse:
            negatives.length === 0
                ? null
                : negatives.filter((s) => s.metrics.negativeOveruse).length / negatives.length,
        totalTokens: scored.reduce((a, s) => a + s.metrics.totalTokens, 0),
        costTotal: scored.reduce((a, s) => a + s.metrics.costTotal, 0),
    };
}
