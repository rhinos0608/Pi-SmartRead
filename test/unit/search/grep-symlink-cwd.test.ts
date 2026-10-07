/** Symlinked-cwd regression: relFile display paths must stay workspace-relative. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../../../src/search/grep-tool.js";
import type { GrepHit } from "../../../src/search/grep-cascade.js";
import { disposeSemanticIndexes } from "../../../src/indexing/semantic-index-registry.js";
import { makeCtx, makeOpts } from "../../helpers/grep-tool-fixtures.js";

let realDir = "";
let linkDir = "";

beforeEach(() => {
    realDir = realpathSync(mkdtempSync(join(tmpdir(), "grep-symlink-real-")));
    mkdirSync(join(realDir, "src"), { recursive: true });
    writeFileSync(
        join(realDir, "src", "marker.ts"),
        `export function symlinkMarkerToken(): string {\n  return "symlinkMarkerToken";\n}\n`,
    );
    linkDir = `${realDir}-link`;
    try { rmSync(linkDir, { recursive: true, force: true }); } catch { /* ignore */ }
    symlinkSync(realDir, linkDir, "dir");
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(linkDir, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
});

async function runQuery(params: Record<string, unknown>): Promise<{ text: string; shown: GrepHit[]; evidence: any }> {
    let shown: GrepHit[] = [];
    const tool = createGrepTool(makeOpts({
        onTraceGrepQuery: (e) => { if (e.stage === "post-judge") shown = e.shown as GrepHit[]; },
    }));
    const result = await tool.execute("symlink-cwd", params as any, undefined, undefined, makeCtx(linkDir));
    const text = (result.content[0] as { text: string }).text;
    const evidence = (result.details as any).workspaceEvidence;
    return { text, shown, evidence };
}

function expectCleanRelFiles(label: string, shown: GrepHit[], text: string): void {
    expect(shown.length, `${label}: expected hits`).toBeGreaterThan(0);
    for (const hit of shown) {
        expect(hit.relFile, `${label}: relFile`).not.toMatch(/\.\./);
        expect(hit.relFile, `${label}: relFile`).toMatch(/^src\//);
    }
    expect(text, `${label}: rendered text`).not.toMatch(/\.\.\//);
    expect(text, `${label}: rendered text`).toContain("src/marker.ts");
}

describe("grep symlinked cwd", () => {
    it("literal query uses workspace-relative display paths", async () => {
        const { text, shown, evidence } = await runQuery({ pattern: "symlinkMarkerToken", literal: true });
        expectCleanRelFiles("literal", shown, text);
        for (const r of evidence.resources) {
            expect(r.canonicalPath).toBe(realpathSync(r.canonicalPath));
        }
    });

    it("natural-language/BM25 query uses workspace-relative display paths", async () => {
        const { text, shown } = await runQuery({ pattern: "symlink marker token" });
        expectCleanRelFiles("bm25", shown, text);
    });

    it("symbol query uses workspace-relative display paths", async () => {
        const { text, shown } = await runQuery({ pattern: "symlinkMarkerToken" });
        expectCleanRelFiles("symbol", shown, text);
    });
});
