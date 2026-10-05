import { describe, expect, it } from "vitest";
import {
    finalizeNaturalLanguageResults,
    fuseNaturalLanguageCandidates,
    type FindDiscoveredFile,
} from "../../../src/search/find-candidates.js";

function file(relPath: string): FindDiscoveredFile {
    return { absPath: `/w/${relPath}`, relPath, mtimeMs: 0, dirty: false };
}

const FILES = [
    "src/embedding.ts",
    "src/embedding-profile.ts",
    "src/config.ts",
    "docs/configuration.md",
].map(file);

const NO_SIGNALS = {
    semanticFileScores: async () => new Map<string, number>(),
    symbolFileRanks: () => [],
    pagerankFileRanks: () => [],
};

describe("fuseNaturalLanguageCandidates (unjudged)", () => {
    it("is deterministic without index/graph backends", async () => {
        const query = "files that configure the embedding endpoint";
        const first = await fuseNaturalLanguageCandidates(query, FILES, "/w", { ...NO_SIGNALS });
        const second = await fuseNaturalLanguageCandidates(query, FILES, "/w", { ...NO_SIGNALS });
        expect(second).toEqual(first);
        expect(first.length).toBeGreaterThan(0);
        expect(first[0]!.relPath).toBe("src/embedding.ts");
    });

    it("fuses injected signals by reciprocal rank (k=60)", async () => {
        const fused = await fuseNaturalLanguageCandidates("embedding endpoint config", FILES, "/w", {
            semanticFileScores: async () => new Map([["docs/configuration.md", 0.9]]),
            symbolFileRanks: () => ["src/config.ts"],
            pagerankFileRanks: () => ["src/embedding.ts", "src/config.ts"],
        });
        const order = fused.map((entry) => entry.relPath);
        // Every contributing signal surfaces in the fused ranking.
        expect(order).toContain("src/embedding.ts");
        expect(order).toContain("docs/configuration.md");
        expect(order).toContain("src/config.ts");
        // Scores descend.
        for (let i = 1; i < fused.length; i++) {
            expect(fused[i - 1]!.fusedScore).toBeGreaterThanOrEqual(fused[i]!.fusedScore);
        }
    });

    it("caps candidates at 128", async () => {
        const many = Array.from({ length: 200 }, (_, i) => file(`src/f${i}.ts`));
        const fused = await fuseNaturalLanguageCandidates("source file f", many, "/w", { ...NO_SIGNALS });
        expect(fused.length).toBeLessThanOrEqual(128);
    });

    it("never triggers index or graph builds by default", async () => {
        // Default deps only read already-available backends; with none
        // registered this resolves purely from path tokens.
        const fused = await fuseNaturalLanguageCandidates("configure the embedding endpoint", FILES, "/w");
        expect(fused.length).toBeGreaterThan(0);
        expect(fused[0]!.relPath).toBe("src/embedding.ts");
    });
});

describe("finalizeNaturalLanguageResults (Phase-B seam)", () => {
    it("normalizes fused scores to (0, 1] and applies the limit", () => {
        const final = finalizeNaturalLanguageResults([
            { relPath: "a.ts", fusedScore: 0.04 },
            { relPath: "b.ts", fusedScore: 0.02 },
            { relPath: "c.ts", fusedScore: 0.01 },
        ], 2);
        expect(final).toEqual([
            { relPath: "a.ts", score: 1 },
            { relPath: "b.ts", score: 0.5 },
        ]);
    });

    it("handles empty fusion", () => {
        expect(finalizeNaturalLanguageResults([], 20)).toEqual([]);
    });
});
