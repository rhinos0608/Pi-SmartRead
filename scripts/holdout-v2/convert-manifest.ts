#!/usr/bin/env node
/**
 * Holdout v3 -> v2 manifest converter (retrieval worktree).
 *
 * The sealed retrieval holdout is frozen as a version-3
 * `RetrievalHoldoutManifest` (instance-holdout freezer), while the frozen
 * retrieval harness `scripts/eval/external/grep/run.ts --manifest` loads only
 * version-2 dev/holdout manifests via `loadFrozenManifest`
 * (frozen-manifest.ts:21-38). This converter verifies a v3 manifest fail-closed
 * and emits an equivalent v2 manifest whose `holdout` is exactly the v3
 * SELECTED entries, in v3 order; `dev` is empty and reserves are excluded (the
 * prereg allows no reserve substitution).
 *
 * This file lives OUTSIDE the hashed engine paths (`src/**`,
 * `scripts/eval/**`) so the frozen engine hash stays identical, and it does NOT
 * import from the ergonomics worktree at runtime: the v3 self-sha verification
 * is a minimal port of
 * `/Users/rhinesharar/Pi-SmartRead-ergonomics/scripts/eval/external/grep/freeze-instance-holdout.ts`
 * — `sha256Hex` (:275-277), `computeRetrievalHoldoutSha` (:303-305),
 * `verifyRetrievalHoldoutManifest` (:307-311), manifest/entry shape
 * (:248-273), `RETRIEVAL_HOLDOUT_SEED` (:68).
 *
 * The v2 integrity sha comes from the retrieval worktree's own existing helper
 * `computeDevHoldoutSha` (sampling.ts:430-434); it is imported, never
 * re-implemented.
 *
 * CLI:
 *   node --import tsx scripts/holdout-v2/convert-manifest.ts --in <v3> --out <new path>
 *
 * The CLI prints ONLY the out path, out sha256, entry count, and per-repo
 * counts — never instance ids, issue text, gold, or patches.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalDataset, InstanceLanguage } from "../eval/external/grep/instance.js";
import {
    computeDevHoldoutSha,
    type DevHoldoutDataset,
    type DevHoldoutEntry,
    type DevHoldoutManifest,
} from "../eval/external/grep/sampling.js";

/**
 * Canonical freeze seed (ported from freeze-instance-holdout.ts:68). A v3
 * manifest with any other seed is rejected rather than converted.
 */
export const RETRIEVAL_HOLDOUT_SEED = "external-grep-retrieval-holdout-v1";

/** Datasets `run.ts` loaders can attribute an entry to (instance.ts:11). */
const KNOWN_DATASETS = ["swe-bench-multilingual", "multi-swe-bench"] as const;

/** Language labels allowed by `DevHoldoutEntry` (instance.ts:13). */
const KNOWN_LANGUAGES = ["ts", "js", "mixed"] as const;

/** Full v3 entry shape (ported from freeze-instance-holdout.ts:248-260). */
const V3_ENTRY_FIELDS = [
    "id",
    "repo",
    "baseCommit",
    "dataset",
    "language",
    "goldFiles",
    "issueKey",
    "querySha256",
    "goldSha256",
] as const;

/** v2 entry shape (`DevHoldoutEntry`, sampling.ts:173-180). */
const V2_ENTRY_FIELDS: ReadonlyArray<keyof DevHoldoutEntry> = [
    "id",
    "repo",
    "baseCommit",
    "dataset",
    "language",
    "goldFiles",
];

/**
 * v3 entry fields `run.ts` reads from the manifest itself:
 * split ids (run.ts:299-301), dataset attribution (run.ts:395),
 * repo/baseCommit pinning (run.ts:495, :683). Each must have a
 * `DevHoldoutEntry` counterpart; when it has none, this converter throws
 * instead of guessing (contract: never guess).
 */
const RUN_TS_REQUIRED_V3_FIELDS = ["id", "repo", "baseCommit", "dataset"] as const;

/** v3-only entry fields with no v2 counterpart; dropped and reported, never guessed into the v2 entries. */
const DROPPED_V3_ENTRY_FIELDS = V3_ENTRY_FIELDS.filter(
    (field) => !(V2_ENTRY_FIELDS as ReadonlyArray<string>).includes(field),
);

export interface ConversionReport {
    /** Selected entries carried into the v2 holdout (reserves excluded). */
    entryCount: number;
    /** Reserve entries verified but deliberately excluded. */
    reserveCount: number;
    perRepo: Array<{ repo: string; count: number }>;
    /** sha256 of the raw v3 input bytes. */
    sourceFileSha256: string;
    /** The v3 manifest's own recorded self-sha256 (verified above). */
    v3InternalSha256: string;
    /** sha256 of this converter's source bytes (provenance). */
    converterSha256: string;
    /** v3 entry fields dropped because v2 has no counterpart for them. */
    droppedV3EntryFields: string[];
}

interface VerifiedV3 {
    seed: string;
    datasets: DevHoldoutDataset[];
    entries: V3Entry[];
    reserve: V3Entry[];
    exclusions: Array<{ instanceId: string; stage: string; reason: string }>;
    internalSha256: string;
}

interface V3Entry {
    id: string;
    repo: string;
    baseCommit: string;
    dataset: ExternalDataset;
    language: InstanceLanguage;
    goldFiles: string[];
    issueKey: string;
    querySha256: string;
    goldSha256: string;
}

function sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Ported from freeze-instance-holdout.ts:303-305 (`computeRetrievalHoldoutSha`):
 * sha256 over the manifest JSON minus the recorded `sha256` field, preserving
 * key order.
 */
function computeRetrievalHoldoutSha(manifest: object): string {
    return sha256Hex(JSON.stringify(manifest));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`v3 manifest malformed: ${label} must be a non-empty string`);
    }
    return value;
}

function requireHexSha(value: unknown, label: string): string {
    const text = requireNonEmptyString(value, label);
    if (!/^[0-9a-f]{64}$/.test(text)) {
        throw new Error(`v3 manifest malformed: ${label} must be a sha256 hex digest`);
    }
    return text;
}

function requireStringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`v3 manifest malformed: ${label} must be a non-empty array`);
    }
    return value.map((item, i) => requireNonEmptyString(item, `${label}[${i}]`));
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    const text = requireNonEmptyString(value, label);
    if (!(allowed as readonly string[]).includes(text)) {
        throw new Error(`v3 manifest malformed: ${label} must be one of ${allowed.join("|")} (got ${JSON.stringify(text)})`);
    }
    return text as T;
}

/**
 * Fail-closed v3 verification: version, seed, then the recorded self-sha256
 * against a recomputation (ported verifyRetrievalHoldoutManifest,
 * freeze-instance-holdout.ts:307-311).
 */
function verifyV3Integrity(parsed: Record<string, unknown>): string {
    if (parsed.version !== 3) {
        throw new Error(`v3 manifest version mismatch: expected 3, got ${JSON.stringify(parsed.version)}`);
    }
    if (parsed.seed !== RETRIEVAL_HOLDOUT_SEED) {
        throw new Error(
            `v3 manifest seed mismatch: expected ${JSON.stringify(RETRIEVAL_HOLDOUT_SEED)}, got ${JSON.stringify(parsed.seed)}`,
        );
    }
    const { sha256, ...rest } = parsed;
    const recorded = requireHexSha(sha256, "sha256");
    const recomputed = computeRetrievalHoldoutSha(rest);
    if (recomputed !== recorded) {
        throw new Error("v3 manifest integrity mismatch (sha256): recorded self-sha does not match recomputation");
    }
    return recorded;
}

/**
 * One v3 entry, field-for-field. Unknown entry fields throw (a schema this
 * converter does not know must never be guessed into v2), and every v2
 * counterpart required by `run.ts` is read here, so a missing field fails
 * closed by name instead of being invented.
 */
function verifyEntry(raw: unknown, label: string): V3Entry {
    if (!isPlainObject(raw)) {
        throw new Error(`v3 manifest malformed: ${label} must be an object`);
    }
    for (const key of Object.keys(raw)) {
        if (!(V3_ENTRY_FIELDS as ReadonlyArray<string>).includes(key)) {
            throw new Error(
                `v3 entry field ${key} at ${label} has no v2 counterpart; refusing to guess`,
            );
        }
    }
    return {
        id: requireNonEmptyString(raw.id, `${label}.id`),
        repo: requireNonEmptyString(raw.repo, `${label}.repo`),
        baseCommit: requireNonEmptyString(raw.baseCommit, `${label}.baseCommit`),
        dataset: requireEnum(raw.dataset, KNOWN_DATASETS, `${label}.dataset`),
        language: requireEnum(raw.language, KNOWN_LANGUAGES, `${label}.language`),
        goldFiles: requireStringArray(raw.goldFiles, `${label}.goldFiles`),
        issueKey: requireNonEmptyString(raw.issueKey, `${label}.issueKey`),
        querySha256: requireHexSha(raw.querySha256, `${label}.querySha256`),
        goldSha256: requireHexSha(raw.goldSha256, `${label}.goldSha256`),
    };
}

function verifyEntryList(value: unknown, label: "entries" | "reserve"): V3Entry[] {
    if (!Array.isArray(value)) {
        throw new Error(`v3 manifest malformed: ${label} must be an array`);
    }
    return value.map((raw, i) => verifyEntry(raw, `${label}[${i}]`));
}

function verifyDatasets(value: unknown): DevHoldoutDataset[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("v3 manifest malformed: datasets must be a non-empty array");
    }
    return value.map((raw, i) => {
        if (!isPlainObject(raw)) {
            throw new Error(`v3 manifest malformed: datasets[${i}] must be an object`);
        }
        return {
            name: requireNonEmptyString(raw.name, `datasets[${i}].name`),
            revision: requireNonEmptyString(raw.revision, `datasets[${i}].revision`),
            license: requireNonEmptyString(raw.license, `datasets[${i}].license`),
        };
    });
}

function verifyExclusions(value: unknown): VerifiedV3["exclusions"] {
    if (!Array.isArray(value)) {
        throw new Error("v3 manifest malformed: exclusions must be an array");
    }
    return value.map((raw, i) => {
        if (!isPlainObject(raw)) {
            throw new Error(`v3 manifest malformed: exclusions[${i}] must be an object`);
        }
        return {
            instanceId: requireNonEmptyString(raw.instanceId, `exclusions[${i}].instanceId`),
            stage: requireNonEmptyString(raw.stage, `exclusions[${i}].stage`),
            reason: requireNonEmptyString(raw.reason, `exclusions[${i}].reason`),
        };
    });
}

/** Exact v3 top-level schema (`freeze-instance-holdout.ts:262-273`). */
const V3_TOP_LEVEL_KEYS = [
    "version",
    "seed",
    "requestedSize",
    "createdAt",
    "datasets",
    "blacklist",
    "entries",
    "reserve",
    "exclusions",
    "sha256",
] as const;

const V3_BLACKLIST_COUNT_KEYS = ["instanceIds", "issueKeys", "repos"] as const;

function verifyExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw new Error(`v3 manifest malformed: unknown ${label} key ${key}; refusing to drop it silently`);
        }
    }
    for (const key of allowed) {
        if (!(key in value)) {
            throw new Error(`v3 manifest malformed: missing ${label} key ${key}`);
        }
    }
}

function verifyBlacklist(raw: unknown): void {
    if (!isPlainObject(raw)) {
        throw new Error("v3 manifest malformed: blacklist must be an object");
    }
    verifyExactKeys(raw, [...V3_BLACKLIST_COUNT_KEYS, "sourceFiles"], "blacklist");
    for (const key of V3_BLACKLIST_COUNT_KEYS) {
        const count = raw[key];
        if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
            throw new Error(`v3 manifest malformed: blacklist.${key} must be a non-negative integer`);
        }
    }
    if (!Array.isArray(raw.sourceFiles) || !raw.sourceFiles.every((file) => typeof file === "string")) {
        throw new Error("v3 manifest malformed: blacklist.sourceFiles must be a string array");
    }
}

/** Selected and reserve must be non-empty, well-formed, and id-disjoint. */
function verifyShape(parsed: Record<string, unknown>, internalSha256: string): VerifiedV3 {
    verifyExactKeys(parsed, V3_TOP_LEVEL_KEYS, "top-level");
    if (typeof parsed.requestedSize !== "number" || !Number.isFinite(parsed.requestedSize)) {
        throw new Error("v3 manifest malformed: requestedSize must be a number");
    }
    requireNonEmptyString(parsed.createdAt, "createdAt");
    verifyBlacklist(parsed.blacklist);
    const entries = verifyEntryList(parsed.entries, "entries");
    if (entries.length === 0) {
        throw new Error("v3 manifest malformed: selected entries must be non-empty");
    }
    const reserve = verifyEntryList(parsed.reserve, "reserve");
    const seen = new Set<string>();
    for (const entry of [...entries, ...reserve]) {
        if (seen.has(entry.id)) {
            throw new Error("v3 manifest malformed: duplicate id across selected entries and reserve");
        }
        seen.add(entry.id);
    }
    return {
        seed: requireNonEmptyString(parsed.seed, "seed"),
        datasets: verifyDatasets(parsed.datasets),
        entries,
        reserve,
        exclusions: verifyExclusions(parsed.exclusions),
        internalSha256,
    };
}

/**
 * Map one verified v3 entry to a `DevHoldoutEntry`, field-for-field. Throws
 * when a field `run.ts` needs has no v2 counterpart — never guesses.
 */
function toDevHoldoutEntry(entry: V3Entry): DevHoldoutEntry {
    const mapped: DevHoldoutEntry = {
        id: entry.id,
        repo: entry.repo,
        baseCommit: entry.baseCommit,
        dataset: entry.dataset,
        language: entry.language,
        goldFiles: [...entry.goldFiles],
    };
    for (const field of RUN_TS_REQUIRED_V3_FIELDS) {
        if (!V2_ENTRY_FIELDS.includes(field)) {
            throw new Error(
                `v3 entry field ${field} (required by run.ts) has no v2 DevHoldoutEntry counterpart; refusing to guess`,
            );
        }
        if (mapped[field] === undefined || mapped[field] === "") {
            throw new Error(`v3 entry field ${field} (required by run.ts) did not map to v2; refusing to guess`);
        }
    }
    return mapped;
}

/** sha256 of this converter's own source bytes (provenance in the v2 note). */
export function converterSourceSha256(): string {
    return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
}

function perRepoCounts(entries: DevHoldoutEntry[]): Array<{ repo: string; count: number }> {
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.repo, (counts.get(entry.repo) ?? 0) + 1);
    return [...counts.entries()]
        .map(([repo, count]) => ({ repo, count }))
        .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
}

/**
 * Verify a v3 manifest fail-closed and produce the v2 equivalent:
 * `dev: []`, `holdout` = v3 SELECTED entries in v3 order (reserves excluded),
 * v2 integrity sha from `computeDevHoldoutSha`, provenance in the free-text
 * `holdoutRepoNote`.
 */
export function convertHoldoutV3ToV2(
    v3Bytes: Uint8Array | string,
): { v2: DevHoldoutManifest; report: ConversionReport } {
    const bytes = typeof v3Bytes === "string" ? Buffer.from(v3Bytes, "utf8") : Buffer.from(v3Bytes);
    const sourceFileSha256 = createHash("sha256").update(bytes).digest("hex");
    let parsed: unknown;
    try {
        parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
        throw new Error(`v3 manifest unparseable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isPlainObject(parsed)) {
        throw new Error("v3 manifest malformed: top level must be an object");
    }
    const internalSha256 = verifyV3Integrity(parsed);
    const verified = verifyShape(parsed, internalSha256);
    const holdout = verified.entries.map(toDevHoldoutEntry);
    const perRepo = perRepoCounts(holdout);
    const converterSha256 = converterSourceSha256();

    const holdoutRepoNote =
        `converted from sealed retrieval-holdout v3 by scripts/holdout-v2/convert-manifest.ts: ` +
        `source-v3-file-sha256=${sourceFileSha256} v3-internal-sha256=${internalSha256} ` +
        `converter-sha256=${converterSha256}; holdout=${holdout.length} selected in v3 order ` +
        `across ${perRepo.length} repos, reserve=${verified.reserve.length} excluded ` +
        `(prereg allows no reserve substitution); dev empty`;

    const body: Omit<DevHoldoutManifest, "sha256"> = {
        version: 2,
        seed: verified.seed,
        createdAt: new Date().toISOString(),
        datasets: verified.datasets,
        pilot: [],
        dev: [],
        holdout,
        exclusions: verified.exclusions,
        holdoutRepoNote,
    };
    const v2: DevHoldoutManifest = { ...body, sha256: computeDevHoldoutSha(body) };
    return {
        v2,
        report: {
            entryCount: holdout.length,
            reserveCount: verified.reserve.length,
            perRepo,
            sourceFileSha256,
            v3InternalSha256: internalSha256,
            converterSha256,
            droppedV3EntryFields: [...DROPPED_V3_ENTRY_FIELDS],
        },
    };
}

/**
 * Write the converted v2 manifest: refuses to overwrite (exclusive create,
 * mode 0600). Returns the out path and the sha256 of the written bytes.
 */
export function writeConvertedManifest(
    v2: DevHoldoutManifest,
    outPath: string,
): { outPath: string; fileSha256: string } {
    if (existsSync(outPath)) {
        throw new Error(`refusing to overwrite existing file: ${outPath}`);
    }
    mkdirSync(dirname(outPath), { recursive: true });
    const data = Buffer.from(JSON.stringify(v2, null, 2), "utf8");
    writeFileSync(outPath, data, { flag: "wx", mode: 0o600 });
    return { outPath, fileSha256: createHash("sha256").update(data).digest("hex") };
}

function takeValue(flag: string, argv: string[], index: number): { value: string; next: number } {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return { value, next: index + 1 };
}

export function parseCliArgs(argv: string[]): { inPath: string; outPath: string } {
    let inPath: string | null = null;
    let outPath: string | null = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--in") {
            const { value, next } = takeValue("--in", argv, i);
            inPath = value;
            i = next;
        } else if (arg === "--out") {
            const { value, next } = takeValue("--out", argv, i);
            outPath = value;
            i = next;
        } else {
            throw new Error(`unknown argument: ${arg}`);
        }
    }
    if (inPath === null) throw new Error("missing required --in <v3 manifest>");
    if (outPath === null) throw new Error("missing required --out <new path>");
    return { inPath, outPath };
}

/**
 * CLI entry point. Prints ONLY the out path, out sha256, entry count, and
 * per-repo counts — never instance ids, issue text, gold, or patches.
 */
export function runConvertCli(argv: string[]): void {
    const { inPath, outPath } = parseCliArgs(argv);
    const { v2, report } = convertHoldoutV3ToV2(readFileSync(inPath));
    const written = writeConvertedManifest(v2, outPath);
    process.stdout.write(
        `out: ${written.outPath}\n` +
            `sha256: ${written.fileSha256}\n` +
            `entries: ${report.entryCount}\n` +
            `per-repo: ${report.perRepo.map((r) => `${r.repo}=${r.count}`).join(" ")}\n`,
    );
}

const invokedAsScript = (process.argv[1] ?? "").endsWith("convert-manifest.ts");
if (invokedAsScript) {
    try {
        runConvertCli(process.argv.slice(2));
    } catch (error) {
        console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    }
}
