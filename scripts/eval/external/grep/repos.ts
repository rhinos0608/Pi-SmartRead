/**
 * Repo materialization for the external grep benchmark.
 *
 * Each upstream repo is partially cloned once as a bare repo with
 * --filter=blob:none into ~/.cache/pi-smartread-bench/repos/<org>__<repo>.git.
 * Each instance gets a per-instance snapshot dir via
 * `git --git-dir=<bare> archive <baseCommit>`, so the engine under test
 * searches working-tree files only — no network, no checkout mutation.
 * Every goldFile must exist at base; instances whose gold files do not
 * exist at base are excluded with reason "missing-at-base" and counted.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, readlinkSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep, dirname, basename } from "node:path";
import type { BenchmarkInstance } from "./instance.js";

/** Owner tag for task-owned external benchmark state roots. Stable API for later D46 reuse. */
export const EXTERNAL_STATE_OWNER = "external-grep-v1";

/** Ownership marker filename (lives at the root, OUTSIDE any snapshot). */
export const EXTERNAL_STATE_MARKER = ".smartread-owned-state.json";

/** Schema version for the ownership marker payload. */
export const EXTERNAL_STATE_MARKER_VERSION = 1;

export const EXTERNAL_STATE_ROOT_ENV_VAR = "PI_SMARTREAD_EXTERNAL_STATE_ROOT";

export interface ExternalStatePaths {
    root: string;
    reposDir: string;
    snapshotsDir: string;
    multilingualDir: string;
    multiSweBenchDir: string;
    reportsDir: string;
}

/**
 * Resolve the private state root for an external run: explicit
 * `--state-root` wins, then $PI_SMARTREAD_EXTERNAL_STATE_ROOT, else null
 * (legacy homedir cache mode). Callers must thread the returned root
 * through EVERY writable clone/snapshot/dataset/report path.
 */
export function resolveExternalStateRoot(cliValue: string | null | undefined): string | null {
    if (cliValue !== null && cliValue !== undefined && cliValue.length > 0) return cliValue;
    const env = process.env[EXTERNAL_STATE_ROOT_ENV_VAR];
    if (env !== undefined && env.length > 0) return env;
    return null;
}

/** Physical containment: the PHYSICAL canonical candidate must equal the
 *  physical canonical root or sit under it. resolve()-only prefixes are
 *  NOT sufficient (they mislabel aliased paths as canonical). */
export function assertPathWithinRoot(root: string, candidate: string, label: string): string {
    assertNoSymlinkAncestors(candidate, label);
    const canonicalRoot = physicalCanonical(resolve(root));
    const canonicalCandidate = physicalCanonical(resolve(candidate));
    if (canonicalRoot === null || canonicalCandidate === null) {
        throw new Error(`${label} cannot be canonically contained: ${candidate}`);
    }
    if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(`${canonicalRoot}${sep}`)) {
        throw new Error(`${label} escapes the owned state root: ${candidate}`);
    }
    return canonicalCandidate;
}

/**
 * Resolve a candidate path to its physical (symlink-free) canonical form.
 * Uses realpath of the nearest existing ancestor joined with the
 * unresolved remainder, so non-existent paths still get a canonical
 * physical prefix. Returns null when no existing ancestor can be stated.
 */
function physicalCanonical(p: string): string | null {
    let cursor = p;
    const tail: string[] = [];
    for (;;) {
        try {
            const st = lstatSync(cursor);
            void st;
            break;
        } catch (error) {
            if (!isMissing(error)) {
                throw new Error(`cannot stat path ancestor (fail-closed): ${cursor}: ${(error as Error).message}`);
            }
            const parent = dirname(cursor);
            if (parent === cursor) return null;
            tail.unshift(basename(cursor));
            cursor = parent;
        }
    }
    try {
        return tail.length > 0 ? join(realpathSync(cursor), ...tail) : realpathSync(cursor);
    } catch {
        return null;
    }
}

/** Throw when any EXISTING component of p (or any existing ancestor up to
 *  the filesystem root) is a symlink. Catches whole-ancestor aliases, not
 *  just the nearest parent. */
function assertNoSymlinkAncestors(p: string, what: string): void {
    let cursor = p;
    for (;;) {
        try {
            if (lstatSync(cursor).isSymbolicLink()) {
                throw new Error(`${what} traverses a symlinked ancestor: ${cursor}`);
            }
        } catch (error) {
            if ((error as Error).message.startsWith(`${what} traverses`)) throw error;
            if (!isMissing(error)) {
                throw new Error(`cannot stat ${what} ancestor (fail-closed): ${cursor}: ${(error as Error).message}`);
            }
            // Missing component: keep walking up toward existing ancestors.
        }
        const parent = dirname(cursor);
        if (parent === cursor) return;
        cursor = parent;
    }
}

/** Injectable filesystem boundary for permission enforcement (tests inject
 *  chmod failures to prove fail-closed behavior; production uses node:fs).
 *  mkdirSync is the fresh-root claim seam: tests inject a racing creator to
 *  prove the leaf claim is exclusive, never recursive-adopting. */
export const externalStateFsHooks: {
    chmodSync: typeof chmodSync;
    readdirSync: typeof readdirSync;
    lstatSync: typeof lstatSync;
    mkdirSync: typeof mkdirSync;
} = {
    chmodSync,
    readdirSync,
    lstatSync,
    mkdirSync,
};

/** True only for missing-path errors. Broader I/O errors are bad state,
 *  never absence: they must fail closed, not read as "fresh" or "empty". */
function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Verify the required private mode on POSIX. Throws when the mode is not
 *  exact; permission enforcement is fail-closed, never best-effort. */
function assertPrivateMode(p: string, expected: number, what: string): void {
    if (process.platform === "win32") return;
    const actual = statSync(p).mode & 0o777;
    if (actual !== expected) {
        throw new Error(`${what} has mode ${actual.toString(8)} (want ${expected.toString(8)}): ${p}`);
    }
}

/** Marker payload: root-bound provenance created by THIS campaign. */
interface OwnershipMarker {
    owner: string;
    version: number;
    canonicalRoot: string;
    nonce: string;
    createdAt: string;
}

function readOwnershipMarker(root: string): OwnershipMarker | null {
    const marker = join(root, EXTERNAL_STATE_MARKER);
    let st: ReturnType<typeof lstatSync>;
    try {
        st = lstatSync(marker);
    } catch (error) {
        if (isMissing(error)) return null;
        throw new Error(`foreign-owned state root (unstatable marker): ${root}: ${(error as Error).message}`);
    }
    // The marker must be an exclusive regular file, never a link.
    if (st.isSymbolicLink() || !st.isFile()) return { owner: "foreign-symlinked-marker", version: 0, canonicalRoot: "", nonce: "", createdAt: "" };
    try {
        return JSON.parse(readFileSync(marker, "utf8")) as OwnershipMarker;
    } catch {
        throw new Error(`foreign-owned state root (unreadable marker): ${root}`);
    }
}

/**
 * Claim a fresh private state root (fail-closed). The root must be freshly
 * created by THIS call, or carry existing VALID root-bound provenance
 * (marker owner + version + canonicalRoot + nonce written by a previous
 * claim of this campaign). Pre-existing directories are NEVER adopted for
 * being empty or UID-ours: an existing dir without a valid marker is
 * foreign. The marker is an exclusive mode-0600 regular non-link file at
 * the root, OUTSIDE any snapshot; the 0600 mode is chmod-asserted on EVERY
 * claim, fresh or valid-marker reuse. Managed subdirs are created mode-0700.
 * Before ANY mkdir/open, every existing ancestor (whole chain, not just
 * the nearest) is checked for symlinks and the physical canonical root
 * binds every path. Never deletes anything. Stable minimal structuredRoot
 * API for later D46 reuse.
 */
export function ensureOwnedStateRoot(stateRoot: string): ExternalStatePaths {
    if (stateRoot.length === 0) throw new Error("--state-root requires a value");
    assertNoSymlinkAncestors(resolve(stateRoot), "--state-root");
    // Missing (ENOENT) is the only claimable shape. Broader I/O errors are
    // bad state: they fail closed instead of reading as 'fresh'.
    let preExisted = true;
    try {
        const st = lstatSync(stateRoot);
        if (st.isSymbolicLink()) throw new Error(`--state-root must not be a symlink: ${stateRoot}`);
        if (!st.isDirectory()) throw new Error(`foreign-owned state root (not a directory): ${stateRoot}`);
    } catch (error) {
        if ((error as Error).message.startsWith("--state-root must not be")) throw error;
        if ((error as Error).message.startsWith("foreign-owned state root")) throw error;
        if (!isMissing(error)) {
            throw new Error(`cannot stat --state-root (fail-closed): ${stateRoot}: ${(error as Error).message}`);
        }
        preExisted = false;
    }
    // Creation authority: only a missing root is claimed, and only by THIS
    // program winning a non-recursive EXCLUSIVE mkdir on the leaf. Recursive
    // mkdir would succeed even if another process created the root after the
    // missing check above, falsely marking a foreign root as fresh. Parent
    // dirs are created as needed but never claimed or chmodded; EEXIST on the
    // leaf means the root appeared after the check, so it is pre-existing and
    // must carry a valid ownership marker below. Any other error throws.
    let createdFresh = false;
    if (!preExisted) {
        externalStateFsHooks.mkdirSync(dirname(resolve(stateRoot)), { recursive: true, mode: 0o700 });
        try {
            externalStateFsHooks.mkdirSync(stateRoot, { mode: 0o700 });
            createdFresh = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw new Error(`cannot create --state-root (fail-closed): ${stateRoot}: ${(error as Error).message}`);
            }
        }
    }
    assertNoSymlinkAncestors(resolve(stateRoot), "--state-root");
    const root = realpathSync(stateRoot);
    // Authorize BEFORE any metadata/content mutation: read-only marker proof
    // (regular non-link marker, bound canonical root, nonce) precedes every
    // chmod/mkdir. Foreign roots return here with mode AND content untouched.
    const existing = readOwnershipMarker(root);
    if (existing !== null) {
        if (
            existing.owner !== EXTERNAL_STATE_OWNER ||
            existing.version !== EXTERNAL_STATE_MARKER_VERSION ||
            existing.canonicalRoot !== root ||
            typeof existing.nonce !== "string" ||
            existing.nonce.length < 16
        ) {
            throw new Error(`foreign-owned state root (owner mismatch): ${root}`);
        }
    } else {
        // Fresh-claim only: refuse to adopt a pre-existing directory simply
        // because it is empty. Ask for a fresh root.
        if (!createdFresh) {
            throw new Error(`foreign-owned state root (no ownership marker): ${root}`);
        }
        writeFileSync(
            join(root, EXTERNAL_STATE_MARKER),
            JSON.stringify(
                {
                    owner: EXTERNAL_STATE_OWNER,
                    version: EXTERNAL_STATE_MARKER_VERSION,
                    canonicalRoot: root,
                    nonce: randomBytes(16).toString("hex"),
                    createdAt: new Date().toISOString(),
                } satisfies OwnershipMarker,
                null,
                2,
            ),
            { mode: 0o600, flag: "wx" },
        );
        // The marker chmod+mode assert is deferred until after the managed
        // scan below: no chmod may precede the read-only authority scan.
    }
    const paths: ExternalStatePaths = {
        root,
        reposDir: join(root, "repos"),
        snapshotsDir: join(root, "snapshots"),
        multilingualDir: join(root, "datasets", "swe-bench-multilingual"),
        multiSweBenchDir: join(root, "datasets", "multi-swe-bench"),
        reportsDir: join(root, "reports"),
    };
    // Validate ALL existing managed subtrees read-only BEFORE changing any
    // mode (root, fresh marker, and subtrees included), so a scan failure
    // cannot follow any chmod.
    const managed = [paths.reposDir, paths.snapshotsDir, paths.multilingualDir, paths.multiSweBenchDir, paths.reportsDir];
    for (const dir of managed) validateManagedSubtree(root, dir, "owned subdir", dir === paths.snapshotsDir);
    // Authority established and subtrees scanned. Required privacy of the
    // ownership marker (fresh claim AND valid-marker reuse) and root is
    // fail-closed: chmod failures throw, and each mode is verified, never
    // assumed. Re-lstat immediately before chmod: readOwnershipMarker proved
    // the marker a regular non-link file at authorization time, and
    // chmodSync follows symlinks, so the invariant is re-asserted at the
    // chmod site itself.
    const markerPath = join(root, EXTERNAL_STATE_MARKER);
    let markerStat: ReturnType<typeof lstatSync>;
    try {
        markerStat = externalStateFsHooks.lstatSync(markerPath);
    } catch (error) {
        throw new Error(`cannot stat ownership marker (fail-closed): ${markerPath}: ${(error as Error).message}`);
    }
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
        throw new Error(`foreign-owned state root (marker is not a regular file): ${root}`);
    }
    externalStateFsHooks.chmodSync(markerPath, 0o600);
    assertPrivateMode(markerPath, 0o600, "ownership marker");
    externalStateFsHooks.chmodSync(root, 0o700);
    assertPrivateMode(root, 0o700, "state root");
    for (const dir of managed) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        externalStateFsHooks.chmodSync(assertPathWithinRoot(root, dir, "owned subdir"), 0o700);
        assertPrivateMode(dir, 0o700, "owned subdir");
    }
    return paths;
}

/** How the managed-subtree scan treats symlink entries. `strict` is the
 *  historical rule (any symlink refused); `snapshots-top` is the snapshots
 *  dir itself (direct children are instance roots, so still strict);
 *  `snapshot-content` is a COMPLETED campaign snapshot, where symlinks are
 *  legitimate `git archive` content (owner decision 2026-10-08). */
type ChildScanMode = "strict" | "snapshots-top" | "snapshot-content";

/** A COMPLETED campaign snapshot: a regular (non-link) `.snapshot-commit`
 *  marker whose content is a canonical object id. Only such a directory may
 *  hold symlink CONTENT during later re-claims; every other directory under
 *  `snapshots/` keeps the strict no-symlink rule. Read-only probe. */
function isMarkedSnapshot(dir: string): boolean {
    try {
        const marker = join(dir, SNAPSHOT_COMMIT_MARKER);
        const st = externalStateFsHooks.lstatSync(marker);
        if (st.isSymbolicLink() || !st.isFile()) return false;
        return FULL_OID_PATTERN.test(readFileSync(marker, "utf8").trim());
    } catch {
        return false;
    }
}

/** Refuse when any existing entry under dir (child or deeper) is a symlink.
 *  Hostile-dir guard for every repos/snapshots/datasets/reports subtree,
 *  checked before mkdir/chmod/open/removal under the root. The snapshots
 *  subtree is marker-gated: symlink entries are refused everywhere except
 *  INSIDE a completed (canonical-marked) snapshot, where they are content
 *  that postcheck/listFiles revalidate and never follow on every use. */
function assertNoSymlinkedChildren(dir: string, what: string, mode: ChildScanMode = "strict"): void {
    let entries: string[];
    try {
        entries = externalStateFsHooks.readdirSync(dir);
    } catch (error) {
        if (isMissing(error)) return;
        throw new Error(`cannot scan ${what} (fail-closed): ${dir}: ${(error as Error).message}`);
    }
    for (const entry of entries) {
        const child = join(dir, entry);
        let st: ReturnType<typeof lstatSync>;
        try {
            st = externalStateFsHooks.lstatSync(child);
        } catch (error) {
            throw new Error(`cannot stat ${what} entry (fail-closed): ${child}: ${(error as Error).message}`);
        }
        if (st.isSymbolicLink()) {
            if (mode === "snapshot-content") continue;
            throw new Error(`${what} contains a symlinked entry: ${child}`);
        }
        if (st.isDirectory()) {
            const childMode: ChildScanMode =
                mode === "snapshots-top" ? (isMarkedSnapshot(child) ? "snapshot-content" : "strict") : mode;
            assertNoSymlinkedChildren(child, what, childMode);
        }
    }
}

/** Validate one managed subtree read-only: containment, type, and links.
 *  Runs before ANY mode/content mutation so a refusal changes nothing. */
function validateManagedSubtree(root: string, dir: string, what: string, snapshotsTree = false): void {
    assertNoSymlinkAncestors(dir, what);
    assertPathWithinRoot(root, dir, what);
    let st;
    try {
        st = externalStateFsHooks.lstatSync(dir);
    } catch (error) {
        if (isMissing(error)) return;
        throw new Error(`cannot stat ${what} (fail-closed): ${dir}: ${(error as Error).message}`);
    }
    if (st.isSymbolicLink()) throw new Error(`refuses ${what} through symlink: ${dir}`);
    if (!st.isDirectory()) throw new Error(`foreign-owned ${what} (not a directory): ${dir}`);
    assertNoSymlinkedChildren(dir, what, snapshotsTree ? "snapshots-top" : "strict");
}

/** Canonical owned subdir helpers (state-root mode; legacy fns below stay homedir). */
export function reposDirUnder(stateRoot: string): string {
    return assertPathWithinRoot(stateRoot, join(resolve(stateRoot), "repos"), "reposDir");
}

export function snapshotsDirUnder(stateRoot: string): string {
    return assertPathWithinRoot(stateRoot, join(resolve(stateRoot), "snapshots"), "snapshotsDir");
}

export function bareRepoDirUnder(stateRoot: string, repo: string): string {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`unsafe repo: ${JSON.stringify(repo)}`);
    return assertPathWithinRoot(stateRoot, join(resolve(stateRoot), "repos", `${repo.replace("/", "__")}.git`), "bareRepoDir");
}

export function snapshotDirUnder(stateRoot: string, instanceId: string): string {
    assertSafeInstanceId(instanceId);
    return assertPathWithinRoot(stateRoot, join(resolve(stateRoot), "snapshots", instanceId), "snapshotDir");
}

export function reposDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/repos");
}

export function snapshotsDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/snapshots");
}

export function bareRepoDir(repo: string): string {
    return join(reposDir(), `${repo.replace("/", "__")}.git`);
}

export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Reject dataset ids that could escape the snapshots dir (e.g. '../'). */
export function assertSafeInstanceId(instanceId: string): void {
    if (!INSTANCE_ID_PATTERN.test(instanceId)) {
        throw new Error(`unsafe instance_id: ${JSON.stringify(instanceId)}`);
    }
    const root = resolve(join(snapshotsDir(), instanceId));
    const base = `${resolve(snapshotsDir())}${sep}`;
    if (root !== resolve(snapshotsDir()) && !root.startsWith(base)) {
        throw new Error(`unsafe instance_id: ${JSON.stringify(instanceId)}`);
    }
    // ".." and "." pass the charset but resolve outside/within the base.
    if (instanceId === ".." || instanceId === ".") {
        throw new Error(`unsafe instance_id: ${JSON.stringify(instanceId)}`);
    }
}

export function snapshotDir(instanceId: string): string {
    assertSafeInstanceId(instanceId);
    return join(snapshotsDir(), instanceId);
}

/** Partial bare clone (blob:none); no-op when already cloned.
 * Options: stateRoot scopes the clone under the owned root; offline
 * refuses to clone a missing repo instead of touching the network. */
export function ensureBareClone(repo: string, opts: { stateRoot?: string | null; offline?: boolean } = {}): string {
    const paths = opts.stateRoot ? ensureOwnedStateRoot(opts.stateRoot) : null;
    // Root-derived owned destination: bareRepoDirUnder appends
    // repos/<slug>.git itself, so it takes the state ROOT (not reposDir).
    const dir = opts.stateRoot ? bareRepoDirUnder((paths as ExternalStatePaths).root, repo) : bareRepoDir(repo);
    mkdirSync(opts.stateRoot ? (paths as ExternalStatePaths).reposDir : reposDir(), { recursive: true });
    if (!existsSync(join(dir, "HEAD"))) {
        if (opts.offline) {
            throw new Error(`--offline: missing bare clone for ${repo}; clone once online first`);
        }
        execFileSync("git", ["clone", "--bare", "--filter=blob:none", `https://github.com/${repo}.git`, dir], {
            stdio: "ignore",
            timeout: 590_000,
        });
    }
    return dir;
}

/** Completion marker filename: exclusive regular file written ONLY after a
 *  fully validated extraction. Never present on an incomplete snapshot. */
export const SNAPSHOT_COMMIT_MARKER = ".snapshot-commit";

/**
 * List the reachable file paths under root as normalized `/`-relative names
 * (excludes `.git` and the completion marker), for gold-presence checks.
 * Never follows symlinks (lstat only). A symlink entry is listed as a leaf
 * file path only when legacy `listFilesLegacy` would have listed it as a
 * non-directory entry — i.e. it resolves to an in-tree file — or when it is
 * dangling (legacy threw ENOENT there; owner decision 2026-10-08 allows
 * dangling in-tree links and the path exists at base, so it is listed).
 * A link resolving to an in-tree DIRECTORY was walked by legacy *through*
 * the link; owned listing refuses to follow, so nothing is listed under it
 * (documented parity rule — entries under the link's real path remain
 * listed normally). Escaping links refuse the whole listing.
 */
function listFiles(root: string): Set<string> {
    const realRoot = realpathSync(root);
    const out = new Set<string>();
    // TOCTOU narrowing (blocking-review P1-2): the entry loop lstat's a
    // path and recursion reopens it with readdir, so a same-UID mover that
    // swaps the path to a symlink between those calls could enumerate an
    // external directory THROUGH the link. Every walk therefore re-lstats
    // the directory immediately AFTER readdirSync and requires the same
    // dev+ino, still a directory, and never a symlink — on any mismatch
    // the just-enumerated names are discarded and the walk throws
    // fail-closed (nothing is ever returned to the caller). NOT CLAIMED:
    // an active same-UID mover racing INSIDE the readdir syscall itself —
    // consistent with the existing POSIX no-claim (lstat-based checks
    // cannot order against a mover with our own UID). This shrinks the
    // window to that claim; every swap detected at the verification point
    // fails closed.
    const walk = (dir: string, before: Stats): void => {
        const names = externalStateFsHooks.readdirSync(dir);
        let after: Stats;
        try {
            after = externalStateFsHooks.lstatSync(dir);
        } catch (error) {
            throw new Error(`refuses-unsafe-entry: snapshot dir unstattable after listing (fail-closed): ${dir}: ${(error as Error).message}`);
        }
        if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
            throw new Error(`refuses-unsafe-entry: snapshot dir swapped during listing (fail-closed): ${dir}`);
        }
        for (const name of names.sort()) {
            if (name === ".git") continue;
            if (name === SNAPSHOT_COMMIT_MARKER) continue;
            const full = join(dir, name);
            // lstat, never stat: traversal must not follow symlinks. Links
            // are validated by `extractedLinkDisposition` and either listed
            // as leaf entries or skipped (in-tree directory links), never
            // expanded; escaping links are refused.
            const st = externalStateFsHooks.lstatSync(full);
            if (st.isSymbolicLink()) {
                if (extractedLinkDisposition(root, realRoot, full) === "entry") {
                    out.add(relative(root, full).split(sep).join("/"));
                }
            } else if (st.isDirectory()) walk(full, st);
            else if (st.isFile()) out.add(relative(root, full).split(sep).join("/"));
            else {
                throw new Error(`refuses-unsafe-entry: non-regular file in snapshot: ${relative(root, full)}`);
            }
        }
    };
    let rootStat: Stats;
    try {
        rootStat = externalStateFsHooks.lstatSync(root);
    } catch (error) {
        throw new Error(`refuses-unsafe-entry: cannot stat snapshot root (fail-closed): ${root}: ${(error as Error).message}`);
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error(`refuses-unsafe-entry: snapshot root is not a directory: ${root}`);
    }
    walk(root, rootStat);
    return out;
}

export { listFiles as listSnapshotFiles };

function listFilesLegacy(root: string): Set<string> {
    const out = new Set<string>();
    const walk = (dir: string): void => {
        for (const name of readdirSync(dir).sort()) {
            if (name === ".git") continue;
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else out.add(relative(root, full).split(sep).join("/"));
        }
    };
    walk(root);
    return out;
}

/** Legacy (non-owned) materialization result shapes, frozen for the legacy
 *  cache paths. Owned mode returns MaterializeResult instead. */
export type LegacyMaterializeResult = { root: string } | { excluded: true; reason: string; missing: string[] };

/**
 * Legacy (non-owned) materialization: historical behavior preserved exactly
 * (throwing errors, rmSync recreate, non-exclusive marker, legacy result
 * shapes) for the pre-owned cache paths. Stage 2 strictness applies to
 * owned mode only.
 */
function materializeLegacyInstance(instance: BenchmarkInstance, bare: string, root: string): LegacyMaterializeResult {
    assertNoSymlinkAncestors(root, "snapshot root");
    try {
        if (lstatSync(root).isSymbolicLink()) throw new Error(`refuses-symlink-snapshot: ${root}`);
    } catch (error) {
        if ((error as Error).message.startsWith("refuses-symlink-snapshot")) throw error;
    }
    const marker = join(root, ".snapshot-commit");
    if (existsSync(marker)) {
        try {
            const mst = lstatSync(marker);
            if (mst.isSymbolicLink() || !mst.isFile()) {
                throw new Error(`refuses-unowned-snapshot: snapshot marker is not a regular file: ${marker}`);
            }
        } catch (error) {
            if ((error as Error).message.startsWith("refuses-unowned-snapshot")) throw error;
            throw new Error(`refuses-unowned-snapshot: cannot stat snapshot marker: ${marker}`);
        }
        const prior = readFileSync(marker, "utf8").trim();
        if (prior !== instance.baseCommit) {
            throw new Error(
                `refuses-mismatched-snapshot: ${root} pins ${prior.slice(0, 12) || "unknown"} ` +
                    `(want ${instance.baseCommit.slice(0, 12)}); snapshot retained, use a fresh --state-root`,
            );
        }
        const files = listFilesLegacy(root);
        const missing = instance.goldFiles.filter((f) => !files.has(f));
        if (missing.length > 0) return { excluded: true, reason: "missing-at-base", missing };
        return { root };
    }
    if (existsSync(root) && !existsSync(marker)) {
        let entries: string[];
        try {
            entries = readdirSync(root);
        } catch {
            throw new Error(`refuses-unowned-snapshot: cannot list ${root}`);
        }
        if (entries.length > 0) {
            throw new Error(`refuses-unowned-snapshot: ${root} has files but no snapshot marker`);
        }
    }
    const archive: Buffer = execFileSync("git", ["--git-dir", bare, "archive", instance.baseCommit], {
        maxBuffer: 1024 * 1024 * 1024,
    });
    assertNoSymlinkAncestors(root, "snapshot root");
    // An existing root here is empty and unmarked (checked above): reuse it
    // in place rather than deleting state this run cannot prove it owns.
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stageDir = tempSnapshotRoot("ext-grep-archive-");
    try {
        const tmpArchive = join(stageDir, "archive.tar");
        writeFileSync(tmpArchive, archive);
        execFileSync("tar", ["-xf", tmpArchive, "-C", root]);
    } finally {
        rmSync(stageDir, { recursive: true, force: true });
    }
    assertNoSymlinkAncestors(marker, "snapshot marker");
    writeFileSync(marker, instance.baseCommit, { mode: 0o600 });
    const files = listFilesLegacy(root);
    const missing = instance.goldFiles.filter((f) => !files.has(f));
    if (missing.length > 0) {
        return { excluded: true, reason: "missing-at-base", missing };
    }
    return { root };
}

/** Completed stage of an owned snapshot attempt, for precise receipts. */
export type SnapshotStage = "preflight" | "archive" | "extract" | "postcheck" | "marker" | "gold-check" | "cleanup-temp";

export interface SnapshotSuccess {
    root: string;
    createdFresh: boolean;
    /** Owner decision (2026-10-08): preflight tree-shape counts, once
     *  preflight succeeded (absent when preflight itself failed or the
     *  snapshot was reused without a preflight). */
    preflightCounts?: SnapshotTreeCounts;
}

export interface SnapshotExclusion {
    excluded: true;
    reason: string;
    missing: string[];
    root: string;
    createdFresh: boolean;
    preflightCounts?: SnapshotTreeCounts;
}

export interface SnapshotFailure {
    failed: true;
    root: string;
    createdFresh: boolean;
    completedStage: SnapshotStage;
    error: string;
    preflightCounts?: SnapshotTreeCounts;
}

export type MaterializeResult = SnapshotSuccess | SnapshotExclusion | SnapshotFailure;

/** One parsed `git ls-tree -z -r -t` record (path keeps tabs/newlines via NUL split).
 *  `oid` is the record's object id — required to read a symlink's target blob. */
export interface SnapshotTreeRecord {
    mode: string;
    kind: string;
    path: string;
    oid?: string;
}

/** Owner decision (2026-10-08): preflight receipt counts for the two
 *  accepted archive shapes — safe in-tree symlinks and gitlink
 *  empty-directory placeholders — recorded on materialization receipts. */
export interface SnapshotTreeCounts {
    symlinks: number;
    gitlinks: number;
}

/** Extracted-entry kind expected at one tree position after `git archive`
 *  extraction. */
export type SnapshotTreeEntryKind = "file" | "dir" | "symlink";

/** Expected post-extraction inventory: every tree position (record paths
 *  plus every ancestor directory) mapped to the entry type extraction
 *  must produce. Post-extract verification compares the real extracted
 *  entries against this on EVERY platform, so an entry collapse preflight
 *  could not refuse (case-/normalization-insensitive extraction outside
 *  the darwin/win32 preflight gate) fails closed instead of silently
 *  losing data. */
export type SnapshotTreeInventory = Map<string, SnapshotTreeEntryKind>;

/** Result of one source-tree preflight: the pinned canonical sha, the
 *  tree-shape counts, and the expected extraction inventory. */
export interface SnapshotTreePreflight {
    canonical: string;
    counts: SnapshotTreeCounts;
    inventory: SnapshotTreeInventory;
}

const SNAPSHOT_TREE_FILE_MODES = new Set(["100644", "100755"]);

/** Canonical full-length object id (40-hex sha1 or 64-hex sha256). */
const FULL_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Owner decision (2026-10-08): snapshots keep `git archive` symlink (120000)
 *  and gitlink (160000) shapes. Symlink chains resolve over the tree records
 *  with this hop bound; exceeding it means a cycle or absurd depth (refuse). */
const SYMLINK_CHAIN_MAX_HOPS = 40;
const WIN_RESERVED_BASENAMES = new Set([
    "con", "prn", "aux", "nul",
    "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
    "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/** Test seam for the git >= 2.44 GIT_NO_LAZY_FETCH probe: tests force the
 *  pre-2.44 path (null = probe the real git) so the offline transport block
 *  is proven version-independent on every installed git, not just >= 2.44. */
export const externalGitEnvHooks: { supportsNoLazyFetch: (() => boolean) | null } = { supportsNoLazyFetch: null };

/** git >= 2.44 honors GIT_NO_LAZY_FETCH (refuse in-process promisor fetches);
 *  older gits ignore it. Probed once per process; the seam above overrides
 *  the probe result (checked first) for tests. */
let noLazyFetchSupported: boolean | null = null;
export function gitSupportsNoLazyFetch(): boolean {
    const override = externalGitEnvHooks.supportsNoLazyFetch;
    if (override !== null) return override();
    if (noLazyFetchSupported !== null) return noLazyFetchSupported;
    try {
        const out = (execFileSync("git", ["--version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }) as string).trim();
        const m = /git version (\d+)\.(\d+)/.exec(out);
        noLazyFetchSupported = m !== null && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 44));
    } catch {
        noLazyFetchSupported = false;
    }
    return noLazyFetchSupported;
}

/** Sentinel GIT_ALLOW_PROTOCOL value for offline reads. Per git(1), a set
 *  GIT_ALLOW_PROTOCOL behaves as `protocol.allow=never` plus `always` for
 *  each listed name, so a name no real transport uses (file/http/https/git/
 *  ssh/ext) blocks EVERY transport while local --git-dir reads keep working.
 *  Verified empirically on git 2.54 with GIT_NO_LAZY_FETCH unset: offline
 *  archive of a reachable file:// promisor fails `transport 'file' not
 *  allowed` and hydrates nothing (batch-all-objects still lacks the blob),
 *  while rev-parse/ls-tree and archive of fully-local objects exit 0.
 *  Deliberately non-empty: an empty value's interpretation as "set" has varied
 *  across git versions, a sentinel never does. */
export const OFFLINE_GIT_ALLOW_PROTOCOL = "none";

/** No-network git environment for metadata/archive reads. Offline owned
 *  operations are pure local --git-dir reads, so ALL transports are blocked
 *  version-independently via OFFLINE_GIT_ALLOW_PROTOCOL: a reachable local
 *  promisor can never be contacted, even on gits too old for
 *  GIT_NO_LAZY_FETCH (kept as a second layer when supported). HTTP/SSH
 *  prompts stay disabled. Touches no HOME/auth-store variables. */
function offlineGitEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: OFFLINE_GIT_ALLOW_PROTOCOL, GIT_SSH_COMMAND: "false" };
    // The env builder fully owns this knob: set only when honored, absent
    // otherwise, so a forced pre-2.44 path (seam) is hermetic for tests.
    if (gitSupportsNoLazyFetch()) env.GIT_NO_LAZY_FETCH = "1";
    else delete env.GIT_NO_LAZY_FETCH;
    return env;
}

/** Owned-mode archive environment: offline keeps the fail-loud no-network
 *  contract above; online may lazy-fetch the blobs a blob:none clone omitted
 *  (archive needs them), over https/file only and never prompting. */
function ownedArchiveGitEnv(offline: boolean | undefined): NodeJS.ProcessEnv {
    if (offline) return offlineGitEnv();
    return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https:file", GIT_SSH_COMMAND: "false" };
}

function snapshotTreeAncestors(path: string): string[] {
    const parts = path.split("/");
    const out: string[] = [];
    for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
    return out;
}

/** Win32-only component rules shared by tree paths and symlink targets.
 *  Backslash is a separator on win32, `:` opens drive/ADS forms; reserved
 *  device names and trailing space/dot are silently rewritten by the
 *  platform. `.`/`..` are handled by callers (legal in link targets). */
function assertWin32TreeComponent(part: string, label: string): void {
    if (
        part.includes("\\") || part.includes(":") || /[*?<>|]/.test(part) ||
        part.endsWith(" ") || part.endsWith(".") ||
        WIN_RESERVED_BASENAMES.has(part.split(".")[0]?.toLowerCase() ?? "")
    ) {
        throw new Error(`refuses-unsafe-tree: platform-escaping component: ${label}`);
    }
}

/** Do DISTINCT tree paths collapse into one entry during extraction on
 *  THIS platform? Case-insensitive APFS (darwin) and NTFS (win32) merge
 *  `Case`/`case` and macOS also merges Unicode NFC/NFD spellings, so a
 *  tree git happily stores as two entries would silently become one
 *  (silent data loss). On case-sensitive, normalization-preserving
 *  filesystems the same tree extracts safely, so the refusal below is
 *  platform-scoped: fail closed ONLY where extraction would collapse. */
function platformCollapsesDistinctPaths(): boolean {
    return process.platform === "darwin" || process.platform === "win32";
}

/** Explicit fold tables for `platformCollidingPosition`, applied per
 *  component AFTER the canonical-fold suffix (NFC → toLowerCase →
 *  NFD → U+0345→U+03B9 → NFC). Every entry was verified as a real
 *  merge on this host's filesystem (mkdtemp probe: both names in a
 *  fresh dir, O_EXCL create + readdir count). Two sweeps authorize the
 *  tables: the original 2,600-pair sweep (1,913 merged / 687 distinct /
 *  0 write-errors), plus a 3,105-pair re-sweep that adds the Latin
 *  half-ring/modifier family — every Latin letter × U+02BE/U+02BC/
 *  U+02C0/U+02C1/U+0339/U+0357 vs every precomposed/compat form in
 *  U+0180–024F and U+1E00–1EFF (1,381 merged / 1,724 distinct /
 *  0 write-errors; final key: 0 merged-not-refused, 0
 *  distinct-refused); pairs the filesystem keeps DISTINCT are
 *  deliberately absent (NFKC wrongly merged them into the key — see
 *  the function doc below).
 *  COLLISION_FULL_FOLD: Unicode case-fold relations that
 *  `toLowerCase()` leaves unfolded, each probe-confirmed as a real
 *  filesystem merge:
 *  - full-case-fold leftovers: "ß" → "ss", "ς" → "σ", "ſ" → "s",
 *    "ŉ" → "\u02BCn", "ẛ" → "ṡ";
 *  - Greek symbol variants folded to their base letters: "ϐ" → "β",
 *    "ϑ" → "θ", "ϕ" → "φ", "ϖ" → "π", "ϰ" → "κ", "ϱ" → "ρ",
 *    "ϵ" → "ε" (review 221b1088: the FS merged `ϐ`/`β` while the
 *    keys differed — the dangerous miss direction);
 *  - "\u0345" → "ι": probe-confirmed AND load-bearing — the canonical
 *    fold suffix reads this value for its U+0345 replacement, so the
 *    entry is the single source of truth for that rule (it also never
 *    reaches the per-char loop, because the suffix replaces U+0345
 *    first);
 *  - "µ" (U+00B5) → "μ": `µ`/`μ` merge on this filesystem (also
 *    enforced by the suffix's NFD step: U+00B5 canonically decomposes
 *    to U+03BC; retained as probe-confirmed belt-and-braces).
 *  - "ẚ" → "a\u02BE": blocking review 95b9395a P1 — `aʾ`/`Aʾ`
 *    (letter + U+02BE right half ring) and `ẚ` (U+1E9A) merge on this
 *    darwin filesystem (EEXIST, one entry) while the keys differed;
 *    target is the pair's lowercase NFC spelling. U+1E9A is the only
 *    letter-plus-modifier decomposition in the probed U+0180–024F /
 *    U+1E00–1EFF scan; every other letter × modifier spelling and
 *    every cross-modifier pair in the family probed DISTINCT.
 *  COLLISION_COMPAT_FOLD: compatibility characters this filesystem
 *  merges (all verified): "ﬀ"→"ff", "ﬁ"→"fi", "ﬂ"→"fl",
 *  "ﬃ"→"ffi", "ﬄ"→"ffl", "ﬅ"→"st", "ﬆ"→"st".
 *  The tables are deliberately CONSERVATIVE: they may refuse pairs
 *  extraction would keep apart (acceptable only where equivalence is
 *  plausible); they must never pass a pair extraction merges (silent
 *  data loss). Verified-SEPARATE on this host (all re-probed) and
 *  therefore NOT folded: fullwidth "Ａ", lunate "ϲ", roman "Ⅰ",
 *  circled "①", "²", "ｱ", "é"/"e", "σ"/"s", "ı"/"i", "İ"/"i",
 *  "œ"/"oe". */
const COLLISION_FULL_FOLD = new Map<string, string>([
    ["ß", "ss"],
    ["ς", "σ"],
    ["\u0345", "ι"],
    ["ſ", "s"],
    ["µ", "μ"],
    ["ϐ", "β"],
    ["ϑ", "θ"],
    ["ϕ", "φ"],
    ["ϖ", "π"],
    ["ϰ", "κ"],
    ["ϱ", "ρ"],
    ["ϵ", "ε"],
    ["ŉ", "ʼn"],
    ["ẛ", "ṡ"],
    ["ẚ", "a\u02BE"],
]);

const COLLISION_COMPAT_FOLD = new Map<string, string>([
    ["ﬀ", "ff"],
    ["ﬁ", "fi"],
    ["ﬂ", "fl"],
    ["ﬃ", "ffi"],
    ["ﬄ", "ffl"],
    ["ﬅ", "st"],
    ["ﬆ", "st"],
]);

/** Platform-collision canonical form of one tree position: per-component
 *  NFC → toLowerCase → canonical fold (NFD → U+0345→U+03B9 → NFC) →
 *  explicit fold tables — a form under which the supported
 *  case-insensitive filesystems (APFS/HFS+ on darwin, NTFS on win32)
 *  compare equal and extract into ONE entry.
 *  Equivalences covered, and which stage handles them (authority:
 *  mkdtemp probes of THIS filesystem — write both names in a fresh
 *  dir, O_EXCL create + readdir count. Original 2,600-pair sweep:
 *  1,913 merged, 687 distinct, 0 write-errors; final key refuses all
 *  merged pairs, over-refuses none. Re-sweep adding the Latin
 *  half-ring/modifier family (3,105 pairs total: every Latin letter ×
 *  U+02BE/U+02BC/U+02C0/U+02C1/U+0339/U+0357 vs every
 *  precomposed/compat form in U+0180–024F and U+1E00–1EFF, plus the
 *  original methodology re-run): 1,381 merged, 1,724 distinct, 0
 *  write-errors; final key: 0 merged-not-refused, 0 distinct-refused):
 *  - canonical NFC/NFD spellings (`café`/`café`) — via NFC (all 593
 *    probed canonical-equivalence pairs merge on this filesystem);
 *  - case (`Case`/`case`, `ẞ`/`ß`, `Ǆ`/`ǆ`, Kelvin `K`/`k`, `Å`/`å`,
 *    ohm `Ω`/`ω`) — via toLowerCase;
 *  - post-lowercase recomposition (`ǰ` = U+01F0 vs `j` +
 *    U+030C; `ΐ` = U+0390 vs `ΐ` = U+03CA + U+0301):
 *    toLowerCase can make NEW canonical compositions available that
 *    the leading NFC never saw — via the suffix's NFD → NFC
 *    re-canonicalization;
 *  - full case folding of U+0345 iota subscript (`ᾳ`/`αι`,
 *    `ᾀ`/`ἀι`, U+0345/`ι`) — via the suffix's U+0345→U+03B9
 *    replacement (the value is read from the fold table entry, so the
 *    table stays the single source of truth for that rule);
 *  - case-fold leftovers and symbol/compat characters `toLowerCase()`
 *    never unfolds (`ß`/`ss`, `σ`/`ς`, `ſ`/`s`, `ŉ`/`ʼn`,
 *    `ϐ`/`β`, `ϕ`/`φ`, ligatures `ﬁ`/`fi`, `µ`/`μ`) — via the
 *    explicit tables above;
 *  - Latin trailing half-ring/modifier spellings (`ẚ`/`aʾ`,
 *    `ẚ`/`Aʾ` — the family's ONLY merged pairs; every other
 *    letter × modifier and cross-modifier pair probed DISTINCT) —
 *    via the explicit table entry above.
 *  REJECTED NFKC (review 952c0275 P2): this filesystem keeps fullwidth
 *  `Ａ`/`A`, lunate `ϲ`/`σ`, roman `Ⅰ`/`I`, `①`/`1`, `²`/`2`
 *  DISTINCT (all re-probed in the same 2,600-pair sweep), so blanket
 *  NFKC over-refused real entries; only empirically-merged characters
 *  are folded. CONSERVATIVE: refuse anything ambiguous; never pass a
 *  pair the filesystem merges (the post-extract inventory check is the
 *  second net for any miss). Gate stays `platformCollapsesDistinctPaths`. */
export function platformCollidingPosition(position: string): string {
    const iotaSubscriptFold = COLLISION_FULL_FOLD.get("\u0345") ?? "\u03B9";
    return position
        .split("/")
        .map((part) => {
            // Canonical fold suffix: plain NFC→toLowerCase is not stable
            // under canonical equivalence (lowercasing can create a
            // composition NFC never applied), and this filesystem folds
            // U+0345 like Unicode full case folding (ᾳ ≡ αι).
            const canonical = part
                .normalize("NFC")
                .toLowerCase()
                .normalize("NFD")
                .split("\u0345")
                .join(iotaSubscriptFold)
                .normalize("NFC");
            let folded = "";
            for (const ch of canonical) {
                folded += COLLISION_FULL_FOLD.get(ch) ?? COLLISION_COMPAT_FOLD.get(ch) ?? ch;
            }
            return folded;
        })
        .join("/");
}

/** Symlink-target syntax (owner decision 2026-10-08): targets must be
 *  relative paths — no NUL, no leading `/`; on win32 additionally no
 *  backslash and no drive/ADS-colon components (same win32 rules as tree
 *  paths). Refusal precedes any resolution or blob-dependent step. */
function assertLinkTargetSyntax(target: string, label: string): void {
    if (target.length === 0) throw new Error(`refuses-unsafe-tree: empty symlink target: ${label}`);
    if (target.includes("\0")) throw new Error(`refuses-unsafe-tree: NUL byte in symlink target: ${label}`);
    if (target.startsWith("/")) throw new Error(`refuses-unsafe-tree: absolute symlink target: ${label}`);
    if (process.platform === "win32") {
        for (const part of target.split("/")) {
            if (part === "" || part === "." || part === "..") continue;
            assertWin32TreeComponent(part, `symlink target ${JSON.stringify(target)}`);
        }
    }
}

/** Lexical '/'-resolution of a relative tree path; null when a `..` pops
 *  above the snapshot root (the path lexically escapes). */
function normalizeTreePath(path: string): string | null {
    const out: string[] = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (out.length === 0) return null;
            out.pop();
            continue;
        }
        out.push(part);
    }
    return out.join("");
}

function treeDirPath(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
}

/** Physical POSIX-style resolution of one symlink record over the tree
 *  records (owner decision 2026-10-08): expand symlink components the way
 *  the kernel would — rewind to the link's directory and splice the target
 *  into the still-unprocessed queue — instead of trusting the lexical
 *  normal form alone. A `..` with nothing left to pop escapes the snapshot
 *  root (refuse, even when the raw lexical target looked contained — a
 *  traversed in-tree link can deepen the path before the pop); more than
 *  SYMLINK_CHAIN_MAX_HOPS expansions mean a cycle or absurd depth (refuse).
 *  The final stack is inside the root by construction. */
function resolveTreeLinkChain(linkPath: string, linkTarget: string, targets: Map<string, string>): void {
    const dir = treeDirPath(linkPath);
    const stack: string[] = dir.length > 0 ? dir.split("/") : [];
    let queue: string[] = linkTarget.split("/");
    let hops = 0;
    for (;;) {
        const component = queue.shift();
        if (component === undefined) return;
        if (component === "" || component === ".") continue;
        if (component === "..") {
            if (stack.length === 0) {
                throw new Error(`refuses-unsafe-tree: symlink chain escapes snapshot root: ${linkPath}`);
            }
            stack.pop();
            continue;
        }
        const path = stack.length > 0 ? `${stack.join("/")}/${component}` : component;
        const target = targets.get(path);
        if (target !== undefined) {
            hops += 1;
            if (hops > SYMLINK_CHAIN_MAX_HOPS) {
                throw new Error(
                    `refuses-unsafe-tree: symlink chain exceeds ${SYMLINK_CHAIN_MAX_HOPS} hops (cycle or excessive depth): ${linkPath}`,
                );
            }
            // Expand in place: stay at this link's directory, splice its
            // target ahead of the still-unprocessed suffix components.
            queue = target.split("/").concat(queue);
            continue;
        }
        stack.push(component);
    }
}

/** Read + syntax-validate every symlink target, then chain-resolve each
 *  record against the full target map (chains may traverse other links). */
function readTreeLinkTargets(
    symlinkRecords: SnapshotTreeRecord[],
    readLinkTarget?: (record: SnapshotTreeRecord) => string,
): void {
    const targets = new Map<string, string>();
    for (const record of symlinkRecords) {
        if (readLinkTarget === undefined) {
            throw new Error(`refuses-unsafe-tree: symlink record (120000) requires a link-target reader: ${record.path}`);
        }
        if (record.oid === undefined || !FULL_OID_PATTERN.test(record.oid)) {
            throw new Error(`refuses-unsafe-tree: symlink record without a valid object id: ${record.path}`);
        }
        const target = readLinkTarget(record);
        assertLinkTargetSyntax(target, record.path);
        const dir = treeDirPath(record.path);
        if (normalizeTreePath(dir.length > 0 ? `${dir}/${target}` : target) === null) {
            throw new Error(`refuses-unsafe-tree: symlink target lexically escapes snapshot root: ${record.path}`);
        }
        targets.set(record.path, target);
    }
    for (const [path, target] of targets) resolveTreeLinkChain(path, target, targets);
}

/**
 * Fail-closed validator for source-tree records. Rejects unsafe or
 * platform-escaping components, duplicates/prefix collisions, unsupported
 * modes/types, and reserved completion-marker names.
 *
 * Owner decision (2026-10-08): symlink (120000) and gitlink (160000 /
 * type commit) records are SUPPORTED — cases are never dropped — under
 * these rules:
 * - each symlink's target blob is read through `readLinkTarget` (preflight
 *   wires `git cat-file blob` under the archive network env: offline fails
 *   closed when the blob is missing, online may lazy-fetch) and must be a
 *   relative in-tree path: syntax + lexical containment + physical chain
 *   resolution over the tree records (bounded to SYMLINK_CHAIN_MAX_HOPS;
 *   root escapes and cycles refuse);
 * - a gitlink is an empty-directory placeholder (records nothing to
 *   extract; `git archive` emits an empty dir for it).
 * Pure given an injected reader: no I/O happens in this function itself.
 */
export function validateSnapshotTreeRecords(
    records: SnapshotTreeRecord[],
    readLinkTarget?: (record: SnapshotTreeRecord) => string,
): SnapshotTreeCounts {
    const blobs = new Set<string>();
    const trees = new Set<string>();
    const gitlinks = new Set<string>();
    // Every directory position seen so far: tree paths, gitlink paths,
    // ancestors of trees/gitlinks, and ancestors of blobs. A blob landing
    // anywhere in this set is a file-versus-directory prefix collision in
    // EITHER record order (a blob equal to, above, or below a recorded
    // tree/gitlink/blob directory position).
    const dirPaths = new Set<string>();
    const symlinkRecords: SnapshotTreeRecord[] = [];
    let gitlinkCount = 0;
    // Platform-collision registry (darwin/win32 only): maps each
    // position's collision key (per-component NFC → toLowerCase →
    // canonical fold suffix → explicit probe-confirmed fold tables;
    // see platformCollidingPosition) to the first raw spelling seen,
    // so distinct raw paths that extraction would merge into one
    // entry refuse. Covers FULL paths AND every
    // ancestor directory position — `Case/x` vs `case/y` differ as paths
    // but collide at the `Case`/`case` directory. Exact-duplicate raw
    // paths map to themselves and remain the duplicate/prefix checks'
    // job below.
    const canonicalPositions = new Map<string, string>();
    const collidesPaths = platformCollapsesDistinctPaths();
    for (const record of records) {
        const { mode, kind, path } = record;
        const isTree = mode === "040000" && kind === "tree";
        const isBlob = SNAPSHOT_TREE_FILE_MODES.has(mode) && kind === "blob";
        const isSymlink = mode === "120000" && kind === "blob";
        const isGitlink = mode === "160000" && kind === "commit";
        if (!isTree && !isBlob && !isSymlink && !isGitlink) {
            if (kind === "commit" || mode === "160000") {
                throw new Error(`refuses-unsafe-tree: gitlink/submodule record: ${path}`);
            }
            throw new Error(`refuses-unsafe-tree: unsupported mode/type ${mode} ${kind}: ${path}`);
        }
        if (path.length === 0 || path.startsWith("/")) {
            throw new Error(`refuses-unsafe-tree: unsafe path: ${path}`);
        }
        for (const part of path.split("/")) {
            if (part === "" || part === "." || part === "..") {
                throw new Error(`refuses-unsafe-tree: unsafe path component: ${path}`);
            }
            if (part === SNAPSHOT_COMMIT_MARKER) {
                throw new Error(`refuses-unsafe-tree: reserved completion-marker name: ${path}`);
            }
            if (process.platform === "win32") assertWin32TreeComponent(part, path);
        }
        const ancestors = snapshotTreeAncestors(path);
        if (collidesPaths) {
            for (const position of [path, ...ancestors]) {
                const key = platformCollidingPosition(position);
                const prior = canonicalPositions.get(key);
                if (prior !== undefined && prior !== position) {
                    throw new Error(
                        `refuses-unsafe-path: platform-equivalent path collision: ${JSON.stringify(prior)} <-> ${JSON.stringify(position)}`,
                    );
                }
                canonicalPositions.set(key, position);
            }
        }
        if (isTree || isGitlink) {
            if (trees.has(path) || gitlinks.has(path)) throw new Error(`refuses-unsafe-tree: duplicate path: ${path}`);
            if (blobs.has(path)) throw new Error(`refuses-unsafe-tree: path collision: ${path}`);
            for (const ancestor of ancestors) {
                if (blobs.has(ancestor) || gitlinks.has(ancestor)) {
                    throw new Error(`refuses-unsafe-tree: prefix collision: ${path}`);
                }
            }
            (isTree ? trees : gitlinks).add(path);
            dirPaths.add(path);
            for (const ancestor of ancestors) dirPaths.add(ancestor);
            if (isGitlink) gitlinkCount += 1;
            continue;
        }
        if (blobs.has(path) || trees.has(path) || gitlinks.has(path)) {
            throw new Error(`refuses-unsafe-tree: duplicate path: ${path}`);
        }
        // dirPaths catches a blob equal to a recorded tree/gitlink, an
        // ancestor of a recorded tree/gitlink, or an ancestor of a recorded
        // blob — regardless of record order; the ancestors loop catches blob
        // ancestors recorded as blobs or gitlinks (blob paths themselves are
        // never in dirPaths).
        if (dirPaths.has(path)) {
            throw new Error(`refuses-unsafe-tree: prefix collision: ${path}`);
        }
        for (const ancestor of ancestors) {
            if (blobs.has(ancestor) || gitlinks.has(ancestor)) {
                throw new Error(`refuses-unsafe-tree: prefix collision: ${path}`);
            }
        }
        blobs.add(path);
        for (const ancestor of ancestors) dirPaths.add(ancestor);
        if (isSymlink) symlinkRecords.push(record);
    }
    readTreeLinkTargets(symlinkRecords, readLinkTarget);
    return { symlinks: symlinkRecords.length, gitlinks: gitlinkCount };
}

/** Link-target blob reader wired into preflight: same network-mode env as
 *  `git archive` — offline blocks every transport (ALL-transport sentinel +
 *  prompt/lazy-fetch blocks), so a blob:none clone lacking the target blob
 *  fails closed; online may lazy-fetch over https/file. Targets are tiny;
 *  64 KiB bounds the read (overflow refuses). Any failure refuses the whole
 *  preflight — the target is never skipped or substituted. */
function makeLinkTargetReader(bare: string, offline: boolean | undefined): (record: SnapshotTreeRecord) => string {
    return (record) => {
        const oid = record.oid;
        if (oid === undefined || !FULL_OID_PATTERN.test(oid)) {
            throw new Error(`refuses-unsafe-tree: symlink record without a valid object id: ${record.path}`);
        }
        let buf: Buffer;
        try {
            buf = execFileSync("git", ["--git-dir", bare, "cat-file", "blob", oid], {
                env: ownedArchiveGitEnv(offline),
                stdio: ["ignore", "pipe", "pipe"],
                maxBuffer: 64 * 1024,
            }) as Buffer;
        } catch (error) {
            throw new Error(
                `refuses-unsafe-tree: cannot read symlink target blob for ${record.path}: ${(error as Error).message.slice(0, 160)}`,
            );
        }
        return buf.toString("utf8");
    };
}

/**
 * Source-tree preflight: resolve baseCommit to ONE immutable canonical sha,
 * then read and validate the FULL recursive tree (including tree entries)
 * of that exact scope. The returned sha is the only scope the caller may
 * archive. Returns the sha plus tree-shape counts {symlinks, gitlinks} for
 * materialization receipts (owner decision 2026-10-08): symlink target
 * blobs are read under the archive network mode (offline fail-closed, online
 * may lazy-fetch), gitlinks record no extractable content. Metadata only
 * (stdout bytes); writes nothing anywhere.
 */
export function preflightSnapshotTree(
    bare: string,
    baseCommit: string,
    opts: { offline?: boolean } = {},
): SnapshotTreePreflight {
    let canonical: string;
    try {
        canonical = (execFileSync(
            "git",
            ["--git-dir", bare, "rev-parse", "--verify", "--end-of-options", `${baseCommit}^{commit}`],
            { encoding: "utf8", env: offlineGitEnv(), stdio: ["ignore", "pipe", "pipe"] },
        ) as string).trim();
    } catch (error) {
        throw new Error(`refuses-unverified-commit: cannot resolve ${baseCommit}: ${(error as Error).message.slice(0, 160)}`);
    }
    if (!/^[0-9a-f]{40,64}$/.test(canonical)) {
        throw new Error(`refuses-unverified-commit: non-canonical resolution: ${canonical.slice(0, 80)}`);
    }
    let raw: Buffer;
    try {
        raw = execFileSync("git", ["--git-dir", bare, "ls-tree", "-z", "-r", "-t", "--end-of-options", canonical], {
            env: offlineGitEnv(),
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 256 * 1024 * 1024,
        }) as Buffer;
    } catch (error) {
        throw new Error(`refuses-unsafe-tree: cannot read tree of ${canonical}: ${(error as Error).message.slice(0, 160)}`);
    }
    // NUL-safe parse: split records on \0, then split meta/path on the
    // FIRST tab so ordinary tabs/newlines inside names survive intact.
    const records: SnapshotTreeRecord[] = [];
    for (const entry of raw.toString("utf8").split("\0")) {
        if (entry.length === 0) continue;
        const tab = entry.indexOf("\t");
        if (tab < 0) throw new Error("refuses-unsafe-tree: malformed ls-tree record");
        const meta = entry.slice(0, tab).split(" ");
        if (meta.length !== 3) throw new Error("refuses-unsafe-tree: malformed ls-tree record");
        records.push({ mode: meta[0] as string, kind: meta[1] as string, oid: meta[2] as string, path: entry.slice(tab + 1) });
    }
    const counts = validateSnapshotTreeRecords(records, makeLinkTargetReader(bare, opts.offline));
    return { canonical, counts, inventory: expectedExtractionInventory(records) };
}

/** Expected extraction inventory for VALIDATED tree records (run
 *  `validateSnapshotTreeRecords` first): each record maps to the kind
 *  extraction produces — regular blob → file, 120000 → symlink, 040000
 *  tree and 160000 gitlink → dir — and every ancestor becomes a
 *  directory position (git archive materializes those as directories).
 *  Validation guarantees no record ever claims an ancestor position. */
export function expectedExtractionInventory(records: SnapshotTreeRecord[]): SnapshotTreeInventory {
    const inventory: SnapshotTreeInventory = new Map();
    for (const record of records) {
        let kind: SnapshotTreeEntryKind;
        if (record.mode === "120000") kind = "symlink";
        else if (record.mode === "040000" || record.mode === "160000") kind = "dir";
        else kind = "file";
        for (const ancestor of snapshotTreeAncestors(record.path)) {
            if (!inventory.has(ancestor)) inventory.set(ancestor, "dir");
        }
        inventory.set(record.path, kind);
    }
    return inventory;
}

/** FS-side symlink verdict for one extracted snapshot link (owner decision
 *  2026-10-08). Refuses anything but a relative target whose LEXICAL
 *  resolution stays inside the snapshot; a resolvable link must ALSO
 *  resolve (realpath) inside realpath(root); a link that cannot be resolved
 *  (dangling, or pathing through a file) is allowed only when the lexical
 *  target is inside — documented decision: dangling in-tree links are
 *  permitted, everything else fails closed. Returns "dir" when the link
 *  resolves to an in-tree directory (legacy `listFilesLegacy` walked INTO
 *  such links; owned listing never follows them) and "entry" otherwise —
 *  legacy listed the link path itself as a file entry; for dangling links
 *  legacy would throw ENOENT instead, and owner decision allows the case,
 *  so the link path is listed as a leaf entry (documented deviation). */
function extractedLinkDisposition(root: string, realRoot: string, full: string): "dir" | "entry" {
    const target = readlinkSync(full);
    const label = relative(root, full);
    assertLinkTargetSyntax(target, label);
    const lexical = resolve(dirname(full), target);
    if (lexical !== root && !lexical.startsWith(`${root}${sep}`)) {
        throw new Error(`refuses-unsafe-entry: symlink target lexically escapes snapshot: ${label}`);
    }
    let resolved: string | null = null;
    let failure: unknown = null;
    try {
        resolved = realpathSync(full);
    } catch (error) {
        failure = error;
    }
    if (resolved !== null) {
        if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${sep}`)) {
            throw new Error(`refuses-unsafe-entry: symlink resolves outside snapshot: ${label}`);
        }
        return statSync(resolved).isDirectory() ? "dir" : "entry";
    }
    const code = (failure as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return "entry";
    throw new Error(`refuses-unsafe-entry: unresolvable symlink: ${label}: ${(failure as Error).message}`);
}

/**
 * Post-extraction validation: lstat every descendant (never follow links).
 * Regular files and directories survive; symlinks survive only when
 * `extractedLinkDisposition` proves them in-tree (owner decision 2026-10-08:
 * in-tree symlinks are legitimate `git archive` content; nothing walks
 * through them). The reserved marker name must be absent (preflight already
 * rejects it; this is defense in depth).
 *
 * Blocking-review P1-1b (runs on EVERY platform): the walk also builds the
 * ACTUAL extracted entry inventory and compares it — path set + per-kind
 * equality — against the PREFLIGHT expectations (`expected`), so entries
 * merged by case-/normalization-insensitive extraction (which the
 * darwin/win32 preflight refusal cannot see on other hosts) fail closed
 * instead of silently losing data.
 */
export function assertSafeExtractedTree(root: string, expected: SnapshotTreeInventory): void {
    const realRoot = realpathSync(root);
    const actual: SnapshotTreeInventory = new Map();
    const stack: string[] = [root];
    while (stack.length > 0) {
        const dir = stack.pop() as string;
        for (const name of readdirSync(dir).sort()) {
            if (name === ".git") continue;
            if (name === SNAPSHOT_COMMIT_MARKER) {
                throw new Error(`refuses-unsafe-entry: reserved marker present after extract: ${relative(root, join(dir, name))}`);
            }
            const full = join(dir, name);
            const rel = relative(root, full).split(sep).join("/");
            const st = lstatSync(full);
            if (st.isSymbolicLink()) {
                // Validate the link, then leave it unexpanded on the stack:
                // descendants are never walked through a symlink.
                extractedLinkDisposition(root, realRoot, full);
                actual.set(rel, "symlink");
            } else if (st.isDirectory()) {
                actual.set(rel, "dir");
                stack.push(full);
            } else if (st.isFile()) actual.set(rel, "file");
            else {
                throw new Error(`refuses-unsafe-entry: non-regular file after extract: ${relative(root, full)}`);
            }
        }
    }
    assertExtractedInventory(expected, actual);
}

/** Fail-closed extracted-vs-expected inventory comparison: path sets and
 *  per-path entry kinds must match exactly — missing (dropped or merged
 *  during extraction), extra (never preflighted), and retyped entries all
 *  refuse, with per-kind counts in the message for diagnosis. Exported as
 *  the test seam: a collapsed inventory can be injected when the host
 *  filesystem itself cannot be made to collapse distinct entries. */
export function assertExtractedInventory(expected: SnapshotTreeInventory, actual: SnapshotTreeInventory): void {
    const missing: string[] = [];
    const retyped: string[] = [];
    const extra: string[] = [];
    for (const [path, kind] of expected) {
        const found = actual.get(path);
        if (found === undefined) missing.push(path);
        else if (found !== kind) retyped.push(`${path} (${kind} -> ${found})`);
    }
    for (const path of actual.keys()) {
        if (!expected.has(path)) extra.push(path);
    }
    if (missing.length === 0 && retyped.length === 0 && extra.length === 0) return;
    const brief = (xs: string[]): string => xs.slice(0, 8).join(", ") + (xs.length > 8 ? ` (+${xs.length - 8} more)` : "");
    const counts = (inv: SnapshotTreeInventory): string => {
        const c: Record<SnapshotTreeEntryKind, number> = { file: 0, dir: 0, symlink: 0 };
        for (const kind of inv.values()) c[kind] += 1;
        return `file=${c.file} dir=${c.dir} symlink=${c.symlink}`;
    };
    throw new Error(
        `refuses-unsafe-entry: extracted inventory mismatch: missing=[${brief(missing)}] extra=[${brief(extra)}] ` +
            `retyped=[${brief(retyped)}] expected counts ${counts(expected)}; found counts ${counts(actual)}`,
    );
}

/** Stage-tagged throw for the owned extract→postcheck→marker staging block. */
class SnapshotStageError extends Error {
    constructor(readonly completedStage: SnapshotStage, message: string) {
        super(message);
        this.name = "SnapshotStageError";
    }
}

/**
 * Owned-mode pin contract: baseCommit must already be a full lowercase
 * 40- or 64-hex object id. Raw refs ('HEAD', branch names) and abbreviated
 * or uppercase shas can resolve to different objects over time or under a
 * different clone, so they can neither pin nor match a snapshot marker
 * (a raw-ref pin is how a stale snapshot gets silently reused). Throws —
 * reported as a refusal by the run loop, which applies this SAME
 * validator to every selected instance BEFORE `ensureBareClone` so a
 * noncanonical pin never triggers a clone write or network access —
 * before any marker reuse or snapshot write. Owned mode only; legacy
 * caches keep historical behavior.
 */
export function assertCanonicalBaseCommit(baseCommit: string): void {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
        throw new Error(
            `refuses-noncanonical-basecommit: ${JSON.stringify(baseCommit.slice(0, 80))} is not a full lowercase hex object id`,
        );
    }
}

/**
 * Archive baseCommit into the per-instance snapshot dir. Returns the
 * snapshot root, or an exclusion when any gold file is absent at base.
 * A matching marker skips re-extraction; gold presence is always verified.
 *
 * Authority order: canonical baseCommit pin check, containment/symlink
 * checks and marker reuse first, then source-tree preflight over the
 * verified commit (whose resolved sha must equal the pin), then
 * `git archive` of that SAME sha (network-mode env: offline fail-loud/no
 * lazy fetch, online https/file lazy fetch allowed), then snapshot-dir creation
 * (never deleting anything pre-existing, even an empty unmarked dir), then
 * tar extract, post-extract lstat validation, exclusive completion marker,
 * and finally the gold check.
 *
 * Refusals of foreign/mismatched state throw (files retained, never
 * adopted). Every OWNED attempt instead returns a precise receipt
 * (root/createdFresh/completedStage/error) — including preflight, archive,
 * extract, postcheck, marker, gold-exclusion, and temp-cleanup failures —
 * so the run loop can record every inspected root. Temp-dir cleanup never
 * masks the primary error.
 *
 * Legacy (non-owned) callers keep the historical shapes and throwing
 * behavior via materializeLegacyInstance; Stage 2 strictness applies to
 * owned mode only.
 */
export function materializeInstance(
    instance: BenchmarkInstance,
    opts: { bareDir?: string; stateRoot: string; offline?: boolean },
): MaterializeResult;
export function materializeInstance(
    instance: BenchmarkInstance,
    bareDirOrOpts?: string | { bareDir?: string; stateRoot?: string | null; offline?: boolean },
): MaterializeResult | LegacyMaterializeResult;
export function materializeInstance(
    instance: BenchmarkInstance,
    bareDirOrOpts?: string | { bareDir?: string; stateRoot?: string | null; offline?: boolean },
): MaterializeResult | LegacyMaterializeResult {
    const asOpts = typeof bareDirOrOpts === "object" ? bareDirOrOpts : { bareDir: bareDirOrOpts };
    const owned = asOpts.stateRoot ? ensureOwnedStateRoot(asOpts.stateRoot) : null;
    // Fail closed on a noncanonical pin BEFORE any clone, marker reuse, or
    // snapshot write: 'HEAD' or an abbreviated/uppercase sha must never
    // compare against (or write) a completion marker.
    if (owned !== null) assertCanonicalBaseCommit(instance.baseCommit);
    const bare = asOpts.bareDir ?? ensureBareClone(instance.repo, { stateRoot: asOpts.stateRoot, offline: asOpts.offline });
    if (owned === null) return materializeLegacyInstance(instance, bare, snapshotDir(instance.instanceId));
    const root = snapshotDirUnder(owned.root, instance.instanceId);
    // Whole-ancestor alias guard BEFORE touching anything.
    assertNoSymlinkAncestors(root, "snapshot root");
    try {
        if (lstatSync(root).isSymbolicLink()) throw new Error(`refuses-symlink-snapshot: ${root}`);
    } catch (error) {
        if ((error as Error).message.startsWith("refuses-symlink-snapshot")) throw error;
    }
    const marker = join(root, ".snapshot-commit");
    if (existsSync(marker)) {
        // The marker must be a regular non-link file; a symlinked or
        // non-file marker is foreign. A mismatched commit NEVER deletes:
        // refuse and ask for a fresh root (recreate without exact
        // campaign-created binding outside this dir is unsafe).
        try {
            const mst = lstatSync(marker);
            if (mst.isSymbolicLink() || !mst.isFile()) {
                throw new Error(`refuses-unowned-snapshot: snapshot marker is not a regular file: ${marker}`);
            }
        } catch (error) {
            if ((error as Error).message.startsWith("refuses-unowned-snapshot")) throw error;
            throw new Error(`refuses-unowned-snapshot: cannot stat snapshot marker: ${marker}`);
        }
        const prior = readFileSync(marker, "utf8").trim();
        // The pin is canonical at entry, so this compares canonical vs
        // marker: a pre-fix raw-ref marker can only mismatch and refuse,
        // never be reused as the current commit.
        if (prior !== instance.baseCommit) {
            throw new Error(
                `refuses-mismatched-snapshot: ${root} pins ${prior.slice(0, 12) || "unknown"} ` +
                `(want ${instance.baseCommit.slice(0, 12)}); snapshot retained, use a fresh --state-root`,
            );
        }
        const files = listFiles(root);
        const missing = instance.goldFiles.filter((f) => !files.has(f));
        if (missing.length > 0) return { excluded: true, reason: "missing-at-base", missing, root, createdFresh: false };
        return { root, createdFresh: false };
    }
    // Only a campaign-marked snapshot may be reused. Any pre-existing
    // unmarked entry (even an empty dir) is refused, never adopted or
    // deleted: emptiness does not prove ownership.
    if (existsSync(root)) {
        throw new Error(`refuses-unowned-snapshot: ${root} exists without a snapshot marker; use a fresh --state-root`);
    }
    // Preflight BEFORE any archive/extract/snapshot write: resolve ONE
    // immutable canonical sha and reject unsafe trees (escaping/unresolvable
    // links, bad modes, escapes, collisions, reserved marker names). Safe
    // in-tree symlinks and gitlinks pass with receipt counts (owner decision
    // 2026-10-08). A rejection leaves no snapshot behind and invokes no tar.
    let preflight: SnapshotTreePreflight;
    try {
        preflight = preflightSnapshotTree(bare, instance.baseCommit, { offline: asOpts.offline });
    } catch (error) {
        return { failed: true, root, createdFresh: false, completedStage: "preflight", error: (error as Error).message };
    }
    const canonical = preflight.canonical;
    const preflightCounts = preflight.counts;
    // The pin must BE the commit preflight resolved (e.g. a full tag-object
    // sha peels via ^{commit} to a different commit sha): archive and mark
    // only an exact match, so the marker stores the same canonical value
    // later comparisons use. No archive/snapshot write has happened yet.
    if (canonical !== instance.baseCommit) {
        return {
            failed: true,
            root,
            createdFresh: false,
            completedStage: "preflight",
            error: `refuses-noncanonical-basecommit: pin resolves to a different object (${canonical.slice(0, 12)} != ${instance.baseCommit.slice(0, 12)})`,
            preflightCounts,
        };
    }
    // Archive ONLY the preflighted scope, under the run's network mode:
    // offline fails loudly instead of touching the network (no lazy fetch),
    // online lazy-fetches a blob:none clone's missing blobs over https/file
    // only. Still no snapshot write yet.
    let archive: Buffer;
    try {
        archive = execFileSync("git", ["--git-dir", bare, "archive", "--end-of-options", canonical], {
            env: ownedArchiveGitEnv(asOpts.offline),
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 1024 * 1024 * 1024,
        }) as Buffer;
    } catch (error) {
        return { failed: true, root, createdFresh: false, completedStage: "archive", error: `git archive failed: ${(error as Error).message.slice(0, 200)}`, preflightCounts };
    }
    // Exclusive (non-recursive) creation: a dir that appeared since the
    // refusal check above fails with EEXIST instead of being adopted.
    assertNoSymlinkAncestors(root, "snapshot root");
    try {
        mkdirSync(root, { mode: 0o700 });
    } catch (error) {
        return { failed: true, root, createdFresh: false, completedStage: "extract", error: `cannot create snapshot dir: ${(error as Error).message.slice(0, 200)}`, preflightCounts };
    }
    const createdFresh = true;
    try {
        externalStateFsHooks.chmodSync(root, 0o700);
        assertPrivateMode(root, 0o700, "snapshot root");
    } catch (error) {
        return { failed: true, root, createdFresh, completedStage: "extract", error: `snapshot root not private: ${(error as Error).message.slice(0, 200)}`, preflightCounts };
    }
    // Extract from a temp file rather than stdin: piping the archive via
    // spawnSync input races tar's exit on macOS (bsdtar), surfacing as
    // `spawnSync tar EPIPE` in CI. -xf reads the same bytes deterministically.
    // The staging temp dir is session-created; its cleanup is recorded
    // separately and never masks the primary error.
    const stageDir = tempSnapshotRoot("ext-grep-archive-");
    let primaryError: { completedStage: SnapshotStage; message: string } | null = null;
    let markerWritten = false;
    // Stage being attempted: unexpected (non-stage) errors still become a
    // precise failure receipt instead of an undefined completedStage.
    let stage: SnapshotStage = "extract";
    try {
        const tmpArchive = join(stageDir, "archive.tar");
        writeFileSync(tmpArchive, archive);
        try {
            execFileSync("tar", ["-xf", tmpArchive, "-C", root]);
        } catch (error) {
            throw new SnapshotStageError("extract", `tar extract failed: ${(error as Error).message.slice(0, 200)}`);
        }
        stage = "postcheck";
        try {
            assertSafeExtractedTree(root, preflight.inventory);
        } catch (error) {
            throw new SnapshotStageError("postcheck", (error as Error).message);
        }
        // Exclusive completion marker: written ONLY after a fully validated
        // extraction, never on an incomplete phase.
        stage = "marker";
        assertNoSymlinkAncestors(marker, "snapshot marker");
        try {
            // The preflight-resolved canonical sha, verified above to equal
            // the pin: reuse later compares this exact value.
            writeFileSync(marker, canonical, { mode: 0o600, flag: "wx" });
            markerWritten = true;
        } catch (error) {
            throw new SnapshotStageError("marker", `snapshot marker write failed: ${(error as Error).message.slice(0, 200)}`);
        }
    } catch (staged) {
        if (staged instanceof SnapshotStageError) {
            primaryError = { completedStage: staged.completedStage, message: staged.message };
        } else {
            primaryError = {
                completedStage: stage,
                message: staged instanceof Error ? staged.message : String(staged),
            };
        }
    }
    try {
        rmSync(stageDir, { recursive: true, force: true });
    } catch (error) {
        const cleanup = `temp cleanup failed: ${(error as Error).message.slice(0, 200)}`;
        if (primaryError !== null) {
            return { failed: true, root, createdFresh, completedStage: primaryError.completedStage, error: `${primaryError.message}; ${cleanup}`, preflightCounts };
        }
        return { failed: true, root, createdFresh, completedStage: "cleanup-temp", error: cleanup, preflightCounts };
    }
    if (primaryError !== null) {
        return { failed: true, root, createdFresh, completedStage: primaryError.completedStage, error: primaryError.message, preflightCounts };
    }
    if (!markerWritten) {
        return { failed: true, root, createdFresh, completedStage: "marker", error: "snapshot marker was not written", preflightCounts };
    }
    const files = listFiles(root);
    const missing = instance.goldFiles.filter((f) => !files.has(f));
    if (missing.length > 0) {
        // Exclusion retains the materialization receipt: root, creation,
        // files, and marker all survive.
        return { excluded: true, reason: "missing-at-base", missing, root, createdFresh, preflightCounts };
    }
    return { root, createdFresh, preflightCounts };
}

/** Create a throwaway temp snapshot root (used by unit tests, not the cache). */
export function tempSnapshotRoot(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}
