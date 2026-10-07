/**
 * Phase-B judge-wave tests for the find tool: no-judge identity, keep/drop
 * ordering at p >= 0.40, directory grouping (>= 2 kept children), failure
 * fallback to the unjudged ranking with a degraded code, judge isolation to
 * natural-language mode, symbol caps/tree shape, and no index/graph builds.
 */
import { mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    buildFindJudgeTree,
    createFindTool,
    FIND_JUDGE_KEEP_PROBABILITY,
} from "../../../src/search/find-tool.js";
import { JudgeError, type Judge, type JudgeNoulInput } from "../../../src/judge/types.js";

let workdir: string;

function write(rel: string, content = "export const x = 1;\n"): void {
    const abs = join(workdir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
}

function ctx() {
    return {
        cwd: workdir,
        sessionManager: { getSessionFile: () => "/sessions/find-judge-test.jsonl" },
    } as any;
}

const NL_QUERY = "files that handle authentication state";

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "find-judge-")));
    // Basenames share exact tokens with NL_QUERY so fusion finds them.
    write("src/authentication.ts", "export function login() { return true; }\n");
    write("src/state.ts", "export const state = {};\n");
    write("src/handle.ts", "export function handle() { return true; }\n");
    write("src/nested/deep-state.ts", "export const deepState = 1;\n");
    write("src/db.ts", "export function connect() { return true; }\n");
});

afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
});

function fakeJudge(
    score: (relPath: string, key: string) => number | undefined,
    seen: { input?: JudgeNoulInput } = {},
): Judge {
    return {
        info: { backend: "cloud", model: "test-judge", baseUrl: "https://judge.example" },
        async judgeNouls(input: JudgeNoulInput) {
            seen.input = input;
            const p = new Map<string, number>();
            for (const item of input.items) {
                const relPath = String((input.shared.units as Record<string, any>)[item.id]?.path ?? "");
                const value = score(relPath, item.id);
                if (value !== undefined) p.set(item.id, value);
            }
            return { p, unjudged: [], usage: { inputTokens: 0, requests: 1 }, cacheHits: 0 };
        },
    };
}

describe("find judge wave: no-judge identity", () => {
    it("keeps the unjudged ranking when no judge is injected", async () => {
        const tool = createFindTool();
        const result: any = await tool.execute("j-1", { pattern: NL_QUERY }, undefined, undefined, ctx());
        expect(result.details.mode).toBe("natural-language");
        expect(result.content[0].text).toContain("ranked (unjudged)");
        expect(result.details.judge).toBeUndefined();
        expect(result.details.degraded).toBeUndefined();
    });

    it("resolves the judge with the workspace and live execution context", async () => {
        const executionContext = ctx();
        let resolvedRoot: string | undefined;
        let resolvedContext: unknown;
        const tool = createFindTool({
            resolveJudge: async (root, context) => {
                resolvedRoot = root;
                resolvedContext = context;
                return { judge: fakeJudge(() => 0.8) };
            },
        });
        const result: any = await tool.execute("j-resolve", { pattern: NL_QUERY }, undefined, undefined, executionContext);
        expect(resolvedRoot).toBe(workdir);
        expect(resolvedContext).toBe(executionContext);
        expect(result.details.judge.backend).toBe("cloud");
    });
});

describe("find judge wave: keep/drop/order", () => {
    it("keeps p >= 0.40 ordered by probability and drops the rest", async () => {
        const seen: { input?: JudgeNoulInput } = {};
        const judge = fakeJudge((relPath) => {
            if (relPath === "src/authentication.ts") return 0.93;
            if (relPath === "src/nested/deep-state.ts") return 0.7;
            if (relPath === "src/state.ts") return 0.55;
            return 0.1;
        }, seen);
        const tool = createFindTool({ judge });
        const result: any = await tool.execute("j-2", { pattern: NL_QUERY }, undefined, undefined, ctx());
        const text = result.content[0].text as string;
        expect(text).not.toContain("ranked (unjudged)");
        expect(text).toContain("authentication.ts  0.93");
        expect(text).toContain("deep-state.ts  0.70");
        expect(text).toContain("state.ts  0.55");
        const paths = (result.details.entries as any[])
            .filter((entry) => entry.type === "file")
            .map((entry) => entry.path);
        expect(paths).toEqual([
            "src/authentication.ts",
            "src/nested/deep-state.ts",
            "src/state.ts",
        ]);
        // Judge-dropped and never-fused files stay out.
        expect(paths).not.toContain("src/handle.ts");
        expect(paths).not.toContain("src/db.ts");
        expect(result.details.judge).toMatchObject({
            backend: "cloud",
            threshold: FIND_JUDGE_KEEP_PROBABILITY,
            kept: 3,
            dropped: 1,
        });
        // One noul question per candidate file.
        expect(Object.keys(seen.input?.shared.units ?? {}).length).toBe(seen.input?.items.length);
    });

    it("drops everything below the threshold", async () => {
        const tool = createFindTool({ judge: fakeJudge(() => 0.39) });
        const result: any = await tool.execute("j-3", { pattern: NL_QUERY }, undefined, undefined, ctx());
        expect(result.details.judge.kept).toBe(0);
        expect((result.content[0].text as string)).toContain("(no matches)");
    });
});

describe("find judge wave: partial judge response", () => {
    it("preserves candidates with missing probabilities with degradation instead of dropping them", async () => {
        const judge = fakeJudge((relPath) => {
            if (relPath === "src/state.ts") return undefined;
            if (relPath === "src/authentication.ts") return 0.9;
            if (relPath === "src/nested/deep-state.ts") return 0.7;
            return 0.1;
        });
        const tool = createFindTool({ judge });
        const result: any = await tool.execute("j-partial", { pattern: NL_QUERY }, undefined, undefined, ctx());
        const files = (result.details.entries as any[]).filter((entry) => entry.type === "file");
        // Judge-kept files stay scored and first; the unanswered candidate
        // is preserved after them without a score.
        expect(files.map((entry) => entry.path)).toEqual([
            "src/authentication.ts",
            "src/nested/deep-state.ts",
            "src/state.ts",
        ]);
        expect(files[0].score).toBe(0.9);
        expect(files[2].score).toBeUndefined();
        expect(result.details.judge).toMatchObject({ kept: 2, dropped: 1, unjudged: 1 });
        expect(result.details.degraded).toContain("judge_bad_response");
        expect(result.details.judge.degraded).toContain("judge_bad_response");
        expect(result.content[0].text).not.toContain("(no matches)");
    });
});

describe("find judge wave: directory grouping", () => {
    it("reports a directory only when >= 2 kept files share it", async () => {
        const judge = fakeJudge((relPath) => {
            if (relPath === "src/authentication.ts") return 0.9;
            if (relPath === "src/state.ts") return 0.8;
            if (relPath === "src/nested/deep-state.ts") return 0.7;
            return 0.1;
        });
        const tool = createFindTool({ judge });
        const result: any = await tool.execute("j-4", { pattern: NL_QUERY }, undefined, undefined, ctx());
        const dirs = (result.details.entries as any[]).filter((entry) => entry.type === "directory");
        expect(dirs.map((entry) => entry.path)).toContain("src");
        expect(dirs.find((entry) => entry.path === "src")?.score).toBe(0.9);
        expect(result.details.judge.kept).toBe(3);
        // src/nested holds a single kept file: no directory entry.
        expect(dirs.map((entry) => entry.path)).not.toContain("src/nested");
    });
});

describe("find judge wave: failure fallback", () => {
    it("falls back to the unjudged ranking with a degraded code on judge error", async () => {
        const failing: Judge = {
            info: { backend: "cloud", model: "test-judge", baseUrl: "https://judge.example" },
            async judgeNouls() {
                throw new JudgeError("timeout", "judge timed out");
            },
        };
        const tool = createFindTool({ judge: failing });
        const result: any = await tool.execute("j-5", { pattern: NL_QUERY }, undefined, undefined, ctx());
        expect(result.content[0].text).toContain("ranked (unjudged)");
        expect(result.details.degraded).toContain("judge_timeout");
        expect(result.details.judge.degraded).toContain("judge_timeout");
        expect(result.details.entries.length).toBeGreaterThan(0);
    });
});

describe("find judge wave: mode isolation and tree cards", () => {
    it("never judges glob or fuzzy modes", async () => {
        let calls = 0;
        const judge: Judge = {
            info: { backend: "cloud", model: "test-judge", baseUrl: "https://judge.example" },
            async judgeNouls(input) {
                calls += 1;
                return {
                    p: new Map(input.items.map((item) => [item.id, 0.99])),
                    unjudged: [],
                    usage: { inputTokens: 0, requests: 1 },
                    cacheHits: 0,
                };
            },
        };
        const tool = createFindTool({ judge });
        const globbed: any = await tool.execute("j-6", { pattern: "src/*.ts" }, undefined, undefined, ctx());
        expect(globbed.details.mode).toBe("glob");
        const fuzzy: any = await tool.execute("j-7", { pattern: "deep" }, undefined, undefined, ctx());
        expect(fuzzy.details.mode).toBe("fuzzy");
        expect(calls).toBe(0);
    });

    it("caps tree cards at 8 symbols per file and tags files only", async () => {
        const symbols = Array.from({ length: 10 }, (_, i) => `symbol${i}`);
        const seen: { input?: JudgeNoulInput } = {};
        const tool = createFindTool({
            judge: fakeJudge(() => 0.9, seen),
            getFileSymbols: () => symbols,
        });
        await tool.execute("j-8", { pattern: NL_QUERY }, undefined, undefined, ctx());
        const tree = String((seen.input?.shared as any)?.tree ?? "");
        const cardLine = tree.split("\n").find((line) => line.includes("authentication.ts"));
        expect(cardLine).toBeDefined();
        expect(cardLine).toContain("[f");
        expect(cardLine).toContain("symbol7");
        expect(cardLine).not.toContain("symbol8");
        // Folders stay untagged headers.
        for (const line of tree.split("\n")) {
            if (!line.startsWith("  ")) expect(line).not.toMatch(/\[[^\]]+\]/);
        }
    });

    it("buildFindJudgeTree groups by directory with files tagged", () => {
        const tree = buildFindJudgeTree([
            { key: "f0", relPath: "src/auth.ts", sizeBytes: 10, symbols: ["login"] },
            { key: "f1", relPath: "docs/guide.md", sizeBytes: 20, symbols: [] },
        ]);
        expect(tree).toContain("src/");
        expect(tree).toContain("[f0] auth.ts (10 bytes) symbols: login");
        expect(tree).toContain("[f1] guide.md (20 bytes)");
    });
});

describe("find judge wave: no index/graph builds", () => {
    it("leaves no index, graph, or tag caches behind (judged or not)", async () => {
        const tool = createFindTool({ judge: fakeJudge(() => 0.9) });
        await tool.execute("j-9", { pattern: NL_QUERY }, undefined, undefined, ctx());
        const plain = createFindTool();
        await plain.execute("j-10", { pattern: NL_QUERY }, undefined, undefined, ctx());
        const leftovers = readdirSync(workdir, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => name.startsWith(".pi") || name === "graphify-out");
        expect(leftovers).toEqual([]);
    });

    it("sends at most 128 candidates to the judge", async () => {
        for (let i = 0; i < 150; i++) write(`bulk/f${i}.ts`);
        const seen: { input?: JudgeNoulInput } = {};
        const tool = createFindTool({ judge: fakeJudge(() => 0.9, seen) });
        await tool.execute("j-11", { pattern: "bulk source files that handle testing" }, undefined, undefined, ctx());
        expect(seen.input!.items.length).toBeLessThanOrEqual(128);
    });
});
