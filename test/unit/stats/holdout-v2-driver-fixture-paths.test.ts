/**
 * Fixture-path ownership regression (Owner B seam only).
 *
 * Synthetic engine/snapshot metadata must stay beneath harness-owned
 * temporary roots — never fixed /tmp literals — and a shared per-test
 * fake engine path must keep the resume args fingerprint stable.
 */

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { pairKey } from "../../../scripts/holdout-v2/driver-checkpoint.js";
import { loadCheckpoint } from "../../../scripts/holdout-v2/driver-checkpoint.js";
import { runDriverCli } from "../../../scripts/holdout-v2/driver-run.js";
import {
    FAKE_WORKER,
    FAST,
    fakeEngineRoot,
    manifestFor,
    newRunId,
    onlyCheckpoint,
    runSynthetic,
    stubEngine,
    tempDir,
} from "./holdout-v2-driver-harness.js";

describe("driver fixture-path ownership", () => {
    it("generates unique run ids and harness-owned engine paths", () => {
        const first = newRunId();
        const second = newRunId();
        expect(first).toMatch(/^t-[0-9a-f-]{36}$/);
        expect(second).toMatch(/^t-[0-9a-f-]{36}$/);
        expect(second).not.toBe(first);

        const dir = tempDir();
        const engineRoot = fakeEngineRoot(dir);
        expect(engineRoot.startsWith(dir)).toBe(true);
        expect(engineRoot).not.toBe("/tmp/fake-engine");
    });

    it.skipIf(process.platform === "win32")("synthetic snapshot metadata stays beneath the owned state root", async () => {
        const { code, reportsDir, stateRoot, engineRoot } = await runSynthetic({
            plan: { setups: { "syn-t1": "exclude" } },
        });
        expect(code).toBe(0);
        expect(engineRoot.startsWith("/tmp/fake-engine")).toBe(false);

        const checkpointPath = onlyCheckpoint(reportsDir);
        const raw = readFileSync(checkpointPath, "utf8");
        expect(raw).not.toContain("/tmp/fake-snap");
        const state = loadCheckpoint(checkpointPath);
        expect(state.exclusions.length).toBe(1);
        expect(state.exclusions[0]).toMatchObject({
            instanceId: "syn-t1",
            root: join(stateRoot, "snapshots", "syn-t1"),
        });
        expect(state.attempts.length).toBeGreaterThan(0);
        for (const attempt of state.attempts) {
            const root = String(attempt["root"]);
            expect(root.startsWith(join(stateRoot, "snapshots"))).toBe(true);
        }
    });

    it.skipIf(process.platform === "win32")("a shared per-test engine path keeps the resume fingerprint stable", async () => {
        const dir = tempDir();
        const stateRoot = join(dir, "state");
        const engineRoot = fakeEngineRoot(dir);
        const manifest = manifestFor(["syn-t1", "syn-t2"]);
        expect(resolve(engineRoot).startsWith(resolve(dir))).toBe(true);

        process.env.FAKE_PLAN_JSON = JSON.stringify({ queries: { [pairKey("syn-t1", "body")]: "exit-crash" } });
        const reportsDir = join(stateRoot, "reports");
        const baseArgs = [
            "--engine-root",
            engineRoot,
            "--manifest",
            manifest,
            "--split",
            "dev",
            "--formulation",
            "both",
            "--state-root",
            stateRoot,
            "--accept-license-review",
        ];
        const base = {
            thresholds: FAST,
            tickMs: 50,
            samplerMs: null,
            nodeArgs: [] as string[],
            workerEntry: FAKE_WORKER,
            loadEngine: async () => stubEngine(),
            listGroup: async () => [] as never[],
            expectedEngineHash: "test-engine-hash",
            runId: "fixture-path-resume-1",
        };
        const code1 = await runDriverCli(baseArgs, { ...base, maxExtraLaunches: 0 });
        expect(code1).toBe(3);

        process.env.FAKE_PLAN_JSON = JSON.stringify({});
        const checkpointPath = onlyCheckpoint(reportsDir);
        const code2 = await runDriverCli([...baseArgs, "--resume", checkpointPath], { ...base, runId: "fixture-path-resume-2" });
        expect(code2).toBe(0);

        const argsRecord = JSON.parse(readFileSync(`${checkpointPath}.args.json`, "utf8")) as { engineRoot: string };
        expect(argsRecord.engineRoot).toBe(resolve(engineRoot));

        const raw = readFileSync(checkpointPath, "utf8");
        expect(raw).not.toContain("/tmp/fake-snap");
        expect(raw).not.toContain("/tmp/fake-engine");
        const state = loadCheckpoint(checkpointPath);
        expect(state.outcomes.size).toBe(4);
        for (const attempt of state.attempts) {
            const root = String(attempt["root"]);
            expect(root.startsWith(join(stateRoot, "snapshots"))).toBe(true);
        }
    });
});
