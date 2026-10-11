/**
 * Pilot corpus construction tooling (design plan §2) — pure and offline.
 *
 * This module owns the fail-closed contracts for building the method-selection
 * pilot fixture before any paid execution:
 *
 *  1. Schemas/validators for query dossiers, candidate dossiers (label-free),
 *     author-proposed labels (kept structurally separate), labeler
 *     assessments, and adjudications.
 *  2. Pinned source-range materialization using the frozen convention from
 *     `run.ts` (`git show <ref>:<file>`, 1-based `line|` prefixes, 3,500-char
 *     cap, 1-based inclusive ranges ≤120 lines under `src/` or `test/`), run
 *     against a caller-supplied repository directory at the frozen pin. The
 *     pin is fixed: the only override is the explicitly named test-only
 *     seam, and the manifest records and verifies the ref actually used.
 *  3. Disjointness evidence against the frozen 44-query corpus: exact and
 *     normalized duplicates plus a documented token-Jaccard near-paraphrase
 *     flag. Flags are evidence for human audit — never an automatic pass.
 *     The production seal and `loadVerifiedPilotCorpus` re-run the check
 *     against `loadFrozenPilotQueries()` (read-only), which fails closed
 *     unless the fixture bytes match the preregistered
 *     `FROZEN_FIXTURE_DIGEST`, and refuse exact or
 *     normalized duplicates and Jaccard at or above the threshold; the
 *     advisory `nearest_old_qid_unknown` flag requires a trimmed non-empty
 *     note. Both entry points also enforce the frozen composition:
 *     exactly 40 queries = 32 answerable + 8 absence.
 *  4. Label-quality gates: binary gold-vs-negative agreement ≥.90, binary
 *     Cohen's κ ≥.75, three-class agreement ≥.85, and each labeler having
 *     both positive and negative labels.
 *  5. Final acceptance: two assessments per candidate, at most one
 *     adjudication per candidate (duplicates rejected), source-cited
 *     adjudication of every disagreement/ambiguity/invalid range, a
 *     deterministic seeded-hash 10% audit of agreed candidates, ≥1 gold for
 *     every answerable query, and 0 gold plus exactly one query-level
 *     `confirmed-absent` absence audit for every absence query.
 *  6. Deterministic, label-independent candidate identity and ordering:
 *     neutral content-derived ids and ordering by
 *     sha256(qid|file|startLine-endLine) — never gold-first. Author dossier
 *     ids (`<qid>-cNN`) map to neutral ids deterministically, with the
 *     mapping sealed as its own artifact.
 *  7. Manifest builder/verifier binding exact-byte SHA-256 of the exact
 *     required artifact set, the source ref actually used, provenance-
 *     checked excerpts (re-materialized and byte-compared at that ref), and
 *     candidate ordering; the verifier refuses any modified byte. Direct
 *     exports of these low-level builders are test-only (`__test__` aliases
 *     at the end of this module).
 *  8. Seal-from-validated-data: `sealPilotCorpusFromRoot(root, {repoDir})`
 *     is the ONLY production seal entry point. Its options carry nothing
 *     but the repository directory: it always seals at `PILOT_SOURCE_REF`,
 *     and the only way to reach a non-frozen ref (or to bypass the
 *     composition check) is the explicitly named test-only wrapper
 *     `__test__sealPilotCorpusFromRoot`. The seal reads every required
 *     artifact file from the pilot data root itself, parses each line with
 *     its exact-key validator, cross-binds the corpus (author-cid map ↔
 *     candidates, both labeler files, required adjudications, final-fixture
 *     labels, absence audits, disjointness rows), runs the label-quality
 *     gates and `verifyFinalAcceptance`, re-runs the frozen-44
 *     disjointness check and the 40/32/8 composition check, re-materializes
 *     every excerpt at the frozen pin, and only then hashes the exact bytes
 *     it read and writes the manifest plus sidecar.
 *     `loadVerifiedPilotCorpus(root)` re-verifies a sealed root, re-runs
 *     the same disjointness and composition checks, and returns the
 *     runtime-branded read-only roster (`isVerifiedPilotCorpusRoster`) for
 *     downstream stages; `assemblePilotDossiers` serves the pre-labeling
 *     phase and never seals.
 *
 * No network, no credentials, no product-source changes: everything here is
 * a pure function of caller-supplied bytes plus (for materialization only) a
 * local `git show` in the caller's repository directory.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PLAN_DATA_DIR, PLAN_SOURCE_REF, loadSetRows } from "./model-comparison-plan.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Frozen constants
 * ──────────────────────────────────────────────────────────────────────── */

/** Source pin for the pilot; reuses the single frozen plan constant. */
export const PILOT_SOURCE_REF: string = PLAN_SOURCE_REF;
/** Maximum materialized range length, 1-based inclusive lines. */
export const PILOT_MAX_RANGE_LINES = 120;
/** Character cap applied to the whole formatted excerpt (header included). */
export const PILOT_EXCERPT_CHAR_CAP = 3500;
/**
 * Near-paraphrase flag threshold: the maximum token-set Jaccard between a new
 * query and any frozen query at or above this value flags the query for human
 * audit. 0.7 is a deliberately loose tripwire — it catches rewordings that
 * keep most of the same vocabulary while rarely flagging genuinely different
 * behavioral questions. Flagging never auto-passes and never auto-rejects:
 * a human decides, and the decision is recorded in the query's
 * `disjointnessNote`.
 */
export const NEAR_PARAPHRASE_JACCARD_THRESHOLD = 0.7;
/** The frozen comparison corpus is exactly 44 query groups. */
export const FROZEN_QUERY_GROUP_COUNT = 44;
/**
 * Preregistered digest of the frozen 44-group fixture files, binding the
 * disjointness check to the exact frozen bytes:
 *
 *   `fixtureSha = SHA256(bytes(set-a.jsonl) ∥ bytes(set-b.jsonl))`
 *
 * Concatenation order matters: set-a first, then set-b. This mirrors the
 * `fixtureSha` derivation in `grep-e2e.ts` and `deriveFullRunPlan`
 * (`sha256Hex(a.rawBytes + b.rawBytes)` over the UTF-8 file contents), is
 * documented in `docs/plans/2026-10-08-judge-decider-protocol.md` §3.1 and
 * `docs/plans/2026-10-08-judge-campaign-foundation-evidence.md`, and is
 * recomputed from the real fixture files in
 * `test/unit/judge/model-comparison-types.test.ts`.
 */
export const FROZEN_FIXTURE_DIGEST = "2e9fa4117b7003e50581ec1c32d2b17c9c211b655bd9a9002a47961f2b871f9b";
/** Pilot composition fixed by protocol A1.2/A1.5: exactly this many queries total. */
export const PILOT_EXPECTED_QUERY_COUNT = 40;
/** Pilot composition: exactly this many of the 40 queries are answerable. */
export const PILOT_EXPECTED_ANSWERABLE = 32;
/** Pilot composition: exactly this many of the 40 queries are absence queries. */
export const PILOT_EXPECTED_ABSENCE = 8;
/** Label-quality gate: binary (gold vs. any negative) agreement minimum. */
export const LABEL_GATE_BINARY_AGREEMENT_MIN = 0.9;
/** Label-quality gate: binary Cohen's kappa minimum. */
export const LABEL_GATE_BINARY_KAPPA_MIN = 0.75;
/** Label-quality gate: three-class agreement minimum. */
export const LABEL_GATE_THREE_CLASS_AGREEMENT_MIN = 0.85;
/**
 * Seed for the deterministic 10% agreed-candidate audit selection. Fixed so
 * the selected audit set is reproducible from the sealed corpus alone.
 */
export const PILOT_AUDIT_SAMPLE_SEED = "method-pilot-audit-10pct-v1";
/** Manifest format version. */
export const PILOT_MANIFEST_VERSION = 1;
/** Sidecar file name bound to the manifest bytes (`<sha256>  <name>`). */
export const PILOT_MANIFEST_SIDECAR_FILE = "pilot-manifest.json";
/** On-disk sidecar file name under the pilot data root: `<manifest name>.sha256`. */
export const PILOT_MANIFEST_SIDECAR_PATH = `${PILOT_MANIFEST_SIDECAR_FILE}.sha256`;
/** The only ordering rule a sealed manifest may declare. */
export const PILOT_ORDER_RULE = "sha256(qid|file|startLine-endLine) ascending, cid ascending tie-break";
/**
 * The exact artifact set a sealed pilot manifest must cover — no missing and
 * no unexpected paths (plan §2 freeze/seal list plus the absence-audit and
 * author-cid-map records). The manifest itself and its sidecar are produced
 * after this set is hashed, so they are deliberately not part of it.
 */
export const PILOT_REQUIRED_ARTIFACT_PATHS: readonly string[] = [
    "pilot-queries.jsonl",
    "pilot-candidates.jsonl",
    "pilot-source-snapshots.jsonl",
    "labels-a.jsonl",
    "labels-b.jsonl",
    "adjudications.jsonl",
    "pilot-absence-audits.jsonl",
    "pilot-disjointness.jsonl",
    "pilot-author-cid-map.jsonl",
    "pilot-fixture.jsonl",
];

/* ──────────────────────────────────────────────────────────────────────────
 * Shared primitives
 * ──────────────────────────────────────────────────────────────────────── */

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed exact-shape check: foreign/extra keys reject the record. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const actual = Object.keys(value);
    if (actual.length !== keys.length) return false;
    const allowed = new Set(keys);
    return actual.every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/** A note must contain non-whitespace content: `" "` is not an audit note. */
function isNonBlankString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isBoolean(value: unknown): value is boolean {
    return typeof value === "boolean";
}

function isInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Utf8(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

/* ──────────────────────────────────────────────────────────────────────────
 * 1. Schemas + fail-closed validators
 * ──────────────────────────────────────────────────────────────────────── */

export type PilotLabel = "gold" | "hard_negative" | "easy_negative";
export type PilotLabeler = "A" | "B";

const PILOT_LABELS: readonly PilotLabel[] = ["gold", "hard_negative", "easy_negative"];
const PILOT_LABELERS: readonly PilotLabeler[] = ["A", "B"];

function isPilotLabel(value: unknown): value is PilotLabel {
    return typeof value === "string" && (PILOT_LABELS as readonly string[]).includes(value);
}

function isPilotLabeler(value: unknown): value is PilotLabeler {
    return typeof value === "string" && (PILOT_LABELERS as readonly string[]).includes(value);
}

/** Query dossier fields (exact set — foreign keys reject the record). */
export const PILOT_QUERY_DOSSIER_KEYS = ["qid", "query", "answerable", "slice", "nearestOldQid", "disjointnessNote"] as const;

/**
 * One pilot query. `nearestOldQid` + `disjointnessNote` together are the
 * per-query disjointness audit required by plan §2: the note must explain how
 * this query differs from its nearest query in the frozen 44.
 */
export interface PilotQueryDossier {
    qid: string;
    query: string;
    answerable: boolean;
    slice: string;
    nearestOldQid: string;
    disjointnessNote: string;
}

export function isPilotQueryDossier(value: unknown): value is PilotQueryDossier {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_QUERY_DOSSIER_KEYS)) return false;
    return isNonEmptyString(value.qid) && isNonEmptyString(value.query) &&
        isBoolean(value.answerable) && isNonEmptyString(value.slice) &&
        isNonEmptyString(value.nearestOldQid) && isNonBlankString(value.disjointnessNote);
}

/** Candidate dossier fields (exact set — deliberately NO label/why fields). */
export const PILOT_CANDIDATE_DOSSIER_KEYS = ["qid", "cid", "file", "startLine", "endLine", "symbol"] as const;

/**
 * One candidate source range, label-free by construction: labels arrive only
 * through the separate assessment/adjudication records, so a dossier carrying
 * a proposed or assigned label is rejected as a foreign key.
 */
export interface PilotCandidateDossier {
    qid: string;
    cid: string;
    file: string;
    startLine: number;
    endLine: number;
    symbol: string | null;
}

/** Repository-relative path guard: only `src/` or `test/`, no traversal. */
export function isValidPilotSourcePath(file: string): boolean {
    if (isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file)) return false;
    if (file.split(/[\\/]/).includes("..")) return false;
    return file.startsWith("src/") || file.startsWith("test/");
}

/** 1-based inclusive range, at most `PILOT_MAX_RANGE_LINES` lines. */
export function isValidPilotLineRange(startLine: number, endLine: number): boolean {
    if (!isInteger(startLine) || !isInteger(endLine)) return false;
    if (startLine < 1 || endLine < startLine) return false;
    return endLine - startLine + 1 <= PILOT_MAX_RANGE_LINES;
}

export function isPilotCandidateDossier(value: unknown): value is PilotCandidateDossier {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_CANDIDATE_DOSSIER_KEYS)) return false;
    if (!isNonEmptyString(value.qid) || !isNonEmptyString(value.cid) || !isNonEmptyString(value.file)) return false;
    if (value.symbol !== null && !isNonEmptyString(value.symbol)) return false;
    if (!isInteger(value.startLine) || !isInteger(value.endLine)) return false;
    return isValidPilotSourcePath(value.file) && isValidPilotLineRange(value.startLine, value.endLine);
}

/** Author-proposed label fields (exact set). */
export const PILOT_AUTHOR_PROPOSAL_KEYS = ["cid", "label", "why"] as const;

/**
 * The corpus author's proposed label. Kept in its own artifact and its own
 * record shape: labelers and the adjudicator never receive it, and it is
 * never merged into a candidate dossier.
 */
export interface PilotAuthorProposal {
    cid: string;
    label: PilotLabel;
    why: string;
}

export function isPilotAuthorProposal(value: unknown): value is PilotAuthorProposal {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_AUTHOR_PROPOSAL_KEYS)) return false;
    return isNonEmptyString(value.cid) && isPilotLabel(value.label) && isNonEmptyString(value.why);
}

/** Labeler assessment fields (exact set). */
export const PILOT_LABELER_ASSESSMENT_KEYS = ["cid", "labeler", "label", "rationale", "rangeValid", "ambiguous"] as const;

/**
 * One blinded independent assessment. `rationale` must cite
 * `file:startLine-endLine` of the candidate (checked contextually by
 * `rationaleCitesSourceRange`, enforced by `verifyFinalAcceptance`).
 */
export interface PilotLabelerAssessment {
    cid: string;
    labeler: PilotLabeler;
    label: PilotLabel;
    rationale: string;
    rangeValid: boolean;
    ambiguous: boolean;
}

export function isPilotLabelerAssessment(value: unknown): value is PilotLabelerAssessment {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_LABELER_ASSESSMENT_KEYS)) return false;
    return isNonEmptyString(value.cid) && isPilotLabeler(value.labeler) && isPilotLabel(value.label) &&
        isNonEmptyString(value.rationale) && isBoolean(value.rangeValid) && isBoolean(value.ambiguous);
}

/** Adjudication fields (exact set). */
export const PILOT_ADJUDICATION_KEYS = ["cid", "label", "rationale", "reviewedAssessments"] as const;
const PILOT_REVIEWED_ASSESSMENT_KEYS = ["labeler", "label"] as const;

/**
 * Adjudicator resolution. `reviewedAssessments` must record exactly the two
 * assessments (labeler A and labeler B, one each) with the labels actually
 * submitted; `rationale` must cite `file:startLine-endLine`.
 */
export interface PilotAdjudication {
    cid: string;
    label: PilotLabel;
    rationale: string;
    reviewedAssessments: Array<{ labeler: PilotLabeler; label: PilotLabel }>;
}

function isValidReviewedAssessments(value: unknown): value is Array<{ labeler: PilotLabeler; label: PilotLabel }> {
    if (!Array.isArray(value) || value.length !== 2) return false;
    if (!value.every((entry) => isPlainObject(entry) && hasExactKeys(entry, PILOT_REVIEWED_ASSESSMENT_KEYS) &&
        isPilotLabeler(entry.labeler) && isPilotLabel(entry.label))) {
        return false;
    }
    const labelers = new Set(value.map((entry) => entry.labeler));
    return labelers.size === 2 && PILOT_LABELERS.every((labeler) => labelers.has(labeler));
}

export function isPilotAdjudication(value: unknown): value is PilotAdjudication {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_ADJUDICATION_KEYS)) return false;
    return isNonEmptyString(value.cid) && isPilotLabel(value.label) && isNonEmptyString(value.rationale) &&
        isValidReviewedAssessments(value.reviewedAssessments);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Contextual citation check: does this rationale cite the candidate range?
 * Delimiter-exact, never substring/prefix: the citation must appear with no
 * path/word character immediately before it and no digit or hyphen
 * immediately after it, so `src/index.ts:1-10` never satisfies a
 * `src/index.ts:1-1` candidate and `lib/src/index.ts:1-1` never satisfies
 * `src/index.ts:1-1`.
 */
export function rationaleCitesSourceRange(rationale: string, candidate: PilotCandidateDossier): boolean {
    const citation = `${candidate.file}:${candidate.startLine}-${candidate.endLine}`;
    return new RegExp(`(?<![A-Za-z0-9_./\\\\-])${escapeRegExp(citation)}(?![0-9-])`).test(rationale);
}

/** Absence-audit record fields (exact set). */
export const PILOT_ABSENCE_AUDIT_KEYS = ["qid", "auditor", "verdict", "evidenceCommands", "rationale"] as const;
/** The only verdict an absence audit may record. */
export const PILOT_ABSENCE_VERDICT = "confirmed-absent" as const;

/**
 * Query-level absence audit (plan §2 / protocol A1.2): an absence query
 * requires a bounded source investigation, so an independent auditor records
 * a `confirmed-absent` verdict backed by explicit evidence commands and a
 * rationale citing the searched `src/` / `test/` paths. Exactly one audit per
 * absence query is required by `verifyFinalAcceptance`.
 */
export interface PilotAbsenceAudit {
    qid: string;
    auditor: string;
    verdict: typeof PILOT_ABSENCE_VERDICT;
    evidenceCommands: string[];
    rationale: string;
}

/** Does this rationale cite at least one plausible searched `src/` or `test/` path? */
export function rationaleCitesSearchedPath(rationale: string): boolean {
    const cited = rationale.match(/(?:src|test)\/[A-Za-z0-9_./\\-]+/g) ?? [];
    return cited.some((path) => isValidPilotSourcePath(path.replace(/[.,;:]+$/, "")));
}

export function isPilotAbsenceAudit(value: unknown): value is PilotAbsenceAudit {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_ABSENCE_AUDIT_KEYS)) return false;
    if (!isNonEmptyString(value.qid) || !isNonEmptyString(value.auditor)) return false;
    if (value.verdict !== PILOT_ABSENCE_VERDICT) return false;
    if (!Array.isArray(value.evidenceCommands) || value.evidenceCommands.length === 0) return false;
    if (!value.evidenceCommands.every((command) => isNonEmptyString(command))) return false;
    return isNonEmptyString(value.rationale) && rationaleCitesSearchedPath(value.rationale);
}

/** Source-snapshot artifact row fields (exact set — no label fields). */
export const PILOT_SOURCE_SNAPSHOT_KEYS = ["cid", "excerpt"] as const;

/** One sealed materialized excerpt: `materializePinnedRange` output keyed by neutral cid. */
export interface PilotSourceSnapshotRow {
    cid: string;
    excerpt: string;
}

export function isPilotSourceSnapshotRow(value: unknown): value is PilotSourceSnapshotRow {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_SOURCE_SNAPSHOT_KEYS)) return false;
    return isNonEmptyString(value.cid) && isNonEmptyString(value.excerpt);
}

/** Final-fixture artifact row fields (exact set — the sealed per-candidate roster record). */
export const PILOT_FIXTURE_ROW_KEYS = ["cid", "qid", "file", "startLine", "endLine", "label"] as const;

export interface PilotFixtureRow {
    cid: string;
    qid: string;
    file: string;
    startLine: number;
    endLine: number;
    label: PilotLabel;
}

export function isPilotFixtureRow(value: unknown): value is PilotFixtureRow {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_FIXTURE_ROW_KEYS)) return false;
    if (!isNonEmptyString(value.cid) || !isNonEmptyString(value.qid) || !isNonEmptyString(value.file)) return false;
    if (!isInteger(value.startLine) || !isInteger(value.endLine)) return false;
    if (!isPilotLabel(value.label)) return false;
    return isValidPilotSourcePath(value.file) && isValidPilotLineRange(value.startLine, value.endLine);
}

/** Disjointness artifact row fields (exact set — the per-query audit projection). */
export const PILOT_DISJOINTNESS_ROW_KEYS = ["qid", "nearestOldQid", "disjointnessNote"] as const;

/**
 * The per-query disjointness audit projected from its query dossier. The
 * seal requires exactly one row per query with values byte-equal to the
 * dossier, so a placeholder or desynced artifact cannot be sealed under
 * this filename.
 */
export interface PilotDisjointnessRow {
    qid: string;
    nearestOldQid: string;
    disjointnessNote: string;
}

export function isPilotDisjointnessRow(value: unknown): value is PilotDisjointnessRow {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_DISJOINTNESS_ROW_KEYS)) return false;
    return isNonEmptyString(value.qid) && isNonEmptyString(value.nearestOldQid) && isNonBlankString(value.disjointnessNote);
}

/* ──────────────────────────────────────────────────────────────────────────
 * 2. Pinned materialization (byte-equal to the run.ts sourceRange convention)
 * ──────────────────────────────────────────────────────────────────────── */

export interface PilotRangeRequest {
    /** Caller-supplied repository directory (the cwd for `git show`). */
    repoDir: string;
    /** Repository-relative file under `src/` or `test/`. */
    file: string;
    /** 1-based inclusive start line. */
    startLine: number;
    /** 1-based inclusive end line. */
    endLine: number;
    symbol: string | null;
    /**
     * Explicitly named test-only seam: materialize from a non-frozen ref
     * (local fixture repos in unit tests). Production callers must omit it —
     * the frozen pilot pin is the only production ref, ad-hoc `ref` overrides
     * are refused outright, and the manifest records and verifies the ref
     * actually used.
     */
    testOnlyRefOverride?: string;
}

/** Ref actually used for a range request: the frozen pin unless the test-only seam overrides it. */
export function pilotRangeEffectiveRef(request: Pick<PilotRangeRequest, "testOnlyRefOverride">): string {
    return request.testOnlyRefOverride ?? PILOT_SOURCE_REF;
}

/**
 * Materialize one pinned source range with the frozen excerpt convention:
 * `git show <ref>:<file>` in `repoDir`, 1-based `line|` prefixes, header
 * `<file>:<start>-<end>[ <symbol>]`, whole-string cap at 3,500 characters,
 * ranges 1-based inclusive and at most 120 lines under `src/` or `test/`.
 *
 * The formatted output is byte-identical to the local `sourceRange` function
 * in `run.ts` (not exported there, so it cannot be imported; the unit test
 * extracts the frozen implementation from `run.ts` itself and proves
 * byte-equality on samples).
 */
export function materializePinnedRange(request: PilotRangeRequest): string {
    if ("ref" in request) {
        throw new Error("refusing ad-hoc ref override: the frozen pilot pin is fixed; tests must use the testOnlyRefOverride seam");
    }
    const { repoDir, file, startLine, endLine, symbol } = request;
    const ref = pilotRangeEffectiveRef(request);
    if (!isValidPilotSourcePath(file)) {
        throw new Error(`Refusing non-repository eval path: ${file}`);
    }
    if (!isValidPilotLineRange(startLine, endLine)) {
        throw new Error(`Invalid pinned source range ${file}:${startLine}-${endLine}`);
    }
    let source: string;
    try {
        source = execFileSync("git", ["show", `${ref}:${file}`], {
            cwd: repoDir,
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
        });
    } catch (cause) {
        throw new Error(`git show failed for ${ref}:${file} in ${repoDir}`, { cause });
    }
    const lines = source.split(/\r?\n/);
    if (endLine > lines.length || endLine - startLine + 1 > PILOT_MAX_RANGE_LINES) {
        throw new Error(`Invalid pinned source range ${file}:${startLine}-${endLine}`);
    }
    const code = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}|${line}`).join("\n");
    return `${file}:${startLine}-${endLine}${symbol ? ` ${symbol}` : ""}\n${code}`.slice(0, PILOT_EXCERPT_CHAR_CAP);
}

/* ──────────────────────────────────────────────────────────────────────────
 * 3. Disjointness checks against the frozen 44 queries
 * ──────────────────────────────────────────────────────────────────────── */

/** One query of the frozen 44-query comparison corpus. */
export interface PilotFrozenQuery {
    qid: string;
    query: string;
}

export interface PilotDisjointnessFinding {
    qid: string;
    /** The frozen qid the author declared as nearest (from the dossier). */
    declaredNearestOldQid: string;
    /** Argmax token-Jaccard frozen qid (first wins on ties, frozen order). */
    computedNearestOldQid: string | null;
    maxTokenJaccard: number;
    exactDuplicateOf: string | null;
    normalizedDuplicateOf: string | null;
    qidCollisionWith: string | null;
    flagged: boolean;
    flagReasons: string[];
}

/**
 * Lowercase, ASCII-fold to `[a-z0-9]+` runs, collapse whitespace. Used both
 * for duplicate detection (normalized equality) and for tokenization.
 */
export function normalizeQueryText(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

/** Token set of a query: normalized text split on spaces, deduplicated. */
export function queryTokenSet(text: string): Set<string> {
    const normalized = normalizeQueryText(text);
    if (normalized === "") return new Set();
    return new Set(normalized.split(" "));
}

/** Jaccard similarity of two token sets; two empty sets are identical (1). */
export function tokenSetJaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection += 1;
    const union = a.size + b.size - intersection;
    return union === 0 ? 1 : intersection / union;
}

/**
 * Load the frozen 44-query corpus (set-a + set-b fixture files) as one query
 * per qid. Fails closed unless the corpus resolves to exactly
 * `FROZEN_QUERY_GROUP_COUNT` groups with globally unique qids and a single
 * consistent query text per group, and — before any row is returned for
 * use — unless `SHA256(bytes(set-a) ∥ bytes(set-b))` equals
 * `FROZEN_FIXTURE_DIGEST`. Structural consistency alone would accept any
 * alternate 44-group fixture pair, letting a pilot query that duplicates
 * real frozen text slip past the disjointness check; the digest binds the
 * rows to the preregistered corpus.
 */
export function loadFrozenPilotQueries(dataDir: string = PLAN_DATA_DIR): PilotFrozenQuery[] {
    const a = loadSetRows("a", dataDir);
    const b = loadSetRows("b", dataDir);
    const groups = new Map<string, PilotFrozenQuery>();
    const firstSet = new Map<string, "a" | "b">();
    for (const row of [...a.rows, ...b.rows]) {
        const priorSet = firstSet.get(row.qid);
        if (priorSet === undefined) firstSet.set(row.qid, row.set);
        else if (priorSet !== row.set) throw new Error(`Frozen qid collides across sets: ${row.qid}`);
        const existing = groups.get(row.qid);
        if (existing === undefined) {
            groups.set(row.qid, { qid: row.qid, query: row.query });
        } else if (existing.query !== row.query) {
            throw new Error(`Inconsistent query text for frozen qid: ${row.qid}`);
        }
    }
    if (groups.size !== FROZEN_QUERY_GROUP_COUNT) {
        throw new Error(`Frozen corpus must contain ${FROZEN_QUERY_GROUP_COUNT} query groups, found ${groups.size}`);
    }
    // Fail closed on identity before the rows are used: set-a bytes first,
    // then set-b bytes (the preregistered concatenation order).
    const digest = sha256Utf8(a.rawBytes + b.rawBytes);
    if (digest !== FROZEN_FIXTURE_DIGEST) {
        throw new Error(
            `frozen fixture bytes do not match the preregistered digest: expected ${FROZEN_FIXTURE_DIGEST}, computed ${digest} (SHA256(bytes(set-a) ∥ bytes(set-b)))`,
        );
    }
    return [...groups.values()];
}

/**
 * Per-query disjointness evidence. Every query is compared against every
 * frozen query:
 *
 *  - `qid_collision`: same qid as a frozen query;
 *  - `exact_duplicate`: identical raw query text;
 *  - `normalized_duplicate`: identical after `normalizeQueryText`;
 *  - `near_paraphrase_jaccard`: max token-set Jaccard ≥
 *    `NEAR_PARAPHRASE_JACCARD_THRESHOLD`;
 *  - `nearest_old_qid_unknown`: the declared `nearestOldQid` is not in the
 *    frozen set.
 *
 * Findings are evidence for human audit — a flagged query is not rejected
 * automatically, and an unflagged query is never auto-accepted as disjoint
 * (the dossier's human-written `disjointnessNote` remains the audit record).
 * An empty frozen set is refused because it would silently pass everything.
 */
export function evaluateQueryDisjointness(
    queries: readonly PilotQueryDossier[],
    frozen: readonly PilotFrozenQuery[],
): PilotDisjointnessFinding[] {
    if (frozen.length === 0) {
        throw new Error("disjointness check requires the frozen query set (an empty set would auto-pass every query)");
    }
    const seenQids = new Set<string>();
    return queries.map((query) => {
        if (seenQids.has(query.qid)) throw new Error(`duplicate pilot qid in disjointness input: ${query.qid}`);
        seenQids.add(query.qid);
        const reasons: string[] = [];
        const qidCollisionWith = frozen.find((old) => old.qid === query.qid)?.qid ?? null;
        if (qidCollisionWith !== null) reasons.push("qid_collision");
        const exactDuplicateOf = frozen.find((old) => old.query === query.query)?.qid ?? null;
        if (exactDuplicateOf !== null) reasons.push("exact_duplicate");
        const normalized = normalizeQueryText(query.query);
        const normalizedDuplicateOf = frozen.find((old) => normalizeQueryText(old.query) === normalized)?.qid ?? null;
        if (normalizedDuplicateOf !== null) reasons.push("normalized_duplicate");
        const tokens = queryTokenSet(query.query);
        let computedNearestOldQid: string | null = null;
        let maxTokenJaccard = 0;
        for (const old of frozen) {
            const score = tokenSetJaccard(tokens, queryTokenSet(old.query));
            if (score > maxTokenJaccard) {
                maxTokenJaccard = score;
                computedNearestOldQid = old.qid;
            }
        }
        if (maxTokenJaccard >= NEAR_PARAPHRASE_JACCARD_THRESHOLD) reasons.push("near_paraphrase_jaccard");
        if (!frozen.some((old) => old.qid === query.nearestOldQid)) reasons.push("nearest_old_qid_unknown");
        return {
            qid: query.qid,
            declaredNearestOldQid: query.nearestOldQid,
            computedNearestOldQid,
            maxTokenJaccard,
            exactDuplicateOf,
            normalizedDuplicateOf,
            qidCollisionWith,
            flagged: reasons.length > 0,
            flagReasons: reasons,
        };
    });
}

/**
 * Frozen-corpus disjointness enforcement, run by both the production seal
 * and `loadVerifiedPilotCorpus`. The frozen corpus is read read-only
 * through `loadFrozenPilotQueries()`; exact or normalized duplicates of any
 * frozen query and near-paraphrase flags (token Jaccard at or above
 * `NEAR_PARAPHRASE_JACCARD_THRESHOLD`) are refused outright. The advisory
 * `nearest_old_qid_unknown` flag is not a refusal, but it must carry a
 * trimmed non-empty audit note on the query. An unreadable frozen corpus is itself
 * a collected failure — no disjointness evidence, no seal, no load.
 */
function frozenDisjointnessFailures(queries: readonly PilotQueryDossier[]): string[] {
    let frozen: PilotFrozenQuery[];
    try {
        frozen = loadFrozenPilotQueries();
    } catch (cause) {
        return [
            `frozen ${FROZEN_QUERY_GROUP_COUNT}-query corpus unavailable for the disjointness check: ` +
                (cause instanceof Error ? cause.message : String(cause)),
        ];
    }
    const failures: string[] = [];
    try {
        for (const finding of evaluateQueryDisjointness(queries, frozen)) {
            if (finding.exactDuplicateOf !== null) {
                failures.push(`query ${finding.qid} exactly duplicates frozen query ${finding.exactDuplicateOf}`);
                continue;
            }
            if (finding.normalizedDuplicateOf !== null) {
                failures.push(`query ${finding.qid} duplicates frozen query ${finding.normalizedDuplicateOf} after normalization`);
                continue;
            }
            if (finding.flagReasons.includes("near_paraphrase_jaccard")) {
                failures.push(
                    `query ${finding.qid} is a near-paraphrase of frozen query ${finding.computedNearestOldQid} ` +
                        `(token Jaccard ${finding.maxTokenJaccard.toFixed(4)} >= ${NEAR_PARAPHRASE_JACCARD_THRESHOLD})`,
                );
            }
            if (finding.flagReasons.includes("nearest_old_qid_unknown")) {
                const note = queries.find((query) => query.qid === finding.qid)?.disjointnessNote;
                if (!isNonBlankString(note)) {
                    failures.push(`query ${finding.qid} flags nearest_old_qid_unknown without a non-blank disjointness audit note`);
                }
            }
        }
    } catch (cause) {
        failures.push(`frozen disjointness check rejected the query set: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return failures;
}

/**
 * Composition enforcement fixed by protocol A1.2/A1.5: exactly
 * `PILOT_EXPECTED_QUERY_COUNT` queries = `PILOT_EXPECTED_ANSWERABLE`
 * answerable + `PILOT_EXPECTED_ABSENCE` absence. Enforced by the production
 * seal and by `loadVerifiedPilotCorpus`; only the `__test__` seal seam
 * bypasses it — never the frozen-44 disjointness check.
 */
function pilotCompositionFailures(queries: readonly PilotQueryDossier[]): string[] {
    const answerable = queries.filter((query) => query.answerable).length;
    const absence = queries.length - answerable;
    if (queries.length === PILOT_EXPECTED_QUERY_COUNT &&
        answerable === PILOT_EXPECTED_ANSWERABLE &&
        absence === PILOT_EXPECTED_ABSENCE) {
        return [];
    }
    return [
        `pilot corpus composition must be exactly ${PILOT_EXPECTED_QUERY_COUNT} queries = ` +
            `${PILOT_EXPECTED_ANSWERABLE} answerable + ${PILOT_EXPECTED_ABSENCE} absence; found ` +
            `${queries.length} queries = ${answerable} answerable + ${absence} absence`,
    ];
}

/* ──────────────────────────────────────────────────────────────────────────
 * 4. Label-quality gates
 * ──────────────────────────────────────────────────────────────────────── */

export interface PilotLabelGateResult {
    /** Number of candidates with exactly one A and one B assessment. */
    pairedCandidateCount: number;
    binaryAgreement: number;
    /** `null` when Cohen's κ is undefined (degenerate shared marginals). */
    binaryKappa: number | null;
    threeClassAgreement: number;
    labelerHasBothClasses: Record<PilotLabeler, boolean>;
    passed: boolean;
    failures: string[];
}

function binaryClass(label: PilotLabel): "positive" | "negative" {
    return label === "gold" ? "positive" : "negative";
}

function pairAssessmentsByCid(assessments: readonly PilotLabelerAssessment[]): Map<string, Record<PilotLabeler, PilotLabelerAssessment>> {
    const byCid = new Map<string, PilotLabelerAssessment[]>();
    for (const assessment of assessments) {
        const bucket = byCid.get(assessment.cid) ?? [];
        bucket.push(assessment);
        byCid.set(assessment.cid, bucket);
    }
    const paired = new Map<string, Record<PilotLabeler, PilotLabelerAssessment>>();
    for (const [cid, bucket] of byCid) {
        const a = bucket.filter((entry) => entry.labeler === "A");
        const b = bucket.filter((entry) => entry.labeler === "B");
        if (a.length !== 1 || b.length !== 1) {
            throw new Error(`label assessments for candidate ${cid} must be exactly one A and one B, found A×${a.length} B×${b.length}`);
        }
        paired.set(cid, { A: a[0]!, B: b[0]! });
    }
    if (paired.size === 0) throw new Error("label-quality gates require at least one paired candidate assessment set");
    return paired;
}

/**
 * Plan §2 label-quality gates, computed over paired (one A, one B)
 * assessments. Fail-closed: unpaired or missing assessments throw; a failed
 * gate is returned in `failures` with measured values. If any gate fails,
 * the entire affected construction batch must be relabeled before paid calls
 * (never selectively discard disagreements).
 */
export function evaluateLabelQualityGates(assessments: readonly PilotLabelerAssessment[]): PilotLabelGateResult {
    const paired = pairAssessmentsByCid(assessments);
    const count = paired.size;
    let binaryAgree = 0;
    let threeClassAgree = 0;
    let aPositive = 0;
    let bPositive = 0;
    const aLabels = new Set<PilotLabel>();
    const bLabels = new Set<PilotLabel>();
    for (const { A, B } of paired.values()) {
        if (binaryClass(A.label) === binaryClass(B.label)) binaryAgree += 1;
        if (A.label === B.label) threeClassAgree += 1;
        if (A.label === "gold") aPositive += 1;
        if (B.label === "gold") bPositive += 1;
        aLabels.add(A.label);
        bLabels.add(B.label);
    }
    const binaryAgreement = binaryAgree / count;
    const threeClassAgreement = threeClassAgree / count;
    const pA = aPositive / count;
    const pB = bPositive / count;
    const expectedAgreement = pA * pB + (1 - pA) * (1 - pB);
    const binaryKappa = expectedAgreement === 1 ? null : (binaryAgreement - expectedAgreement) / (1 - expectedAgreement);
    const labelerHasBothClasses: Record<PilotLabeler, boolean> = {
        A: aLabels.has("gold") && aLabels.size > 1,
        B: bLabels.has("gold") && bLabels.size > 1,
    };
    const failures: string[] = [];
    if (binaryAgreement < LABEL_GATE_BINARY_AGREEMENT_MIN) {
        failures.push(`binary agreement ${binaryAgreement.toFixed(4)} < required ${LABEL_GATE_BINARY_AGREEMENT_MIN.toFixed(4)}`);
    }
    if (binaryKappa === null) {
        failures.push("binary Cohen's kappa undefined (degenerate shared marginals)");
    } else if (binaryKappa < LABEL_GATE_BINARY_KAPPA_MIN) {
        failures.push(`binary Cohen's kappa ${binaryKappa.toFixed(4)} < required ${LABEL_GATE_BINARY_KAPPA_MIN.toFixed(4)}`);
    }
    if (threeClassAgreement < LABEL_GATE_THREE_CLASS_AGREEMENT_MIN) {
        failures.push(`three-class agreement ${threeClassAgreement.toFixed(4)} < required ${LABEL_GATE_THREE_CLASS_AGREEMENT_MIN.toFixed(4)}`);
    }
    for (const labeler of PILOT_LABELERS) {
        if (!labelerHasBothClasses[labeler]) failures.push(`labeler ${labeler} must submit both positive and negative labels`);
    }
    return {
        pairedCandidateCount: count,
        binaryAgreement,
        binaryKappa,
        threeClassAgreement,
        labelerHasBothClasses,
        passed: failures.length === 0,
        failures,
    };
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6. Neutral ids + deterministic label-independent ordering
 * ──────────────────────────────────────────────────────────────────────── */

export interface PilotCandidateOrderKey {
    qid: string;
    file: string;
    startLine: number;
    endLine: number;
}

/** Canonical ordering key: `qid|file|startLine-endLine`. */
export function candidateOrderKey(key: PilotCandidateOrderKey): string {
    if (!isNonEmptyString(key.qid)) throw new Error("candidate order key requires a non-empty qid");
    if (!isValidPilotSourcePath(key.file)) throw new Error(`Refusing non-repository eval path: ${key.file}`);
    if (!isValidPilotLineRange(key.startLine, key.endLine)) {
        throw new Error(`Invalid pinned source range ${key.file}:${key.startLine}-${key.endLine}`);
    }
    return `${key.qid}|${key.file}|${key.startLine}-${key.endLine}`;
}

/** sha256 over the canonical ordering key (lowercase hex). */
export function candidateOrderHash(key: PilotCandidateOrderKey): string {
    return sha256Utf8(candidateOrderKey(key));
}

/**
 * Neutral, content-derived candidate id: `c` + first 12 hex chars of the
 * ordering hash. It carries no label semantics and stays stable while the
 * key (qid + file + range) is unchanged.
 */
export function neutralCandidateId(key: PilotCandidateOrderKey): string {
    return `c${candidateOrderHash(key).slice(0, 12)}`;
}

/** Stamp neutral ids onto label-free candidate key entries (throws on key collisions). */
export function assignNeutralCandidateIds<T extends PilotCandidateOrderKey>(entries: readonly T[]): Array<T & { cid: string }> {
    const out = entries.map((entry) => ({ ...entry, cid: neutralCandidateId(entry) }));
    const cids = new Set(out.map((entry) => entry.cid));
    if (cids.size !== out.length) {
        throw new Error("duplicate candidate key (qid|file|range) — each candidate needs a unique range");
    }
    return out;
}

/**
 * Deterministic, label-independent ordering: ascending order-hash, ties by
 * cid. Only qid/file/range enter the key, so the order cannot depend on
 * labels — it can never be "gold-first".
 */
export function orderCandidates<T extends PilotCandidateOrderKey & { cid: string }>(candidates: readonly T[]): T[] {
    const cids = new Set(candidates.map((candidate) => candidate.cid));
    if (cids.size !== candidates.length) throw new Error("duplicate candidate cid in ordering input");
    return [...candidates].sort((left, right) => {
        const leftHash = candidateOrderHash(left);
        const rightHash = candidateOrderHash(right);
        if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
        if (left.cid !== right.cid) return left.cid < right.cid ? -1 : 1;
        return 0;
    });
}

/** Author candidate entry: the author dossier id (`<qid>-cNN`) plus its source key. */
export const PILOT_AUTHOR_CANDIDATE_KEYS = ["qid", "authorCid", "file", "startLine", "endLine", "symbol"] as const;

export interface PilotAuthorCandidateEntry {
    qid: string;
    authorCid: string;
    file: string;
    startLine: number;
    endLine: number;
    symbol: string | null;
}

export function isPilotAuthorCandidateEntry(value: unknown): value is PilotAuthorCandidateEntry {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_AUTHOR_CANDIDATE_KEYS)) return false;
    if (!isNonEmptyString(value.qid) || !isNonEmptyString(value.authorCid)) return false;
    if (value.symbol !== null && !isNonEmptyString(value.symbol)) return false;
    if (!isNonEmptyString(value.file)) return false;
    if (!isInteger(value.startLine) || !isInteger(value.endLine)) return false;
    if (!isValidPilotSourcePath(value.file) || !isValidPilotLineRange(value.startLine, value.endLine)) return false;
    return new RegExp(`^${escapeRegExp(value.qid)}-c\\d+$`).test(value.authorCid);
}

/** One author-cid → neutral-cid mapping row (exact set — no label field). */
export const PILOT_AUTHOR_CID_MAP_ROW_KEYS = ["authorCid", "cid"] as const;

export interface PilotAuthorCidMapRow {
    authorCid: string;
    cid: string;
}

export function isPilotAuthorCidMapRow(value: unknown): value is PilotAuthorCidMapRow {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_AUTHOR_CID_MAP_ROW_KEYS)) return false;
    return isNonEmptyString(value.authorCid) && isNonEmptyString(value.cid);
}

/**
 * Deterministic author-cid (`<qid>-cNN`) → neutral-cid mapping for the
 * already-written author dossiers. The neutral id is derived only from
 * qid|file|range, so labels and author enumeration order can never leak
 * into it; rows are sorted by author cid so any input arrangement yields
 * the same mapping. Fails closed on malformed author ids, duplicate author
 * ids, and two author ids claiming one candidate key.
 */
export function buildAuthorCidMap(entries: readonly PilotAuthorCandidateEntry[]): PilotAuthorCidMapRow[] {
    if (entries.length === 0) throw new Error("author cid map requires at least one entry");
    const failures: string[] = [];
    const rows: PilotAuthorCidMapRow[] = [];
    const seenAuthorCids = new Set<string>();
    const seenNeutralCids = new Set<string>();
    entries.forEach((entry, index) => {
        if (!isPilotAuthorCandidateEntry(entry)) {
            failures.push(`invalid author candidate entry at index ${index}`);
            return;
        }
        const cid = neutralCandidateId(entry);
        if (seenAuthorCids.has(entry.authorCid)) {
            failures.push(`duplicate author cid ${entry.authorCid}`);
            return;
        }
        if (seenNeutralCids.has(cid)) {
            failures.push(`duplicate neutral cid ${cid} (two author cids claim the same qid|file|range)`);
            return;
        }
        seenAuthorCids.add(entry.authorCid);
        seenNeutralCids.add(cid);
        rows.push({ authorCid: entry.authorCid, cid });
    });
    if (failures.length > 0) throw new Error(`author cid map rejected: ${failures.join("; ")}`);
    return rows.sort((left, right) => (left.authorCid < right.authorCid ? -1 : left.authorCid > right.authorCid ? 1 : 0));
}

/**
 * Translate author-proposed `{cid,label,why}` records from author cids to
 * neutral cids via a sealed mapping. Fails closed on unknown or duplicate
 * author cids so no proposal can silently keep an author id.
 */
export function applyAuthorCidMap(
    proposals: readonly PilotAuthorProposal[],
    rows: readonly PilotAuthorCidMapRow[],
): PilotAuthorProposal[] {
    const lookup = new Map<string, string>();
    for (const row of rows) {
        if (!isPilotAuthorCidMapRow(row)) throw new Error("invalid author cid map row");
        if (lookup.has(row.authorCid)) throw new Error(`duplicate author cid map row ${row.authorCid}`);
        lookup.set(row.authorCid, row.cid);
    }
    const seen = new Set<string>();
    return proposals.map((proposal) => {
        if (!isPilotAuthorProposal(proposal)) throw new Error("invalid author proposal");
        if (seen.has(proposal.cid)) throw new Error(`duplicate author proposal cid ${proposal.cid}`);
        seen.add(proposal.cid);
        const cid = lookup.get(proposal.cid);
        if (cid === undefined) throw new Error(`author proposal references unknown author cid ${proposal.cid}`);
        return { ...proposal, cid };
    });
}

/** Canonical JSONL bytes for any sealed artifact: one row per line, trailing newline. */
export function serializePilotJsonl(rows: readonly unknown[]): string {
    if (rows.length === 0) return "";
    return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** Canonical JSONL bytes for the sealed `pilot-author-cid-map.jsonl` artifact. */
export function serializePilotAuthorCidMap(rows: readonly PilotAuthorCidMapRow[]): string {
    return serializePilotJsonl(rows);
}

/* ──────────────────────────────────────────────────────────────────────────
 * 5. Deterministic 10% audit selection + final acceptance
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Deterministic 10% agreed-sample audit selection: sort agreed cids by
 * sha256(`${seed}\n${cid}`) ascending (cid ascending on the astronomically
 * unlikely hash tie) and take `ceil(n × 0.10)` — rounding up guarantees at
 * least one audited candidate whenever any agreed candidate exists. Selection
 * depends only on the seed and the cid set, never on input order or labels.
 */
export function selectAgreedAuditSample(agreedCids: readonly string[], seed: string = PILOT_AUDIT_SAMPLE_SEED): string[] {
    const unique = new Set(agreedCids);
    if (unique.size !== agreedCids.length) throw new Error("duplicate cid in agreed-candidate audit input");
    if (agreedCids.length === 0) return [];
    const ranked = [...agreedCids].sort((left, right) => {
        const leftHash = sha256Utf8(`${seed}\n${left}`);
        const rightHash = sha256Utf8(`${seed}\n${right}`);
        if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
        return left < right ? -1 : left > right ? 1 : 0;
    });
    return ranked.slice(0, Math.ceil(agreedCids.length * 0.1));
}

export interface PilotFinalAcceptanceInput {
    queries: readonly PilotQueryDossier[];
    candidates: readonly PilotCandidateDossier[];
    assessments: readonly PilotLabelerAssessment[];
    adjudications: readonly PilotAdjudication[];
    /** Query-level absence audits; exactly one validated audit required per absence query. */
    absenceAudits: readonly PilotAbsenceAudit[];
    /** Override the audit seed only for tests; production seals the default. */
    auditSampleSeed?: string;
}

export interface PilotFinalAcceptanceResult {
    ok: boolean;
    failures: string[];
    /** Final label per candidate: adjudicated label wins, else agreed label. */
    finalLabels: Record<string, PilotLabel>;
    auditSampleCids: string[];
}

function invalidRecordFailures<T>(
    records: readonly unknown[],
    validator: (value: unknown) => value is T,
    label: string,
): string[] {
    const failures: string[] = [];
    records.forEach((record, index) => {
        if (!validator(record)) failures.push(`invalid ${label} at index ${index}`);
    });
    return failures;
}

/**
 * Plan §2 final acceptance. Pure and fail-closed; every problem is collected
 * as a failure string rather than thrown, except structurally malformed
 * pairing below which makes further evaluation meaningless.
 *
 * Checks:
 *  - every record passes its schema validator (cids reference real
 *    candidates, candidate qids reference real queries);
 *  - every candidate carries its neutral content-derived id;
 *  - every candidate has exactly one A and one B assessment;
 *  - every assessment rationale cites the candidate's exact delimited
 *    `file:start-end` range (no substring/prefix acceptance);
 *  - at most one adjudication per candidate — duplicates are rejected;
 *  - every disagreement, ambiguity, or invalid-range flag has an
 *    adjudication whose rationale cites the source range and whose
 *    `reviewedAssessments` match the submitted labels;
 *  - the deterministic 10% agreed-sample audit set is fully adjudicated;
 *  - every answerable query has ≥1 final gold; every absence query has 0
 *    gold and exactly one validated `confirmed-absent` absence audit.
 *
 * Author-proposed labels are deliberately NOT an input: they never enter
 * acceptance (blinding by construction).
 */
interface PilotDossierIndex {
    queryByQid: Map<string, PilotQueryDossier>;
    candidateByCid: Map<string, PilotCandidateDossier>;
    failures: string[];
}

function indexDossiers(queries: readonly PilotQueryDossier[], candidates: readonly PilotCandidateDossier[]): PilotDossierIndex {
    const failures: string[] = [
        ...invalidRecordFailures(queries, isPilotQueryDossier, "query dossier"),
        ...invalidRecordFailures(candidates, isPilotCandidateDossier, "candidate dossier"),
    ];
    const queryByQid = new Map<string, PilotQueryDossier>();
    for (const query of queries) {
        if (!isPilotQueryDossier(query)) continue;
        if (queryByQid.has(query.qid)) failures.push(`duplicate query qid ${query.qid}`);
        queryByQid.set(query.qid, query);
    }
    const candidateByCid = new Map<string, PilotCandidateDossier>();
    for (const candidate of candidates) {
        if (!isPilotCandidateDossier(candidate)) continue;
        if (candidateByCid.has(candidate.cid)) failures.push(`duplicate candidate cid ${candidate.cid}`);
        if (!queryByQid.has(candidate.qid)) failures.push(`candidate ${candidate.cid} references unknown qid ${candidate.qid}`);
        if (candidate.cid !== neutralCandidateId(candidate)) {
            failures.push(`candidate ${candidate.cid} does not use its neutral content-derived id`);
        }
        candidateByCid.set(candidate.cid, candidate);
    }
    return { queryByQid, candidateByCid, failures };
}

type PilotAssessmentSlot = Partial<Record<PilotLabeler, PilotLabelerAssessment>>;

function indexAssessments(
    assessments: readonly PilotLabelerAssessment[],
    candidateByCid: Map<string, PilotCandidateDossier>,
): { paired: Map<string, PilotAssessmentSlot>; failures: string[] } {
    const failures = invalidRecordFailures(assessments, isPilotLabelerAssessment, "labeler assessment");
    const paired = new Map<string, PilotAssessmentSlot>();
    for (const assessment of assessments) {
        if (!isPilotLabelerAssessment(assessment)) continue;
        const candidate = candidateByCid.get(assessment.cid);
        if (candidate === undefined) {
            failures.push(`assessment for unknown candidate ${assessment.cid}`);
            continue;
        }
        if (!rationaleCitesSourceRange(assessment.rationale, candidate)) {
            failures.push(`assessment from labeler ${assessment.labeler} missing source citation for candidate ${assessment.cid}`);
        }
        const slot = paired.get(assessment.cid) ?? {};
        if (slot[assessment.labeler] !== undefined) {
            failures.push(`duplicate assessment from labeler ${assessment.labeler} for candidate ${assessment.cid}`);
        }
        slot[assessment.labeler] = assessment;
        paired.set(assessment.cid, slot);
    }
    return { paired, failures };
}

function indexAdjudications(
    adjudications: readonly PilotAdjudication[],
    candidateByCid: Map<string, PilotCandidateDossier>,
    paired: Map<string, PilotAssessmentSlot>,
): { adjudicationByCid: Map<string, PilotAdjudication>; failures: string[] } {
    const failures = invalidRecordFailures(adjudications, isPilotAdjudication, "adjudication");
    const adjudicationByCid = new Map<string, PilotAdjudication>();
    for (const adjudication of adjudications) {
        if (!isPilotAdjudication(adjudication)) continue;
        if (adjudicationByCid.has(adjudication.cid)) {
            failures.push(`duplicate adjudication for candidate ${adjudication.cid}`);
            continue;
        }
        const candidate = candidateByCid.get(adjudication.cid);
        if (candidate === undefined) {
            failures.push(`adjudication for unknown candidate ${adjudication.cid}`);
            continue;
        }
        if (!rationaleCitesSourceRange(adjudication.rationale, candidate)) {
            failures.push(`adjudication for candidate ${adjudication.cid} missing source citation`);
        }
        const slot = paired.get(adjudication.cid) ?? {};
        for (const reviewed of adjudication.reviewedAssessments) {
            const actual = slot[reviewed.labeler];
            if (actual !== undefined && actual.label !== reviewed.label) {
                failures.push(`adjudication for candidate ${adjudication.cid} misstates labeler ${reviewed.labeler}'s assessment`);
            }
        }
        adjudicationByCid.set(adjudication.cid, adjudication);
    }
    return { adjudicationByCid, failures };
}

/** Failures for a candidate whose flags require an adjudication but have none. */
function unresolvedFlagFailures(
    cid: string,
    a: PilotLabelerAssessment,
    b: PilotLabelerAssessment,
    adjudication: PilotAdjudication | undefined,
): string[] {
    if (adjudication !== undefined) return [];
    const failures: string[] = [];
    if (a.label !== b.label) failures.push(`unresolved disagreement for candidate ${cid}`);
    if (a.ambiguous || b.ambiguous) failures.push(`unresolved ambiguity for candidate ${cid}`);
    if (!a.rangeValid || !b.rangeValid) failures.push(`unresolved invalid range for candidate ${cid}`);
    return failures;
}

function deriveCandidateLabels(
    candidates: readonly PilotCandidateDossier[],
    paired: Map<string, PilotAssessmentSlot>,
    adjudicationByCid: Map<string, PilotAdjudication>,
): { finalLabels: Record<string, PilotLabel>; agreedCids: string[]; failures: string[] } {
    const failures: string[] = [];
    const finalLabels: Record<string, PilotLabel> = {};
    const agreedCids: string[] = [];
    for (const candidate of candidates) {
        if (!isPilotCandidateDossier(candidate)) continue;
        const slot = paired.get(candidate.cid) ?? {};
        const a = slot.A;
        const b = slot.B;
        if (a === undefined) failures.push(`candidate ${candidate.cid} has no assessment from labeler A`);
        if (b === undefined) failures.push(`candidate ${candidate.cid} has no assessment from labeler B`);
        if (a === undefined || b === undefined) continue;
        const adjudication = adjudicationByCid.get(candidate.cid);
        const disagreement = a.label !== b.label;
        failures.push(...unresolvedFlagFailures(candidate.cid, a, b, adjudication));
        if (!disagreement) agreedCids.push(candidate.cid);
        if (adjudication !== undefined) {
            finalLabels[candidate.cid] = adjudication.label;
        } else if (!disagreement) {
            finalLabels[candidate.cid] = a.label;
        }
    }
    return { finalLabels, agreedCids, failures };
}

function queryGoldCoverageFailures(
    queries: readonly PilotQueryDossier[],
    candidates: readonly PilotCandidateDossier[],
    finalLabels: Record<string, PilotLabel>,
): string[] {
    const failures: string[] = [];
    for (const query of queries) {
        if (!isPilotQueryDossier(query)) continue;
        let goldCount = 0;
        for (const candidate of candidates) {
            if (!isPilotCandidateDossier(candidate) || candidate.qid !== query.qid) continue;
            if (finalLabels[candidate.cid] === "gold") goldCount += 1;
        }
        if (query.answerable && goldCount < 1) failures.push(`answerable query ${query.qid} has no gold candidate`);
        if (!query.answerable && goldCount > 0) failures.push(`absence query ${query.qid} has a gold candidate`);
    }
    return failures;
}

function indexAbsenceAudits(
    audits: readonly PilotAbsenceAudit[],
    queryByQid: Map<string, PilotQueryDossier>,
): { auditedQids: Set<string>; failures: string[] } {
    const failures = invalidRecordFailures(audits, isPilotAbsenceAudit, "absence audit");
    const auditedQids = new Set<string>();
    for (const audit of audits) {
        if (!isPilotAbsenceAudit(audit)) continue;
        const query = queryByQid.get(audit.qid);
        if (query === undefined) {
            failures.push(`absence audit for unknown query ${audit.qid}`);
            continue;
        }
        if (query.answerable) {
            failures.push(`absence audit for answerable query ${audit.qid}`);
            continue;
        }
        if (auditedQids.has(audit.qid)) {
            failures.push(`duplicate absence audit for query ${audit.qid}`);
            continue;
        }
        auditedQids.add(audit.qid);
    }
    return { auditedQids, failures };
}

function absenceAuditCoverageFailures(
    queries: readonly PilotQueryDossier[],
    auditedQids: ReadonlySet<string>,
): string[] {
    const failures: string[] = [];
    const seenQids = new Set<string>();
    for (const query of queries) {
        if (!isPilotQueryDossier(query) || query.answerable || seenQids.has(query.qid)) continue;
        seenQids.add(query.qid);
        if (!auditedQids.has(query.qid)) failures.push(`absence query ${query.qid} has no absence audit`);
    }
    return failures;
}

export function verifyFinalAcceptance(input: PilotFinalAcceptanceInput): PilotFinalAcceptanceResult {
    const { queries, candidates, assessments, adjudications, absenceAudits } = input;
    const dossiers = indexDossiers(queries, candidates);
    const assessmentIndex = indexAssessments(assessments, dossiers.candidateByCid);
    const adjudicationIndex = indexAdjudications(adjudications, dossiers.candidateByCid, assessmentIndex.paired);
    const absenceAuditIndex = indexAbsenceAudits(absenceAudits, dossiers.queryByQid);
    const labels = deriveCandidateLabels(candidates, assessmentIndex.paired, adjudicationIndex.adjudicationByCid);
    const auditSampleCids = selectAgreedAuditSample(labels.agreedCids, input.auditSampleSeed ?? PILOT_AUDIT_SAMPLE_SEED);
    const failures = [
        ...dossiers.failures,
        ...assessmentIndex.failures,
        ...adjudicationIndex.failures,
        ...absenceAuditIndex.failures,
        ...labels.failures,
        ...auditSampleCids
            .filter((cid) => !adjudicationIndex.adjudicationByCid.has(cid))
            .map((cid) => `audit sample candidate ${cid} has no adjudication`),
        ...queryGoldCoverageFailures(queries, candidates, labels.finalLabels),
        ...absenceAuditCoverageFailures(queries, absenceAuditIndex.auditedQids),
    ];
    return { ok: failures.length === 0, failures, finalLabels: labels.finalLabels, auditSampleCids };
}

/* ──────────────────────────────────────────────────────────────────────────
 * 7. Manifest builder + verifier (low-level bytes; direct exports are
 *    test-only — the production seal path is `sealPilotCorpusFromRoot`)
 * ──────────────────────────────────────────────────────────────────────── */

export interface PilotArtifactInput {
    /** Sealed artifact path relative to the artifact directory (no traversal). */
    path: string;
    /** Exact file bytes as text (UTF-8). */
    content: string;
}

export interface PilotExcerptInput {
    cid: string;
    /** Materialized pinned excerpt (output of `materializePinnedRange`). */
    excerpt: string;
}

/** Seal-time candidates must be full label-free dossiers (`symbol` drives the excerpt header). */
export type PilotManifestCandidate = PilotCandidateDossier;

export interface PilotManifestArtifactEntry {
    path: string;
    sha256: string;
    byteLength: number;
}

export interface PilotManifest {
    version: number;
    /** The ref actually used to materialize every sealed excerpt. */
    sourceRef: string;
    /** True only when the test-only seam recorded a non-frozen `sourceRef`. */
    testOnlyRefOverride: boolean;
    artifacts: PilotManifestArtifactEntry[];
    excerpts: { count: number; digest: string };
    ordering: { rule: string; cids: string[] };
}

export interface PilotManifestInput {
    artifacts: readonly PilotArtifactInput[];
    excerpts: readonly PilotExcerptInput[];
    candidates: readonly PilotManifestCandidate[];
    /** Repository directory used to re-materialize every candidate excerpt (provenance). */
    repoDir: string;
    /** Ref actually used to materialize the excerpts; defaults to the frozen pin. */
    sourceRef?: string;
    /** Explicitly named test-only seam: permit and record a non-frozen `sourceRef`. */
    testOnlyAllowNonFrozenRef?: boolean;
}

function isValidArtifactPath(path: string): boolean {
    if (!isNonEmptyString(path)) return false;
    if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) return false;
    return !path.split(/[\\/]/).includes("..");
}

function excerptDigest(excerpts: readonly PilotExcerptInput[]): { count: number; digest: string } {
    const lines = excerpts.map((entry) => `${entry.cid}\t${sha256Utf8(entry.excerpt)}`);
    return { count: excerpts.length, digest: sha256Utf8(lines.join("\n")) };
}

/** Hash, validate, and canonically sort the exact required artifact set. */
function buildManifestArtifacts(artifacts: readonly PilotArtifactInput[]): PilotManifestArtifactEntry[] {
    const seenPaths = new Set<string>();
    const entries: PilotManifestArtifactEntry[] = artifacts.map((artifact) => {
        if (!isValidArtifactPath(artifact.path)) throw new Error(`refusing unsafe artifact path: ${artifact.path}`);
        if (seenPaths.has(artifact.path)) throw new Error(`duplicate artifact path: ${artifact.path}`);
        seenPaths.add(artifact.path);
        return {
            path: artifact.path,
            sha256: sha256Utf8(artifact.content),
            byteLength: Buffer.byteLength(artifact.content, "utf8"),
        };
    });
    const missingPaths = PILOT_REQUIRED_ARTIFACT_PATHS.filter((path) => !seenPaths.has(path)).sort();
    const unexpectedPaths = [...seenPaths].filter((path) => !PILOT_REQUIRED_ARTIFACT_PATHS.includes(path)).sort();
    if (missingPaths.length > 0 || unexpectedPaths.length > 0) {
        throw new Error(
            `pilot manifest requires the exact artifact set; missing: [${missingPaths.join(", ")}]; unexpected: [${unexpectedPaths.join(", ")}]`,
        );
    }
    return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** Every sealed excerpt must be byte-identical to re-materialization of its candidate at the recorded ref. */
function assertExcerptProvenance(
    candidates: readonly PilotManifestCandidate[],
    excerpts: readonly PilotExcerptInput[],
    repoDir: string,
    sourceRef: string,
): void {
    const testOnlyRefOverride = sourceRef === PILOT_SOURCE_REF ? undefined : sourceRef;
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index]!;
        const provided = excerpts[index]!;
        const materialized = materializePinnedRange({
            repoDir,
            file: candidate.file,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            symbol: candidate.symbol,
            testOnlyRefOverride,
        });
        if (materialized !== provided.excerpt) {
            throw new Error(
                `excerpt provenance mismatch for candidate ${candidate.cid}: sealed excerpt differs from re-materialization at ${sourceRef}`,
            );
        }
    }
}

/**
 * Build the sealed pilot manifest. Fail-closed invariants:
 *
 *  - `sourceRef` records the ref actually used to materialize the excerpts;
 *    any ref other than the frozen pilot pin is refused unless the
 *    explicitly named test-only flag is set, and that flag is recorded;
 *  - artifacts: exactly `PILOT_REQUIRED_ARTIFACT_PATHS` (no missing, no
 *    unexpected), unique safe relative paths, SHA-256 over exact UTF-8
 *    bytes, sorted ascending by path for deterministic output;
 *  - candidates: neutral content-derived cids, passed in canonical
 *    label-independent order — a gold-first or otherwise hand-arranged list
 *    is rejected, and the manifest binds the canonical order;
 *  - excerpts: exactly the candidates' cids in the same canonical order,
 *    each byte-identical to re-materializing its candidate at the recorded
 *    ref (provenance), with an order-sensitive digest over
 *    `cid\tsha256(excerpt)` lines.
 *
 * The direct export is test-only (`__test__buildPilotManifest`): this
 * low-level builder hashes the artifact bytes it is given without validating
 * corpus contents. The only production seal entry point is
 * `sealPilotCorpusFromRoot` (section 8).
 */
function buildPilotManifest(input: PilotManifestInput): PilotManifest {
    const sourceRef = input.sourceRef ?? PILOT_SOURCE_REF;
    const testOnlyRefOverride = input.testOnlyAllowNonFrozenRef === true;
    if (sourceRef !== PILOT_SOURCE_REF && !testOnlyRefOverride) {
        throw new Error(
            `refusing to seal: excerpts must be materialized at the frozen pin ${PILOT_SOURCE_REF}, recorded ref ${sourceRef} ` +
                "(set testOnlyAllowNonFrozenRef only in tests)",
        );
    }
    if (input.candidates.length === 0) throw new Error("pilot manifest requires at least one candidate");
    const artifacts = buildManifestArtifacts(input.artifacts);
    const seenCids = new Set<string>();
    for (const candidate of input.candidates) {
        candidateOrderKey(candidate);
        if (seenCids.has(candidate.cid)) throw new Error(`duplicate candidate cid: ${candidate.cid}`);
        seenCids.add(candidate.cid);
        if (candidate.cid !== neutralCandidateId(candidate)) {
            throw new Error(`candidate ${candidate.cid} does not use its neutral content-derived id`);
        }
        if (candidate.symbol !== null && !isNonEmptyString(candidate.symbol)) {
            throw new Error(`candidate ${candidate.cid} has an invalid symbol field`);
        }
    }
    const canonical = orderCandidates(input.candidates).map((candidate) => candidate.cid);
    const providedOrder = input.candidates.map((candidate) => candidate.cid);
    if (providedOrder.length !== canonical.length || providedOrder.some((cid, index) => cid !== canonical[index])) {
        throw new Error("candidates must be listed in canonical label-independent order (sha256 of qid|file|range)");
    }
    const excerptOrder = input.excerpts.map((entry) => entry.cid);
    if (excerptOrder.length !== canonical.length || excerptOrder.some((cid, index) => cid !== canonical[index])) {
        throw new Error("excerpts must exactly match candidate neutral ids in canonical label-independent order");
    }
    assertExcerptProvenance(input.candidates, input.excerpts, input.repoDir, sourceRef);
    return {
        version: PILOT_MANIFEST_VERSION,
        sourceRef,
        testOnlyRefOverride,
        artifacts,
        excerpts: excerptDigest(input.excerpts),
        ordering: { rule: PILOT_ORDER_RULE, cids: canonical },
    };
}

/** Canonical manifest bytes: pretty JSON + trailing newline (deterministic). Test-only direct export. */
function serializePilotManifest(manifest: PilotManifest): string {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Sidecar bytes binding the manifest: `<sha256hex>  pilot-manifest.json\n`. Shared by seal and load; direct export is test-only. */
function pilotManifestSidecar(manifestBytes: string): string {
    return `${sha256Utf8(manifestBytes)}  ${PILOT_MANIFEST_SIDECAR_FILE}\n`;
}

/**
 * Build + serialize + sidecar in one step (the freeze/seal operation).
 * Direct export is test-only (`__test__sealPilotManifest`): it does not
 * validate corpus contents. Production seals through `sealPilotCorpusFromRoot`.
 */
function sealPilotManifest(input: PilotManifestInput): { manifest: PilotManifest; manifestBytes: string; sidecar: string } {
    const manifest = buildPilotManifest(input);
    const manifestBytes = serializePilotManifest(manifest);
    return { manifest, manifestBytes, sidecar: pilotManifestSidecar(manifestBytes) };
}

function isPilotManifestArtifact(value: unknown): boolean {
    if (!isPlainObject(value) || !hasExactKeys(value, ["path", "sha256", "byteLength"])) return false;
    if (typeof value.path !== "string" || !isValidArtifactPath(value.path)) return false;
    if (typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256)) return false;
    return isInteger(value.byteLength) && value.byteLength >= 0;
}

function isPilotManifestExcerpts(value: unknown): boolean {
    if (!isPlainObject(value) || !hasExactKeys(value, ["count", "digest"])) return false;
    if (!isInteger(value.count) || value.count < 0) return false;
    return typeof value.digest === "string" && SHA256_HEX.test(value.digest);
}

function isPilotManifestOrdering(value: unknown): boolean {
    if (!isPlainObject(value) || !hasExactKeys(value, ["rule", "cids"])) return false;
    if (value.rule !== PILOT_ORDER_RULE || !Array.isArray(value.cids)) return false;
    return value.cids.every((cid) => isNonEmptyString(cid));
}

export function isPilotManifest(value: unknown): value is PilotManifest {
    if (!isPlainObject(value) || !hasExactKeys(value, ["version", "sourceRef", "testOnlyRefOverride", "artifacts", "excerpts", "ordering"])) return false;
    if (value.version !== PILOT_MANIFEST_VERSION || !isNonEmptyString(value.sourceRef)) return false;
    if (typeof value.testOnlyRefOverride !== "boolean") return false;
    if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) return false;
    if (!value.artifacts.every((entry) => isPilotManifestArtifact(entry))) return false;
    if (!isPilotManifestExcerpts(value.excerpts)) return false;
    return isPilotManifestOrdering(value.ordering);
}

function diffPilotManifest(parsed: PilotManifest, expected: PilotManifest): string[] {
    const failures: string[] = [];
    const parsedArtifacts = new Map(parsed.artifacts.map((entry) => [entry.path, entry]));
    const expectedArtifacts = new Map(expected.artifacts.map((entry) => [entry.path, entry]));
    for (const [path, entry] of expectedArtifacts) {
        const actual = parsedArtifacts.get(path);
        if (actual === undefined) failures.push(`artifact missing from manifest: ${path}`);
        else if (actual.sha256 !== entry.sha256 || actual.byteLength !== entry.byteLength) {
            failures.push(`artifact digest mismatch: ${path}`);
        }
    }
    for (const path of parsedArtifacts.keys()) {
        if (!expectedArtifacts.has(path)) failures.push(`sealed artifact not provided: ${path}`);
    }
    if (parsed.excerpts.count !== expected.excerpts.count) failures.push("excerpt count mismatch");
    if (parsed.excerpts.digest !== expected.excerpts.digest) failures.push("excerpt digest mismatch");
    if (parsed.ordering.rule !== expected.ordering.rule) failures.push("ordering rule mismatch");
    if (parsed.ordering.cids.length !== expected.ordering.cids.length ||
        parsed.ordering.cids.some((cid, index) => cid !== expected.ordering.cids[index])) {
        failures.push("candidate ordering mismatch");
    }
    return failures;
}

export interface PilotManifestVerifyInput extends PilotManifestInput {
    /** Exact sealed bytes of `pilot-manifest.json`. */
    manifestBytes: string;
    /** Exact sealed bytes of `pilot-manifest.json.sha256`. */
    sidecar: string;
}

/**
 * Verify a sealed manifest against the actual artifact bytes. The verifier
 * refuses any modified byte: a single changed character in any artifact,
 * excerpt (re-materialized and byte-compared at the recorded ref), the
 * manifest itself (sidecar mismatch), the source ref actually used, the
 * recorded test-only ref-override flag, or the candidate ordering produces
 * a failure. All independent failures are collected; only
 * unparseable/unshaped manifests short-circuit.
 *
 * Direct export is test-only (`__test__verifyPilotManifest`): production
 * re-verification goes through `loadVerifiedPilotCorpus`, which re-reads and
 * re-validates the sealed data root itself instead of trusting
 * caller-supplied bytes.
 */
function verifyPilotManifest(input: PilotManifestVerifyInput): { ok: boolean; failures: string[] } {
    let parsedValue: unknown;
    try {
        parsedValue = JSON.parse(input.manifestBytes);
    } catch {
        return { ok: false, failures: ["manifest json invalid"] };
    }
    if (!isPilotManifest(parsedValue)) {
        return { ok: false, failures: ["manifest shape invalid"] };
    }
    const parsed = parsedValue;
    const failures: string[] = [];
    if (input.sidecar !== pilotManifestSidecar(input.manifestBytes)) {
        failures.push("manifest sidecar mismatch (manifest bytes modified or unsealed)");
    }
    let expected: PilotManifest;
    try {
        expected = buildPilotManifest(input);
    } catch (cause) {
        failures.push(`manifest input invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { ok: false, failures };
    }
    if (parsed.sourceRef !== expected.sourceRef) {
        failures.push(`source ref mismatch: ${parsed.sourceRef}`);
    }
    if (parsed.testOnlyRefOverride !== expected.testOnlyRefOverride) {
        failures.push("test-only ref override flag mismatch");
    }
    failures.push(...diffPilotManifest(parsed, expected));
    return { ok: failures.length === 0, failures };
}

/* ──────────────────────────────────────────────────────────────────────
 * 8. Seal from validated data + verified load (production entry points)
 * ──────────────────────────────────────────────────────────────────── */

/** All ten required artifacts parsed and exact-key validated, keyed by sealed path shape. */
interface PilotCorpus {
    queries: PilotQueryDossier[];
    candidates: PilotCandidateDossier[];
    labelsA: PilotLabelerAssessment[];
    labelsB: PilotLabelerAssessment[];
    adjudications: PilotAdjudication[];
    absenceAudits: PilotAbsenceAudit[];
    disjointness: PilotDisjointnessRow[];
    authorCidMap: PilotAuthorCidMapRow[];
    sourceSnapshots: PilotSourceSnapshotRow[];
    fixture: PilotFixtureRow[];
}

function readPilotTextFile(path: string, what: string): string {
    let bytes: Buffer;
    try {
        bytes = readFileSync(path);
    } catch (cause) {
        throw new Error(`${what} missing or unreadable: ${path}`, { cause });
    }
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
        throw new Error(`${what} is not valid UTF-8: ${path}`);
    }
    return content;
}

/** Reads every required artifact file from the root; sealing later hashes these exact bytes. */
function readPilotArtifacts(root: string): PilotArtifactInput[] {
    return PILOT_REQUIRED_ARTIFACT_PATHS.map((path) => ({
        path,
        content: readPilotTextFile(join(root, path), `pilot artifact ${path}`),
    }));
}

function parsePilotJsonl<T>(path: string, content: string, validator: (value: unknown) => value is T, label: string): T[] {
    if (content === "") return [];
    if (!content.endsWith("\n")) throw new Error(`pilot artifact ${path} must end with a newline`);
    const rows: T[] = [];
    content.slice(0, -1).split("\n").forEach((line, index) => {
        if (line.trim() === "") throw new Error(`pilot artifact ${path} has a blank line at line ${index + 1}`);
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`pilot artifact ${path} has invalid JSON at line ${index + 1}`);
        }
        if (!validator(value)) throw new Error(`invalid ${label} at index ${index} in ${path}`);
        rows.push(value);
    });
    return rows;
}

/** Parses the exact sealed path set into typed rows; every line must pass its exact-key validator. */
function parsePilotArtifacts(files: readonly PilotArtifactInput[]): PilotCorpus {
    const contentByPath = new Map(files.map((file) => [file.path, file.content]));
    const contentOf = (path: string): string => {
        const content = contentByPath.get(path);
        if (content === undefined) throw new Error(`pilot artifact was not read: ${path}`);
        return content;
    };
    const queries = parsePilotJsonl("pilot-queries.jsonl", contentOf("pilot-queries.jsonl"), isPilotQueryDossier, "query dossier");
    const candidates = parsePilotJsonl("pilot-candidates.jsonl", contentOf("pilot-candidates.jsonl"), isPilotCandidateDossier, "candidate dossier");
    const labelsA = parsePilotJsonl("labels-a.jsonl", contentOf("labels-a.jsonl"), isPilotLabelerAssessment, "labeler assessment");
    const labelsB = parsePilotJsonl("labels-b.jsonl", contentOf("labels-b.jsonl"), isPilotLabelerAssessment, "labeler assessment");
    labelsA.forEach((assessment, index) => {
        if (assessment.labeler !== "A") throw new Error(`labels-a.jsonl row at index ${index} is from labeler ${assessment.labeler}`);
    });
    labelsB.forEach((assessment, index) => {
        if (assessment.labeler !== "B") throw new Error(`labels-b.jsonl row at index ${index} is from labeler ${assessment.labeler}`);
    });
    return {
        queries,
        candidates,
        labelsA,
        labelsB,
        adjudications: parsePilotJsonl("adjudications.jsonl", contentOf("adjudications.jsonl"), isPilotAdjudication, "adjudication"),
        absenceAudits: parsePilotJsonl("pilot-absence-audits.jsonl", contentOf("pilot-absence-audits.jsonl"), isPilotAbsenceAudit, "absence audit"),
        disjointness: parsePilotJsonl("pilot-disjointness.jsonl", contentOf("pilot-disjointness.jsonl"), isPilotDisjointnessRow, "disjointness row"),
        authorCidMap: parsePilotJsonl("pilot-author-cid-map.jsonl", contentOf("pilot-author-cid-map.jsonl"), isPilotAuthorCidMapRow, "author cid map row"),
        sourceSnapshots: parsePilotJsonl("pilot-source-snapshots.jsonl", contentOf("pilot-source-snapshots.jsonl"), isPilotSourceSnapshotRow, "source snapshot row"),
        fixture: parsePilotJsonl("pilot-fixture.jsonl", contentOf("pilot-fixture.jsonl"), isPilotFixtureRow, "pilot fixture row"),
    };
}

function disjointnessBindingFailures(corpus: PilotCorpus): string[] {
    const failures: string[] = [];
    const queryByQid = new Map(corpus.queries.map((query) => [query.qid, query]));
    const covered = new Set<string>();
    for (const row of corpus.disjointness) {
        if (covered.has(row.qid)) {
            failures.push(`duplicate disjointness row for query ${row.qid}`);
            continue;
        }
        covered.add(row.qid);
        const query = queryByQid.get(row.qid);
        if (query === undefined) {
            failures.push(`disjointness row for unknown query ${row.qid}`);
            continue;
        }
        if (row.nearestOldQid !== query.nearestOldQid || row.disjointnessNote !== query.disjointnessNote) {
            failures.push(`disjointness row for query ${row.qid} does not match its query dossier`);
        }
    }
    for (const query of corpus.queries) {
        if (!covered.has(query.qid)) failures.push(`query ${query.qid} has no disjointness row`);
    }
    return failures;
}

function authorCidMapBindingFailures(corpus: PilotCorpus): string[] {
    const failures: string[] = [];
    const candidateByCid = new Map(corpus.candidates.map((candidate) => [candidate.cid, candidate]));
    const covered = new Set<string>();
    const entries: PilotAuthorCandidateEntry[] = [];
    let boundRows = 0;
    for (const row of corpus.authorCidMap) {
        if (covered.has(row.cid)) {
            failures.push(`duplicate author cid map row for candidate ${row.cid}`);
            continue;
        }
        covered.add(row.cid);
        const candidate = candidateByCid.get(row.cid);
        if (candidate === undefined) {
            failures.push(`author cid map row ${row.authorCid} references unknown candidate ${row.cid}`);
            continue;
        }
        const entry: PilotAuthorCandidateEntry = {
            qid: candidate.qid,
            authorCid: row.authorCid,
            file: candidate.file,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            symbol: candidate.symbol,
        };
        if (!isPilotAuthorCandidateEntry(entry)) {
            failures.push(`author cid map row ${row.authorCid} is inconsistent with candidate ${row.cid}`);
            continue;
        }
        entries.push(entry);
        boundRows += 1;
    }
    for (const candidate of corpus.candidates) {
        if (!covered.has(candidate.cid)) failures.push(`candidate ${candidate.cid} has no author cid map row`);
    }
    if (boundRows === corpus.authorCidMap.length && boundRows === corpus.candidates.length) {
        try {
            const recomputed = buildAuthorCidMap(entries);
            if (JSON.stringify(recomputed) !== JSON.stringify(corpus.authorCidMap)) {
                failures.push("author cid map rows must equal buildAuthorCidMap rows recomputed from the candidate set");
            }
        } catch (cause) {
            failures.push(`author cid map rejected: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }
    return failures;
}

function orderedBindingFailures(
    corpus: PilotCorpus,
    canonical: readonly PilotCandidateDossier[],
    finalLabels: Record<string, PilotLabel>,
): string[] {
    const failures: string[] = [];
    const canonicalCids = canonical.map((candidate) => candidate.cid);
    const providedCids = corpus.candidates.map((candidate) => candidate.cid);
    if (providedCids.length !== canonicalCids.length || providedCids.some((cid, index) => cid !== canonicalCids[index])) {
        failures.push("pilot-candidates.jsonl must follow canonical label-independent order (sha256 of qid|file|range)");
    }
    if (corpus.sourceSnapshots.length !== canonicalCids.length) {
        failures.push(`pilot-source-snapshots.jsonl has ${corpus.sourceSnapshots.length} rows; expected ${canonicalCids.length}`);
    } else {
        corpus.sourceSnapshots.forEach((row, index) => {
            if (row.cid !== canonicalCids[index]) failures.push(`pilot-source-snapshots.jsonl row ${index} must be candidate ${canonicalCids[index]}`);
        });
    }
    if (corpus.fixture.length !== canonicalCids.length) {
        failures.push(`pilot-fixture.jsonl has ${corpus.fixture.length} rows; expected ${canonicalCids.length}`);
    } else {
        corpus.fixture.forEach((row, index) => {
            const candidate = canonical[index]!;
            if (row.cid !== candidate.cid) {
                failures.push(`pilot-fixture.jsonl row ${index} must be candidate ${candidate.cid}`);
                return;
            }
            if (row.qid !== candidate.qid || row.file !== candidate.file || row.startLine !== candidate.startLine || row.endLine !== candidate.endLine) {
                failures.push(`pilot fixture row for candidate ${row.cid} does not match its dossier`);
                return;
            }
            const expected = finalLabels[row.cid];
            if (row.label !== expected) {
                failures.push(`pilot fixture label mismatch for candidate ${row.cid}: fixture ${row.label}, expected ${String(expected)}`);
            }
        });
    }
    return failures;
}

interface PilotCorpusValidation {
    finalLabels: Record<string, PilotLabel>;
    canonicalCandidates: PilotCandidateDossier[];
}

interface PilotCorpusValidationOptions {
    /**
     * Enforce the frozen composition (40 = 32 answerable + 8 absence).
     * The production seal and `loadVerifiedPilotCorpus` always enforce it;
     * only the `__test__` seal seam bypasses composition — the frozen-44
     * disjointness check still runs there.
     */
    enforceComposition: boolean;
}

/**
 * Fail-closed cross-binding of every sealed artifact. Disjointness rows must
 * cover exactly the queries and mirror their dossiers; the author-cid map
 * must carry exactly one label-free row per candidate and equal
 * `buildAuthorCidMap` recomputed from the candidate set; both labeler files
 * must bind to their labeler; the label-quality gates and
 * `verifyFinalAcceptance` must pass; the frozen-44 disjointness check must
 * pass (exact/normalized duplicates and near-paraphrases refused, advisory
 * flags noted); the frozen composition is enforced when requested; and, in
 * canonical order, the source snapshots and final fixture must match the
 * candidates with fixture labels equal to the adjudicated/agreed labels.
 * Throws with every failure.
 */
function validatePilotCorpus(corpus: PilotCorpus, options: PilotCorpusValidationOptions): PilotCorpusValidation {
    const failures: string[] = [];
    const acceptance = verifyFinalAcceptance({
        queries: corpus.queries,
        candidates: corpus.candidates,
        assessments: [...corpus.labelsA, ...corpus.labelsB],
        adjudications: corpus.adjudications,
        absenceAudits: corpus.absenceAudits,
    });
    failures.push(...acceptance.failures);
    failures.push(...disjointnessBindingFailures(corpus));
    failures.push(...frozenDisjointnessFailures(corpus.queries));
    if (options.enforceComposition) failures.push(...pilotCompositionFailures(corpus.queries));
    failures.push(...authorCidMapBindingFailures(corpus));
    try {
        const gates = evaluateLabelQualityGates([...corpus.labelsA, ...corpus.labelsB]);
        if (!gates.passed) failures.push(...gates.failures.map((failure) => `label-quality gate failed: ${failure}`));
    } catch (cause) {
        failures.push(`label-quality gates rejected the corpus: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    let canonicalCandidates: PilotCandidateDossier[] | undefined;
    if (acceptance.ok) {
        try {
            canonicalCandidates = orderCandidates(corpus.candidates);
        } catch (cause) {
            failures.push(`candidate canonical ordering rejected: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }
    if (canonicalCandidates !== undefined) {
        failures.push(...orderedBindingFailures(corpus, canonicalCandidates, acceptance.finalLabels));
    }
    if (failures.length > 0) throw new Error(`pilot corpus rejected: ${failures.join("; ")}`);
    return { finalLabels: acceptance.finalLabels, canonicalCandidates: canonicalCandidates! };
}

/** Production seal options: the repository directory only — the ref is never caller-selectable. */
export interface SealPilotCorpusOptions {
    /** Repository directory used to re-materialize every excerpt via `git show`. */
    repoDir: string;
}

export interface SealedPilotCorpus {
    manifest: PilotManifest;
    manifestBytes: string;
    sidecar: string;
    manifestPath: string;
    sidecarPath: string;
}

/**
 * Unexported seal implementation. The production entry point always seals
 * at `PILOT_SOURCE_REF` with the frozen composition enforced; a non-frozen
 * ref or a composition bypass is reachable only through the explicitly
 * named test-only wrapper `__test__sealPilotCorpusFromRoot` at the end of
 * this module. That seam bypasses composition only — the frozen-44
 * disjointness check runs on every seal.
 */
function sealPilotCorpus(
    root: string,
    options: { repoDir: string; sourceRef: string; enforceComposition: boolean },
): SealedPilotCorpus {
    const artifacts = readPilotArtifacts(root);
    const corpus = parsePilotArtifacts(artifacts);
    const { canonicalCandidates } = validatePilotCorpus(corpus, { enforceComposition: options.enforceComposition });
    const excerpts: PilotExcerptInput[] = corpus.sourceSnapshots.map((row) => ({ cid: row.cid, excerpt: row.excerpt }));
    // Provenance first: every excerpt must re-materialize at the recorded ref
    // before any corpus byte is hashed into the manifest.
    assertExcerptProvenance(canonicalCandidates, excerpts, options.repoDir, options.sourceRef);
    const sealed = sealPilotManifest({
        artifacts,
        excerpts,
        candidates: canonicalCandidates,
        repoDir: options.repoDir,
        sourceRef: options.sourceRef,
        testOnlyAllowNonFrozenRef: options.sourceRef !== PILOT_SOURCE_REF,
    });
    const manifestPath = join(root, PILOT_MANIFEST_SIDECAR_FILE);
    const sidecarPath = join(root, PILOT_MANIFEST_SIDECAR_PATH);
    writeFileSync(manifestPath, sealed.manifestBytes);
    writeFileSync(sidecarPath, sealed.sidecar);
    return { ...sealed, manifestPath, sidecarPath };
}

/**
 * The ONLY production seal entry point. Options carry nothing but
 * `repoDir`: the seal always materializes at `PILOT_SOURCE_REF`. It reads
 * every required artifact from the pilot data root itself — caller-supplied
 * bytes can never be sealed — parses each line with its exact-key
 * validator, cross-binds the corpus, runs the label-quality gates and
 * `verifyFinalAcceptance`, re-runs the frozen-44 disjointness check and the
 * frozen composition check, re-materializes every excerpt at the frozen
 * pin, and only then hashes the exact bytes it read and writes
 * `pilot-manifest.json` plus its sidecar. Nothing is written when any
 * validation step fails.
 */
export function sealPilotCorpusFromRoot(root: string, options: SealPilotCorpusOptions): SealedPilotCorpus {
    return sealPilotCorpus(root, {
        repoDir: options.repoDir,
        sourceRef: PILOT_SOURCE_REF,
        enforceComposition: true,
    });
}

/**
 * Explicitly named test-only seal seam (unexported; exported below as
 * `__test__sealPilotCorpusFromRoot`): seals at a non-frozen ref for local
 * fixture repos and bypasses the composition check only — every other
 * validation, including the frozen-44 disjointness check, still runs.
 */
function testSealPilotCorpusFromRoot(
    root: string,
    options: { repoDir: string; testOnlyRefOverride?: string },
): SealedPilotCorpus {
    return sealPilotCorpus(root, {
        repoDir: options.repoDir,
        sourceRef: options.testOnlyRefOverride ?? PILOT_SOURCE_REF,
        enforceComposition: false,
    });
}

/** Read-only roster handed to downstream stages (selector, runner) after full re-verification. */
export interface PilotCorpusRoster {
    readonly queries: readonly { readonly qid: string; readonly answerable: boolean }[];
    readonly candidates: readonly {
        readonly cid: string;
        readonly qid: string;
        readonly file: string;
        readonly startLine: number;
        readonly endLine: number;
        readonly label: PilotLabel;
    }[];
    readonly sourceRef: string;
    readonly manifestSha256: string;
}

/**
 * Module-private runtime brand: only rosters that completed full
 * re-verification in `loadVerifiedPilotCorpus` are recorded here. The
 * brand is deliberately a WeakSet outside the public type — structural
 * equality with `PilotCorpusRoster` proves nothing on its own.
 */
const verifiedPilotCorpusRosters = new WeakSet<object>();

/**
 * Runtime brand check for the verified sealed roster: true only for an
 * object branded by `loadVerifiedPilotCorpus` (or by the documented
 * test-only seam below). A hand-constructed structural roster fails this
 * check even when every field is well-formed.
 */
export function isVerifiedPilotCorpusRoster(x: unknown): x is PilotCorpusRoster {
    return typeof x === "object" && x !== null && verifiedPilotCorpusRosters.has(x);
}

/**
 * Test-only seam: brand a structurally valid roster so tests can exercise
 * brand-gated downstream consumers without sealing a real corpus. This
 * performs NO verification — production rosters are branded only by
 * `loadVerifiedPilotCorpus` after full re-verification.
 */
export function __test__brandPilotCorpusRoster(r: PilotCorpusRoster): PilotCorpusRoster {
    verifiedPilotCorpusRosters.add(r);
    return r;
}

/** Re-verifies the sealed manifest against the on-disk artifacts; digests must match the exact bytes read. */
function verifySealedArtifactDigests(root: string, manifest: PilotManifest): PilotArtifactInput[] {
    const artifacts = readPilotArtifacts(root);
    const entryByPath = new Map(manifest.artifacts.map((entry) => [entry.path, entry]));
    if (entryByPath.size !== artifacts.length) throw new Error("pilot manifest artifact set does not match the required artifact set");
    for (const artifact of artifacts) {
        const entry = entryByPath.get(artifact.path);
        if (entry === undefined) throw new Error(`pilot manifest does not cover artifact ${artifact.path}`);
        const sha256 = sha256Utf8(artifact.content);
        if (sha256 !== entry.sha256 || Buffer.byteLength(artifact.content, "utf8") !== entry.byteLength) {
            throw new Error(`pilot artifact digest mismatch: ${artifact.path}`);
        }
    }
    return artifacts;
}

/**
 * Re-verify a sealed pilot data root and return the typed read-only roster
 * for downstream stages. Re-checks the sidecar against the exact manifest
 * bytes, every artifact digest against the exact bytes on disk, the excerpt
 * digest and candidate ordering claims against the corpus, and re-runs the
 * full corpus cross-binding (validators, gates, `verifyFinalAcceptance`,
 * fixture-label equality), the frozen-44 disjointness check, and the frozen
 * composition check (40 = 32 answerable + 8 absence). Fails closed on the
 * first mismatch; the returned roster carries the runtime brand checked by
 * `isVerifiedPilotCorpusRoster`.
 */
export function loadVerifiedPilotCorpus(root: string): PilotCorpusRoster {
    const manifestBytes = readPilotTextFile(join(root, PILOT_MANIFEST_SIDECAR_FILE), "pilot manifest");
    const sidecar = readPilotTextFile(join(root, PILOT_MANIFEST_SIDECAR_PATH), "pilot manifest sidecar");
    if (sidecar !== pilotManifestSidecar(manifestBytes)) {
        throw new Error("pilot manifest sidecar mismatch (manifest bytes modified or unsealed)");
    }
    let parsedValue: unknown;
    try {
        parsedValue = JSON.parse(manifestBytes);
    } catch {
        throw new Error("pilot manifest json invalid");
    }
    if (!isPilotManifest(parsedValue)) throw new Error("pilot manifest shape invalid");
    const artifacts = verifySealedArtifactDigests(root, parsedValue);
    const corpus = parsePilotArtifacts(artifacts);
    const { finalLabels, canonicalCandidates } = validatePilotCorpus(corpus, { enforceComposition: true });
    const snapshotDigest = excerptDigest(corpus.sourceSnapshots.map((row) => ({ cid: row.cid, excerpt: row.excerpt })));
    if (parsedValue.excerpts.count !== snapshotDigest.count || parsedValue.excerpts.digest !== snapshotDigest.digest) {
        throw new Error("pilot manifest excerpt digest does not match pilot-source-snapshots.jsonl");
    }
    const canonicalCids = canonicalCandidates.map((candidate) => candidate.cid);
    if (parsedValue.ordering.cids.length !== canonicalCids.length ||
        parsedValue.ordering.cids.some((cid, index) => cid !== canonicalCids[index])) {
        throw new Error("pilot manifest ordering does not match the canonical candidate order");
    }
    const queries = corpus.queries.map((query) => Object.freeze({ qid: query.qid, answerable: query.answerable }));
    const candidates = canonicalCandidates.map((candidate) => Object.freeze({
        cid: candidate.cid,
        qid: candidate.qid,
        file: candidate.file,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        label: finalLabels[candidate.cid]!,
    }));
    const roster: PilotCorpusRoster = {
        queries: Object.freeze(queries),
        candidates: Object.freeze(candidates),
        sourceRef: parsedValue.sourceRef,
        manifestSha256: sha256Utf8(manifestBytes),
    };
    Object.freeze(roster);
    verifiedPilotCorpusRosters.add(roster);
    return roster;
}

export interface PilotDossierAssemblyInput {
    /** Raw query-dossier rows (exact-key validated here). */
    queryRows: readonly unknown[];
    /** Raw author candidate rows (`<qid>-cNN`; exact-key validated here). */
    authorCandidateRows: readonly unknown[];
    /** Repository directory used to materialize the source snapshots. */
    repoDir: string;
    /** Explicitly named test-only seam: materialize at a non-frozen ref. */
    testOnlyRefOverride?: string;
}

export interface PilotDossierAssembly {
    queries: readonly PilotQueryDossier[];
    /** Neutral content-derived ids in canonical label-independent order. */
    candidates: readonly PilotCandidateDossier[];
    /** Author-cid → neutral-cid rows sorted by author cid. */
    authorCidMap: readonly PilotAuthorCidMapRow[];
    /** Materialized pinned excerpts, one per candidate in canonical order. */
    sourceSnapshots: readonly PilotExcerptInput[];
}

/**
 * Pre-labeling assembly: validate the author's raw dossiers, assign neutral
 * content-derived ids, order candidates label-independently, build the
 * author-cid map, and materialize the source snapshots labelers will read.
 * It never seals: no manifest bytes are produced and nothing is written —
 * sealing happens only through `sealPilotCorpusFromRoot` after labeling and
 * adjudication.
 */
export function assemblePilotDossiers(input: PilotDossierAssemblyInput): PilotDossierAssembly {
    const queries: PilotQueryDossier[] = [];
    const queryQids = new Set<string>();
    input.queryRows.forEach((row, index) => {
        if (!isPilotQueryDossier(row)) throw new Error(`invalid query dossier at index ${index}`);
        if (queryQids.has(row.qid)) throw new Error(`duplicate query qid ${row.qid}`);
        queryQids.add(row.qid);
        queries.push(row);
    });
    if (queries.length === 0) throw new Error("pilot assembly requires at least one query dossier");
    const entries: PilotAuthorCandidateEntry[] = [];
    input.authorCandidateRows.forEach((row, index) => {
        if (!isPilotAuthorCandidateEntry(row)) throw new Error(`invalid author candidate entry at index ${index}`);
        if (!queryQids.has(row.qid)) throw new Error(`author candidate ${row.authorCid} references unknown qid ${row.qid}`);
        entries.push(row);
    });
    const stamped = assignNeutralCandidateIds(entries);
    const authorCidMap = buildAuthorCidMap(entries);
    const candidates = orderCandidates(stamped.map((entry) => ({
        qid: entry.qid,
        cid: entry.cid,
        file: entry.file,
        startLine: entry.startLine,
        endLine: entry.endLine,
        symbol: entry.symbol,
    })));
    const sourceSnapshots = candidates.map((candidate) => ({
        cid: candidate.cid,
        excerpt: materializePinnedRange({
            repoDir: input.repoDir,
            file: candidate.file,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            symbol: candidate.symbol,
            testOnlyRefOverride: input.testOnlyRefOverride,
        }),
    }));
    return { queries, candidates, authorCidMap, sourceSnapshots };
}

/*
 * Test-only export aliases. The low-level builder/serializer/verifier hash
 * and compare whatever bytes they are handed — they never validate corpus
 * contents. The ONLY production seal entry point is
 * `sealPilotCorpusFromRoot` (section 8), and the only production
 * re-verification path is `loadVerifiedPilotCorpus`. The seal alias is the
 * only path to a non-frozen ref or a composition bypass.
 */
export {
    buildPilotManifest as __test__buildPilotManifest,
    pilotManifestSidecar as __test__pilotManifestSidecar,
    sealPilotManifest as __test__sealPilotManifest,
    serializePilotManifest as __test__serializePilotManifest,
    testSealPilotCorpusFromRoot as __test__sealPilotCorpusFromRoot,
    verifyPilotManifest as __test__verifyPilotManifest,
};
