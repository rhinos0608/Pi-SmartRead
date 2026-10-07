/**
 * External grep engine-source identity (D48): the external report must
 * record engineSourceHash via the shared hashEngineSources helper (no
 * local duplicate) and bind it into the run digest. Unknown hashes stay
 * unknown and never claim a known identity.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashEngineSources, isKnownSourceHash } from "../../../scripts/eval/judge/grep-e2e-contract.js";
import {
    computeExternalRunDigest,
    gitRootFromScript,
} from "../../../scripts/eval/external/grep/run-identity.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("external grep engine source hash", () => {
    it("records unknown without a git root and never claims a known identity", () => {
        const gitRoot = gitRootFromScript("file:///nonexistent-dir-xyz/run.ts");
        expect(gitRoot).toBe(null);
        expect(isKnownSourceHash("unknown:no-git-root")).toBe(false);
    });

    it("returns unknown (never a fake hash) when git is unavailable", () => {
        const hash = hashEngineSources("/nonexistent-git-root-xyz");
        expect(hash.startsWith("unknown:")).toBe(true);
        expect(isKnownSourceHash(hash)).toBe(false);
    });

    it("binds the engine hash into the run digest", () => {
        const base = {
            engineSourceHash: "sha256:abc:3-files",
            manifestSha256: "manifest-1",
            seed: "external-grep-v1",
            rankingKnobs: { rankBm25k1: 1.2 },
            outcomesJson: "[]",
        };
        const same = computeExternalRunDigest(base);
        expect(computeExternalRunDigest({ ...base })).toBe(same);
        expect(
            computeExternalRunDigest({ ...base, engineSourceHash: "sha256:def:4-files" }),
        ).not.toBe(same);
    });

    it("run.ts imports the shared helper and records the hash", () => {
        const source = readFileSync(resolve(REPO_ROOT, "scripts/eval/external/grep/run.ts"), "utf8");
        expect(source).toContain("hashEngineSources");
        expect(source).toContain("grep-e2e-contract.js");
        expect(source).toContain("engineSourceHash");
        expect(source).toContain("unknown:no-git-root");
    });
});
