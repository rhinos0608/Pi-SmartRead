/**
 * D46 runner refusal-path tests (no engine IO, no network).
 * Every integrity/holdout refusal in scripts/eval/d46/run.ts is exercised:
 * sealed-manifest mismatch, dirty/pinned checkout drift, holdout opened
 * without --open-holdout/--freeze, freeze arm mismatch, freeze
 * engine-hash mismatch, and holdout redaction (no query text or gold).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    checkHoldoutGuard,
    parseD46RunArgs,
    redactForHoldout,
    verifyCheckoutPins,
    verifySplitManifest,
} from "../../../scripts/eval/d46/run.js";
import type { D46SplitManifest } from "../../../scripts/eval/d46/validate.js";

function sha(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function manifestWith(files: Array<{ file: string; content: string }>): {
    dir: string;
    manifest: D46SplitManifest;
} {
    const dir = mkdtempSync(join(tmpdir(), "d46-split-"));
    for (const f of files) writeFileSync(join(dir, f.file), f.content);
    const manifest = {
        version: 1,
        split: "dev",
        createdAt: new Date().toISOString(),
        files: files.map((f) => ({ file: f.file, sha256: sha(f.content), queryCount: 1 })),
        artifacts: [],
        countsByClass: {},
        countsByRepo: {},
        repos: [],
        queriesSha256: "q",
    } as unknown as D46SplitManifest;
    writeFileSync(join(dir, "MANIFEST.sha256.json"), JSON.stringify(manifest));
    return { dir, manifest };
}

describe("parseD46RunArgs", () => {
    it("parses the documented CLI surface", () => {
        expect(
            parseD46RunArgs(["--split", "dev", "--config", "off", "--replicate", "2"]),
        ).toEqual({ split: "dev", repo: null, config: "off", replicate: 2, freeze: null, openHoldout: false });
        expect(
            parseD46RunArgs(["--split", "holdout", "--repo", "a__b", "--freeze", "f", "--open-holdout"]),
        ).toEqual({ split: "holdout", repo: "a__b", config: "off", replicate: 1, freeze: "f", openHoldout: true });
    });

    it("rejects bad split/config/replicate", () => {
        expect(() => parseD46RunArgs(["--split", "nope"])).toThrow();
        expect(() => parseD46RunArgs(["--split", "dev", "--config", "t045"])).toThrow();
        expect(() => parseD46RunArgs(["--split", "dev", "--replicate", "0"])).toThrow();
    });
});

describe("verifySplitManifest refusals", () => {
    it("passes on a matching seal", () => {
        const { dir, manifest } = manifestWith([{ file: "a__b.jsonl", content: "{}\n" }]);
        expect(verifySplitManifest(dir, manifest)).toEqual([]);
    });

    it("refuses on changed content", () => {
        const { dir, manifest } = manifestWith([{ file: "a__b.jsonl", content: "{}\n" }]);
        writeFileSync(join(dir, "a__b.jsonl"), "{\"tampered\":true}\n");
        expect(verifySplitManifest(dir, manifest).some((e) => e.includes("changed"))).toBe(true);
    });

    it("refuses on missing sealed files and unsealed extras", () => {
        const { dir, manifest } = manifestWith([{ file: "a__b.jsonl", content: "{}\n" }]);
        writeFileSync(join(dir, "extra.jsonl"), "{}\n");
        const errors = verifySplitManifest(dir, { ...manifest, files: [...manifest.files, { file: "gone.jsonl", sha256: "x", queryCount: 0 }] });
        expect(errors.some((e) => e.includes("missing"))).toBe(true);
        expect(errors.some((e) => e.includes("unsealed"))).toBe(true);
    });

    it("refuses on a missing split dir", () => {
        const { manifest } = manifestWith([{ file: "a.jsonl", content: "x" }]);
        expect(verifySplitManifest(join(tmpdir(), "d46-no-such-dir"), manifest).length).toBeGreaterThan(0);
    });
});

describe("verifyCheckoutPins refusals", () => {
    const pins = [
        {
            owner: "honojs",
            name: "hono",
            split: "dev",
            sha: "abc",
            branch: "main",
            license: { spdx: "MIT", file: "LICENSE", sha256: "x" },
            corpusRoot: ".",
            fileCount: 1,
            workingTree: "w",
        },
    ] as unknown as Parameters<typeof verifyCheckoutPins>[1];
    const q = (repo: string) => [{ id: "q", repo } as unknown as Parameters<typeof verifyCheckoutPins>[0][number]];

    it("refuses a moved HEAD", () => {
        const errors = verifyCheckoutPins(q("honojs/hono"), pins, "/tmp", {
            head: () => "def",
            clean: () => true,
        });
        expect(errors.some((e) => e.includes("pinned"))).toBe(true);
    });

    it("refuses a dirty tree at the pinned sha", () => {
        const errors = verifyCheckoutPins(q("honojs/hono"), pins, "/tmp", {
            head: () => "abc",
            clean: () => false,
        });
        expect(errors.some((e) => e.includes("not clean"))).toBe(true);
    });

    it("refuses unpinned repos and passes a clean pin", () => {
        expect(
            verifyCheckoutPins(q("other/repo"), pins, "/tmp", { head: () => "abc", clean: () => true }).length,
        ).toBeGreaterThan(0);
        expect(
            verifyCheckoutPins(q("honojs/hono"), pins, "/tmp", { head: () => "abc", clean: () => true }),
        ).toEqual([]);
    });
});

describe("checkHoldoutGuard refusals", () => {
    const ranking = {
        rankTestDemote: 0.7,
        rankFilename: false,
        rankBm25k1: 1.2,
        rankBm25b: 0.75,
        rankCoverage: false,
        rankStopwords: false,
    };
    const freeze = { engineSourceHash: "sha256:abc:1-files", arms: [{ config: "off" as const, replicate: 1, ranking }] };
    const base = {
        split: "holdout" as const,
        openHoldout: true,
        freeze,
        config: "off" as const,
        replicate: 1,
        ranking,
        engineSourceHash: "sha256:abc:1-files",
    };

    it("passes dev without a freeze and a matching holdout arm", () => {
        expect(checkHoldoutGuard({ ...base, split: "dev", openHoldout: false, freeze: null })).toBeNull();
        expect(checkHoldoutGuard(base)).toBeNull();
    });

    it("refuses holdout without --open-holdout and without --freeze", () => {
        expect(checkHoldoutGuard({ ...base, openHoldout: false })).toMatch(/open-holdout/);
        expect(checkHoldoutGuard({ ...base, freeze: null })).toMatch(/freeze/);
    });

    it("refuses engine-hash drift and unlisted arms", () => {
        expect(checkHoldoutGuard({ ...base, engineSourceHash: "sha256:other:1-files" })).toMatch(/engine source hash/);
        expect(checkHoldoutGuard({ ...base, config: "t040" })).toMatch(/not a listed freeze arm/);
        expect(checkHoldoutGuard({ ...base, replicate: 5 })).toMatch(/not a listed freeze arm/);
        expect(checkHoldoutGuard({ ...base, ranking: { ...ranking, rankFilename: true } })).toMatch(
            /not a listed freeze arm/,
        );
    });
});

describe("redactForHoldout", () => {
    it("strips query text and gold from holdout rows only", () => {
        const row = { id: "h-001", query: "secret text", gold: [{ path: "src/a.ts" }], covered: true };
        const redacted = redactForHoldout(row, true);
        expect(JSON.stringify(redacted)).not.toContain("secret text");
        expect(redacted["gold"]).toEqual([]);
        expect(redacted["covered"]).toBe(true);
        expect(redactForHoldout(row, false)).toEqual(row);
    });
});
