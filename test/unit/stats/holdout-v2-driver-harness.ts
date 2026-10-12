/**
 * Shared synthetic harness for driver supervisor tests (no engine, no network).
 *
 * Stub engine + temp owned root + fake worker wiring. Imported by the
 * holdout-v2-driver-*.test.ts suites; not itself a test file.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";
import { runDriverCli, type DriverTestHooks, type SupervisorEngine } from "../../../scripts/holdout-v2/driver-run.js";

export const FAKE_WORKER = new URL("./fixtures/holdout-v2-fake-worker.mjs", import.meta.url).pathname;

const dirs: string[] = [];
export function tempDir(): string {
    // Canonical temp root: merge-attempts refuses symlinked ancestors (macOS /var -> /private/var).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "holdout-v2-drv-")));
    dirs.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
    delete process.env.FAKE_PLAN_JSON;
});

export const INSTANCES = [
    { instanceId: "syn-t1", repo: "o/r1", baseCommit: "a".repeat(40) },
    { instanceId: "syn-t2", repo: "o/r2", baseCommit: "b".repeat(40) },
];

export function stubEngine(): SupervisorEngine {
    return {
        fetchAllRows: async () => [],
        datasetRevision: () => "rev-test",
        rowsToInstances: () => ({ instances: INSTANCES.map((i) => ({ ...i })), skipped: [] }),
        ensureDatasetFileCached: async () => {},
        readCachedRows: async () => [],
        msbRowsToInstances: () => ({ instances: [], skipped: [] }),
        MULTI_SWE_BENCH_FILES: [],
        multiSweBenchFileRepo: () => null,
        loadFrozenManifest: (path: string) => JSON.parse(readFileSync(path, "utf8")),
        frozenSplitIds: (manifest: { dev: Array<{ id: string }>; holdout: Array<{ id: string }> }, split: string, opts: { openHoldout: boolean }) => {
            if (split === "dev") return { ids: manifest.dev.map((d) => d.id), holdoutWarning: null };
            if (split === "holdout") {
                if (!opts.openHoldout) throw new Error("refuses-holdout: --split holdout is single-use per D41");
                return { ids: manifest.holdout.map((h) => h.id), holdoutWarning: null };
            }
            throw new Error("--split must be dev|holdout for a frozen manifest");
        },
        selectPilot: () => [],
        freezeManifest: () => ({ pilot: [], dev: [], sha256: "x" }),
        writeManifest: () => "",
        resolveExternalStateRoot: (v) => v ?? null,
        ensureOwnedStateRoot: (root: string) => ({
            root,
            reposDir: join(root, "repos"),
            snapshotsDir: join(root, "snapshots"),
            multilingualDir: join(root, "datasets", "multi"),
            multiSweBenchDir: join(root, "datasets", "msb"),
            reportsDir: join(root, "reports"),
        }),
        bareRepoDirUnder: (root: string, repo: string) => join(root, "repos", repo.replace("/", "__")),
        snapshotDirUnder: (root: string, id: string) => join(root, "snapshots", id),
        hashEngineSources: () => "test-engine-hash",
        gitRootFromScript: () => null,
        resolveGrepRankingOptions: () => ({}),
        toRankReportSettings: (o: Record<string, unknown>) => o,
        computeInstanceMetrics: (input: { instance: unknown; formulation: string; elapsedMs: number; status: string }) => ({
            instanceId: (input.instance as { instanceId: string }).instanceId,
            formulation: input.formulation,
            rankedFiles: [],
            goldRanks: [],
            successAt5: false,
            recallAt5: 0,
            mrr: 0,
            hunkOverlapAt5: 0,
            overTokenCap: false,
            renderedTokens: 0,
            elapsedMs: input.elapsedMs,
            status: input.status,
            topEngine: null,
        }),
        summarizeMetrics: (metrics: unknown[]) => {
            const rows = metrics as Array<{ status: string }>;
            return {
                runs: rows.length,
                errors: rows.filter((m) => m.status.startsWith("error:") || m.status.startsWith("timeout:")).length,
                overTokenCap: 0,
                successAt5: `${rows.length}/${rows.length}`,
                meanRecallAt5: 0,
                meanMRR: 0,
                meanHunkOverlapAt5: 0,
                meanRenderedTokens: 0,
                meanElapsedMs: 0,
            };
        },
        computeExternalRunDigest: (input: Record<string, unknown>) =>
            createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 8),
    };
}

export function manifestFor(ids: string[]): string {
    const dir = tempDir();
    const path = join(dir, "manifest.json");
    writeFileSync(
        path,
        JSON.stringify({
            version: 2,
            dev: ids.map((id) => ({ id, repo: "o/r1", baseCommit: "a".repeat(40), dataset: "swe-bench-multilingual" })),
            holdout: [],
            sha256: "ab".repeat(32),
        }),
    );
    return path;
}

export const FAST = {
    queryWatchdogMs: 800,
    setupCheckMs: 120,
    setupStallChecks: 3,
    setupHardCapMs: 20000,
    killGraceMs: 200,
};

export interface RunOpts {
    plan: Record<string, unknown>;
    hooks?: DriverTestHooks;
    extraArgs?: string[];
    formulation?: string;
    stateRoot?: string;
    manifest?: string;
}

export async function runSynthetic({ plan, hooks = {}, extraArgs = [], formulation = "both", stateRoot, manifest }: RunOpts): Promise<{
    code: number;
    reportsDir: string;
    stateRoot: string;
    manifest: string;
}> {
    const root = stateRoot ?? join(tempDir(), "state");
    const manifestPath = manifest ?? manifestFor(["syn-t1", "syn-t2"]);
    process.env.FAKE_PLAN_JSON = JSON.stringify(plan);
    const code = await runDriverCli(
        [
            "--engine-root",
            "/tmp/fake-engine",
            "--manifest",
            manifestPath,
            "--split",
            "dev",
            "--formulation",
            formulation,
            "--state-root",
            root,
            "--accept-license-review",
            ...extraArgs,
        ],
        {
            thresholds: FAST,
            tickMs: 50,
            samplerMs: null,
            nodeArgs: [],
            workerEntry: FAKE_WORKER,
            loadEngine: async () => stubEngine(),
            listGroup: async () => [],
            expectedEngineHash: "test-engine-hash",
            runId: `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
            ...hooks,
        },
    );
    return { code, reportsDir: join(root, "reports"), stateRoot: root, manifest: manifestPath };
}

export function onlyCheckpoint(reportsDir: string): string {
    const file = readdirSync(reportsDir).find((f) => f.endsWith(".jsonl") && !f.endsWith(".load.log"));
    if (!file) throw new Error(`no checkpoint in ${reportsDir}`);
    return join(reportsDir, file);
}

export function onlyReport(reportsDir: string): string {
    const file = readdirSync(reportsDir).find((f) => f.startsWith("external-grep-") && f.endsWith(".json"));
    if (!file) throw new Error(`no report in ${reportsDir}`);
    return join(reportsDir, file);
}
