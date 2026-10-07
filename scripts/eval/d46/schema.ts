/**
 * D46 held-out evaluation set: query schema and quota constants.
 *
 * Queries and gold spans are authored from source before any system output
 * (D46). The query files themselves live outside the repo under
 * `~/.cache/pi-smartread-bench/d46/{dev,holdout}/` with mode 0600; only
 * this schema, the validator, and the authoring protocol live in the repo.
 */

export type D46Split = "dev" | "holdout";

export type D46QueryClass =
    | "behaviour"
    | "architecture"
    | "configuration"
    | "error_retry"
    | "multi_file"
    | "exact_ish"
    | "absence";

export type D46ExactForm = "literal" | "regex" | "identifier";

export const D46_CLASSES: readonly D46QueryClass[] = [
    "behaviour",
    "architecture",
    "configuration",
    "error_retry",
    "multi_file",
    "exact_ish",
    "absence",
] as const;

export interface D46GoldSpan {
    /** Repo-relative path from the corpus root at the pinned commit. */
    path: string;
    /** 1-based inclusive line range of the gold span. */
    startLine: number;
    endLine: number;
    /** 1 = primary evidence, 2 = supporting evidence. */
    grade: 1 | 2;
}

export interface D46AbsenceEvidence {
    /** Exhaustive searches run to verify absence (commands + scope). */
    searchesRun: string[];
    /** Alternative phrasings / synonyms checked before declaring absence. */
    synonymsChecked: string[];
}

export interface D46Query {
    id: string;
    repo: string;
    split: D46Split;
    class: D46QueryClass;
    query: string;
    /** Empty for absence queries. */
    gold: D46GoldSpan[];
    rationale: string;
    author: string;
    authoredAt: string;
    /** Required for absence queries, absent otherwise. */
    absenceEvidence?: D46AbsenceEvidence;
    /** Required for exact_ish queries, absent otherwise. */
    exactForm?: D46ExactForm;
}

export interface D46Quota {
    /** Repos the split spans; every repo must appear at least once. */
    repos: number;
    /** Queries per class in total across the repos (near-balanced). */
    perClass: number;
    total: number;
}

/** Holdout: 7 classes x 30 over 8 repos, near-balanced (D46). */
export const HOLDOUT_QUOTA: D46Quota = { repos: 8, perClass: 30, total: 210 };

/** Dev: 7 classes x 8 over 2 repos (D46 divergence). */
export const DEV_QUOTA: D46Quota = { repos: 2, perClass: 8, total: 56 };

export interface D46RepoPin {
    owner: string;
    name: string;
    split: D46Split;
    /** Exact pinned commit sha. */
    sha: string;
    branch: string;
    tag?: string;
    license: { spdx: string; file: string; sha256: string };
    /** Restricts the corpus when the full tree exceeds the size limit. */
    corpusRoot: string;
    fileCount: number;
    workingTree: string;
}

export interface D46RepoManifest {
    version: 1;
    createdAt: string;
    reposDir: string;
    repos: D46RepoPin[];
}
