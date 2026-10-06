/**
 * CLI usage-error tests for the external grep benchmark runner:
 * a value-taking flag with a missing value (trailing or followed by
 * another flag) is a usage error (exit 2, clear message) and must never
 * reach any manifest write. Spawns the runner as a subprocess with a
 * temp HOME so the real cache cannot be touched.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(extraArgs: string[], home: string): { status: number | null; stderr: string } {
    try {
        execFileSync("npx", ["tsx", "scripts/eval/external/grep/run.ts", ...extraArgs], {
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: home },
            encoding: "utf8",
            stdio: ["ignore", "ignore", "pipe"],
        });
        return { status: 0, stderr: "" };
    } catch (error) {
        const err = error as { status?: number | null; stderr?: string };
        return { status: err.status ?? null, stderr: String(err.stderr ?? "") };
    }
}

function cacheIsUntouched(home: string): boolean {
    return readdirSync(home, { withFileTypes: true }).length === 0;
}

describe("run.ts value-taking flags", () => {
    it.each([
        ["--manifest"],
        ["--manifest", "--offline"],
        ["--split"],
        ["--formulation"],
        ["--limit"],
        ["--timeout-ms"],
        ["--seed"],
    ])("rejects %j with exit 2 and never writes to the cache", (...flagArgs: string[]) => {
        const home = mkdtempSync(join(tmpdir(), "ext-grep-cli-home-"));
        tmpRoots.push(home);
        const { status, stderr } = runCli(flagArgs, home);
        expect(status).toBe(2);
        expect(stderr).toMatch(/requires a value/);
        expect(cacheIsUntouched(home)).toBe(true);
    });
});
