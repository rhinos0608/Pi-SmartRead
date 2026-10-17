/**
 * Pin-mismatch revision tests (review note 1): the worker's datasetFailure
 * receipt must carry the resolved dataset revision (run.ts:509), not
 * "unknown", and driver-run.ts must pass it through WorkerConfig.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchDetachedWorker } from "../../../scripts/holdout-v2/driver-run.js";
import { WORKER_CONFIG_SUFFIX_RE, pinMismatchRecords } from "../../../scripts/holdout-v2/driver-worker.js";
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
        let seen: unknown = undefined;
        const { code, reportsDir } = await runSynthetic({
            plan: {},
            hooks: {
                launchWorker: async (spec) => {
                    seen = spec.config;
                    return launchDetachedWorker(spec);
                },
            },
        });
        expect(code).toBe(0);
        expect((seen as { revision?: unknown }).revision).toBe("rev-test");
        // The producer still writes the exclusive 0600 sidecar receipt, and
        // the bytes fed to the worker over stdin are identical to it.
        const sidecars = readdirSync(reportsDir).filter((f) => WORKER_CONFIG_SUFFIX_RE.test(f));
        expect(sidecars.length).toBeGreaterThan(0);
        for (const sidecar of sidecars) {
            expect(JSON.parse(readFileSync(join(reportsDir, sidecar), "utf8"))).toEqual(seen);
        }
    });
});
