/**
 * D31 enclosing-symbol result units for the no-index BM25 fallback path.
 *
 * Anchor mode (default) is byte-identical to the pre-seam behaviour;
 * symbol mode emits the enclosing function rather than a comment anchor,
 * caps units per file, bounds excerpts within the unit, and falls back to
 * the anchor window when no symbols parse or the unit is oversized.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    GREP_UNIT_EXCERPT_LINES,
    GREP_UNIT_MAX_PER_FILE,
    GREP_UNIT_MAX_SYMBOL_LINES,
    buildSymbolUnitHits,
    formatUnitSnippet,
    listEnclosingSymbolUnits,
    resolveGrepUnitMode,
} from "../../../src/search/grep-units.js";
import { runFallbackBm25 } from "../../../src/search/grep-cascade.js";

const UNIT_MODE_VAR = "PI_SMARTREAD_GREP_UNIT_MODE";

let workdir: string;
let savedUnitMode: string | undefined;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-units-")));
    savedUnitMode = process.env[UNIT_MODE_VAR];
});

afterEach(() => {
    if (savedUnitMode === undefined) delete process.env[UNIT_MODE_VAR];
    else process.env[UNIT_MODE_VAR] = savedUnitMode;
    rmSync(workdir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
    writeFileSync(join(workdir, name), content, "utf8");
}

/** Comment anchor carries all query tokens; the function body spreads them. */
const COMMENT_ABOVE_FN = [
    "// retry backoff policy for failed requests",
    "export function retryFailedRequests(url: string) {",
    "  const policy = loadRetryPolicy(url);",
    "  return executeWithBackoff(policy);",
    "}",
    "",
].join("\n");

async function fallback(pattern: string, contextLines = 2) {
    const hits = await runFallbackBm25({
        pattern,
        searchDir: workdir,
        topK: 5,
        contextLines,
        cwd: workdir,
        signal: undefined,
        scopedFile: undefined,
        fileGlob: undefined,
        deps: undefined,
        root: workdir,
    });
    return [...hits.values()];
}

describe("resolveGrepUnitMode", () => {
    it("defaults to anchor and only honours the exact symbol value", () => {
        expect(resolveGrepUnitMode({})).toBe("anchor");
        expect(resolveGrepUnitMode({ [UNIT_MODE_VAR]: "anchor" })).toBe("anchor");
        expect(resolveGrepUnitMode({ [UNIT_MODE_VAR]: "SYMBOL" })).toBe("anchor");
        expect(resolveGrepUnitMode({ [UNIT_MODE_VAR]: "symbol" })).toBe("symbol");
    });
});

describe("anchor mode (default)", () => {
    it("is byte-identical with the seam unset vs explicit anchor", async () => {
        write("a.ts", COMMENT_ABOVE_FN);
        delete process.env[UNIT_MODE_VAR];
        const unset = await fallback("retry backoff policy");
        process.env[UNIT_MODE_VAR] = "anchor";
        const explicit = await fallback("retry backoff policy");
        expect(explicit).toEqual(unset);
    });

    it("snapshots the comment-anchor window", async () => {
        write("a.ts", COMMENT_ABOVE_FN);
        delete process.env[UNIT_MODE_VAR];
        const result = await fallback("retry backoff policy");
        expect(result).toHaveLength(1);
        expect(result[0]?.line).toBe(1);
        expect(result[0]?.endLine).toBe(1);
        expect(result[0]?.snippet).toBe(
            [
                "       1 | // retry backoff policy for failed requests",
                "       2 | export function retryFailedRequests(url: string) {",
                "       3 |   const policy = loadRetryPolicy(url);",
            ].join("\n"),
        );
    });
});

describe("symbol mode", () => {
    beforeEach(() => {
        process.env[UNIT_MODE_VAR] = "symbol";
    });

    it("returns the enclosing function instead of the comment line above it", async () => {
        write("a.ts", COMMENT_ABOVE_FN);
        const result = await fallback("retry backoff policy");
        expect(result.length).toBeGreaterThanOrEqual(1);
        const hit = result[0]!;
        expect(hit.line).toBe(2);
        expect(hit.endLine).toBe(5);
        expect(hit.name).toBe("retryFailedRequests");
        expect(hit.snippet).not.toContain("for failed requests");
        expect(hit.snippet).toContain("executeWithBackoff");
    });

    it(`emits at most ${GREP_UNIT_MAX_PER_FILE} units per file`, async () => {
        const fns = [1, 2, 3]
            .map(
                (n) =>
                    `export function retryWorker${n}(url: string) {\n  return executeWithBackoff(url);\n}`,
            )
            .join("\n");
        write("multi.ts", `${fns}\n`);
        const result = await fallback("retry backoff");
        const fileHits = result.filter((h) => h.relFile === "multi.ts");
        expect(fileHits).toHaveLength(GREP_UNIT_MAX_PER_FILE);
        const starts = new Set(fileHits.map((h) => `${h.line}-${h.endLine}`));
        expect(starts.size).toBe(fileHits.length);
    });

    it(`bounds excerpts to ${GREP_UNIT_EXCERPT_LINES} lines within the unit`, async () => {
        const body = Array.from({ length: 30 }, (_, i) => `  doBackoffStep(${i});`).join("\n");
        write("long.ts", `export function retryLoop(url: string) {\n${body}\n}\n`);
        const result = await fallback("retry backoff");
        expect(result).toHaveLength(1);
        const hit = result[0]!;
        expect(hit.line).toBe(1);
        expect(hit.endLine).toBe(32);
        const rendered = hit.snippet.split("\n");
        expect(rendered.length).toBeLessThanOrEqual(GREP_UNIT_EXCERPT_LINES);
        const renderedLines = rendered.map((l) => Number(l.trim().split(" ")[0]));
        expect(Math.min(...renderedLines)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...renderedLines)).toBeLessThanOrEqual(32);
    });

    it("falls back to the anchor window when no symbols parse", async () => {
        write("notes.ts", "// retry backoff policy notes\n// nothing else here\n");
        const result = await fallback("retry backoff policy");
        expect(result).toHaveLength(1);
        expect(result[0]?.line).toBe(1);
        expect(result[0]?.endLine).toBe(1);
    });

    it(`falls back to the anchor window for units over ${GREP_UNIT_MAX_SYMBOL_LINES} lines`, async () => {
        const body = Array.from({ length: GREP_UNIT_MAX_SYMBOL_LINES + 10 }, () => "  x++;").join("\n");
        write(
            "huge.ts",
            `// retry backoff policy for failed requests\nexport function retryHuge() {\n${body}\n}\n`,
        );
        const result = await fallback("retry backoff policy");
        expect(result).toHaveLength(1);
        expect(result[0]?.line).toBe(1);
        expect(result[0]?.endLine).toBe(1);
    });

    it("preserves file order from file-level BM25", async () => {
        write("a.ts", COMMENT_ABOVE_FN);
        write("b.ts", "// unrelated helper\nconst x = 1;\n");
        const result = await fallback("retry backoff policy");
        expect(result[0]?.relFile).toBe("a.ts");
    });
});

describe("unit helpers", () => {
    it("returns no units for unparseable content", () => {
        expect(listEnclosingSymbolUnits("(((", "broken.ts")).toEqual([]);
        expect(listEnclosingSymbolUnits("hello", "notes.txt")).toEqual([]);
    });

    it("buildSymbolUnitHits returns null when nothing scores", () => {
        expect(
            buildSymbolUnitHits({
                absPath: "/tmp/x.ts",
                relFile: "x.ts",
                content: "const x = 1;\n",
                filePathForLang: "/tmp/x.ts",
                pattern: "zzzzqqqq",
                fileScore: 1,
                contextLines: 2,
            }),
        ).toBeNull();
    });

    it("formatUnitSnippet never renders outside the unit", () => {
        const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
        const snippet = formatUnitSnippet(lines, 10, 12, 1, 12);
        expect(snippet.split("\n")).toHaveLength(3);
        expect(snippet).toContain("line10");
        expect(snippet).toContain("line12");
        expect(snippet).not.toContain("line9");
    });
});
