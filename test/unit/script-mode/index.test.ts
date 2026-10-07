import { describe, it, expect } from "vitest";
import { executeScriptMode } from "../../../src/script-mode/index.js";

const cwd = process.cwd();
const sessionFilePath = "/tmp/fake-script-mode-session.jsonl";

describe("executeScriptMode", () => {
    it("runs a read+grep script and merges query-mode evidence", async () => {
        const result = await executeScriptMode({
            script: `const r = await read("package.json", { limit: 2 }); const g = await grep("typecheck", { path: "package.json", literal: true, limit: 3 }); return { lines: r.totalLines, hits: g.totalHits };`,
            cwd,
            sessionFilePath,
            budget: { deadlineMs: 20_000 },
        });
        expect(result.status).toBe("ok");
        expect(result.returnValue).toMatchObject({ lines: expect.any(Number), hits: expect.any(Number) });
        expect(result.callLog).toHaveLength(2);
        expect(result.callLog.map((e) => e.status)).toEqual(["ok", "ok"]);
        expect(result.workspaceEvidence).not.toBeNull();
        expect(result.workspaceEvidence!.mode).toBe("query");
        // read (full-file) + grep (search-match) resources coexist.
        expect(result.workspaceEvidence!.resources.length).toBeGreaterThanOrEqual(2);
        expect(result.truncated).toBe(false);
        expect(result.byteLength).toBeGreaterThan(0);
    });

    it("returns degraded with partial log/evidence on script throw", async () => {
        const result = await executeScriptMode({
            script: `const r = await read("package.json", { limit: 1 }); throw new Error("boom"); return r;`,
            cwd,
            sessionFilePath,
            budget: { deadlineMs: 20_000 },
        });
        expect(result.status).toBe("degraded");
        expect(result.errorKind).toBe("js-exception");
        expect(result.errorMessage).toContain("boom");
        expect(result.callLog).toHaveLength(1);
        expect(result.workspaceEvidence).not.toBeNull();
    });

    it("failed calls appear in the log but contribute no evidence", async () => {
        const result = await executeScriptMode({
            script: `try { await read("does-not-exist-12345.ts"); } catch (e) { return "caught"; }`,
            cwd,
            sessionFilePath,
            budget: { deadlineMs: 20_000 },
        });
        expect(result.status).toBe("ok");
        expect(result.returnValue).toBe("caught");
        expect(result.callLog).toHaveLength(1);
        expect(result.callLog[0]!.status).toBe("error");
        expect(result.workspaceEvidence).toBeNull();
    });

    it("mixed outcomes: success resources merge, failure contributes none, both logged", async () => {
        const result = await executeScriptMode({
            script: `const r = await read("package.json", { limit: 2 }); let failed = false; try { await read("does-not-exist-12345.ts"); } catch (e) { failed = true; } return { lines: r.totalLines, failed };`,
            cwd,
            sessionFilePath,
            budget: { deadlineMs: 20_000 },
        });
        expect(result.status).toBe("ok");
        expect(result.returnValue).toMatchObject({ lines: expect.any(Number), failed: true });
        expect(result.callLog).toHaveLength(2);
        expect(result.callLog.map((e) => e.status)).toEqual(["ok", "error"]);
        expect(result.callLog[0]).toMatchObject({ op: "read" });
        expect(result.callLog[1]).toMatchObject({ op: "read" });
        // Success's resources present; failure contributed nothing.
        expect(result.workspaceEvidence).not.toBeNull();
        expect(result.workspaceEvidence!.resources.length).toBeGreaterThanOrEqual(1);
        for (const r of result.workspaceEvidence!.resources) {
            expect(r.canonicalPath).not.toContain("does-not-exist-12345");
        }
    });

    it("truncates oversized return values and flags", async () => {
        const result = await executeScriptMode({
            script: `const r = await read("package.json", {}); return r.contentText + r.contentText;`,
            cwd,
            sessionFilePath,
            budget: { deadlineMs: 20_000, maxReturnBytes: 50 },
        });
        expect(result.status).toBe("ok");
        expect(result.truncated).toBe(true);
        expect(result.returnValue).toMatchObject({ __truncated: true });
    });
});
