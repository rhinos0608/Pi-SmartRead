/**
 * Exposure blacklist for the E15 retrieval holdout freezer.
 *
 * The sealed holdout must be instance-disjoint from every previously
 * exposed instance: pilot, provisional dev31, dev64, holdout32, and
 * superseded freezes (all manifests under the manifests cache plus
 * test fixtures), every instance id present in any
 * `reports/external-grep-*.json` report, and every D46 repo
 * (`d46/repos.json`). Dedupe is by instance id AND by linked
 * issue/patch identity, so the same upstream issue under a different
 * dataset id cannot leak in.
 *
 * This module is pure (no cache reads): callers collect id/repo sets
 * with the `collect*` helpers and then `buildExposureBlacklist`.
 */

export interface BlacklistSources {
    /** Normalized instance ids from every historical manifest/report. */
    instanceIds: Iterable<string>;
    /** Normalized `org/name#number` linked-issue keys (may be empty). */
    issueKeys: Iterable<string>;
    /** Normalized `org/name` D46 repo identities. */
    repos: Iterable<string>;
    /** sha256 patch identities already exposed (may be empty). */
    patchHashes: Iterable<string>;
}

export interface ExposureBlacklist {
    /** Normalized blocked instance ids. */
    instanceIds: Set<string>;
    /** Normalized blocked linked-issue keys. */
    issueKeys: Set<string>;
    /** Normalized blocked repo identities. */
    repos: Set<string>;
    /** Blocked patch sha256 identities. */
    patchHashes: Set<string>;
}

export interface BlacklistCandidate {
    instanceId: string;
    repo: string;
    /** Linked-issue key when known (repo + issue/PR number). */
    issueKey?: string;
    /** sha256 of the fix-patch bytes when known. */
    patchHash?: string;
}

/** `Org/Name` → `org/name`: lowercase, `__`→`/`, trimmed, no `.git`. */
export function normalizeRepo(repo: string): string {
    return repo.trim().replace(/__/g, "/").replace(/\.git$/i, "").toLowerCase();
}

/** Instance ids compare case-insensitively with surrounding whitespace ignored. */
export function normalizeInstanceId(id: string): string {
    return id.trim().toLowerCase();
}

/**
 * Linked-issue key for an instance id. SWE-bench-family ids embed
 * `org__repo-number` (e.g. `axios__axios-4731`); the key is the
 * normalized `org/repo#number`. Ids without that shape fall back to the
 * normalized id itself (still an exact-match dedupe key).
 */
export function issueKeyOfInstanceId(instanceId: string): string {
    const id = normalizeInstanceId(instanceId);
    const match = id.match(/^([a-z0-9._-]+)__([a-z0-9._-]+)-(\d+)$/);
    if (match) return `${match[1]}/${match[2]}#${match[3]}`;
    return id;
}

/** Normalize an explicit `org/name#number` issue key. */
export function normalizeIssueKey(key: string): string {
    const trimmed = key.trim().toLowerCase();
    const hash = trimmed.lastIndexOf("#");
    if (hash < 0) return trimmed;
    return `${normalizeRepo(trimmed.slice(0, hash))}#${trimmed.slice(hash + 1).trim()}`;
}

export function buildExposureBlacklist(sources: BlacklistSources): ExposureBlacklist {
    const instanceIds = new Set<string>();
    for (const id of sources.instanceIds) {
        const norm = normalizeInstanceId(id);
        if (norm) instanceIds.add(norm);
    }
    const issueKeys = new Set<string>();
    for (const id of instanceIds) issueKeys.add(issueKeyOfInstanceId(id));
    for (const key of sources.issueKeys) {
        const norm = normalizeIssueKey(key);
        if (norm) issueKeys.add(norm);
    }
    const repos = new Set<string>();
    for (const repo of sources.repos) {
        const norm = normalizeRepo(repo);
        if (norm) repos.add(norm);
    }
    const patchHashes = new Set<string>();
    for (const hash of sources.patchHashes) {
        const norm = hash.trim().toLowerCase();
        if (norm) patchHashes.add(norm);
    }
    return { instanceIds, issueKeys, repos, patchHashes };
}

export type BlacklistHit = "instance-id" | "issue-key" | "repo" | "patch-hash";

/**
 * Null when the candidate is clean; otherwise the first blocking
 * reason in instance → issue → repo → patch order.
 */
export function blacklistHit(list: ExposureBlacklist, candidate: BlacklistCandidate): BlacklistHit | null {
    if (list.instanceIds.has(normalizeInstanceId(candidate.instanceId))) return "instance-id";
    const key = candidate.issueKey !== undefined
        ? normalizeIssueKey(candidate.issueKey)
        : issueKeyOfInstanceId(candidate.instanceId);
    if (list.issueKeys.has(key)) return "issue-key";
    if (list.repos.has(normalizeRepo(candidate.repo))) return "repo";
    if (candidate.patchHash !== undefined && list.patchHashes.has(candidate.patchHash.trim().toLowerCase())) {
        return "patch-hash";
    }
    return null;
}

// ---------------------------------------------------------------------------
// Disk collectors (thin IO over the pure builder above).
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readJsonFile(path: string): unknown | null {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
        return null;
    }
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Every instance id in a historical manifest: v1 (`pilot`/`dev`/
 * `holdout` id arrays) and v2 (`pilot` id array plus `dev`/`holdout`
 * `{id}` entries).
 */
export function manifestInstanceIds(manifest: unknown): string[] {
    if (typeof manifest !== "object" || manifest === null) return [];
    const record = manifest as Record<string, unknown>;
    const ids: string[] = [...stringArray(record["pilot"]), ...stringArray(record["dev"]), ...stringArray(record["holdout"])];
    for (const key of ["dev", "holdout"]) {
        const entries = record[key];
        if (Array.isArray(entries)) {
            for (const entry of entries) {
                if (typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string") {
                    ids.push((entry as { id: string }).id);
                }
            }
        }
    }
    return ids;
}

/** Every outcome instance id in an external-grep report file. */
export function reportInstanceIds(report: unknown): string[] {
    if (typeof report !== "object" || report === null) return [];
    const outcomes = (report as { outcomes?: unknown }).outcomes;
    if (!Array.isArray(outcomes)) return [];
    const ids: string[] = [];
    for (const outcome of outcomes) {
        if (typeof outcome === "object" && outcome !== null) {
            const id = (outcome as { instanceId?: unknown; id?: unknown }).instanceId
                ?? (outcome as { id?: unknown }).id;
            if (typeof id === "string") ids.push(id);
        }
    }
    return ids;
}

/** Collect manifest ids from every `*.json` file in the given dirs (missing dirs → none). */
export function collectManifestIds(dirs: string[]): { ids: string[]; files: string[] } {
    const ids: string[] = [];
    const files: string[] = [];
    for (const dir of dirs) {
        let names: string[];
        try {
            names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
        } catch {
            continue;
        }
        for (const name of names) {
            const parsed = readJsonFile(join(dir, name));
            if (parsed === null) continue;
            files.push(join(dir, name));
            ids.push(...manifestInstanceIds(parsed));
        }
    }
    return { ids, files };
}

/** Collect outcome instance ids from every `external-grep-*.json` report (missing dir → none). */
export function collectReportIds(reportsDir: string): { ids: string[]; files: string[] } {
    const ids: string[] = [];
    const files: string[] = [];
    let names: string[];
    try {
        names = readdirSync(reportsDir).filter((n) => n.startsWith("external-grep-") && n.endsWith(".json")).sort();
    } catch {
        return { ids, files };
    }
    for (const name of names) {
        const parsed = readJsonFile(join(reportsDir, name));
        if (parsed === null) continue;
        files.push(join(reportsDir, name));
        ids.push(...reportInstanceIds(parsed));
    }
    return { ids, files };
}

/** Load normalized `owner/name` identities from a `d46/repos.json` file (missing/unparseable → none). */
export function loadD46Repos(reposJsonPath: string): string[] {
    if (!existsSync(reposJsonPath)) return [];
    const parsed = readJsonFile(reposJsonPath);
    if (typeof parsed !== "object" || parsed === null) return [];
    const repos = (parsed as { repos?: unknown }).repos;
    if (!Array.isArray(repos)) return [];
    const out: string[] = [];
    for (const repo of repos) {
        if (typeof repo !== "object" || repo === null) continue;
        const { owner, name } = repo as { owner?: unknown; name?: unknown };
        if (typeof owner === "string" && typeof name === "string") out.push(`${owner}/${name}`);
    }
    return out;
}
