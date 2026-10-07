/**
 * Unit tests for the external grep benchmark pipeline (dataset, gold,
 * sampling). No network: dataset rows are synthetic; the git fixture is a
 * local temp repo; snapshots land under a test instance id and are removed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyLanguageByGoldFiles, formulationText, type BenchmarkInstance } from "../../../scripts/eval/external/grep/instance.js";
import {
    computeInstanceMetrics,
    dedupeFilesByFirstAppearance,
    RENDERED_TOKEN_CAP,
    summarizeMetrics,
} from "../../../scripts/eval/external/grep/metrics.js";
import { assertMultiSweBenchLicense, msbRowsToInstances } from "../../../scripts/eval/external/grep/multi-swe-bench.js";
import { classifyPatchFile, deriveGold, parseUnifiedDiff } from "../../../scripts/eval/external/grep/patch.js";
import { assertSafeInstanceId, materializeInstance, snapshotDir } from "../../../scripts/eval/external/grep/repos.js";
import {
    buildDevHoldoutManifest,
    computeDevHoldoutSha,
    freezeManifest,
    pickHoldoutRepos,
    seededShuffle,
    selectDevHoldout,
    selectPilot,
    verifyDevHoldoutManifest,
} from "../../../scripts/eval/external/grep/sampling.js";
import { rowsToInstances } from "../../../scripts/eval/external/grep/swebench-multilingual.js";
import { toReportOutcome, type AdapterResult } from "../../../scripts/eval/external/grep/adapter.js";

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
}

const FIX_PATCH = `diff --git a/packages/core/src/focus.ts b/packages/core/src/focus.ts
index 1111111..2222222 100644
--- a/packages/core/src/focus.ts
+++ b/packages/core/src/focus.ts
@@ -10,5 +10,6 @@ export function focus() {
     const a = 1;
+    const b = 2;
     return a;
 }
diff --git a/packages/core/src/focus.test.ts b/packages/core/src/focus.test.ts
index 1111111..2222222 100644
--- a/packages/core/src/focus.test.ts
+++ b/packages/core/src/focus.test.ts
@@ -1,3 +1,4 @@ import { focus } from "./focus";
+import { blur } from "./blur";
 focus();
diff --git a/docs/guide.md b/docs/guide.md
index 1111111..2222222 100644
--- a/docs/guide.md
+++ b/docs/guide.md
@@ -1 +1 @@
-old
+new
diff --git a/packages/core/src/newfile.ts b/packages/core/src/newfile.ts
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/packages/core/src/newfile.ts
@@ -0,0 +1 @@
+export const x = 1;
`;

describe("parseUnifiedDiff", () => {
    it("extracts base-side ranges per file", () => {
        const files = parseUnifiedDiff(FIX_PATCH);
        expect(files.map((f) => f.file)).toEqual([
            "packages/core/src/focus.ts",
            "packages/core/src/focus.test.ts",
            "docs/guide.md",
            "packages/core/src/newfile.ts",
        ]);
        expect(files[0]?.baseRanges).toEqual([{ start: 10, end: 14 }]);
    });

    it("flags new files with no base side", () => {
        const files = parseUnifiedDiff(FIX_PATCH);
        expect(files[3]?.isNewFile).toBe(true);
        expect(files[0]?.isNewFile).toBe(false);
    });
});

describe("classifyPatchFile", () => {
    it.each([
        ["src/a.test.ts", "test"],
        ["src/__tests__/a.ts", "test"],
        ["test/e2e/a.ts", "test"],
        ["src/a.spec.ts", "test"],
        ["docs/guide.md", "doc"],
        ["README.md", "doc"],
        ["website/docs/x.mdx", "doc"],
        ["package-lock.json", "config"],
        ["babel.config.js", "config"],
        [".github/workflows/ci.yml", "config"],
        ["tsconfig.json", "config"],
    ])("excludes %s as %s", (file, reason) => {
        expect(classifyPatchFile(file)).toEqual({ file, excluded: true, reason });
    });

    it("keeps production sources", () => {
        expect(classifyPatchFile("packages/core/src/focus.ts")).toEqual({
            file: "packages/core/src/focus.ts",
            excluded: false,
        });
    });
});

describe("deriveGold", () => {
    it("keeps production files; records test/doc/new-file exclusions", () => {
        const gold = deriveGold(FIX_PATCH);
        expect(gold.goldFiles).toEqual(["packages/core/src/focus.ts"]);
        expect(gold.goldHunks).toEqual([
            { file: "packages/core/src/focus.ts", ranges: [{ start: 10, end: 14 }] },
        ]);
        expect(gold.excludedFiles).toEqual([
            { file: "packages/core/src/focus.test.ts", reason: "test" },
            { file: "docs/guide.md", reason: "doc" },
            { file: "packages/core/src/newfile.ts", reason: "new-file-no-base" },
        ]);
    });
});

describe("classifyLanguageByGoldFiles", () => {
    it.each([
        [["src/a.ts"], "ts"],
        [["src/a.tsx"], "ts"],
        [["src/a.mts"], "ts"],
        [["src/a.cts"], "ts"],
        [["src/a.d.ts"], "ts"],
        [["SRC/A.TS"], "ts"],
        [["lib/a.js"], "js"],
        [["lib/a.jsx"], "js"],
        [["lib/a.mjs"], "js"],
        [["lib/a.cjs"], "js"],
        [["src/a.ts", "lib/b.js"], "mixed"],
        [["src/a.js", "src/b.jsx"], "js"],
        [["src/a.ts", "src/b.tsx"], "ts"],
        [[], "js"],
    ])("classifies %j as %s", (goldFiles, expected) => {
        expect(classifyLanguageByGoldFiles(goldFiles as string[])).toBe(expected);
    });
});

describe("snapshotDir traversal guard", () => {
    it.each(["../evil", "..", ".", "a/b", "a\\b", "", "evil;id"])("rejects %j", (id) => {
        expect(() => snapshotDir(id)).toThrow(/unsafe instance_id/);
        expect(() => assertSafeInstanceId(id)).toThrow(/unsafe instance_id/);
    });

    it("accepts dataset-shaped ids", () => {
        expect(() => assertSafeInstanceId("django__django-12345")).not.toThrow();
        expect(snapshotDir("django__django-12345")).toContain("django__django-12345");
    });
});

describe("rowsToInstances", () => {
    const row = (over: Record<string, unknown> = {}): Parameters<typeof rowsToInstances>[0][number] => ({
        instance_id: "preactjs__preact-1",
        repo: "preactjs/preact",
        base_commit: "abc123",
        problem_statement: "Title here\n\nBody text here.",
        patch: FIX_PATCH,
        ...over,
    }) as Parameters<typeof rowsToInstances>[0][number];

    it("classifies .js gold as js (not ts)", () => {
        const { instances } = rowsToInstances([
            row({
                repo: "axios/axios",
                patch: "diff --git a/lib/adapters/http.js b/lib/adapters/http.js\n" +
                    "--- a/lib/adapters/http.js\n+++ b/lib/adapters/http.js\n" +
                    "@@ -1 +1 @@\n-old\n+new\n",
            }),
        ]);
        expect(instances[0]?.language).toBe("js");
    });

    it("classifies mixed js+ts gold as mixed", () => {
        const { instances } = rowsToInstances([
            row({
                repo: "vuejs/core",
                patch: "diff --git a/src/a.ts b/src/a.ts\n" +
                    "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" +
                    "diff --git a/lib/b.js b/lib/b.js\n" +
                    "--- a/lib/b.js\n+++ b/lib/b.js\n@@ -1 +1 @@\n-old\n+new\n",
            }),
        ]);
        expect(instances[0]?.language).toBe("mixed");
    });

    it("keeps JS/TS repos with production gold; title is the first line", () => {
        const { instances, skipped } = rowsToInstances([row()]);
        expect(skipped).toEqual([]);
        expect(instances).toHaveLength(1);
        expect(instances[0]?.title).toBe("Title here");
        expect(instances[0]?.body).toBe("Title here\n\nBody text here.");
        expect(instances[0]?.goldFiles).toEqual(["packages/core/src/focus.ts"]);
        expect(instances[0]?.language).toBe("ts");
        expect(instances[0]?.license).toBe("MIT");
    });

    it("drops non-JS/TS repos and gold-less patches", () => {
        const { instances, skipped } = rowsToInstances([
            row({ instance_id: "x__y-1", repo: "redis/redis" }),
            row({ instance_id: "preactjs__preact-2", repo: "preactjs/preact", patch: "diff --git a/x.md b/x.md\n" }),
        ]);
        expect(instances).toHaveLength(0);
        expect(skipped.map((s) => s.instanceId)).toEqual(["preactjs__preact-2"]);
    });

    it("formulationText returns title vs full body", () => {
        const { instances } = rowsToInstances([row()]);
        const inst = instances[0] as BenchmarkInstance;
        expect(formulationText(inst, "title")).toBe("Title here");
        expect(formulationText(inst, "body")).toContain("Body text here.");
    });
});

describe("multi-swe-bench gate", () => {
    it("refuses without --accept-license-review", () => {
        expect(() => assertMultiSweBenchLicense([])).toThrow(/Refusing Multi-SWE-bench/);
        expect(() => assertMultiSweBenchLicense(["--accept-license-review"])).not.toThrow();
    });
});

function makeInstance(over: Partial<BenchmarkInstance> = {}): BenchmarkInstance {
    return {
        instanceId: "test__repo-1",
        dataset: "swe-bench-multilingual",
        repo: "test/repo",
        baseCommit: "abc",
        title: "t",
        body: "b",
        goldFiles: ["src/a.ts"],
        goldHunks: [{ file: "src/a.ts", ranges: [{ start: 10, end: 14 }] }],
        excludedFiles: [],
        language: "ts",
        split: "dev",
        license: "MIT",
        ...over,
    };
}

describe("metrics", () => {
    it("dedupes ranked files by first appearance", () => {
        expect(
            dedupeFilesByFirstAppearance([
                { relFile: "b.ts" },
                { relFile: "a.ts" },
                { relFile: "b.ts" },
            ]),
        ).toEqual(["b.ts", "a.ts"]);
    });

    it("computes success/recall/MRR/hunk overlap", () => {
        const m = computeInstanceMetrics({
            instance: makeInstance(),
            formulation: "title",
            shown: [
                { relFile: "src/other.ts", line: 1, endLine: 3, name: "x" },
                { relFile: "src/a.ts", line: 11, endLine: 12, name: "y" },
            ],
            renderedText: "ok",
            elapsedMs: 5,
            status: "ok",
        });
        expect(m.successAt5).toBe(true);
        expect(m.recallAt5).toBe(1);
        expect(m.mrr).toBeCloseTo(0.5);
        expect(m.hunkOverlapAt5).toBe(1);
        expect(m.goldRanks).toEqual([{ file: "src/a.ts", rank: 2 }]);
    });

    it("counts hunk overlap from every top-5 file, not just the first five units", () => {
        // src/a.ts ranks in the top 5 (its file is 5th) but its only unit
        // sits past shown index 4 because src/b.ts contributes two units.
        const m = computeInstanceMetrics({
            instance: makeInstance(),
            formulation: "title",
            shown: [
                { relFile: "src/b.ts", line: 1, endLine: 1, name: "b1" },
                { relFile: "src/b.ts", line: 2, endLine: 2, name: "b2" },
                { relFile: "src/c.ts", line: 3, endLine: 3, name: "c" },
                { relFile: "src/d.ts", line: 4, endLine: 4, name: "d" },
                { relFile: "src/e.ts", line: 5, endLine: 5, name: "e" },
                { relFile: "src/a.ts", line: 11, endLine: 12, name: "a" },
            ],
            renderedText: "ok",
            elapsedMs: 5,
            status: "ok",
        });
        expect(m.successAt5).toBe(true);
        expect(m.hunkOverlapAt5).toBe(1);
    });

    it("marks over-token-cap runs as failures, not successes", () => {
        const m = computeInstanceMetrics({
            instance: makeInstance(),
            formulation: "body",
            shown: [{ relFile: "src/a.ts", line: 10, endLine: 14, name: "y" }],
            renderedText: `x`.padEnd(RENDERED_TOKEN_CAP * 4 + 4, "x"),
            elapsedMs: 5,
            status: "ok",
        });
        expect(m.overTokenCap).toBe(true);
        expect(m.status).toBe("over_token_cap");
        expect(m.successAt5).toBe(false);
    });

    it("errors count as failures with zero recall", () => {
        const m = computeInstanceMetrics({
            instance: makeInstance(),
            formulation: "title",
            shown: [{ relFile: "src/a.ts", line: 10, endLine: 14, name: "y" }],
            renderedText: "",
            elapsedMs: 5,
            status: "error:boom",
        });
        expect(m.successAt5).toBe(false);
        expect(m.recallAt5).toBe(0);
        expect(m.status).toBe("error:boom");
    });

    it("summarizes with errors in the denominator", () => {
        const ok = computeInstanceMetrics({
            instance: makeInstance(),
            formulation: "title",
            shown: [{ relFile: "src/a.ts", line: 10, endLine: 14, name: "y" }],
            renderedText: "ok",
            elapsedMs: 1,
            status: "ok",
        });
        const err = computeInstanceMetrics({
            instance: makeInstance(),
            formulation: "title",
            shown: [],
            renderedText: "",
            elapsedMs: 1,
            status: "error:x",
        });
        const s = summarizeMetrics([ok, err]);
        expect(s.successAt5).toBe("1/2");
        expect(s.errors).toBe(1);
    });
    it("records the top-1 engine from the first shown card", () => {
        const m = computeInstanceMetrics({
            instance: makeInstance(),
            formulation: "title",
            shown: [
                { relFile: "src/a.ts", line: 10, endLine: 14, name: "y", engines: ["symbol", "lexical"], score: 3.5, kind: "Function" },
            ],
            renderedText: "ok",
            elapsedMs: 5,
            status: "ok",
        });
        expect(m.topEngine).toBe("symbol");
    });

    it("top-1 engine is null when nothing is shown", () => {
        const m = computeInstanceMetrics({
            instance: makeInstance(),
            formulation: "title",
            shown: [],
            renderedText: "",
            elapsedMs: 1,
            status: "error:x",
        });
        expect(m.topEngine).toBeNull();
    });
});

describe("report outcome shaping", () => {
    it("retains shown cards and routing while dropping rendered text", () => {
        const full: AdapterResult = {
            instanceId: "test__repo-1",
            formulation: "title",
            rankedFiles: ["src/a.ts"],
            goldRanks: [{ file: "src/a.ts", rank: 1 }],
            successAt5: true,
            recallAt5: 1,
            mrr: 1,
            hunkOverlapAt5: 1,
            overTokenCap: false,
            renderedTokens: 3,
            elapsedMs: 5,
            status: "ok",
            topEngine: "symbol",
            renderedText: " ruch rendered text (tool output) ",
            shownCards: [
                { relFile: "src/a.ts", line: 10, endLine: 14, engines: ["symbol"], score: 3.5, name: "y", kind: "Function" },
            ],
            routing: { mode: "smart", reason: "auto_literal" },
        };
        const outcome = toReportOutcome(full);
        expect(outcome.shownCards).toHaveLength(1);
        expect(outcome.shownCards[0]).toMatchObject({
            relFile: "src/a.ts",
            line: 10,
            endLine: 14,
            engines: ["symbol"],
            score: 3.5,
            name: "y",
            kind: "Function",
        });
        expect(outcome.routing).toMatchObject({ mode: "smart", reason: "auto_literal" });
        expect(outcome.topEngine).toBe("symbol");
        expect("renderedText" in outcome).toBe(false);
    });
});

describe("sampling", () => {
    const instances: BenchmarkInstance[] = (() => {
        const repos = ["a/r1", "b/r2", "c/r3"];
        const out: BenchmarkInstance[] = [];
        let n = 0;
        for (const repo of repos) {
            for (let i = 0; i < 5; i++) {
                n++;
                out.push(
                    makeInstance({
                        instanceId: `id-${n}`,
                        repo,
                        language: i % 2 === 0 ? "ts" : "js",
                        goldFiles: [`src/f${n}.ts`],
                        goldHunks: [{ file: `src/f${n}.ts`, ranges: [{ start: 1, end: 2 }] }],
                    }),
                );
            }
        }
        return out;
    })();

    it("is deterministic for the same seed", () => {
        const a = selectPilot(instances, "seed-1").map((i) => i.instanceId);
        const b = selectPilot(instances, "seed-1").map((i) => i.instanceId);
        expect(a).toEqual(b);
        expect(a).toHaveLength(12);
    });

    it("spreads the pilot across repos", () => {
        const pilot = selectPilot(instances, "seed-1");
        expect(new Set(pilot.map((p) => p.repo)).size).toBe(3);
    });

    it("freezes a manifest with dev/holdout-empty and a sha256", () => {
        const pilot = selectPilot(instances, "seed-1");
        const m = freezeManifest(instances, pilot, "seed-1", "rev-abc");
        expect(m.pilot).toHaveLength(12);
        expect(m.dev).toHaveLength(3);
        expect(m.holdout).toEqual([]);
        expect(m.note).toMatch(/holdout empty/);
        expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
        // sha256 binds content: different seed changes ids and hash.
        const m2 = freezeManifest(instances, selectPilot(instances, "seed-2"), "seed-2", "rev-abc");
        expect(m2.sha256).not.toBe(m.sha256);
    });

    it("seededShuffle is deterministic", () => {
        expect(seededShuffle([1, 2, 3, 4, 5], "s")).toEqual(seededShuffle([1, 2, 3, 4, 5], "s"));
    });
});

describe("gold-at-base with a temp git fixture", () => {
    it("materializes from a local git dir and excludes missing gold", () => {
        const repo = tempDir("ext-grep-fixture-");
        execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
            cwd: repo,
            stdio: "ignore",
        });
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
        execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
        execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "add a"], {
            cwd: repo,
            stdio: "ignore",
        });
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

        const present = materializeInstance(
            makeInstance({ instanceId: `test-ext-grep-present-${process.pid}`, baseCommit: sha }),
            join(repo, ".git"),
        );
        expect("root" in present).toBe(true);

        const absent = materializeInstance(
            makeInstance({
                instanceId: `test-ext-grep-absent-${process.pid}`,
                baseCommit: sha,
                goldFiles: ["src/does-not-exist.ts"],
                goldHunks: [],
            }),
            join(repo, ".git"),
        );
        expect(absent).toEqual({ excluded: true, reason: "missing-at-base", missing: ["src/does-not-exist.ts"] });

        rmSync(snapshotDir(`test-ext-grep-present-${process.pid}`), { recursive: true, force: true });
        rmSync(snapshotDir(`test-ext-grep-absent-${process.pid}`), { recursive: true, force: true });
    });
});

describe("msbRowsToInstances", () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
        instance_id: "mui__material-ui-39962",
        org: "mui",
        repo: "material-ui",
        number: 39962,
        base: { sha: "553cf822f6500075d374f3e89ad04b8308cd9f47" },
        title: "PR title",
        body: "PR body",
        resolved_issues: [{ title: "Issue title", body: "Issue body text" }],
        fix_patch:
            "diff --git a/packages/a.ts b/packages/a.ts\n" +
            "--- a/packages/a.ts\n+++ b/packages/a.ts\n" +
            "@@ -1,2 +1,3 @@\n x\n+y\n z\n",
        ...overrides,
    });

    it("converts rows with the linked issue as query text", () => {
        const { instances, skipped } = msbRowsToInstances([row() as never]);
        expect(skipped).toEqual([]);
        expect(instances).toHaveLength(1);
        const inst = instances[0] as BenchmarkInstance;
        expect(inst.dataset).toBe("multi-swe-bench");
        expect(inst.repo).toBe("mui/material-ui");
        expect(inst.title).toBe("Issue title");
        expect(inst.body).toBe("Issue body text");
        expect(inst.goldFiles).toEqual(["packages/a.ts"]);
    });

    it("skips rows with no production gold or missing base", () => {
        const { instances, skipped } = msbRowsToInstances([
            row({ instance_id: "x-1", fix_patch: "" }) as never,
            row({ instance_id: "x-2", base: {} }) as never,
        ]);
        expect(instances).toEqual([]);
        expect(skipped.map((s) => s.reason)).toEqual(["missing-title-patch-or-base", "missing-title-patch-or-base"]);
    });
});

describe("dev/holdout freeze (D15)", () => {
    const synth = (id: string, repo: string, language: "ts" | "js" = "ts"): BenchmarkInstance => ({
        instanceId: id,
        dataset: "swe-bench-multilingual",
        repo,
        baseCommit: "0".repeat(40),
        title: `title ${id}`,
        body: `body ${id}`,
        goldFiles: [`src/${id}.ts`],
        goldHunks: [{ file: `src/${id}.ts`, ranges: [{ start: 1, end: 2 }] }],
        excludedFiles: [],
        language,
        split: "dev",
        license: "MIT",
    });

    const pool = [
        ...["a-1", "a-2", "a-3", "a-4"].map((id) => synth(id, "org/deep")),
        ...["b-1", "b-2", "b-3"].map((id) => synth(id, "org/mid")),
        synth("c-1", "org/pilot-repo"),
        synth("p-1", "org/pilot-repo"),
    ];
    const pilot = new Set(["p-1"]);

    it("picks non-pilot repos first and reports spillover", () => {
        const { repos, spillover } = pickHoldoutRepos(
            pool.filter((i) => !pilot.has(i.instanceId)),
            new Set(["org/pilot-repo"]),
            "seed",
            4,
            2,
        );
        expect(spillover).toEqual([]);
        expect(repos).not.toContain("org/pilot-repo");
        // Ascending by count: mid(3) before deep(4).
        expect(repos[0]).toBe("org/mid");
    });

    it("selects disjoint splits deterministically", () => {
        const opts = { devSize: 3, holdoutSize: 2, devCapPerRepo: 2, holdoutCapPerRepo: 2, minTsFraction: 0 };
        const first = selectDevHoldout(pool, pilot, "seed", opts);
        const second = selectDevHoldout(pool, [...pilot], "seed", opts);
        expect(first.dev.map((i) => i.instanceId)).toEqual(second.dev.map((i) => i.instanceId));
        expect(first.holdout.map((i) => i.instanceId)).toEqual(second.holdout.map((i) => i.instanceId));
        expect(first.dev).toHaveLength(3);
        expect(first.holdout).toHaveLength(2);
        const devRepos = new Set(first.dev.map((i) => i.repo));
        for (const h of first.holdout) expect(devRepos.has(h.repo)).toBe(false);
        for (const h of first.holdout) expect(h.repo).not.toBe("org/pilot-repo");
    });

    it("fails loudly on duplicate ids and shortfalls", () => {
        const opts = { devSize: 3, holdoutSize: 2, devCapPerRepo: 2, holdoutCapPerRepo: 2, minTsFraction: 0 };
        expect(() => selectDevHoldout([...pool, synth("a-1", "org/deep")], pilot, "seed", opts)).toThrow(
            /duplicate instance ids/,
        );
        expect(() => selectDevHoldout(pool, pilot, "seed", { ...opts, devSize: 99 })).toThrow(/shortfall/);
    });

    it("manifest integrity detects any modification", () => {
        const manifest = buildDevHoldoutManifest({
            seed: "seed",
            datasets: [{ name: "d", revision: "r", license: "l" }],
            pilot: [synth("p-1", "org/pilot-repo")],
            dev: [synth("a-1", "org/deep")],
            holdout: [synth("b-1", "org/mid")],
            exclusions: [],
            holdoutRepoNote: "note",
        });
        expect(verifyDevHoldoutManifest(manifest)).toBe(true);
        expect(computeDevHoldoutSha(manifest)).toBe(manifest.sha256);
        const noted = buildDevHoldoutManifest({
            seed: "s",
            datasets: [],
            pilot: [],
            dev: Array.from({ length: 4 }, (_, i) => synth(`d${i}`, "r/a", "ts")),
            holdout: Array.from({ length: 4 }, (_, i) => synth(`h${i}`, "r/b", "js")),
            exclusions: [],
            holdoutRepoNote: "note",
            tsShareNote: "floor relaxed: reason",
        });
        expect(noted.tsShareNote).toBe("floor relaxed: reason");
        expect(verifyDevHoldoutManifest(noted)).toBe(true);
        const tampered = { ...manifest, dev: [synth("a-2", "org/deep")] };
        expect(verifyDevHoldoutManifest(tampered as unknown as typeof manifest)).toBe(false);
        const retitled = JSON.parse(JSON.stringify(manifest)) as typeof manifest;
        retitled.dev[0]!.baseCommit = "1".repeat(40);
        expect(verifyDevHoldoutManifest(retitled)).toBe(false);
    });
});
