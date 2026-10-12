/**
 * Pin-mismatch revision tests (review note 1): the worker's datasetFailure
 * receipt must carry the resolved dataset revision (run.ts:509), not
 * "unknown", and driver-run.ts must pass it through WorkerConfig.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { launchDetachedWorker } from "../../../scripts/holdout-v2/driver-run.js";
import { pinMismatchRecords } from "../../../scripts/holdout-v2/driver-worker.js";
import { runSynthetic } from "./holdout-v2-driver-harness.js";

const entry = { repo: "pinned/org", baseCommit: "a".repeat(40), dataset: "swe-bench-multilingual" };
const instance = { instanceId: "syn-x", repo: "row/org", baseCommit: "b".repeat(40) };

describe("pin-mismatch revision", () => {
    it("datasetFailure carries the resolved revision", () => {
        const { exclusion, datasetFailure } = pinMismatchRecords(entry, instance, "rev-test");
        expect(exclusion).toEqual({
            instanceId: "syn-x",
            reason: "pin-mismatch",
            stage: "dataset",
            dataset: "swe-bench-multilingual",
            pinned: `${entry.repo}@${entry.baseCommit}`,
            row: `${instance.repo}@${instance.baseCommit}`,
        });
        expect(datasetFailure).toMatchObject({ dataset: "swe-bench-multilingual", revision: "rev-test", instanceIds: ["syn-x"] });
    });
    it.skipIf(process.platform === "win32")("supervisor passes the resolved revision in WorkerConfig", async () => {
        let revision: unknown = undefined;
        const { code } = await runSynthetic({
            plan: {},
            hooks: {
                launchWorker: async (spec) => {
                    revision = (JSON.parse(readFileSync(spec.configPath, "utf8")) as { revision?: unknown }).revision;
                    return launchDetachedWorker(spec);
                },
            },
        });
        expect(code).toBe(0);
        expect(revision).toBe("rev-test");
    });
});
