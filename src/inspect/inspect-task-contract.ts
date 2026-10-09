import { checkScopeAdmission, DEFAULT_SCOPE_LIMITS } from "./inspect-bounded-scope.js";
import type { DiffTarget } from "./inspect-types.js";

export type InspectTaskView = "overview" | "dependencies" | "architecture" | "change-review" | "routes";
export type GatherRecipe = "overview" | "dependencies" | "architecture" | "change-review" | "routes";
export type InspectTaskStatus = "ok" | "partial" | "unavailable" | "unsupported" | "failed";
export type InspectCoverage = "complete" | "partial" | "unknown";
export type InspectTaskErrorCode =
    | "invalid-combination"
    | "filesystem-type-mismatch"
    | "diff-required"
    | "budget-exceeded"
    | "scope-unavailable"
    | "unsupported-operation"
    | "stage-failed";

export const GATHER_RECIPE_BY_VIEW: Readonly<Record<InspectTaskView, GatherRecipe>> = {
    overview: "overview",
    dependencies: "dependencies",
    architecture: "architecture",
    "change-review": "change-review",
    routes: "routes",
};

export interface InspectBudget {
    stages: number;
    candidates: number;
    scannedFiles: number;
    scannedBytes: number;
    corroborationFiles: number;
    wallMs: number;
    outputBytes: number;
}

/** Provisional scope-derived ceilings only; no wall-time or output budget is frozen. */
export const DEFAULT_INSPECT_BUDGET: Readonly<InspectBudget> = {
    stages: 4,
    candidates: DEFAULT_SCOPE_LIMITS.maxFiles,
    scannedFiles: DEFAULT_SCOPE_LIMITS.maxFiles,
    scannedBytes: DEFAULT_SCOPE_LIMITS.maxTotalBytes,
    corroborationFiles: DEFAULT_SCOPE_LIMITS.maxFiles,
    wallMs: Number.POSITIVE_INFINITY,
    outputBytes: Number.POSITIVE_INFINITY,
};

export interface InspectTaskCompatibilityInput {
    view: InspectTaskView;
    mode: "file" | "directory" | "script";
    hasAnalysis: boolean;
    diff?: DiffTarget;
    targetIsDirectory: boolean;
}

export function validateInspectTaskCompatibility(input: InspectTaskCompatibilityInput): void {
    const { view, mode, hasAnalysis, diff, targetIsDirectory } = input;
    if (mode === "script") throw new Error("Error: inspect view cannot be used in script mode");
    if (hasAnalysis) throw new Error("Error: inspect view cannot be combined with analysis");
    if (view === "dependencies" && mode !== "file") throw new Error("Error: inspect dependencies view requires file mode");
    if (view === "architecture" && mode !== "directory") throw new Error("Error: inspect architecture view requires directory mode");
    if (view === "change-review" && diff === undefined) throw new Error("Error: inspect change-review view requires diff: unstaged | staged | HEAD");
    if (mode === "file" && targetIsDirectory) throw new Error("Error: inspect file view requires a file target");
    if (mode === "directory" && !targetIsDirectory) throw new Error("Error: inspect directory view requires a directory target");
}

export interface InspectBudgetVerdict {
    admitted: boolean;
    reasons: string[];
}

/** Must be called before a recipe performs work. Wall/output are uncapped until measured. */
export function admitInspectWork(usage: InspectBudget, limits: Readonly<InspectBudget> = DEFAULT_INSPECT_BUDGET): InspectBudgetVerdict {
    const scope = checkScopeAdmission(
        { files: usage.scannedFiles, bytes: usage.scannedBytes },
        { ...DEFAULT_SCOPE_LIMITS, maxFiles: limits.scannedFiles, maxTotalBytes: limits.scannedBytes },
    );
    const reasons = [...scope.reasons];
    for (const key of ["stages", "candidates", "corroborationFiles", "wallMs", "outputBytes"] as const) {
        if (usage[key] > limits[key]) reasons.push(`${key} ${usage[key]} exceeds limit ${limits[key]}`);
    }
    return { admitted: reasons.length === 0, reasons };
}

export interface InspectCitation {
    path: string;
    range?: { start: number; end: number };
    manifestSpecifier?: string;
    resolutionRule?: string;
}

export interface InspectSectionRecord {
    scope: string;
    relationKind: string;
    inspectedCount: number | null;
    displayedCount: number | null;
    omissions: string[];
    unresolved: string[];
    failures: string[];
    truncationReason?: string;
    coverage: InspectCoverage;
    citations: InspectCitation[];
}

export interface InspectStageRecord {
    name: string;
    args: Record<string, unknown>;
    derivation: string;
    status: InspectTaskStatus;
    observed: { files: number | null; bytes: number | null; wallMs: number | null; outputBytes: number | null };
}
