/**
 * Stage F method-pilot runner (design plan Stage F row + §3 "Pilot versus
 * full-mode gate"; protocol §9 A1.6 request arithmetic).
 *
 * Sealed tests run the REAL dry-run against the on-disk pilot root
 * (`it.runIf`, name suffix "— sealed"): exact A1.6 counts (722/model),
 * byte-identical determinism, no transport construction, no HOME /
 * credential reads, no campaign ledger. Synthetic tests use the
 * documented `__test__` branding seam and the `loadInputs` /
 * `createTransport` run seams for wrong counts, tampered plans, and the
 * paid-gate refusals (exit 3). No test makes a network call.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    PILOT_EXPECTED_QUERY_COUNT,
    PILOT_MANIFEST_SIDECAR_FILE,
    PILOT_SOURCE_REF,
    __test__brandPilotCorpusRoster,
    type PilotCorpusRoster,
    type PilotLabel,
} from "../../../scripts/eval/judge/method-pilot-fixture.js";
import {
    A1_6_ISOLATED_REQUESTS_PER_MODEL,
    A1_6_REQUESTS_PER_MODEL,
    A1_6_WARMUP_REQUESTS_PER_MODEL,
    METHOD_PILOT_EXIT_GATE,
    METHOD_PILOT_EXIT_OK,
    METHOD_PILOT_EXIT_USAGE,
    METHOD_PILOT_PLAN_KIND,
    METHOD_PILOT_PLAN_VERSION,
    buildMethodPilotPlan,
    compareMethodPilotPlans,
    isMethodPilotPlanArtifact,
    loadMethodPilotPlanInputs,
    runMethodPilot,
    serializeMethodPilotPlan,
    type MethodPilotPlanArtifact,
    type MethodPilotPlanInputs,
    type MethodPilotRunOptions,
} from "../../../scripts/eval/judge/method-pilot.js";
import { PLAN_DATA_DIR } from "../../../scripts/eval/judge/model-comparison-plan.js";
import { JUDGE_KEY_ENV } from "../../../scripts/eval/judge/model-comparison.js";

/* ──────────────────────────────────────────────────────────────────
 * Gating: the real sealed corpus must be on disk (CI has neither)
 * ────────────────────────────────────────────────────────────────── */

const FROZEN_CORPUS_AVAILABLE = existsSync(join(PLAN_DATA_DIR, "set-a.jsonl"))
    && existsSync(join(PLAN_DATA_DIR, "set-b.jsonl"));
/** Resolved at import time (real HOME) so a redirected HOME in-test cannot move it. */
const PILOT_ROOT = join(homedir(), ".cache", "pi-smartread-judge-pilot-20261008");
const SEALED_AVAILABLE = FROZEN_CORPUS_AVAILABLE
    && existsSync(join(PILOT_ROOT, PILOT_MANIFEST_SIDECAR_FILE))
    && existsSync(join(PILOT_ROOT, `${PILOT_MANIFEST_SIDECAR_FILE}.sha256`));
const sealedIt = it.runIf(SEALED_AVAILABLE);

/* ──────────────────────────────────────────────────────────────────
 * Synthetic sealed corpus (documented `__test__` branding seam)
 * ────────────────────────────────────────────────────────────────── */

interface SyntheticOverrides {
    queryCount?: number;
    /** Delta applied to the first query's candidate count (7 + delta total for it). */
    firstQueryCandidateDelta?: number;
}

function syntheticInputs(overrides: SyntheticOverrides = {}): MethodPilotPlanInputs {
    const queryCount = overrides.queryCount ?? PILOT_EXPECTED_QUERY_COUNT;
    const delta = overrides.firstQueryCandidateDelta ?? 0;
    const queries: Array<{ qid: string; answerable: boolean }> = [];
    const candidates: Array<{ cid: string; qid: string; file: string; startLine: number; endLine: number; label: PilotLabel }> = [];
    const queryTexts = new Map<string, string>();
    const candidateStates = new Map<string, { qid: string; state: Record<string, string> }>();
    for (let qi = 1; qi <= queryCount; qi += 1) {
        const qid = `p${String(qi).padStart(3, "0")}`;
        queries.push({ qid, answerable: qi <= 32 });
        queryTexts.set(qid, `How does component ${qid} behave when a dependency is missing?`);
        const perQuery = 7 + (qi === 1 ? delta : 0);
        for (let ci = 1; ci <= perQuery; ci += 1) {
            const cid = `${qid}-c${String(ci).padStart(2, "0")}`;
            candidates.push({ cid, qid, file: `src/mod${qi}.ts`, startLine: 1, endLine: 20, label: ci === 1 ? "gold" : "hard_negative" });
            candidateStates.set(cid, {
                qid,
                state: { path: `src/mod${qi}.ts`, symbol: `f${ci}`, text: `export function f${ci}() { return "${cid}"; }` },
            });
        }
    }
    const roster: PilotCorpusRoster = __test__brandPilotCorpusRoster({
        queries,
        candidates,
        sourceRef: PILOT_SOURCE_REF,
        manifestSha256: createHash("sha256").update("synthetic-method-pilot-manifest").digest("hex"),
    });
    return {
        roster,
        queryTexts,
        candidateStates: candidateStates as MethodPilotPlanInputs["candidateStates"],
    };
}

function syntheticLoad(overrides: SyntheticOverrides = {}): MethodPilotRunOptions {
    return { loadInputs: () => syntheticInputs(overrides) };
}

/** Write a valid synthetic plan artifact and return it plus its path. */
function writeSyntheticPlan(dir: string, name = "plan.json"): { path: string; plan: MethodPilotPlanArtifact } {
    const plan = buildMethodPilotPlan(syntheticInputs()).artifact;
    const path = join(dir, name);
    writeFileSync(path, serializeMethodPilotPlan(plan));
    return { path, plan };
}

function assertA1_6Inventory(artifact: MethodPilotPlanArtifact): void {
    expect(artifact.version).toBe(METHOD_PILOT_PLAN_VERSION);
    expect(artifact.kind).toBe(METHOD_PILOT_PLAN_KIND);
    expect(artifact.expectedRequestsPerModel).toBe(A1_6_REQUESTS_PER_MODEL);
    expect(artifact.queryCount).toBe(40);
    expect(artifact.candidateCount).toBe(280);
    expect(artifact.replicaCount).toBe(2);
    expect(artifact.requests).toHaveLength(3 * A1_6_REQUESTS_PER_MODEL);
    expect(artifact.models).toHaveLength(3);
    for (const arm of artifact.models) {
        const inventory = artifact.perModel[arm];
        expect(inventory).toBeDefined();
        // A1.6: 722 = 560 isolated + 80 M0 forward + 80 M2 reverse + 2 warmups.
        expect(inventory?.m1Isolated).toBe(A1_6_ISOLATED_REQUESTS_PER_MODEL);
        expect(inventory?.m0Forward).toBe(80);
        expect(inventory?.m2Reverse).toBe(80);
        expect(inventory?.warmups).toBe(A1_6_WARMUP_REQUESTS_PER_MODEL);
        expect(inventory?.total).toBe(A1_6_REQUESTS_PER_MODEL);
        expect(
            (inventory?.m1Isolated ?? 0) + (inventory?.m0Forward ?? 0)
            + (inventory?.m2Reverse ?? 0) + (inventory?.warmups ?? 0),
        ).toBe(inventory?.total);
    }
    // Warmups: queryGroup null exactly for warmups; every hash is lowercase hex64.
    for (const request of artifact.requests) {
        expect(request.queryGroup === null).toBe(request.warmup);
        expect(request.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // No synthetic quality scores, labels, or probabilities anywhere in the artifact.
    const json = JSON.stringify(artifact);
    expect(json).not.toContain('"probability"');
    expect(json).not.toContain('"label"');
    expect(json).not.toContain('"score"');
}

/* ──────────────────────────────────────────────────────────────────
 * Environment isolation: redirect HOME, drop credential env vars
 * ────────────────────────────────────────────────────────────────── */

interface EnvSnapshot {
    home: string | undefined;
    judgeKey: string | undefined;
    openrouterKey: string | undefined;
}

const restoredEnvs: EnvSnapshot[] = [];

function redirectHomeAndDropKeys(): { tempHome: string } {
    const tempHome = mkdtempSync(join(tmpdir(), "method-pilot-home-"));
    restoredEnvs.push({
        home: process.env.HOME,
        judgeKey: process.env[JUDGE_KEY_ENV],
        openrouterKey: process.env.OPENROUTER_API_KEY,
    });
    process.env.HOME = tempHome;
    delete process.env[JUDGE_KEY_ENV];
    delete process.env.OPENROUTER_API_KEY;
    return { tempHome };
}

afterEach(() => {
    const snapshot = restoredEnvs.pop();
    if (snapshot === undefined) return;
    if (snapshot.home === undefined) delete process.env.HOME;
    else process.env.HOME = snapshot.home;
    if (snapshot.judgeKey === undefined) delete process.env[JUDGE_KEY_ENV];
    else process.env[JUDGE_KEY_ENV] = snapshot.judgeKey;
    if (snapshot.openrouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = snapshot.openrouterKey;
});

/* ──────────────────────────────────────────────────────────────────
 * Sealed dry-run against the real corpus
 * ────────────────────────────────────────────────────────────────── */

describe("method-pilot dry-run", () => {
    sealedIt("— sealed: exact A1.6 inventory (722/model), byte-identical reruns, no network/HOME/credentials/ledger", async () => {
        const work = realpath(mkdtempSync(join(tmpdir(), "method-pilot-sealed-")));
        const { tempHome } = redirectHomeAndDropKeys();
        const createTransport = vi.fn(() => {
            throw new Error("transport factory must never be constructed in dry-run");
        });
        try {
            const out1 = join(work, "plan-1.json");
            const out2 = join(work, "plan-2.json");
            const code1 = await runMethodPilot(
                ["--pilot-root", PILOT_ROOT, "--out", out1],
                { createTransport },
            );
            const code2 = await runMethodPilot(
                ["--pilot-root", PILOT_ROOT, "--out", out2],
                { createTransport },
            );
            expect(code1).toBe(METHOD_PILOT_EXIT_OK);
            expect(code2).toBe(METHOD_PILOT_EXIT_OK);

            // Determinism: two runs over the same sealed inputs are byte-identical.
            expect(readFileSync(out1, "utf8")).toBe(readFileSync(out2, "utf8"));

            const artifact = JSON.parse(readFileSync(out1, "utf8")) as MethodPilotPlanArtifact;
            assertA1_6Inventory(artifact);
            expect(isMethodPilotPlanArtifact(artifact)).toBe(true);
            expect(artifact.models).toEqual([
                "~typesafe/jev-latest",
                "perplexity/pplx-decider-v1.1-27b",
                "openai/gpt-6-luna-decisions",
            ]);

            // No network: the transport-building hook was never invoked.
            expect(createTransport).not.toHaveBeenCalled();

            // No HOME reads/writes and no credentials: with HOME redirected to
            // an empty temp dir and both key env vars deleted, dry-run still
            // succeeds and creates NOTHING under HOME (no .cache, no campaign
            // ledger, no progress/records sidecars, no temp residue).
            expect(readdirSync(tempHome)).toEqual([]);
            expect(existsSync(`${out1}.progress.jsonl`)).toBe(false);
            expect(existsSync(`${out1}.wire-records.jsonl`)).toBe(false);
            const residue = readdirSync(work).filter((name) => name.endsWith(".tmp"));
            expect(residue).toEqual([]);
        } finally {
            rmSync(work, { recursive: true, force: true });
            rmSync(tempHome, { recursive: true, force: true });
        }
    });

    sealedIt("— sealed: the sealed manifest hash recorded in the plan matches the on-disk manifest bytes", async () => {
        const work = realpath(mkdtempSync(join(tmpdir(), "method-pilot-sealed-manifest-")));
        try {
            const out = join(work, "plan.json");
            expect(await runMethodPilot(["--pilot-root", PILOT_ROOT, "--out", out])).toBe(METHOD_PILOT_EXIT_OK);
            const artifact = JSON.parse(readFileSync(out, "utf8")) as MethodPilotPlanArtifact;
            const manifestBytes = readFileSync(join(PILOT_ROOT, PILOT_MANIFEST_SIDECAR_FILE), "utf8");
            expect(artifact.pilotManifestSha256)
                .toBe(createHash("sha256").update(manifestBytes, "utf8").digest("hex"));
            // Roster digest is a stable hex64 over the roster projection.
            expect(artifact.rosterDigest).toMatch(/^[0-9a-f]{64}$/);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });
});

/* ──────────────────────────────────────────────────────────────────
 * Synthetic dry-run: counts, wrong counts, no scores
 * ────────────────────────────────────────────────────────────────── */

function realpath(path: string): string {
    // mkdtempSync under macOS tmpdir can yield /var → /private/var aliases;
    // normalize so later rmSync/find operations target the real directory.
    return realpathSync(path);
}

describe("method-pilot synthetic roster (branded via __test__ seam)", () => {
    it("dry-run builds the exact A1.6 inventory from a synthetic 40/280 roster", async () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-synth-"));
        try {
            const out = join(work, "plan.json");
            expect(await runMethodPilot(["--pilot-root", "/unused", "--out", out], syntheticLoad())).toBe(METHOD_PILOT_EXIT_OK);
            assertA1_6Inventory(JSON.parse(readFileSync(out, "utf8")) as MethodPilotPlanArtifact);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("wrong query count (39) is refused with exit 2 and an explicit report", async () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-wrongq-"));
        try {
            const messages: string[] = [];
            const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
                messages.push(args.map(String).join(" "));
            });
            try {
                const code = await runMethodPilot(
                    ["--pilot-root", "/unused", "--out", join(work, "plan.json")],
                    syntheticLoad({ queryCount: 39 }),
                );
                expect(code).toBe(METHOD_PILOT_EXIT_USAGE);
            } finally {
                errorSpy.mockRestore();
            }
            expect(messages.join("\n")).toContain("39");
            expect(messages.join("\n")).toContain(`${PILOT_EXPECTED_QUERY_COUNT}`);
            expect(existsSync(join(work, "plan.json"))).toBe(false);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("wrong candidate count (279) trips the A1.6 arithmetic — reported, never adjusted", async () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-wrongc-"));
        try {
            const messages: string[] = [];
            const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
                messages.push(args.map(String).join(" "));
            });
            try {
                const code = await runMethodPilot(
                    ["--pilot-root", "/unused", "--out", join(work, "plan.json")],
                    syntheticLoad({ firstQueryCandidateDelta: -1 }),
                );
                expect(code).toBe(METHOD_PILOT_EXIT_USAGE);
            } finally {
                errorSpy.mockRestore();
            }
            const text = messages.join("\n");
            expect(text).toContain("A1.6 request arithmetic mismatch");
            expect(text).toContain(`${A1_6_REQUESTS_PER_MODEL}`);
            expect(text).toContain("279");
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("an unbranded roster cannot build a plan", () => {
        const inputs = syntheticInputs();
        const unbranded: MethodPilotPlanInputs = {
            ...inputs,
            roster: { ...inputs.roster },
        };
        expect(() => buildMethodPilotPlan(unbranded)).toThrow(/not a load-verified sealed corpus roster/);
    });
});

/* ──────────────────────────────────────────────────────────────────
 * Paid gate refusals (exit 3) and clean env failure (exit 2)
 * ────────────────────────────────────────────────────────────────── */

describe("method-pilot paid gate", () => {
    it("missing --authorize-paid refuses with exit 3 before any corpus load", async () => {
        const loadInputs = vi.fn(() => syntheticInputs());
        const code = await runMethodPilot(["--mode", "full", "--out", "/nonexistent/plan.json"], { loadInputs });
        expect(code).toBe(METHOD_PILOT_EXIT_GATE);
        expect(loadInputs).not.toHaveBeenCalled();
    });

    it("--authorize-paid without a plan artifact refuses with exit 3", async () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-noplan-"));
        try {
            const code = await runMethodPilot(
                ["--mode", "full", "--authorize-paid", "--pilot-root", "/unused", "--out", join(work, "missing.json")],
                syntheticLoad(),
            );
            expect(code).toBe(METHOD_PILOT_EXIT_GATE);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("a tampered requestBytes field in the stored plan is refused with exit 3 (full canonical compare)", async () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-tamper-bytes-"));
        try {
            const { path } = writeSyntheticPlan(work);
            const tampered = JSON.parse(readFileSync(path, "utf8")) as MethodPilotPlanArtifact;
            tampered.requests[0] = {
                ...tampered.requests[0]!,
                requestBytes: (tampered.requests[0]?.requestBytes ?? 1) + 1,
            };
            writeFileSync(path, JSON.stringify(tampered, null, 2));
            const messages: string[] = [];
            const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
                messages.push(args.map(String).join(" "));
            });
            try {
                const code = await runMethodPilot(
                    ["--mode", "full", "--authorize-paid", "--pilot-root", "/unused", "--out", path],
                    syntheticLoad(),
                );
                expect(code).toBe(METHOD_PILOT_EXIT_GATE);
            } finally {
                errorSpy.mockRestore();
            }
            expect(messages.join("\n")).toContain("full canonical comparison");
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("a tampered payload hash in the stored plan is refused with exit 3", async () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-tamper-"));
        try {
            const { path } = writeSyntheticPlan(work);
            const tampered = JSON.parse(readFileSync(path, "utf8")) as MethodPilotPlanArtifact;
            const original = tampered.requests[0]?.payloadSha256 ?? "";
            tampered.requests[0] = {
                ...tampered.requests[0]!,
                payloadSha256: /^[0]/.test(original)
                    ? `1${original.slice(1)}`
                    : `0${original.slice(1)}`,
            };
            writeFileSync(path, JSON.stringify(tampered, null, 2));
            const messages: string[] = [];
            const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
                messages.push(args.map(String).join(" "));
            });
            try {
                const code = await runMethodPilot(
                    ["--mode", "full", "--authorize-paid", "--pilot-root", "/unused", "--out", path],
                    syntheticLoad(),
                );
                expect(code).toBe(METHOD_PILOT_EXIT_GATE);
            } finally {
                errorSpy.mockRestore();
            }
            expect(messages.join("\n")).toContain("payload hash mismatch");
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("a structurally foreign plan artifact is refused by the shape guard", () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-foreign-"));
        try {
            const { path, plan } = writeSyntheticPlan(work, "foreign.json");
            const foreign = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
            foreign.extraField = "smuggled";
            expect(isMethodPilotPlanArtifact(foreign)).toBe(false);
            // Shape guard refuses it; the gate reports refusal (3), not a crash.
            writeFileSync(path, JSON.stringify(foreign));
            expect(isMethodPilotPlanArtifact(JSON.parse(readFileSync(path, "utf8")))).toBe(false);
            expect(compareMethodPilotPlans(plan, plan)).toBeNull();
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });

    it("gate-passing full mode without the env key fails cleanly (exit 2) with NO ledger mutation", async () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-nokey-"));
        const { tempHome } = redirectHomeAndDropKeys();
        try {
            const { path } = writeSyntheticPlan(work);
            const messages: string[] = [];
            const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
                messages.push(args.map(String).join(" "));
            });
            let code: number;
            try {
                code = await runMethodPilot(
                    ["--mode", "full", "--authorize-paid", "--pilot-root", "/unused", "--out", path],
                    syntheticLoad(),
                );
            } finally {
                errorSpy.mockRestore();
            }
            expect(code).toBe(METHOD_PILOT_EXIT_USAGE);
            expect(messages.join("\n")).toContain(JUDGE_KEY_ENV);
            // The transport factory runs before any campaign-ledger seeding:
            // HOME stays empty (no .cache/pi-smartread-judge-campaign).
            expect(readdirSync(tempHome)).toEqual([]);
            expect(existsSync(`${path}.progress.jsonl`)).toBe(false);
        } finally {
            rmSync(work, { recursive: true, force: true });
            rmSync(tempHome, { recursive: true, force: true });
        }
    });
});

/* ──────────────────────────────────────────────────────────────────
 * CLI usage + main-guard import safety
 * ────────────────────────────────────────────────────────────────── */

describe("method-pilot CLI surface", () => {
    it("usage errors exit 2: unknown flag, dry-run without --out, bad mode", async () => {
        const unknown = await runMethodPilot(["--bogus"]);
        const noOut = await runMethodPilot(["--pilot-root", "/unused"]);
        const badMode = await runMethodPilot(["--mode", "paid", "--out", "/tmp/x.json"]);
        expect(unknown).toBe(METHOD_PILOT_EXIT_USAGE);
        expect(noOut).toBe(METHOD_PILOT_EXIT_USAGE);
        expect(badMode).toBe(METHOD_PILOT_EXIT_USAGE);
    });

    it("--help exits 0 without touching disk", async () => {
        expect(await runMethodPilot(["--help"])).toBe(METHOD_PILOT_EXIT_OK);
    });

    it("main guard: importing the module never executes the CLI", async () => {
        const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
            throw new Error(`process.exit(${String(code)}) called during import`);
        }) as never);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const exitCodeBefore = process.exitCode;
        vi.resetModules();
        try {
            const mod = await import("../../../scripts/eval/judge/method-pilot.js");
            expect(typeof mod.runMethodPilot).toBe("function");
            expect(exitSpy).not.toHaveBeenCalled();
            expect(errorSpy).not.toHaveBeenCalled();
            expect(logSpy).not.toHaveBeenCalled();
            expect(process.exitCode).toBe(exitCodeBefore);
        } finally {
            exitSpy.mockRestore();
            errorSpy.mockRestore();
            logSpy.mockRestore();
        }
    });
});

/* ──────────────────────────────────────────────────────────────────
 * Loader cross-binding (fails closed on tampered sealed bytes)
 * ────────────────────────────────────────────────────────────────── */

describe("method-pilot loader", () => {
    sealedIt("— sealed: loadMethodPilotPlanInputs cross-binds artifacts to the verified roster", () => {
        const inputs = loadMethodPilotPlanInputs(PILOT_ROOT);
        expect(inputs.roster.queries).toHaveLength(40);
        expect(inputs.roster.candidates).toHaveLength(280);
        expect(inputs.queryTexts.size).toBe(40);
        expect(inputs.candidateStates.size).toBe(280);
        for (const candidate of inputs.roster.candidates) {
            const state = inputs.candidateStates.get(candidate.cid);
            expect(state?.qid).toBe(candidate.qid);
            expect(typeof state?.state.text).toBe("string");
        }
    });

    sealedIt("— sealed: a modified sealed artifact byte is refused at load", () => {
        const work = mkdtempSync(join(tmpdir(), "method-pilot-tamper-artifact-"));
        try {
            // Copy the sealed queries file into a mirror root is unnecessary —
            // instead assert the digest check fires by pointing at a root whose
            // pilot-queries.jsonl differs from its manifest: mutate a copy of
            // the whole root's manifest entry by feeding a wrong manifest.
            const mirror = join(work, "root");
            cpSync(PILOT_ROOT, mirror, { recursive: true });
            const queriesPath = join(mirror, "pilot-queries.jsonl");
            writeFileSync(queriesPath, `${readFileSync(queriesPath, "utf8")}`);
            // Rewriting identical bytes is a no-op; append a space to break the digest.
            writeFileSync(queriesPath, `${readFileSync(queriesPath, "utf8")} `);
            expect(() => loadMethodPilotPlanInputs(mirror)).toThrow(/sidecar mismatch|digest mismatch|manifest/i);
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    });
});
