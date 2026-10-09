import { describe, expect, it, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";

afterEach(() => {
    // Fault flags are armed per-attempt inside the mocked wire; never leak
    // across tests (a leaked flag would fault unrelated admissions).
    delete (globalThis as Record<string, unknown>).__campaignLedgerDirOpenFail;
    delete (globalThis as Record<string, unknown>).__campaignLedgerRenameFail;
});
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        // Test-only fault injection for settlement durability paths. Flags are
        // armed inside the mocked wire AFTER the real attempt so admission is
        // unaffected: __campaignLedgerDirOpenFail faults the post-rename
        // directory open (ledger already renamed/persisted), while
        // __campaignLedgerRenameFail faults the rename itself
        // (pre-persistence: reserve stays in-flight). No other openSync
        // "r" / renameSync call sites exist on this path. Node20 official
        // fs signatures (openSync/renameSync) unchanged.
        openSync: ((p: unknown, flags?: unknown, mode?: unknown) => {
            if (flags === "r" && typeof p === "string"
                && !p.endsWith(".tmp") && !p.endsWith(".json")
                && (globalThis as Record<string, unknown>).__campaignLedgerDirOpenFail === true) {
                const err = new Error(`EIO: i/o error, open '${p}'`) as NodeJS.ErrnoException;
                err.code = "EIO";
                throw err;
            }
            return (actual.openSync as (...a: unknown[]) => unknown)(p, flags, mode) as never;
        }) as typeof actual.openSync,
        renameSync: ((oldP: unknown, newP: unknown) => {
            if (typeof newP === "string" && newP.endsWith("campaign-ledger.json")
                && (globalThis as Record<string, unknown>).__campaignLedgerRenameFail === true) {
                const err = new Error(`EIO: i/o error, rename '${String(oldP)}' -> '${newP}'`) as NodeJS.ErrnoException;
                err.code = "EIO";
                throw err;
            }
            return (actual.renameSync as (...a: unknown[]) => unknown)(oldP, newP) as never;
        }) as typeof actual.renameSync,
    };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
    AuthStorage: { create: () => { throw new Error("no store in unit tests"); } },
}));
import {
    COMPARISON_MODELS,
    FULL_RUN_NOT_AUTHORISED,
    MAX_INPUT_TOKENS_PER_REQUEST,
    buildProbeInput,
    estimateFullRun,
    hasJudgeKey,
    normalizeCallerOutPath,
    parseComparisonArgs,
    resolveProbeApiKey,
    runModelComparisonProbe,
    validateProbability,
} from "../../../scripts/eval/judge/model-comparison.js";
import { unitRelevanceQuestion } from "../../../src/judge/questions.js";

function cannedFetch(servedModel: string, answers: Record<string, unknown>, usage: Record<string, number>) {
    return vi.fn(async (_url: string, _init?: RequestInit) =>
        new Response(
            JSON.stringify({ id: "gen-test", model: servedModel, provider: "Test", answers, usage }),
            { status: 200, headers: { "content-type": "application/json" } },
        ));
}

describe("validateProbability", () => {
    it("accepts finite numbers in [0,1]", () => {
        expect(validateProbability(0.5)).toEqual({ ok: true, p: 0.5 });
        expect(validateProbability(0)).toEqual({ ok: true, p: 0 });
        expect(validateProbability(1)).toEqual({ ok: true, p: 1 });
    });
    it("rejects non-numeric, NaN, and out-of-range values explicitly", () => {
        for (const bad of ["0.5", Number.NaN, -0.1, 1.1, undefined, null, {}, []]) {
            expect(validateProbability(bad)).toEqual({ ok: false });
        }
    });
});

describe("parseComparisonArgs", () => {
    it("rejects unknown arguments fail-closed", () => {
        expect(() => parseComparisonArgs(["--frobnicate"])).toThrow(/Unknown argument/);
    });
    it("rejects full mode as not authorised without any request", () => {
        const parsed = parseComparisonArgs(["--mode", "full"]);
        expect(parsed.mode).toBe("full");
        expect(FULL_RUN_NOT_AUTHORISED).toMatch(/NOT authorised/i);
    });
    it("pins exactly the three requested model slugs by default", () => {
        expect(parseComparisonArgs([]).models).toEqual([...COMPARISON_MODELS]);
        expect(COMPARISON_MODELS).toEqual([
            "~typesafe/jev-latest",
            "perplexity/pplx-decider-v1.1-27b",
            "openai/gpt-6-luna-decisions",
        ]);
    });
});

describe("buildProbeInput", () => {
    it("builds one fixed input with stable content hashes", () => {
        const a = buildProbeInput();
        const b = buildProbeInput();
        expect(a.items).toHaveLength(2);
        expect(a.candidateHash).toBe(b.candidateHash);
        expect(a.criterionHash).toBe(b.criterionHash);
        expect(a.candidateHash).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("runModelComparisonProbe (mocked transport)", () => {
    it("sends the same labelled input across models and captures per-item records", async () => {
        const fetchFn = cannedFetch("served/snapshot-1", { u0: 0.9, u1: 0.2 }, { input_tokens: 500, cost: 0.00002 });
        const report = await runModelComparisonProbe({
            apiKey: "test-key",
            models: ["~typesafe/jev-latest", "perplexity/pplx-decider-v1.1-27b"],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { ephemeral: true },
        });
        expect(report.results).toHaveLength(2);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        const bodies = fetchFn.mock.calls.map((c) => JSON.parse((c[1]?.body ?? "{}") as string));
        expect(bodies[0].state).toEqual(bodies[1].state);
        expect(bodies[0].questions).toEqual(bodies[1].questions);
        expect(bodies[0].model).not.toBe(bodies[1].model);
        for (const r of report.results) {
            expect(r.status).toBe("ok");
            expect(r.scores.u0).toBe(0.9);
            expect(r.requestTimestamp).toBeTruthy();
            expect(r.latencyMs).toBeGreaterThanOrEqual(0);
            expect(r.candidateHash).toBeTruthy();
        }
        expect(report.requestCount).toBe(2);
    });

    it("records malformed answers as failures, never as p=0.5", async () => {
        const fetchFn = cannedFetch("served/snapshot-1", { u0: "noul" }, { input_tokens: 10, cost: 0 });
        const report = await runModelComparisonProbe({
            apiKey: "k",
            models: ["~typesafe/jev-latest"],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { ephemeral: true },
        });
        const [r] = report.results;
        expect(r!.status).toBe("bad_response");
        expect(r!.scores).toEqual({});
        expect(Object.values(r!.scores)).not.toContain(0.5);
        expect(report.validCoverage.unjudged).toBe(2);
    });

    it("records transport errors by code only, leaking no secret material", async () => {
        const secret = "sk-or-super-secret-xyz";
        const fetchFn = vi.fn(async () => new Response("boom", { status: 502 }));
        const report = await runModelComparisonProbe({
            apiKey: secret,
            models: ["~typesafe/jev-latest"],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { ephemeral: true },
        });
        const dumped = JSON.stringify(report);
        expect(dumped).not.toContain(secret);
        expect(dumped).not.toContain("Bearer");
        expect(report.results[0]!.status).toMatch(/http_502|timeout|network/);
    });

    it("stops fail-closed once the spend cap is reached, disclosing honest totals", async () => {
        // Reserve-consistent fake costs: each under its model's
        // context-window reserve (Jev $0.001344, Pplx $0.01048576) so the
        // campaign layer stays quiet, but summing past the $0.01 probe
        // cap after two models so the third stops gracefully.
        const costByModel: Record<string, number> = {
            "~typesafe/jev-latest": 0.0012,
            "perplexity/pplx-decider-v1.1-27b": 0.009,
            "openai/gpt-6-luna-decisions": 0.00001,
        };
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
            const cost = costByModel[body.model ?? ""] ?? 0;
            return new Response(
                JSON.stringify({ id: "gen-test", model: "served/s", provider: "Test", answers: { u0: 0.5, u1: 0.5 }, usage: { input_tokens: 100, cost } }),
                { status: 200, headers: { "content-type": "application/json" } },
            );
        });
        const report = await runModelComparisonProbe({
            apiKey: "k",
            models: [...COMPARISON_MODELS],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { ephemeral: true },
        });
        expect(fetchFn.mock.calls.length).toBe(2);
        expect(report.stoppedEarly).toBe(true);
        expect(report.totalCostUsd).toBeCloseTo(0.0102, 12);
        expect(report.results.length).toBe(2);
        expect(report.campaignCostComplete).toBe(true);
    });

    it("artifact sidecar hashes the exact bytes written", async () => {
        const { mkdtempSync, readFileSync, realpathSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "probe-sidecar-")));
        const outPath = join(dir, "report.json");
        const fetchFn = cannedFetch("served/s", { u0: 0.9, u1: 0.1 }, { input_tokens: 500, cost: 0.00001 });
        await runModelComparisonProbe({
            apiKey: "k",
            models: [COMPARISON_MODELS[0]!],
            fetchFn: fetchFn as never,
            writeArtifact: true,
            campaign: { ephemeral: true },
            outPath,
        });
        const body = readFileSync(outPath, "utf-8");
        const sidecar = readFileSync(`${outPath}.sha256`, "utf-8");
        expect(sidecar.startsWith(createHash("sha256").update(body, "utf-8").digest("hex"))).toBe(true);
    });

    it("RED: duplicate model slugs are rejected before any fetch", async () => {
        const fetchFn = cannedFetch("served/s", { u0: 0.9, u1: 0.1 }, { input_tokens: 100, cost: 0.00001 });
        await expect(runModelComparisonProbe({
            apiKey: "k",
            models: [COMPARISON_MODELS[0]!, COMPARISON_MODELS[0]!],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { ephemeral: true },
        })).rejects.toThrow(/duplicate/i);
        expect(fetchFn).toHaveBeenCalledTimes(0);
    });

    it("RED: missing usage.cost stays UNKNOWN instead of 0", async () => {
        const fetchFn = cannedFetch("served/s", { u0: 0.9, u1: 0.1 }, { input_tokens: 500 });
        const report = await runModelComparisonProbe({
            apiKey: "k",
            models: [COMPARISON_MODELS[0]!],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { ephemeral: true },
        });
        expect(report.results[0]!.costUsd).toBeUndefined();
        expect(report.costComplete).toBe(false);
        expect(report.totalCostUsd).toBeUndefined();
    });

    it("RED: a retryable 502 causes exactly 1 actual HTTP attempt (no silent client retry)", async () => {
        const fetchFn = vi.fn(async () => new Response("boom", { status: 502 }));
        const report = await runModelComparisonProbe({
            apiKey: "k",
            models: [COMPARISON_MODELS[0]!],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { ephemeral: true },
        });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(report.httpAttempts).toBe(1);
        expect(report.results[0]!.status).toBe("http_502");
    });

    it("RED: criterion hash binds ALL submitted question objects with state refs + shared", async () => {
        const fetchFn = cannedFetch("served/s", { u0: 0.9, u1: 0.1 }, { input_tokens: 500, cost: 0.00001 });
        const report = await runModelComparisonProbe({
            apiKey: "k",
            models: [COMPARISON_MODELS[0]!],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { ephemeral: true },
        });
        const input = buildProbeInput();
        const shared = { query: input.query };
        const questions: Record<string, unknown> = {};
        for (const u of input.items) questions[u.id] = unitRelevanceQuestion(input.query, `units.${u.id}`);
        const expected = createHash("sha256")
            .update(JSON.stringify({ shared, questions }), "utf-8").digest("hex");
        expect(report.results[0]!.criterionHash).toBe(expected);
        const bodies = fetchFn.mock.calls.map((c) => String(c[1]?.body ?? ""));
        for (const raw of bodies) {
            expect(raw).not.toMatch(/gold|hard_negative|expected|label/);
        }
    });
    it("RED: FINAL-model charge above reserve persists the charge then halts loudly", async () => {
        const { mkdtempSync, realpathSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { loadCampaignLedger } = await import("../../../scripts/eval/judge/model-comparison-budget.js");
        // Jev reserve = 32_000 * 0.042 / 1e6 = $0.001344; mock an actual above it.
        const overReserveCost = 0.005;
        const fetchFn = cannedFetch("served/s", { u0: 0.9, u1: 0.1 }, { input_tokens: 100, cost: overReserveCost });
        const campaignRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "probe-halt-")));
        await expect(runModelComparisonProbe({
            apiKey: "k",
            models: ["~typesafe/jev-latest"],
            fetchFn: fetchFn as never,
            writeArtifact: false,
            campaign: { root: campaignRoot },
        })).rejects.toThrow(/reserve|halt|campaign/i);
        // Exactly one wire attempt: no retry, no subsequent admission, no extra fetch.
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const ledger = loadCampaignLedger(campaignRoot);
        expect(ledger.reserveBreached).toBe(true);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(1);
        expect(ledger.settled[0]!.status).toBe("settled");
        expect(ledger.settled[0]!.actualCostUsd).toBe(overReserveCost);
        expect(ledger.attempts).toBe(6 + 1);
    });
});

describe("hasJudgeKey", () => {
    it("reports a presence boolean only", () => {
        expect(typeof hasJudgeKey()).toBe("boolean");
    });
});

describe("resolveProbeApiKey (no secrets leave the store)", () => {
    it("prefers the explicit judge key without touching the SDK store", async () => {
        const resolved = await resolveProbeApiKey({ PI_SMARTREAD_JUDGE_API_KEY: "sek" } as NodeJS.ProcessEnv);
        expect(resolved).toEqual({ ok: true, key: "sek", source: "env:PI_SMARTREAD_JUDGE_API_KEY" });
    });

    it("reports absent when neither env nor store can serve (mocked store throws)", async () => {
        const resolved = await resolveProbeApiKey({} as NodeJS.ProcessEnv);
        expect(resolved).toEqual({ ok: false, reason: "absent" });
    });

    it("RED: post-rename settlement I/O after a real wire attempt halts with the ORIGINAL error (exactly 1 settle, no next model)", async () => {
        // Fault the directory durability open AFTER the mocked wire, exactly
        // like the budget RED. The atomic rename already persisted the known
        // actual, so the probe must halt loudly with the ORIGINAL EIO — no
        // second UNKNOWN settlement (which would throw "Cannot settle
        // without…" and mask it), no next model/fetch. Financial I/O is
        // never converted into a per-model network result.
        const { mkdtempSync, realpathSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { loadCampaignLedger } = await import("../../../scripts/eval/judge/model-comparison-budget.js");
        const campaignRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "probe-settle-io-")));
        const knownCost = 0.00001;
        const fetchFn = vi.fn(async () => {
            (globalThis as Record<string, unknown>).__campaignLedgerDirOpenFail = true;
            return new Response(JSON.stringify({
                id: "gen-settle", model: "served/s", provider: "Test",
                answers: { u0: 0.9, u1: 0.1 }, usage: { input_tokens: 100, cost: knownCost },
            }), { status: 200, headers: { "content-type": "application/json" } });
        });
        await expect(runModelComparisonProbe({
            apiKey: "k", models: ["~typesafe/jev-latest", "perplexity/pplx-decider-v1.1-27b"],
            fetchFn: fetchFn as never, writeArtifact: false, campaign: { root: campaignRoot },
        })).rejects.toThrow(/EIO/);
        expect(fetchFn).toHaveBeenCalledTimes(1); // no next model/fetch
        const ledger = loadCampaignLedger(campaignRoot);
        expect(ledger.inFlight).toHaveLength(0);
        expect(ledger.settled).toHaveLength(1); // exactly one settle persisted
        expect(ledger.settled[0]!.actualCostUsd).toBe(knownCost); // known actual retained
    });

    it("RED: pre-persistence settlement failure retains the reserve in-flight with no next wire", async () => {
        // Fault the rename itself AFTER the mocked wire: nothing persisted,
        // so the original admission reserve must stay on the books
        // (in-flight) and the probe must halt loudly with the ORIGINAL EIO.
        const { mkdtempSync, realpathSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const { loadCampaignLedger } = await import("../../../scripts/eval/judge/model-comparison-budget.js");
        const campaignRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "probe-settle-pre-")));
        const fetchFn = vi.fn(async () => {
            (globalThis as Record<string, unknown>).__campaignLedgerRenameFail = true;
            return new Response(JSON.stringify({
                id: "gen-settle", model: "served/s", provider: "Test",
                answers: { u0: 0.9, u1: 0.1 }, usage: { input_tokens: 100, cost: 0.00001 },
            }), { status: 200, headers: { "content-type": "application/json" } });
        });
        await expect(runModelComparisonProbe({
            apiKey: "k", models: ["~typesafe/jev-latest", "perplexity/pplx-decider-v1.1-27b"],
            fetchFn: fetchFn as never, writeArtifact: false, campaign: { root: campaignRoot },
        })).rejects.toThrow(/EIO/);
        expect(fetchFn).toHaveBeenCalledTimes(1); // no next model/fetch
        const ledger = loadCampaignLedger(campaignRoot);
        expect(ledger.settled).toHaveLength(0);
        expect(ledger.inFlight).toHaveLength(1); // original reserve retained
        expect(ledger.inFlight[0]!.reserveUsd).toBeCloseTo(0.001344, 9);
    });
});

describe("estimateFullRun", () => {
    it("produces a conservative 3-arm estimate within the documented budget shape", () => {
        const est = estimateFullRun();
        expect(est.corpusUnits).toBe(314);
        expect(est.corpusQueries).toBe(44);
        expect(est.corpusQueries).toBe(44);
        expect(est.plannedCallsPerArm).toBe(45);
        expect(est.callUpperBoundPerArm).toBe(135);
        expect(est.plannedCalls).toBe(135);
        expect(est.callUpperBound).toBe(405);
        expect(est.fiveReplicatePlannedCalls).toBe(675);
        expect(est.fiveReplicateUpperBound).toBe(2025);
        expect(est.conservativeUpperUsd).toBeLessThan(2);
        expect(est.totalCostUsd).toBeLessThan(1);
        expect(est.callUpperBound).toBeGreaterThanOrEqual(est.plannedCalls);
        expect(est.maxInputTokensPerRequest).toBeLessThanOrEqual(MAX_INPUT_TOKENS_PER_REQUEST);
    });
});

describe("caller tmp-alias compat (--out normalization at the caller boundary)", () => {
    async function freshCampaignRoot(tag: string): Promise<string> {
        const { mkdtempSync, realpathSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        return realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `probe-caller-${tag}-`)));
    }

    function okWire() {
        return cannedFetch("served/s", { u0: 0.9, u1: 0.1 }, { input_tokens: 100, cost: 0.00001 });
    }

    it("literal /tmp child path writes the exclusive 0600 artifact + exact-bytes sidecar", async () => {
        const { mkdirSync, readFileSync, statSync, realpathSync } = await import("node:fs");
        const { join, resolve } = await import("node:path");
        const campaignRoot = await freshCampaignRoot("tmpalias");
        // Unique child BELOW the canonical /tmp target; the literal alias
        // spelling is what the caller passes (macOS /tmp->/private/tmp).
        const canonicalTmp = realpathSync("/tmp");
        const tag = `caller-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        mkdirSync(join(canonicalTmp, tag), { recursive: true });
        const literalOut = join("/tmp", tag, "report.json");
        const expectedOut = resolve(join(canonicalTmp, tag, "report.json"));
        expect(normalizeCallerOutPath(literalOut)).toBe(expectedOut);
        const fetchFn = okWire();
        await runModelComparisonProbe({
            apiKey: "k", models: [COMPARISON_MODELS[0]], fetchFn: fetchFn as never,
            writeArtifact: true, outPath: literalOut, campaign: { root: campaignRoot },
        });
        const st = statSync(expectedOut);
        expect(st.isFile()).toBe(true);
        expect(st.mode & 0o777).toBe(0o600);
        const bytes = readFileSync(expectedOut, "utf-8");
        const byteHash = createHash("sha256").update(bytes, "utf-8").digest("hex");
        const sidecar = readFileSync(`${expectedOut}.sha256`, "utf-8");
        expect(sidecar).toBe(`${byteHash}  ${expectedOut}\n`);
        const sideSt = statSync(`${expectedOut}.sha256`);
        expect(sideSt.mode & 0o777).toBe(0o600);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("canonical physical path under /tmp writes the same exclusive artifact", async () => {
        const { readFileSync, statSync, realpathSync } = await import("node:fs");
        const { join, resolve } = await import("node:path");
        const campaignRoot = await freshCampaignRoot("tmpcanon");
        const canonicalTmp = realpathSync("/tmp");
        const tag = `caller-canon-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        const canonicalOut = join(canonicalTmp, tag, "report.json");
        expect(normalizeCallerOutPath(canonicalOut)).toBe(resolve(canonicalOut));
        const fetchFn = okWire();
        await runModelComparisonProbe({
            apiKey: "k", models: [COMPARISON_MODELS[0]], fetchFn: fetchFn as never,
            writeArtifact: true, outPath: canonicalOut, campaign: { root: campaignRoot },
        });
        const expectedOut = resolve(canonicalOut);
        expect(statSync(expectedOut).mode & 0o777).toBe(0o600);
        const bytes = readFileSync(expectedOut, "utf-8");
        expect(readFileSync(`${expectedOut}.sha256`, "utf-8"))
            .toBe(`${createHash("sha256").update(bytes, "utf-8").digest("hex")}  ${expectedOut}\n`);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it("nested hostile symlink below the /tmp alias stays fail-closed with zero fetches", async () => {
        const { mkdirSync, realpathSync, symlinkSync } = await import("node:fs");
        const { join } = await import("node:path");
        const campaignRoot = await freshCampaignRoot("tmpevil");
        const canonicalTmp = realpathSync("/tmp");
        const tag = `caller-evil-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        const base = join(canonicalTmp, tag);
        mkdirSync(join(base, "real"), { recursive: true });
        symlinkSync(join(base, "real"), join(base, "evil-parent"));
        const fetchFn = okWire();
        await expect(runModelComparisonProbe({
            apiKey: "k", models: [COMPARISON_MODELS[0]], fetchFn: fetchFn as never,
            writeArtifact: true, outPath: join("/tmp", tag, "evil-parent", "report.json"),
            campaign: { root: campaignRoot },
        })).rejects.toThrow(/symlink|ancestor/i);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("leaf symlink at --out is refused with zero fetches even under the OS alias", async () => {
        const { mkdirSync, realpathSync, symlinkSync, writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const campaignRoot = await freshCampaignRoot("tmpleaf");
        const canonicalTmp = realpathSync("/tmp");
        const tag = `caller-leaf-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
        mkdirSync(join(canonicalTmp, tag), { recursive: true });
        const target = join(canonicalTmp, tag, "real.json");
        writeFileSync(target, "{}", { mode: 0o600 });
        symlinkSync(target, join(canonicalTmp, tag, "link.json"));
        const fetchFn = okWire();
        await expect(runModelComparisonProbe({
            apiKey: "k", models: [COMPARISON_MODELS[0]], fetchFn: fetchFn as never,
            writeArtifact: true, outPath: join("/tmp", tag, "link.json"),
            campaign: { root: campaignRoot },
        })).rejects.toThrow(/overwrite|symlink/i);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("arbitrary user alias ancestor stays fail-closed with zero fetches", async () => {
        const { mkdirSync, symlinkSync } = await import("node:fs");
        const { join } = await import("node:path");
        const campaignRoot = await freshCampaignRoot("useralias");
        const { mkdtempSync, realpathSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "probe-useralias-")));
        mkdirSync(join(scratch, "real"), { recursive: true });
        symlinkSync(join(scratch, "real"), join(scratch, "user-alias"));
        expect(normalizeCallerOutPath(join(scratch, "user-alias", "report.json")))
            .toBe(join(scratch, "user-alias", "report.json"));
        const fetchFn = okWire();
        await expect(runModelComparisonProbe({
            apiKey: "k", models: [COMPARISON_MODELS[0]], fetchFn: fetchFn as never,
            writeArtifact: true, outPath: join(scratch, "user-alias", "report.json"),
            campaign: { root: campaignRoot },
        })).rejects.toThrow(/symlink|ancestor/i);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it("existing --out path is refused before any fetch without overwriting", async () => {
        const { mkdtempSync, realpathSync, readFileSync, writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "probe-existing-")));
        const campaignRoot = await freshCampaignRoot("existing");
        const existing = join(scratch, "report.json");
        writeFileSync(existing, "original", { mode: 0o600 });
        const fetchFn = okWire();
        await expect(runModelComparisonProbe({
            apiKey: "k", models: [COMPARISON_MODELS[0]], fetchFn: fetchFn as never,
            writeArtifact: true, outPath: existing, campaign: { root: campaignRoot },
        })).rejects.toThrow(/overwrite/i);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(readFileSync(existing, "utf-8")).toBe("original");
    });
});
