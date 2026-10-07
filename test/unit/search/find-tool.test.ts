/**
 * End-to-end find tool tests on tmp fixtures: schema identity with the
 * pi builtin, directory grouping, details shape, discovery-only
 * evidence, and "/" rejection.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_SCHEMA_VERSION } from "@rhinos0608/pi-workspace-protocol";
import { createFindTool, FIND_DESCRIPTION } from "../../../src/search/find-tool.js";

let workdir: string;

function write(rel: string, content = "export const x = 1;\n"): void {
    const abs = join(workdir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
}

function ctx() {
    return {
        cwd: workdir,
        sessionManager: { getSessionFile: () => "/sessions/find-test.jsonl" },
    } as any;
}

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "find-tool-")));
    write("src/auth.ts");
    write("src/db.ts");
    write("src/nested/deep.ts");
});

afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
});

describe("find tool schema", () => {
    it("keeps the builtin parameter shape {pattern, path?, limit?}", () => {
        const tool = createFindTool();
        expect(tool.name).toBe("find");
        const schema = tool.parameters as any;
        expect(schema.type).toBe("object");
        expect(Object.keys(schema.properties).sort()).toEqual(["limit", "path", "pattern"]);
        expect(schema.properties.pattern.type).toBe("string");
    });

    it("describes file/dir finding and defers line search to grep", () => {
        expect(FIND_DESCRIPTION).toMatch(/director/i);
        expect(FIND_DESCRIPTION).toMatch(/grep/);
    });
});

describe("find tool execution", () => {
    it("groups glob matches by directory", async () => {
        const tool = createFindTool();
        const result: any = await tool.execute("f-1", { pattern: "src/*.ts" }, undefined, undefined, ctx());
        const text = result.content[0].text as string;
        expect(text).toContain("# src/");
        expect(text).toContain("  auth.ts");
        expect(text).not.toContain("deep.ts");
        expect(result.details.mode).toBe("glob");
        expect(result.details.root).toBe(workdir);
        expect(result.details.truncated).toBe(false);
    });

    it("finds nested files with ** and fuzzy fragments without dots", async () => {
        const tool = createFindTool();
        const globbed: any = await tool.execute("f-2", { pattern: "src/**/*.ts" }, undefined, undefined, ctx());
        expect((globbed.content[0].text as string)).toContain("deep.ts");
        const fuzzy: any = await tool.execute("f-3", { pattern: "deep" }, undefined, undefined, ctx());
        expect(fuzzy.details.mode).toBe("fuzzy");
        expect((fuzzy.content[0].text as string)).toContain("deep.ts");
    });

    it("routes descriptions to natural language with unjudged scores", async () => {
        const tool = createFindTool();
        const result: any = await tool.execute(
            "f-4",
            { pattern: "files that handle authentication state" },
            undefined,
            undefined,
            ctx(),
        );
        expect(result.details.mode).toBe("natural-language");
        expect(result.content[0].text).toContain("ranked (unjudged)");
    });

    it("rejects path /", async () => {
        const tool = createFindTool();
        await expect(tool.execute("f-5", { pattern: "*.ts", path: "/" }, undefined, undefined, ctx()))
            .rejects.toThrow('path "/" is rejected');
    });

    it("rejects paths that normalize to the filesystem root", async () => {
        const tool = createFindTool();
        for (const path of ["/.", "/tmp/.."]) {
            await expect(tool.execute("f-root", { pattern: "*.ts", path }, undefined, undefined, ctx()))
                .rejects.toThrow('path "/" is rejected');
        }
    });

    it("rejects missing paths like the builtin", async () => {
        const tool = createFindTool();
        await expect(tool.execute("f-6", { pattern: "*.ts", path: "nope" }, undefined, undefined, ctx()))
            .rejects.toThrow("Path not found");
    });

    it("truncates to limit with steering", async () => {
        const tool = createFindTool();
        const result: any = await tool.execute("f-7", { pattern: "*.ts", limit: 1 }, undefined, undefined, ctx());
        expect(result.details.total).toBe(3);
        expect(result.details.shown).toBe(1);
        expect(result.details.truncated).toBe(true);
        expect(result.content[0].text).toContain("(showing 1 of 3 — narrow the pattern or set path)");
    });

    it("emits discovery-only evidence (no line ranges, no patch authority)", async () => {
        const tool = createFindTool();
        const result: any = await tool.execute("f-8", { pattern: "*.ts" }, undefined, undefined, ctx());
        const envelope = result.details.workspaceEvidence;
        expect(envelope.schemaVersion).toBe(PROTOCOL_SCHEMA_VERSION);
        expect(envelope.resources).toEqual([]);
        expect(result.details.entries.length).toBeGreaterThan(0);
        for (const entry of result.details.entries) {
            expect(["file", "directory"]).toContain(entry.type);
            expect(entry).not.toHaveProperty("allowedRanges");
        }
    });

    it("publishes evidence best-effort when a resolver is wired", async () => {
        const published: unknown[] = [];
        const tool = createFindTool({
            resolver: {
                publishInspection: (envelope) => { published.push(envelope); },
            },
            getSessionFilePath: () => "/sessions/find-test.jsonl",
        });
        await tool.execute("f-9", { pattern: "*.ts" }, undefined, undefined, ctx());
        expect(published.length).toBe(1);
    });
});
