/**
 * Snapshot archive + materialization-receipt safety (Stage 2).
 *
 * Boundary-first: every fixture lives under a canonical (realpath) os
 * tmpdir owned by the test (never homedir, never the repo, never legacy
 * caches). All git fixtures are synthetic local repos created by the test
 * (test-only git objects, never worktree/source commits, no network, no
 * legacy pins, no benchmark APIs, no sealed labels).
 *
 * Archive authority is enforced BEFORE untar: a NUL-safe `git ls-tree`
 * preflight over the exact verified commit accepts safe in-tree symlinks
 * (120000) and gitlinks (160000/type commit, extracted as empty-directory
 * placeholders) per the owner decision of 2026-10-08 — escaping, absolute,
 * cyclic, or unresolvable links still refuse — and rejects unsupported
 * modes, unsafe or platform-escaping components, duplicates/prefix
 * collisions, and reserved completion-marker names BEFORE any
 * archive/extract/snapshot write, so a rejected tree invokes no tar and
 * leaves outside state (bytes AND mode) untouched. Post-extraction validation uses lstat (never follows links)
 * and the completion marker is exclusive (never written on an incomplete
 * phase). Nothing pre-existing is ever deleted, even an empty unmarked
 * snapshot dir. Every owned attempt returns a precise receipt
 * (root/creation/completed-stage/error); temp-cleanup failure never masks
 * the primary error. Platform-colliding paths (case/Unicode/full-fold-
 * equivalent on darwin/win32) refuse at preflight; the extracted entry inventory is
 * compared fail-closed against the preflight records on every platform;
 * and listing re-verifies directory identity after readdir (TOCTOU swaps
 * fail closed and enumerated names are never returned).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    OFFLINE_GIT_ALLOW_PROTOCOL,
    assertSafeExtractedTree,
    ensureOwnedStateRoot,
    expectedExtractionInventory,
    externalGitEnvHooks,
    externalStateFsHooks,
    gitSupportsNoLazyFetch,
    listSnapshotFiles,
    materializeInstance,
    platformCollidingPosition,
    snapshotDirUnder,
    validateSnapshotTreeRecords,
} from "../../../scripts/eval/external/grep/repos.js";
import type { BenchmarkInstance } from "../../../scripts/eval/external/grep/instance.js";
import type { ExternalStatePaths } from "../../../scripts/eval/external/grep/repos.js";

const SNAP_FLAGS = {
    tarCalls: 0,
    cloneCalls: 0,
    failTar: false,
    failMarkerWrite: false,
    failTempCleanup: false,
    archiveEnvs: [] as Array<NodeJS.ProcessEnv | undefined>,
};
(globalThis as unknown as { __snapFlags: typeof SNAP_FLAGS }).__snapFlags = SNAP_FLAGS;

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        execFileSync: ((...args: unknown[]) => {
            const flags = (globalThis as unknown as { __snapFlags: typeof SNAP_FLAGS }).__snapFlags;
            const [cmd, cmdArgs, options] = args as [string, unknown, unknown];
            if (cmd === "tar") {
                flags.tarCalls += 1;
                if (flags.failTar) throw new Error("injected tar failure");
            } else if (cmd === "git" && Array.isArray(cmdArgs) && cmdArgs.includes("archive")) {
                // Record the env owned-mode `git archive` ran with (network-mode contract).
                flags.archiveEnvs.push((options as { env?: NodeJS.ProcessEnv } | undefined)?.env);
            } else if (cmd === "git" && Array.isArray(cmdArgs) && cmdArgs.includes("clone")) {
                // Count clone invocations: the pin-preflight contract requires
                // ensureBareClone to never exec a `git clone` at all.
                flags.cloneCalls += 1;
            }
            return (actual.execFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.execFileSync,
    };
});

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        writeFileSync: ((...args: unknown[]) => {
            const flags = (globalThis as unknown as { __snapFlags: typeof SNAP_FLAGS }).__snapFlags;
            const p = String(args[0]);
            const normalized = p.split("\\").join("/");
            if (normalized.endsWith("/.snapshot-commit") && flags.failMarkerWrite) throw new Error("injected marker failure");
            return (actual.writeFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.writeFileSync,
        rmSync: ((...args: unknown[]) => {
            const flags = (globalThis as unknown as { __snapFlags: typeof SNAP_FLAGS }).__snapFlags;
            const p = String(args[0]);
            if (flags.failTempCleanup && p.includes("ext-grep-archive-")) throw new Error("injected temp cleanup failure");
            return (actual.rmSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.rmSync,
    };
});

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_SMARTREAD_EXTERNAL_STATE_ROOT;
});
beforeEach(() => {
    SNAP_FLAGS.tarCalls = 0;
    SNAP_FLAGS.cloneCalls = 0;
    SNAP_FLAGS.failTar = false;
    SNAP_FLAGS.failMarkerWrite = false;
    SNAP_FLAGS.failTempCleanup = false;
    SNAP_FLAGS.archiveEnvs.length = 0;
});

function tempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tmpRoots.push(dir);
    return dir;
}

function freshRoot(): { base: string; root: string } {
    const base = tempDir("ext-snap-state-");
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

function gitCommit(repo: string, message: string): void {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", message], {
        cwd: repo,
        stdio: "ignore",
    });
}

/** Synthetic local git repo; its .git dir serves as the bare repo (no network). */
function localWorkRepo(): { work: string; bare: string; sha: string } {
    const work = tempDir("ext-snap-fixture-");
    execFileSync("git", ["init"], { cwd: work, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
        cwd: work,
        stdio: "ignore",
    });
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
    gitCommit(work, "add a");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
    return { work, bare: join(work, ".git"), sha };
}

function headSha(work: string): string {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim();
}

function sentinel(root: string): { file: string; bytes: Buffer; mode: number } {
    const file = join(root, "sentinel.txt");
    writeFileSync(file, "outside-sentinel");
    const bytes = readFileSync(file);
    const mode = process.platform === "win32" ? -1 : statSync(file).mode & 0o777;
    return { file, bytes, mode };
}

function expectSentinelUnchanged(s: { file: string; bytes: Buffer; mode: number }): void {
    expect(readFileSync(s.file).equals(s.bytes)).toBe(true);
    if (process.platform !== "win32") expect(statSync(s.file).mode & 0o777).toBe(s.mode);
}

// Failed and excluded receipts retain partial roots; root presence is not success.
// `diagnose` is a thunk so probes run only when a failed/excluded message is built.
function successReceiptDetail(out: ReturnType<typeof materializeInstance>, diagnose: () => string = () => ""): string {
    if ("failed" in out) {
        return `expected snapshot success (completedStage=${out.completedStage.slice(0, 40)} error=${out.error.slice(0, 200)})${diagnose()}`;
    }
    if ("excluded" in out) return `expected snapshot success (excluded=${out.reason.slice(0, 200)})${diagnose()}`;
    return "expected snapshot success";
}

// win32-only receipt enrichment: spawnSync is unmocked here (the mock wraps
// execFileSync only), so probes never touch the tar mock counter; only enum
// tokens and numeric versions are emitted, never raw paths or process text.
function textOf(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
    return "";
}

function errnoCodeOf(error: unknown): string {
    if (error instanceof Error) {
        const errno = error as NodeJS.ErrnoException;
        return typeof errno.code === "string" ? errno.code : "unknown";
    }
    return "unknown";
}

/** Classify a resolved `where tar` line without ever logging the raw path. */
function classifyTarLocation(line: string): "system32" | "git" | "other" {
    const segments = line.split("\\").join("/").toLowerCase().split("/");
    if (segments.includes("system32")) return "system32";
    if (segments.includes("git")) return "git";
    return "other";
}

/** Tar implementation/version from numeric tokens only; unknown text stays "unknown". */
function parseTarImplementationVersion(output: string): string {
    const first = textOf(output).split(/\r?\n/)[0] ?? "";
    const bsdtar = /bsdtar\s+(\d+(?:\.\d+){0,3})/i.exec(first)?.[1];
    if (bsdtar !== undefined) {
        const libarchive = /libarchive\s+(\d+(?:\.\d+){0,3})/i.exec(first)?.[1];
        return libarchive === undefined ? `bsdtar:${bsdtar}` : `bsdtar:${bsdtar}:libarchive:${libarchive}`;
    }
    const gnu = /gnu tar\)?\s+(\d+(?:\.\d+){0,3})/i.exec(first)?.[1];
    return gnu === undefined ? "unknown" : `gnu:${gnu}`;
}

/** Parse `chcp` query output. Console observation only, never decoder proof. */
function parseConsoleCodePage(output: string): string {
    const code = /(\d{3,5})/.exec(textOf(output))?.[1] ?? "unknown";
    return `${code} (console observation only; not decoder proof)`;
}

type ProbeSpawnResult = { status: number | null; stdout: unknown; error?: unknown };
type ProbeSpawn = (
    cmd: string,
    args: string[],
    opts: { encoding: "utf8"; timeout: number; maxBuffer: number; windowsHide: boolean },
) => ProbeSpawnResult;

/** Bounded subprocess probe: query-only with explicit time AND memory bounds. */
function runBoundedProbe(cmd: string, args: string[], spawn: ProbeSpawn = (c, a, o) => spawnSync(c, a, o)): {
    status: string;
    stdout: string;
} {
    try {
        const res = spawn(cmd, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true });
        // Probe failures stay a bounded status string, never a product error.
        const status = res.error instanceof Error ? `error:${errnoCodeOf(res.error)}` : `status:${String(res.status)}`;
        return { status, stdout: textOf(res.stdout).slice(0, 200) };
    } catch (error) {
        return { status: `probe-threw:${errnoCodeOf(error)}`, stdout: "" };
    }
}

/**
 * Windows-only enrichment for failed/excluded positive-receipt messages.
 * Returns "" off win32 so other platforms see byte-identical messages.
 * `pre` carries pre-archive FS observations (booleans/error codes, never raw
 * paths). tar entries are ordered PATH candidates, not the certified binary.
 */
function windowsReceiptDiagnostic(pre: string): string {
    if (process.platform !== "win32") return "";
    const where = runBoundedProbe("where", ["tar"]);
    const classes = where.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map(classifyTarLocation)
        .filter((value, index, all) => all.indexOf(value) === index)
        .join(",")
        .slice(0, 40);
    const version = runBoundedProbe("tar", ["--version"]);
    const codepage = runBoundedProbe("chcp", []);
    const tarCandidates = (classes === "" ? `unavailable:${where.status}` : classes).slice(0, 40);
    return ` | win-diag(pre=[${pre.slice(0, 200)}]; tar-candidates=[${tarCandidates}]; tar=[${parseTarImplementationVersion(version.stdout)}:${version.status.slice(0, 40)}]; codepage=[${parseConsoleCodePage(codepage.stdout).slice(0, 100)}:${codepage.status.slice(0, 40)}])`;
}

describe("preflight rejects unsafe trees before any archive write", () => {
    it("rejects a symlink with an absolute target: no tar, no snapshot, outside state untouched", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const sent = sentinel(root);
        const { work, bare, sha: first } = localWorkRepo();
        void first;
        symlinkSync(join(work, "src", "a.ts"), join(work, "evil-link"));
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add symlink");
        const sha = headSha(work);
        const id = "symlinktree__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [] }), {
            bareDir: bare,
            stateRoot: root,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("preflight");
            expect(out.error).toMatch(/symlink|120000/);
            expect(out.createdFresh).toBe(false);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
        expectSentinelUnchanged(sent);
    });

    it("accepts a gitlink as an empty-directory placeholder (owner decision 2026-10-08)", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        // Mint a real local commit object to reference as a gitlink (no
        // submodule clone, no network: test-only git objects only).
        const subTree = execFileSync("git", ["write-tree"], { cwd: work, encoding: "utf8" }).trim();
        const subSha = execFileSync(
            "git",
            ["-c", "user.email=t@t", "-c", "user.name=t", "commit-tree", subTree, "-m", "sub"],
            { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        execFileSync("git", ["update-index", "--add", "--cacheinfo", "160000", subSha, "vendor/sub"], {
            cwd: work,
            stdio: "ignore",
        });
        gitCommit(work, "add gitlink");
        const sha = headSha(work);
        // Sanity: the synthetic commit really carries a gitlink record.
        const tree = execFileSync("git", ["--git-dir", bare, "ls-tree", "-r", sha], { encoding: "utf8" }) as string;
        expect(tree).toMatch(/160000 commit/);
        const id = "gitlink__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }), {
            bareDir: bare,
            stateRoot: root,
        });
        // Accepted: `git archive` emits an empty directory entry for the
        // gitlink, which extracts (and receipts) as an empty directory.
        expect("root" in out).toBe(true);
        if ("root" in out) {
            expect(out.preflightCounts).toEqual({ symlinks: 0, gitlinks: 1 });
            const sub = join(out.root, "vendor", "sub");
            expect(statSync(sub).isDirectory()).toBe(true);
            expect(readdirSync(sub)).toEqual([]);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(1);
        expect(existsSync(join(snapshotDirUnder(root, id), ".snapshot-commit"))).toBe(true);
    });

    it("rejects the reserved completion-marker name committed at the root", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        writeFileSync(join(work, ".snapshot-commit"), "poison");
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add reserved marker name");
        const sha = headSha(work);
        const id = "reservedmarker__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [] }), {
            bareDir: bare,
            stateRoot: root,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("preflight");
            expect(out.error).toMatch(/snapshot-commit|reserved/);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
    });

    it("rejects an unknown base commit before any snapshot write", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare } = localWorkRepo();
        const id = "badcommit__i-1";
        const out = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: "1".repeat(40), goldFiles: [] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("failed" in out).toBe(true);
        if ("failed" in out) expect(out.completedStage).toBe("preflight");
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
    });
});

describe("preflight record validator (raw metadata edge cases)", () => {
    it("rejects unsupported modes, duplicates, and prefix collisions", () => {
        const blob = (mode: string, path: string) => ({ mode, kind: "blob", path });
        expect(() => validateSnapshotTreeRecords([blob("100777", "x.sh")])).toThrow(/unsupported|mode/);
        expect(() => validateSnapshotTreeRecords([blob("100644", "a"), blob("100644", "a")])).toThrow(/duplicate/);
        expect(() =>
            validateSnapshotTreeRecords([
                { mode: "040000", kind: "tree", path: "d" },
                { mode: "040000", kind: "tree", path: "d" },
            ]),
        ).toThrow(/duplicate/);
        expect(() =>
            validateSnapshotTreeRecords([blob("100644", "a"), blob("100644", "a/b")]),
        ).toThrow(/prefix|collision/);
        expect(() =>
            validateSnapshotTreeRecords([
                { mode: "040000", kind: "tree", path: "d" },
                blob("100644", "d"),
            ]),
        ).toThrow(/duplicate|collision/);
        // Symlinks without a target reader fail closed (no silent accept).
        expect(() => validateSnapshotTreeRecords([{ mode: "120000", kind: "blob", path: "l" }])).toThrow(
            /symlink|120000/,
        );
        // Gitlinks are accepted as empty-directory placeholders (owner
        // decision 2026-10-08) and reported in the preflight counts.
        expect(validateSnapshotTreeRecords([{ mode: "160000", kind: "commit", path: "v/s" }])).toEqual({
            symlinks: 0,
            gitlinks: 1,
        });
        expect(() => validateSnapshotTreeRecords([blob("100644", "../escape")])).toThrow(/unsafe/);
        expect(() => validateSnapshotTreeRecords([blob("100644", "sub/.snapshot-commit")])).toThrow(/reserved/);
    });

    it("rejects blob/tree prefix collisions in either record order", () => {
        const tree = (path: string) => ({ mode: "040000", kind: "tree", path });
        const file = (path: string) => ({ mode: "100644", kind: "blob", path });
        // tree/blob: blob equal to an ancestor of a recorded tree (both orders).
        expect(() => validateSnapshotTreeRecords([tree("a/b"), file("a")])).toThrow(/prefix|collision/);
        expect(() => validateSnapshotTreeRecords([file("a"), tree("a/b")])).toThrow(/prefix|collision/);
        // blob/blob-child: file above/below file (both orders).
        expect(() => validateSnapshotTreeRecords([file("a"), file("a/b")])).toThrow(/prefix|collision/);
        expect(() => validateSnapshotTreeRecords([file("a/b"), file("a")])).toThrow(/prefix|collision/);
        // tree-child/blob: blob equal to an ancestor of a deeper recorded tree (both orders).
        expect(() => validateSnapshotTreeRecords([tree("a/b/c"), file("a")])).toThrow(/prefix|collision/);
        expect(() => validateSnapshotTreeRecords([file("a"), tree("a/b/c")])).toThrow(/prefix|collision/);
    });

    it("accepts a file under a tree in either record order (no over-rejection)", () => {
        const tree = { mode: "040000", kind: "tree", path: "src" };
        const file = { mode: "100644", kind: "blob", path: "src/a.ts" };
        expect(() => validateSnapshotTreeRecords([tree, file])).not.toThrow();
        expect(() => validateSnapshotTreeRecords([file, tree])).not.toThrow();
    });

    it("accepts ordinary files, executables, and tree entries", () => {
        expect(() =>
            validateSnapshotTreeRecords([
                { mode: "040000", kind: "tree", path: "src" },
                { mode: "100644", kind: "blob", path: "src/a.ts" },
                { mode: "100755", kind: "blob", path: "bin/run.sh" },
            ]),
        ).not.toThrow();
    });
});

describe("positive materialization preserves executables and odd names", () => {
    it("materializes executable files and odd names (platform-valid names)", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        // Windows forbids control-character filenames; POSIX retains NUL-safe listing coverage.
        const oddNames =
            process.platform === "win32" ? ["sp ace.ts", "caf\u00e9.ts"] : ["tab\there.ts", "new\nline.ts"];
        for (const name of oddNames) writeFileSync(join(work, "src", name), `${name}\n`);
        writeFileSync(join(work, "run.sh"), "#!/bin/sh\necho hi\n");
        if (process.platform !== "win32") chmodSync(join(work, "run.sh"), 0o755);
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add odd names");
        const sha = headSha(work);
        const id = "weirdnames__i-1";
        // Pre-archive precondition: the synthetic Unicode names exist before
        // archive/extract; presence booleans are captured for the diagnostic.
        for (const name of oddNames) expect(existsSync(join(work, "src", name))).toBe(true);
        const preUnicode = oddNames.map((name) => `${name.length}:${existsSync(join(work, "src", name)) ? "present" : "absent"}`).join(",");
        const out = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        // Lazy thunks: probes run only on win32 AND a failed/excluded receipt.
        expect("failed" in out, successReceiptDetail(out, () => windowsReceiptDiagnostic(`unicode-fixture=[${preUnicode}]`))).toBe(false);
        expect("excluded" in out, successReceiptDetail(out, () => windowsReceiptDiagnostic(`unicode-fixture=[${preUnicode}]`))).toBe(false);
        expect("root" in out).toBe(true);
        if ("root" in out) {
            for (const name of oddNames) expect(existsSync(join(out.root, "src", name))).toBe(true);
            expect(existsSync(join(out.root, "run.sh"))).toBe(true);
            if (process.platform !== "win32") {
                expect(statSync(join(out.root, "run.sh")).mode & 0o111).not.toBe(0);
            }
            expect(SNAP_FLAGS.tarCalls).toBe(1);
        }
    });

    it("succeeds with no gold files and never reports a false missing-gold exclusion", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        const out = materializeInstance(
            makeInstance({ instanceId: "nogold__i-1", baseCommit: sha, goldFiles: [] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("root" in out).toBe(true);
        expect("excluded" in out).toBe(false);
        expect("failed" in out).toBe(false);
    });
});

describe("owned snapshots require a canonical baseCommit pin", () => {
    it("'HEAD' is refused without any snapshot write and never reuses a stale marker", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare } = localWorkRepo();
        const id = "rawref__i-1";
        expect(() =>
            materializeInstance(makeInstance({ instanceId: id, baseCommit: "HEAD", goldFiles: ["src/a.ts"] }), {
                bareDir: bare,
                stateRoot: root,
            }),
        ).toThrow(/refuses-noncanonical-basecommit/);
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
        // Gate precedes marker reuse: even a pre-existing snapshot whose
        // marker holds a raw ref (pre-fix artifact) is never compared
        // against, adopted, or rewritten under a noncanonical pin.
        const staleId = "rawref-stale__i-1";
        const stale = snapshotDirUnder(root, staleId);
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, ".snapshot-commit"), "HEAD", { mode: 0o600 });
        expect(() =>
            materializeInstance(makeInstance({ instanceId: staleId, baseCommit: "HEAD", goldFiles: [] }), {
                bareDir: bare,
                stateRoot: root,
            }),
        ).toThrow(/refuses-noncanonical-basecommit/);
        expect(readdirSync(stale)).toEqual([".snapshot-commit"]);
        expect(readFileSync(join(stale, ".snapshot-commit"), "utf8")).toBe("HEAD");
        expect(SNAP_FLAGS.tarCalls).toBe(0);
    });

    it("an abbreviated sha is refused without any snapshot write", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        const id = "abbrev__i-1";
        expect(() =>
            materializeInstance(makeInstance({ instanceId: id, baseCommit: sha.slice(0, 12), goldFiles: [] }), {
                bareDir: bare,
                stateRoot: root,
            }),
        ).toThrow(/refuses-noncanonical-basecommit/);
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
    });

    it("an uppercase sha is refused without any snapshot write", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare } = localWorkRepo();
        const id = "upper__i-1";
        expect(() =>
            materializeInstance(
                makeInstance({ instanceId: id, baseCommit: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", goldFiles: [] }),
                { bareDir: bare, stateRoot: root },
            ),
        ).toThrow(/refuses-noncanonical-basecommit/);
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
    });

    it("a full lowercase sha writes the canonical marker and reuse compares it", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        const id = "canonical__i-1";
        const first = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("root" in first).toBe(true);
        expect(SNAP_FLAGS.tarCalls).toBe(1);
        const marker = join(snapshotDirUnder(root, id), ".snapshot-commit");
        expect(readFileSync(marker, "utf8").trim()).toBe(sha);
        // Reuse: canonical comparison against the stored marker, no re-archive.
        const second = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("root" in second).toBe(true);
        if ("root" in second) expect(second.createdFresh).toBe(false);
        expect(SNAP_FLAGS.tarCalls).toBe(1);
        // A different canonical pin mismatches the marker and is refused;
        // the stored marker keeps the original canonical value.
        expect(() =>
            materializeInstance(makeInstance({ instanceId: id, baseCommit: "e".repeat(40), goldFiles: ["src/a.ts"] }), {
                bareDir: bare,
                stateRoot: root,
            }),
        ).toThrow(/refuses-mismatched-snapshot/);
        expect(readFileSync(marker, "utf8").trim()).toBe(sha);
    });

    it("a full hex pin that peels to a different commit fails the preflight pin check", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "tag", "-a", "v1", "-m", "release"], {
            cwd: work,
            stdio: "ignore",
        });
        const tagSha = execFileSync("git", ["rev-parse", "v1"], { cwd: work, encoding: "utf8" }).trim();
        // Sanity: the annotated tag object id is canonical hex but is NOT
        // the commit it peels to via ^{commit}.
        expect(tagSha).toMatch(/^[0-9a-f]{40}$/);
        expect(tagSha).not.toBe(headSha(work));
        const id = "tagpeel__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: tagSha, goldFiles: [] }), {
            bareDir: bare,
            stateRoot: root,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("preflight");
            expect(out.error).toMatch(/refuses-noncanonical-basecommit/);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
    });
});

describe("incomplete phases keep precise receipts and retain partial state", () => {
    it("tar failure returns an extract-stage receipt: partial files retained, no marker", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        const id = "partialtar__i-1";
        SNAP_FLAGS.failTar = true;
        const out = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("extract");
            expect(out.error).toMatch(/injected tar failure/);
            expect(out.root).toBe(snapshotDirUnder(root, id));
            expect(out.createdFresh).toBe(true);
        }
        // Partial extraction is retained for inspection; no completion marker.
        expect(existsSync(snapshotDirUnder(root, id))).toBe(true);
        expect(existsSync(join(snapshotDirUnder(root, id), ".snapshot-commit"))).toBe(false);
    });

    it("marker failure returns a marker-stage receipt with the extracted tree retained", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        const id = "markerfail__i-1";
        SNAP_FLAGS.failMarkerWrite = true;
        const out = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("marker");
            expect(out.error).toMatch(/injected marker failure/);
            expect(out.createdFresh).toBe(true);
        }
        expect(existsSync(join(snapshotDirUnder(root, id), "src", "a.ts"))).toBe(true);
        expect(existsSync(join(snapshotDirUnder(root, id), ".snapshot-commit"))).toBe(false);
    });

    it("temp-cleanup failure after success is a cleanup-stage receipt, not a fake success", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        SNAP_FLAGS.failTempCleanup = true;
        const out = materializeInstance(
            makeInstance({ instanceId: "tmpclean__i-1", baseCommit: sha, goldFiles: ["src/a.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("cleanup-temp");
            expect(out.error).toMatch(/temp cleanup failure/);
        }
    });

    it("temp-cleanup failure keeps the primary error instead of masking it", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        SNAP_FLAGS.failTar = true;
        SNAP_FLAGS.failTempCleanup = true;
        const out = materializeInstance(
            makeInstance({ instanceId: "maskcheck__i-1", baseCommit: sha, goldFiles: ["src/a.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("extract");
            expect(out.error).toMatch(/injected tar failure/);
            expect(out.error).toMatch(/temp cleanup failure/);
        }
    });
});

describe("missing-gold exclusions carry receipts and reuse without deletion", () => {
    it("fresh and reused missing-gold roots report root/creation and retain files", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        const id = "missinggold__i-1";
        const first = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["lib/missing.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("excluded" in first).toBe(true);
        if ("excluded" in first) {
            expect(first.reason).toBe("missing-at-base");
            expect(first.missing).toEqual(["lib/missing.ts"]);
            expect(first.root).toBe(snapshotDirUnder(root, id));
            expect(first.createdFresh).toBe(true);
        }
        // Nothing deleted: the extracted tree and marker survive the exclusion.
        expect(existsSync(join(snapshotDirUnder(root, id), "src", "a.ts"))).toBe(true);
        expect(existsSync(join(snapshotDirUnder(root, id), ".snapshot-commit"))).toBe(true);
        const second = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["lib/missing.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("excluded" in second).toBe(true);
        if ("excluded" in second) {
            expect(second.root).toBe(snapshotDirUnder(root, id));
            expect(second.createdFresh).toBe(false);
        }
        // Successful reuse of the same marked root deletes nothing either.
        const reuse = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("root" in reuse).toBe(true);
        if ("root" in reuse) expect(reuse.createdFresh).toBe(false);
    });

    it("refuses a pre-existing empty unmarked snapshot without adopting or changing it", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { bare, sha } = localWorkRepo();
        const id = "emptyreuse__i-1";
        const snap = snapshotDirUnder(root, id);
        mkdirSync(snap, { recursive: true });
        if (process.platform !== "win32") chmodSync(snap, 0o750);
        const beforeMode = statSync(snap).mode;
        expect(() =>
            materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }), {
                bareDir: bare,
                stateRoot: root,
            }),
        ).toThrow(/refuses-unowned-snapshot/);
        expect(readdirSync(snap)).toEqual([]);
        expect(statSync(snap).mode).toBe(beforeMode);
        expect(SNAP_FLAGS.tarCalls).toBe(0);
    });
});

describe("owned archive honors the run's network mode (blob:none promisor residual)", () => {
    /** file:// URL forces the upload-pack transport where
     *  uploadpack.allowFilter applies (plain local clones ignore --filter). */
    function fileUrl(p: string): string {
        const unix = p.split("\\").join("/");
        return `file://${unix.startsWith("/") ? "" : "/"}${unix}`;
    }

    /** Fresh blob:none promisor clone of the local fixture; asserts the
     *  filter was honored so the promisor premise cannot silently vanish. */
    function promisorClone(work: string): string {
        execFileSync("git", ["-C", work, "config", "uploadpack.allowFilter", "true"], { stdio: "ignore" });
        const clone = join(tempDir("ext-snap-promisor-"), "clone.git");
        execFileSync("git", ["clone", "--bare", "--filter=blob:none", fileUrl(work), clone], { stdio: "ignore" });
        const promisor = execFileSync("git", ["--git-dir", clone, "config", "--get", "remote.origin.promisor"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }) as string;
        expect(promisor.trim()).toBe("true");
        return clone;
    }

    /** Local object ids only: enumerates what is on disk and never fetches
     *  (unlike cat-file -e, which would hydrate a promisor on old gits). */
    function localObjects(clone: string): string {
        return execFileSync(
            "git",
            ["--git-dir", clone, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ) as string;
    }

    function blobOid(clone: string, commit: string): string {
        return (execFileSync("git", ["--git-dir", clone, "rev-parse", `${commit}:src/a.ts`], {
            encoding: "utf8",
        }) as string).trim();
    }

    /** Run fn with the git < 2.44 path forced (GIT_NO_LAZY_FETCH withheld) so
     *  the ALL-transport offline block is proven version-independent on every
     *  installed git — the regression must not be it.runIf-gated. */
    function withForcedOldGit<T>(fn: () => T): T {
        const saved = externalGitEnvHooks.supportsNoLazyFetch;
        externalGitEnvHooks.supportsNoLazyFetch = () => false;
        try {
            return fn();
        } finally {
            externalGitEnvHooks.supportsNoLazyFetch = saved;
        }
    }

    it("offline: missing blobs fail loudly at archive — no tar, no snapshot dir", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, sha } = localWorkRepo();
        const clone = promisorClone(work);
        const blob = blobOid(clone, sha);
        expect(localObjects(clone)).not.toContain(blob);
        // Unreachable origin: even where a protocol is allowed no fetch can
        // succeed, so the failure stays network-free on every git version.
        execFileSync(
            "git",
            ["--git-dir", clone, "remote", "set-url", "origin", join(tempDir("ext-snap-nopromisor-"), "missing.git")],
            { stdio: "ignore" },
        );
        const id = "offlineblob__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }), {
            bareDir: clone,
            stateRoot: root,
            offline: true,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("archive");
            expect(out.error).toMatch(/git archive failed/);
            expect(out.createdFresh).toBe(false);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
        const env = SNAP_FLAGS.archiveEnvs.at(-1);
        expect(env?.GIT_ALLOW_PROTOCOL).toBe(OFFLINE_GIT_ALLOW_PROTOCOL);
        expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
        if (gitSupportsNoLazyFetch()) expect(env?.GIT_NO_LAZY_FETCH).toBe("1");
    });

    it("offline: never lazy-fetches from a reachable local promisor (pre-2.44 path forced)", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, sha } = localWorkRepo();
        const clone = promisorClone(work); // origin stays the reachable local path
        const blob = blobOid(clone, sha);
        const id = "offlinelazy__i-1";
        // Force the git < 2.44 path (no GIT_NO_LAZY_FETCH honored) through the
        // seam: the ALL-transport block must hold version-independently, so
        // this regression runs on every installed git — never it.runIf.
        const out = withForcedOldGit(() =>
            materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }), {
                bareDir: clone,
                stateRoot: root,
                offline: true,
            }),
        );
        expect("failed" in out).toBe(true);
        if ("failed" in out) expect(out.completedStage).toBe("archive");
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
        // Old-git env proof: no GIT_NO_LAZY_FETCH, yet every transport blocked.
        const env = SNAP_FLAGS.archiveEnvs.at(-1);
        expect(env?.GIT_NO_LAZY_FETCH).toBeUndefined();
        expect(env?.GIT_ALLOW_PROTOCOL).toBe(OFFLINE_GIT_ALLOW_PROTOCOL);
        // Still absent: offline archived without hydrating anything.
        expect(localObjects(clone)).not.toContain(blob);
    });

    it("online: materialize hydrates a reachable local promisor and succeeds", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, sha } = localWorkRepo();
        const clone = promisorClone(work);
        const blob = blobOid(clone, sha);
        expect(localObjects(clone)).not.toContain(blob);
        const id = "onlineblob__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }), {
            bareDir: clone,
            stateRoot: root,
        });
        expect("root" in out).toBe(true);
        if ("root" in out) expect(out.root).toBe(snapshotDirUnder(root, id));
        expect(existsSync(join(snapshotDirUnder(root, id), "src", "a.ts"))).toBe(true);
        expect(SNAP_FLAGS.tarCalls).toBe(1);
        // The archive lazy-fetched the missing blob from the local promisor.
        expect(localObjects(clone)).toContain(blob);
        // Online archive env: https/file allowed (lazy fetch possible), no prompts.
        const env = SNAP_FLAGS.archiveEnvs.at(-1);
        expect(env?.GIT_ALLOW_PROTOCOL).toBe("https:file");
        expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
    });

    it("offline: a missing symlink target blob fails closed at preflight", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work } = localWorkRepo();
        symlinkSync("a.ts", join(work, "src", "link.ts"));
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add in-tree symlink");
        const sha = headSha(work);
        const clone = promisorClone(work);
        const linkBlob = (execFileSync("git", ["--git-dir", clone, "rev-parse", `${sha}:src/link.ts`], {
            encoding: "utf8",
        }) as string).trim();
        expect(localObjects(clone)).not.toContain(linkBlob);
        // Unreachable origin: even where a transport is allowed no fetch can
        // succeed, so an offline blob read must fail closed at preflight.
        execFileSync(
            "git",
            ["--git-dir", clone, "remote", "set-url", "origin", join(tempDir("ext-snap-nopromisor-"), "missing.git")],
            { stdio: "ignore" },
        );
        const id = "offline-linkblob__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/a.ts"] }), {
            bareDir: clone,
            stateRoot: root,
            offline: true,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            // The target blob is read DURING preflight (before any archive):
            // offline never reaches tar, never hydrates the blob.
            expect(out.completedStage).toBe("preflight");
            expect(out.error).toMatch(/cannot read symlink target blob/);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
        expect(localObjects(clone)).not.toContain(linkBlob);
    });
});

// ---------------------------------------------------------------------------
// Owner decision (2026-10-08, option 1): the 6 refused dev instances (5
// symlink-120000, 1 gitlink-160000) must materialize safely while matching
// legacy `git archive` output — symlinks stay symlinks, submodules become
// empty directories — and cases are never dropped.
// ---------------------------------------------------------------------------

describe("owner decision 2026-10-08: safe in-tree symlinks and gitlinks", () => {
    const OID = "a".repeat(40);
    const link = (path: string) => ({ mode: "120000", kind: "blob", path, oid: OID });
    const readTargets = (targets: Map<string, string>) => (record: { path: string }): string => {
        const target = targets.get(record.path);
        if (target === undefined) throw new Error(`no injected target for ${record.path}`);
        return target;
    };

    it("raw validator accepts a relative in-tree symlink and reports counts", () => {
        const counts = validateSnapshotTreeRecords([link("src/link.ts")], readTargets(new Map([["src/link.ts", "a.ts"]])));
        expect(counts).toEqual({ symlinks: 1, gitlinks: 0 });
        // In-tree directory target (svelte shape) also passes at raw level.
        expect(
            validateSnapshotTreeRecords([link("sites/p/static/s")],
                readTargets(new Map([["sites/p/static/s", "../../../packages/s"]]))),
        ).toEqual({ symlinks: 1, gitlinks: 0 });
    });

    it("raw validator refuses absolute, NUL, lexical-escape, chain-escape, and cycle targets", () => {
        expect(() =>
            validateSnapshotTreeRecords([link("src/link.ts")], readTargets(new Map([["src/link.ts", "/etc/passwd"]]))),
        ).toThrow(/absolute/);
        expect(() =>
            validateSnapshotTreeRecords([link("src/link.ts")], readTargets(new Map([["src/link.ts", "a\u0000b"]]))),
        ).toThrow(/NUL/);
        expect(() =>
            validateSnapshotTreeRecords([link("src/link.ts")], readTargets(new Map([["src/link.ts", "../../evil"]]))),
        ).toThrow(/lexically escapes/);
        // Chain escape: BOTH raw targets are lexically contained, but physical
        // resolution through `src/relay -> ..` pops above the snapshot root —
        // the lexical form alone would miss this.
        expect(() =>
            validateSnapshotTreeRecords(
                [link("src/relay"), link("src/deep/L")],
                readTargets(new Map([["src/relay", ".."], ["src/deep/L", "../relay/../../x"]])),
            ),
        ).toThrow(/chain escapes/);
        // Cycle: src/x -> src/y -> src/x (bounded hops refuse).
        expect(() =>
            validateSnapshotTreeRecords(
                [link("src/x"), link("src/y")],
                readTargets(new Map([["src/x", "y"], ["src/y", "x"]])),
            ),
        ).toThrow(/cycle|hops|40/);
    });

    it("in-tree relative symlink extracts as a symlink with receipt counts", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        // Docusaurus shape: sibling-template relative link.
        symlinkSync("a.ts", join(work, "src", "link.ts"));
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add in-tree symlink");
        const sha = headSha(work);
        const id = "insymlink__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: ["src/link.ts"] }), {
            bareDir: bare,
            stateRoot: root,
        });
        expect("root" in out).toBe(true);
        if ("root" in out) {
            expect(out.preflightCounts).toEqual({ symlinks: 1, gitlinks: 0 });
            const linkPath = join(out.root, "src", "link.ts");
            expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
            expect(readlinkSync(linkPath)).toBe("a.ts");
        }
        expect(SNAP_FLAGS.tarCalls).toBe(1);
        expect(existsSync(join(snapshotDirUnder(root, id), ".snapshot-commit"))).toBe(true);
        // Regression: a re-claim over the completed symlink-bearing snapshot
        // passes the managed-subtree scan (marker-gated snapshot content).
        expect(() => ensureOwnedStateRoot(root)).not.toThrow();
    });

    it("'../' escaping symlink is refused at preflight: no tar, no snapshot", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        symlinkSync("../../evil.ts", join(work, "src", "escape.ts"));
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add escaping symlink");
        const sha = headSha(work);
        const id = "escapesymlink__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [] }), {
            bareDir: bare,
            stateRoot: root,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("preflight");
            expect(out.error).toMatch(/lexically escapes/);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
    });

    it("symlink chain escaping through another in-tree link is refused at preflight", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        mkdirSync(join(work, "src", "deep"), { recursive: true });
        // src/relay -> ".." (points at the snapshot root: contained alone).
        symlinkSync("..", join(work, "src", "relay"));
        // Lexically contained, but physically walks through src/relay and
        // then pops above the root: the chain must refuse.
        symlinkSync("../relay/../../x", join(work, "src", "deep", "L"));
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add chained symlink");
        const sha = headSha(work);
        const id = "chainescape__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [] }), {
            bareDir: bare,
            stateRoot: root,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("preflight");
            expect(out.error).toMatch(/chain escapes/);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
    });

    it("symlink cycle is refused at preflight (bounded chain hops)", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        mkdirSync(join(work, "cy"));
        symlinkSync("y", join(work, "cy", "x"));
        symlinkSync("x", join(work, "cy", "y"));
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add cyclic symlinks");
        const sha = headSha(work);
        const id = "cyclelink__i-1";
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [] }), {
            bareDir: bare,
            stateRoot: root,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("preflight");
            expect(out.error).toMatch(/cycle|hops|40/);
        }
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, id))).toBe(false);
    });

    it("gold listing parity with legacy on a repo containing symlinks", () => {
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        // File link (docusaurus shape) + directory link (svelte shape).
        symlinkSync("a.ts", join(work, "src", "link.ts"));
        mkdirSync(join(work, "src", "sub"));
        writeFileSync(join(work, "src", "sub", "f.ts"), "export const f = 1;\n");
        symlinkSync("sub", join(work, "src", "dirlink"));
        execFileSync("git", ["add", "."], { cwd: work, stdio: "ignore" });
        gitCommit(work, "add links for parity");
        // Observed worktree dirlink status for the diagnostic: lstat/readlink
        // asserted; the stat outcome is recorded as-is, never claimed as passing.
        const dirlinkPath = join(work, "src", "dirlink");
        expect(lstatSync(dirlinkPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(dirlinkPath)).toBe("sub");
        let preDirlink: string;
        try {
            preDirlink = `readlink=sub isDir=${statSync(dirlinkPath).isDirectory()}`;
        } catch (error) {
            preDirlink = `readlink=sub stat-code=${errnoCodeOf(error)}`;
        }
        const sha = headSha(work);

        // LEGACY baseline (temp HOME; never the real cache): legacy lists a
        // file link's own path, and walks INTO a directory link.
        const home = tempDir("ext-snap-parity-home-");
        const prevHome = process.env.HOME;
        const prevProfile = process.env.USERPROFILE;
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            // Legacy walks the entire archive, hitting the restored dirlink's EPERM on Windows
            // even for file-link gold. Owned non-traversal checks below remain cross-platform.
            if (process.platform !== "win32") {
                const goldLink = materializeInstance(
                    makeInstance({ instanceId: "parity__legacy-link", baseCommit: sha, goldFiles: ["src/link.ts"] }),
                    bare,
                );
                expect("root" in goldLink).toBe(true);
                const goldViaDirLink = materializeInstance(
                    makeInstance({ instanceId: "parity__legacy-dirlink", baseCommit: sha, goldFiles: ["src/dirlink/f.ts"] }),
                    bare,
                );
                expect("root" in goldViaDirLink).toBe(true);
            }
        } finally {
            process.env.HOME = prevHome;
            process.env.USERPROFILE = prevProfile;
        }

        // OWNED: file-link gold passes with the link extracted as a symlink
        // (legacy parity for the entry legacy would list as a file).
        const owned = materializeInstance(
            makeInstance({ instanceId: "parity__owned-1", baseCommit: sha, goldFiles: ["src/link.ts", "src/sub/f.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        // Lazy thunks: probes run only on win32 AND a failed/excluded receipt.
        expect("failed" in owned, successReceiptDetail(owned, () => windowsReceiptDiagnostic(`work-dirlink: lstat-symlink=true ${preDirlink}`))).toBe(false);
        expect("excluded" in owned, successReceiptDetail(owned, () => windowsReceiptDiagnostic(`work-dirlink: lstat-symlink=true ${preDirlink}`))).toBe(false);
        expect("root" in owned).toBe(true);
        if ("root" in owned) {
            expect(lstatSync(join(owned.root, "src", "link.ts")).isSymbolicLink()).toBe(true);
            expect(lstatSync(join(owned.root, "src", "dirlink")).isSymbolicLink()).toBe(true);
        }
        // Documented parity rule: owned listing NEVER follows the directory
        // link, so gold through the link path is excluded (the same files are
        // reachable at their real path, which passes below — no content drop).
        const viaLink = materializeInstance(
            makeInstance({ instanceId: "parity__owned-2", baseCommit: sha, goldFiles: ["src/dirlink/f.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("excluded" in viaLink).toBe(true);
        if ("excluded" in viaLink) {
            expect(viaLink.reason).toBe("missing-at-base");
            expect(viaLink.missing).toEqual(["src/dirlink/f.ts"]);
        }
        const viaReal = materializeInstance(
            makeInstance({ instanceId: "parity__owned-3", baseCommit: sha, goldFiles: ["src/sub/f.ts"] }),
            { bareDir: bare, stateRoot: root },
        );
        expect("root" in viaReal).toBe(true);
    });
});

describe("run-loop receipts record failed and excluded roots (no success-only omission)", () => {
    const RUN_LOOP_SCENARIOS = [
        { scenario: "missing-gold", preseedClone: true, precreateSnapshotDir: false },
        { scenario: "clone-failure", preseedClone: false, precreateSnapshotDir: false },
        { scenario: "snapshot-refusal", preseedClone: true, precreateSnapshotDir: true },
    ] as const;

    type ReportAttempt = {
        instanceId: string;
        root: string | null;
        stage: string;
        outcome: string;
        createdFresh: boolean | null;
    };
    type CampaignReport = {
        deletion: {
            checkedRoots: string[];
            planned: string[];
            deleted: string[];
            attempts?: ReportAttempt[];
        };
        excluded: Array<{ reason: string; stage?: string; root?: string; createdFresh?: boolean | null }>;
        outcomes?: unknown[];
    };

    it.each(RUN_LOOP_SCENARIOS)(
        "$scenario exclusion lands in checkedRoots with root context",
        async ({ scenario, preseedClone, precreateSnapshotDir }) => {
            const home = tempDir("ext-snap-campaign-home-");
            const prevHome = process.env.HOME;
            const prevProfile = process.env.USERPROFILE;
            process.env.HOME = home;
            process.env.USERPROFILE = home;
            try {
                const { base, root } = freshRoot();
                const paths = ensureOwnedStateRoot(root);
                const { work } = localWorkRepo();
                const sha = headSha(work);
                if (preseedClone) {
                    // Preseed the owned bare clone from the synthetic local repo.
                    execFileSync(
                        "git",
                        ["clone", "--bare", join(work, ".git"), join(paths.root, "repos", "axios__axios.git")],
                        { stdio: "ignore" },
                    );
                }
                if (precreateSnapshotDir) {
                    // Unmarked empty snapshot dir: materialize must refuse it.
                    mkdirSync(join(paths.snapshotsDir, "axios__axios-1"));
                }
                const row = {
                    instance_id: "axios__axios-1",
                    repo: "axios/axios",
                    base_commit: sha,
                    problem_statement: "Fix crash\n\nBody text.",
                    patch: "diff --git a/lib/missing.ts b/lib/missing.ts\n--- a/lib/missing.ts\n+++ b/lib/missing.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
                };
                writeFileSync(
                    join(paths.multilingualDir, "rows-offset-0-length-100.json"),
                    JSON.stringify({ rows: [row], total: 1 }),
                );
                const { buildDevHoldoutManifest } = await import("../../../scripts/eval/external/grep/sampling.js");
                const frozen = buildDevHoldoutManifest({
                    seed: "snapshot-receipt-test",
                    datasets: [{ name: "swe-bench-multilingual", revision: "test-revision", license: "MIT" }],
                    pilot: [],
                    dev: [
                        {
                            instanceId: "axios__axios-1",
                            repo: "axios/axios",
                            baseCommit: sha,
                            dataset: "swe-bench-multilingual",
                            language: "ts",
                            split: "dev",
                            license: "MIT",
                            excludedFiles: [],
                            title: "Fix crash",
                            body: "Body text.",
                            goldFiles: ["lib/missing.ts"],
                            goldHunks: [],
                        },
                    ],
                    holdout: [],
                    exclusions: [],
                    holdoutRepoNote: "test fixture: no holdout",
                });
                const manifestPath = join(base, "freeze.json");
                writeFileSync(manifestPath, JSON.stringify(frozen, null, 2));
                const { runExternalGrepCli } = await import("../../../scripts/eval/external/grep/run.js");
                const code = await runExternalGrepCli([
                    "--manifest", manifestPath,
                    "--split", "dev",
                    "--state-root", root,
                    "--accept-license-review",
                    "--offline",
                    "--limit", "1",
                ]);
                // Excluded instances never fail the campaign: run.ts records
                // them in the report and returns 0 after writing it (only
                // parse errors, owned-root errors, and outer failures return 2).
                expect(code).toBe(0);
                const reports = readdirSync(paths.reportsDir).filter((f) => f.endsWith(".json"));
                expect(reports).toHaveLength(1);
                const report = JSON.parse(readFileSync(join(paths.reportsDir, reports[0] as string), "utf8")) as CampaignReport;
                expect(report.deletion.planned).toEqual([]);
                expect(report.deletion.deleted).toEqual([]);
                expect(report.excluded).toHaveLength(1);
                const cloneRoot = join(paths.reposDir, "axios__axios.git");
                if (scenario === "clone-failure") {
                    // ensureBareClone threw before any materialize: the attempted
                    // clone root is still receipted, creation status unknown.
                    expect(report.deletion.checkedRoots).toEqual([cloneRoot]);
                    expect(report.excluded[0]).toMatchObject({
                        stage: "clone",
                        root: cloneRoot,
                        createdFresh: null,
                    });
                    expect(report.excluded[0]?.reason).toMatch(/^materialize-error:/);
                    // Attempts receipt: same root/stage with the throw outcome.
                    expect(report.deletion.attempts).toEqual([
                        { instanceId: "axios__axios-1", root: cloneRoot, stage: "clone", outcome: "failed", createdFresh: null },
                    ]);
                } else if (scenario === "snapshot-refusal") {
                    // materializeInstance refused the pre-existing unmarked dir:
                    // receipted, and the dir is retained untouched (still empty).
                    const snapshotRoot = realpathSync(join(root, "snapshots", "axios__axios-1"));
                    expect(report.deletion.checkedRoots).toEqual([snapshotRoot]);
                    expect(report.excluded[0]).toMatchObject({
                        stage: "materialize",
                        root: snapshotRoot,
                        createdFresh: null,
                    });
                    expect(report.excluded[0]?.reason).toMatch(/refuses-unowned-snapshot/);
                    expect(readdirSync(join(root, "snapshots", "axios__axios-1"))).toEqual([]);
                    // Attempts receipt: explicit refusal outcome, creation unknown.
                    expect(report.deletion.attempts).toEqual([
                        { instanceId: "axios__axios-1", root: snapshotRoot, stage: "materialize", outcome: "refused", createdFresh: null },
                    ]);
                } else {
                    // The excluded (missing-gold) snapshot is still a checked root.
                    const snapshotRoot = realpathSync(join(root, "snapshots", "axios__axios-1"));
                    expect(report.deletion.checkedRoots).toEqual([snapshotRoot]);
                    expect(report.excluded[0]).toMatchObject({
                        reason: "missing-at-base",
                        root: snapshotRoot,
                        createdFresh: true,
                    });
                    // Attempts receipt: exclusion with the fresh-creation fact
                    // that checkedRoots alone cannot express.
                    expect(report.deletion.attempts).toEqual([
                        { instanceId: "axios__axios-1", root: snapshotRoot, stage: "materialize", outcome: "excluded", createdFresh: true, preflightCounts: { symlinks: 0, gitlinks: 0 } },
                    ]);
                }
            } finally {
                if (prevHome === undefined) delete process.env.HOME;
                else process.env.HOME = prevHome;
                if (prevProfile === undefined) delete process.env.USERPROFILE;
                else process.env.USERPROFILE = prevProfile;
            }
        },
    );

    it("successful materializations land in deletion.attempts with stage and createdFresh", async () => {
        const home = tempDir("ext-snap-campaign-home-");
        const prevHome = process.env.HOME;
        const prevProfile = process.env.USERPROFILE;
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            const { base, root } = freshRoot();
            const paths = ensureOwnedStateRoot(root);
            const { work } = localWorkRepo();
            const sha = headSha(work);
            // Preseed the owned bare clone from the synthetic local repo:
            // the success path runs fully offline (no network).
            execFileSync(
                "git",
                ["clone", "--bare", join(work, ".git"), join(paths.root, "repos", "axios__axios.git")],
                { stdio: "ignore" },
            );
            // Gold src/a.ts exists at base, so materialization succeeds.
            const row = {
                instance_id: "axios__axios-1",
                repo: "axios/axios",
                base_commit: sha,
                problem_statement: "Fix crash\n\nBody text.",
                patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
            };
            writeFileSync(
                join(paths.multilingualDir, "rows-offset-0-length-100.json"),
                JSON.stringify({ rows: [row], total: 1 }),
            );
            const { buildDevHoldoutManifest } = await import("../../../scripts/eval/external/grep/sampling.js");
            const frozen = buildDevHoldoutManifest({
                seed: "snapshot-receipt-test",
                datasets: [{ name: "swe-bench-multilingual", revision: "test-revision", license: "MIT" }],
                pilot: [],
                dev: [
                    {
                        instanceId: "axios__axios-1",
                        repo: "axios/axios",
                        baseCommit: sha,
                        dataset: "swe-bench-multilingual",
                        language: "ts",
                        split: "dev",
                        license: "MIT",
                        excludedFiles: [],
                        title: "Fix crash",
                        body: "Body text.",
                        goldFiles: ["src/a.ts"],
                        goldHunks: [],
                    },
                ],
                holdout: [],
                exclusions: [],
                holdoutRepoNote: "test fixture: no holdout",
            });
            const manifestPath = join(base, "freeze.json");
            writeFileSync(manifestPath, JSON.stringify(frozen, null, 2));
            const { runExternalGrepCli } = await import("../../../scripts/eval/external/grep/run.js");
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
            const report = JSON.parse(readFileSync(join(paths.reportsDir, reports[0] as string), "utf8")) as CampaignReport;
            const snapshotRoot = realpathSync(join(root, "snapshots", "axios__axios-1"));
            expect(report.deletion.checkedRoots).toEqual([snapshotRoot]);
            expect(report.excluded).toEqual([]);
            // The success receipt carries the stage and fresh-creation fact
            // that checkedRoots alone cannot express.
            expect(report.deletion.attempts).toEqual([
                {
                    instanceId: "axios__axios-1",
                    root: snapshotRoot,
                    stage: "materialize",
                    outcome: "success",
                    createdFresh: true,
                    preflightCounts: { symlinks: 0, gitlinks: 0 },
                },
            ]);
            // Both default formulations (title, body) ran on the snapshot.
            expect(report.outcomes).toHaveLength(2);
        } finally {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
            if (prevProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = prevProfile;
        }
    });
});

describe("owned run loop refuses a noncanonical pin BEFORE ensureBareClone", () => {
    type PinReportAttempt = {
        instanceId: string;
        root: string | null;
        stage: string;
        outcome: string;
        createdFresh: boolean | null;
    };
    type PinCampaignReport = {
        deletion: {
            checkedRoots: string[];
            planned: string[];
            deleted: string[];
            attempts?: PinReportAttempt[];
        };
        excluded: Array<{
            instanceId?: string;
            reason?: string;
            stage?: string;
            root?: string | null;
            createdFresh?: boolean | null;
        }>;
    };

    /** One-instance owned campaign whose dataset row AND frozen-manifest entry
     *  pin baseCommit "HEAD", with NO preseeded bare clone under the state
     *  root. Returns the exit code, the parsed report, and the owned paths. */
    async function runPinCampaign(
        offline: boolean,
    ): Promise<{ code: number; report: PinCampaignReport; paths: ExternalStatePaths }> {
        const home = tempDir("ext-snap-pin-home-");
        const prevHome = process.env.HOME;
        const prevProfile = process.env.USERPROFILE;
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            const { base, root } = freshRoot();
            const paths = ensureOwnedStateRoot(root);
            const row = {
                instance_id: "axios__axios-1",
                repo: "axios/axios",
                base_commit: "HEAD",
                problem_statement: "Fix crash\n\nBody text.",
                patch:
                    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n",
            };
            writeFileSync(join(paths.multilingualDir, "rows-offset-0-length-100.json"), JSON.stringify({ rows: [row], total: 1 }));
            const { buildDevHoldoutManifest } = await import("../../../scripts/eval/external/grep/sampling.js");
            const frozen = buildDevHoldoutManifest({
                seed: "pin-preflight-test",
                datasets: [{ name: "swe-bench-multilingual", revision: "test-revision", license: "MIT" }],
                pilot: [],
                dev: [
                    {
                        instanceId: "axios__axios-1",
                        repo: "axios/axios",
                        baseCommit: "HEAD",
                        dataset: "swe-bench-multilingual",
                        language: "ts",
                        split: "dev",
                        license: "MIT",
                        excludedFiles: [],
                        title: "Fix crash",
                        body: "Body text.",
                        goldFiles: ["src/a.ts"],
                        goldHunks: [],
                    },
                ],
                holdout: [],
                exclusions: [],
                holdoutRepoNote: "test fixture: no holdout",
            });
            const manifestPath = join(base, "freeze.json");
            writeFileSync(manifestPath, JSON.stringify(frozen, null, 2));
            const { runExternalGrepCli } = await import("../../../scripts/eval/external/grep/run.js");
            const argv = [
                "--manifest",
                manifestPath,
                "--split",
                "dev",
                "--state-root",
                root,
                "--accept-license-review",
                "--limit",
                "1",
            ];
            if (offline) argv.push("--offline");
            const code = await runExternalGrepCli(argv);
            const reports = readdirSync(paths.reportsDir).filter((f) => f.endsWith(".json"));
            expect(reports).toHaveLength(1);
            const report = JSON.parse(readFileSync(join(paths.reportsDir, reports[0] as string), "utf8")) as PinCampaignReport;
            return { code, report, paths };
        } finally {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
            if (prevProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = prevProfile;
        }
    }

    /** Shared receipt assertions: the run exits 0, the "HEAD" pin is refused
     *  pre-clone with a preflight receipt, and neither repos/ nor snapshots/
     *  gained an entry (no clone write, no snapshot write, no git clone exec). */
    function expectPinRefusalReceipt(code: number, report: PinCampaignReport, paths: ExternalStatePaths): void {
        expect(code).toBe(0);
        expect(report.excluded).toHaveLength(1);
        const snapshotRoot = join(paths.snapshotsDir, "axios__axios-1");
        expect(report.excluded[0]).toMatchObject({
            instanceId: "axios__axios-1",
            reason: /^materialize-error:refuses-noncanonical-basecommit/,
            stage: "preflight",
            root: snapshotRoot,
            createdFresh: null,
        });
        expect(report.deletion.checkedRoots).toEqual([snapshotRoot]);
        expect(report.deletion.planned).toEqual([]);
        expect(report.deletion.deleted).toEqual([]);
        expect(report.deletion.attempts).toEqual([
            {
                instanceId: "axios__axios-1",
                root: snapshotRoot,
                stage: "preflight",
                outcome: "refused",
                createdFresh: null,
            },
        ]);
        // No state writes at all: both managed dirs stay empty.
        expect(readdirSync(paths.reposDir)).toEqual([]);
        expect(readdirSync(paths.snapshotsDir)).toEqual([]);
        // ensureBareClone never ran (no `git clone` exec), and no archive/tar
        // ever ran. The child-process mock is the spy: cloneCalls counts
        // every git clone invocation across the whole run.
        expect(SNAP_FLAGS.cloneCalls).toBe(0);
        expect(SNAP_FLAGS.tarCalls).toBe(0);
    }

    it("offline: a 'HEAD' pin is refused pre-clone with a preflight receipt and no state writes", async () => {
        const { code, report, paths } = await runPinCampaign(true);
        expectPinRefusalReceipt(code, report, paths);
    });

    it("online mode with every git transport forbidden: same refusal before any clone write or network access", async () => {
        // Online (no --offline) with the existing network-forbidden seam: the
        // GIT_ALLOW_PROTOCOL sentinel refuses ALL git transports, so a
        // regression that reaches ensureBareClone fails at the protocol gate
        // without touching the network — and cloneCalls catches it either way.
        const prevAllow = process.env.GIT_ALLOW_PROTOCOL;
        process.env.GIT_ALLOW_PROTOCOL = OFFLINE_GIT_ALLOW_PROTOCOL;
        try {
            const { code, report, paths } = await runPinCampaign(false);
            expectPinRefusalReceipt(code, report, paths);
        } finally {
            if (prevAllow === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
            else process.env.GIT_ALLOW_PROTOCOL = prevAllow;
        }
    });
});

// ---------------------------------------------------------------------------
// Dataset-failure receipts + frozen-manifest pin binding (run-loop receipts).
// ---------------------------------------------------------------------------

type DatasetCampaignReport = {
    inputs: { pinnedRefs: string[] };
    deletion: {
        checkedRoots: string[];
        planned: string[];
        deleted: string[];
        attempts?: Array<{
            instanceId: string;
            root: string | null;
            stage: string;
            outcome: string;
            createdFresh: boolean | null;
        }>;
    };
    excluded: Array<{
        instanceId?: string;
        reason?: string;
        stage?: string;
        dataset?: string;
        file?: string;
        pinned?: string;
        row?: string;
    }>;
    datasetFailures?: Array<{
        dataset: string;
        revision: string;
        file?: string;
        error: string;
        instanceIds: string[];
    }>;
    outcomes?: unknown[];
};

/**
 * One offline owned campaign from a frozen manifest over cached rows: the
 * written report is the receipt under test. `rows: []` leaves the owned
 * multilingual cache empty (the offline load fails); `onClaimed` runs after
 * the state-root claim, before the run (e.g. to preseed a bare clone).
 */
async function runOwnedManifestCampaign(opts: {
    rows: unknown[];
    datasets?: Array<{ name: string; revision: string; license: string }>;
    dev: BenchmarkInstance[];
    args?: string[];
    onClaimed?: (paths: ExternalStatePaths) => void;
}): Promise<{ code: number; report: DatasetCampaignReport; paths: ExternalStatePaths }> {
    const home = tempDir("ext-snap-dataset-home-");
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        const { base, root } = freshRoot();
        const paths = ensureOwnedStateRoot(root);
        if (opts.rows.length > 0) {
            writeFileSync(
                join(paths.multilingualDir, "rows-offset-0-length-100.json"),
                JSON.stringify({ rows: opts.rows, total: opts.rows.length }),
            );
        }
        if (opts.onClaimed) opts.onClaimed(paths);
        const { buildDevHoldoutManifest } = await import("../../../scripts/eval/external/grep/sampling.js");
        const frozen = buildDevHoldoutManifest({
            seed: "dataset-receipt-test",
            datasets: opts.datasets ?? [{ name: "swe-bench-multilingual", revision: "test-revision", license: "MIT" }],
            pilot: [],
            dev: opts.dev,
            holdout: [],
            exclusions: [],
            holdoutRepoNote: "test fixture: no holdout",
        });
        const manifestPath = join(base, "freeze.json");
        writeFileSync(manifestPath, JSON.stringify(frozen, null, 2));
        const { runExternalGrepCli } = await import("../../../scripts/eval/external/grep/run.js");
        const code = await runExternalGrepCli([
            "--manifest",
            manifestPath,
            "--split",
            "dev",
            "--state-root",
            root,
            "--accept-license-review",
            "--offline",
            ...(opts.args ?? []),
        ]);
        const reports = readdirSync(paths.reportsDir).filter((f) => f.endsWith(".json"));
        expect(reports).toHaveLength(1);
        const report = JSON.parse(
            readFileSync(join(paths.reportsDir, reports[0] as string), "utf8"),
        ) as DatasetCampaignReport;
        return { code, report, paths };
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevProfile;
    }
}

const SRC_PATCH =
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";

describe("owned dataset failures are receipted (stage dataset + datasetFailures)", () => {
    it("an empty offline cache excludes the selected id with per-loader datasetFailures receipts", async () => {
        const id = "axios__axios-1";
        const { code, report, paths } = await runOwnedManifestCampaign({
            rows: [],
            dev: [
                makeInstance({ instanceId: id, repo: "axios/axios", baseCommit: "0".repeat(40), goldFiles: ["src/a.ts"] }),
            ],
        });
        // Excluded instances never fail the campaign; the drop is receipted.
        expect(code).toBe(0);
        expect(report.excluded).toEqual([{ instanceId: id, reason: "manifest-id-unresolved", stage: "dataset" }]);
        // The receipt is TOP-LEVEL and independent of deletion.attempts.
        expect(report.deletion).not.toHaveProperty("datasetFailures");
        expect(report.deletion.planned).toEqual([]);
        expect(report.deletion.deleted).toEqual([]);
        expect(report.deletion.attempts).toEqual([]);
        const failures = report.datasetFailures ?? [];
        const multilingual = failures.find((f) => f.dataset === "swe-bench-multilingual");
        expect(multilingual).toMatchObject({ revision: "unknown", instanceIds: [id] });
        expect(multilingual?.error).toMatch(/missing cached dataset page/);
        // Errors are truncated (loader messages carry no credentials).
        expect((multilingual?.error ?? "").length).toBeLessThanOrEqual(200);
        // The selected id is a swe-bench-multilingual manifest entry: NO
        // Multi-SWE-bench file failure may claim it (attribution follows
        // the frozen entry's dataset, not "every failed loader").
        const msb = failures.find((f) => f.dataset === "multi-swe-bench");
        expect(msb).toMatchObject({ file: "js/Kong__insomnia_dataset.jsonl", instanceIds: [] });
        expect(msb?.error).toMatch(/missing cached dataset file/);
        for (const f of failures) {
            if (f.dataset === "multi-swe-bench") expect(f.instanceIds).toEqual([]);
        }
        // Nothing was materialized or cloned.
        expect(readdirSync(paths.snapshotsDir)).toEqual([]);
        expect(readdirSync(paths.reposDir)).toEqual([]);
        expect(SNAP_FLAGS.cloneCalls).toBe(0);
    });

    it("a selected row that cannot be converted is excluded stage dataset with a conversion receipt", async () => {
        const id = "axios__axios-2";
        const row = {
            instance_id: id,
            repo: "axios/axios",
            base_commit: "0".repeat(40),
            problem_statement: "Fix docs\n\nBody text.",
            patch: "diff --git a/docs/guide.md b/docs/guide.md\n--- a/docs/guide.md\n+++ b/docs/guide.md\n@@ -1 +1 @@\n-old\n+new\n",
        };
        const { code, report } = await runOwnedManifestCampaign({
            rows: [row],
            dev: [
                makeInstance({
                    instanceId: id,
                    repo: "axios/axios",
                    baseCommit: "0".repeat(40),
                    goldFiles: ["docs/guide.md"],
                }),
            ],
        });
        expect(code).toBe(0);
        expect(report.excluded).toEqual([
            { instanceId: id, reason: "no-production-gold", stage: "dataset", dataset: "swe-bench-multilingual" },
        ]);
        const failures = report.datasetFailures ?? [];
        const conversion = failures.find((f) => f.dataset === "swe-bench-multilingual");
        expect(conversion).toMatchObject({ instanceIds: [id] });
        expect(conversion?.error).toMatch(/no-production-gold/);
        expect(conversion?.revision).toMatch(/^[0-9a-f]{64}$/);
        // Load-failure receipts (the Multi-SWE-bench files were attempted)
        // carry NO affected id: this row existed; its failure is the
        // conversion, not the load.
        for (const f of failures) {
            if (f.dataset === "multi-swe-bench") expect(f.instanceIds).toEqual([]);
        }
    });
});

describe("datasetFailures load-failure attribution follows the frozen manifest", () => {
    it("mixed-dataset selection attributes each unresolved id only to its own dataset's failed loader", async () => {
        const mlId = "axios__axios-1";
        const msbId = "kong__insomnia-1";
        const { code, report, paths } = await runOwnedManifestCampaign({
            rows: [],
            datasets: [
                { name: "swe-bench-multilingual", revision: "test-revision", license: "MIT" },
                { name: "multi-swe-bench", revision: "test-revision", license: "CC0 (D20)" },
            ],
            dev: [
                makeInstance({ instanceId: mlId, repo: "axios/axios", baseCommit: "0".repeat(40), goldFiles: ["src/a.ts"] }),
                makeInstance({
                    instanceId: msbId,
                    repo: "kong/insomnia",
                    baseCommit: "0".repeat(40),
                    goldFiles: ["src/a.ts"],
                    dataset: "multi-swe-bench",
                }),
            ],
        });
        expect(code).toBe(0);
        expect(report.excluded).toEqual([
            { instanceId: mlId, reason: "manifest-id-unresolved", stage: "dataset" },
            { instanceId: msbId, reason: "manifest-id-unresolved", stage: "dataset" },
        ]);
        const failures = report.datasetFailures ?? [];
        // Each failed loader lists ONLY the ids its frozen dataset could hold.
        const multilingual = failures.find((f) => f.dataset === "swe-bench-multilingual");
        expect(multilingual).toMatchObject({ instanceIds: [mlId] });
        // The Multi-SWE-bench id is attributed only to the failed file whose
        // repo mapping (`js/Kong__insomnia_dataset.jsonl` -> kong/insomnia)
        // matches the manifest entry.
        const kong = failures.find((f) => f.file === "js/Kong__insomnia_dataset.jsonl");
        expect(kong).toMatchObject({ dataset: "multi-swe-bench", instanceIds: [msbId] });
        expect(kong?.error).toMatch(/missing cached dataset file/);
        const otherMsb = failures.filter(
            (f) => f.dataset === "multi-swe-bench" && f.file !== "js/Kong__insomnia_dataset.jsonl",
        );
        expect(otherMsb.length).toBeGreaterThan(0);
        for (const f of otherMsb) expect(f.instanceIds).toEqual([]);
        // Nothing was materialized or cloned.
        expect(readdirSync(paths.snapshotsDir)).toEqual([]);
        expect(readdirSync(paths.reposDir)).toEqual([]);
        expect(SNAP_FLAGS.cloneCalls).toBe(0);
    });
});

describe("manifest pin binding: frozen repo/baseCommit wins over the dataset row", () => {
    it("pin-mismatch excludes with both values, pinnedRefs come from the manifest, no state writes", async () => {
        const shaRow = "a".repeat(40);
        const shaPinned = "f".repeat(40);
        const rows = [
            {
                instance_id: "axios__axios-1",
                repo: "axios/axios",
                base_commit: shaRow,
                problem_statement: "Fix crash\n\nBody text.",
                patch: SRC_PATCH,
            },
            {
                instance_id: "vuejs__core-1",
                repo: "vuejs/core",
                base_commit: shaRow,
                problem_statement: "Fix core\n\nBody text.",
                patch: SRC_PATCH,
            },
        ];
        // The frozen entries disagree with the cached rows: axios pins a
        // different commit, vuejs a different repo. The manifest is the pin
        // authority — neither disagreeing value may be silently materialized.
        const dev = [
            makeInstance({ instanceId: "axios__axios-1", repo: "axios/axios", baseCommit: shaPinned, goldFiles: ["src/a.ts"] }),
            makeInstance({ instanceId: "vuejs__core-1", repo: "vuejs/vue-core", baseCommit: shaRow, goldFiles: ["src/a.ts"] }),
        ];
        const { code, report, paths } = await runOwnedManifestCampaign({ rows, dev });
        expect(code).toBe(0);
        expect(report.excluded).toHaveLength(2);
        const byId = new Map(report.excluded.map((e) => [e.instanceId, e]));
        expect(byId.get("axios__axios-1")).toMatchObject({
            reason: "pin-mismatch",
            stage: "dataset",
            pinned: `axios/axios@${shaPinned}`,
            row: `axios/axios@${shaRow}`,
        });
        expect(byId.get("vuejs__core-1")).toMatchObject({
            reason: "pin-mismatch",
            stage: "dataset",
            pinned: `vuejs/vue-core@${shaRow}`,
            row: `vuejs/core@${shaRow}`,
        });
        // Pinned refs are the frozen manifest values, never the row values.
        expect(report.inputs.pinnedRefs).toEqual([`axios/axios@${shaPinned}`, `vuejs/vue-core@${shaRow}`]);
        // Excluded BEFORE any clone or materialize: managed dirs stay empty.
        expect(readdirSync(paths.reposDir)).toEqual([]);
        expect(readdirSync(paths.snapshotsDir)).toEqual([]);
        expect(report.deletion.planned).toEqual([]);
        expect(report.deletion.deleted).toEqual([]);
        expect(report.deletion.attempts).toEqual([]);
        expect(SNAP_FLAGS.cloneCalls).toBe(0);
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        // The owned datasetFailures receipt indexes the disagreements too.
        const pinReceipts = (report.datasetFailures ?? []).filter((f) => f.error.includes("pin-mismatch"));
        expect(new Set(pinReceipts.flatMap((f) => f.instanceIds))).toEqual(
            new Set(["axios__axios-1", "vuejs__core-1"]),
        );
    });

    it("rows matching the frozen pins materialize: the gate is exact equality, no false positives", async () => {
        const { work, sha } = localWorkRepo();
        const row = {
            instance_id: "axios__axios-1",
            repo: "axios/axios",
            base_commit: sha,
            problem_statement: "Fix crash\n\nBody text.",
            patch: SRC_PATCH,
        };
        const dev = [
            makeInstance({ instanceId: "axios__axios-1", repo: "axios/axios", baseCommit: sha, goldFiles: ["src/a.ts"] }),
        ];
        const { code, report, paths } = await runOwnedManifestCampaign({
            rows: [row],
            dev,
            args: ["--limit", "1"],
            onClaimed: (p) => {
                // Preseed the owned bare clone: the success path runs offline.
                execFileSync("git", ["clone", "--bare", join(work, ".git"), join(p.reposDir, "axios__axios.git")], {
                    stdio: "ignore",
                });
            },
        });
        expect(code).toBe(0);
        expect(report.excluded).toEqual([]);
        expect(report.inputs.pinnedRefs).toEqual([`axios/axios@${sha}`]);
        expect(report.datasetFailures ?? []).toEqual([]);
        const snapshotRoot = realpathSync(join(paths.snapshotsDir, "axios__axios-1"));
        expect(report.deletion.checkedRoots).toEqual([snapshotRoot]);
        expect(report.deletion.attempts).toEqual([
            { instanceId: "axios__axios-1", root: snapshotRoot, stage: "materialize", outcome: "success", createdFresh: true, preflightCounts: { symlinks: 0, gitlinks: 0 } },
        ]);
        // Both default formulations (title, body) ran on the snapshot.
        expect(report.outcomes).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Blocking review P1-1/P1-2: platform path collisions (preflight), extracted
// entry inventory (post-extract, every platform), and listing TOCTOU.
// ---------------------------------------------------------------------------

describe("preflight refuses platform-colliding paths (P1-1a)", () => {
    /** Commit a synthetic root-level tree through git plumbing: a worktree
     *  can never hold colliding names on the very platforms where the
     *  refusal under test applies, and `mktree` writes raw tree bytes (no
     *  Unicode precomposition). Test-only git objects, local repo, no
     *  network. */
    function commitRootTree(work: string, paths: string[]): string {
        const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
            cwd: work,
            input: "collision\n",
            encoding: "utf8",
        }).trim();
        const input = paths.map((p) => `100644 blob ${oid}\t${p}`).join("\n") + "\n";
        const tree = execFileSync("git", ["mktree"], { cwd: work, input, encoding: "utf8" }).trim();
        return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit-tree", tree, "-m", "collide"], {
            cwd: work,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }

    const CASE_RECORDS = [
        { mode: "100644", kind: "blob", path: "Case/x" },
        { mode: "100644", kind: "blob", path: "case/y" },
    ];
    const NFC_NAME = "caf\u00e9.txt";
    const NFD_NAME = "cafe\u0301.txt";
    const UNICODE_RECORDS = [
        { mode: "100644", kind: "blob", path: NFC_NAME },
        { mode: "100644", kind: "blob", path: NFD_NAME },
    ];
    // Extraction on case-/normalization-insensitive filesystems (APFS,
    // NTFS) merges these; case-sensitive normalization-preserving
    // filesystems keep them, so the refusal is platform-scoped.
    const collidesHere = process.platform === "darwin" || process.platform === "win32";

    function expectRefusedAtPreflight(instanceId: string, sha: string, bare: string, root: string): void {
        const out = materializeInstance(makeInstance({ instanceId, baseCommit: sha, goldFiles: [] }), {
            bareDir: bare,
            stateRoot: root,
        });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("preflight");
            expect(out.error).toMatch(/platform-equivalent path collision/);
        }
        // Refused BEFORE any archive/extract/snapshot write.
        expect(SNAP_FLAGS.tarCalls).toBe(0);
        expect(existsSync(snapshotDirUnder(root, instanceId))).toBe(false);
    }

    it.runIf(collidesHere)("case-colliding names are refused at preflight (no tar, no snapshot)", () => {
        // Ancestor-level collision: `Case/x` and `case/y` differ as paths
        // but share the `Case`/`case` directory position.
        expect(() => validateSnapshotTreeRecords(CASE_RECORDS)).toThrow(/platform-equivalent path collision/);
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        const sha = commitRootTree(work, ["Case", "case"]);
        expectRefusedAtPreflight("casecollide__i-1", sha, bare, root);
    });

    it.runIf(collidesHere)("NFC/NFD-equivalent names are refused at preflight", () => {
        expect(() => validateSnapshotTreeRecords(UNICODE_RECORDS)).toThrow(/platform-equivalent path collision/);
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        const sha = commitRootTree(work, [NFC_NAME, NFD_NAME]);
        expectRefusedAtPreflight("unicodemerge__i-1", sha, bare, root);
    });

    it.runIf(!collidesHere)(
        "case-sensitive, normalization-preserving platforms keep both entries (refusal is platform-scoped)",
        () => {
            expect(() => validateSnapshotTreeRecords(CASE_RECORDS)).not.toThrow();
            expect(() => validateSnapshotTreeRecords(UNICODE_RECORDS)).not.toThrow();
        },
    );

    // Blocking review P1/P1-review-221b1088: NFC+toLowerCase missed these
    // because they are full-case-fold / post-lowercase-recomposition /
    // compatibility merges, not case or NFC/NFD pairs. Each pair was
    // probed empirically on this host (mkdtemp: create both names in ONE
    // directory, O_EXCL + readdir) — the 2,600-pair probe sweep (1,913
    // merged / 687 distinct / 0 write-errors) plus the 3,105-pair
    // re-sweep that adds the Latin half-ring/modifier family (1,381
    // merged / 1,724 distinct / 0 write-errors; final key: 0
    // merged-not-refused, 0 distinct-refused) — and merge on APFS.
    const FULL_FOLD_PAIRS: Array<[string, string]> = [
        ["σ.txt", "ς.txt"], // final sigma vs sigma
        ["Straße.ts", "Strasse.ts"], // ß vs ss
        ["ﬁle.ts", "file.ts"], // ﬁ ligature vs fi
        ["ϐ.txt", "β.txt"], // Greek variant beta vs beta (fold table)
        ["ϕ.txt", "φ.txt"], // Greek phi symbol vs phi (fold table)
        ["ŉ.txt", "\u02BCn.txt"], // modifier-apostrophe n (fold table)
        ["ǰ.txt", "j\u030C.txt"], // post-lowercase recomposition (suffix NFC)
        ["ᾳ.txt", "αι.txt"], // iota subscript vs alpha+iota (U+0345 fold)
        ["\u1F80.txt", "\u1F00\u03B9.txt"], // breathing+iota subscript expansion
        ["ẚ.txt", "A\u02BE.txt"], // review 95b9395a P1: U+1E9A vs A+right-half-ring
        ["ẚ.txt", "a\u02BE.txt"], // same merge, lowercase spelling
    ];

    it.runIf(process.platform === "darwin")("full-fold-equivalent names (σ/ς, ß/ss, ﬁ/fi, ϐ/β, ŉ, ǰ, ᾳ/αι, ẚ/ʾ) are refused at preflight", () => {
        for (const [a, b] of FULL_FOLD_PAIRS) {
            expect(() =>
                validateSnapshotTreeRecords([
                    { mode: "100644", kind: "blob", path: a },
                    { mode: "100644", kind: "blob", path: b },
                ]),
            ).toThrow(/platform-equivalent path collision/);
        }
        // End-to-end: refusal still fires inside materializeInstance
        // BEFORE any tar/extract/snapshot write.
        const { root } = freshRoot();
        ensureOwnedStateRoot(root);
        const { work, bare } = localWorkRepo();
        const sha = commitRootTree(work, FULL_FOLD_PAIRS.flat());
        expectRefusedAtPreflight("fullfold__i-1", sha, bare, root);
    });

    it.runIf(process.platform === "darwin")(
        "compatibility-equivalent names the filesystem keeps distinct are accepted (P2: fullwidth/lunate/roman)",
        () => {
            // Preflight must not refuse pairs APFS extracts as SEPARATE
            // entries (blanket NFKC did — blocking review P2).
            expect(() =>
                validateSnapshotTreeRecords([
                    { mode: "100644", kind: "blob", path: "Ａ.txt" },
                    { mode: "100644", kind: "blob", path: "A.txt" },
                    { mode: "100644", kind: "blob", path: "ϲ.txt" },
                    { mode: "100644", kind: "blob", path: "σ.txt" },
                    { mode: "100644", kind: "blob", path: "Ⅰ.txt" },
                    { mode: "100644", kind: "blob", path: "I.txt" },
                ]),
            ).not.toThrow();
            // End-to-end: extraction keeps BOTH members of the pair.
            const { root } = freshRoot();
            ensureOwnedStateRoot(root);
            const { work, bare } = localWorkRepo();
            const sha = commitRootTree(work, ["Ａ.txt", "A.txt"]);
            const out = materializeInstance(
                makeInstance({ instanceId: "distinct__i-1", baseCommit: sha, goldFiles: [] }),
                { bareDir: bare, stateRoot: root },
            );
            expect("root" in out).toBe(true);
            if ("root" in out) {
                expect(existsSync(join(out.root, "Ａ.txt"))).toBe(true);
                expect(existsSync(join(out.root, "A.txt"))).toBe(true);
            }
            expect(SNAP_FLAGS.tarCalls).toBe(1);
        },
    );
});

// Always-on (platform-independent): the collision-key function itself.
// The supported filesystems' equivalence rules are asserted directly —
// including negative controls, because macOS is case-insensitive but
// ACCENT-sensitive, and over-matching would refuse safe trees off the
// probed behavior.
describe("platformCollidingPosition covers the supported filesystems' equivalences", () => {
    const p = platformCollidingPosition;

    it("collides on full-fold and compatibility pairs that merge on darwin/win32", () => {
        // Full-case-fold (NFKC+toLowerCase does not reach these alone):
        expect(p("σ.txt")).toBe(p("ς.txt"));
        expect(p("Straße")).toBe(p("Strasse"));
        expect(p("ß")).toBe(p("ss"));
        expect(p("a\u0345")).toBe(p("aι")); // combining iota folds to ι
        // NFKC compatibility merges:
        expect(p("ﬁle.ts")).toBe(p("file.ts"));
        expect(p("ﬀx")).toBe(p("ffx"));
        // Canonical NFC/NFD and plain case (regression coverage):
        expect(p("caf\u00e9.txt")).toBe(p("cafe\u0301.txt"));
        expect(p("Case/x")).toBe(p("case/x"));
        // Probed merges folded explicitly (not via blanket NFKC):
        expect(p("µ")).toBe(p("μ")); // micro sign
        expect(p("ﬆ")).toBe(p("st")); // long-s t ligature
        // Review 221b1088 misses (2,600-pair FS probe): Greek symbol
        // variants toLowerCase leaves unfolded — fold-table entries.
        expect(p("ϐ")).toBe(p("β")); // variant beta vs beta
        expect(p("ϑ")).toBe(p("θ")); // variant theta vs theta
        expect(p("ϕ")).toBe(p("φ")); // phi symbol vs phi
        expect(p("ϖ")).toBe(p("π")); // pi symbol vs pi
        expect(p("ϰ")).toBe(p("κ")); // kappa symbol vs kappa
        expect(p("ϱ")).toBe(p("ρ")); // rho symbol vs rho
        expect(p("ϵ")).toBe(p("ε")); // lunate epsilon vs epsilon
        expect(p("ŉ")).toBe(p("\u02BCn")); // U+0149 vs modifier-apostrophe + n
        expect(p("ẛ")).toBe(p("ṡ")); // long-s with dot vs dotted s
        // Post-lowercase recomposition: toLowerCase creates compositions
        // the leading NFC never saw (suffix NFD→NFC), probed merged.
        expect(p("ǰ")).toBe(p("j\u030C")); // ǰ vs j + caron
        expect(p("ΐ")).toBe(p("\u03CA\u0301")); // ΐ vs ϊ + tonos (lowered)
        // Unicode full case folding of U+0345 (suffix U+0345→U+03B9).
        expect(p("ᾳ")).toBe(p("αι")); // ᾳ vs alpha + iota
        expect(p("ᾀ")).toBe(p("\u1F00\u03B9")); // ᾀ vs alpha-with-breathing + iota
        // Review 95b9395a P1 (Latin half-ring family re-sweep): U+1E9A
        // vs letter+U+02BE merge on darwin while the old keys differed.
        expect(p("ẚ")).toBe(p("a\u02BE")); // ẚ vs a + right half ring
        expect(p("ẚ")).toBe(p("A\u02BE")); // uppercase spelling of the same merge
    });

    it("does NOT collide accent-sensitive or unrelated names", () => {
        // macOS is case- but accent-sensitive: e vs é must stay apart.
        expect(p("café")).not.toBe(p("cafe"));
        expect(p("σ")).not.toBe(p("s"));
        expect(p("œ")).not.toBe(p("oe"));
        expect(p("İ")).not.toBe(p("i")); // İ folds to i+U+0307, not bare i
        expect(p("src/a.ts")).not.toBe(p("src/b.ts"));
        // Compatibility chars this filesystem keeps DISTINCT (all probed
        // on darwin); blanket NFKC collided them (blocking review P2).
        expect(p("Ａ")).not.toBe(p("A")); // fullwidth A
        expect(p("ϲ")).not.toBe(p("σ")); // lunate sigma vs sigma
        expect(p("Ⅰ")).not.toBe(p("I")); // roman numeral I
        expect(p("①")).not.toBe(p("1")); // circled 1
        expect(p("²")).not.toBe(p("2")); // superscript 2
        // Probe-confirmed distinct: only the U+02BC spelling folds with
        // ŉ; the ASCII-apostrophe spelling stays separate (and distinct
        // from U+02BC too).
        expect(p("ŉ")).not.toBe(p("'n"));
        expect(p("\u02BCn")).not.toBe(p("'n"));
        // Latin half-ring family controls (3,105-pair re-sweep): only
        // the letter+U+02BE pair with U+1E9A merged; the other
        // modifiers and other base letters stayed distinct.
        expect(p("a\u02BC")).not.toBe(p("a\u02BE")); // modifier apostrophe vs right half ring
        expect(p("a\u0339")).not.toBe(p("a\u02BE")); // below-ring combining vs right half ring
        expect(p("b\u02BE")).not.toBe(p("ẚ")); // fold is letter-specific: b+half-ring ≠ ẚ
    });
});

describe("post-extract inventory verification fails closed (P1-1b)", () => {
    function fixtureDir(): string {
        const dir = join(tempDir("ext-inventory-"), "snap");
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "README.md"), "# r\n");
        writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
        symlinkSync("a.ts", join(dir, "src", "link.ts"));
        return dir;
    }

    const RECORDS = [
        { mode: "040000", kind: "tree", path: "src" },
        { mode: "100644", kind: "blob", path: "src/a.ts" },
        { mode: "120000", kind: "blob", path: "src/link.ts" },
        { mode: "100644", kind: "blob", path: "README.md" },
    ];

    it("accepts an inventory that matches the extracted entries exactly", () => {
        const dir = fixtureDir();
        expect(() => assertSafeExtractedTree(dir, expectedExtractionInventory(RECORDS))).not.toThrow();
    });

    it("fails closed on a missing (collapsed) entry — injected collapsed inventory", () => {
        const dir = fixtureDir();
        // What a case-/normalization-collapsing extraction would drop: the
        // preflight records contain a sibling the walk will not find. The
        // seam injects the collapsed expectation directly, so the check is
        // proven on every platform regardless of host filesystem behavior.
        const collapsed = expectedExtractionInventory([...RECORDS, { mode: "100644", kind: "blob", path: "src/A.ts" }]);
        expect(() => assertSafeExtractedTree(dir, collapsed)).toThrow(/inventory mismatch.*src\/A\.ts/);
    });

    it("fails closed on an extra (never-preflighted) entry", () => {
        const dir = fixtureDir();
        const expected = expectedExtractionInventory(RECORDS.filter((r) => r.path !== "README.md"));
        expect(() => assertSafeExtractedTree(dir, expected)).toThrow(/inventory mismatch.*extra=\[README\.md\]/);
    });

    it("fails closed on a retyped entry", () => {
        const dir = fixtureDir();
        const expected = expectedExtractionInventory(RECORDS);
        expected.set("src", "file");
        expect(() => assertSafeExtractedTree(dir, expected)).toThrow(/inventory mismatch.*retyped=\[src \(file -> dir\)\]/);
    });
});

describe("listing TOCTOU: a swap between lstat and readdir fails closed (P1-2)", () => {
    it("throws and returns nothing when a listed directory becomes a symlink mid-walk", () => {
        const base = tempDir("ext-toctou-");
        const snap = join(base, "snap");
        mkdirSync(join(snap, "sub"), { recursive: true });
        writeFileSync(join(snap, "sub", "inside.txt"), "inside");
        const external = join(base, "external");
        mkdirSync(external);
        writeFileSync(join(external, "secret.txt"), "secret");
        const sub = join(snap, "sub");
        const realReaddirSync = externalStateFsHooks.readdirSync;
        let swapped = false;
        externalStateFsHooks.readdirSync = ((p: string, ...rest: unknown[]) => {
            if (String(p) === sub && !swapped) {
                // Swap AFTER the entry lstat reported "directory", BEFORE
                // readdir enumerates: the enumeration now runs through a
                // symlink to an external directory (the review's repro).
                swapped = true;
                renameSync(sub, join(base, "sub.bak"));
                symlinkSync(external, sub);
            }
            return (realReaddirSync as unknown as (...args: unknown[]) => string[])(p, ...rest);
        }) as typeof readdirSync;
        let result: Set<string> | undefined;
        let thrown: unknown;
        try {
            result = listSnapshotFiles(snap);
        } catch (error) {
            thrown = error;
        } finally {
            externalStateFsHooks.readdirSync = realReaddirSync;
        }
        expect(swapped).toBe(true);
        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toMatch(/swapped during listing/);
        // Fail-closed: NOTHING is returned — the external enumeration
        // (secret.txt) never surfaces to the caller.
        expect(result).toBeUndefined();
    });
});

describe("windows receipt diagnostic parsers (synthetic process results)", () => {
    it("classifies tar locations without logging raw paths", () => {
        expect(classifyTarLocation("C:\\Windows\\System32\\tar.exe")).toBe("system32");
        expect(classifyTarLocation("C:\\Program Files\\Git\\usr\\bin\\tar.exe")).toBe("git");
        expect(classifyTarLocation("/usr/bin/tar")).toBe("other");
        expect(classifyTarLocation("")).toBe("other");
    });

    it("parses tar implementation/version tokens only, never raw process text", () => {
        expect(parseTarImplementationVersion("bsdtar 3.7.4 - libarchive 3.7.4\nsecond line")).toBe(
            "bsdtar:3.7.4:libarchive:3.7.4",
        );
        expect(parseTarImplementationVersion("bsdtar 3.7.4")).toBe("bsdtar:3.7.4");
        expect(parseTarImplementationVersion("tar (GNU tar) 1.35\nCopyright")).toBe("gnu:1.35");
        expect(parseTarImplementationVersion("")).toBe("unknown");
        // Hostile header: a fake path and secret marker must be rejected, not echoed.
        const hostile = "bsdtar 3.7.4 - libarchive 3.7.4 C:\\Users\\svc\\secret --token hunter2 caf\u00e9";
        const parsed = parseTarImplementationVersion(hostile);
        expect(parsed).toBe("bsdtar:3.7.4:libarchive:3.7.4");
        expect(parsed).not.toMatch(/Users|secret|token|hunter|caf/);
        expect(parseTarImplementationVersion("totally-unknown C:\\x --token hunter2")).toBe("unknown");
    });

    it("reports the console codepage as observation, never decoder proof", () => {
        expect(parseConsoleCodePage("Active code page: 65001")).toMatch(/65001.*console observation only/);
        expect(parseConsoleCodePage("")).toMatch(/unknown.*console observation only/);
    });

    it("bounds probe subprocess time and memory via explicit options (typed spy)", () => {
        let seen: { timeout: number; maxBuffer: number } | undefined;
        const spy: ProbeSpawn = (cmd, args, opts) => {
            seen = { timeout: opts.timeout, maxBuffer: opts.maxBuffer };
            expect(cmd).toBe("tar");
            expect(args).toEqual(["--version"]);
            return { status: 0, stdout: "tar (GNU tar) 1.35" };
        };
        expect(runBoundedProbe("tar", ["--version"], spy)).toEqual({ status: "status:0", stdout: "tar (GNU tar) 1.35" });
        expect(seen).toEqual({ timeout: 5000, maxBuffer: 4096 });
    });

    it("invokes the diagnostic thunk only for failed/excluded receipts (success byte-identical, zero spawns)", () => {
        // spawnSync is reachable only through the thunk, so zero thunk calls
        // prove zero subprocess spawns on every platform, including win32.
        let calls = 0;
        const spy = (): string => {
            calls += 1;
            return " | win-diag(spy)";
        };
        expect(successReceiptDetail({ root: "snap", createdFresh: true }, spy)).toBe("expected snapshot success");
        expect(calls).toBe(0);
        expect(
            successReceiptDetail(
                { failed: true as const, root: "snap", createdFresh: true, completedStage: "extract" as const, error: "boom" },
                spy,
            ),
        ).toBe("expected snapshot success (completedStage=extract error=boom) | win-diag(spy)");
        expect(calls).toBe(1);
    });
});
