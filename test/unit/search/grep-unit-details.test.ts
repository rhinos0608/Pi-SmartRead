/** Grep details carry the active unit mode + M/E (additive; anchor render unchanged). */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../../../src/search/grep-tool.js";
import { makeCtx, makeOpts } from "../../helpers/grep-tool-fixtures.js";

const MODE_VAR = "PI_SMARTREAD_GREP_UNIT_MODE";
const MAX_VAR = "PI_SMARTREAD_GREP_UNIT_MAX_PER_FILE";
const EXCERPT_VAR = "PI_SMARTREAD_GREP_UNIT_EXCERPT_LINES";

let workdir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-unit-details-")));
    writeFileSync(
        join(workdir, "a.ts"),
        "// retry backoff policy for failed requests\nexport function retryFailedRequests(url: string) {\n  return executeWithBackoff(url);\n}\n",
        "utf8",
    );
    saved = {
        [MODE_VAR]: process.env[MODE_VAR],
        [MAX_VAR]: process.env[MAX_VAR],
        [EXCERPT_VAR]: process.env[EXCERPT_VAR],
    };
});

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    rmSync(workdir, { recursive: true, force: true });
});

describe("grep details unit plumbing", () => {
    it("reports anchor mode with defaults on a single query", async () => {
        delete process.env[MODE_VAR];
        delete process.env[MAX_VAR];
        delete process.env[EXCERPT_VAR];
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute("t1", { pattern: "retry backoff policy" }, undefined, undefined, makeCtx(workdir));
        const details = result.details as any;
        expect(details.unitMode).toBe("anchor");
        expect(details.unitMaxPerFile).toBe(2);
        expect(details.unitExcerptLines).toBe(12);
    });

    it("reports symbol mode with custom M/E on single and batch queries", async () => {
        process.env[MODE_VAR] = "symbol";
        process.env[MAX_VAR] = "3";
        process.env[EXCERPT_VAR] = "8";
        const tool = createGrepTool(makeOpts());
        const single = await tool.execute("t2", { pattern: "retry backoff" }, undefined, undefined, makeCtx(workdir));
        const singleDetails = single.details as any;
        expect(singleDetails.unitMode).toBe("symbol");
        expect(singleDetails.unitMaxPerFile).toBe(3);
        expect(singleDetails.unitExcerptLines).toBe(8);

        const batch = await tool.execute(
            "t3",
            { queries: [{ pattern: "retry backoff" }, { pattern: "executeWithBackoff" }] },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const batchDetails = batch.details as any;
        expect(batchDetails.unitMode).toBe("symbol");
        expect(batchDetails.unitMaxPerFile).toBe(3);
        expect(batchDetails.unitExcerptLines).toBe(8);
        for (const qr of batchDetails.queryResults) {
            expect(qr.unitMode).toBe("symbol");
            expect(qr.unitMaxPerFile).toBe(3);
            expect(qr.unitExcerptLines).toBe(8);
        }
    });

    it("anchor-mode rendered text is unchanged by details plumbing", async () => {
        delete process.env[MODE_VAR];
        const tool = createGrepTool(makeOpts());
        const result = await tool.execute("t4", { pattern: "retry backoff policy" }, undefined, undefined, makeCtx(workdir));
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("retry backoff policy");
    });
});
