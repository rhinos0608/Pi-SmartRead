/**
 * Worker-config boundary tests (Owner A).
 *
 * The driver worker config is internal authority-bearing IPC: the producer
 * (driver-run.ts) generates it and the consumer (driver-worker.ts) validates
 * it before importing engine modules or touching the checkpoint. These tests
 * pin the boundary without touching Owner B fixture/harness files.
 */

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readWorkerConfig, runWorker, validateWorkerConfig } from "../../../scripts/holdout-v2/driver-worker.js";
import { writeWorkerConfigFile } from "../../../scripts/holdout-v2/driver-run.js";
import type { WorkerConfig } from "../../../scripts/holdout-v2/driver-worker.js";

const dirs: string[] = [];
function tempDir(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "holdout-v2-wcfg-")));
    dirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function validConfig(checkpointPath: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
    return {
        engineRoot: join(tempDir(), "engine"),
        stateRoot: join(tempDir(), "state"),
        owned: true,
        offline: true,
        timeoutMs: 1000,
        checkpointPath,
        instances: [{ instanceId: "syn-t1", repo: "o/r1", baseCommit: "a".repeat(40) }],
        manifestEntries: null,
        revision: "rev-test",
        formulations: ["title"],
        assignedPairs: [JSON.stringify(["syn-t1", "title"])],
        launchIndex: 1,
        ...overrides,
    };
}

function siblingConfigPath(checkpointPath: string, now = 1700000000000, ctr = 1): string {
    return `${checkpointPath}.worker-${now}-${ctr}.json`;
}

function writeRaw(path: string, content: string, mode = 0o600): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode });
}

describe("worker config boundary", () => {
    it("rejects malformed JSON before engine import", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const configPath = siblingConfigPath(checkpointPath);
        writeRaw(configPath, "{not-json");
        await expect(runWorker(configPath)).rejects.toThrow(/worker config/i);
        expect(readFileSync(checkpointPath, "utf8")).toBe("");
    });

    it("rejects invalid shapes before engine import", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const badShapes: unknown[] = [
            { ...validConfig(checkpointPath), checkpointPath: 42 },
            { ...validConfig(checkpointPath), instances: [{ instanceId: 1 }] },
            { ...validConfig(checkpointPath), assignedPairs: "nope" },
            { ...validConfig(checkpointPath), formulations: [] },
            { ...validConfig(checkpointPath), manifestEntries: { x: 1 } },
            { ...validConfig(checkpointPath), timeoutMs: Number.NaN },
        ];
        for (const shape of badShapes) {
            const configPath = siblingConfigPath(checkpointPath, Date.now(), Math.floor(Math.random() * 1000000));
            writeRaw(configPath, JSON.stringify(shape));
            await expect(runWorker(configPath)).rejects.toThrow(/worker config/i);
        }
        expect(readFileSync(checkpointPath, "utf8")).toBe("");
        expect(() => validateWorkerConfig({})).toThrow(/worker config/i);
    });

    it("rejects a directory as config", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        const configPath = siblingConfigPath(checkpointPath);
        mkdirSync(configPath, { recursive: true });
        expect(() => readWorkerConfig(configPath)).toThrow(/worker config/i);
    });

    it("rejects a symlink config without following it", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const target = join(dir, "real.json");
        writeRaw(target, JSON.stringify(validConfig(checkpointPath)));
        const linkPath = siblingConfigPath(checkpointPath);
        symlinkSync(target, linkPath);
        expect(() => readWorkerConfig(linkPath)).toThrow(/worker config/i);
        // Target was never consumed as the config (read refused the link itself).
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    });

    it.skipIf(process.platform === "win32")("rejects insecure file modes on POSIX", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const configPath = siblingConfigPath(checkpointPath);
        writeRaw(configPath, JSON.stringify(validConfig(checkpointPath)), 0o600);
        chmodSync(configPath, 0o644);
        expect(() => readWorkerConfig(configPath)).toThrow(/worker config/i);
        expect(statSync(configPath).mode & 0o777).toBe(0o644);
    });

    it("rejects naming/checkpoint binding mismatch", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        const otherCheckpoint = join(dir, "other.jsonl");
        writeRaw(checkpointPath, "");
        // Basename does not start with the configured checkpoint basename.
        const mismatched = join(dir, "unrelated.worker-1-1.json");
        writeRaw(mismatched, JSON.stringify(validConfig(otherCheckpoint)));
        expect(() => readWorkerConfig(mismatched)).toThrow(/worker config/i);
        // Sibling in a different directory also mismatches.
        const otherDir = join(dir, "sub");
        mkdirSync(otherDir, { recursive: true });
        const elsewhere = join(otherDir, `${basename(checkpointPath)}.worker-1-1.json`);
        writeRaw(elsewhere, JSON.stringify(validConfig(checkpointPath)));
        expect(() => readWorkerConfig(elsewhere)).toThrow(/worker config/i);
    });

    it("producer refuses to overwrite an existing file (sentinel unchanged)", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        const configPath = siblingConfigPath(checkpointPath);
        writeRaw(configPath, "sentinel", 0o600);
        const modeBefore = statSync(configPath).mode;
        expect(() => writeWorkerConfigFile(configPath, validConfig(checkpointPath))).toThrow(/refus/i);
        expect(readFileSync(configPath, "utf8")).toBe("sentinel");
        expect(statSync(configPath).mode).toBe(modeBefore);
    });

    it("producer refuses to follow a pre-existing symlink", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        const target = join(dir, "target.json");
        writeRaw(target, "sentinel-target");
        const linkPath = siblingConfigPath(checkpointPath);
        symlinkSync(target, linkPath);
        expect(() => writeWorkerConfigFile(linkPath, validConfig(checkpointPath))).toThrow(/worker config/i);
        expect(readFileSync(target, "utf8")).toBe("sentinel-target");
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    });

    it("roundtrips current producer output in owned layout", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const configPath = siblingConfigPath(checkpointPath);
        const config = validConfig(checkpointPath);
        writeWorkerConfigFile(configPath, config);
        if (process.platform !== "win32") {
            expect(statSync(configPath).mode & 0o777).toBe(0o600);
        }
        const back = readWorkerConfig(configPath);
        expect(back.checkpointPath).toBe(checkpointPath);
        expect(back.instances).toHaveLength(1);
        expect(resolve(configPath)).toBe(resolve(`${resolve(checkpointPath)}.worker-1700000000000-1.json`));
    });

    it("accepts legacy layout (null stateRoot, unowned)", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "legacy.jsonl");
        writeRaw(checkpointPath, "");
        const configPath = siblingConfigPath(checkpointPath, 7, 2);
        const config = validConfig(checkpointPath, { stateRoot: null, owned: false });
        writeWorkerConfigFile(configPath, config);
        const back = readWorkerConfig(configPath);
        expect(back.owned).toBe(false);
        expect(back.stateRoot).toBeNull();
    });

    it("accepts custom relative checkpoint paths as siblings", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "custom-resume.jsonl");
        writeRaw(checkpointPath, "");
        // Relative form of the same sibling pair (no cwd containment requirement).
        const relCheckpoint = join(dir, "custom-resume.jsonl");
        const configPath = siblingConfigPath(relCheckpoint, 9, 3);
        const config = validConfig(relCheckpoint);
        writeWorkerConfigFile(configPath, config);
        const back = readWorkerConfig(configPath);
        expect(resolve(back.checkpointPath)).toBe(resolve(relCheckpoint));
        expect(dirname(resolve(configPath))).toBe(dirname(resolve(relCheckpoint)));
    });

    it("preserves extra instance fields", () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const configPath = siblingConfigPath(checkpointPath);
        const config = validConfig(checkpointPath, {
            instances: [{ instanceId: "syn-t1", repo: "o/r1", baseCommit: "a".repeat(40), customField: "keep-me" } as WorkerConfig["instances"][number]],
        });
        writeWorkerConfigFile(configPath, config);
        const back = readWorkerConfig(configPath);
        expect(back.instances[0]).toMatchObject({ instanceId: "syn-t1", customField: "keep-me" });
    });

    it("rejects before checkpoint mutation", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        const sentinel = `${JSON.stringify({ v: 1, kind: "attempt", attempt: { instanceId: "x" } })}\n`;
        writeRaw(checkpointPath, sentinel);
        const configPath = siblingConfigPath(checkpointPath);
        writeRaw(configPath, JSON.stringify({ bogus: true }));
        await expect(runWorker(configPath)).rejects.toThrow(/worker config/i);
        expect(readFileSync(checkpointPath, "utf8")).toBe(sentinel);
    });
});
