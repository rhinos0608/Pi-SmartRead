/**
 * D46 runner refusal-path tests (no engine IO, no network).
 * Every integrity/holdout refusal in scripts/eval/d46/run.ts is exercised:
 * sealed-manifest mismatch, dirty/pinned checkout drift, holdout opened
 * without --open-holdout/--freeze, freeze arm mismatch, freeze
 * engine-hash mismatch, and holdout redaction (no query text or gold).
 */
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync, realpathSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { JudgeNoulInput, JudgeUsage } from "../../../src/judge/types.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { D46Query } from "../../../scripts/eval/d46/schema.js";
import {
    checkHoldoutGuard,
    coldStartRuntimeCaches,
    D46_REPORTS_DIR,
    d46ReportFileHit,
    isCleanPorcelain,
    parseD46RunArgs,
    redactForHoldout,
    resolveD46ReportsDir,
    resolveD46ScoringTotalHits,
    runD46Cli,
    SMARTREAD_RUNTIME_CACHE_DIRS,
    verifyCheckoutPins,
    verifySplitManifest,
    wrapJudge,
} from "../../../scripts/eval/d46/run.js";
import { scoreD46Query } from "../../../scripts/eval/d46/score.js";
import { loadSplitQueries, writeSplitManifest } from "../../../scripts/eval/d46/validate.js";
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

// Guard: no test in this file may write a report into the real home
// reports dir. Every runD46Cli call below injects a temp reports dir;
// this snapshots the real dir and fails if any newcomer appears.
let realReportsBefore = new Set<string>();
beforeAll(() => {
    try {
        realReportsBefore = new Set(readdirSync(D46_REPORTS_DIR));
    } catch {
        realReportsBefore = new Set();
    }
});
afterAll(() => {
    let after: string[];
    try {
        after = readdirSync(D46_REPORTS_DIR);
    } catch {
        return;
    }
    const newcomers = after.filter((f) => !realReportsBefore.has(f) && !f.startsWith("quarantine"));
    expect(newcomers).toEqual([]);
});

describe("resolveD46ReportsDir", () => {
    it("prefers --reports-dir, then env, then the real default", () => {
        const dir = mkdtempSync(join(tmpdir(), "d46-reports-resolve-"));
        expect(resolveD46ReportsDir(null)).toBe(D46_REPORTS_DIR);
        expect(resolveD46ReportsDir(dir)).toBe(dir);
        const prev = process.env.PI_SMARTREAD_D46_REPORTS_DIR;
        process.env.PI_SMARTREAD_D46_REPORTS_DIR = dir;
        try {
            expect(resolveD46ReportsDir(null)).toBe(dir);
            expect(resolveD46ReportsDir(`${dir}-cli`)).toBe(`${dir}-cli`);
        } finally {
            if (prev === undefined) delete process.env.PI_SMARTREAD_D46_REPORTS_DIR;
            else process.env.PI_SMARTREAD_D46_REPORTS_DIR = prev;
        }
    });
});

describe("parseD46RunArgs", () => {
    it("parses --reports-dir", () => {
        expect(parseD46RunArgs(["--split", "dev", "--reports-dir", "/tmp/r"]).reportsDir).toBe("/tmp/r");
    });
    it("parses the documented CLI surface", () => {
        expect(
            parseD46RunArgs(["--split", "dev", "--config", "off", "--replicate", "2"]),
        ).toEqual({ split: "dev", repo: null, config: "off", replicate: 2, freeze: null, openHoldout: false, reportsDir: null, existsEvidence: null });
        expect(
            parseD46RunArgs(["--split", "holdout", "--repo", "a__b", "--freeze", "f", "--open-holdout"]),
        ).toEqual({ split: "holdout", repo: "a__b", config: "off", replicate: 1, freeze: "f", openHoldout: true, reportsDir: null, existsEvidence: null });
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

    it("refuses when git HEAD or status reads fail (fail-closed, never 'clean' on error)", () => {
        const headFails = verifyCheckoutPins(q("honojs/hono"), pins, "/tmp", {
            head: () => {
                throw new Error("fatal: index file corrupt");
            },
            clean: () => true,
        });
        expect(headFails.some((e) => e.includes("cannot read HEAD"))).toBe(true);
        const statusFails = verifyCheckoutPins(q("honojs/hono"), pins, "/tmp", {
            head: () => "abc",
            status: () => {
                throw new Error("spawn git ENOENT");
            },
        });
        expect(statusFails.some((e) => e.includes("cannot check tree cleanliness"))).toBe(true);
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

describe("runD46Cli cold-start preflight ordering", () => {
    function makeBench(split: "dev" | "holdout") {
        const bench = mkdtempSync(join(tmpdir(), "d46-order-"));
        const checkout = join(bench, "repos", "o__r");
        mkdirSync(checkout, { recursive: true });
        execFileSync("git", ["init", "-q"], { cwd: checkout });
        execFileSync("git", ["config", "user.email", "t@t"], { cwd: checkout });
        execFileSync("git", ["config", "user.name", "t"], { cwd: checkout });
        writeFileSync(join(checkout, "a.txt"), "hello world\n");
        execFileSync("git", ["add", "."], { cwd: checkout });
        execFileSync("git", ["commit", "-qm", "init"], { cwd: checkout });
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
        const repos = [{
            owner: "o", name: "r", url: "https://example.com/o/r.git", sha, branch: "main",
            corpusRoot: ".", split, addedAt: "2026-01-01T00:00:00.000Z", license: "mit", source: "test",
        }];
        writeFileSync(join(bench, "repos.json"), JSON.stringify({ version: 1, reposDir: join(bench, "repos"), repos }));
        const splitDir = join(bench, split);
        mkdirSync(splitDir, { recursive: true });
        const q = {
            id: "q1", repo: "o/r", split, class: "exact_ish", exactForm: "literal",
            query: "hello", rationale: "r", author: "t", authoredAt: "2026-01-01T00:00:00.000Z",
            gold: [{ path: "a.txt", startLine: 1, endLine: 1, grade: 1 }],
        };
        writeFileSync(join(splitDir, "o__r.jsonl"), `${JSON.stringify(q)}\n`);
        const loaded = loadSplitQueries(splitDir, new Set(["o__r.jsonl"]));
        expect(loaded.errors).toEqual([]);
        writeSplitManifest(splitDir, split, loaded, repos as never);
        // Plant an untracked runtime cache that cold start would delete.
        mkdirSync(join(checkout, ".pi-smartread", "cache"), { recursive: true });
        writeFileSync(join(checkout, ".pi-smartread", "cache", "x.bin"), "x");
        return { bench, cacheFile: join(checkout, ".pi-smartread", "cache", "x.bin") };
    }

    function runIsolated(argv: string[], bench: string): Promise<number> {
        const reportsDir = mkdtempSync(join(tmpdir(), "d46-reports-"));
        return runD46Cli(argv, bench, { engineSourceHash: "sha256:abc:1-files", reportsDir });
    }

    it("unknown engine hash refuses WITHOUT deleting the planted cache", async () => {
        const { bench, cacheFile } = makeBench("dev");
        const reportsDir = mkdtempSync(join(tmpdir(), "d46-reports-"));
        const code = await runD46Cli(["--split", "dev", "--config", "off"], bench, { engineSourceHash: "unknown:test", reportsDir });
        expect(code).toBe(2);
        expect(existsSync(cacheFile)).toBe(true);
    });

    it("holdout guard refusal leaves the planted cache present", async () => {
        const { bench, cacheFile } = makeBench("holdout");
        const code = await runIsolated(["--split", "holdout", "--config", "off"], bench);
        expect(code).toBe(2);
        expect(existsSync(cacheFile)).toBe(true);
    });

    it("t040 without a judge API key refuses WITHOUT deleting the planted cache", async () => {
        const { bench, cacheFile } = makeBench("dev");
        const prev = process.env.PI_SMARTREAD_JUDGE_API_KEY;
        delete process.env.PI_SMARTREAD_JUDGE_API_KEY;
        try {
            const code = await runIsolated(["--split", "dev", "--config", "t040"], bench);
            expect(code).toBe(2);
            expect(existsSync(cacheFile)).toBe(true);
        } finally {
            if (prev !== undefined) process.env.PI_SMARTREAD_JUDGE_API_KEY = prev;
        }
    });

    it("happy path deletes the planted cache and writes the report into the injected dir", async () => {
        const { bench, cacheFile } = makeBench("dev");
        const reportsDir = mkdtempSync(join(tmpdir(), "d46-reports-"));
        const code = await runD46Cli(["--split", "dev", "--config", "off"], bench, { engineSourceHash: "sha256:abc:1-files", reportsDir });
        expect(code).toBe(0);
        expect(existsSync(cacheFile)).toBe(false);
        expect(readdirSync(reportsDir).filter((f) => f.startsWith("d46-dev-off-"))).toHaveLength(1);
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

describe("d46ReportFileHit", () => {
    it("agrees with covered when five repeated non-gold units precede the gold file", () => {
        const gold = [{ path: "src/app.ts", startLine: 10, endLine: 20, grade: 1 as const }];
        const units = [
            ...[10, 11, 12, 13, 14].map((line) => ({
                file: "src/noise.ts",
                line,
                endLine: line,
                snippet: `  ${line} | noise`,
            })),
            { file: "src/app.ts", line: 10, endLine: 10, snippet: "  10 | app" },
        ];
        const scored = scoreD46Query({
            query: {
                id: "hono-001",
                repo: "honojs/hono",
                split: "dev",
                class: "behaviour",
                query: "synthetic",
                gold,
                rationale: "synthetic",
                author: "test",
                authoredAt: "2026-10-07T00:00:00Z",
            },
            units,
            totalHits: units.length,
            renderedChars: 0,
            routingMode: "smart",
            judgeInvoked: false,
            status: "ok",
            elapsedMs: 1,
        });
        expect(scored.successAt5).toBe(true);
        // The old first-five-units expression is false here (all noise);
        // the report row must use the distinct-file source instead.
        expect(units.slice(0, 5).some((u) => gold.some((g) => g.path === u.file))).toBe(false);
        expect(d46ReportFileHit(scored.top5Files, gold)).toBe(scored.successAt5);
    });
});

describe("D62 SmartRead runtime caches", () => {
    it("defines the AGENTS.md generated/runtime-state dir names once", () => {
        expect([...SMARTREAD_RUNTIME_CACHE_DIRS].sort()).toEqual(
            [
                ".pi",
                ".pi-smartread",
                ".pi-smartread.tags.cache",
                ".pi-smartread.embeddings.cache",
                ".pi-subagents",
                "graphify-out",
                ".smart-edit-undo",
                ".subagent-work",
            ].sort(),
        );
    });

    it("treats only full-segment cache paths as clean", () => {
        expect(isCleanPorcelain("")).toBe(true);
        expect(isCleanPorcelain("?? .pi-smartread.tags.cache/\n?? src/.pi/x\n")).toBe(true);
        expect(isCleanPorcelain("?? notes.txt\n")).toBe(false);
        expect(isCleanPorcelain(" M src/a.ts\n")).toBe(false);
        expect(isCleanPorcelain("?? notes.txt\n?? .pi/\n")).toBe(false);
        expect(isCleanPorcelain("?? .pi-smartread.tags.cache.bak/x\n")).toBe(false);
    });

    function initRepo(): string {
        const dir = realpathSync(mkdtempSync(join(tmpdir(), "d46-d62-")));
        execFileSync("git", ["init", "-q", dir]);
        execFileSync("git", ["-C", dir, "config", "user.email", "d62@test.invalid"]);
        execFileSync("git", ["-C", dir, "config", "user.name", "d62"]);
        writeFileSync(join(dir, "a.txt"), "a\n");
        execFileSync("git", ["-C", dir, "add", "."]);
        execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
        return dir;
    }

    function headOf(dir: string): string {
        return (execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }) as string).trim();
    }

    function gitStatus(dir: string): string {
        return execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], {
            encoding: "utf8",
        }) as string;
    }

    it("ignores root+nested cache dirs, cold-starts them, still refuses notes.txt/tracked drift", () => {
        const reposRoot = realpathSync(mkdtempSync(join(tmpdir(), "d46-d62-roots-")));
        const dir = join(reposRoot, "o__r");
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init", "-q", dir]);
        execFileSync("git", ["-C", dir, "config", "user.email", "d62@test.invalid"]);
        execFileSync("git", ["-C", dir, "config", "user.name", "d62"]);
        writeFileSync(join(dir, "a.txt"), "a\n");
        execFileSync("git", ["-C", dir, "add", "."]);
        execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
        mkdirSync(join(dir, ".pi-smartread.tags.cache"), { recursive: true });
        writeFileSync(join(dir, ".pi-smartread.tags.cache", "t.json"), "{}\n");
        mkdirSync(join(dir, "sub", ".pi"), { recursive: true });
        writeFileSync(join(dir, "sub", ".pi", "x.json"), "{}\n");
        expect(isCleanPorcelain(gitStatus(dir))).toBe(true);
        const queries = [
            { id: "q1", repo: "o/r", answerable: true, gold: [] },
        ] as unknown as Parameters<typeof verifyCheckoutPins>[0];
        const pins = [{ owner: "o", name: "r", sha: headOf(dir) }] as unknown as Parameters<
            typeof verifyCheckoutPins
        >[1];
        expect(verifyCheckoutPins(queries, pins, reposRoot)).toEqual([]);
        const cold = coldStartRuntimeCaches(dir);
        expect(cold.error).toBeNull();
        expect(cold.deleted).toEqual([".pi-smartread.tags.cache", "sub/.pi"]);
        expect(existsSync(join(dir, ".pi-smartread.tags.cache"))).toBe(false);
        expect(existsSync(join(dir, "sub", ".pi"))).toBe(false);
        writeFileSync(join(dir, "notes.txt"), "n\n");
        expect(isCleanPorcelain(gitStatus(dir))).toBe(false);
        const errors = verifyCheckoutPins(queries, pins, reposRoot);
        expect(errors.some((e) => e.includes("not clean"))).toBe(true);
    });

    it("refuses tracked modifications even with caches present", () => {
        const dir = initRepo();
        mkdirSync(join(dir, ".pi"), { recursive: true });
        writeFileSync(join(dir, "a.txt"), "changed\n");
        expect(isCleanPorcelain(gitStatus(dir))).toBe(false);
    });

    it("refuses a modified tracked file inside a cache-named dir", () => {
        const dir = initRepo();
        mkdirSync(join(dir, ".pi"), { recursive: true });
        writeFileSync(join(dir, ".pi", "config.json"), "{}\n");
        execFileSync("git", ["-C", dir, "add", "."]);
        execFileSync("git", ["-C", dir, "commit", "-qm", "track pi"]);
        writeFileSync(join(dir, ".pi", "config.json"), "{\"x\":1}\n");
        expect(isCleanPorcelain(gitStatus(dir))).toBe(false);
    });

    it("skips a cache-named dir containing tracked files, deletes untracked caches", () => {
        const dir = initRepo();
        mkdirSync(join(dir, ".pi"), { recursive: true });
        writeFileSync(join(dir, ".pi", "config.json"), "{}\n");
        execFileSync("git", ["-C", dir, "add", "."]);
        execFileSync("git", ["-C", dir, "commit", "-qm", "track pi"]);
        mkdirSync(join(dir, ".pi-smartread.tags.cache"), { recursive: true });
        writeFileSync(join(dir, ".pi-smartread.tags.cache", "t.json"), "{}\n");
        const cold = coldStartRuntimeCaches(dir);
        expect(cold.error).toBeNull();
        expect(cold.deleted).toEqual([".pi-smartread.tags.cache"]);
        expect(cold.skippedTracked).toEqual([".pi"]);
        expect(existsSync(join(dir, ".pi", "config.json"))).toBe(true);
        expect(existsSync(join(dir, ".pi-smartread.tags.cache"))).toBe(false);
    });

    it("does not follow a symlinked cache dir pointing outside the checkout", () => {
        const dir = initRepo();
        const outside = realpathSync(mkdtempSync(join(tmpdir(), "d46-d62-out-")));
        writeFileSync(join(outside, "secret.txt"), "s\n");
        symlinkSync(outside, join(dir, ".pi"));
        const cold = coldStartRuntimeCaches(dir);
        expect(cold.error).toMatch(/refuse/);
        expect(cold.deleted).toEqual([]);
        expect(existsSync(join(outside, "secret.txt"))).toBe(true);
    });

    it("refuses (no deletion) when git ls-files fails: corrupt-index repro", () => {
        const dir = initRepo();
        mkdirSync(join(dir, ".pi"), { recursive: true });
        writeFileSync(join(dir, ".pi", "config.json"), "{}\n");
        execFileSync("git", ["-C", dir, "add", "."]);
        execFileSync("git", ["-C", dir, "commit", "-qm", "track pi"]);
        // Corrupt the index so `git ls-files` exits non-zero; the tracked
        // check must fail closed instead of treating the dir as untracked.
        writeFileSync(join(dir, ".git", "index"), "CORRUPT!");
        const cold = coldStartRuntimeCaches(dir);
        expect(cold.error).toMatch(/cannot list tracked files/);
        expect(cold.deleted).toEqual([]);
        expect(existsSync(join(dir, ".pi", "config.json"))).toBe(true);
    });

    it("refuses (no deletion) when git is unavailable", () => {
        const dir = initRepo();
        mkdirSync(join(dir, ".pi-smartread.tags.cache"), { recursive: true });
        writeFileSync(join(dir, ".pi-smartread.tags.cache", "t.json"), "{}\n");
        const noGit = {
            lsFiles: () => {
                throw new Error("spawn git ENOENT");
            },
        };
        const cold = coldStartRuntimeCaches(dir, noGit);
        expect(cold.error).toMatch(/cannot list tracked files/);
        expect(cold.deleted).toEqual([]);
        expect(existsSync(join(dir, ".pi-smartread.tags.cache", "t.json"))).toBe(true);
    });

    it("checks every cache dir before deleting any (no interleaved check/delete)", () => {
        const dir = initRepo();
        mkdirSync(join(dir, ".pi"), { recursive: true });
        writeFileSync(join(dir, ".pi", "a.json"), "{}\n");
        mkdirSync(join(dir, ".pi-smartread"), { recursive: true });
        writeFileSync(join(dir, ".pi-smartread", "b.json"), "{}\n");
        let calls = 0;
        const flakyGit = {
            lsFiles: () => {
                calls += 1;
                if (calls === 1) return "";
                throw new Error("fatal: index file corrupt");
            },
        };
        const cold = coldStartRuntimeCaches(dir, flakyGit);
        expect(cold.error).toMatch(/cannot list tracked files/);
        expect(cold.deleted).toEqual([]);
        expect(existsSync(join(dir, ".pi", "a.json"))).toBe(true);
        expect(existsSync(join(dir, ".pi-smartread", "b.json"))).toBe(true);
    });
});

describe("resolveD46ScoringTotalHits (D67: score absence over rendered locations)", () => {
    const absenceQuery: D46Query = {
        id: "tj-commander-dev-absence-01",
        repo: "tj/commander.js",
        split: "dev",
        class: "absence",
        query: "synthetic absence query",
        gold: [],
        rationale: "synthetic",
        author: "test",
        authoredAt: "2026-10-07T00:00:00Z",
    };

    it("passes through the trace count for non-abstained rows", () => {
        expect(resolveD46ScoringTotalHits(false, 7, 5)).toBe(7);
        expect(resolveD46ScoringTotalHits(false, 0, 0)).toBe(0);
    });

    it("scores an abstained row over rendered units: empty top5Files and no false content", async () => {
        const { scoreD46Query } = await import("../../../scripts/eval/d46/score.js");
        const scored = scoreD46Query({
            // Abstained traces render zero locations: units [] and the
            // rendered-unit count (0), not the internal unjudged count (7).
            query: { ...absenceQuery },
            units: [],
            totalHits: resolveD46ScoringTotalHits(true, 7, 0),
            renderedChars: 160,
            routingMode: "smart",
            judgeInvoked: true,
            status: "ok",
            elapsedMs: 1,
        });
        expect(scored.top5Files).toEqual([]);
        expect(scored.falseContent).toBe(false);
        expect(scored.correctAbstention).toBe(true);
    });

    it("documents the bug when the raw internal count is scored instead", async () => {
        const { scoreD46Query } = await import("../../../scripts/eval/d46/score.js");
        const scored = scoreD46Query({
            query: { ...absenceQuery },
            units: [],
            totalHits: 7,
            renderedChars: 160,
            routingMode: "smart",
            judgeInvoked: true,
            status: "ok",
            elapsedMs: 1,
        });
        expect(scored.falseContent).toBe(true);
    });
});

describe("wrapJudge", () => {
    const info = { backend: "local" as const, model: "test-model", baseUrl: "http://127.0.0.1/" };
    const input: JudgeNoulInput = { shared: {}, items: [] };
    const usage: JudgeUsage = { inputTokens: 10, requests: 1 };

    it("marks invocation and records usage on success", async () => {
        let invoked = 0;
        const calls: Array<typeof usage> = [];
        const inner = {
            info,
            judgeNouls: async () => ({ p: new Map(), unjudged: [], usage, cacheHits: 0 }),
        };
        const wrapped = wrapJudge(inner, () => {
            invoked += 1;
        }, calls);
        const result = await wrapped.judgeNouls(input);
        expect(result.usage).toBe(usage);
        expect(invoked).toBe(1);
        expect(calls).toEqual([usage]);
    });

    it("marks invocation even when the judge call throws", async () => {
        let invoked = 0;
        const calls: Array<typeof usage> = [];
        const inner = {
            info,
            judgeNouls: async (): Promise<never> => {
                throw new Error("judge boom");
            },
        };
        const wrapped = wrapJudge(inner, () => {
            invoked += 1;
        }, calls);
        await expect(wrapped.judgeNouls(input)).rejects.toThrow("judge boom");
        expect(invoked).toBe(1);
        expect(calls).toEqual([]);
    });
});
