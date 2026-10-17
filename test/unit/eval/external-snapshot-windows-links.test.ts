/**
 * Windows owned-snapshot extraction adapter (owner decision 2026-10-12,
 * option A): UTF-8 tar header decoding plus directory-link type restoration
 * inside the fresh, incomplete snapshot root, before postcheck and marker.
 * Every test runs on every OS; win32 runs exercise the native link types.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ensureOwnedStateRoot,
    externalStateFsHooks,
    materializeInstance,
    preflightSnapshotTree,
    restoreDirectoryLinkTypes,
    snapshotDirUnder,
} from "../../../scripts/eval/external/grep/repos.js";
import type { BenchmarkInstance } from "../../../scripts/eval/external/grep/instance.js";

const TAR = { calls: [] as string[][], fail: false };
(globalThis as unknown as { __winLinkTar: typeof TAR }).__winLinkTar = TAR;

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return {
        ...actual,
        execFileSync: ((...args: unknown[]) => {
            const tar = (globalThis as unknown as { __winLinkTar: typeof TAR }).__winLinkTar;
            const [cmd, cmdArgs] = args as [string, unknown];
            if (cmd === "tar") {
                tar.calls.push(Array.isArray(cmdArgs) ? cmdArgs.map(String) : []);
                if (tar.fail) throw new Error("injected tar failure");
            }
            return (actual.execFileSync as (...a: unknown[]) => unknown)(...args);
        }) as typeof actual.execFileSync,
    };
});

const IS_WIN = process.platform === "win32";
const UNI = `caf${String.fromCodePoint(0xe9)}.ts`;
const realSymlinkHook = externalStateFsHooks.symlinkSync;
const tmpRoots: string[] = [];

beforeEach(() => {
    TAR.calls.length = 0;
    TAR.fail = false;
});
afterEach(() => {
    externalStateFsHooks.symlinkSync = realSymlinkHook;
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tmpRoots.push(dir);
    return dir;
}

function makeInstance(overrides: Partial<BenchmarkInstance>): BenchmarkInstance {
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

function git(args: string[], cwd: string): string {
    return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
}

/** Synthetic local repo with nested, chained, root-pointing, and dangling links. */
function linkRepo(): { bare: string; sha: string } {
    const work = tempDir("win-links-fixture-");
    mkdirSync(join(work, "src", "sub"), { recursive: true });
    mkdirSync(join(work, "src", "inner"), { recursive: true });
    writeFileSync(join(work, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(work, "src", UNI), "export const c = 1;\n");
    writeFileSync(join(work, "src", "sub", "f.ts"), "export const f = 1;\n");
    symlinkSync("sub", join(work, "src", "dirlink"));
    symlinkSync("a.ts", join(work, "src", "link.ts"));
    symlinkSync("../sub", join(work, "src", "inner", "up"));
    symlinkSync("dirlink", join(work, "src", "chain"));
    symlinkSync("..", join(work, "src", "top"));
    symlinkSync("missing", join(work, "src", "dangling"));
    git(["init", "-q"], work);
    git(["add", "."], work);
    git(["commit", "-qm", "links"], work);
    return { bare: join(work, ".git"), sha: git(["rev-parse", "HEAD"], work) };
}

const DIRECTORY_LINKS: Array<[string, string]> = [
    ["src/chain", "dirlink"],
    ["src/dirlink", "sub"],
    ["src/inner/up", "../sub"],
    ["src/top", ".."],
];

/** Link target as stored by Git: Windows link creation translates '/' to '\'. */
function storedTarget(path: string): string {
    const raw = readlinkSync(path);
    return IS_WIN ? raw.split("\\").join("/") : raw;
}

function countingSymlinkHook(fail: boolean): { calls: number } {
    const spy = { calls: 0 };
    externalStateFsHooks.symlinkSync = ((...args: Parameters<typeof symlinkSync>) => {
        spy.calls += 1;
        if (fail) throw new Error("injected link restore failure");
        realSymlinkHook(...args);
    }) as typeof symlinkSync;
    return spy;
}

/** Synthetic extracted root: src/sub is a real directory, links are added per test. */
function extractedRoot(): string {
    const root = tempDir("win-links-root-");
    mkdirSync(join(root, "src", "sub"), { recursive: true });
    mkdirSync(join(root, "src", "inner"), { recursive: true });
    writeFileSync(join(root, "src", "sub", "f.ts"), "export const f = 1;\n");
    return root;
}

describe("preflight directory-link targets", () => {
    it("records the original target of every link whose chain resolves to a directory", () => {
        const { bare, sha } = linkRepo();
        const preflight = preflightSnapshotTree(bare, sha);
        expect([...preflight.directoryLinks].sort(([a], [b]) => (a < b ? -1 : 1))).toEqual(DIRECTORY_LINKS);
    });
});

describe("restoreDirectoryLinkTypes: fresh incomplete root only", () => {
    it("retypes a file-typed link as a directory link with the original target", () => {
        const root = extractedRoot();
        const link = join(root, "src", "dirlink");
        symlinkSync("sub", link, "file");
        restoreDirectoryLinkTypes(root, new Map([["src/dirlink", "sub"]]));
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(storedTarget(link)).toBe("sub");
        expect(statSync(link).isDirectory()).toBe(true);
        expect(realpathSync(link)).toBe(realpathSync(join(root, "src", "sub")));
    });

    it("preserves a multi-component target across Windows separator translation", () => {
        const root = extractedRoot();
        const link = join(root, "src", "inner", "up");
        symlinkSync("../sub", link, "file");
        restoreDirectoryLinkTypes(root, new Map([["src/inner/up", "../sub"]]));
        expect(storedTarget(link)).toBe("../sub");
        expect(statSync(link).isDirectory()).toBe(true);
    });

    it("leaves a link that already resolves to a directory untouched", () => {
        const root = extractedRoot();
        symlinkSync("sub", join(root, "src", "dirlink"), "dir");
        const spy = countingSymlinkHook(false);
        restoreDirectoryLinkTypes(root, new Map([["src/dirlink", "sub"]]));
        expect(spy.calls).toBe(0);
    });

    it("refuses a link whose extracted target differs from preflight, before any write", () => {
        const root = extractedRoot();
        const link = join(root, "src", "dirlink");
        symlinkSync("other", link, "file");
        const spy = countingSymlinkHook(false);
        expect(() => restoreDirectoryLinkTypes(root, new Map([["src/dirlink", "sub"]]))).toThrow(/refuses-unsafe-entry: .*differs/);
        expect(storedTarget(link)).toBe("other");
        expect(spy.calls).toBe(0);
    });

    it("refuses a missing entry or a non-link at a directory-link position, leaving it intact", () => {
        const root = extractedRoot();
        const spy = countingSymlinkHook(false);
        expect(() => restoreDirectoryLinkTypes(root, new Map([["src/dirlink", "sub"]]))).toThrow(/refuses-unsafe-entry: .*missing/);
        mkdirSync(join(root, "src", "dirlink"));
        expect(() => restoreDirectoryLinkTypes(root, new Map([["src/dirlink", "sub"]]))).toThrow(/refuses-unsafe-entry: .*not a symlink/);
        expect(lstatSync(join(root, "src", "dirlink")).isDirectory()).toBe(true);
        writeFileSync(join(root, "src", "inner", "file"), "x");
        expect(() => restoreDirectoryLinkTypes(root, new Map([["src/inner/file", "../sub"]]))).toThrow(/not a symlink/);
        expect(lstatSync(join(root, "src", "inner", "file")).isFile()).toBe(true);
        expect(spy.calls).toBe(0);
    });

    it("refuses to traverse a symlinked ancestor; the outside tree is untouched", () => {
        const root = tempDir("win-links-root-");
        const outside = tempDir("win-links-outside-");
        mkdirSync(join(outside, "sub"));
        symlinkSync("sub", join(outside, "dirlink"), "file");
        symlinkSync(outside, join(root, "src"), "dir");
        const spy = countingSymlinkHook(false);
        expect(() => restoreDirectoryLinkTypes(root, new Map([["src/dirlink", "sub"]]))).toThrow(/symlinked ancestor/);
        expect(lstatSync(join(outside, "dirlink")).isSymbolicLink()).toBe(true);
        expect(storedTarget(join(outside, "dirlink"))).toBe("sub");
        expect(spy.calls).toBe(0);
    });
});

describe("owned materialization with the Windows adapter", () => {
    it("passes the UTF-8 header option to tar on win32 only; argv is unchanged elsewhere", () => {
        const stateRoot = join(tempDir("win-links-state-"), "state");
        ensureOwnedStateRoot(stateRoot);
        const { bare, sha } = linkRepo();
        const out = materializeInstance(makeInstance({ instanceId: "winargv__i-1", baseCommit: sha }), { bareDir: bare, stateRoot });
        expect("root" in out && !("failed" in out)).toBe(true);
        expect(TAR.calls).toHaveLength(1);
        const args = TAR.calls[0] ?? [];
        if (IS_WIN) expect(args.slice(0, 3)).toEqual(["--options", "tar:hdrcharset=UTF-8", "-xf"]);
        else expect(args[0]).toBe("-xf");
        expect(args).toHaveLength(IS_WIN ? 6 : 4);
    });

    it("materializes Unicode names and nested, chained, and root directory links with original targets", () => {
        const stateRoot = join(tempDir("win-links-state-"), "state");
        ensureOwnedStateRoot(stateRoot);
        const { bare, sha } = linkRepo();
        const id = "winlinks__i-1";
        const out = materializeInstance(
            makeInstance({ instanceId: id, baseCommit: sha, goldFiles: [`src/${UNI}`, "src/sub/f.ts", "src/link.ts"] }),
            { bareDir: bare, stateRoot },
        );
        expect("failed" in out ? `${out.completedStage}: ${out.error}` : "ok").toBe("ok");
        expect("excluded" in out).toBe(false);
        if (!("root" in out) || "failed" in out) return;
        const realRoot = realpathSync(out.root);
        expect(existsSync(join(out.root, "src", UNI))).toBe(true);
        for (const [rel, target] of DIRECTORY_LINKS) {
            const link = join(out.root, ...rel.split("/"));
            expect(lstatSync(link).isSymbolicLink()).toBe(true);
            expect(storedTarget(link)).toBe(target);
            expect(statSync(link).isDirectory()).toBe(true);
            const resolved = realpathSync(link);
            expect(resolved === realRoot || resolved.startsWith(`${realRoot}${sep}`)).toBe(true);
        }
        expect(storedTarget(join(out.root, "src", "link.ts"))).toBe("a.ts");
        expect(lstatSync(join(out.root, "src", "dangling")).isSymbolicLink()).toBe(true);
        expect(existsSync(join(snapshotDirUnder(stateRoot, id), ".snapshot-commit"))).toBe(true);
    });

    it("a link-restore failure fails closed at extract with no marker (win32); off-Windows nothing is restored", () => {
        const stateRoot = join(tempDir("win-links-state-"), "state");
        ensureOwnedStateRoot(stateRoot);
        const { bare, sha } = linkRepo();
        const id = "winrestorefail__i-1";
        const spy = countingSymlinkHook(true);
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha }), { bareDir: bare, stateRoot });
        const marker = join(snapshotDirUnder(stateRoot, id), ".snapshot-commit");
        if (!IS_WIN) {
            expect("failed" in out).toBe(false);
            expect(spy.calls).toBe(0);
            return;
        }
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("extract");
            expect(out.createdFresh).toBe(true);
            expect(out.error).toMatch(/directory link restore failed: injected link restore failure/);
        }
        expect(spy.calls).toBe(1);
        expect(existsSync(marker)).toBe(false);
    });

    it("a tar failure records an extract failure and never reaches link restoration", () => {
        const stateRoot = join(tempDir("win-links-state-"), "state");
        ensureOwnedStateRoot(stateRoot);
        const { bare, sha } = linkRepo();
        const id = "wintarfail__i-1";
        TAR.fail = true;
        const spy = countingSymlinkHook(false);
        const out = materializeInstance(makeInstance({ instanceId: id, baseCommit: sha }), { bareDir: bare, stateRoot });
        expect("failed" in out).toBe(true);
        if ("failed" in out) {
            expect(out.completedStage).toBe("extract");
            expect(out.error).toMatch(/tar extract failed: injected tar failure/);
        }
        expect(spy.calls).toBe(0);
        expect(existsSync(join(snapshotDirUnder(stateRoot, id), ".snapshot-commit"))).toBe(false);
    });
});
