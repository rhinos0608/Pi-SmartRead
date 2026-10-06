/**
 * D46 validator path-containment and second-label sampler tests.
 * No network: path checks run against temp fixture dirs with a local git repo.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { D46Query, D46RepoManifest } from "../../../scripts/eval/d46/schema.js";
import {
    checkPathsAtCommit,
    classifyArtifact,
    listSealedArtifacts,
    loadSplitQueries,
    validateQueryDoc,
} from "../../../scripts/eval/d46/validate.js";
import { runSampleCli, selectSecondLabelIds } from "../../../scripts/eval/d46/sample-second-label.js";

function behaviourQuery(overrides: Partial<D46Query> = {}): D46Query {
    return {
        id: "zod-001",
        repo: "colinhacks/zod",
        split: "holdout",
        class: "behaviour",
        query: "Where is the email string validator implemented?",
        gold: [{ path: "src/types.ts", startLine: 1, endLine: 2, grade: 1 }],
        rationale: "The email check lives in the string type implementation.",
        author: "alice",
        authoredAt: "2026-10-07T00:00:00Z",
        ...overrides,
    };
}

describe("gold path containment (pure)", () => {
    it("rejects a parent-traversal gold path", () => {
        const result = validateQueryDoc([
            behaviourQuery({
                gold: [{ path: "../outside.ts", startLine: 1, endLine: 2, grade: 1 }],
            }),
        ]);
        expect(result.errors.some((e) => e.includes("../outside.ts"))).toBe(true);
    });

    it("rejects a nested parent-traversal gold path", () => {
        const result = validateQueryDoc([
            behaviourQuery({
                gold: [{ path: "src/../../outside.ts", startLine: 1, endLine: 2, grade: 1 }],
            }),
        ]);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects an absolute gold path", () => {
        const result = validateQueryDoc([
            behaviourQuery({
                gold: [{ path: "/etc/passwd", startLine: 1, endLine: 2, grade: 1 }],
            }),
        ]);
        expect(result.errors.some((e) => e.includes("/etc/passwd"))).toBe(true);
    });
});

describe("checkPathsAtCommit containment (IO)", () => {
    let dir = "";
    afterEach(() => {
        if (dir) {
            chmodSync(dir, 0o700);
            rmSync(dir, { recursive: true, force: true });
            dir = "";
        }
    });

    function initRepo(corpusRoot: string): { reposRoot: string; manifest: D46RepoManifest } {
        dir = mkdtempSync(join(tmpdir(), "d46-paths-"));
        const reposRoot = join(dir, "repos");
        const repoDir = join(reposRoot, "colinhacks__zod");
        mkdirSync(join(repoDir, corpusRoot), { recursive: true });
        writeFileSync(join(repoDir, corpusRoot, "types.ts"), "line1\nline2\n");
        const env = {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
        };
        execFileSync("git", ["init"], { cwd: repoDir });
        execFileSync("git", ["add", "."], { cwd: repoDir });
        execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, env });
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim() as string;
        const manifest: D46RepoManifest = {
            version: 1,
            createdAt: "2026-10-07T00:00:00Z",
            reposDir: "~/.cache/pi-smartread-bench/d46/repos",
            repos: [
                {
                    owner: "colinhacks",
                    name: "zod",
                    split: "holdout",
                    sha,
                    branch: "main",
                    license: { spdx: "MIT", file: "LICENSE", sha256: "x" },
                    corpusRoot,
                    fileCount: 1,
                    workingTree: "1K",
                },
            ],
        };
        return { reposRoot, manifest };
    }

    it("accepts a contained path and rejects a symlink escape", () => {
        const { reposRoot, manifest } = initRepo(".");
        const ok = checkPathsAtCommit(
            [behaviourQuery({ gold: [{ path: "types.ts", startLine: 1, endLine: 2, grade: 1 }] })],
            manifest,
            reposRoot,
        );
        expect(ok).toEqual([]);
        // Symlink inside the repo pointing outside the checkout.
        const outside = join(dir, "outside.ts");
        writeFileSync(outside, "secret\n");
        symlinkSync(outside, join(reposRoot, "colinhacks__zod", "linked.ts"));
        const escaped = checkPathsAtCommit(
            [behaviourQuery({ gold: [{ path: "linked.ts", startLine: 1, endLine: 1, grade: 1 }] })],
            manifest,
            reposRoot,
        );
        expect(escaped.some((e) => e.includes("linked.ts"))).toBe(true);
    });
});

describe("selectSecondLabelIds", () => {
    function answerable(id: string, repo: string): D46Query {
        return behaviourQuery({ id, repo, split: "dev", class: "behaviour" });
    }
    function absence(id: string, repo: string): D46Query {
        return behaviourQuery({
            id,
            repo,
            split: "dev",
            class: "absence",
            gold: [],
            absenceEvidence: { searchesRun: ["rg x"], synonymsChecked: ["y"] },
        });
    }

    it("selects ceil(25%) of answerables per repo plus all absence queries", () => {
        const queries = [
            ...Array.from({ length: 5 }, (_, i) => answerable(`hono-a${i}`, "honojs/hono")),
            absence("hono-x0", "honojs/hono"),
            ...Array.from({ length: 3 }, (_, i) => answerable(`cmd-a${i}`, "tj/commander.js")),
        ];
        // 5 answerable -> ceil(1.25) = 2, plus 1 absence = 3 for hono;
        // 3 answerable -> ceil(0.75) = 1 for commander.
        const hono = selectSecondLabelIds(
            queries.filter((q) => q.repo === "honojs/hono"),
            42,
        );
        expect(hono).toHaveLength(3);
        expect(hono).toContain("hono-x0");
        const cmd = selectSecondLabelIds(
            queries.filter((q) => q.repo === "tj/commander.js"),
            42,
        );
        expect(cmd).toHaveLength(1);
    });

    it("is deterministic for the same seed", () => {
        const queries = Array.from({ length: 8 }, (_, i) => answerable(`hono-a${i}`, "honojs/hono"));
        expect(selectSecondLabelIds(queries, 7)).toEqual(selectSecondLabelIds(queries, 7));
    });

    it("returns ids only, without gold content", () => {
        const queries = [answerable("hono-a0", "honojs/hono")];
        const ids = selectSecondLabelIds(queries, 1);
        expect(ids.every((id) => typeof id === "string")).toBe(true);
        expect(JSON.stringify(ids)).not.toContain("startLine");
    });
});

describe("loadSplitQueries ignores non-query artifacts", () => {
    let bench = "";
    afterEach(() => {
        if (bench !== "") rmSync(bench, { recursive: true, force: true });
        bench = "";
    });

    it("does not parse second-labels/adjudication/pre-adjudication files as queries", () => {
        bench = mkdtempSync(join(tmpdir(), "d46-nonquery-"));
        const q = behaviourQuery({ id: "h0", repo: "honojs/hono", split: "dev" });
        writeFileSync(join(bench, "hono.jsonl"), `${JSON.stringify(q)}\n`);
        writeFileSync(join(bench, "second-labels-honojs__hono.jsonl"), "not a query\n");
        writeFileSync(join(bench, "adjudication.jsonl"), "not a query\n");
        writeFileSync(join(bench, "hono.jsonl.pre-adjudication.bak"), "not a query\n");
        const loaded = loadSplitQueries(bench);
        expect(loaded.errors).toEqual([]);
        expect(loaded.queries.map((x) => x.id)).toEqual(["h0"]);
        expect(loaded.files.map((f) => f.file)).toEqual(["hono.jsonl"]);
    });
});

describe("listSealedArtifacts", () => {
    let bench = "";
    afterEach(() => {
        if (bench !== "") rmSync(bench, { recursive: true, force: true });
        bench = "";
    });

    it("seals every artifact with role labels and excludes the manifest", () => {
        bench = mkdtempSync(join(tmpdir(), "d46-seal-"));
        const names = [
            "hono.jsonl",
            "second-label-honojs__hono.json",
            "second-labels-honojs__hono.jsonl",
            "adjudication.jsonl",
            "hono.jsonl.pre-adjudication.2026-10-06.bak",
        ];
        for (const n of names) writeFileSync(join(bench, n), `${n}\n`);
        writeFileSync(join(bench, "MANIFEST.sha256.json"), "{}\n");
        const sealed = listSealedArtifacts(bench);
        expect(sealed.map((a) => a.file).sort()).toEqual([...names].sort());
        expect(Object.fromEntries(sealed.map((a) => [a.file, a.role]))).toEqual({
            "hono.jsonl": "queries",
            "second-label-honojs__hono.json": "second-label-sample",
            "second-labels-honojs__hono.jsonl": "second-labels",
            "adjudication.jsonl": "adjudication",
            "hono.jsonl.pre-adjudication.2026-10-06.bak": "pre-adjudication",
        });
        for (const a of sealed) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("runSampleCli --repo and idempotency", () => {
    let bench = "";
    afterEach(() => {
        if (bench !== "") rmSync(bench, { recursive: true, force: true });
        bench = "";
    });

    function seedBench(): string {
        bench = mkdtempSync(join(tmpdir(), "d46-sample-"));
        const splitDir = join(bench, "dev");
        mkdirSync(splitDir, { recursive: true });
        const line = (q: D46Query): string => JSON.stringify(q);
        const hono = [
            behaviourQuery({ id: "h0", repo: "honojs/hono", split: "dev" }),
            behaviourQuery({ id: "h1", repo: "honojs/hono", split: "dev" }),
            behaviourQuery({ id: "h2", repo: "honojs/hono", split: "dev" }),
            behaviourQuery({ id: "h3", repo: "honojs/hono", split: "dev" }),
        ];
        const cmd = [
            behaviourQuery({ id: "c0", repo: "tj/commander.js", split: "dev" }),
            behaviourQuery({ id: "c1", repo: "tj/commander.js", split: "dev" }),
        ];
        writeFileSync(join(splitDir, "hono.jsonl"), `${hono.map(line).join("\n")}\n`);
        writeFileSync(join(splitDir, "commander.jsonl"), `${cmd.map(line).join("\n")}\n`);
        return splitDir;
    }

    it("--repo samples only that repo", () => {
        const splitDir = seedBench();
        expect(runSampleCli(["--split", "dev", "--seed", "9", "--repo", "honojs__hono"], bench)).toBe(0);
        expect(JSON.parse(readFileSync(join(splitDir, "second-label-honojs__hono.json"), "utf8")).ids).toHaveLength(1);
    });

    it("reuses the existing file when the seed matches", () => {
        const splitDir = seedBench();
        expect(runSampleCli(["--split", "dev", "--seed", "9"], bench)).toBe(0);
        const out = join(splitDir, "second-label-honojs__hono.json");
        const before = readFileSync(out, "utf8");
        const mtime = statSync(out).mtimeMs;
        expect(runSampleCli(["--split", "dev", "--seed", "9"], bench)).toBe(0);
        expect(readFileSync(out, "utf8")).toBe(before);
        expect(statSync(out).mtimeMs).toBe(mtime);
    });
});

describe("pinned query-file classification", () => {
    let dir = "";
    afterEach(() => {
        if (dir !== "") rmSync(dir, { recursive: true, force: true });
        dir = "";
    });

    it("does not parse per-repo adjudication and -rest variants as queries", () => {
        dir = mkdtempSync(join(tmpdir(), "d46-pinned-"));
        const pinned = new Set(["colinhacks__zod.jsonl"]);
        const line = JSON.stringify(behaviourQuery());
        writeFileSync(join(dir, "colinhacks__zod.jsonl"), `${line}\n`);
        writeFileSync(join(dir, "adjudication-colinhacks__zod.jsonl"), `${line}\n`);
        writeFileSync(join(dir, "adjudication-colinhacks__zod-rest.jsonl"), `${line}\n`);
        writeFileSync(join(dir, "second-labels-colinhacks__zod-rest.jsonl"), "x\n");
        writeFileSync(join(dir, "colinhacks__zod.jsonl.pre-adjudication-rest"), "x\n");
        const loaded = loadSplitQueries(dir, pinned);
        expect(loaded.errors).toEqual([]);
        expect(loaded.files.map((f) => f.file)).toEqual(["colinhacks__zod.jsonl"]);
        expect(loaded.queries).toHaveLength(1);
    });

    it("classifies per-repo artifact roles and seals unknown files as 'other'", () => {
        const pinned = new Set(["colinhacks__zod.jsonl"]);
        expect(classifyArtifact("colinhacks__zod.jsonl", pinned)).toBe("queries");
        expect(classifyArtifact("adjudication-colinhacks__zod.jsonl", pinned)).toBe("adjudication");
        expect(classifyArtifact("adjudication-colinhacks__zod-rest.jsonl", pinned)).toBe("adjudication");
        expect(classifyArtifact("second-labels-colinhacks__zod-rest.jsonl", pinned)).toBe("second-labels");
        expect(classifyArtifact("colinhacks__zod.jsonl.pre-adjudication-rest", pinned)).toBe("pre-adjudication");
        expect(classifyArtifact("notes.txt", pinned)).toBe("other");
        dir = mkdtempSync(join(tmpdir(), "d46-other-"));
        writeFileSync(join(dir, "notes.txt"), "x\n");
        const sealed = listSealedArtifacts(dir, pinned);
        expect(sealed.map((a) => [a.file, a.role])).toEqual([["notes.txt", "other"]]);
    });

    it("errors on a stray foo.jsonl matching no pinned repo", () => {
        dir = mkdtempSync(join(tmpdir(), "d46-stray-"));
        const pinned = new Set(["colinhacks__zod.jsonl"]);
        const line = JSON.stringify(behaviourQuery());
        writeFileSync(join(dir, "colinhacks__zod.jsonl"), `${line}\n`);
        writeFileSync(join(dir, "foo.jsonl"), `${line}\n`);
        const loaded = loadSplitQueries(dir, pinned);
        expect(loaded.errors.some((e) => e.includes("foo.jsonl"))).toBe(true);
        expect(loaded.queries).toHaveLength(1);
    });
});
