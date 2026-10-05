/**
 * External grep benchmark — instance schema (D12-D15).
 *
 * An instance is one issue→fix-patch case from an external dataset.
 * Gold is known-patch-file gold (D14): production (non-test, non-doc)
 * files touched by the fix patch, verified to exist at the base commit.
 * Files that are new in the patch (no base side) are recorded but are not
 * locatable gold.
 */

export type ExternalDataset = "swe-bench-multilingual" | "multi-swe-bench";

export type InstanceLanguage = "ts" | "js";

export type InstanceSplit = "pilot" | "dev" | "holdout";

/** Base-side hunk: file path plus 1-based inclusive line ranges. */
export interface GoldHunk {
    file: string;
    /** 1-based inclusive [start, end] ranges on the base-commit side. */
    ranges: Array<{ start: number; end: number }>;
}

/** A patch file excluded from gold, with the reason it was excluded. */
export interface ExcludedFile {
    file: string;
    reason: "test" | "doc" | "config" | "new-file-no-base" | "missing-at-base";
}

/** Query formulation: issue title (primary) or full issue text (stress). D13. */
export type Formulation = "title" | "body";

export interface BenchmarkInstance {
    instanceId: string;
    dataset: ExternalDataset;
    /** Upstream repo as org/name. */
    repo: string;
    baseCommit: string;
    /** First non-empty line of the issue text. */
    title: string;
    /** Full issue text, never truncated (D13). */
    body: string;
    /** Known-patch-file gold: production files only (D14). */
    goldFiles: string[];
    goldHunks: GoldHunk[];
    excludedFiles: ExcludedFile[];
    language: InstanceLanguage;
    split: InstanceSplit;
    /** License tag of the source dataset. */
    license: string;
}

/** Per-formulation query text for an instance (D13: same source text). */
export function formulationText(instance: BenchmarkInstance, formulation: Formulation): string {
    return formulation === "title" ? instance.title : instance.body;
}
