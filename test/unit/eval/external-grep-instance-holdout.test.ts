/**
 * E15 retrieval holdout: exposure blacklist + instance freezer.
 *
 * Pure unit tests with synthetic instances and tmp dirs only: never
 * touches the developer's bench cache, never clones, never runs a
 * freeze for real.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    blacklistHit,
    buildExposureBlacklist,
    collectManifestIds,
    collectReportIds,
    issueKeyOfInstanceId,
    loadD46Repos,
    manifestInstanceIds,
    normalizeIssueKey,
    normalizeRepo,
    reportInstanceIds,
} from "../../../scripts/eval/external/grep/exposure-blacklist.js";
import {
    bindToManifest,
    buildRetrievalHoldoutManifest,
    censusCounts,
    filterEligible,
    minDetectableEffect,
    pairedPowerSimulation,
    recordOpening,
    selectRetrievalHoldout,
    verifyAtBase,
    verifyRetrievalHoldoutManifest,
    writeNewManifest,
    type RetrievalHoldoutManifest,
} from "../../../scripts/eval/external/grep/freeze-instance-holdout.js";
import type { BenchmarkInstance } from "../../../scripts/eval/external/grep/instance.js";

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ext-grep-holdout-"));
    tmpRoots.push(dir);
    return dir;
}

let counter = 0;
function synth(over: Partial<BenchmarkInstance> = {}): BenchmarkInstance {
    counter += 1;
    const id = over.instanceId ?? `some__repo-${1000 + counter}`;
    return {
        instanceId: id,
        dataset: "swe-bench-multilingual",
        repo: "some/repo",
        baseCommit: "a".repeat(40),
        title: `title ${id}`,
        body: `body ${id}`,
        goldFiles: [`src/${id}.ts`],
        goldHunks: [{ file: `src/${id}.ts`, ranges: [{ start: 1, end: 2 }] }],
        excludedFiles: [],
        language: "ts",
        split: "dev",
        license: "MIT",
        ...over,
    };
}

describe("repo/issue normalization", () => {
    it("normalizes repo identities", () => {
        expect(normalizeRepo("Axios/Axios")).toBe("axios/axios");
        expect(normalizeRepo("axios__axios")).toBe("axios/axios");
        expect(normalizeRepo(" mrdoob/three.js.git ")).toBe("mrdoob/three.js");
    });

    it("derives linked-issue keys from instance ids", () => {
        expect(issueKeyOfInstanceId("axios__axios-4731")).toBe("axios/axios#4731");
        expect(issueKeyOfInstanceId("Axios__Axios-4731")).toBe("axios/axios#4731");
        // Non-conforming ids fall back to the normalized id (exact match).
        expect(issueKeyOfInstanceId("odd-id")).toBe("odd-id");
    });

    it("normalizes explicit issue keys", () => {
        expect(normalizeIssueKey("Axios/Axios#4731")).toBe("axios/axios#4731");
    });
});

describe("blacklist matching", () => {
    const list = buildExposureBlacklist({
        instanceIds: ["axios__axios-4731"],
        issueKeys: ["vuejs/core#9999"],
        repos: ["eslint/eslint"],
        patchHashes: ["deadbeef"],
    });

    it("blocks by instance id (case-insensitive)", () => {
        expect(blacklistHit(list, { instanceId: "Axios__Axios-4731", repo: "axios/axios" })).toBe("instance-id");
    });

    it("blocks the same issue under a different dataset id via issue key", () => {
        expect(blacklistHit(list, { instanceId: "other-1", repo: "axios/axios", issueKey: "axios/axios#4731" })).toBe(
            "issue-key",
        );
    });

    it("blocks explicit issue keys and D46 repos", () => {
        expect(blacklistHit(list, { instanceId: "vuejs__core-1", repo: "vuejs/core", issueKey: "vuejs/core#9999" })).toBe(
            "issue-key",
        );
        expect(blacklistHit(list, { instanceId: "fresh-1", repo: "ESLint/ESLint" })).toBe("repo");
    });

    it("blocks exposed patch bytes", () => {
        expect(blacklistHit(list, { instanceId: "fresh-2", repo: "fresh/repo", patchHash: "DEADBEEF" })).toBe(
            "patch-hash",
        );
    });

    it("passes clean candidates", () => {
        expect(blacklistHit(list, { instanceId: "fresh-3", repo: "fresh/repo" })).toBeNull();
    });
});

describe("disk collectors", () => {
    it("reads v1 and v2 manifest shapes", () => {
        expect(manifestInstanceIds({ pilot: ["a-1"], dev: ["b-2"], holdout: [] })).toEqual(["a-1", "b-2"]);
        expect(
            manifestInstanceIds({
                pilot: ["a-1"],
                dev: [{ id: "c-3" }, { id: "d-4" }],
                holdout: [{ id: "e-5" }],
            }),
        ).toEqual(["a-1", "c-3", "d-4", "e-5"]);
        expect(manifestInstanceIds({ nope: true })).toEqual([]);
        expect(manifestInstanceIds(null)).toEqual([]);
    });

    it("reads report outcome ids", () => {
        expect(
            reportInstanceIds({ outcomes: [{ instanceId: "a-1" }, { id: "b-2" }, {}] }),
        ).toEqual(["a-1", "b-2"]);
        expect(reportInstanceIds({ outcomes: "x" })).toEqual([]);
    });

    it("collects from dirs and tolerates missing dirs", () => {
        const dir = tmpDir();
        writeFileSync(join(dir, "m1.json"), JSON.stringify({ pilot: ["a-1"], dev: [], holdout: [] }));
        writeFileSync(join(dir, "notes.txt"), "ignored");
        const got = collectManifestIds([dir, join(dir, "missing")]);
        expect(got.ids).toEqual(["a-1"]);
        expect(got.files).toHaveLength(1);
    });

    it("collects only external-grep reports", () => {
        const dir = tmpDir();
        writeFileSync(join(dir, "external-grep-dev-x.json"), JSON.stringify({ outcomes: [{ instanceId: "a-1" }] }));
        writeFileSync(join(dir, "d46-dev-x.json"), JSON.stringify({ outcomes: [{ instanceId: "b-2" }] }));
        const got = collectReportIds(dir);
        expect(got.ids).toEqual(["a-1"]);
        expect(collectReportIds(join(dir, "missing"))).toEqual({ ids: [], files: [] });
    });

    it("loads D46 repos and tolerates a missing file", () => {
        const dir = tmpDir();
        const path = join(dir, "repos.json");
        writeFileSync(path, JSON.stringify({ repos: [{ owner: "ESLint", name: "ESLint" }, { owner: "x" }] }));
        expect(loadD46Repos(path)).toEqual(["ESLint/ESLint"]);
        expect(loadD46Repos(join(dir, "missing.json"))).toEqual([]);
    });
});

describe("eligibility and census", () => {
    it("excludes empty titles, duplicates, and blacklist hits", () => {
        const blocked = buildExposureBlacklist({
            instanceIds: ["some__repo-1001"],
            issueKeys: [],
            repos: ["blocked/repo"],
            patchHashes: [],
        });
        const instances = [
            synth({ instanceId: "some__repo-1001" }),
            synth({ instanceId: "some__repo-1002", title: "  " }),
            synth({ instanceId: "some__repo-1003", baseCommit: "" }),
            synth({ instanceId: "some__repo-1004", goldFiles: [] }),
            synth({ instanceId: "some__repo-1005", repo: "blocked/repo" }),
            synth({ instanceId: "some__repo-1005", repo: "blocked/repo" }),
            synth({ instanceId: "some__repo-1006" }),
        ];
        const { eligible, exclusions } = filterEligible(instances, blocked);
        expect(eligible.map((i) => i.instanceId)).toEqual(["some__repo-1006"]);
        expect(exclusions.map((e) => e.reason)).toEqual([
            "blacklist:instance-id",
            "empty-title",
            "missing-base-commit",
            "no-production-gold",
            "blacklist:repo",
            "duplicate-instance-id",
        ]);
    });

    it("counts by repo, language, and patch-size bucket", () => {
        const instances = [
            synth({ instanceId: "a-1", repo: "b/repo", language: "js" }),
            synth({ instanceId: "a-2", repo: "a/repo", language: "ts" }),
            synth({
                instanceId: "a-3",
                repo: "a/repo",
                language: "mixed",
                goldFiles: ["x.ts", "y.js"],
                goldHunks: [
                    { file: "x.ts", ranges: [{ start: 1, end: 9 }] },
                    { file: "y.js", ranges: [{ start: 1, end: 2 }] },
                ],
            }),
        ];
        const census = censusCounts(instances);
        expect(census.total).toBe(3);
        expect(census.byRepo).toEqual([
            { repo: "a/repo", count: 2 },
            { repo: "b/repo", count: 1 },
        ]);
        expect(census.byLanguage).toEqual({ js: 1, ts: 1, mixed: 1 });
        expect(census.byBucket).toEqual([2, 1, 0]);
    });
});

describe("verifyAtBase", () => {
    it("splits verified, missing-at-base, and unverifiable", () => {
        const instances = [synth({ instanceId: "v-1" }), synth({ instanceId: "m-1" }), synth({ instanceId: "u-1" })];
        const presentRunner = (args: string[]): string => {
            const golds = args.slice(args.indexOf("--") + 1);
            if (golds.includes("src/m-1.ts")) return "";
            if (golds.includes("src/u-1.ts")) throw new Error("git ls-tree: object missing");
            return golds.map((g) => `100644 blob abc123\t${g}`).join("\n");
        };
        const got = verifyAtBase(instances, presentRunner, () => true);
        expect(got.verified.map((i) => i.instanceId)).toEqual(["v-1"]);
        expect(got.missingAtBase).toEqual([{ instanceId: "m-1", missing: ["src/m-1.ts"] }]);
        expect(got.unverifiable).toHaveLength(1);
        expect(got.unverifiable[0]?.instanceId).toBe("u-1");
    });
});

describe("selection", () => {
    it("is deterministic with a ranked reserve tail", () => {
        const instances: BenchmarkInstance[] = [];
        for (let r = 0; r < 4; r++) {
            for (let k = 0; k < 10; k++) {
                instances.push(synth({ instanceId: `r${r}__i-${k}`, repo: `org${r}/repo`, language: k % 3 === 0 ? "ts" : "js" }));
            }
        }
        const first = selectRetrievalHoldout(instances, "seed", 20, 5);
        const second = selectRetrievalHoldout(instances, "seed", 20, 5);
        expect(first.selected.map((i) => i.instanceId)).toEqual(second.selected.map((i) => i.instanceId));
        expect(first.selected).toHaveLength(20);
        expect(first.reserve).toHaveLength(5);
        const selectedIds = new Set(first.selected.map((i) => i.instanceId));
        for (const r of first.reserve) expect(selectedIds.has(r.instanceId)).toBe(false);
        // Round-robin spreads repos across the selection head.
        expect(new Set(first.selected.slice(0, 4).map((i) => i.repo)).size).toBe(4);
    });

    it("throws on shortfall instead of silently shrinking", () => {
        expect(() => selectRetrievalHoldout([synth()], "seed", 400, 0)).toThrow(/shortfall/);
    });
});

describe("manifest and ledger", () => {
    function manifestFor(ids: string[]): RetrievalHoldoutManifest {
        const list = buildExposureBlacklist({ instanceIds: [], issueKeys: [], repos: ["d46/repo"], patchHashes: [] });
        return buildRetrievalHoldoutManifest({
            seed: "seed",
            requestedSize: ids.length,
            datasets: [{ name: "ds", revision: "rev", license: "MIT" }],
            blacklist: list,
            sourceFiles: ["/x/m.json"],
            selected: ids.map((id) => synth({ instanceId: id })),
            reserve: [],
            exclusions: [{ instanceId: "e-1", stage: "census", reason: "blacklist:repo" }],
        });
    }

    it("builds a self-verifying v3 manifest", () => {
        const manifest = manifestFor(["b-2", "a-1"]);
        expect(manifest.version).toBe(3);
        expect(manifest.entries.map((e) => e.id)).toEqual(["a-1", "b-2"]);
        expect(manifest.entries[0]?.querySha256).toHaveLength(64);
        expect(manifest.entries[0]?.goldSha256).toHaveLength(64);
        expect(verifyRetrievalHoldoutManifest(manifest)).toBe(true);
        expect(verifyRetrievalHoldoutManifest({ ...manifest, requestedSize: 999 })).toBe(false);
    });

    it("never overwrites an existing manifest file", () => {
        const dir = tmpDir();
        const path = join(dir, "freeze.json");
        writeNewManifest(manifestFor(["a-1"]), path);
        expect(() => writeNewManifest(manifestFor(["a-1"]), path)).toThrow(/refusing to overwrite/);
    });

    it("binds loaded instances and fails closed on drift", () => {
        const manifest = manifestFor(["a-1"]);
        const loaded = [synth({ instanceId: "a-1" })];
        // Synthetic title/body/gold are deterministic per id, so binding passes.
        expect(bindToManifest(manifest, loaded)).toHaveLength(1);
        expect(() => bindToManifest(manifest, [])).toThrow(/not in loaded pool/);
        expect(() => bindToManifest(manifest, [synth({ instanceId: "a-1", baseCommit: "b".repeat(40) })])).toThrow(
            /base-commit drift/,
        );
        expect(() => bindToManifest(manifest, [synth({ instanceId: "a-1", title: "changed" })])).toThrow(
            /query-text drift/,
        );
    });

    it("records exactly one opening per manifest sha", () => {
        const dir = tmpDir();
        const ledger = join(dir, "ledger.json");
        const opening = {
            manifestSha256: "abc",
            manifestPath: "/x/m.json",
            openedAt: new Date().toISOString(),
            openedBy: "test",
            purpose: "baseline vs champion",
            arms: ["baseline", "champion"],
        };
        expect(recordOpening(ledger, opening)).toHaveLength(1);
        expect(() => recordOpening(ledger, opening)).toThrow(/already opened/);
        mkdirSync(join(dir, "sub"), { recursive: true });
        const corrupt = join(dir, "sub", "ledger.json");
        writeFileSync(corrupt, JSON.stringify({ not: "array" }));
        expect(() => recordOpening(corrupt, { ...opening, manifestSha256: "def" })).toThrow(/corrupt/);
    });
});

describe("power", () => {
    it("MDE matches the normal approximation", () => {
        // sqrt(7.84 * 0.078 / 400) ~= 0.039.
        expect(minDetectableEffect(400, 0.078)).toBeCloseTo(0.039, 3);
        expect(minDetectableEffect(300, 0.078)).toBeGreaterThan(minDetectableEffect(400, 0.078));
    });

    it("simulation is seeded and monotone in effect", () => {
        const low = pairedPowerSimulation(400, 0.039, 0.078, 2000);
        const high = pairedPowerSimulation(400, 0.078, 0.078, 2000);
        expect(pairedPowerSimulation(400, 0.039, 0.078, 2000).power).toBe(low.power);
        expect(high.power).toBeGreaterThan(low.power);
        expect(low.power).toBeGreaterThanOrEqual(0);
        expect(low.power).toBeLessThanOrEqual(1);
    });
});
