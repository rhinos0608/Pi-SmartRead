/**
 * Import-safety regression for the external grep benchmark runner.
 *
 * Incident: early drafts of the owned-root tests imported run.ts directly,
 * whose top-level runner executed five pilot runs into the legacy cache on
 * import. run.ts now exposes runExternalGrepCli() behind an established
 * main-entry guard (same invokedAsCli pattern as d46/run.ts): importing the
 * module under vitest/tsx parses no argv and starts no corpus, engine,
 * network, dataset, report, or cache work. This file locks that in:
 * the static import below IS the regression test, plus an isolated
 * subprocess sentinel with mocked boundaries (temp HOME, wrapper argv).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as runModule from "../../../scripts/eval/external/grep/run.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("external run.ts import safety", () => {
    it("importing the runner parses nothing and starts nothing", () => {
        // Callable entry point exists; import alone changed no process state.
        expect(typeof runModule.runExternalGrepCli).toBe("function");
        expect(typeof runModule.parseArgs).toBe("function");
        expect(process.exitCode).toBeUndefined();
    });

    it("isolated subprocess: importing run.ts has zero filesystem effects", () => {
        const home = mkdtempSync(join(tmpdir(), "ext-run-import-home-"));
        tmpRoots.push(home);
        const work = mkdtempSync(join(tmpdir(), "ext-run-import-work-"));
        tmpRoots.push(work);
        // Wrapper owns argv[1], so the invokedAsCli guard stays false: the
        // import below must be side-effect free even with hostile argv.
        const wrapper = join(work, "import-sentinel.mts");
        writeFileSync(
            wrapper,
            `await import(${JSON.stringify(pathToFileURL(resolve(REPO_ROOT, "scripts/eval/external/grep/run.ts")).href)});\n` +
                `console.log("SENTINEL-IMPORT-CLEAN");\n`,
        );
        const stdout = execFileSync(TSX_BIN, [wrapper, "--offline", "--state-root", "/nonexistent"], {
            cwd: REPO_ROOT,
            env: { ...process.env, HOME: home, USERPROFILE: home },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            shell: process.platform === "win32",
        });
        expect(stdout).toMatch(/SENTINEL-IMPORT-CLEAN/);
        // No legacy interaction: no cache, manifest, report, or dataset
        // paths materialized under the (temp) HOME.
        expect(existsSync(join(home, ".cache", "pi-smartread-bench"))).toBe(false);
    });
});
