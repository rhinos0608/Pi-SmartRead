/**
 * Synthetic supervisor tests for the §9.16 driver (no engine, no network).
 *
 * The supervisor loads a stub engine via test-only injection and spawns the
 * fake worker fixture (plain node, no tsx) with real process-group kills on
 * POSIX. Thresholds, tick, CPU readings and the clock path are injected.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchDetachedWorker, runDriverCli } from "../../../scripts/holdout-v2/driver-run.js";
import { loadCheckpoint, pairKey } from "../../../scripts/holdout-v2/driver-checkpoint.js";
import { FAKE_WORKER, FAST, fakeEngineRoot, manifestFor, onlyCheckpoint, runSynthetic, stubEngine, tempDir } from "./holdout-v2-driver-harness.js";

// Process-group supervision (SIGTERM to -pgid, pgrep/ps) is POSIX-only by
// §9.16 design; the driver refuses on win32 (see launchDetachedWorker).
describe.skipIf(process.platform === "win32")("driver supervisor (synthetic)", () => {
    it("hung query is killed at the cap, recorded timeout:watchdog-query, next pair continues", async () => {
        const hanging = pairKey("syn-t1", "title");
        const { code, reportsDir } = await runSynthetic({ plan: { queries: { [hanging]: "hang" } } });
        expect(code).toBe(0);
        const ckpt = loadCheckpoint(onlyCheckpoint(reportsDir));
        expect(ckpt.outcomes.get(hanging)).toMatchObject({ status: "timeout:watchdog-query" });
        expect(ckpt.outcomes.get(pairKey("syn-t1", "body"))).toMatchObject({ status: "ok" });
        expect(ckpt.outcomes.get(pairKey("syn-t2", "title"))).toMatchObject({ status: "ok" });
        expect(ckpt.outcomes.size).toBe(4);
    });
    it("hung setup is retried once, then both formulations are error:watchdog-setup", async () => {
        const { code, reportsDir } = await runSynthetic({ plan: { setups: { "syn-t1": "hang" } } });
        expect(code).toBe(0);
        const ckpt = loadCheckpoint(onlyCheckpoint(reportsDir));
        expect(ckpt.setupKills.get("syn-t1")).toBe(2);
        expect(ckpt.outcomes.get(pairKey("syn-t1", "title"))).toMatchObject({ status: "error:watchdog-setup" });
        expect(ckpt.outcomes.get(pairKey("syn-t1", "body"))).toMatchObject({ status: "error:watchdog-setup" });
        expect(ckpt.outcomes.get(pairKey("syn-t2", "title"))).toMatchObject({ status: "ok" });
    });
    it("hang-once setup recovers on retry with no error outcomes", async () => {
        const { code, reportsDir } = await runSynthetic({ plan: { setups: { "syn-t1": "hang-once" } } });
        expect(code).toBe(0);
        const ckpt = loadCheckpoint(onlyCheckpoint(reportsDir));
        expect(ckpt.setupKills.get("syn-t1")).toBe(1);
        expect(ckpt.outcomes.get(pairKey("syn-t1", "title"))).toMatchObject({ status: "ok" });
    });
    it("slow-but-CPU-burning setup under the cap is NOT killed", async () => {
        let calls = 0;
        const { code, reportsDir } = await runSynthetic({
            plan: { setups: { "syn-t1": "busy" } },
            hooks: {
                thresholds: FAST,
                listGroup: async () => {
                    calls += 1;
                    return [{ pid: 1, pgid: 1, cpuS: calls * 60 }];
                },
            },
        });
        expect(code).toBe(0);
        const ckpt = loadCheckpoint(onlyCheckpoint(reportsDir));
        expect(ckpt.setupKills.get("syn-t1") ?? 0).toBe(0);
        expect(ckpt.outcomes.get(pairKey("syn-t1", "title"))).toMatchObject({ status: "ok" });
    });
    it("survivor detection stops for review with no further workers", async () => {
        let launches = 0;
        const hanging = pairKey("syn-t1", "title");
        const { code } = await runSynthetic({
            plan: { queries: { [hanging]: "hang" } },
            hooks: {
                listGroup: async () => [{ pid: 999998, pgid: 999999, cpuS: 0 }],
                launchWorker: async (spec) => {
                    launches += 1;
                    return launchDetachedWorker(spec);
                },
            },
        });
        expect(code).toBe(3);
        expect(launches).toBe(1);
    });
    it("SIGTERM-ignoring grandchild dies with the group SIGKILL and verification passes", async () => {
        const hanging = pairKey("syn-t1", "title");
        const { code, reportsDir } = await runSynthetic({
            plan: { queries: { [hanging]: "hang" }, spawnIgnorer: true },
            hooks: { listGroup: undefined },
        });
        expect(code).toBe(0);
        const ckpt = loadCheckpoint(onlyCheckpoint(reportsDir));
        expect(ckpt.outcomes.get(hanging)).toMatchObject({ status: "timeout:watchdog-query" });
        expect(ckpt.outcomes.size).toBe(4);
    }, 30000);
    it("setup after a long idle gap gets a clean first window; genuine idle reaches the full count", async () => {
        // Virtual clock: every stall window is exactly 1000 ms, so the kill
        // must land exactly 10 windows after setup-start (§9.16 count of 10).
        let virtualNow = 1_000_000;
        let sawSetupStartB = false;
        let jumped = false;
        const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
        const dir = tempDir();
        const stateRoot = join(dir, "state");
        const engineRoot = fakeEngineRoot(dir);
        const manifest = manifestFor(["syn-t1", "syn-t2"]);
        process.env.FAKE_PLAN_JSON = JSON.stringify({ setups: { "syn-t2": "hang" } });
        const reportsDir = join(stateRoot, "reports");
        const runPromise = runDriverCli(
            ["--engine-root", engineRoot, "--manifest", manifest, "--split", "dev", "--state-root", stateRoot, "--accept-license-review"],
            {
                thresholds: { ...FAST, setupCheckMs: 1000, setupStallChecks: 10, setupHardCapMs: 3600000 },
                tickMs: 50,
                samplerMs: null,
                nodeArgs: [],
                workerEntry: FAKE_WORKER,
                loadEngine: async () => stubEngine(),
                listGroup: async () => [],
                expectedEngineHash: "test-engine-hash",
                runId: `stall-window-${Date.now()}`,
                now: () => virtualNow,
                launchWorker: async (spec) => {
                    const handle = await launchDetachedWorker(spec);
                    const origOnLine = handle.onLine.bind(handle);
                    handle.onLine = (cb: (line: string) => void) => {
                        origOnLine((line: string) => {
                            let marker: Record<string, unknown>;
                            try {
                                marker = JSON.parse(line);
                            } catch {
                                cb(line);
                                return;
                            }
                            if (marker["phase"] === "query-end" && marker["instanceId"] === "syn-t1" && !jumped) {
                                jumped = true;
                                virtualNow += 100_000; // long idle gap, under the 180 s gap-reset
                            }
                            if (marker["phase"] === "setup-start" && marker["instanceId"] === "syn-t2") sawSetupStartB = true;
                            cb(line);
                        });
                    };
                    return handle;
                },
            },
        );
        const deadline = Date.now() + 20000;
        while (!sawSetupStartB) {
            if (Date.now() > deadline) throw new Error("timed out waiting for setup-start of syn-t2");
            await realSleep(50);
        }
        const ckptPath = onlyCheckpoint(reportsDir);
        const killsOfB = (): number => loadCheckpoint(ckptPath).setupKills.get("syn-t2") ?? 0;
        // Nine full windows: genuinely idle, but the count of 10 is not reached.
        for (let i = 0; i < 9; i++) {
            virtualNow += 1000;
            await realSleep(250);
            expect(killsOfB()).toBe(0);
        }
        // Tenth window: first kill, exactly 10 windows after setup-start.
        virtualNow += 1000;
        while (killsOfB() < 1) {
            if (Date.now() > deadline) throw new Error("timed out waiting for the first setup kill");
            await realSleep(100);
        }
        expect(loadCheckpoint(ckptPath).setupKills.get("syn-t2")).toBe(1);
        // Retry hangs again: keep opening full windows until the run drains
        // (ten more after the retry's own setup-start, then both recorded).
        const runEnd = Date.now() + 40000;
        let runCode = -1;
        let runDone = false;
        const runDonePromise = runPromise.then((code) => {
            runDone = true;
            runCode = code;
        });
        void runDonePromise;
        while (!runDone) {
            if (Date.now() > runEnd) throw new Error("timed out waiting for run completion");
            virtualNow += 1000;
            await realSleep(250);
        }
        expect(runCode).toBe(0);
        const final = loadCheckpoint(ckptPath);
        expect(final.setupKills.get("syn-t2")).toBe(2);
        expect(final.outcomes.get(pairKey("syn-t2", "title"))).toMatchObject({ status: "error:watchdog-setup" });
        expect(final.outcomes.get(pairKey("syn-t2", "body"))).toMatchObject({ status: "error:watchdog-setup" });
    }, 45000);
});
