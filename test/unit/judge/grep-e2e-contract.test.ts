/**
 * R1 contract tests: run identity, checkpoint resume validation,
 * sanitized error codes, private-file guards. Pure stdlib-adjacent
 * helpers from scripts/eval/judge/grep-e2e-contract.ts — no engine IO.
 */
import { describe, expect, it } from "vitest";
import type { PairedReport } from "../../../scripts/eval/judge/grep-e2e-contract.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ALLOWED_LABELS,
    CHECKPOINT_SCHEMA_VERSION,
    checkPrivateExisting,
    computeRunFingerprint,
    errorStatus,
    hashEngineSources,
    pairReports,
    isConsistentDuplicate,
    isHardError,
    isKnownSourceHash,
    canonicalizeCorpusRoot,
    stableErrorCode,
    validateCheckpointRow,
    type CheckpointRow,
    type RunIdentityInput,
} from "../../../scripts/eval/judge/grep-e2e-contract.js";
import { classifyGoldRow } from "../../../scripts/eval/judge/grep-e2e-metrics.js";

function identity(overrides: Partial<RunIdentityInput> = {}): RunIdentityInput {
    return {
        orderedQids: ["q01", "q02"],
        fixtureSha: "aaa",
        corpusInventoryHash: "bbb",
        corpusInventoryFiles: 10,
        corpusKind: "frozen-git-archive-snapshot",
        sourceRef: "18f6463",
        engineSourceHash: "ccc",
        nodeVersion: "v20.0.0",
        modelAlias: "off",
        judgeOrigin: "off",
        gateConstants: { keep: 0.4, pointer: 0.45, exists: 0.35, find: 0.4 },
        appliedKeepOverride: null,
        params: { perQueryLimit: 20, topKWindow: 20, contextLines: 2 },
        timeoutMs: 60000,
        ...overrides,
    };
}

function row(overrides: Partial<CheckpointRow> = {}): string {
    return JSON.stringify({
        v: CHECKPOINT_SCHEMA_VERSION,
        fingerprint: "fp",
        trace: { qid: "q01" },
        outcome: { status: "ok" },
        ...overrides,
    });
}

describe("computeRunFingerprint", () => {
    it("is stable for identical inputs", () => {
        expect(computeRunFingerprint(identity())).toBe(computeRunFingerprint(identity()));
    });
    it("changes when query text selection, fixtures, corpus, source bytes, model, gates, or timeout change", () => {
        const base = computeRunFingerprint(identity());
        const variants: RunIdentityInput[] = [
            identity({ orderedQids: ["q01", "q03"] }),
            identity({ fixtureSha: "changed" }),
            identity({ corpusInventoryHash: "changed" }),
            identity({ engineSourceHash: "changed" }),
            identity({ modelAlias: "other-model", judgeOrigin: "cloud-openrouter" }),
            identity({ gateConstants: { keep: 0.5, pointer: 0.45, exists: 0.35, find: 0.4 } }),
            identity({ appliedKeepOverride: "0.35" }),
            identity({ timeoutMs: 1000 }),
        ];
        for (const v of variants) {
            expect(computeRunFingerprint(v)).not.toBe(base);
        }
    });
    it("is key-order insensitive (canonical JSON)", () => {
        const a = identity({ params: { x: 1, y: 2 } });
        const b = identity({ params: { y: 2, x: 1 } });
        expect(computeRunFingerprint(a)).toBe(computeRunFingerprint(b));
    });
});

describe("validateCheckpointRow", () => {
    const known = new Set(["q01", "q02"]);
    it("accepts a matching versioned row", () => {
        const verdict = validateCheckpointRow(row(), "fp", known);
        expect(verdict.ok).toBe(true);
    });
    it("rejects malformed rows, old/qid-only rows, unknown qids, stale fingerprints", () => {
        expect(validateCheckpointRow("not json", "fp", known)).toMatchObject({ ok: false });
        expect(validateCheckpointRow(row({ v: 0 as number }), "fp", known)).toMatchObject({
            ok: false, reason: "incompatible-schema",
        });
        expect(validateCheckpointRow(JSON.stringify({ trace: { qid: "q01" } }), "fp", known)).toMatchObject({
            ok: false, reason: "incompatible-schema",
        });
        expect(validateCheckpointRow(row(), "other-fp", known)).toMatchObject({
            ok: false, reason: "stale-fingerprint",
        });
        expect(validateCheckpointRow(row({ trace: { qid: "q99" } }), "fp", known)).toMatchObject({
            ok: false, reason: "unknown-qid",
        });
    });
    it("flags inconsistent duplicates for rerun, dedupes identical ones", () => {
        const a = (validateCheckpointRow(row(), "fp", known) as { ok: true; row: CheckpointRow }).row;
        const same = (validateCheckpointRow(row(), "fp", known) as { ok: true; row: CheckpointRow }).row;
        const diff = (validateCheckpointRow(
            row({ outcome: { status: "error:timeout" } }), "fp", known,
        ) as { ok: true; row: CheckpointRow }).row;
        expect(isConsistentDuplicate(a, same)).toBe(true);
        expect(isConsistentDuplicate(a, diff)).toBe(false);
    });
});

describe("canonicalizeCorpusRoot", () => {
    it("resolves a symlinked root to its canonical path", () => {
        const real = realpathSync(mkdtempSync(join(tmpdir(), "corpus-real-")));
        const link = `${real}-link`;
        try { rmSync(link, { recursive: true, force: true }); } catch { /* ignore */ }
        symlinkSync(real, link, "dir");
        try {
            expect(canonicalizeCorpusRoot(link)).toBe(real);
            expect(canonicalizeCorpusRoot(real)).toBe(real);
        } finally {
            rmSync(link, { recursive: true, force: true });
            rmSync(real, { recursive: true, force: true });
        }
    });
    it("passes missing paths through for the harness walk to reject", () => {
        const missing = join(tmpdir(), "smartread-no-such-corpus-dir");
        expect(canonicalizeCorpusRoot(missing)).toBe(missing);
    });
});

describe("stableErrorCode", () => {
    it("maps failures to stable codes without raw messages", () => {
        expect(stableErrorCode(new Error("TimeoutError: timed out"))).toBe("timeout");
        expect(stableErrorCode(new Error("fetch failed: ENOTFOUND example.com"))).toBe("network");
        expect(stableErrorCode(new Error("401 Unauthorized"))).toBe("auth");
        expect(stableErrorCode(new Error("weird novel failure"))).toBe("execution");
        expect(errorStatus(new Error("boom"))).toBe("error:execution");
    });
    it("never leaks key material patterns into the code itself", () => {
        const code = stableErrorCode(new Error("key sk-secret-123 rejected"));
        expect(code).not.toContain("sk-secret-123");
    });
});

describe("checkPrivateExisting", () => {
    it("rejects symlinks, group/world-readable modes, and unowned files", () => {
        const base = { mode: 0o100600, uid: 501, isSymbolicLink: () => false };
        expect(checkPrivateExisting(base, 501)).toEqual({ ok: true });
        expect(checkPrivateExisting({ ...base, isSymbolicLink: () => true }, 501)).toMatchObject({ ok: false });
        expect(checkPrivateExisting({ ...base, mode: 0o100644 }, 501)).toMatchObject({
            ok: false, reason: "refuses-non-private-mode",
        });
        expect(checkPrivateExisting(base, 999)).toMatchObject({
            ok: false, reason: "refuses-unowned-file",
        });
    });
});

describe("execution status / isHardError", () => {
    it("keeps judge_degraded measurable and errors as execution errors", () => {
        expect(isHardError("judge_degraded:judge_timeout")).toBe(false);
        expect(isHardError("error:timeout")).toBe(true);
    });

    it("classifies a harness error status as execution_error, never a retrieval outcome", () => {
        const gold = { file: "src/a.ts", startLine: 1, endLine: 5 };
        const status = errorStatus(new Error("boom"));
        expect(classifyGoldRow(gold, [], { judged: false, abstained: false, executionStatus: status }))
            .toBe("execution_error");
    });

    it("keeps measured coverage for completed judge_degraded runs", () => {
        const gold = { file: "src/a.ts", startLine: 1, endLine: 5 };
        const hit = [{ relFile: "src/a.ts", line: 2, endLine: 3 }];
        expect(classifyGoldRow(gold, hit, { judged: false, abstained: false, executionStatus: "judge_degraded:judge_timeout" }))
            .toBe("covered");
    });
});

describe("ALLOWED_LABELS", () => {
    it("covers the fixture label set", () => {
        expect([...ALLOWED_LABELS].sort()).toEqual(["easy_negative", "gold", "hard_negative"]);
    });
});

describe("hashEngineSources (temp git fixture)", () => {
    function fixtureRepo(): string {
        const dir = mkdtempSync(join(tmpdir(), "smartread-hash-fixture-"));
        const git = (...args: string[]): void => {
            execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
        };
        git("init");
        mkdirSync(join(dir, "src", "judge"), { recursive: true });
        mkdirSync(join(dir, "scripts", "eval"), { recursive: true });
        writeFileSync(join(dir, "src", "tracked.ts"), "export const a = 1;\n");
        writeFileSync(join(dir, "package.json"), "{}\n");
        git("add", "src/tracked.ts", "package.json");
        git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base");
        // Untracked runtime sources: the R1 gap (tracked-only listing misses these).
        writeFileSync(join(dir, "src", "judge", "untracked.ts"), "export const u = 1;\n");
        writeFileSync(join(dir, "scripts", "eval", "untracked-eval.ts"), "export const e = 1;\n");
        return dir;
    }
    function headOf(dir: string): string {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    }
    it("changes when untracked runtime sources change despite identical HEAD", () => {
        const dir = fixtureRepo();
        try {
            const head = headOf(dir);
            const base = hashEngineSources(dir);
            expect(isKnownSourceHash(base)).toBe(true);
            writeFileSync(join(dir, "src", "judge", "untracked.ts"), "export const u = 2;\n");
            expect(headOf(dir)).toBe(head);
            expect(hashEngineSources(dir)).not.toBe(base);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("changes when untracked runtime sources are added or deleted", () => {
        const dir = fixtureRepo();
        try {
            const base = hashEngineSources(dir);
            writeFileSync(join(dir, "src", "added.ts"), "export const n = 1;\n");
            const added = hashEngineSources(dir);
            expect(added).not.toBe(base);
            rmSync(join(dir, "scripts", "eval", "untracked-eval.ts"));
            expect(hashEngineSources(dir)).not.toBe(added);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("ignores caches, generated reports, and secrets by construction", () => {
        const dir = fixtureRepo();
        try {
            const base = hashEngineSources(dir);
            mkdirSync(join(dir, ".pi-smartread"), { recursive: true });
            writeFileSync(join(dir, ".pi-smartread", "cache.json"), "{}");
            writeFileSync(join(dir, "report.json"), "{}");
            writeFileSync(join(dir, ".env"), "KEY=secret");
            expect(hashEngineSources(dir)).toBe(base);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    it("fails closed on missing/unhashable trees", () => {
        expect(isKnownSourceHash(hashEngineSources(join(tmpdir(), "smartread-no-such-dir")))).toBe(false);
        expect(isKnownSourceHash("unknown:hash-failed")).toBe(false);
    });
});

describe("pairReports", () => {
    const manifest = (overrides: Record<string, string | number> = {}): PairedReport["manifest"] => ({
        fixtureSha: "aaa",
        inventoryHashBefore: "bbb",
        queryCount: 2,
        ...overrides,
    });
    const report = (engine: string, rows: PairedReport["queries"]): PairedReport => ({
        manifest: { ...manifest(), engineSourceHash: engine },
        queries: rows,
    });
    const base = report("sha256:base", [
        { qid: "q01", fileHit: true, covered: true, abstained: false, renderedTokens: 100, readReady: true },
        { qid: "q02", fileHit: false, covered: false, abstained: true, renderedTokens: 200, readReady: false },
    ]);
    const variant = report("sha256:variant", [
        { qid: "q01", fileHit: false, covered: false, abstained: false, renderedTokens: 150, readReady: false },
        { qid: "q02", fileHit: true, covered: true, abstained: false, renderedTokens: 200, readReady: true },
    ]);
    it("emits per-query wins/losses/ties and token deltas", () => {
        const paired = pairReports(base, variant);
        expect(paired.queryCount).toBe(2);
        expect(paired.readReady).toEqual({ wins: 1, losses: 1, ties: 0 });
        expect(paired.fileHit).toEqual({ wins: 1, losses: 1, ties: 0 });
        // q02 stopped abstaining: recorded as an abstention "loss".
        expect(paired.abstention).toEqual({ wins: 0, losses: 1, ties: 1 });
        expect(paired.meanTokenDelta).toBe(25);
        expect(paired.deltas.map((d) => d.qid)).toEqual(["q01", "q02"]);
    });
    it("tolerates engineSourceHash differences but refuses other identity mismatches", () => {
        expect(() => pairReports(base, variant)).not.toThrow();
        expect(() => pairReports(
            { ...base, manifest: manifest({ fixtureSha: "zzz" }) },
            variant,
        )).toThrow(/fixtureSha/);
        expect(() => pairReports(
            { ...base, manifest: manifest({ inventoryHashBefore: "zzz" }) },
            variant,
        )).toThrow(/inventory/);
        expect(() => pairReports(
            base,
            { ...variant, queries: [...variant.queries!].reverse() },
        )).toThrow(/qid/);
    });
});
