/**
 * Driver resume, report-equivalence, merge, mode and gate tests (synthetic).
 *
 * Same stub-engine + fake-worker harness as the watchdog suite: no engine,
 * no network. POSIX-only (process-group supervision).
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCheckpoint, pairKey } from "../../../scripts/holdout-v2/driver-checkpoint.js";
import { runDriverCli, launchDetachedWorker } from "../../../scripts/holdout-v2/driver-run.js";
import { mergeAttemptReports } from "../../../scripts/holdout-v2/merge-attempts.js";
import {
    FAST,
    FAKE_WORKER,
    fakeEngineRoot,
    manifestFor,
    onlyCheckpoint,
    onlyReport,
    runSynthetic,
    stubEngine,
    tempDir,
} from "./holdout-v2-driver-harness.js";

// run.ts:653-702 field order, mirrored exactly by assembleDriverReport.
const RUN_TS_FIELD_ORDER = [
    "generatedAt",
    "engine",
    "judge",
    "split",
    "formulations",
    "seed",
    "datasetRevision",
    "manifestPath",
    "manifestCanonical",
    "manifestSha256",
    "state",
    "inputs",
    "deletion",
    "engineSourceHash",
    "rankingKnobs",
    "summary",
    "excluded",
    "excludedCount",
    "datasetFailures",
    "outcomes",
];

describe.skipIf(process.platform === "win32")("driver resume/report/merge/modes", () => {
    it("crash mid-checkpoint resumes without duplicate, skip or mislabel", async () => {
        const torn = pairKey("syn-t1", "body");
        const { code, reportsDir } = await runSynthetic({ plan: { queries: { [torn]: "torn-crash-once" } } });
        expect(code).toBe(0);
        const ckpt = loadCheckpoint(onlyCheckpoint(reportsDir));
        expect(ckpt.tornLineDropped).toBe(false); // torn line was overwritten by resume, not loaded
        expect(ckpt.outcomes.size).toBe(4);
        const report = JSON.parse(readFileSync(onlyReport(reportsDir), "utf8"));
        const keys = report.outcomes.map((o: { instanceId: string; formulation: string }) => pairKey(o.instanceId, o.formulation));
        expect(keys).toEqual([pairKey("syn-t1", "title"), torn, pairKey("syn-t2", "title"), pairKey("syn-t2", "body")]);
    });
    it("resume after a supervisor restart completes the remaining pairs in order", async () => {
        const dir = tempDir();
        const stateRoot = join(dir, "state");
        const engineRoot = fakeEngineRoot(dir);
        const manifest = manifestFor(["syn-t1", "syn-t2"]);
        // Run 1: worker crashes after the first pair; no relaunches allowed.
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
        const shared = {
            thresholds: FAST,
            tickMs: 50,
            samplerMs: null,
            nodeArgs: [],
            workerEntry: FAKE_WORKER,
            loadEngine: async () => stubEngine(),
            listGroup: async () => [],
            expectedEngineHash: "test-engine-hash",
            runId: "restart-probe",
        };
        const code1 = await runDriverCli(baseArgs, { ...shared, maxExtraLaunches: 0 });
        expect(code1).toBe(3);
        const ckptPath = onlyCheckpoint(reportsDir);
        const mid = loadCheckpoint(ckptPath);
        expect(mid.outcomes.size).toBe(1);
        // Run 2: resume with an all-ok plan.
        process.env.FAKE_PLAN_JSON = JSON.stringify({});
        const code2 = await runDriverCli([...baseArgs, "--resume", ckptPath], shared);
        expect(code2).toBe(0);
        const report = JSON.parse(readFileSync(onlyReport(reportsDir), "utf8"));
        expect(report.outcomes.map((o: { instanceId: string; formulation: string }) => pairKey(o.instanceId, o.formulation))).toEqual([
            pairKey("syn-t1", "title"),
            pairKey("syn-t1", "body"),
            pairKey("syn-t2", "title"),
            pairKey("syn-t2", "body"),
        ]);
    });
    it("report has run.ts field order and consistent summary.errors", async () => {
        const errPair = pairKey("syn-t2", "body");
        const { code, reportsDir } = await runSynthetic({
            plan: { status: { [errPair]: "timeout:watchdog-query" }, queries: { [pairKey("syn-t1", "title")]: "hang" } },
        });
        expect(code).toBe(0);
        const report = JSON.parse(readFileSync(onlyReport(reportsDir), "utf8"));
        expect(Object.keys(report)).toEqual(RUN_TS_FIELD_ORDER);
        expect(report.engine).toBe("smartread-grep");
        expect(report.judge).toBe("off");
        const errorCount = report.outcomes.filter((o: { status: string }) => o.status.startsWith("error:") || o.status.startsWith("timeout:")).length;
        expect(report.summary.errors).toBe(errorCount);
        expect(report.summary.errors).toBe(2);
        expect(report.excludedCount).toBe(report.excluded.length);
    });
    it("merge-attempts accepts a driver-produced all-ok report", async () => {
        const { code, reportsDir } = await runSynthetic({ plan: {} });
        expect(code).toBe(0);
        const report = JSON.parse(readFileSync(onlyReport(reportsDir), "utf8"));
        const out = join(tempDir(), "merged.json");
        const { report: merged } = mergeAttemptReports({
            attempts: [{ path: "driver-report.json", report }],
            expectedInstanceIds: ["syn-t1", "syn-t2"],
            outputPath: out,
        });
        expect((merged.outcomes as unknown[]).length).toBe(4);
        expect((merged.attemptMerge as { pairsTakenFromEachAttempt: number[] }).pairsTakenFromEachAttempt).toEqual([4]);
    });
    it("cold-per-pair mode spawns one worker per pair", async () => {
        let launches = 0;
        const { code, reportsDir } = await runSynthetic({
            plan: {},
            formulation: "title",
            extraArgs: ["--mode", "cold-per-pair"],
            hooks: {
                launchWorker: async (spec) => {
                    launches += 1;
                    return launchDetachedWorker(spec);
                },
            },
        });
        expect(code).toBe(0);
        expect(launches).toBe(2);
        const report = JSON.parse(readFileSync(onlyReport(reportsDir), "utf8"));
        expect(report.outcomes).toHaveLength(2);
    });
    it("load sampler writes loadavg sidecar records", async () => {
        const { code, reportsDir } = await runSynthetic({ plan: {}, hooks: { samplerMs: 100 } });
        expect(code).toBe(0);
        const ckpt = onlyCheckpoint(reportsDir);
        if (process.platform !== "win32") {
            expect(statSync(`${ckpt}.load.log`).mode & 0o777).toBe(0o600);
        }
        const log = JSON.parse(`[${readFileSync(`${ckpt}.load.log`, "utf8").trim().split("\n").join(",")}]`) as Array<{
            ts: string;
            loadavg: number[];
            workerTreeCpuS: number;
        }>;
        expect(log.length).toBeGreaterThan(0);
        for (const sample of log) {
            expect(typeof sample.ts).toBe("string");
            expect(sample.loadavg).toHaveLength(3);
            expect(typeof sample.workerTreeCpuS).toBe("number");
        }
    });
    it("refuses holdout without --open-holdout and mismatched engine hash", async () => {
        const dir = tempDir();
        const engineRoot = fakeEngineRoot(dir);
        const holdoutManifest = join(dir, "holdout.json");
        writeFileSync(holdoutManifest, JSON.stringify({ version: 2, dev: [], holdout: [{ id: "h1" }], sha256: "cd".repeat(32) }));
        process.env.FAKE_PLAN_JSON = JSON.stringify({});
        const base = {
            thresholds: FAST,
            tickMs: 50,
            samplerMs: null,
            nodeArgs: [],
            workerEntry: FAKE_WORKER,
            loadEngine: async () => stubEngine(),
            listGroup: async () => [],
            expectedEngineHash: "test-engine-hash",
            runId: "gate-probe",
        };
        const refused = await runDriverCli(
            ["--engine-root", engineRoot, "--manifest", holdoutManifest, "--split", "holdout", "--state-root", join(dir, "s"), "--accept-license-review"],
            base,
        );
        expect(refused).toBe(2);
        const opened = await runDriverCli(
            ["--engine-root", engineRoot, "--manifest", holdoutManifest, "--split", "holdout", "--open-holdout", "--state-root", join(dir, "s2"), "--accept-license-review"],
            base,
        );
        // h1 is not in the stub instance set: dataset-stage exclusion, zero pairs, still a complete report.
        expect(opened).toBe(0);
        const mismatch = await runDriverCli(
            ["--engine-root", engineRoot, "--manifest", manifestFor(["syn-t1"]), "--split", "dev", "--state-root", join(dir, "s3"), "--accept-license-review"],
            { ...base, expectedEngineHash: "sha256:wrong", runId: "gate-probe-2" },
        );
        expect(mismatch).toBe(2);
    });
    it("excluded instances land in excluded receipts with no pairs", async () => {
        const { code, reportsDir } = await runSynthetic({ plan: { setups: { "syn-t1": "exclude" } } });
        expect(code).toBe(0);
        const report = JSON.parse(readFileSync(onlyReport(reportsDir), "utf8"));
        expect(report.excluded).toHaveLength(1);
        expect(report.excluded[0]).toMatchObject({ instanceId: "syn-t1", reason: "missing-at-base" });
        expect(report.outcomes.map((o: { instanceId: string }) => o.instanceId)).toEqual(["syn-t2", "syn-t2"]);
    });
    it("status-class counts distinguish internal, watchdog and other errors", async () => {
        const bodies: Record<string, string> = {
            [pairKey("syn-t1", "title")]: "timeout:Operation aborted",
            [pairKey("syn-t1", "body")]: "error:boom",
        };
        const { code, reportsDir } = await runSynthetic({
            plan: { status: bodies, queries: { [pairKey("syn-t2", "title")]: "hang" } },
        });
        expect(code).toBe(0);
        const receiptPath = `${onlyCheckpoint(reportsDir)}.receipt.json`;
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        expect(receipt.statusClasses.counts).toMatchObject({
            "internal-limit": 1,
            "watchdog-query": 1,
            "other-error": 1,
            ok: 1,
        });
        expect(receipt.engineHashBefore).toBe("test-engine-hash");
        expect(receipt.engineHashAfter).toBe("test-engine-hash");
        expect(receipt.thresholds.queryWatchdogMs).toBe(FAST.queryWatchdogMs);
    });
});
