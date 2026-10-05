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
import { formulationText, type BenchmarkInstance } from "../../../scripts/eval/external/grep/instance.js";
import {
    computeInstanceMetrics,
    dedupeFilesByFirstAppearance,
    RENDERED_TOKEN_CAP,
    summarizeMetrics,
} from "../../../scripts/eval/external/grep/metrics.js";
import { assertMultiSweBenchLicense } from "../../../scripts/eval/external/grep/multi-swe-bench.js";
import { classifyPatchFile, deriveGold, parseUnifiedDiff } from "../../../scripts/eval/external/grep/patch.js";
import { materializeInstance, snapshotDir } from "../../../scripts/eval/external/grep/repos.js";
import { freezeManifest, seededShuffle, selectPilot } from "../../../scripts/eval/external/grep/sampling.js";
import { rowsToInstances } from "../../../scripts/eval/external/grep/swebench-multilingual.js";

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

describe("rowsToInstances", () => {
    const row = (over: Record<string, unknown> = {}): Parameters<typeof rowsToInstances>[0][number] => ({
        instance_id: "preactjs__preact-1",
        repo: "preactjs/preact",
        base_commit: "abc123",
        problem_statement: "Title here\n\nBody text here.",
        patch: FIX_PATCH,
        ...over,
    }) as Parameters<typeof rowsToInstances>[0][number];

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
