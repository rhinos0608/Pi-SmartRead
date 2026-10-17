/**
 * Owned state-root safety tests for the external grep benchmark runner.
 *
 * Boundary-first: every fixture lives under a canonical (realpath) os
 * tmpdir owned by the test (never homedir, never the repo, never legacy
 * caches). Fresh roots are claimed at a NOT-YET-EXISTING child path:
 * pre-existing directories are NEVER adopted for being empty or UID-ours.
 * Foreign/mismatched state is refused without deletion (files retained),
 * offline mode fails before any network, and importing run.ts has zero
 * CLI effects (see external-run-import-safe.test.ts for the import guard).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    EXTERNAL_STATE_MARKER,
    EXTERNAL_STATE_OWNER,
    assertPathWithinRoot,
    bareRepoDirUnder,
    ensureBareClone,
    ensureOwnedStateRoot,
    externalStateFsHooks,
    materializeInstance,
    resolveExternalStateRoot,
    snapshotDirUnder,
} from "../../../scripts/eval/external/grep/repos.js";
import { runExternalGrepCli } from "../../../scripts/eval/external/grep/run.js";
import { buildDevHoldoutManifest } from "../../../scripts/eval/external/grep/sampling.js";
import { rowsToInstances } from "../../../scripts/eval/external/grep/swebench-multilingual.js";
import { cacheDir } from "../../../scripts/eval/external/grep/swebench-multilingual.js";
import { multiSweBenchCacheDir } from "../../../scripts/eval/external/grep/multi-swe-bench.js";
import type { BenchmarkInstance } from "../../../scripts/eval/external/grep/instance.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_SMARTREAD_EXTERNAL_STATE_ROOT;
});
/** Canonical fixture base: realpath sidesteps the /var OS alias so
 *  physical-containment checks see the true location (no blind exceptions). */
function tempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tmpRoots.push(dir);
    return dir;
}

/** Fresh (not-yet-existing) child path: the only claimable shape. */
function freshRoot(): { base: string; root: string } {
    const base = tempDir("ext-owned-state-");
    return { base, root: join(base, "state") };
}

function makeInstance(overrides: Partial<BenchmarkInstance> = {}): BenchmarkInstance {
    return {
        instanceId: "acme__widget-1",
        repo: "acme/widget",
        baseCommit: "0".repeat(40),
        dataset: "swe-bench-multilingual",
        language: "ts",
        split: "dev",
        license: "MIT",
        excludedFiles: [],
        title: "t",
        body: "b",
        goldFiles: [],
        goldHunks: [],
        ...overrides,
    };
}

/** Local git repo; its .git dir serves as the bare repo (no network). */
function localBareRepo(): { bare: string; sha: string } {
    const repo = tempDir("ext-owned-fixture-");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
        cwd: repo,
        stdio: "ignore",
    });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add a"], {
        cwd: repo,
        stdio: "ignore",
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    return { bare: join(repo, ".git"), sha };
}

describe("ensureOwnedStateRoot", () => {
    it("claims a fresh root with an ownership marker outside any snapshot", () => {
        const parent = tempDir("ext-owned-parent-");
        const root = join(parent, "state");
        const paths = ensureOwnedStateRoot(root);
        expect(paths.root).toBe(realpathSync(root));
        const marker = JSON.parse(readFileSync(join(paths.root, ".smartread-owned-state.json"), "utf8")) as {
            owner: string;
            version: number;
            canonicalRoot: string;
            nonce: string;
            createdAt: string;
        };
        // Root-bound provenance written by THIS program, outside any snapshot.
        expect(marker.owner).toBe(EXTERNAL_STATE_OWNER);
        expect(marker.version).toBe(1);
        expect(marker.canonicalRoot).toBe(paths.root);
        expect(typeof marker.nonce).toBe("string");
        expect(marker.nonce.length).toBeGreaterThanOrEqual(16);
        expect(typeof marker.createdAt).toBe("string");
        // Exclusive regular non-link marker, mode 0600 (POSIX).
        const markerStat = lstatSync(join(paths.root, ".smartread-owned-state.json"));
        expect(markerStat.isSymbolicLink()).toBe(false);
        expect(markerStat.isFile()).toBe(true);
        if (process.platform !== "win32") {
            expect(statSync(join(paths.root, ".smartread-owned-state.json")).mode & 0o777).toBe(0o600);
        }
        for (const dir of [paths.reposDir, paths.snapshotsDir, paths.multilingualDir, paths.multiSweBenchDir, paths.reportsDir]) {
            expect(existsSync(dir)).toBe(true);
        }
        // Re-claiming the same root is a no-op (same owner).
        expect(ensureOwnedStateRoot(root).root).toBe(paths.root);
    });

    it("refuses a foreign marker without deleting anything", () => {
        const root = tempDir("ext-owned-foreign-");
        writeFileSync(join(root, ".smartread-owned-state.json"), JSON.stringify({ owner: "someone-else" }));
        writeFileSync(join(root, "keep.txt"), "precious");
        expect(() => ensureOwnedStateRoot(root)).toThrow(/foreign-owned/);
        expect(existsSync(join(root, "keep.txt"))).toBe(true);
    });

    it("refuses a pre-existing directory with no marker, even when empty", () => {
        // Fresh-claim only: never adopt an existing dir for being empty.
        const empty = tempDir("ext-owned-empty-");
        expect(() => ensureOwnedStateRoot(empty)).toThrow(/foreign-owned state root \(no ownership marker\)/);
        expect(existsSync(empty)).toBe(true);
    });

    it("refuses a higher ancestor alias (whole-chain symlink check)", () => {
        const real = tempDir("ext-owned-real-");
        const aliasBase = tempDir("ext-owned-aliasbase-");
        const alias = join(aliasBase, "alias");
        symlinkSync(real, alias);
        expect(() => ensureOwnedStateRoot(join(alias, "state"))).toThrow(/symlink/);
    });

    it("refuses a non-empty root with no marker (never adopts then recreates)", () => {
        const root = tempDir("ext-owned-nonempty-");
        writeFileSync(join(root, "keep.txt"), "precious");
        expect(() => ensureOwnedStateRoot(root)).toThrow(/foreign-owned/);
        expect(existsSync(join(root, "keep.txt"))).toBe(true);
    });

    it("refuses a symlinked root", () => {
        const parent = tempDir("ext-owned-linkparent-");
        const real = join(parent, "real");
        mkdirSync(real, { recursive: true });
        const link = join(parent, "link");
        symlinkSync(real, link);
        expect(() => ensureOwnedStateRoot(link)).toThrow(/symlink/);
    });

    it("claims a fresh root whose parent chain does not exist yet", () => {
        const parent = tempDir("ext-owned-chain-");
        const root = join(parent, "a", "b", "state");
        const paths = ensureOwnedStateRoot(root);
        expect(paths.root).toBe(realpathSync(root));
        expect(existsSync(join(paths.root, EXTERNAL_STATE_MARKER))).toBe(true);
    });
});

describe("path containment", () => {
    it("keeps owned subdirs inside the root and rejects escapes", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        expect(bareRepoDirUnder(root, "acme/widget")).toContain("acme__widget.git");
        expect(() => bareRepoDirUnder(root, "../evil/x")).toThrow(/unsafe repo/);
        expect(() => snapshotDirUnder(root, "../evil")).toThrow(/unsafe instance_id/);
        expect(() => assertPathWithinRoot(root, join(root, "..", "escape"), "probe")).toThrow(/escapes/);
    });

    it("dataset helpers accept an owned base and never default to homedir when given one", () => {
        const { root } = freshRoot();
        const paths = ensureOwnedStateRoot(root);
        expect(cacheDir(paths.multilingualDir)).toBe(paths.multilingualDir);
        expect(multiSweBenchCacheDir(paths.multiSweBenchDir)).toBe(paths.multiSweBenchDir);
    });
});

describe("physical containment (no resolve-only aliases)", () => {
    it("refuses a path that escapes via a symlinked entry", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const outside = tempDir("ext-owned-outside-");
        const link = join(root, "repos", "alias-escape");
        symlinkSync(outside, link);
        expect(() => assertPathWithinRoot(root, join(link, "x"), "probe")).toThrow(/symlink|escapes/);
        rmSync(link);
    });
});

describe("offline never touches the network", () => {
    it("ensureBareClone with offline fails before cloning a missing repo", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        expect(() => ensureBareClone("acme/widget", { stateRoot: root, offline: true })).toThrow(/--offline: missing bare clone/);
        expect(existsSync(join(root, "repos", "acme__widget.git", "HEAD"))).toBe(false);
    });
});

describe("bootstrap authorization leaves foreign state untouched", () => {
    const POSIX = process.platform !== "win32";
    const markerPath = (root: string): string => join(root, EXTERNAL_STATE_MARKER);
    const modeOf = (p: string): number => statSync(p).mode & 0o777;
    function fingerprintTree(dir: string): string {
        const h = createHash("sha256");
        const walk = (d: string): void => {
            for (const n of readdirSync(d).sort()) {
                const p = join(d, n);
                const st = lstatSync(p);
                h.update(n);
                h.update(String(st.mode & 0o7777));
                if (st.isSymbolicLink()) h.update(readlinkSync(p));
                else if (st.isFile()) h.update(readFileSync(p));
                else if (st.isDirectory()) walk(p);
            }
        };
        walk(dir);
        return h.digest("hex");
    }
    function validMarker(root: string): Record<string, unknown> {
        return {
            owner: EXTERNAL_STATE_OWNER,
            version: 1,
            canonicalRoot: realpathSync(root),
            nonce: "0123456789abcdef",
            createdAt: new Date(0).toISOString(),
        };
    }
    function withHooks<T>(patch: Partial<typeof externalStateFsHooks>, fn: () => T): T {
        const saved = { ...externalStateFsHooks };
        Object.assign(externalStateFsHooks, patch);
        try {
            return fn();
        } finally {
            Object.assign(externalStateFsHooks, saved);
        }
    }

    it("refuses a root that appears between the missing check and the claim", () => {
        // Deterministic seam: the mkdirSync hook creates the leaf AFTER the
        // ENOENT check, then our non-recursive exclusive claim must hit EEXIST
        // and treat the root as pre-existing (marker-required), never ours.
        const { root } = freshRoot();
        let raced = false;
        const racingMkdir = ((p: string, options?: Parameters<typeof mkdirSync>[1]) => {
            if (!raced && p === root) {
                raced = true;
                mkdirSync(p);
                if (POSIX) chmodSync(p, 0o755);
                writeFileSync(join(p, "foreign.txt"), "raced");
            }
            return mkdirSync(p, options);
        }) as typeof mkdirSync;
        expect(() => withHooks({ mkdirSync: racingMkdir }, () => ensureOwnedStateRoot(root))).toThrow(
            /no ownership marker/,
        );
        expect(raced).toBe(true);
        // Foreign root untouched: no adoption, no chmod, no marker, files kept.
        if (POSIX) expect(modeOf(root)).toBe(0o755);
        expect(readdirSync(root)).toEqual(["foreign.txt"]);
        expect(readFileSync(join(root, "foreign.txt"), "utf8")).toBe("raced");
        expect(existsSync(markerPath(root))).toBe(false);
    });

    it("refuses a pre-existing empty dir without changing its mode", () => {
        const root = tempDir("ext-owned-prefix-");
        if (POSIX) chmodSync(root, 0o750);
        const before = POSIX ? modeOf(root) : -1;
        expect(() => ensureOwnedStateRoot(root)).toThrow(/no ownership marker/);
        if (POSIX) expect(modeOf(root)).toBe(before);
        expect(readdirSync(root)).toEqual([]);
    });

    it.each([
        ["foreign owner", (root: string) => ({ ...validMarker(root), owner: "someone-else" })],
        ["version mismatch", (root: string) => ({ ...validMarker(root), version: 999 })],
        ["canonical-root mismatch", (root: string) => ({ ...validMarker(root), canonicalRoot: join(root, "elsewhere") })],
        ["short nonce", (root: string) => ({ ...validMarker(root), nonce: "short" })],
    ])("refuses a %s marker without mode/content/tree changes", (_label, shape) => {
        const root = tempDir("ext-owned-badmarker-");
        writeFileSync(markerPath(root), JSON.stringify(shape(root)));
        writeFileSync(join(root, "keep.txt"), "sentinel");
        if (POSIX) chmodSync(root, 0o750);
        const beforeMode = POSIX ? modeOf(root) : -1;
        const beforeMarker = readFileSync(markerPath(root));
        const beforeTree = fingerprintTree(root);
        const chmods: string[] = [];
        const recording = ((p: string, m: number) => {
            chmods.push(p);
            return chmodSync(p, m);
        }) as typeof chmodSync;
        expect(() => withHooks({ chmodSync: recording }, () => ensureOwnedStateRoot(root))).toThrow(
            /foreign-owned state root/,
        );
        // Refused before the scan: no marker/root chmod ever runs on a foreign marker.
        expect(chmods).toEqual([]);
        if (POSIX) expect(modeOf(root)).toBe(beforeMode);
        expect(readFileSync(markerPath(root)).equals(beforeMarker)).toBe(true);
        expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("sentinel");
        expect(fingerprintTree(root)).toBe(beforeTree);
    });

    it("refuses a malformed marker without mode/content changes", () => {
        const root = tempDir("ext-owned-malformed-");
        writeFileSync(markerPath(root), "{not-json");
        if (POSIX) chmodSync(root, 0o750);
        const beforeMode = POSIX ? modeOf(root) : -1;
        expect(() => ensureOwnedStateRoot(root)).toThrow(/foreign-owned state root/);
        if (POSIX) expect(modeOf(root)).toBe(beforeMode);
        expect(readFileSync(markerPath(root), "utf8")).toBe("{not-json");
    });

    it("refuses a symlinked marker without touching the link target", () => {
        const root = tempDir("ext-owned-marklink-");
        const outside = tempDir("ext-owned-marktarget-");
        const target = join(outside, "target.json");
        writeFileSync(target, JSON.stringify(validMarker(root)));
        const beforeTargetMode = POSIX ? modeOf(target) : -1;
        symlinkSync(target, markerPath(root));
        if (POSIX) chmodSync(root, 0o750);
        const beforeMode = POSIX ? modeOf(root) : -1;
        expect(() => ensureOwnedStateRoot(root)).toThrow(/foreign-owned state root/);
        expect(lstatSync(markerPath(root)).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, "utf8")).toBe(JSON.stringify(validMarker(root)));
        // The link target keeps its mode: chmod never followed the symlink.
        if (POSIX) expect(modeOf(target)).toBe(beforeTargetMode);
        if (POSIX) expect(modeOf(root)).toBe(beforeMode);
    });

    it("fails closed when the root chmod is injected to fail", () => {
        const { root } = freshRoot();
        const failing = () => {
            throw new Error("injected chmod failure");
        };
        expect(() => withHooks({ chmodSync: failing as typeof chmodSync }, () => ensureOwnedStateRoot(root))).toThrow(
            /injected chmod failure/,
        );
        // Recovery: with the real chmod back, the same fresh root bootstraps.
        const paths = ensureOwnedStateRoot(root);
        expect(paths.root).toBe(realpathSync(root));
    });

    it("fails closed when a managed-subdir chmod is injected to fail", () => {
        const { root } = freshRoot();
        const paths = ensureOwnedStateRoot(root);
        const realChmod = externalStateFsHooks.chmodSync;
        const selective = ((p: string, m: number) => {
            if (p === join(paths.root, "repos")) throw new Error("injected managed chmod failure");
            return realChmod(p, m);
        }) as typeof chmodSync;
        expect(() => withHooks({ chmodSync: selective }, () => ensureOwnedStateRoot(root))).toThrow(
            /injected managed chmod failure/,
        );
        // Valid marked state is retained and reusable after the failure.
        expect(ensureOwnedStateRoot(root).root).toBe(paths.root);
    });

    it("repairs a valid reused marker from 0644 back to 0600", () => {
        const { root } = freshRoot();
        const paths = ensureOwnedStateRoot(root);
        if (POSIX) {
            chmodSync(markerPath(paths.root), 0o644);
            expect(modeOf(markerPath(paths.root))).toBe(0o644);
        }
        // Reclaim is a valid-marker reuse, and the marker mode is re-asserted
        // (P1: the old fresh-only chmod left a reused 0644 marker world-readable).
        expect(ensureOwnedStateRoot(root).root).toBe(paths.root);
        if (POSIX) expect(modeOf(markerPath(paths.root))).toBe(0o600);
    });

    it("fails closed when the reused marker chmod is injected to fail (no root chmod follows)", () => {
        const { root } = freshRoot();
        const paths = ensureOwnedStateRoot(root);
        const chmods: string[] = [];
        const realChmod = externalStateFsHooks.chmodSync;
        const markerOnlyFailure = ((p: string, m: number) => {
            chmods.push(p);
            if (p === markerPath(paths.root)) throw new Error("injected marker chmod failure");
            return realChmod(p, m);
        }) as typeof chmodSync;
        expect(() => withHooks({ chmodSync: markerOnlyFailure }, () => ensureOwnedStateRoot(root))).toThrow(
            /injected marker chmod failure/,
        );
        // The marker chmod is the FIRST chmod on reuse: nothing (root or
        // managed dirs) was chmodded after it failed.
        expect(chmods).toEqual([markerPath(paths.root)]);
        // Valid marked state is retained and reusable once the hook is restored.
        expect(ensureOwnedStateRoot(root).root).toBe(paths.root);
    });

    it("cannot chmod an earlier child before a later scan fails", () => {
        const { root } = freshRoot();
        const paths = ensureOwnedStateRoot(root);
        if (POSIX) {
            chmodSync(paths.root, 0o750);
            chmodSync(paths.reposDir, 0o750);
        }
        const beforeRoot = POSIX ? modeOf(paths.root) : -1;
        const before = POSIX ? modeOf(paths.reposDir) : -1;
        symlinkSync(join(paths.root, "repos"), join(paths.snapshotsDir, "evil"));
        expect(() => ensureOwnedStateRoot(root)).toThrow(/symlink/);
        if (POSIX) {
            expect(modeOf(paths.root)).toBe(beforeRoot);
            expect(modeOf(paths.reposDir)).toBe(before);
        }
        expect(lstatSync(join(paths.snapshotsDir, "evil")).isSymbolicLink()).toBe(true);
    });

    it("no chmod (marker or root) precedes the managed scan on a fresh claim", () => {
        const { root } = freshRoot();
        const chmods: string[] = [];
        const recording = ((p: string, m: number) => {
            chmods.push(p);
            return chmodSync(p, m);
        }) as typeof chmodSync;
        const boom = () => {
            throw new Error("injected scan failure");
        };
        // Fresh claim: the exclusive marker write authorizes, then the managed
        // scan fails closed — before ANY chmod (marker or root) has run.
        expect(() =>
            withHooks({ chmodSync: recording, lstatSync: boom as typeof lstatSync }, () => ensureOwnedStateRoot(root)),
        ).toThrow(/fail-closed/);
        expect(chmods).toEqual([]);
        expect(existsSync(markerPath(root))).toBe(true);
    });

    it("fails closed on injected scan/stat errors instead of swallowing them", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const boom = () => {
            throw new Error("injected scan failure");
        };
        expect(() =>
            withHooks({ readdirSync: boom as typeof readdirSync }, () => ensureOwnedStateRoot(root)),
        ).toThrow(/fail-closed/);
        expect(() =>
            withHooks({ lstatSync: boom as typeof lstatSync }, () => ensureOwnedStateRoot(root)),
        ).toThrow(/fail-closed/);
        expect(ensureOwnedStateRoot(root).root).toBe(realpathSync(root));
    });
});

describe("bare clone routing is root-derived with the exact advertised path", () => {
    it("reuses a preseeded bare clone at the exact owned path offline (no network)", () => {
        const { root } = freshRoot();
        const paths = ensureOwnedStateRoot(root);
        const { bare } = localBareRepo();
        const dest = bareRepoDirUnder(root, "acme/widget");
        expect(dest).toBe(join(paths.reposDir, "acme__widget.git"));
        expect(dest).not.toContain(join("repos", "repos"));
        execFileSync("git", ["clone", "--bare", bare, dest], { stdio: "ignore" });
        const out = ensureBareClone("acme/widget", { stateRoot: root, offline: true });
        expect(out).toBe(dest);
        expect(existsSync(join(out, "HEAD"))).toBe(true);
    });

    it("does not nest a repos dir under reposDir for a missing clone", () => {
        const { root } = freshRoot();
        expect(() => ensureBareClone("acme/widget", { stateRoot: root, offline: true })).toThrow(/--offline/);
        expect(existsSync(join(root, "repos", "repos"))).toBe(false);
    });
});

describe("snapshot deletion guards", () => {
    it("refuses to recreate a foreign-planted snapshot dir and retains its files", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localBareRepo();
        const id = "guarded__instance-1";
        const snap = snapshotDirUnder(root, id);
        mkdirSync(snap, { recursive: true });
        writeFileSync(join(snap, "foreign.txt"), "not ours");
        expect(() =>
            materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [] }), {
                bareDir: bare,
                stateRoot: root,
            }),
        ).toThrow(/refuses-unowned-snapshot/);
        expect(readFileSync(join(snap, "foreign.txt"), "utf8")).toBe("not ours");
    });

    it("refuses a symlinked snapshot root", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localBareRepo();
        const id = "symlink__instance-1";
        const snap = snapshotDirUnder(root, id);
        const outside = tempDir("ext-owned-outside-");
        writeFileSync(join(outside, "x.txt"), "x");
        symlinkSync(outside, snap);
        expect(() =>
            materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [] }), {
                bareDir: bare,
                stateRoot: root,
            }),
        ).toThrow(/symlink/);
        expect(lstatSync(snap).isSymbolicLink()).toBe(true);
    });

    it("materializes from a local bare repo entirely under the owned root", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localBareRepo();
        const id = "owned__instance-1";
        const out = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("root" in out).toBe(true);
        if ("root" in out) {
            expect(realpathSync(out.root).startsWith(`${root}${sep}`)).toBe(true);
            expect(existsSync(join(out.root, "src", "a.ts"))).toBe(true);
        }
    });
});

    it("refuses a symlinked ownership marker (never a link)", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const markerPath = join(root, EXTERNAL_STATE_MARKER);
        const payload = readFileSync(markerPath, "utf8");
        rmSync(markerPath);
        symlinkSync(join(root, "reports"), markerPath);
        expect(() => ensureOwnedStateRoot(root)).toThrow(/foreign-owned/);
        // Marker symlink retained; restore to prove the root is still ours.
        rmSync(markerPath);
        writeFileSync(markerPath, payload, { mode: 0o600 });
        expect(ensureOwnedStateRoot(root).root).toBe(root);
    });

    it("refuses symlinked children and deeper entries under managed dirs", () => {
        const { root } = freshRoot();
        const paths = ensureOwnedStateRoot(root);
        const outside = tempDir("ext-owned-outside-");
        symlinkSync(outside, join(paths.reposDir, "evil"));
        expect(() => ensureOwnedStateRoot(root)).toThrow(/symlink/);
        rmSync(join(paths.reposDir, "evil"));
        mkdirSync(join(paths.snapshotsDir, "nested"), { recursive: true });
        symlinkSync(outside, join(paths.snapshotsDir, "nested", "deep-evil"));
        expect(() => ensureOwnedStateRoot(root)).toThrow(/symlink/);
        rmSync(join(paths.snapshotsDir, "nested", "deep-evil"));
        rmSync(join(paths.snapshotsDir, "nested"), { recursive: true });
        expect(ensureOwnedStateRoot(root).root).toBe(root);
    });

    it("refuses a snapshot whose marker commit mismatches (no deletion, files retained)", () => {
        const { sha, bare } = localBareRepo();
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const instance = makeInstance({ repo: "axios/axios", baseCommit: sha, goldFiles: ["src/a.ts"] });
        const first = materializeInstance(instance, { bareDir: bare, stateRoot: root });
        if ("excluded" in first) throw new Error("setup materialize excluded unexpectedly");
        expect(readFileSync(join(first.root, "src/a.ts"), "utf8")).toContain("const a = 1");
        const other = "f".repeat(40);
        const mismatched = makeInstance({ repo: "axios/axios", baseCommit: other, goldFiles: ["src/a.ts"] });
        expect(() => materializeInstance(mismatched, { bareDir: bare, stateRoot: root })).toThrow(
            /refuses-mismatched-snapshot/,
        );
        // Snapshot retained untouched: files AND the original marker survive.
        expect(readFileSync(join(first.root, "src/a.ts"), "utf8")).toContain("const a = 1");
        expect(readFileSync(join(first.root, ".snapshot-commit"), "utf8").trim()).toBe(sha);
    });

    it("refuses a symlinked snapshot marker (foreign, retained)", () => {
        const { sha, bare } = localBareRepo();
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const instance = makeInstance({ repo: "axios/axios", baseCommit: sha, goldFiles: ["src/a.ts"] });
        const first = materializeInstance(instance, { bareDir: bare, stateRoot: root });
        if ("excluded" in first) throw new Error("setup materialize excluded unexpectedly");
        const marker = join(first.root, ".snapshot-commit");
        const payload = readFileSync(marker, "utf8");
        rmSync(marker);
        symlinkSync(join(root, "reports"), marker);
        // The whole-tree symlink guard fires first (fail-closed, retained);
        // either refusal proves the foreign marker is never honored.
        expect(() => materializeInstance(instance, { bareDir: bare, stateRoot: root })).toThrow(
            /symlinked entry|refuses-unowned-snapshot/,
        );
        rmSync(marker);
        writeFileSync(marker, payload, { mode: 0o600 });
        const again = materializeInstance(instance, { bareDir: bare, stateRoot: root });
        if ("excluded" in again) throw new Error("re-materialize excluded unexpectedly");
        expect(again.root).toBe(first.root);
    });

describe("resolveExternalStateRoot", () => {
    it("prefers the explicit flag over the env fallback", () => {
        process.env.PI_SMARTREAD_EXTERNAL_STATE_ROOT = "/tmp/env-root";
        expect(resolveExternalStateRoot(null)).toBe("/tmp/env-root");
        expect(resolveExternalStateRoot("/tmp/flag-root")).toBe("/tmp/flag-root");
        expect(resolveExternalStateRoot(undefined)).toBe("/tmp/env-root");
    });
});

describe("owned campaign receipts (in-process, offline, own temps only)", () => {
    it("records a complete no-clean receipt: checkedRoots/planned/deleted bound the claim", async () => {
        const home = tempDir("ext-owned-campaign-home-");
        const prevHome = process.env.HOME;
        const prevProfile = process.env.USERPROFILE;
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            const { base, root } = freshRoot();
            const paths = ensureOwnedStateRoot(root);
            // Seed the OWNED dataset cache: one Multilingual page, offline-readable.
            const row = {
                instance_id: "axios__axios-1",
                repo: "axios/axios",
                base_commit: "0".repeat(40),
                problem_statement: "Fix crash\n\nBody text.",
                patch: "diff --git a/lib/axios.ts b/lib/axios.ts\n--- a/lib/axios.ts\n+++ b/lib/axios.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
            };
            writeFileSync(
                join(paths.multilingualDir, "rows-offset-0-length-100.json"),
                JSON.stringify({ rows: [row], total: 1 }),
            );
            const { instances } = rowsToInstances([row]);
            expect(instances).toHaveLength(1);
            // Sealed frozen manifest fixture (v2 dev/holdout, own temp file, never the cache).
            const frozen = buildDevHoldoutManifest({
                seed: "owned-campaign-test",
                datasets: [{ name: "swe-bench-multilingual", revision: "test-revision", license: "MIT" }],
                pilot: [],
                dev: instances,
                holdout: [],
                exclusions: [],
                holdoutRepoNote: "test fixture: no holdout",
            });
            const manifestPath = join(base, "freeze.json");
            writeFileSync(manifestPath, JSON.stringify(frozen, null, 2));
            const code = await runExternalGrepCli([
                "--manifest", manifestPath,
                "--split", "dev",
                "--state-root", root,
                "--accept-license-review",
                "--offline",
                "--limit", "1",
            ]);
            expect(code).toBe(0);
            const reports = readdirSync(paths.reportsDir).filter((f) => f.endsWith(".json"));
            expect(reports).toHaveLength(1);
            const report = JSON.parse(readFileSync(join(paths.reportsDir, reports[0] as string), "utf8")) as {
                state: { mode: string; stateRoot: string };
                inputs: { pinnedRefs: string[] };
                deletion: {
                    checkedRoots: string[];
                    planned: string[];
                    deleted: string[];
                    attempts?: Array<{ instanceId: string; root: string | null; stage: string; outcome: string; createdFresh: boolean | null }>;
                };
                excluded: Array<{ stage: string; reason: string; root: string | null; createdFresh: boolean | null }>;
            };
            // Owned mode, canonical roots, pinned refs.
            expect(report.state.mode).toBe("owned");
            expect(report.state.stateRoot).toBe(root);
            expect(report.inputs.pinnedRefs).toEqual([`axios/axios@${"0".repeat(40)}`]);
            // No-clean proof: nothing planned, nothing deleted. The missing
            // bare clone lands in `excluded` (offline, before any network)
            // and its attempted root is still a checked root.
            const attemptedClone = join(paths.reposDir, "axios__axios.git");
            expect(report.deletion).toEqual({
                checkedRoots: [attemptedClone],
                planned: [],
                deleted: [],
                // Additive attempts receipt: the offline clone throw is one owned
                // attempt with its stage and unknown-creation status.
                attempts: [
                    { instanceId: "axios__axios-1", root: attemptedClone, stage: "clone", outcome: "failed", createdFresh: null },
                ],
            });
            expect(report.excluded).toHaveLength(1);
            expect(report.excluded[0]?.stage).toBe("clone");
            expect(report.excluded[0]?.root).toBe(attemptedClone);
            expect(report.excluded[0]?.createdFresh).toBeNull();
            expect(report.excluded[0]?.reason).toMatch(/offline/);
            // Legacy caches under the (temp) HOME are untouched.
            expect(existsSync(join(home, ".cache", "pi-smartread-bench"))).toBe(false);
        } finally {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
            if (prevProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = prevProfile;
        }
    });
});

describe("CLI state-root plumbing (subprocess, temp HOME)", () => {
    const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    function runCli(extraArgs: string[], home: string): { status: number | null; stdout: string; stderr: string } {
        try {
            const stdout = execFileSync(TSX_BIN, ["scripts/eval/external/grep/run.ts", ...extraArgs], {
                cwd: REPO_ROOT,
                env: { ...process.env, HOME: home, USERPROFILE: home },
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                shell: process.platform === "win32",
            }) as string;
            return { status: 0, stdout, stderr: "" };
        } catch (error) {
            const err = error as { status?: number | null; stdout?: string; stderr?: string };
            return { status: err.status ?? null, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
        }
    }

    it("--help documents --state-root", () => {
        const home = tempDir("ext-owned-help-home-");
        const { status, stdout } = runCli(["--help"], home);
        expect(status).toBe(0);
        expect(stdout).toMatch(/--state-root/);
    });

    it("--state-root without --manifest fails before claiming any state", () => {
        const home = tempDir("ext-owned-cli-home-");
        const state = join(tempDir("ext-owned-cli-parent-"), "state");
        const { status, stderr } = runCli(["--state-root", state, "--offline"], home);
        expect(status).toBe(2);
        expect(stderr).toMatch(/requires --manifest/);
        expect(existsSync(state)).toBe(false);
        expect(existsSync(join(home, ".cache", "pi-smartread-bench"))).toBe(false);
    });

    it("a foreign state root fails closed without network or deletion", () => {
        const home = tempDir("ext-owned-foreign-home-");
        const state = tempDir("ext-owned-foreign-state-");
        writeFileSync(join(state, ".smartread-owned-state.json"), JSON.stringify({ owner: "someone-else" }));
        writeFileSync(join(state, "keep.txt"), "precious");
        const { status, stderr } = runCli(
            ["--manifest", "m.json", "--split", "dev", "--state-root", state, "--accept-license-review", "--offline"],
            home,
        );
        expect(status).toBe(2);
        expect(stderr).toMatch(/foreign-owned/);
        expect(readFileSync(join(state, "keep.txt"), "utf8")).toBe("precious");
        expect(existsSync(join(home, ".cache", "pi-smartread-bench"))).toBe(false);
    });

    it("missing value for --state-root is a usage error", () => {
        const home = tempDir("ext-owned-novalue-home-");
        const { status, stderr } = runCli(["--state-root"], home);
        expect(status).toBe(2);
        expect(stderr).toMatch(/requires a value/);
    });
});
