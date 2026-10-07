import { describe, expect, it } from "vitest";
import { formatFindOutput, groupFindEntries } from "../../../src/search/find-format.js";

describe("groupFindEntries", () => {
    it("groups by parent directory with ./ first", () => {
        const groups = groupFindEntries([
            { path: "src/b.ts", type: "file" },
            { path: "top.ts", type: "file" },
            { path: "docs/guide.md", type: "file" },
            { path: "src/a.ts", type: "file" },
        ]);
        expect(groups.map((g) => g.dir)).toEqual([".", "docs", "src"]);
        expect(groups[2]!.items.map((i) => i.path)).toEqual(["src/b.ts", "src/a.ts"]);
    });
});

describe("formatFindOutput", () => {
    it("renders grouped headers with scores for natural language", () => {
        const text = formatFindOutput({
            pattern: "embedding endpoint",
            mode: "natural-language",
            entries: [
                { path: "src/embedding.ts", type: "file", score: 1 },
                { path: "src/embedding-profile.ts", type: "file", score: 0.62 },
            ],
            total: 2,
            elapsedMs: 900,
            timedOut: false,
            unjudged: true,
        });
        expect(text).toContain("(natural language, ranked (unjudged)");
        expect(text).toContain("# src/");
        expect(text).toContain("  embedding.ts  1.00");
        expect(text).toContain("  embedding-profile.ts  0.62");
    });

    it("marks git-dirty files with * and no scores in glob/fuzzy", () => {
        const text = formatFindOutput({
            pattern: "*.ts",
            mode: "glob",
            entries: [
                { path: "src/auth.ts", type: "file", dirty: true },
                { path: "src/db.ts", type: "file" },
            ],
            total: 2,
            elapsedMs: 50,
            timedOut: false,
            unjudged: true,
        });
        expect(text).toContain("  auth.ts*");
        expect(text).toContain("  db.ts");
        expect(text).not.toContain("(unjudged)");
    });

    it("renders directory entries with [dir]", () => {
        const text = formatFindOutput({
            pattern: "judge*",
            mode: "fuzzy",
            entries: [{ path: "src/judge", type: "directory" }],
            total: 1,
            elapsedMs: 10,
            timedOut: false,
            unjudged: true,
        });
        expect(text).toContain("# src/");
        expect(text).toContain("  judge/  [dir]");
    });

    it("adds truncation steering when entries are capped", () => {
        const text = formatFindOutput({
            pattern: "*.ts",
            mode: "glob",
            entries: [{ path: "a.ts", type: "file" }],
            total: 5,
            elapsedMs: 10,
            timedOut: false,
            unjudged: true,
        });
        expect(text).toContain("(showing 1 of 5 — narrow the pattern or set path)");
    });

    it("adds a steering notice on traversal timeout", () => {
        const text = formatFindOutput({
            pattern: "*.ts",
            mode: "glob",
            entries: [{ path: "a.ts", type: "file" }],
            total: 1,
            elapsedMs: 5000,
            timedOut: true,
            unjudged: true,
        });
        expect(text).toContain("partial results: traversal budget exceeded");
    });
});
