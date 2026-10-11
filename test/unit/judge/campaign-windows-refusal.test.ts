import { existsSync, mkdtempSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    admitCampaignAttempt,
    loadCampaignLedger,
    migrateCampaignLedgerCap,
    seedCampaignLedger,
    settleCampaignAttempt,
    voidCampaignAttempt,
    writePrivateFileExclusive,
} from "../../../scripts/eval/judge/model-comparison-budget.js";
import {
    buildM0Request,
    executeWireRequest,
} from "../../../scripts/eval/judge/method-comparison-executor.js";
import {
    runModelComparisonProbe,
    COMPARISON_MODELS,
} from "../../../scripts/eval/judge/model-comparison.js";
import {
    executeConfirmPlan,
    type BuiltConfirmPlan,
    type ConfirmPlan,
    type ConfirmPlanRequest,
} from "../../../scripts/eval/judge/method-confirm.js";

const WINDOWS_REFUSAL_PATTERN =
    /Campaign ledger unsupported on Windows: atomic rename\/exclusive-lock\/mode semantics are unverified there; refusing fail-closed/;

/** Run `fn` under a simulated `win32` platform. Safely restores platform in finally. */
async function withSimulatedWin32<T>(fn: () => Promise<T> | T): Promise<T> {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
        return await fn();
    } finally {
        Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
}

function cleanupScratch(dir: string): void {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch (_err) {
        // Ignored: best-effort temporary test scratch cleanup
    }
}

describe("campaign ledger operations fail closed on Windows", () => {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "campaign-win-ledger-")));
    });

    afterEach(() => {
        cleanupScratch(scratchDir);
    });

    it("seedCampaignLedger refuses fail-closed with zero filesystem mutations", async () => {
        const root = join(scratchDir, "ledger-seed");
        await withSimulatedWin32(() => {
            expect(() => seedCampaignLedger(root)).toThrow(WINDOWS_REFUSAL_PATTERN);
        });
        // Zero side effects: no ledger file, no lock file, no directory created
        expect(existsSync(join(root, "campaign-ledger.json"))).toBe(false);
        expect(existsSync(join(root, "campaign-ledger.lock"))).toBe(false);
    });

    it("admitCampaignAttempt refuses fail-closed before any admission", async () => {
        const root = join(scratchDir, "ledger-admit");
        await withSimulatedWin32(() => {
            expect(() => admitCampaignAttempt(root, "M0")).toThrow(WINDOWS_REFUSAL_PATTERN);
        });
        expect(existsSync(join(root, "campaign-ledger.lock"))).toBe(false);
    });

    it("loadCampaignLedger refuses fail-closed", async () => {
        const root = join(scratchDir, "ledger-load");
        await withSimulatedWin32(() => {
            expect(() => loadCampaignLedger(root)).toThrow(WINDOWS_REFUSAL_PATTERN);
        });
    });

    it("settleCampaignAttempt refuses fail-closed", async () => {
        const root = join(scratchDir, "ledger-settle");
        await withSimulatedWin32(() => {
            expect(() => settleCampaignAttempt(root, "attempt-1", 0.0001)).toThrow(WINDOWS_REFUSAL_PATTERN);
        });
    });

    it("voidCampaignAttempt refuses fail-closed", async () => {
        const root = join(scratchDir, "ledger-void");
        await withSimulatedWin32(() => {
            expect(() => voidCampaignAttempt(root, "attempt-1")).toThrow(WINDOWS_REFUSAL_PATTERN);
        });
    });

    it("migrateCampaignLedgerCap refuses fail-closed", async () => {
        const root = join(scratchDir, "ledger-migrate");
        await withSimulatedWin32(() => {
            expect(() =>
                migrateCampaignLedgerCap(root, {
                    fromCapUsd: 3,
                    toCapUsd: 10,
                    authorization: "test-auth",
                }),
            ).toThrow(WINDOWS_REFUSAL_PATTERN);
        });
    });
});

describe("method-comparison wire execution refuses Windows with ZERO transport dispatch", () => {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "campaign-win-wire-")));
    });

    afterEach(() => {
        cleanupScratch(scratchDir);
    });

    it("executeWireRequest fails closed at admission: fetchFn never called, no records written", async () => {
        const campaignRoot = join(scratchDir, "wire-campaign");
        const transport = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

        const arm = "~typesafe/jev-latest" as const;
        const request = buildM0Request(arm, "test query", [
            { candidateId: "c1", state: { path: "src/a.ts", symbol: "s", text: "text" } },
        ])[0]!;

        await withSimulatedWin32(async () => {
            await expect(
                executeWireRequest({
                    method: "M0",
                    arm,
                    phase: "pilot",
                    replica: 0,
                    queryGroup: "q1",
                    warmup: false,
                    request,
                    transport,
                    campaignRoot,
                    sleep: async () => {},
                }),
            ).rejects.toThrow(WINDOWS_REFUSAL_PATTERN);
        });

        // Invariant: zero network transport dispatch
        expect(transport).not.toHaveBeenCalled();

        // Invariant: no records or journal written in campaignRoot
        if (existsSync(campaignRoot)) {
            const entries = readdirSync(campaignRoot);
            expect(entries.filter((e) => e.endsWith(".json") || e.endsWith(".tmp"))).toEqual([]);
        }
    });
});

describe("model-comparison probe refuses Windows with ZERO network dispatch", () => {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "campaign-win-probe-")));
    });

    afterEach(() => {
        cleanupScratch(scratchDir);
    });

    it("runModelComparisonProbe fails closed before fetch: fetchFn never called, no artifact written", async () => {
        const campaignRoot = join(scratchDir, "probe-campaign");
        const outPath = join(scratchDir, "probe-out.json");
        const fetchFn = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

        await withSimulatedWin32(async () => {
            await expect(
                runModelComparisonProbe({
                    apiKey: "test-key",
                    models: [COMPARISON_MODELS[0]],
                    fetchFn,
                    campaign: { root: campaignRoot },
                    writeArtifact: true,
                    outPath,
                }),
            ).rejects.toThrow(WINDOWS_REFUSAL_PATTERN);
        });

        // Invariant: zero HTTP fetch dispatch
        expect(fetchFn).not.toHaveBeenCalled();

        // Invariant: no artifact written
        expect(existsSync(outPath)).toBe(false);
        expect(existsSync(`${outPath}.sha256`)).toBe(false);
    });
});

describe("method confirmation plan execution refuses Windows with ZERO transport dispatch", () => {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "campaign-win-confirm-")));
    });

    afterEach(() => {
        cleanupScratch(scratchDir);
    });

    it("executeConfirmPlan fails closed: transport never called, no results written", async () => {
        const campaignRoot = join(scratchDir, "confirm-campaign");
        const outDir = join(scratchDir, "confirm-out");
        const transport = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));

        const arm = "~typesafe/jev-latest" as const;
        const candidate = {
            candidateId: "c-win",
            state: { path: "src/file.ts", symbol: "f", text: "export function f() {}" },
        };
        const request = buildM0Request(arm, "How does win test work?", [candidate])[0]!;
        const planRequest: ConfirmPlanRequest = {
            arm,
            method: "M0",
            replica: 0,
            queryGroup: "q1",
            warmup: false,
            candidateIds: [candidate.candidateId],
            payloadSha256: request.payloadSha256,
            requestBytes: request.requestBytes,
        };
        const artifact: ConfirmPlan = {
            version: 1,
            kind: "method-confirm-plan",
            manifestSha256: "a".repeat(64),
            queryCount: 1,
            candidateCount: 1,
            replicaCount: 3,
            orderingRule: "test",
            requests: [planRequest],
            inventory: {},
            replicaLadder: {
                fiveReplicaStressUsd: 0,
                fourReplicaStressUsd: 0,
                threeReplicaStressUsd: 0,
                headroomUsd: 0,
                selected: 3,
            },
            deferredSuite: "deferred",
            projection: {
                pilotBilledUsdPerQueryReplica: 0,
                scoredUsd: 0,
                warmupUsd: 0,
                deferredSuiteUsd: 0,
                nominalUsd: 0,
                stressUsd: 0,
                capUsd: 10,
                components: [],
            },
        };
        const built: BuiltConfirmPlan = { artifact, dispatch: [{ plan: planRequest, request }] };

        await withSimulatedWin32(async () => {
            await expect(
                executeConfirmPlan(built, outDir, transport, campaignRoot),
            ).rejects.toThrow(WINDOWS_REFUSAL_PATTERN);
        });

        // Invariant: zero HTTP fetch dispatch
        expect(transport).not.toHaveBeenCalled();

        // Invariant: no results file written
        expect(existsSync(join(outDir, "results.json"))).toBe(false);
    });
});

describe("private artifact creation fails closed on unsupported mode platforms", () => {
    let scratchDir: string;

    beforeEach(() => {
        scratchDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "campaign-win-priv-")));
    });

    afterEach(() => {
        cleanupScratch(scratchDir);
    });

    it.runIf(process.platform === "win32")("writePrivateFileExclusive fails closed when 0600 mode cannot be proven", () => {
        const outPath = join(scratchDir, "private-artifact.json");
        expect(() => writePrivateFileExclusive(outPath, "test")).toThrow(/cannot prove 0600/);
        expect(existsSync(outPath)).toBe(false);
    });
});
