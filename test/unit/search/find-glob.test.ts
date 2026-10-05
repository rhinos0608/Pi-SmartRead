/**
 * Glob compatibility with pi's builtin find semantics, plus discovery
 * budgets and git-dirty ranking inputs.
 *
 * Fixtures live in os tmpdirs (never the developer's live cache).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    discoverFindCandidates,
    matchFindGlob,
    matchFuzzyCandidates,
    matchGlobCandidates,
    sortGlobFiles,
    type FindDiscoveryResult,
} from "../../../src/search/find-candidates.js";

let workdir: string;

function write(rel: string, content = "x\n"): void {
    const abs = join(workdir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
}

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "find-glob-")));
    write("src/auth.ts");
    write("src/db.ts");
    write("src/nested/deep.ts");
    write("test/auth.test.ts");
    write(".hidden-secret.ts");
    write("ignored.log");
    write(".gitignore", "ignored.log\n");
});

afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
});

async function discover(): Promise<FindDiscoveryResult> {
    return discoverFindCandidates(workdir, { readGitDirty: async () => new Set() });
}

describe("matchFindGlob (builtin-compatible)", () => {
    it("matches basenames when the pattern has no slash", async () => {
        expect(await matchFindGlob("*.ts", "src/auth.ts")).toBe(true);
        expect(await matchFindGlob("*.ts", "test/auth.test.ts")).toBe(true);
        expect(await matchFindGlob("auth.ts", "src/auth.ts")).toBe(true);
        expect(await matchFindGlob("db.ts", "src/auth.ts")).toBe(false);
    });

    it("matches full relative paths when the pattern has a slash", async () => {
        expect(await matchFindGlob("src/*.ts", "src/auth.ts")).toBe(true);
        expect(await matchFindGlob("src/*.ts", "test/auth.test.ts")).toBe(false);
        expect(await matchFindGlob("src/**/*.ts", "src/nested/deep.ts")).toBe(true);
    });

    it("matches hidden files (dot:true)", async () => {
        expect(await matchFindGlob("*.ts", ".hidden-secret.ts")).toBe(true);
    });
});

describe("matchGlobCandidates over discovery", () => {
    it("respects .gitignore via discoverFiles", async () => {
        const discovered = await discover();
        const rels = discovered.files.map((f) => f.relPath);
        expect(rels).toContain("src/auth.ts");
        expect(rels).not.toContain("ignored.log");
    });

    it("exposes directories containing discovered files as matchable entries", async () => {
        const discovered = await discover();
        expect(discovered.directories).toContain("src");
        expect(discovered.directories).toContain("src/nested");
        const matched = await matchGlobCandidates("src/**", discovered);
        expect(matched.directories).toContain("src/nested");
    });

    it("finds nothing for a non-matching pattern", async () => {
        const discovered = await discover();
        const matched = await matchGlobCandidates("*.py", discovered);
        expect(matched.files).toEqual([]);
    });
});

describe("sortGlobFiles", () => {
    it("orders dirty first, then mtime desc, then path", () => {
        const files = [
            { absPath: "/w/b.ts", relPath: "b.ts", mtimeMs: 300, dirty: false },
            { absPath: "/w/a.ts", relPath: "a.ts", mtimeMs: 100, dirty: true },
            { absPath: "/w/c.ts", relPath: "c.ts", mtimeMs: 200, dirty: true },
        ];
        const ranked = sortGlobFiles(files).map((f) => f.relPath);
        expect(ranked).toEqual(["c.ts", "a.ts", "b.ts"]);
    });

    it("breaks mtime ties by path", () => {
        const files = [
            { absPath: "/w/b.ts", relPath: "b.ts", mtimeMs: 100, dirty: false },
            { absPath: "/w/a.ts", relPath: "a.ts", mtimeMs: 100, dirty: false },
        ];
        expect(sortGlobFiles(files).map((f) => f.relPath)).toEqual(["a.ts", "b.ts"]);
    });
});

describe("matchFuzzyCandidates ties", () => {
    it("breaks score ties by shorter path then mtime desc", () => {
        const discovered: FindDiscoveryResult = {
            files: [
                { absPath: "/w/src/aaa-auth.ts", relPath: "src/aaa-auth.ts", mtimeMs: 1, dirty: false },
                { absPath: "/w/auth.ts", relPath: "auth.ts", mtimeMs: 1, dirty: false },
            ],
            directories: [],
            timedOut: false,
            dirtyFiles: new Set(),
        };
        const matched = matchFuzzyCandidates("auth", discovered);
        expect(matched.files.map((f) => f.relPath)[0]).toBe("auth.ts");
    });
});

describe("discoverFindCandidates budget", () => {
    it("returns partial results with timedOut when the walker exceeds budget", async () => {
        const seen: string[] = [];
        const result = await discoverFindCandidates(workdir, {
            discover: async (_root, signal) => {
                seen.push("walk");
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (signal?.aborted) return [join(workdir, "src/auth.ts")];
                return [join(workdir, "src/auth.ts"), join(workdir, "src/db.ts")];
            },
            readGitDirty: async () => new Set(),
            traversalBudgetMs: 5,
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        expect(seen).toEqual(["walk"]);
        expect(result.timedOut).toBe(true);
        expect(result.files.map((f) => f.relPath)).toEqual(["src/auth.ts"]);
    });

    it("marks git-dirty files from a single status read", async () => {
        const result = await discoverFindCandidates(workdir, {
            readGitDirty: async () => new Set(["src/auth.ts"]),
        });
        const byPath = new Map(result.files.map((f) => [f.relPath, f.dirty]));
        expect(byPath.get("src/auth.ts")).toBe(true);
        expect(byPath.get("src/db.ts")).toBe(false);
    });

    it("treats git failure as no dirty files", async () => {
        const result = await discoverFindCandidates(workdir, {
            readGitDirty: async () => { throw new Error("not a repo"); },
        });
        expect(result.files.every((f) => !f.dirty)).toBe(true);
    });
});
