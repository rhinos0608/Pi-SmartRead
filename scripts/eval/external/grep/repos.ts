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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { BenchmarkInstance } from "./instance.js";

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

/** Partial bare clone (blob:none); no-op when already cloned. */
export function ensureBareClone(repo: string): string {
    const dir = bareRepoDir(repo);
    mkdirSync(reposDir(), { recursive: true });
    if (!existsSync(join(dir, "HEAD"))) {
        execFileSync("git", ["clone", "--bare", "--filter=blob:none", `https://github.com/${repo}.git`, dir], {
            stdio: "ignore",
            timeout: 590_000,
        });
    }
    return dir;
}

function listFiles(root: string): Set<string> {
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

export { listFiles as listSnapshotFiles };

/**
 * Archive baseCommit into the per-instance snapshot dir. Returns the
 * snapshot root, or an exclusion when any gold file is absent at base.
 * A matching marker skips re-extraction; gold presence is always verified.
 */
export function materializeInstance(
    instance: BenchmarkInstance,
    bareDir?: string,
): { root: string } | { excluded: true; reason: string; missing: string[] } {
    const bare = bareDir ?? ensureBareClone(instance.repo);
    const root = snapshotDir(instance.instanceId);
    const marker = join(root, ".snapshot-commit");
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === instance.baseCommit) {
        const files = listFiles(root);
        const missing = instance.goldFiles.filter((f) => !files.has(f));
        if (missing.length > 0) return { excluded: true, reason: "missing-at-base", missing };
        return { root };
    }
    const archive: Buffer = execFileSync("git", ["--git-dir", bare, "archive", instance.baseCommit], {
        maxBuffer: 1024 * 1024 * 1024,
    });
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    // Extract from a temp file rather than stdin: piping the archive via
    // spawnSync input races tar's exit on macOS (bsdtar), surfacing as
    // `spawnSync tar EPIPE` in CI. -xf reads the same bytes deterministically.
    const stageDir = tempSnapshotRoot("ext-grep-archive-");
    try {
        const tmpArchive = join(stageDir, "archive.tar");
        writeFileSync(tmpArchive, archive);
        execFileSync("tar", ["-xf", tmpArchive, "-C", root]);
    } finally {
        rmSync(stageDir, { recursive: true, force: true });
    }
    writeFileSync(marker, instance.baseCommit);
    const files = listFiles(root);
    const missing = instance.goldFiles.filter((f) => !files.has(f));
    if (missing.length > 0) {
        return { excluded: true, reason: "missing-at-base", missing };
    }
    return { root };
}

/** Create a throwaway temp snapshot root (used by unit tests, not the cache). */
export function tempSnapshotRoot(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}
