/**
 * Narrow lifecycle regression test for the PR47 load-sampler race.
 *
 * A fast worker can exit before the first supervisor tick fires. The
 * supervisor must still emit a valid configured sampling sidecar
 * (`<checkpoint>.load.log`) in that case instead of leaving ENOENT.
 *
 * Determinism: tickMs (2000ms) far exceeds the fast fake-worker runtime
 * (~150ms), so the exit path always wins the supervisor race without any
 * injected sleeps or busy-wait. The race resolves via the exit promise;
 * no test time is spent waiting for the tick.
 *
 * POSIX-only (process-group supervision), like the other driver suites.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDriverCli } from "../../../scripts/holdout-v2/driver-run.js";
import {
    FAKE_WORKER,
    FAST,
    manifestFor,
    onlyCheckpoint,
    stubEngine,
    tempDir,
} from "./holdout-v2-driver-harness.js";

describe.skipIf(process.platform === "win32")("driver load sampler lifecycle", () => {
    it("emits a sidecar even when the worker exits before the first tick", async () => {
        const root = join(tempDir(), "state");
        const manifestPath = manifestFor(["syn-t1", "syn-t2"]);
        process.env.FAKE_PLAN_JSON = JSON.stringify({});
        const code = await runDriverCli(
            [
                "--engine-root",
                "/tmp/fake-engine",
                "--manifest",
                manifestPath,
                "--split",
                "dev",
                "--formulation",
                "title",
                "--state-root",
                root,
                "--accept-license-review",
            ],
            {
                thresholds: FAST,
                tickMs: 2000,
                samplerMs: 100,
                nodeArgs: [],
                workerEntry: FAKE_WORKER,
                loadEngine: async () => stubEngine(),
                listGroup: async () => [],
                expectedEngineHash: "test-engine-hash",
                runId: "sampler-fast-exit-probe",
            },
        );
        expect(code).toBe(0);
        const ckpt = onlyCheckpoint(join(root, "reports"));
        expect(statSync(`${ckpt}.load.log`).mode & 0o777).toBe(0o600);
        const log = JSON.parse(
            `[${readFileSync(`${ckpt}.load.log`, "utf8").trim().split("\n").join(",")}]`,
        ) as Array<{ ts: string; loadavg: number[]; workerTreeCpuS: number }>;
        expect(log.length).toBeGreaterThan(0);
        for (const sample of log) {
            expect(typeof sample.ts).toBe("string");
            expect(sample.loadavg).toHaveLength(3);
            expect(typeof sample.workerTreeCpuS).toBe("number");
        }
    });
});
