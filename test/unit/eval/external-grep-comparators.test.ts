/**
 * Unit tests for external grep comparator adapters (harness only).
 *
 * All fixtures are small synthetic outputs written inline — no dataset
 * content is vendored. Tests cover pure parsing/mapping/ranking helpers and
 * the ripgrep end-to-end path against a temp dir (system rg required;
 * rg-dependent cases skip honestly via ctx.skip() when rg is absent).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    parseCodannaJson,
    renderCodannaText,
} from "../../../scripts/eval/external/grep/comparators/codanna.js";
import { isComparatorName } from "../../../scripts/eval/external/grep/comparators/index.js";
import {
    parseProbeJson,
    renderProbeText,
} from "../../../scripts/eval/external/grep/comparators/probe.js";
import {
    parseRipgrepJson,
    rankRipgrepFiles,
    renderRipgrepText,
    runRipgrep,
    tokenizeForRipgrep,
} from "../../../scripts/eval/external/grep/comparators/ripgrep.js";
import type { BenchmarkInstance } from "../../../scripts/eval/external/grep/instance.js";

const tmpRoots: string[] = [];
afterEach(() => {
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
}

function stubInstance(over: Partial<BenchmarkInstance> = {}): BenchmarkInstance {
    return {
        instanceId: "synth__case-1",
        dataset: "swe-bench-multilingual",
        repo: "synth/repo",
        baseCommit: "abc123",
        title: "Focus tracker does not update on second call",
        body: "Focus tracker does not update on second call.\n\nCalling focusTracker twice leaves stale state.",
        goldFiles: ["src/focus.ts"],
        goldHunks: [],
        excludedFiles: [],
        language: "ts",
        split: "pilot",
        license: "MIT",
        ...over,
    };
}

function rgAvailable(): boolean {
    try {
        execFileSync("rg", ["--version"], { timeout: 15000, stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

describe("tokenizeForRipgrep", () => {
    it("extracts identifier terms, lowercases, drops shorts and stopwords", () => {
        const terms = tokenizeForRipgrep("Focus tracker: the bug in src/focus.ts on 2nd call!");
        expect(terms).toContain("focus");
        expect(terms).toContain("tracker");
        expect(terms).not.toContain("the");
        expect(terms).toContain("src");
        expect(terms).not.toContain("2nd");
        expect(terms).toEqual([...new Set(terms)]);
    });

    it("orders by frequency then first appearance and caps terms", () => {
        const terms = tokenizeForRipgrep("alpha beta alpha gamma beta alpha", 2);
        expect(terms).toEqual(["alpha", "beta"]);
    });

    it("returns empty for stopword-only text", () => {
        expect(tokenizeForRipgrep("the and for")).toEqual([]);
    });
});

describe("parseRipgrepJson", () => {
    const RG_BEGIN = '{"type":"begin","data":{"path":{"text":"/root/src/focus.ts"}}}';
    const match = (path: string, line: number, text = "focus") =>
        `{"type":"match","data":{"path":{"text":"${path}"},"line_number":${line},"submatches":[{"match":{"text":"${text}"}}]}}`;

    it("tallies matches per file and drops .git paths", () => {
        const out = [
            RG_BEGIN,
            match("/root/src/focus.ts", 10),
            match("/root/src/focus.ts", 4),
            match("/root/.git/objects/x", 1),
            match("/elsewhere/out.ts", 2),
            "not json",
            "{invalid",
        ].join("\n");
        const files = parseRipgrepJson(out, "/root");
        expect(files.get("src/focus.ts")).toMatchObject({ count: 2, firstLine: 4 });
        expect(files.has(".git/objects/x")).toBe(false);
        expect(files.has("../elsewhere/out.ts")).toBe(false);
    });

    it("rankRipgrepFiles orders by count desc, path asc", () => {
        const units = rankRipgrepFiles(
            new Map([
                ["b.ts", { count: 1, firstLine: 1, firstText: "" }],
                ["a.ts", { count: 1, firstLine: 2, firstText: "" }],
                ["c.ts", { count: 3, firstLine: 5, firstText: "hit" }],
            ]),
        );
        expect(units.map((u) => u.relFile)).toEqual(["c.ts", "a.ts", "b.ts"]);
        expect(units[0]).toMatchObject({ line: 5, endLine: 5, text: "hit" });
    });

    it("renderRipgrepText caps lines", () => {
        const units = Array.from({ length: 5 }, (_, i) => ({
            relFile: `f${i}.ts`,
            line: i + 1,
            endLine: i + 1,
            name: "",
            text: "x",
        }));
        expect(renderRipgrepText(units, 3).split("\n")).toHaveLength(3);
    });
});

describe("runRipgrep", () => {
    it("finds terms in a temp tree and ranks by count", async ({ skip }) => {
        if (!rgAvailable()) {
            skip("system rg not on PATH — ripgrep lexical-floor e2e unproven here, not a pass");
            return;
        }
        const root = tempDir("rg-fix-");
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src/focus.ts"), "focusTracker focusTracker focus\n");
        writeFileSync(join(root, "src/other.ts"), "focus once\n");
        const out = await runRipgrep(stubInstance(), root, "title", { timeoutMs: 30000 });
        expect(out.status).toBe("ok");
        expect(out.units[0]?.relFile).toBe("src/focus.ts");
        expect(out.setupMs).toBe(0);
        expect(out.renderedText).toContain("src/focus.ts");
    });

    it("returns empty-query when no terms survive", async () => {
        const out = await runRipgrep(stubInstance({ title: "the and for" }), "/nonexistent", "title", {
            timeoutMs: 30000,
        });
        expect(out.status).toBe("empty-query");
        expect(out.units).toEqual([]);
    });

    it("continues past a no-match term (rg exit 1) to later terms", async () => {
        const seen: string[] = [];
        const hit =
            '{"type":"match","data":{"path":{"text":"/root/src/hit.ts"},"line_number":2,"submatches":[{"match":{"text":"present"}}]}}';
        const out = await runRipgrep(stubInstance(), "/root", "title", { timeoutMs: 30000 }, {
            runTerm: (term: string) => {
                seen.push(term);
                if (seen.length === 1) {
                    // First term has no matches: rg exits 1. Must not abort.
                    throw Object.assign(new Error("no matches"), { status: 1 });
                }
                return hit;
            },
        });
        expect(seen.length).toBeGreaterThan(1);
        expect(out.status).toBe("ok");
        expect(out.units.map((u) => u.relFile)).toContain("src/hit.ts");
    });

    it("records an error and stops when a term fails with exit >= 2", async () => {
        const hit =
            '{"type":"match","data":{"path":{"text":"/root/src/hit.ts"},"line_number":2,"submatches":[{"match":{"text":"present"}}]}}';
        const seen: string[] = [];
        const out = await runRipgrep(stubInstance(), "/root", "title", { timeoutMs: 30000 }, {
            runTerm: (term: string) => {
                seen.push(term);
                if (seen.length === 1) throw Object.assign(new Error("rg crashed"), { status: 2 });
                return hit;
            },
        });
        // Fatal rg failure must stop the term loop: later terms are NOT run
        // and partial results from them must not appear.
        expect(seen.length).toBe(1);
        expect(out.status).toContain("error");
        expect(out.units).toEqual([]);
    });

    it("continues past a no-match term (rg exit 1) to later terms", async ({ skip }) => {
        if (!rgAvailable()) {
            skip("system rg not on PATH — no-match continuation unproven here, not a pass");
            return;
        }
        // "zzzqqq" sorts first by frequency but matches nothing (rg exit 1);
        // "focus" matches and must still be reported.
        const root = tempDir("rg-nomatch-");
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src/focus.ts"), "focusTracker focus\n");
        const out = await runRipgrep(
            stubInstance({ title: "zzzqqq zzzqqq zzzqqq focus" }),
            root,
            "title",
            { timeoutMs: 30000 },
        );
        expect(out.status).toBe("ok");
        expect(out.units.map((u) => u.relFile)).toContain("src/focus.ts");
    });
});

describe("parseProbeJson", () => {
    const doc = JSON.stringify({
        version: "0.6.0",
        results: [
            { file: "/root/src/focus.ts", lines: [3, 5], code: "export function focus() {\n  return 1;\n}", score: 2.3 },
            { file: "/root/src/other.ts", lines: [1, 1], code: "blur", score: 0.5 },
            { file: "/unrelated/x.ts", lines: [1, 1], code: "y", score: 0.1 },
            { nofile: true },
        ],
        summary: { count: 3 },
    });

    it("keeps rank order, relativizes, takes first code line", () => {
        const units = parseProbeJson(`Using BM25 ranking\n${doc}`, "/root");
        expect(units.map((u) => u.relFile)).toEqual(["src/focus.ts", "src/other.ts", "/unrelated/x.ts"]);
        expect(units[0]).toMatchObject({ line: 3, endLine: 5, text: "export function focus() {" });
    });

    it("returns empty on non-JSON output", () => {
        expect(parseProbeJson("no results at all", "/root")).toEqual([]);
    });

    it("renderProbeText joins file:line:text lines", () => {
        expect(
            renderProbeText([{ relFile: "a.ts", line: 2, endLine: 2, name: "", text: "hi" }]),
        ).toBe("a.ts:2:hi");
    });
});

describe("parseCodannaJson", () => {
    const doc = JSON.stringify({
        type: "result",
        status: "success",
        data: [
            {
                symbol: {
                    name: "focusTracker",
                    kind: "Function",
                    file_path: "src/focus.ts",
                    signature: "function focusTracker()",
                    range: { start_line: 0, end_line: 0 },
                },
                file_path: "src/focus.ts",
            },
            {
                symbol: {
                    name: "helper",
                    file_path: "src/util.ts",
                    range: { start_line: 9, end_line: 12 },
                },
                file_path: "src/util.ts",
            },
            { symbol: { name: "abs", file_path: "/abs/x.ts" } },
            { garbage: true },
        ],
    });

    it("converts 0-based lines to 1-based and keeps rank order", () => {
        const units = parseCodannaJson(doc);
        expect(units.map((u) => u.relFile)).toEqual(["src/focus.ts", "src/util.ts"]);
        expect(units[0]).toMatchObject({ line: 1, endLine: 1, name: "focusTracker", text: "function focusTracker()" });
        expect(units[1]).toMatchObject({ line: 10, endLine: 13 });
    });

    it("returns empty on non-JSON output", () => {
        expect(parseCodannaJson("Error: something broke")).toEqual([]);
    });

    it("parses the mcp search_symbols shape (1-based line) and not_found JSON", () => {
        const mcp = JSON.stringify({
            type: "result",
            status: "success",
            data: [
                {
                    symbol: {
                        name: "focusTracker",
                        kind: "Function",
                        file_path: "src/focus.ts",
                        line: 3,
                        signature: "function focusTracker()",
                    },
                    score: 5.2,
                },
            ],
        });
        const units = parseCodannaJson(mcp);
        expect(units).toHaveLength(1);
        expect(units[0]).toMatchObject({ relFile: "src/focus.ts", line: 3, endLine: 3 });
        const notFound = JSON.stringify({ type: "result", status: "not_found", data: null });
        expect(parseCodannaJson(notFound)).toEqual([]);
    });

    it("renderCodannaText joins file:line:signature lines", () => {
        expect(
            renderCodannaText([{ relFile: "a.ts", line: 1, endLine: 1, name: "f", text: "sig" }]),
        ).toBe("a.ts:1:sig");
    });
});

describe("isComparatorName", () => {
    it("accepts only known systems", () => {
        expect(isComparatorName("ripgrep")).toBe(true);
        expect(isComparatorName("probe")).toBe(true);
        expect(isComparatorName("codanna")).toBe(true);
        expect(isComparatorName("ours")).toBe(false);
        expect(isComparatorName("zoekt")).toBe(false);
    });

    it("system rg is available for the lexical floor", ({ skip }) => {
        if (!rgAvailable()) {
            skip("system rg not on PATH — lexical-floor availability unproven here, not a pass");
            return;
        }
        const v: Buffer = execFileSync("rg", ["--version"], { timeout: 15000 });
        expect(v.toString("utf8")).toMatch(/ripgrep/);
    });
});
