/**
 * Bounded source-scope enumerator for inspect.
 *
 * Independently testable scope discovery: given a root, enumerate the
 * candidate source universe under explicit resource bounds WITHOUT building
 * a graph, reading file contents, or assuming a precomputed complete list.
 *
 * Traversal contract:
 * - Root is resolved with realpath; every entry is classified with lstat /
 *   Dirent metadata. External symlinks are NEVER followed silently; each one
 *   is recorded as an omitted `symlink-skipped` entry.
 * - Directories are iterated incrementally (`opendir` async iteration), so
 *   enumeration never materializes an unbounded `readdir` array. The only
 *   sort is over the admitted file list, which is bounded by `maxFiles`.
 * - Cancellation is cooperative: `AbortSignal` is checked BEFORE opening
 *   each directory and AFTER finishing it. Pending filesystem calls are NOT
 *   forcibly aborted; a signal racing a blocked call takes effect at the
 *   next check. `signalChecks` counts the checks performed.
 * - `complete` is reported only when traversal actually exhausts the scope
 *   with no unreadable entries and no limit/deadline/cancellation stop.
 *   Limit hits, cancellation, deadline expiry, and read errors yield
 *   `partial` (some files admitted) or `unknown` (nothing usable), always
 *   with an explicit `stopReason`. Absence claims must not be drawn from
 *   `partial`/`unknown` results.
 */
import { opendir, realpath, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";

export interface BoundedScopeLimits {
    /** Maximum directories to open. */
    maxDirs: number;
    /** Maximum directory entries to visit. */
    maxEntries: number;
    /** Maximum descent depth below the root (root = 0). */
    maxDepth: number;
    /** Maximum files to admit. */
    maxFiles: number;
    /** Per-file byte cap; larger files are omitted, traversal continues. */
    maxBytesPerFile: number;
    /** Total admitted-byte cap; exceeding it stops enumeration. */
    maxTotalBytes: number;
}

/**
 * Provisional engineering limits derived from the source-size census, NOT
 * experimentally proven defaults. No budget freeze for graph or
 * selective views may be built on these until measured.
 */
export const DEFAULT_SCOPE_LIMITS: BoundedScopeLimits = {
    maxDirs: 5_000,
    maxEntries: 100_000,
    maxDepth: 25,
    maxFiles: 10_000,
    maxBytesPerFile: 1_000_000,
    maxTotalBytes: 100_000_000,
};

export type ScopeStatus = "complete" | "partial" | "unknown";

export interface ScopeOmission {
    path: string;
    reason:
        | "symlink-skipped"
        | "depth-exceeded"
        | "unreadable"
        | "file-bytes-exceeded"
        | "limit"
        | "cancelled"
        | "deadline"
        | "root-error";
    detail?: string;
}

export interface ScopeFile {
    /** Path relative to the enumeration root, `/`-separated. */
    path: string;
    bytes: number;
}

export interface ScopeResult {
    status: ScopeStatus;
    /** Admitted files, sorted lexicographically (deterministic order). */
    files: ScopeFile[];
    visitedDirs: number;
    visitedEntries: number;
    maxDepthReached: number;
    emittedFiles: number;
    admittedBytes: number;
    omitted: ScopeOmission[];
    wallMs: number;
    deadlineMs: number | undefined;
    signalChecks: number;
    aborted: boolean;
    stopReason?: string;
}

export interface EnumerateScopeOptions {
    limits: BoundedScopeLimits;
    signal?: AbortSignal;
    /** Wall-clock budget in ms from enumeration start. */
    deadlineMs?: number;
}

export interface ScopeCounts {
    files: number;
    bytes: number;
}

export interface AdmissionVerdict {
    admitted: boolean;
    reasons: string[];
}

/**
 * Count admission BEFORE consume: decide whether a known file/byte universe
 * fits the limits without enumerating or reading anything.
 */
export function checkScopeAdmission(counts: ScopeCounts, limits: BoundedScopeLimits): AdmissionVerdict {
    const reasons: string[] = [];
    if (counts.files > limits.maxFiles) {
        reasons.push(`files ${counts.files} exceeds maxFiles ${limits.maxFiles}`);
    }
    if (counts.bytes > limits.maxTotalBytes) {
        reasons.push(`bytes ${counts.bytes} exceeds maxTotalBytes ${limits.maxTotalBytes}`);
    }
    return { admitted: reasons.length === 0, reasons };
}

function checkSignal(signal: AbortSignal | undefined, checks: { n: number }): boolean {
    checks.n += 1;
    return signal?.aborted ?? false;
}

export async function enumerateBoundedScope(
    root: string,
    options: EnumerateScopeOptions,
): Promise<ScopeResult> {
    const { limits, signal, deadlineMs } = options;
    const startedAt = performance.now();
    const checks = { n: 0 };
    const omitted: ScopeOmission[] = [];
    const files: ScopeFile[] = [];
    let visitedDirs = 0;
    let visitedEntries = 0;
    let maxDepthReached = 0;
    let admittedBytes = 0;
    let aborted = false;
    let stopReason: string | undefined;

    const expired = (): boolean =>
        deadlineMs !== undefined && performance.now() - startedAt >= deadlineMs;

    const finish = (
        status: ScopeStatus,
        wallMs: number,
    ): ScopeResult => ({
        status,
        files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        visitedDirs,
        visitedEntries,
        maxDepthReached,
        emittedFiles: files.length,
        admittedBytes,
        omitted,
        wallMs,
        deadlineMs,
        signalChecks: checks.n,
        aborted,
        stopReason,
    });

    // BEFORE-work admission: refusal without touching the tree.
    if (checkSignal(signal, checks)) {
        aborted = true;
        stopReason = "aborted before enumeration started";
        return finish("unknown", performance.now() - startedAt);
    }
    if (expired()) {
        stopReason = "deadline exceeded before enumeration started";
        return finish("unknown", performance.now() - startedAt);
    }

    let canonicalRoot: string;
    try {
        canonicalRoot = await realpath(root);
    } catch (err) {
        omitted.push({
            path: root,
            reason: "root-error",
            detail: err instanceof Error ? err.message : String(err),
        });
        stopReason = `cannot resolve scope root: ${root}`;
        return finish("unknown", performance.now() - startedAt);
    }

    const stack: Array<{ dir: string; depth: number }> = [{ dir: canonicalRoot, depth: 0 }];

    while (stack.length > 0) {
        if (checkSignal(signal, checks)) {
            aborted = true;
            stopReason = "aborted mid-enumeration (cooperative: pending FS calls were not preempted)";
            return finish(files.length > 0 ? "partial" : "unknown", performance.now() - startedAt);
        }
        if (expired()) {
            stopReason = "deadline exceeded mid-enumeration";
            return finish(files.length > 0 ? "partial" : "unknown", performance.now() - startedAt);
        }
        if (visitedDirs >= limits.maxDirs) {
            stopReason = `maxDirs ${limits.maxDirs} reached; scope enumeration itself is bounded`;
            for (const pending of stack) {
                omitted.push({ path: relative(canonicalRoot, pending.dir) || ".", reason: "limit" });
            }
            return finish("partial", performance.now() - startedAt);
        }

        const { dir, depth } = stack.pop() as { dir: string; depth: number };
        maxDepthReached = Math.max(maxDepthReached, depth);
        let handle;
        try {
            handle = await opendir(dir);
        } catch (err) {
            omitted.push({
                path: relative(canonicalRoot, dir) || ".",
                reason: "unreadable",
                detail: err instanceof Error ? err.message : String(err),
            });
            continue;
        }
        visitedDirs += 1;

        try {
            for await (const entry of handle) {
                visitedEntries += 1;
                if (visitedEntries >= limits.maxEntries) {
                    stopReason = `maxEntries ${limits.maxEntries} reached; scope enumeration itself is bounded`;
                    omitted.push({ path: relative(canonicalRoot, dir) || ".", reason: "limit" });
                    return finish("partial", performance.now() - startedAt);
                }
                const rel = relative(canonicalRoot, join(dir, entry.name)) || entry.name;
                const entryDepth = depth + 1;

                if (entry.isSymbolicLink()) {
                    omitted.push({ path: rel, reason: "symlink-skipped" });
                    continue;
                }
                if (entry.isDirectory()) {
                    if (entryDepth > limits.maxDepth) {
                        omitted.push({ path: rel, reason: "depth-exceeded" });
                        continue;
                    }
                    stack.push({ dir: join(dir, entry.name), depth: entryDepth });
                } else if (entry.isFile()) {
                    if (entryDepth > limits.maxDepth) {
                        omitted.push({ path: rel, reason: "depth-exceeded" });
                        continue;
                    }
                    let size: number;
                    try {
                        size = (await lstat(join(dir, entry.name))).size;
                    } catch (err) {
                        omitted.push({
                            path: rel,
                            reason: "unreadable",
                            detail: err instanceof Error ? err.message : String(err),
                        });
                        continue;
                    }
                    if (size > limits.maxBytesPerFile) {
                        omitted.push({ path: rel, reason: "file-bytes-exceeded", detail: `${size}B` });
                        continue;
                    }
                    if (files.length + 1 > limits.maxFiles) {
                        stopReason = `maxFiles ${limits.maxFiles} reached; scope enumeration itself is bounded`;
                        omitted.push({ path: rel, reason: "limit" });
                        return finish("partial", performance.now() - startedAt);
                    }
                    if (admittedBytes + size > limits.maxTotalBytes) {
                        stopReason = `maxTotalBytes ${limits.maxTotalBytes} reached; scope enumeration itself is bounded`;
                        omitted.push({ path: rel, reason: "limit" });
                        return finish("partial", performance.now() - startedAt);
                    }
                    files.push({ path: rel.replace(/\\/g, "/"), bytes: size });
                    admittedBytes += size;
                }
                // Sockets, FIFOs, and other non-file entries are out of the
                // supported source scope and are ignored without omission noise.
            }
        } catch (err) {
            omitted.push({
                path: relative(canonicalRoot, dir) || ".",
                reason: "unreadable",
                detail: err instanceof Error ? err.message : String(err),
            });
            continue;
        } finally {
            await handle.close().catch(() => undefined);
        }

        // AFTER-work check: a signal racing the directory iteration takes
        // effect here (pending FS calls are never forcibly aborted).
        if (checkSignal(signal, checks)) {
            aborted = true;
            stopReason = "aborted mid-enumeration (cooperative: pending FS calls were not preempted)";
            return finish(files.length > 0 ? "partial" : "unknown", performance.now() - startedAt);
        }
    }

    // Traversal finished: `complete` only when the supported scope was
    // actually exhausted. Unreadable entries and depth cutoffs mean part of
    // the scope was not enumerated, so they yield `partial`. Symlink skips
    // and per-file byte admissions are policy, not coverage gaps.
    const hasErrors = omitted.some((o) => o.reason === "unreadable" || o.reason === "root-error" || o.reason === "depth-exceeded");
    return finish(hasErrors ? "partial" : "complete", performance.now() - startedAt);
}
