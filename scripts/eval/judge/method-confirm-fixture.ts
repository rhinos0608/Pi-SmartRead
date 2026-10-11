/**
 * Confirmation-corpus construction tooling (design plan "confirmation run") —
 * pure and offline. This is the production generalization of the method-
 * selection pilot fixture (`method-pilot-fixture.ts`): same fail-closed
 * seal/load discipline, generalized from one frozen source pin to a sealed
 * multi-source registry.
 *
 * The contracts owned here:
 *
 *  1. Multi-source provenance. Every query and candidate carries
 *     `{repo, pin}`; sources come only from the sealed `SOURCES` registry in
 *     `<root>/allocation.json` (`{repo, gitDir, pin, license}` per entry,
 *     unique per `(repo, pin)`). Excerpts materialize as
 *     `git --git-dir <gitDir> show <pin>:<file>` under an offline env
 *     (`GIT_ALLOW_PROTOCOL=none`, `GIT_NO_LAZY_FETCH=1`) with the pilot's
 *     frozen excerpt convention — 1-based `line|` prefixes, whole-string
 *     3,500-char cap, 1-based inclusive ranges ≤120 lines — reusing
 *     `PILOT_MAX_RANGE_LINES` / `PILOT_EXCERPT_CHAR_CAP` and proven
 *     byte-equal to the pilot materializer by test. Path validity is NOT the
 *     pilot's `src/`|`test/` restriction: any tracked-at-the-pin file is
 *     eligible except lockfiles, vendored, minified, and generated files
 *     (explicit rule in `isValidConfirmSourcePath`); trackedness itself is
 *     enforced fail-closed by `git show` when the excerpt materializes.
 *  2. Sealed composition: exactly 400 queries = 320 answerable + 80 absence
 *     (`CONFIRM_EXPECTED_QUERY_COUNT` / `CONFIRM_EXPECTED_ANSWERABLE` /
 *     `CONFIRM_EXPECTED_ABSENCE`), enforced by the production seal and by
 *     `loadVerifiedConfirmCorpus`.
 *  3. Disjointness against ALL 84 prior query groups: the digest-verified
 *     frozen 44 (`loadFrozenPilotQueries`) plus the sealed 40-query pilot,
 *     loaded through `loadVerifiedPilotCorpus` and bound to the
 *     preregistered pilot manifest digest
 *     `CONFIRM_PRIOR_PILOT_MANIFEST_SHA256`. Exact or normalized duplicates
 *     and token-Jaccard ≥ `NEAR_PARAPHRASE_JACCARD_THRESHOLD` (0.7) are
 *     refused; the advisory `nearest_old_qid_unknown` flag requires a
 *     non-blank audit note. The confirm corpus is also checked against
 *     itself: duplicate qids or duplicate (exact/normalized) query text
 *     within the corpus are refused.
 *  4. Neutral, label-independent identity: candidate ids hash
 *     `repo|pin|qid|file|startLine-endLine`, so two sources claiming the
 *     same file and range can never collide; ordering is ascending order
 *     hash with cid tie-break and never involves labels.
 *  5. The pilot's label-quality gates, adjudication rules, absence-audit
 *     rules, and final-acceptance rules, reusing the pilot primitives that
 *     are structurally source-agnostic (`evaluateLabelQualityGates`,
 *     `selectAgreedAuditSample`, `rationaleCitesSourceRange`,
 *     `evaluateQueryDisjointness`, the assessment/adjudication validators).
 *     `verifyConfirmFinalAcceptance` mirrors `verifyFinalAcceptance` rather
 *     than calling it because the pilot's acceptance embeds two pilot-only
 *     assumptions — the `src/`|`test/` path validator and the repo-free
 *     neutral-id formula — which this contract deliberately generalizes. The
 *     pilot module itself is imported read-only; no pilot behaviour changed.
 *  6. Production entry points: `sealConfirmCorpusFromRoot(root)` takes no
 *     options at all (pins/gitDirs come only from the sealed allocation; the
 *     only seam is the explicitly named `__test__sealConfirmCorpusFromRoot`
 *     composition bypass) and `loadVerifiedConfirmCorpus(root)` re-verifies
 *     a sealed root and returns the runtime-branded read-only roster
 *     (`isVerifiedConfirmCorpusRoster`).
 *
 * No network: `git show` runs with transports disabled and lazy fetching
 * refused; no credentials; no product-source changes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
    NEAR_PARAPHRASE_JACCARD_THRESHOLD,
    PILOT_ABSENCE_AUDIT_KEYS,
    PILOT_ABSENCE_VERDICT,
    PILOT_EXCERPT_CHAR_CAP,
    PILOT_MANIFEST_SIDECAR_FILE,
    PILOT_MAX_RANGE_LINES,
    evaluateLabelQualityGates,
    evaluateQueryDisjointness,
    isPilotAdjudication,
    isPilotLabelerAssessment,
    isPilotManifest,
    isPilotQueryDossier,
    isValidPilotLineRange,
    loadFrozenPilotQueries,
    loadVerifiedPilotCorpus,
    normalizeQueryText,
    rationaleCitesSourceRange,
    selectAgreedAuditSample,
    type PilotAdjudication,
    type PilotDisjointnessFinding,
    type PilotFrozenQuery,
    type PilotLabel,
    type PilotLabeler,
    type PilotLabelerAssessment,
} from "./method-pilot-fixture.js";
import { defaultPilotRoot } from "./method-pilot.js";

/* ──────────────────────────────────────────────────────────────────────────
 * Frozen constants
 * ──────────────────────────────────────────────────────────────────────── */

/** Confirmation composition: exactly this many queries total. */
export const CONFIRM_EXPECTED_QUERY_COUNT = 400;
/** Confirmation composition: exactly this many of the 400 queries are answerable. */
export const CONFIRM_EXPECTED_ANSWERABLE = 320;
/** Confirmation composition: exactly this many of the 400 queries are absence queries. */
export const CONFIRM_EXPECTED_ABSENCE = 80;
/** Prior query groups the confirm corpus must be disjoint from: frozen 44 + sealed pilot 40. */
export const CONFIRM_PRIOR_QUERY_GROUP_COUNT = 84;
/**
 * Preregistered digest of the sealed 40-query pilot manifest
 * (`pilot-manifest.json` under the default pilot root). Every prior-pilot
 * load re-verifies the roster through `loadVerifiedPilotCorpus` and then
 * binds the manifest bytes to this digest, so the confirm disjointness check
 * can never read pilot queries from an unsealed or swapped corpus. Mirrors
 * the `FROZEN_FIXTURE_DIGEST` binding for the frozen 44.
 */
export const CONFIRM_PRIOR_PILOT_MANIFEST_SHA256 =
    "d28e404d4a514d7e09e01d5e49b6a99b6bc14cfc17123b14e2cee031870c370f";
/**
 * Seed for the deterministic 10% agreed-candidate audit selection. Distinct
 * from `PILOT_AUDIT_SAMPLE_SEED` so the confirm audit sample is reproducible
 * from the sealed confirm corpus alone.
 */
export const CONFIRM_AUDIT_SAMPLE_SEED = "method-confirm-audit-10pct-v1";
/** Manifest format version. */
export const CONFIRM_MANIFEST_VERSION = 1;
/** Manifest file name under the confirm data root. */
export const CONFIRM_MANIFEST_SIDECAR_FILE = "confirm-manifest.json";
/** Sidecar file name bound to the manifest bytes: `<manifest name>.sha256`. */
export const CONFIRM_MANIFEST_SIDECAR_PATH = `${CONFIRM_MANIFEST_SIDECAR_FILE}.sha256`;
/** The only ordering rule a sealed confirm manifest may declare. */
export const CONFIRM_ORDER_RULE = "sha256(repo|pin|qid|file|startLine-endLine) ascending, cid ascending tie-break";
/**
 * The exact artifact set a sealed confirm manifest must cover — no missing
 * and no unexpected paths. `allocation.json` (the SOURCES registry) is part
 * of the sealed byte set. The manifest and its sidecar are produced after
 * this set is hashed, so they are deliberately not part of it.
 */
export const CONFIRM_REQUIRED_ARTIFACT_PATHS: readonly string[] = [
    "confirm-queries.jsonl",
    "confirm-candidates.jsonl",
    "confirm-source-snapshots.jsonl",
    "labels-a.jsonl",
    "labels-b.jsonl",
    "adjudications.jsonl",
    "confirm-absence-audits.jsonl",
    "confirm-disjointness.jsonl",
    "confirm-fixture.jsonl",
    "allocation.json",
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
/** Commit-id pins are exact lowercase full SHA-1s; refs, tags, and abbreviations are refused. */
const CONFIRM_PIN = /^[0-9a-f]{40}$/;
/**
 * Repository identifiers are url-safe tokens, optionally `owner/name` with
 * exactly one `/`; each segment starts alphanumeric, so `.`/`..` segments,
 * leading/trailing/double slashes, `\\`, `|` and `:` are refused.
 */
const CONFIRM_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

function sha256Utf8(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Runtime label list. The pilot keeps `isPilotLabel` module-private, so the
 * label vocabulary is restated here against the shared `PilotLabel` type;
 * the assessment/adjudication validators imported from the pilot remain the
 * single spelling of the label rules.
 */
const CONFIRM_LABELS: readonly PilotLabel[] = ["gold", "hard_negative", "easy_negative"];

function isConfirmLabel(value: unknown): value is PilotLabel {
    return typeof value === "string" && (CONFIRM_LABELS as readonly string[]).includes(value);
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

function parseConfirmJsonl<T>(path: string, content: string, validator: (value: unknown) => value is T, label: string): T[] {
    if (content === "") return [];
    if (!content.endsWith("\n")) throw new Error(`confirm artifact ${path} must end with a newline`);
    const rows: T[] = [];
    content.slice(0, -1).split("\n").forEach((line, index) => {
        if (line.trim() === "") throw new Error(`confirm artifact ${path} has a blank line at line ${index + 1}`);
        let value: unknown;
        try {
            value = JSON.parse(line);
        } catch {
            throw new Error(`confirm artifact ${path} has invalid JSON at line ${index + 1}`);
        }
        if (!validator(value)) throw new Error(`invalid ${label} at index ${index} in ${path}`);
        rows.push(value);
    });
    return rows;
}

function readConfirmTextFile(path: string, what: string): string {
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

/* ──────────────────────────────────────────────────────────────────────────
 * 1. Path validity rule (any tracked file at the pin, minus generated shapes)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Lockfiles are never eval sources: their contents are machine-written
 * dependency resolution, not behaviour a query can ask about.
 */
export const CONFIRM_LOCKFILE_BASENAMES: readonly string[] = [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "bun.lock",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "Gemfile.lock",
    "composer.lock",
    "go.sum",
    "flake.lock",
];

/** Vendored trees are third-party snapshots, not authored repository code. */
export const CONFIRM_VENDORED_SEGMENTS: readonly string[] = [
    "node_modules",
    "vendor",
    "third_party",
    "third-party",
];

/** Path segments that mark generated output trees. */
export const CONFIRM_GENERATED_SEGMENTS: readonly string[] = ["__generated__"];

/** Minified artifacts: `*.min.js` / `*.min.css` and bundler `*.bundle.*` outputs. */
const CONFIRM_MINIFIED_BASENAME = /\.(?:min\.[a-z0-9]+|bundle\.[a-z0-9]+)$/;
/**
 * Generated artifacts recognized by shape: compiler/bundler suffixes
 * (`.g.ts`, `.gen.js`), explicit `.generated.*` naming, protobuf outputs
 * (`.pb.*`, `*_pb2*.py`), and source maps (`*.map`). Type declarations
 * (`*.d.ts`, `*.d.cts`) are eligible: a declaration file TRACKED at the pin
 * is hand-authored public API (emitted declarations are build output and
 * not committed). Everything else is eligible; the file must additionally be
 * tracked at the pin as a regular blob (enforced at materialization).
 */
const CONFIRM_GENERATED_BASENAME = /\.(?:g|gen)\.[a-z0-9]+$|\.generated\.[a-z0-9]+$|\.pb\.[a-z0-9]+$|_pb2(?:_grpc)?\.py$|\.map$/;

/**
 * The confirm path rule, replacing the pilot's `src/`|`test/` restriction:
 * a candidate file must be a relative, traversal-free repository path whose
 * basename is not a lockfile, whose segments are not vendored or generated
 * trees, and whose basename is neither minified nor generated by shape.
 * Tracked-at-the-pin validity is a separate property of the sealed registry
 * and is enforced fail-closed when the excerpt materializes (`git show`
 * fails for any path absent from the tree at that pin).
 */
export function isValidConfirmSourcePath(file: string): boolean {
    if (!isNonEmptyString(file)) return false;
    if (isAbsolute(file) || /^[a-zA-Z]:[\\/]/.test(file)) return false;
    const segments = file.split(/[\\/]/);
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
    const basename = segments[segments.length - 1]!;
    if ((CONFIRM_LOCKFILE_BASENAMES as readonly string[]).includes(basename)) return false;
    if (segments.some((segment) => (CONFIRM_VENDORED_SEGMENTS as readonly string[]).includes(segment))) return false;
    if (segments.some((segment) => (CONFIRM_GENERATED_SEGMENTS as readonly string[]).includes(segment))) return false;
    if (CONFIRM_MINIFIED_BASENAME.test(basename)) return false;
    if (CONFIRM_GENERATED_BASENAME.test(basename)) return false;
    return true;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 2. SOURCES registry (sealed allocation.json)
 * ──────────────────────────────────────────────────────────────────────── */

/** One sealed source: a repository, the local git directory used to materialize it, its pin, and its license declaration. */
export interface ConfirmSource {
    repo: string;
    gitDir: string;
    pin: string;
    license: string;
}

export const CONFIRM_SOURCE_KEYS = ["repo", "gitDir", "pin", "license"] as const;
export const CONFIRM_ALLOCATION_KEYS = ["sources"] as const;
/** Descriptive per-source fields the allocation planner records; validated, never used for materialization. */
export const CONFIRM_SOURCE_OPTIONAL_KEYS = ["pinCommitTime", "sizeFiles"] as const;
/** Planner metadata allowed beside `sources` in `allocation.json` (the whole file is sealed byte-for-byte). */
export const CONFIRM_ALLOCATION_OPTIONAL_KEYS = ["version", "createdAt", "composition", "slices"] as const;

/** Every required key present; every present key either required or allowed-optional. */
function hasKeysWithin(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
    const keys = Object.keys(value);
    return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

export function isConfirmSource(value: unknown): value is ConfirmSource {
    if (!isPlainObject(value) || !hasExactKeys(value, CONFIRM_SOURCE_KEYS)) return false;
    return isConfirmSourceFields(value);
}

function isConfirmSourceFields(value: Record<string, unknown>): boolean {
    return isNonEmptyString(value.repo) && CONFIRM_REPO.test(value.repo) &&
        isNonEmptyString(value.gitDir) && isAbsolute(value.gitDir) &&
        isNonEmptyString(value.pin) && CONFIRM_PIN.test(value.pin) &&
        isNonBlankString(value.license);
}

/** A registry entry as written in `allocation.json`: the four sealed fields plus optional planner metadata. */
function isConfirmAllocationEntry(value: unknown): value is ConfirmSource & Record<string, unknown> {
    if (!isPlainObject(value) || !hasKeysWithin(value, CONFIRM_SOURCE_KEYS, CONFIRM_SOURCE_OPTIONAL_KEYS)) return false;
    if ("pinCommitTime" in value && !isInteger(value.pinCommitTime)) return false;
    if ("sizeFiles" in value && !isInteger(value.sizeFiles)) return false;
    return isConfirmSourceFields(value);
}

export interface ConfirmAllocation {
    sources: ConfirmSource[];
}

export function isConfirmAllocation(value: unknown): value is ConfirmAllocation {
    if (!isPlainObject(value) || !hasKeysWithin(value, CONFIRM_ALLOCATION_KEYS, CONFIRM_ALLOCATION_OPTIONAL_KEYS)) return false;
    if (!Array.isArray(value.sources) || value.sources.length === 0) return false;
    if (!value.sources.every((source) => isConfirmAllocationEntry(source))) return false;
    const keys = value.sources.map((source) => `${source.repo}:${source.pin}`);
    return new Set(keys).size === keys.length;
}

/**
 * Parse the sealed SOURCES registry from `allocation.json` bytes. Fail-closed:
 * exact top-level and entry shapes, absolute `gitDir`, full-SHA pins, unique
 * `(repo, pin)` pairs. The registry is the only source of pins and git
 * directories the seal or loader will ever use.
 */
export function parseConfirmAllocation(bytes: string, what: string = "allocation.json"): ConfirmSource[] {
    let value: unknown;
    try {
        value = JSON.parse(bytes);
    } catch {
        throw new Error(`${what} is not valid JSON`);
    }
    if (!isConfirmAllocation(value)) {
        throw new Error(
            `${what} must be {sources:[{repo,gitDir,pin,license[,pinCommitTime,sizeFiles]}][,version,createdAt,composition,slices]} with absolute gitDir, full-SHA pins, and unique (repo,pin) pairs`,
        );
    }
    // Project to the four sealed fields: planner metadata never reaches materialization.
    return value.sources.map(({ repo, gitDir, pin, license }) => ({ repo, gitDir, pin, license }));
}

/** `(repo, pin)` → registry lookup key. Repo identifiers exclude `:` and pins are hex, so the key is unambiguous. */
export function confirmSourceKey(entry: { repo: string; pin: string }): string {
    return `${entry.repo}:${entry.pin}`;
}

/** Canonical sources projection sealed into the manifest: `(repo, pin)` pairs sorted by repo then pin. */
function sourceProjection(sources: readonly ConfirmSource[]): Array<{ repo: string; pin: string }> {
    return sources
        .map((source) => ({ repo: source.repo, pin: source.pin }))
        .sort((left, right) => (left.repo !== right.repo ? (left.repo < right.repo ? -1 : 1) : left.pin < right.pin ? -1 : 1));
}

function sameSourceProjection(left: readonly { repo: string; pin: string }[], right: readonly { repo: string; pin: string }[]): boolean {
    return left.length === right.length && left.every((entry, index) =>
        entry.repo === right[index]!.repo && entry.pin === right[index]!.pin);
}

/* ──────────────────────────────────────────────────────────────────────────
 * 3. Schemas + fail-closed validators
 * ──────────────────────────────────────────────────────────────────────── */

/** Query dossier fields (exact set — foreign keys reject the record). */
export const CONFIRM_QUERY_DOSSIER_KEYS = ["qid", "query", "repo", "pin", "answerable", "slice", "nearestOldQid", "disjointnessNote"] as const;

/**
 * One confirm query. Carries the source it targets (`repo` + `pin` — the
 * same `(repo, pin)` its candidates and absence audit must reference) plus
 * the pilot's per-query disjointness audit fields (`nearestOldQid` must
 * resolve into the 84 prior groups or the advisory flag demands the
 * non-blank `disjointnessNote`).
 */
export interface ConfirmQueryDossier {
    qid: string;
    query: string;
    repo: string;
    pin: string;
    answerable: boolean;
    slice: string;
    nearestOldQid: string;
    disjointnessNote: string;
}

export function isConfirmQueryDossier(value: unknown): value is ConfirmQueryDossier {
    if (!isPlainObject(value) || !hasExactKeys(value, CONFIRM_QUERY_DOSSIER_KEYS)) return false;
    return isNonEmptyString(value.qid) && isNonEmptyString(value.query) &&
        isNonEmptyString(value.repo) && CONFIRM_REPO.test(value.repo) &&
        isNonEmptyString(value.pin) && CONFIRM_PIN.test(value.pin) &&
        isBoolean(value.answerable) && isNonEmptyString(value.slice) &&
        isNonEmptyString(value.nearestOldQid) && isNonBlankString(value.disjointnessNote);
}

/** Candidate dossier fields (exact set — deliberately NO label/why fields). */
export const CONFIRM_CANDIDATE_DOSSIER_KEYS = ["qid", "cid", "repo", "pin", "file", "startLine", "endLine", "symbol"] as const;

/**
 * One candidate source range, label-free by construction and bound to one
 * source. The pilot's 1-based inclusive ≤120-line range rule is reused
 * verbatim; the path rule is the confirm rule from `isValidConfirmSourcePath`.
 */
export interface ConfirmCandidateDossier {
    qid: string;
    cid: string;
    repo: string;
    pin: string;
    file: string;
    startLine: number;
    endLine: number;
    symbol: string | null;
}

export function isConfirmCandidateDossier(value: unknown): value is ConfirmCandidateDossier {
    if (!isPlainObject(value) || !hasExactKeys(value, CONFIRM_CANDIDATE_DOSSIER_KEYS)) return false;
    if (!isNonEmptyString(value.qid) || !isNonEmptyString(value.cid) || !isNonEmptyString(value.file)) return false;
    if (!isNonEmptyString(value.repo) || !CONFIRM_REPO.test(value.repo)) return false;
    if (!isNonEmptyString(value.pin) || !CONFIRM_PIN.test(value.pin)) return false;
    if (value.symbol !== null && !isNonEmptyString(value.symbol)) return false;
    if (!isInteger(value.startLine) || !isInteger(value.endLine)) return false;
    return isValidConfirmSourcePath(value.file) && isValidPilotLineRange(value.startLine, value.endLine);
}

/** Source-snapshot artifact row fields (exact set — no label fields). */
export const CONFIRM_SOURCE_SNAPSHOT_KEYS = ["cid", "excerpt"] as const;

export interface ConfirmSourceSnapshotRow {
    cid: string;
    excerpt: string;
}

export function isConfirmSourceSnapshotRow(value: unknown): value is ConfirmSourceSnapshotRow {
    if (!isPlainObject(value) || !hasExactKeys(value, CONFIRM_SOURCE_SNAPSHOT_KEYS)) return false;
    return isNonEmptyString(value.cid) && isNonEmptyString(value.excerpt);
}

/** Final-fixture artifact row fields (exact set — the sealed per-candidate roster record). */
export const CONFIRM_FIXTURE_ROW_KEYS = ["cid", "qid", "repo", "pin", "file", "startLine", "endLine", "label"] as const;

export interface ConfirmFixtureRow {
    cid: string;
    qid: string;
    repo: string;
    pin: string;
    file: string;
    startLine: number;
    endLine: number;
    label: PilotLabel;
}

export function isConfirmFixtureRow(value: unknown): value is ConfirmFixtureRow {
    if (!isPlainObject(value) || !hasExactKeys(value, CONFIRM_FIXTURE_ROW_KEYS)) return false;
    if (!isNonEmptyString(value.cid) || !isNonEmptyString(value.qid) || !isNonEmptyString(value.file)) return false;
    if (!isNonEmptyString(value.repo) || !CONFIRM_REPO.test(value.repo)) return false;
    if (!isNonEmptyString(value.pin) || !CONFIRM_PIN.test(value.pin)) return false;
    if (!isInteger(value.startLine) || !isInteger(value.endLine)) return false;
    if (!isConfirmLabel(value.label)) return false;
    return isValidConfirmSourcePath(value.file) && isValidPilotLineRange(value.startLine, value.endLine);
}

/** Disjointness artifact row fields (exact set — the per-query audit projection). */
export const CONFIRM_DISJOINTNESS_ROW_KEYS = ["qid", "nearestOldQid", "disjointnessNote"] as const;

export interface ConfirmDisjointnessRow {
    qid: string;
    nearestOldQid: string;
    disjointnessNote: string;
}

export function isConfirmDisjointnessRow(value: unknown): value is ConfirmDisjointnessRow {
    if (!isPlainObject(value) || !hasExactKeys(value, CONFIRM_DISJOINTNESS_ROW_KEYS)) return false;
    return isNonEmptyString(value.qid) && isNonEmptyString(value.nearestOldQid) && isNonBlankString(value.disjointnessNote);
}

/**
 * Query-level absence audit: identical shape and rules to the pilot
 * (`PILOT_ABSENCE_AUDIT_KEYS`, one `confirmed-absent` verdict backed by
 * evidence commands), except the rationale cites searched paths under the
 * confirm path rule instead of the pilot's `src/`|`test/` restriction.
 */
export interface ConfirmAbsenceAudit {
    qid: string;
    auditor: string;
    verdict: typeof PILOT_ABSENCE_VERDICT;
    evidenceCommands: string[];
    rationale: string;
}

/**
 * Does this rationale cite at least one whitespace-delimited path token that
 * passes the confirm path rule? Directory citations (`src/graph`) are
 * legitimate; bare words without a path separator are not.
 */
export function confirmRationaleCitesSearchedPath(rationale: string): boolean {
    return rationale.split(/\s+/).some((raw) => {
        const token = raw.replace(/^[([{]+/, "").replace(/[.,;:)\]}]+$/, "").replace(/\/+$/, "");
        return token.includes("/") && isValidConfirmSourcePath(token);
    });
}

export function isConfirmAbsenceAudit(value: unknown): value is ConfirmAbsenceAudit {
    if (!isPlainObject(value) || !hasExactKeys(value, PILOT_ABSENCE_AUDIT_KEYS)) return false;
    if (!isNonEmptyString(value.qid) || !isNonEmptyString(value.auditor)) return false;
    if (value.verdict !== PILOT_ABSENCE_VERDICT) return false;
    if (!Array.isArray(value.evidenceCommands) || value.evidenceCommands.length === 0) return false;
    if (!value.evidenceCommands.every((command) => isNonEmptyString(command))) return false;
    return isNonBlankString(value.rationale) && confirmRationaleCitesSearchedPath(value.rationale);
}

/* ──────────────────────────────────────────────────────────────────────────
 * 4. Neutral ids + deterministic label-independent ordering
 * ──────────────────────────────────────────────────────────────────────── */

export interface ConfirmCandidateOrderKey {
    repo: string;
    pin: string;
    qid: string;
    file: string;
    startLine: number;
    endLine: number;
}

/** Canonical ordering key: `repo|pin|qid|file|startLine-endLine`. */
export function confirmCandidateOrderKey(key: ConfirmCandidateOrderKey): string {
    if (!isNonEmptyString(key.qid)) throw new Error("candidate order key requires a non-empty qid");
    if (!isNonEmptyString(key.repo) || !CONFIRM_REPO.test(key.repo)) throw new Error(`invalid repo in candidate order key: ${key.repo}`);
    if (!isNonEmptyString(key.pin) || !CONFIRM_PIN.test(key.pin)) throw new Error(`invalid pin in candidate order key: ${key.pin}`);
    if (!isValidConfirmSourcePath(key.file)) throw new Error(`Refusing non-source eval path: ${key.file}`);
    if (!isValidPilotLineRange(key.startLine, key.endLine)) {
        throw new Error(`Invalid pinned source range ${key.file}:${key.startLine}-${key.endLine}`);
    }
    return `${key.repo}|${key.pin}|${key.qid}|${key.file}|${key.startLine}-${key.endLine}`;
}

/** sha256 over the canonical ordering key (lowercase hex). */
export function confirmCandidateOrderHash(key: ConfirmCandidateOrderKey): string {
    return sha256Utf8(confirmCandidateOrderKey(key));
}

/**
 * Neutral, content-derived candidate id: `c` + first 12 hex chars of the
 * ordering hash over `repo|pin|qid|file|range`. Because `repo` and `pin`
 * enter the key, two sources claiming the same file and range can never
 * collide — the pilot's repo-free id would.
 */
export function confirmNeutralCandidateId(key: ConfirmCandidateOrderKey): string {
    return `c${confirmCandidateOrderHash(key).slice(0, 12)}`;
}

/** Stamp neutral ids onto label-free candidate key entries (throws on key collisions). */
export function assignConfirmNeutralCandidateIds<T extends ConfirmCandidateOrderKey>(
    entries: readonly T[],
): Array<T & { cid: string }> {
    const out = entries.map((entry) => ({ ...entry, cid: confirmNeutralCandidateId(entry) }));
    const cids = new Set(out.map((entry) => entry.cid));
    if (cids.size !== out.length) {
        throw new Error("duplicate candidate key (repo|pin|qid|file|range) — each candidate needs a unique range per source");
    }
    return out;
}

/**
 * Deterministic, label-independent ordering: ascending order-hash, ties by
 * cid. Only repo/pin/qid/file/range enter the key, so the order cannot
 * depend on labels — it can never be "gold-first".
 */
export function orderConfirmCandidates<T extends ConfirmCandidateOrderKey & { cid: string }>(candidates: readonly T[]): T[] {
    const cids = new Set(candidates.map((candidate) => candidate.cid));
    if (cids.size !== candidates.length) throw new Error("duplicate candidate cid in ordering input");
    return [...candidates].sort((left, right) => {
        const leftHash = confirmCandidateOrderHash(left);
        const rightHash = confirmCandidateOrderHash(right);
        if (leftHash !== rightHash) return leftHash < rightHash ? -1 : 1;
        if (left.cid !== right.cid) return left.cid < right.cid ? -1 : 1;
        return 0;
    });
}

/* ──────────────────────────────────────────────────────────────────────────
 * 5. Multi-source pinned materialization (byte-equal to the pilot convention)
 * ──────────────────────────────────────────────────────────────────────── */

export interface ConfirmRangeRequest {
    /** Sealed local git directory for the source (from `allocation.json`). */
    gitDir: string;
    /** Sealed commit pin (full lowercase SHA-1). */
    pin: string;
    /** Repository-relative file subject to the confirm path rule. */
    file: string;
    /** 1-based inclusive start line. */
    startLine: number;
    /** 1-based inclusive end line. */
    endLine: number;
    symbol: string | null;
}

/**
 * Materialize one pinned source range with the pilot's frozen excerpt
 * convention: `git --git-dir <gitDir> show <pin>:<file>` under an offline
 * environment (`GIT_ALLOW_PROTOCOL=none` refuses every transport,
 * `GIT_NO_LAZY_FETCH=1` refuses partial-clone lazy fetches), 1-based `line|`
 * prefixes, header `<file>:<start>-<end>[ <symbol>]`, whole-string cap at
 * `PILOT_EXCERPT_CHAR_CAP` (3,500) characters, ranges 1-based inclusive and
 * at most `PILOT_MAX_RANGE_LINES` (120) lines.
 *
 * The formatting is intentionally identical to the pilot's
 * `materializePinnedRange`; `method-confirm-fixture.test.ts` proves
 * byte-equality against it for the Pi-SmartRead source at the frozen pilot
 * pin, which is what licenses the duplicated formatting here (the pilot
 * materializer itself cannot be reused: its `src/`|`test/` path rule and
 * single frozen ref are exactly what this contract generalizes).
 */
export function materializeConfirmPinnedRange(request: ConfirmRangeRequest): string {
    const { gitDir, pin, file, startLine, endLine, symbol } = request;
    if (!isNonEmptyString(gitDir)) throw new Error("materialization requires the source gitDir");
    if (!CONFIRM_PIN.test(pin)) throw new Error(`Refusing non-SHA pin: ${pin}`);
    if (!isValidConfirmSourcePath(file)) {
        throw new Error(`Refusing non-source eval path: ${file}`);
    }
    if (!isValidPilotLineRange(startLine, endLine)) {
        throw new Error(`Invalid pinned source range ${file}:${startLine}-${endLine}`);
    }
    assertRegularPinnedBlob(gitDir, pin, file);
    let source: string;
    try {
        source = execFileSync("git", ["--git-dir", gitDir, "show", `${pin}:${file}`], {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, GIT_ALLOW_PROTOCOL: "none", GIT_NO_LAZY_FETCH: "1" },
        });
    } catch (cause) {
        throw new Error(`git show failed for ${pin}:${file} via ${gitDir}`, { cause });
    }
    const lines = source.split(/\r?\n/);
    if (endLine > lines.length || endLine - startLine + 1 > PILOT_MAX_RANGE_LINES) {
        throw new Error(`Invalid pinned source range ${file}:${startLine}-${endLine}`);
    }
    const code = lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}|${line}`).join("\n");
    return `${file}:${startLine}-${endLine}${symbol ? ` ${symbol}` : ""}\n${code}`.slice(0, PILOT_EXCERPT_CHAR_CAP);
}

/**
 * `git show <pin>:<symlink>` prints the link target path, not file contents,
 * so a tracked symlink (or gitlink) would materialize as a misleading excerpt.
 * Only regular blobs (mode 100644/100755) at the exact path are candidates.
 */
function assertRegularPinnedBlob(gitDir: string, pin: string, file: string): void {
    let entry: string;
    try {
        entry = execFileSync("git", ["--git-dir", gitDir, "ls-tree", "-z", pin, "--", file], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            env: { ...process.env, GIT_ALLOW_PROTOCOL: "none", GIT_NO_LAZY_FETCH: "1" },
        });
    } catch (cause) {
        throw new Error(`git ls-tree failed for ${pin}:${file} via ${gitDir}`, { cause });
    }
    const records = entry.split("\0").filter((record) => record.length > 0);
    // Untracked paths list nothing; `git show` then fails closed with its own error.
    if (records.length === 0) return;
    const match = records.length === 1 ? /^(\d{6}) (\w+) [0-9a-f]+\t(.*)$/s.exec(records[0] ?? "") : null;
    const [, mode, type, path] = match ?? [];
    if (path !== file || type !== "blob" || (mode !== "100644" && mode !== "100755")) {
        throw new Error(`Refusing non-regular pinned file ${pin}:${file} (symlink, gitlink, or tree)`);
    }
}

/* ──────────────────────────────────────────────────────────────────────────
 * 6. Disjointness against all 84 prior query groups + within-corpus dupes
 * ──────────────────────────────────────────────────────────────────────── */

/** One prior query group with its provenance for refusal messages. */
interface PriorQueryGroup extends PilotFrozenQuery {
    origin: "frozen" | "pilot";
}

/**
 * Load ALL 84 prior query groups the confirm corpus must be disjoint from:
 *
 *  - the frozen 44 through `loadFrozenPilotQueries()` (digest-verified
 *    against `FROZEN_FIXTURE_DIGEST` inside the pilot module), and
 *  - the sealed 40-query pilot through `loadVerifiedPilotCorpus()` (full
 *    re-verification) with the pilot manifest bytes bound to the
 *    preregistered `CONFIRM_PRIOR_PILOT_MANIFEST_SHA256`; the query texts
 *    themselves are then read from `pilot-queries.jsonl` only after its
 *    exact bytes verify against the sealed manifest's recorded digest, so
 *    the rows used are provably the sealed rows.
 *
 * Fails closed on any mismatch: unreadable corpora, digest drift, qid
 * collisions across the two sets, or anything other than 84 unique groups.
 * `pilotRoot` defaults to the known sealed pilot data root; the override
 * exists for tests and never bypasses the digest binding.
 */
export function loadConfirmPriorQueryGroups(pilotRoot: string = defaultPilotRoot()): PriorQueryGroup[] {
    const frozen = loadFrozenPilotQueries();
    const roster = loadVerifiedPilotCorpus(pilotRoot);
    const manifestBytes = readConfirmTextFile(join(pilotRoot, PILOT_MANIFEST_SIDECAR_FILE), "prior pilot manifest");
    const manifestSha256 = sha256Utf8(manifestBytes);
    if (manifestSha256 !== CONFIRM_PRIOR_PILOT_MANIFEST_SHA256) {
        throw new Error(
            `prior pilot manifest digest mismatch: expected ${CONFIRM_PRIOR_PILOT_MANIFEST_SHA256}, computed ${manifestSha256}`,
        );
    }
    let manifestValue: unknown;
    try {
        manifestValue = JSON.parse(manifestBytes);
    } catch {
        throw new Error("prior pilot manifest json invalid");
    }
    if (!isPilotManifest(manifestValue)) throw new Error("prior pilot manifest shape invalid");
    const queriesEntry = manifestValue.artifacts.find((entry) => entry.path === "pilot-queries.jsonl");
    if (queriesEntry === undefined) throw new Error("prior pilot manifest does not cover pilot-queries.jsonl");
    const queriesBytes = readConfirmTextFile(join(pilotRoot, "pilot-queries.jsonl"), "prior pilot queries");
    if (sha256Utf8(queriesBytes) !== queriesEntry.sha256 || Buffer.byteLength(queriesBytes, "utf8") !== queriesEntry.byteLength) {
        throw new Error("prior pilot pilot-queries.jsonl digest does not match the sealed manifest");
    }
    const pilotQueries = parseConfirmJsonl("pilot-queries.jsonl", queriesBytes, isPilotQueryDossier, "pilot query dossier");
    if (pilotQueries.length !== roster.queries.length) {
        throw new Error(`prior pilot query count mismatch: roster ${roster.queries.length}, queries ${pilotQueries.length}`);
    }
    const rosterQids = new Set(roster.queries.map((query) => query.qid));
    if (!pilotQueries.every((query) => rosterQids.has(query.qid))) {
        throw new Error("prior pilot pilot-queries.jsonl rows do not match the verified roster qids");
    }
    const combined: PriorQueryGroup[] = [
        ...frozen.map((query) => ({ ...query, origin: "frozen" as const })),
        ...pilotQueries.map((query) => ({ qid: query.qid, query: query.query, origin: "pilot" as const })),
    ];
    const uniqueQids = new Set(combined.map((group) => group.qid));
    if (combined.length !== CONFIRM_PRIOR_QUERY_GROUP_COUNT || uniqueQids.size !== CONFIRM_PRIOR_QUERY_GROUP_COUNT) {
        throw new Error(
            `prior query groups must be exactly ${CONFIRM_PRIOR_QUERY_GROUP_COUNT} unique qids, found ${combined.length} rows / ${uniqueQids.size} unique qids`,
        );
    }
    return combined;
}

/**
 * Within-corpus duplicate detection (run at seal and load): duplicate qids
 * and duplicate query text — exact or after `normalizeQueryText` — inside
 * the confirm corpus are refusals, not advisory flags. Returns every
 * distinct pair once.
 */
export function withinCorpusDuplicateFailures(queries: readonly ConfirmQueryDossier[]): string[] {
    const failures: string[] = [];
    const byQid = new Map<string, ConfirmQueryDossier>();
    const byNormalized = new Map<string, string>();
    for (const query of queries) {
        const prior = byQid.get(query.qid);
        if (prior !== undefined) {
            failures.push(`duplicate confirm qid ${query.qid}`);
            continue;
        }
        byQid.set(query.qid, query);
        const normalized = normalizeQueryText(query.query);
        const duplicateOf = byNormalized.get(normalized);
        if (duplicateOf !== undefined) {
            failures.push(`confirm corpus contains duplicate query text (exact or normalized) for queries ${duplicateOf} and ${query.qid}`);
        } else {
            byNormalized.set(normalized, query.qid);
        }
    }
    return failures;
}

/**
 * Prior-corpus disjointness enforcement, run by both the production seal
 * and `loadVerifiedConfirmCorpus` (mirroring the pilot's
 * `frozenDisjointnessFailures`):
 *
 *  - exact or normalized duplicates of ANY of the 84 prior queries: refused;
 *  - token Jaccard ≥ `NEAR_PARAPHRASE_JACCARD_THRESHOLD` (0.7) against any
 *    prior query: refused;
 *  - advisory `nearest_old_qid_unknown`: requires a trimmed non-empty audit
 *    note on the query (the dossier schema already demands a non-blank
 *    note, so this holds for sealed rows);
 *  - an unreadable prior set (frozen corpus or sealed pilot unavailable,
 *    digest drift): itself a collected failure — no disjointness evidence,
 *    no seal, no load.
 */
function priorFindingFailures(
    finding: PilotDisjointnessFinding,
    originByQid: Map<string, "frozen" | "pilot">,
    queryByQid: Map<string, ConfirmQueryDossier>,
): string[] {
    const originOf = (qid: string | null): string => (qid !== null ? originByQid.get(qid) ?? "?" : "?");
    if (finding.exactDuplicateOf !== null) {
        return [
            `query ${finding.qid} exactly duplicates prior ${originOf(finding.exactDuplicateOf)} query ${finding.exactDuplicateOf}`,
        ];
    }
    if (finding.normalizedDuplicateOf !== null) {
        return [
            `query ${finding.qid} duplicates prior ${originOf(finding.normalizedDuplicateOf)} query ${finding.normalizedDuplicateOf} after normalization`,
        ];
    }
    const failures: string[] = [];
    if (finding.flagReasons.includes("near_paraphrase_jaccard")) {
        failures.push(
            `query ${finding.qid} is a near-paraphrase of prior ${originOf(finding.computedNearestOldQid)} query ` +
                `${finding.computedNearestOldQid} (token Jaccard ${finding.maxTokenJaccard.toFixed(4)} >= ${NEAR_PARAPHRASE_JACCARD_THRESHOLD})`,
        );
    }
    if (finding.flagReasons.includes("nearest_old_qid_unknown")) {
        const note = queryByQid.get(finding.qid)?.disjointnessNote;
        if (typeof note !== "string" || note.trim().length === 0) {
            failures.push(`query ${finding.qid} flags nearest_old_qid_unknown without a non-blank disjointness audit note`);
        }
    }
    return failures;
}

function priorDisjointnessFailures(queries: readonly ConfirmQueryDossier[]): string[] {
    let prior: PriorQueryGroup[];
    try {
        prior = loadConfirmPriorQueryGroups();
    } catch (cause) {
        return [
            `prior ${CONFIRM_PRIOR_QUERY_GROUP_COUNT}-query corpus unavailable for the disjointness check: ` +
                (cause instanceof Error ? cause.message : String(cause)),
        ];
    }
    const originByQid = new Map(prior.map((group) => [group.qid, group.origin]));
    const queryByQid = new Map(queries.map((query) => [query.qid, query]));
    const failures: string[] = [];
    try {
        for (const finding of evaluateQueryDisjointness(queries, prior)) {
            failures.push(...priorFindingFailures(finding, originByQid, queryByQid));
        }
    } catch (cause) {
        failures.push(`prior disjointness check rejected the query set: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return failures;
}

/**
 * Composition enforcement fixed for the confirmation run: exactly
 * `CONFIRM_EXPECTED_QUERY_COUNT` queries = `CONFIRM_EXPECTED_ANSWERABLE`
 * answerable + `CONFIRM_EXPECTED_ABSENCE` absence. Enforced by the
 * production seal and by `loadVerifiedConfirmCorpus`; only the `__test__`
 * seal seam bypasses it — never the 84-group disjointness check.
 */
function confirmCompositionFailures(queries: readonly ConfirmQueryDossier[]): string[] {
    const answerable = queries.filter((query) => query.answerable).length;
    const absence = queries.length - answerable;
    if (queries.length === CONFIRM_EXPECTED_QUERY_COUNT &&
        answerable === CONFIRM_EXPECTED_ANSWERABLE &&
        absence === CONFIRM_EXPECTED_ABSENCE) {
        return [];
    }
    return [
        `confirm corpus composition must be exactly ${CONFIRM_EXPECTED_QUERY_COUNT} queries = ` +
            `${CONFIRM_EXPECTED_ANSWERABLE} answerable + ${CONFIRM_EXPECTED_ABSENCE} absence; found ` +
            `${queries.length} queries = ${answerable} answerable + ${absence} absence`,
    ];
}

/* ──────────────────────────────────────────────────────────────────────────
 * 7. Final acceptance (pilot rules, confirm validators)
 * ──────────────────────────────────────────────────────────────────────── */

export interface ConfirmFinalAcceptanceInput {
    queries: readonly ConfirmQueryDossier[];
    candidates: readonly ConfirmCandidateDossier[];
    /** Both labelers' records; pilot assessment/adjudication validators apply verbatim (they are cid-scoped and path-free). */
    assessments: readonly PilotLabelerAssessment[];
    adjudications: readonly PilotAdjudication[];
    absenceAudits: readonly ConfirmAbsenceAudit[];
    /** Override the audit seed only for tests; production seals the default. */
    auditSampleSeed?: string;
}

export interface ConfirmFinalAcceptanceResult {
    ok: boolean;
    failures: string[];
    finalLabels: Record<string, PilotLabel>;
    auditSampleCids: string[];
}

function indexConfirmDossiers(
    queries: readonly ConfirmQueryDossier[],
    candidates: readonly ConfirmCandidateDossier[],
): { queryByQid: Map<string, ConfirmQueryDossier>; candidateByCid: Map<string, ConfirmCandidateDossier>; failures: string[] } {
    const failures: string[] = [
        ...invalidRecordFailures(queries, isConfirmQueryDossier, "query dossier"),
        ...invalidRecordFailures(candidates, isConfirmCandidateDossier, "candidate dossier"),
    ];
    const queryByQid = new Map<string, ConfirmQueryDossier>();
    for (const query of queries) {
        if (!isConfirmQueryDossier(query)) continue;
        if (queryByQid.has(query.qid)) failures.push(`duplicate query qid ${query.qid}`);
        queryByQid.set(query.qid, query);
    }
    const candidateByCid = new Map<string, ConfirmCandidateDossier>();
    for (const candidate of candidates) {
        if (!isConfirmCandidateDossier(candidate)) continue;
        if (candidateByCid.has(candidate.cid)) failures.push(`duplicate candidate cid ${candidate.cid}`);
        if (!queryByQid.has(candidate.qid)) failures.push(`candidate ${candidate.cid} references unknown qid ${candidate.qid}`);
        if (candidate.cid !== confirmNeutralCandidateId(candidate)) {
            failures.push(`candidate ${candidate.cid} does not use its neutral content-derived id`);
        }
        candidateByCid.set(candidate.cid, candidate);
    }
    return { queryByQid, candidateByCid, failures };
}

type ConfirmAssessmentSlot = Partial<Record<PilotLabeler, PilotLabelerAssessment>>;

function indexConfirmAssessments(
    assessments: readonly PilotLabelerAssessment[],
    candidateByCid: Map<string, ConfirmCandidateDossier>,
): { paired: Map<string, ConfirmAssessmentSlot>; failures: string[] } {
    const failures = invalidRecordFailures(assessments, isPilotLabelerAssessment, "labeler assessment");
    const paired = new Map<string, ConfirmAssessmentSlot>();
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

function indexConfirmAdjudications(
    adjudications: readonly PilotAdjudication[],
    candidateByCid: Map<string, ConfirmCandidateDossier>,
    paired: Map<string, ConfirmAssessmentSlot>,
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

function indexConfirmAbsenceAudits(
    audits: readonly ConfirmAbsenceAudit[],
    queryByQid: Map<string, ConfirmQueryDossier>,
): { auditedQids: Set<string>; failures: string[] } {
    const failures = invalidRecordFailures(audits, isConfirmAbsenceAudit, "absence audit");
    const auditedQids = new Set<string>();
    for (const audit of audits) {
        if (!isConfirmAbsenceAudit(audit)) continue;
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

/** Failures for a candidate whose flags require an adjudication but have none (pilot rule). */
function unresolvedConfirmFlagFailures(
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

function deriveConfirmLabels(
    candidates: readonly ConfirmCandidateDossier[],
    paired: Map<string, ConfirmAssessmentSlot>,
    adjudicationByCid: Map<string, PilotAdjudication>,
): { finalLabels: Record<string, PilotLabel>; agreedCids: string[]; failures: string[] } {
    const failures: string[] = [];
    const finalLabels: Record<string, PilotLabel> = {};
    const agreedCids: string[] = [];
    for (const candidate of candidates) {
        if (!isConfirmCandidateDossier(candidate)) continue;
        const slot = paired.get(candidate.cid) ?? {};
        const a = slot.A;
        const b = slot.B;
        if (a === undefined) failures.push(`candidate ${candidate.cid} has no assessment from labeler A`);
        if (b === undefined) failures.push(`candidate ${candidate.cid} has no assessment from labeler B`);
        if (a === undefined || b === undefined) continue;
        const adjudication = adjudicationByCid.get(candidate.cid);
        const disagreement = a.label !== b.label;
        failures.push(...unresolvedConfirmFlagFailures(candidate.cid, a, b, adjudication));
        if (!disagreement) agreedCids.push(candidate.cid);
        if (adjudication !== undefined) {
            finalLabels[candidate.cid] = adjudication.label;
        } else if (!disagreement) {
            finalLabels[candidate.cid] = a.label;
        }
    }
    return { finalLabels, agreedCids, failures };
}

function confirmCoverageFailures(
    queries: readonly ConfirmQueryDossier[],
    candidates: readonly ConfirmCandidateDossier[],
    finalLabels: Record<string, PilotLabel>,
    auditedQids: ReadonlySet<string>,
): string[] {
    const failures: string[] = [];
    const seenAbsence = new Set<string>();
    for (const query of queries) {
        if (!isConfirmQueryDossier(query)) continue;
        let goldCount = 0;
        for (const candidate of candidates) {
            if (!isConfirmCandidateDossier(candidate) || candidate.qid !== query.qid) continue;
            if (finalLabels[candidate.cid] === "gold") goldCount += 1;
        }
        if (query.answerable && goldCount < 1) failures.push(`answerable query ${query.qid} has no gold candidate`);
        if (!query.answerable && goldCount > 0) failures.push(`absence query ${query.qid} has a gold candidate`);
        if (!query.answerable && !seenAbsence.has(query.qid)) {
            seenAbsence.add(query.qid);
            if (!auditedQids.has(query.qid)) failures.push(`absence query ${query.qid} has no absence audit`);
        }
    }
    return failures;
}

/**
 * The pilot's `verifyFinalAcceptance` rules under confirm validators:
 * every record passes its schema, every candidate carries its neutral
 * content-derived id, exactly one A and one B assessment per candidate with
 * source-cited rationales, at most one adjudication per candidate, every
 * disagreement/ambiguity/invalid-range resolved by a source-cited
 * adjudication whose `reviewedAssessments` match the submitted labels, the
 * deterministic 10% agreed-sample audit set (pilot's
 * `selectAgreedAuditSample`, confirm seed) fully adjudicated, ≥1 gold per
 * answerable query, and 0 gold plus exactly one `confirmed-absent` audit per
 * absence query. Author-proposed labels are deliberately not an input.
 */
export function verifyConfirmFinalAcceptance(input: ConfirmFinalAcceptanceInput): ConfirmFinalAcceptanceResult {
    const { queries, candidates, assessments, adjudications, absenceAudits } = input;
    const dossiers = indexConfirmDossiers(queries, candidates);
    const assessmentIndex = indexConfirmAssessments(assessments, dossiers.candidateByCid);
    const adjudicationIndex = indexConfirmAdjudications(adjudications, dossiers.candidateByCid, assessmentIndex.paired);
    const absenceAuditIndex = indexConfirmAbsenceAudits(absenceAudits, dossiers.queryByQid);
    const labels = deriveConfirmLabels(candidates, assessmentIndex.paired, adjudicationIndex.adjudicationByCid);
    const auditSampleCids = selectAgreedAuditSample(labels.agreedCids, input.auditSampleSeed ?? CONFIRM_AUDIT_SAMPLE_SEED);
    const failures = [
        ...dossiers.failures,
        ...assessmentIndex.failures,
        ...adjudicationIndex.failures,
        ...absenceAuditIndex.failures,
        ...labels.failures,
        ...auditSampleCids
            .filter((cid) => !adjudicationIndex.adjudicationByCid.has(cid))
            .map((cid) => `audit sample candidate ${cid} has no adjudication`),
        ...confirmCoverageFailures(queries, candidates, labels.finalLabels, absenceAuditIndex.auditedQids),
    ];
    return { ok: failures.length === 0, failures, finalLabels: labels.finalLabels, auditSampleCids };
}

/* ──────────────────────────────────────────────────────────────────────────
 * 8. Manifest builder (low-level bytes; production seals via
 *    `sealConfirmCorpusFromRoot`)
 * ──────────────────────────────────────────────────────────────────────── */

export interface ConfirmArtifactInput {
    path: string;
    content: string;
}

export interface ConfirmManifestArtifactEntry {
    path: string;
    sha256: string;
    byteLength: number;
}

export interface ConfirmManifest {
    version: number;
    artifacts: ConfirmManifestArtifactEntry[];
    excerpts: { count: number; digest: string };
    ordering: { rule: string; cids: string[] };
    /** Canonical `(repo, pin)` projection of the sealed SOURCES registry. */
    sources: Array<{ repo: string; pin: string }>;
}

function isValidArtifactPath(path: string): boolean {
    if (!isNonEmptyString(path)) return false;
    if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) return false;
    return !path.split(/[\\/]/).includes("..");
}

function excerptDigest(excerpts: readonly ConfirmSourceSnapshotRow[]): { count: number; digest: string } {
    const lines = excerpts.map((entry) => `${entry.cid}\t${sha256Utf8(entry.excerpt)}`);
    return { count: excerpts.length, digest: sha256Utf8(lines.join("\n")) };
}

/** Hash, validate, and canonically sort the exact required artifact set. */
function buildConfirmManifestArtifacts(artifacts: readonly ConfirmArtifactInput[]): ConfirmManifestArtifactEntry[] {
    const seenPaths = new Set<string>();
    const entries: ConfirmManifestArtifactEntry[] = artifacts.map((artifact) => {
        if (!isValidArtifactPath(artifact.path)) throw new Error(`refusing unsafe artifact path: ${artifact.path}`);
        if (seenPaths.has(artifact.path)) throw new Error(`duplicate artifact path: ${artifact.path}`);
        seenPaths.add(artifact.path);
        return {
            path: artifact.path,
            sha256: sha256Utf8(artifact.content),
            byteLength: Buffer.byteLength(artifact.content, "utf8"),
        };
    });
    const missingPaths = CONFIRM_REQUIRED_ARTIFACT_PATHS.filter((path) => !seenPaths.has(path)).sort();
    const unexpectedPaths = [...seenPaths].filter((path) => !CONFIRM_REQUIRED_ARTIFACT_PATHS.includes(path)).sort();
    if (missingPaths.length > 0 || unexpectedPaths.length > 0) {
        throw new Error(
            `confirm manifest requires the exact artifact set; missing: [${missingPaths.join(", ")}]; unexpected: [${unexpectedPaths.join(", ")}]`,
        );
    }
    return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

interface ConfirmManifestInput {
    artifacts: readonly ConfirmArtifactInput[];
    snapshots: readonly ConfirmSourceSnapshotRow[];
    candidates: readonly ConfirmCandidateDossier[];
    sources: readonly ConfirmSource[];
}

function buildConfirmManifest(input: ConfirmManifestInput): ConfirmManifest {
    if (input.candidates.length === 0) throw new Error("confirm manifest requires at least one candidate");
    const seenCids = new Set<string>();
    for (const candidate of input.candidates) {
        confirmCandidateOrderKey(candidate);
        if (seenCids.has(candidate.cid)) throw new Error(`duplicate candidate cid: ${candidate.cid}`);
        seenCids.add(candidate.cid);
        if (candidate.cid !== confirmNeutralCandidateId(candidate)) {
            throw new Error(`candidate ${candidate.cid} does not use its neutral content-derived id`);
        }
    }
    const canonical = orderConfirmCandidates(input.candidates).map((candidate) => candidate.cid);
    const providedOrder = input.candidates.map((candidate) => candidate.cid);
    if (providedOrder.length !== canonical.length || providedOrder.some((cid, index) => cid !== canonical[index])) {
        throw new Error("candidates must be listed in canonical label-independent order (sha256 of repo|pin|qid|file|range)");
    }
    const excerptOrder = input.snapshots.map((entry) => entry.cid);
    if (excerptOrder.length !== canonical.length || excerptOrder.some((cid, index) => cid !== canonical[index])) {
        throw new Error("excerpts must exactly match candidate neutral ids in canonical label-independent order");
    }
    return {
        version: CONFIRM_MANIFEST_VERSION,
        artifacts: buildConfirmManifestArtifacts(input.artifacts),
        excerpts: excerptDigest(input.snapshots),
        ordering: { rule: CONFIRM_ORDER_RULE, cids: canonical },
        sources: sourceProjection(input.sources),
    };
}

/** Canonical manifest bytes: pretty JSON + trailing newline (deterministic). */
function serializeConfirmManifest(manifest: ConfirmManifest): string {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Sidecar bytes binding the manifest: `<sha256hex>  confirm-manifest.json\n`. */
function confirmManifestSidecar(manifestBytes: string): string {
    return `${sha256Utf8(manifestBytes)}  ${CONFIRM_MANIFEST_SIDECAR_FILE}\n`;
}

function isConfirmManifestArtifact(value: unknown): boolean {
    if (!isPlainObject(value) || !hasExactKeys(value, ["path", "sha256", "byteLength"])) return false;
    if (typeof value.path !== "string" || !isValidArtifactPath(value.path)) return false;
    if (typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256)) return false;
    return isInteger(value.byteLength) && value.byteLength >= 0;
}

function isConfirmManifestExcerpts(value: unknown): boolean {
    if (!isPlainObject(value) || !hasExactKeys(value, ["count", "digest"])) return false;
    if (!isInteger(value.count) || value.count < 0) return false;
    return typeof value.digest === "string" && SHA256_HEX.test(value.digest);
}

function isConfirmManifestOrdering(value: unknown): boolean {
    if (!isPlainObject(value) || !hasExactKeys(value, ["rule", "cids"])) return false;
    if (value.rule !== CONFIRM_ORDER_RULE || !Array.isArray(value.cids)) return false;
    return value.cids.every((cid) => isNonEmptyString(cid));
}

function isConfirmManifestSource(value: unknown): boolean {
    return isPlainObject(value) && hasExactKeys(value, ["repo", "pin"]) &&
        isNonEmptyString(value.repo) && CONFIRM_REPO.test(value.repo) &&
        isNonEmptyString(value.pin) && CONFIRM_PIN.test(value.pin);
}

export function isConfirmManifest(value: unknown): value is ConfirmManifest {
    if (!isPlainObject(value) || !hasExactKeys(value, ["version", "artifacts", "excerpts", "ordering", "sources"])) return false;
    if (value.version !== CONFIRM_MANIFEST_VERSION) return false;
    if (!Array.isArray(value.artifacts) || value.artifacts.length === 0) return false;
    if (!value.artifacts.every((entry) => isConfirmManifestArtifact(entry))) return false;
    if (!isConfirmManifestExcerpts(value.excerpts)) return false;
    if (!isConfirmManifestOrdering(value.ordering)) return false;
    if (!Array.isArray(value.sources)) return false;
    return value.sources.every((entry) => isConfirmManifestSource(entry));
}

/* ──────────────────────────────────────────────────────────────────────────
 * 9. Corpus cross-binding + seal/load (production entry points)
 * ──────────────────────────────────────────────────────────────────────── */

interface ConfirmCorpus {
    sources: ConfirmSource[];
    queries: ConfirmQueryDossier[];
    candidates: ConfirmCandidateDossier[];
    labelsA: PilotLabelerAssessment[];
    labelsB: PilotLabelerAssessment[];
    adjudications: PilotAdjudication[];
    absenceAudits: ConfirmAbsenceAudit[];
    disjointness: ConfirmDisjointnessRow[];
    sourceSnapshots: ConfirmSourceSnapshotRow[];
    fixture: ConfirmFixtureRow[];
}

/** Reads every required artifact file from the root; sealing later hashes these exact bytes. */
function readConfirmArtifacts(root: string): ConfirmArtifactInput[] {
    return CONFIRM_REQUIRED_ARTIFACT_PATHS.map((path) => ({
        path,
        content: readConfirmTextFile(join(root, path), `confirm artifact ${path}`),
    }));
}

/** Parses the exact sealed path set into typed rows; every line must pass its exact-key validator. */
function parseConfirmArtifacts(files: readonly ConfirmArtifactInput[]): ConfirmCorpus {
    const contentByPath = new Map(files.map((file) => [file.path, file.content]));
    const contentOf = (path: string): string => {
        const content = contentByPath.get(path);
        if (content === undefined) throw new Error(`confirm artifact was not read: ${path}`);
        return content;
    };
    const labelsA = parseConfirmJsonl("labels-a.jsonl", contentOf("labels-a.jsonl"), isPilotLabelerAssessment, "labeler assessment");
    const labelsB = parseConfirmJsonl("labels-b.jsonl", contentOf("labels-b.jsonl"), isPilotLabelerAssessment, "labeler assessment");
    labelsA.forEach((assessment, index) => {
        if (assessment.labeler !== "A") throw new Error(`labels-a.jsonl row at index ${index} is from labeler ${assessment.labeler}`);
    });
    labelsB.forEach((assessment, index) => {
        if (assessment.labeler !== "B") throw new Error(`labels-b.jsonl row at index ${index} is from labeler ${assessment.labeler}`);
    });
    return {
        sources: parseConfirmAllocation(contentOf("allocation.json")),
        queries: parseConfirmJsonl("confirm-queries.jsonl", contentOf("confirm-queries.jsonl"), isConfirmQueryDossier, "query dossier"),
        candidates: parseConfirmJsonl("confirm-candidates.jsonl", contentOf("confirm-candidates.jsonl"), isConfirmCandidateDossier, "candidate dossier"),
        labelsA,
        labelsB,
        adjudications: parseConfirmJsonl("adjudications.jsonl", contentOf("adjudications.jsonl"), isPilotAdjudication, "adjudication"),
        absenceAudits: parseConfirmJsonl("confirm-absence-audits.jsonl", contentOf("confirm-absence-audits.jsonl"), isConfirmAbsenceAudit, "absence audit"),
        disjointness: parseConfirmJsonl("confirm-disjointness.jsonl", contentOf("confirm-disjointness.jsonl"), isConfirmDisjointnessRow, "disjointness row"),
        sourceSnapshots: parseConfirmJsonl("confirm-source-snapshots.jsonl", contentOf("confirm-source-snapshots.jsonl"), isConfirmSourceSnapshotRow, "source snapshot row"),
        fixture: parseConfirmJsonl("confirm-fixture.jsonl", contentOf("confirm-fixture.jsonl"), isConfirmFixtureRow, "confirm fixture row"),
    };
}

function disjointnessBindingFailures(corpus: ConfirmCorpus): string[] {
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

/** Every query and candidate must name a sealed `(repo, pin)` source, and a candidate's source must be its query's source. */
function sourcesBindingFailures(corpus: ConfirmCorpus): string[] {
    const failures: string[] = [];
    const registry = new Set(corpus.sources.map((source) => confirmSourceKey(source)));
    const queryByQid = new Map(corpus.queries.map((query) => [query.qid, query]));
    for (const query of corpus.queries) {
        if (!registry.has(confirmSourceKey(query))) {
            failures.push(`query ${query.qid} references unsealed source ${query.repo}@${query.pin}`);
        }
    }
    for (const candidate of corpus.candidates) {
        const query = queryByQid.get(candidate.qid);
        if (query === undefined) continue;
        if (confirmSourceKey(candidate) !== confirmSourceKey(query)) {
            failures.push(`candidate ${candidate.cid} source ${candidate.repo}@${candidate.pin} differs from its query's source ${query.repo}@${query.pin}`);
        }
    }
    return failures;
}

function orderedBindingFailures(
    corpus: ConfirmCorpus,
    canonical: readonly ConfirmCandidateDossier[],
    finalLabels: Record<string, PilotLabel>,
): string[] {
    const failures: string[] = [];
    const canonicalCids = canonical.map((candidate) => candidate.cid);
    const providedCids = corpus.candidates.map((candidate) => candidate.cid);
    if (providedCids.length !== canonicalCids.length || providedCids.some((cid, index) => cid !== canonicalCids[index])) {
        failures.push("confirm-candidates.jsonl must follow canonical label-independent order (sha256 of repo|pin|qid|file|range)");
    }
    if (corpus.sourceSnapshots.length !== canonicalCids.length) {
        failures.push(`confirm-source-snapshots.jsonl has ${corpus.sourceSnapshots.length} rows; expected ${canonicalCids.length}`);
    } else {
        corpus.sourceSnapshots.forEach((row, index) => {
            if (row.cid !== canonicalCids[index]) failures.push(`confirm-source-snapshots.jsonl row ${index} must be candidate ${canonicalCids[index]}`);
        });
    }
    if (corpus.fixture.length !== canonicalCids.length) {
        failures.push(`confirm-fixture.jsonl has ${corpus.fixture.length} rows; expected ${canonicalCids.length}`);
    } else {
        corpus.fixture.forEach((row, index) => {
            const candidate = canonical[index]!;
            if (row.cid !== candidate.cid) {
                failures.push(`confirm-fixture.jsonl row ${index} must be candidate ${candidate.cid}`);
                return;
            }
            if (row.qid !== candidate.qid || row.repo !== candidate.repo || row.pin !== candidate.pin ||
                row.file !== candidate.file || row.startLine !== candidate.startLine || row.endLine !== candidate.endLine) {
                failures.push(`confirm fixture row for candidate ${row.cid} does not match its dossier`);
                return;
            }
            const expected = finalLabels[row.cid];
            if (row.label !== expected) {
                failures.push(`confirm fixture label mismatch for candidate ${row.cid}: fixture ${row.label}, expected ${String(expected)}`);
            }
        });
    }
    return failures;
}

interface ConfirmCorpusValidationOptions {
    /**
     * Enforce the sealed composition (400 = 320 answerable + 80 absence).
     * The production seal and `loadVerifiedConfirmCorpus` always enforce it;
     * only the `__test__` seal seam bypasses composition — the 84-group
     * disjointness check still runs there.
     */
    enforceComposition: boolean;
}

/**
 * Fail-closed cross-binding of every sealed artifact: final acceptance,
 * disjointness rows mirroring their dossiers, sealed-source binding,
 * within-corpus duplicate detection, the 84-prior-group disjointness check
 * (exact/normalized duplicates and near-paraphrases refused, advisory flags
 * noted), the frozen composition when requested, the pilot's label-quality
 * gates, and — in canonical order — the source snapshots and final fixture
 * matching the candidates with fixture labels equal to the
 * adjudicated/agreed labels. Throws with every failure.
 */
function validateConfirmCorpus(corpus: ConfirmCorpus, options: ConfirmCorpusValidationOptions): {
    finalLabels: Record<string, PilotLabel>;
    canonicalCandidates: ConfirmCandidateDossier[];
} {
    const failures: string[] = [];
    const acceptance = verifyConfirmFinalAcceptance({
        queries: corpus.queries,
        candidates: corpus.candidates,
        assessments: [...corpus.labelsA, ...corpus.labelsB],
        adjudications: corpus.adjudications,
        absenceAudits: corpus.absenceAudits,
    });
    failures.push(...acceptance.failures);
    failures.push(...disjointnessBindingFailures(corpus));
    failures.push(...sourcesBindingFailures(corpus));
    failures.push(...withinCorpusDuplicateFailures(corpus.queries));
    failures.push(...priorDisjointnessFailures(corpus.queries));
    if (options.enforceComposition) failures.push(...confirmCompositionFailures(corpus.queries));
    try {
        const gates = evaluateLabelQualityGates([...corpus.labelsA, ...corpus.labelsB]);
        if (!gates.passed) failures.push(...gates.failures.map((failure) => `label-quality gate failed: ${failure}`));
    } catch (cause) {
        failures.push(`label-quality gates rejected the corpus: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    let canonicalCandidates: ConfirmCandidateDossier[] | undefined;
    if (acceptance.ok) {
        try {
            canonicalCandidates = orderConfirmCandidates(corpus.candidates);
        } catch (cause) {
            failures.push(`candidate canonical ordering rejected: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
    }
    if (canonicalCandidates !== undefined) {
        failures.push(...orderedBindingFailures(corpus, canonicalCandidates, acceptance.finalLabels));
    }
    if (failures.length > 0) throw new Error(`confirm corpus rejected: ${failures.join("; ")}`);
    return { finalLabels: acceptance.finalLabels, canonicalCandidates: canonicalCandidates! };
}

/** Every sealed excerpt must be byte-identical to re-materialization of its candidate at its sealed source. */
function assertConfirmExcerptProvenance(
    candidates: readonly ConfirmCandidateDossier[],
    snapshots: readonly ConfirmSourceSnapshotRow[],
    sources: readonly ConfirmSource[],
): void {
    const registry = new Map(sources.map((source) => [confirmSourceKey(source), source]));
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index]!;
        const provided = snapshots[index]!;
        const source = registry.get(confirmSourceKey(candidate));
        if (source === undefined) throw new Error(`candidate ${candidate.cid} references unsealed source ${candidate.repo}@${candidate.pin}`);
        const materialized = materializeConfirmPinnedRange({
            gitDir: source.gitDir,
            pin: candidate.pin,
            file: candidate.file,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            symbol: candidate.symbol,
        });
        if (materialized !== provided.excerpt) {
            throw new Error(
                `excerpt provenance mismatch for candidate ${candidate.cid}: sealed excerpt differs from re-materialization at ${candidate.repo}@${candidate.pin}`,
            );
        }
    }
}

export interface SealedConfirmCorpus {
    manifest: ConfirmManifest;
    manifestBytes: string;
    sidecar: string;
    manifestPath: string;
    sidecarPath: string;
}

/**
 * Unexported seal implementation. The production entry point enforces the
 * frozen composition; only the explicitly named test-only wrapper
 * `__test__sealConfirmCorpusFromRoot` bypasses it — never the 84-group
 * disjointness check, never the provenance pass.
 */
function sealConfirmCorpus(root: string, options: { enforceComposition: boolean }): SealedConfirmCorpus {
    const artifacts = readConfirmArtifacts(root);
    const corpus = parseConfirmArtifacts(artifacts);
    const { canonicalCandidates } = validateConfirmCorpus(corpus, { enforceComposition: options.enforceComposition });
    // Provenance first: every excerpt must re-materialize at its sealed
    // source before any corpus byte is hashed into the manifest.
    assertConfirmExcerptProvenance(canonicalCandidates, corpus.sourceSnapshots, corpus.sources);
    const manifest = buildConfirmManifest({
        artifacts,
        snapshots: corpus.sourceSnapshots,
        candidates: canonicalCandidates,
        sources: corpus.sources,
    });
    const manifestBytes = serializeConfirmManifest(manifest);
    const sidecar = confirmManifestSidecar(manifestBytes);
    const manifestPath = join(root, CONFIRM_MANIFEST_SIDECAR_FILE);
    const sidecarPath = join(root, CONFIRM_MANIFEST_SIDECAR_PATH);
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(sidecarPath, sidecar);
    return { manifest, manifestBytes, sidecar, manifestPath, sidecarPath };
}

/**
 * The ONLY production seal entry point. It takes nothing but the confirm
 * data root: pins and git directories come only from the root's sealed
 * `allocation.json`, so there is no ref override to express (the only way
 * to seal at non-production pins is authoring a test root — the explicitly
 * named `__test__sealConfirmCorpusFromRoot` seam, which bypasses the
 * composition check only). The seal reads every required artifact from the
 * root itself, parses each line with its exact-key validator, cross-binds
 * the corpus (sealed sources, disjointness rows, label-quality gates,
 * `verifyConfirmFinalAcceptance`, within-corpus duplicates, the 84-group
 * disjointness check, the 400/320/80 composition), re-materializes every
 * excerpt at its sealed source, and only then hashes the exact bytes it
 * read and writes `confirm-manifest.json` plus its sidecar. Nothing is
 * written when any validation step fails.
 */
export function sealConfirmCorpusFromRoot(root: string): SealedConfirmCorpus {
    return sealConfirmCorpus(root, { enforceComposition: true });
}

/**
 * Explicitly named test-only seal seam (unexported; exported below as
 * `__test__sealConfirmCorpusFromRoot`): bypasses the composition check only
 * so tests can prove `loadVerifiedConfirmCorpus` re-enforces it — every
 * other validation, including the 84-group disjointness check and excerpt
 * provenance, still runs.
 */
function testSealConfirmCorpusFromRoot(root: string): SealedConfirmCorpus {
    return sealConfirmCorpus(root, { enforceComposition: false });
}

/** Re-verifies the sealed manifest against the on-disk artifacts; digests must match the exact bytes read. */
function verifySealedConfirmArtifactDigests(root: string, manifest: ConfirmManifest): ConfirmArtifactInput[] {
    const artifacts = readConfirmArtifacts(root);
    const entryByPath = new Map(manifest.artifacts.map((entry) => [entry.path, entry]));
    if (entryByPath.size !== artifacts.length) throw new Error("confirm manifest artifact set does not match the required artifact set");
    for (const artifact of artifacts) {
        const entry = entryByPath.get(artifact.path);
        if (entry === undefined) throw new Error(`confirm manifest does not cover artifact ${artifact.path}`);
        const sha256 = sha256Utf8(artifact.content);
        if (sha256 !== entry.sha256 || Buffer.byteLength(artifact.content, "utf8") !== entry.byteLength) {
            throw new Error(`confirm artifact digest mismatch: ${artifact.path}`);
        }
    }
    return artifacts;
}

/** Read-only roster handed to downstream stages after full re-verification. */
export interface ConfirmCorpusRoster {
    readonly queries: readonly { readonly qid: string; readonly repo: string; readonly pin: string; readonly answerable: boolean }[];
    readonly candidates: readonly {
        readonly cid: string;
        readonly qid: string;
        readonly repo: string;
        readonly pin: string;
        readonly file: string;
        readonly startLine: number;
        readonly endLine: number;
        readonly label: PilotLabel;
    }[];
    readonly sources: readonly ConfirmSource[];
    readonly manifestSha256: string;
}

/**
 * Module-private runtime brand: only rosters that completed full
 * re-verification in `loadVerifiedConfirmCorpus` are recorded here. The
 * brand is deliberately a WeakSet outside the public type — structural
 * equality with `ConfirmCorpusRoster` proves nothing on its own.
 */
const verifiedConfirmCorpusRosters = new WeakSet<object>();

/**
 * Runtime brand check for the verified sealed roster: true only for an
 * object branded by `loadVerifiedConfirmCorpus`. A hand-constructed
 * structural roster fails this check even when every field is well-formed.
 */
export function isVerifiedConfirmCorpusRoster(x: unknown): x is ConfirmCorpusRoster {
    return typeof x === "object" && x !== null && verifiedConfirmCorpusRosters.has(x);
}

/**
 * Re-verify a sealed confirm data root and return the typed read-only
 * roster for downstream stages. Re-checks the sidecar against the exact
 * manifest bytes, every artifact digest against the exact bytes on disk
 * (including `allocation.json`), the excerpt digest, the candidate
 * ordering claims, and the manifest's sources projection against the sealed
 * allocation; re-runs the full corpus cross-binding (validators,
 * `verifyConfirmFinalAcceptance`, gates, fixture-label equality), the
 * within-corpus duplicate check, the 84-group disjointness check, and the
 * frozen composition (400 = 320 answerable + 80 absence). Fails closed on
 * the first mismatch; the returned roster carries the runtime brand checked
 * by `isVerifiedConfirmCorpusRoster`.
 */
export function loadVerifiedConfirmCorpus(root: string): ConfirmCorpusRoster {
    const manifestBytes = readConfirmTextFile(join(root, CONFIRM_MANIFEST_SIDECAR_FILE), "confirm manifest");
    const sidecar = readConfirmTextFile(join(root, CONFIRM_MANIFEST_SIDECAR_PATH), "confirm manifest sidecar");
    if (sidecar !== confirmManifestSidecar(manifestBytes)) {
        throw new Error("confirm manifest sidecar mismatch (manifest bytes modified or unsealed)");
    }
    let manifestValue: unknown;
    try {
        manifestValue = JSON.parse(manifestBytes);
    } catch {
        throw new Error("confirm manifest json invalid");
    }
    if (!isConfirmManifest(manifestValue)) throw new Error("confirm manifest shape invalid");
    const artifacts = verifySealedConfirmArtifactDigests(root, manifestValue);
    const corpus = parseConfirmArtifacts(artifacts);
    if (!sameSourceProjection(manifestValue.sources, sourceProjection(corpus.sources))) {
        throw new Error("confirm manifest sources projection does not match allocation.json");
    }
    const { finalLabels, canonicalCandidates } = validateConfirmCorpus(corpus, { enforceComposition: true });
    const snapshotDigest = excerptDigest(corpus.sourceSnapshots);
    if (manifestValue.excerpts.count !== snapshotDigest.count || manifestValue.excerpts.digest !== snapshotDigest.digest) {
        throw new Error("confirm manifest excerpt digest does not match confirm-source-snapshots.jsonl");
    }
    const canonicalCids = canonicalCandidates.map((candidate) => candidate.cid);
    if (manifestValue.ordering.cids.length !== canonicalCids.length ||
        manifestValue.ordering.cids.some((cid, index) => cid !== canonicalCids[index])) {
        throw new Error("confirm manifest ordering does not match the canonical candidate order");
    }
    const queries = corpus.queries.map((query) => Object.freeze({ qid: query.qid, repo: query.repo, pin: query.pin, answerable: query.answerable }));
    const candidates = canonicalCandidates.map((candidate) => Object.freeze({
        cid: candidate.cid,
        qid: candidate.qid,
        repo: candidate.repo,
        pin: candidate.pin,
        file: candidate.file,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        label: finalLabels[candidate.cid]!,
    }));
    const roster: ConfirmCorpusRoster = {
        queries: Object.freeze(queries),
        candidates: Object.freeze(candidates),
        sources: Object.freeze(corpus.sources.map((source) => Object.freeze({ ...source }))),
        manifestSha256: sha256Utf8(manifestBytes),
    };
    Object.freeze(roster);
    verifiedConfirmCorpusRosters.add(roster);
    return roster;
}

/*
 * Test-only export aliases: the seal seam is the only path to a
 * composition bypass; there is no ref-override seam at all — pins come
 * from the root's sealed allocation by contract.
 */
export {
    confirmManifestSidecar as __test__confirmManifestSidecar,
    testSealConfirmCorpusFromRoot as __test__sealConfirmCorpusFromRoot,
    serializeConfirmManifest as __test__serializeConfirmManifest,
};
