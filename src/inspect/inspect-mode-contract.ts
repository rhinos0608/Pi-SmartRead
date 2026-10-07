/**
 * Shared inspect mode contract — analysis-bag key allowlists and helpers
 * shared between the direct tool path (inspect-tool.ts) and the script-mode
 * host bindings (script-mode/host-bindings.ts).
 */
import type { DiagnosticsParams, InspectV4Input, NavigationParams } from "./inspect-types.js";

export const FILE_ANALYSIS_KEYS: ReadonlySet<string> = new Set([
    "signals", "compact", "callDepth", "callDirection", "deadCode", "impact", "diff", "graphSchema", "hotspots", "routes",
]);
// Runtime-side twin of the directory contract: executeDirectoryInspect never
// reads input.impact or input.signals, and normalizeDirectoryAnalysis (below)
// rejects them at runtime for directory-kind requests — but the model-facing
// top-level `analysis` JSON Schema in inspect-tool.ts is a union of both
// branches and still advertises both sets of fields to callers regardless of
// mode (provider schema constraint, not fixable here — see the `analysis`
// field description in inspect-tool.ts).
export const DIRECTORY_ANALYSIS_KEYS: ReadonlySet<string> = new Set([
    "mapTokens", "focus", "compact", "deadCode", "diff", "graphSchema", "hotspots", "routes", "clusters", "layers", "boundaries",
]);

/**
 * Whether this branch actually consumes ContextGraph and therefore justifies
 * awaiting the async `opts.contextGraph` getter. Only directory
 * clusters/layers/graphSchema and file impact/graphSchema read the graph.
 *
 * Single source of truth for "does this request need the shared ContextGraph",
 * shared between the direct tool path (inspect-tool.ts) and the script-mode
 * host bindings (script-mode/host-bindings.ts).
 */
export function needsContextGraph(kind: "file" | "directory", bag: Record<string, unknown>): boolean {
    if (kind === "directory") {
        return bag.clusters === true || bag.layers === true || bag.graphSchema === true;
    }
    return bag.impact === true || bag.graphSchema === true;
}

export function rejectUnknownOptions(bag: Record<string, unknown>, allowed: ReadonlySet<string>, what: string): string | undefined {
    for (const key of Object.keys(bag)) {
        if (!allowed.has(key)) return `Error: inspect ${what} has no option "${key}"`;
    }
    return undefined;
}

const boolKeys = ["compact", "deadCode", "impact", "graphSchema", "hotspots", "routes"] as const;
const dirBoolKeys = ["compact", "deadCode", "graphSchema", "hotspots", "routes", "clusters", "layers", "boundaries"] as const;

const SIGNAL_VALUES: ReadonlySet<string> = new Set([
    "complexity", "public-api", "reuse", "recency", "tests", "deprecation",
]);
const CALL_DIRECTIONS: ReadonlySet<string> = new Set(["callers", "callees", "both"]);
const DIFF_REFS: ReadonlySet<string> = new Set(["unstaged", "staged", "HEAD"]);

function assertNoUnknownFileOptions(bag: Record<string, unknown>): void {
    const unknown = rejectUnknownOptions(bag, FILE_ANALYSIS_KEYS, 'mode "file" analysis');
    if (unknown) throw new Error(unknown);
}

function assertValidSignals(bag: Record<string, unknown>): void {
    if (!("signals" in bag)) return;
    const signals = bag.signals;
    if (!Array.isArray(signals) || signals.some((v) => !SIGNAL_VALUES.has(v as string))) {
        throw new Error('Error: inspect signals must be an array of "complexity" | "public-api" | "reuse" | "recency" | "tests" | "deprecation"');
    }
}

function assertBooleanOptions(bag: Record<string, unknown>, keys: readonly string[]): void {
    for (const key of keys) {
        if (key in bag && typeof bag[key] !== "boolean") throw new Error(`Error: inspect ${key} must be a boolean`);
    }
}

function assertValidCallDepth(bag: Record<string, unknown>): void {
    if (!("callDepth" in bag)) return;
    const depth = bag.callDepth as number;
    if (!Number.isFinite(depth)) throw new Error("Error: inspect callDepth must be 1..5");
    if (depth < 1) throw new Error("Error: inspect callDepth must be 1..5");
    if (depth > 5) throw new Error("Error: inspect callDepth must be 1..5");
}

function assertValidCallDirection(bag: Record<string, unknown>): void {
    if (!("callDirection" in bag)) return;
    if (!CALL_DIRECTIONS.has(bag.callDirection as string)) {
        throw new Error('Error: inspect callDirection must be one of "callers" | "callees" | "both"');
    }
}

function assertValidDiffOption(bag: Record<string, unknown>): void {
    if (!("diff" in bag)) return;
    if (!DIFF_REFS.has(bag.diff as string)) {
        throw new Error('Error: inspect diff must be one of "unstaged" | "staged" | "HEAD"');
    }
}

function assertCallDirectionNeedsDepth(bag: Record<string, unknown>): void {
    if (bag.callDirection !== undefined && bag.callDepth === undefined) {
        throw new Error("Error: inspect callDirection requires callDepth to be set");
    }
}

export function normalizeFileAnalysis(bag: Record<string, unknown>): Partial<InspectV4Input> {
    assertNoUnknownFileOptions(bag);
    assertValidSignals(bag);
    assertBooleanOptions(bag, boolKeys);
    assertValidCallDepth(bag);
    assertValidCallDirection(bag);
    assertValidDiffOption(bag);
    assertCallDirectionNeedsDepth(bag);
    return { ...bag } as Partial<InspectV4Input>;
}

function assertNoUnknownDirectoryOptions(bag: Record<string, unknown>): void {
    const unknown = rejectUnknownOptions(bag, DIRECTORY_ANALYSIS_KEYS, 'mode "directory" analysis');
    if (unknown) throw new Error(unknown);
}

function assertValidMapTokensOption(bag: Record<string, unknown>): void {
    if (!("mapTokens" in bag)) return;
    const value = bag.mapTokens as number;
    if (!Number.isFinite(value)) throw new Error("Error: inspect mapTokens must be 256..32768");
    if (value < 256) throw new Error("Error: inspect mapTokens must be 256..32768");
    if (value > 32768) throw new Error("Error: inspect mapTokens must be 256..32768");
}

function assertValidFocusOption(bag: Record<string, unknown>): void {
    if (!("focus" in bag)) return;
    if (!Array.isArray(bag.focus) || bag.focus.some((v) => typeof v !== "string")) {
        throw new Error("Error: inspect focus must be an array of strings");
    }
}

export function normalizeDirectoryAnalysis(bag: Record<string, unknown>): Partial<InspectV4Input> {
    assertNoUnknownDirectoryOptions(bag);
    assertValidMapTokensOption(bag);
    assertValidFocusOption(bag);
    assertBooleanOptions(bag, dirBoolKeys);
    assertValidDiffOption(bag);
    return { ...bag } as Partial<InspectV4Input>;
}

const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
    "operation", "line", "character", "query", "maxResults",
]);

const DIAGNOSTICS_KEYS: ReadonlySet<string> = new Set(["waitMs", "maxPerFile", "maxFiles"]);

const NAVIGATION_OPERATIONS: ReadonlySet<string> = new Set([
    "definition", "references", "implementation", "hover", "documentSymbols",
    "workspaceSymbols", "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
]);

const FILE_TARGET_OPS: ReadonlySet<string> = new Set([
    "definition", "references", "implementation", "hover",
    "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
]);

function asBag(raw: unknown, what: string): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(`Error: inspect ${what} must be an object`);
    }
    return raw as Record<string, unknown>;
}

function checkFiniteInRange(value: unknown, label: string, min: number, max?: number): number {
    if (!Number.isFinite(value) || (value as number) < min || (max !== undefined && (value as number) > max)) {
        throw new Error(max !== undefined ? `Error: inspect ${label} must be ${min}..${max}` : `Error: inspect ${label} must be a finite number >= ${min}`);
    }
    return value as number;
}

function checkFileTargetOp(op: string, nav: Record<string, unknown>, mode: "file" | "directory"): void {
    if (mode !== "file") throw new Error(`Error: inspect navigation operation "${op}" requires a file target`);
    if (nav.line === undefined || nav.character === undefined) throw new Error(`Error: inspect navigation operation "${op}" requires line and character`);
    if (nav.query !== undefined) throw new Error(`Error: inspect navigation operation "${op}" forbids query`);
}

function parseNavigationScalars(nav: Record<string, unknown>): Omit<NavigationParams, "operation"> {
    const out: Omit<NavigationParams, "operation"> = {};
    if (nav.line !== undefined) out.line = checkFiniteInRange(nav.line, "navigation.line", 1);
    if (nav.character !== undefined) out.character = checkFiniteInRange(nav.character, "navigation.character", 1);
    if (nav.query !== undefined) {
        if (typeof nav.query !== "string") throw new Error("Error: inspect navigation.query must be a string");
        out.query = nav.query;
    }
    if (nav.maxResults !== undefined) out.maxResults = checkFiniteInRange(nav.maxResults, "navigation.maxResults", 1, 100);
    return out;
}

function routeNavigation(op: string, nav: Record<string, unknown>, mode: "file" | "directory"): void {
    if (FILE_TARGET_OPS.has(op)) {
        checkFileTargetOp(op, nav, mode);
    } else if (op === "documentSymbols") {
        if (mode !== "file") throw new Error(`Error: inspect navigation operation "${op}" requires a file target`);
        if (nav.line !== undefined || nav.character !== undefined || nav.query !== undefined) throw new Error(`Error: inspect navigation operation "${op}" forbids line/character`);
    } else {
        if (mode !== "directory") throw new Error(`Error: inspect navigation operation "${op}" requires a directory target`);
        if (nav.query === undefined) throw new Error(`Error: inspect navigation operation "${op}" requires query`);
        if (nav.line !== undefined || nav.character !== undefined) throw new Error(`Error: inspect navigation operation "${op}" forbids line/character`);
    }
}

export function normalizeNavigation(raw: unknown, mode: "file" | "directory"): NavigationParams | undefined {
    if (raw === undefined) return undefined;
    const nav = asBag(raw, "navigation");
    const navUnknown = rejectUnknownOptions(nav, NAVIGATION_KEYS, "navigation");
    if (navUnknown) throw new Error(navUnknown);
    const op = nav.operation;
    if (typeof op !== "string" || !NAVIGATION_OPERATIONS.has(op)) {
        throw new Error('Error: inspect navigation operation must be one of "definition" | "references" | "implementation" | "hover" | "documentSymbols" | "workspaceSymbols" | "prepareCallHierarchy" | "incomingCalls" | "outgoingCalls"');
    }
    const out: NavigationParams = { operation: op as NavigationParams["operation"], ...parseNavigationScalars(nav) };
    routeNavigation(op, nav, mode);
    return out;
}

export function normalizeDiagnostics(raw: unknown, mode: "file" | "directory"): DiagnosticsParams | undefined {
    if (raw === undefined) return undefined;
    const d = asBag(raw, "diagnostics");
    const diagUnknown = rejectUnknownOptions(d, DIAGNOSTICS_KEYS, "diagnostics");
    if (diagUnknown) throw new Error(diagUnknown);
    if (d.maxFiles !== undefined && mode !== "directory") throw new Error("Error: inspect diagnostics.maxFiles requires a directory target");
    const out: DiagnosticsParams = {};
    if (d.waitMs !== undefined) out.waitMs = checkFiniteInRange(d.waitMs, "diagnostics.waitMs", 0);
    if (d.maxPerFile !== undefined) out.maxPerFile = checkFiniteInRange(d.maxPerFile, "diagnostics.maxPerFile", 1);
    if (d.maxFiles !== undefined) out.maxFiles = checkFiniteInRange(d.maxFiles, "diagnostics.maxFiles", 1);
    return out;
}
