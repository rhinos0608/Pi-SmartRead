/**
 * Worker-config boundary tests (stdin design).
 *
 * The driver worker config is internal authority-bearing IPC: the producer
 * (driver-run.ts) generates it, writes an exclusive 0600 sidecar receipt,
 * and feeds identical bytes to the worker over stdin. The worker never takes
 * a pathname: it reads bounded stdin bytes, parses strict JSON, and runs the
 * same shape validation. These tests pin the boundary without touching
 * Owner B fixture/harness files.
 */

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_WORKER_CONFIG_BYTES, parseWorkerArgs, readWorkerConfigFromStdin, runWorker, validateWorkerConfig } from "../../../scripts/holdout-v2/driver-worker.js";
import { launchDetachedWorker, writeWorkerConfigFile } from "../../../scripts/holdout-v2/driver-run.js";
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
    it("accepts valid stdin JSON (producer sidecar bytes round-trip)", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const configPath = siblingConfigPath(checkpointPath);
        const config = validConfig(checkpointPath);
        writeWorkerConfigFile(configPath, config);
        if (process.platform !== "win32") {
            expect(statSync(configPath).mode & 0o777).toBe(0o600);
        }
        const back = await readWorkerConfigFromStdin(Readable.from([readFileSync(configPath)]));
        expect(back).toEqual(config);
    });

    it("rejects oversize stdin input without echoing content", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        const oversized = validConfig(checkpointPath, { revision: `ok-SENTINEL-${"p".repeat(MAX_WORKER_CONFIG_BYTES)}` });
        const error = await readWorkerConfigFromStdin(Readable.from([JSON.stringify(oversized)])).then(
            () => {
                throw new Error("expected rejection");
            },
            (cause: unknown) => cause,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/worker config: input too large/);
        expect((error as Error).message).not.toContain("SENTINEL");
    });

    it("rejects invalid JSON without echoing content", async () => {
        const error = await readWorkerConfigFromStdin(Readable.from(["{not-json-SENTINEL"])).then(
            () => {
                throw new Error("expected rejection");
            },
            (cause: unknown) => cause,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/worker config: malformed JSON/);
        expect((error as Error).message).not.toContain("SENTINEL");
    });

    it("rejects invalid shapes without echoing content", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const badShapes: unknown[] = [
            { ...validConfig(checkpointPath), checkpointPath: 42, note: "SENTINEL" },
            { ...validConfig(checkpointPath), instances: [{ instanceId: 1 }] },
            { ...validConfig(checkpointPath), assignedPairs: "nope" },
            { ...validConfig(checkpointPath), formulations: [] },
            { ...validConfig(checkpointPath), manifestEntries: { x: 1 } },
            { ...validConfig(checkpointPath), timeoutMs: Number.NaN },
        ];
        for (const shape of badShapes) {
            const error = await readWorkerConfigFromStdin(Readable.from([JSON.stringify(shape)])).then(
                () => {
                    throw new Error("expected rejection");
                },
                (cause: unknown) => cause,
            );
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toMatch(/worker config/i);
            expect((error as Error).message).not.toContain("SENTINEL");
        }
        expect(() => validateWorkerConfig({})).toThrow(/worker config/i);
    });

    it("rejects empty stdin", async () => {
        await expect(readWorkerConfigFromStdin(Readable.from([]))).rejects.toThrow(/worker config: empty stdin/);
    });

    it("rejects a TTY stdin", async () => {
        const tty = Object.assign(Readable.from([]), { isTTY: true });
        await expect(readWorkerConfigFromStdin(tty as unknown as NodeJS.ReadableStream)).rejects.toThrow(/worker config: stdin is a TTY/);
    });

    it("rejects stdin that never ends (timeout)", async () => {
        const stalled = new Readable({ read() {} });
        await expect(readWorkerConfigFromStdin(stalled, { timeoutMs: 50 })).rejects.toThrow(/worker config: stdin timeout/);
        stalled.destroy();
    });

    it("rejects --config (unknown worker flag)", () => {
        expect(() => parseWorkerArgs(["--config", "some.json"])).toThrow(/unknown argument/);
        expect(() => parseWorkerArgs(["--anything"])).toThrow(/unknown argument/);
        expect(() => parseWorkerArgs([])).not.toThrow();
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

    it("runWorker rejects bogus config before checkpoint mutation", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        const sentinel = `${JSON.stringify({ v: 1, kind: "attempt", attempt: { instanceId: "x" } })}\n`;
        writeRaw(checkpointPath, sentinel);
        await expect(runWorker({ bogus: true } as unknown as WorkerConfig)).rejects.toThrow(/worker config/i);
        expect(readFileSync(checkpointPath, "utf8")).toBe(sentinel);
    });

    it("runWorker gets a valid config past validation to engine load", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const error = await runWorker(validConfig(checkpointPath)).then(
            () => {
                throw new Error("expected rejection");
            },
            (cause: unknown) => cause,
        );
        expect(error).toBeInstanceOf(Error);
        // Validation passed: the failure is the missing engine, not the config.
        expect((error as Error).message).not.toMatch(/worker config/i);
        expect(readFileSync(checkpointPath, "utf8")).toBe("");
    });

    it("accepts legacy layout (null stateRoot, unowned) over stdin", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "legacy.jsonl");
        writeRaw(checkpointPath, "");
        const configPath = siblingConfigPath(checkpointPath, 7, 2);
        const config = validConfig(checkpointPath, { stateRoot: null, owned: false });
        writeWorkerConfigFile(configPath, config);
        const back = await readWorkerConfigFromStdin(Readable.from([readFileSync(configPath, "utf8")]));
        expect(back.owned).toBe(false);
        expect(back.stateRoot).toBeNull();
    });

    it("accepts custom relative checkpoint paths over stdin", async () => {
        // Relative form (no cwd containment requirement).
        const dir = tempDir();
        const relCheckpoint = join(dir, "custom-resume.jsonl");
        writeRaw(relCheckpoint, "");
        const config = validConfig(relCheckpoint);
        const back = await readWorkerConfigFromStdin(Readable.from([JSON.stringify(config)]));
        expect(resolve(back.checkpointPath)).toBe(resolve(relCheckpoint));
    });

    it("preserves extra instance fields over stdin", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const config = validConfig(checkpointPath, {
            instances: [{ instanceId: "syn-t1", repo: "o/r1", baseCommit: "a".repeat(40), customField: "keep-me" } as WorkerConfig["instances"][number]],
        });
        const back = await readWorkerConfigFromStdin(Readable.from([JSON.stringify(config)]));
        expect(back.instances[0]).toMatchObject({ instanceId: "syn-t1", customField: "keep-me" });
    });

    it.skipIf(process.platform === "win32")("launchDetachedWorker pipes the config over stdin (fake worker)", async () => {
        const dir = tempDir();
        const checkpointPath = join(dir, "ckpt.jsonl");
        writeRaw(checkpointPath, "");
        const config = validConfig(checkpointPath, { engineRoot: dir, stateRoot: dir, owned: true });
        const fakeWorker = new URL("./fixtures/holdout-v2-fake-worker.mjs", import.meta.url).pathname;
        process.env.FAKE_PLAN_JSON = JSON.stringify({});
        try {
            const handle = await launchDetachedWorker({ nodeArgs: [], entry: fakeWorker, config, cwd: dir });
            const result = await handle.wait();
            expect(result.code).toBe(0);
        } finally {
            delete process.env.FAKE_PLAN_JSON;
        }
        expect(readFileSync(checkpointPath, "utf8")).toContain('"status":"ok"');
    });
});
