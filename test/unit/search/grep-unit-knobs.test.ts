/** Experimental M/E knobs for symbol unit mode (D34): resolvers + per-file/excerpt behavior. */
import { describe, expect, it } from "vitest";
import {
    GREP_UNIT_EXCERPT_LINES,
    GREP_UNIT_MAX_PER_FILE,
    buildSymbolUnitHits,
    resolveGrepUnitExcerptLines,
    resolveGrepUnitMaxPerFile,
} from "../../../src/search/grep-units.js";

const MAX_VAR = "PI_SMARTREAD_GREP_UNIT_MAX_PER_FILE";
const EXCERPT_VAR = "PI_SMARTREAD_GREP_UNIT_EXCERPT_LINES";

function multiFnContent(): string {
    return [1, 2, 3, 4]
        .map((n) => `export function retryWorker${n}(url: string) {\n  return executeWithBackoff(url);\n}`)
        .join("\n");
}

function baseInput(content: string, pattern = "retry backoff") {
    return {
        absPath: "/tmp/multi.ts",
        relFile: "multi.ts",
        content,
        filePathForLang: "/tmp/multi.ts",
        pattern,
        fileScore: 1,
        contextLines: 2,
    };
}

describe("resolveGrepUnitMaxPerFile", () => {
    it("defaults to 2 and accepts 1..4", () => {
        expect(resolveGrepUnitMaxPerFile({})).toBe(GREP_UNIT_MAX_PER_FILE);
        expect(resolveGrepUnitMaxPerFile({ [MAX_VAR]: "1" })).toBe(1);
        expect(resolveGrepUnitMaxPerFile({ [MAX_VAR]: "4" })).toBe(4);
    });

    it("falls back to default on invalid values", () => {
        for (const v of ["0", "5", "-1", "abc", "", "2.5"]) {
            expect(resolveGrepUnitMaxPerFile({ [MAX_VAR]: v })).toBe(GREP_UNIT_MAX_PER_FILE);
        }
    });
});

describe("resolveGrepUnitExcerptLines", () => {
    it("defaults to 12 and accepts 4..40", () => {
        expect(resolveGrepUnitExcerptLines({})).toBe(GREP_UNIT_EXCERPT_LINES);
        expect(resolveGrepUnitExcerptLines({ [EXCERPT_VAR]: "4" })).toBe(4);
        expect(resolveGrepUnitExcerptLines({ [EXCERPT_VAR]: "40" })).toBe(40);
    });

    it("falls back to default on invalid values", () => {
        for (const v of ["3", "41", "0", "abc", "", "12.5"]) {
            expect(resolveGrepUnitExcerptLines({ [EXCERPT_VAR]: v })).toBe(GREP_UNIT_EXCERPT_LINES);
        }
    });
});

describe("M/E knobs in buildSymbolUnitHits", () => {
    it("caps units per file at M from the environment", () => {
        const withDefault = buildSymbolUnitHits(baseInput(multiFnContent()));
        expect(withDefault).not.toBeNull();
        expect(withDefault).toHaveLength(GREP_UNIT_MAX_PER_FILE);
        const capped = buildSymbolUnitHits(baseInput(multiFnContent()), {
            maxPerFile: 1,
            excerptLines: GREP_UNIT_EXCERPT_LINES,
        });
        expect(capped).not.toBeNull();
        expect(capped).toHaveLength(1);
    });

    it("re-selects the excerpt window for E instead of truncating", () => {
        const filler = Array.from({ length: 30 }, (_, i) => `  const step${i} = ${i};`);
        filler[19] = "  return executeWithBackoff(retryPolicy);";
        const content = `export function retryLoop(url: string) {\n${filler.join("\n")}\n}\n`;
        const full = buildSymbolUnitHits({ ...baseInput(content), pattern: "retry backoff" });
        const short = buildSymbolUnitHits(
            { ...baseInput(content), pattern: "retry backoff" },
            { maxPerFile: 1, excerptLines: 4 },
        );
        expect(full).not.toBeNull();
        expect(short).not.toBeNull();
        // E lines rendered, and the 4-line window is the centered selection —
        // not the first 4 lines of the 12-line excerpt.
        expect(short![0]!.snippet.split("\n")).toHaveLength(4);
        const fullLines = full![0]!.snippet.split("\n");
        const shortLines = short![0]!.snippet.split("\n");
        expect(shortLines).not.toEqual(fullLines.slice(0, 4));
        for (const l of shortLines) expect(fullLines).toContain(l);
    });
});
