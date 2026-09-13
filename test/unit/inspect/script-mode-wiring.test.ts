/**
 * Script-mode wiring tests (inspect { script }) — schema + dispatch +
 * hardening/integration. The engine itself is tested under
 * test/unit/script-mode/; these tests lock the wiring layer only and use
 * real compute (temp fixture dirs, real fs writes), no compute mocks.
 */
import { describe, it, expect, beforeEach, afterEach, vi, expectTypeOf } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { createInspectV4Tool } from "../../../src/inspect/inspect-tool.js";
import { executeInspectV4 } from "../../../src/inspect/inspect.js";
import { computePathEvidence } from "../../../src/evidence/path-evidence.js";
import type { InspectV4Mode } from "../../../src/inspect/inspect-types.js";

let dir: string;
let sessionFile: string;
let previousAllowedRoot: string | undefined;

beforeEach(() => {
    previousAllowedRoot = process.env.PI_SMARTREAD_ALLOWED_ROOT;
    delete process.env.PI_SMARTREAD_ALLOWED_ROOT;
    dir = realpathSync(mkdtempSync(join(tmpdir(), "inspect-script-wiring-")));
    writeFileSync(join(dir, "f.ts"), "export const scriptWiringToken = 1;\n");
    sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "", { mode: 0o600 });
});

afterEach(() => {
    if (previousAllowedRoot === undefined) delete process.env.PI_SMARTREAD_ALLOWED_ROOT;
    else process.env.PI_SMARTREAD_ALLOWED_ROOT = previousAllowedRoot;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function makeTool(extraOpts: Record<string, unknown> = {}) {
    return createInspectV4Tool({
        getSessionFilePath: () => sessionFile,
        ...extraOpts,
    } as Parameters<typeof createInspectV4Tool>[0]);
}

function makeCtx(cwd: string = dir): any {
    return { cwd };
}

async function runScript(script: string, params: Record<string, unknown> = {}, tool?: any) {
    const t = tool ?? makeTool();
    return (await t.execute("c1", { script, ...params }, undefined, undefined, makeCtx())) as any;
}

describe("script schema", () => {
    it("exposes an optional script param with ADR-0002 WHEN/WHEN NOT/RETURNS/EXAMPLE description", () => {
        const tool = makeTool();
        const props = (tool.parameters as any).properties;
        expect(props.script).toBeDefined();
        const desc: string = props.script.description;
        expect(desc).toContain("WHEN:");
        expect(desc).toContain("WHEN NOT:");
        expect(desc).toContain("RETURNS:");
        expect(desc).toContain("EXAMPLE:");
        // Multi-hop dependent-call shape named; near-misses named.
        expect(desc).toContain("grep");
        expect(desc).toContain("read");
        expect(desc.length).toBeLessThanOrEqual(1500);
        for (const forbidden of ["MANDATORY", "BLOCKED", "PREFER ", "Do NOT use", "Never use", "✅", "❌"]) {
            expect(desc).not.toContain(forbidden);
        }
    });

    it("makes path optional (omitted anchors at cwd)", () => {
        const tool = makeTool();
        const schema = tool.parameters as any;
        const required: string[] = schema.required ?? [];
        expect(required).not.toContain("path");
        expect(schema.properties.path).toBeDefined();
    });

    it("leaves the InspectV4Mode union untouched", () => {
        expectTypeOf<InspectV4Mode>().toEqualTypeOf<"directory" | "file">();
    });
});

describe("script dispatch validation", () => {
    it("runs without path (anchors at cwd)", async () => {
        const result = await runScript(`const r = await read("f.ts"); return r.totalLines;`);
        expect(result.details.mode).toBe("query");
        expect(result.details.upstreamDetails.script.status).toBe("ok");
        expect(result.details.upstreamDetails.script.returnValue).toBeGreaterThan(0);
        expect(result.details.upstreamDetails.script.anchorPath).toBe(".");
    }, 20_000);

    it("runs with path (anchor recorded, same results)", async () => {
        const result = await runScript(`const r = await read("f.ts"); return r.totalLines;`, { path: "." });
        expect(result.details.mode).toBe("query");
        expect(result.details.upstreamDetails.script.status).toBe("ok");
        expect(result.details.upstreamDetails.script.returnValue).toBeGreaterThan(0);
        expect(result.details.upstreamDetails.script.anchorPath).toBe(".");
    }, 20_000);

    it("rejects every mode-specific param combined with script", async () => {
        const tool = makeTool();
        const ctx = makeCtx();
        const cases: Record<string, unknown> = {
            signals: ["complexity"],
            mapTokens: 100,
            focus: ["f.ts"],
            compact: true,
            callDepth: 2,
            callDirection: "callers",
            deadCode: true,
            impact: true,
            diff: "HEAD",
            clusters: true,
            graphSchema: true,
            hotspots: true,
            boundaries: true,
            routes: true,
            layers: true,
            navigation: { operation: "documentSymbols" },
            diagnostics: { waitMs: 10 },
        };
        for (const [key, value] of Object.entries(cases)) {
            await expect(
                tool.execute("x", { script: "return 1;", [key]: value }, undefined, undefined, ctx),
            ).rejects.toThrow(`Error: inspect param "${key}"`);
        }
    }, 30_000);

    it("legacy params + script still hit migration errors first", async () => {
        const tool = makeTool();
        const ctx = makeCtx();
        await expect(
            tool.execute("x", { script: "return 1;", query: "old" } as any, undefined, undefined, ctx),
        ).rejects.toThrow(/grep/);
        await expect(
            tool.execute("x", { script: "return 1;", symbol: "old" } as any, undefined, undefined, ctx),
        ).rejects.toThrow(/symbol/i);
        await expect(
            tool.execute("x", { script: "return 1;", action: "map" } as any, undefined, undefined, ctx),
        ).rejects.toThrow(/action/);
    });

    it("rejects empty script and missing path without script", async () => {
        const tool = makeTool();
        const ctx = makeCtx();
        await expect(
            tool.execute("x", { script: "" }, undefined, undefined, ctx),
        ).rejects.toThrow('Error: inspect param "script"');
        await expect(
            tool.execute("x", {} as any, undefined, undefined, ctx),
        ).rejects.toThrow('Error: inspect param "path" is required without script');
    });

    it("script never reaches stat dispatch (nonexistent anchor still runs)", async () => {
        const result = await runScript(`return 42;`, { path: "does-not-exist-xyz.ts" });
        expect(result.details.mode).toBe("query");
        expect(result.details.upstreamDetails.script.status).toBe("ok");
        expect(result.details.upstreamDetails.script.returnValue).toBe(42);
        // Same guarantee at the executeInspectV4 layer, with runtime query mode.
        const direct = await executeInspectV4({
            path: "does-not-exist-xyz.ts",
            cwd: dir,
            sessionFilePath: sessionFile,
            script: "return 7;",
        });
        expect((direct as any).mode).toBe("query");
        expect(((direct.upstreamDetails ?? {}) as any).script.returnValue).toBe(7);
    }, 20_000);
});

describe("script end-to-end (real compute)", () => {
    it("grep→read same file merges both distinct resourceIds in query mode", async () => {
        const result = await runScript(
            `const g = await grep("scriptWiringToken", { path: "f.ts", literal: true, limit: 5 }); const r = await read("f.ts"); return { hits: g.totalHits, lines: r.totalLines };`,
        );
        const details = result.details;
        expect(details.mode).toBe("query");
        expect(details.upstreamDetails.script.status).toBe("ok");
        expect(details.upstreamDetails.script.returnValue).toMatchObject({ lines: expect.any(Number) });
        expect(details.upstreamDetails.script.returnValue.hits).toBeGreaterThan(0);
        const evidence = details.workspaceEvidence;
        expect(evidence.mode).toBe("query");
        expect(evidence.resources.length).toBeGreaterThanOrEqual(2);
        const ids = evidence.resources.map((r: any) => r.resourceId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
        // Full-file read and search-match hit coexist as distinct resources.
        expect(evidence.resources.some((r: any) => r.fullFileSha256)).toBe(true);
        expect(evidence.resources.some((r: any) => r.kind === "range")).toBe(true);
        expect(validateInspectionEnvelope(evidence).ok).toBe(true);
        // Content text renders return value + call-log summary.
        const text = result.content[0].text as string;
        expect(text).toContain("hits");
        expect(text).toContain("Calls (2):");
    }, 30_000);

    it("failed later call contributes no resources but stays in the call log", async () => {
        const result = await runScript(
            `const r = await read("f.ts"); let failed = false; try { await read("nope-missing-xyz.ts"); } catch (e) { failed = true; } return { lines: r.totalLines, failed };`,
        );
        expect(result.details.upstreamDetails.script.status).toBe("ok");
        expect(result.details.upstreamDetails.script.returnValue).toMatchObject({ failed: true });
        const log = result.details.upstreamDetails.script.callLog;
        expect(log.map((e: any) => e.status)).toEqual(["ok", "error"]);
        for (const r of result.details.workspaceEvidence.resources) {
            expect(r.canonicalPath).not.toContain("nope-missing-xyz");
        }
    }, 20_000);

    it("stale-SHA last-wins through the full script path (real fs writes)", async () => {
        // Direct executeScriptMode call per contract ("through the full
        // executeScriptMode path"), with a generous budget so full-suite
        // contention slows the run instead of degrading it. The gap between
        // the reads is a real grep scan: guest-side busy-waiting cannot work
        // (the interpreter blocks the Node loop while spinning, so an
        // external timer would fire only after both reads), while host-side
        // async fs I/O yields macrotask turns and lets the timer land mid-run
        // (probed: a mid-grep timer fires on schedule).
        const { executeScriptMode } = await import("../../../src/script-mode/index.js");
        await executeScriptMode({ script: `return 1;`, cwd: dir, sessionFilePath: sessionFile });
        const f = join(dir, "f.ts");
        writeFileSync(f, "v1\n");
        for (let i = 0; i < 250; i++) {
            writeFileSync(join(dir, `bulk-${i}.ts`), `export const bulk${i} = ${i};\n`);
        }
        // +1000ms: wide enough that read1 (ms-scale, engine already warm)
        // lands before it even under full-suite contention, narrow enough
        // that the multi-second grep scan still follows it (solo ~3s, longer
        // loaded). Either side failing fails loudly via the markers below.
        const timer = setTimeout(() => writeFileSync(f, "v2\n"), 1000);
        try {
            const result = await executeScriptMode({
                script: `const a = await read("f.ts"); await grep("scriptWiringToken", { literal: true, limit: 50 }); const b = await read("f.ts"); return { a: a.contentText, b: b.contentText };`,
                cwd: dir,
                sessionFilePath: sessionFile,
                budget: { deadlineMs: 30_000 },
            });
            // Status first: a degraded run has no returnValue, so asserting
            // markers directly would TypeError instead of showing errorKind.
            expect(result.status).toBe("ok");
            const rv = result.returnValue as { a: string; b: string };
            // The mutation provably landed between the two reads (contentText
            // is line-numbered, so match on the version markers).
            expect(rv.a).toContain("v1");
            expect(rv.a).not.toContain("v2");
            expect(rv.b).toContain("v2");
            // Two full-file reads share one resourceId: last-wins leaves a
            // single full-file entry carrying the later observation.
            const evidence = result.workspaceEvidence!;
            const full = evidence.resources.filter((r: any) => r.fullFileSha256 !== undefined);
            expect(full).toHaveLength(1);
            const fresh = computePathEvidence({ path: "f.ts", cwd: dir, sessionFilePath: sessionFile });
            expect(full[0]!.fullFileSha256).toBe(fresh.workspaceEvidence.resources[0]!.fullFileSha256);
            expect(validateInspectionEnvelope(evidence).ok).toBe(true);
        } finally {
            clearTimeout(timer);
        }
    }, 40_000);

    it("oversized host result degrades (quota-exceeded) instead of throwing", async () => {
        writeFileSync(join(dir, "big.txt"), "x".repeat(300_000));
        const result = await runScript(`return await read("big.txt");`);
        // Outer tool call resolves — never throws.
        expect(result.details.mode).toBe("query");
        const script = result.details.upstreamDetails.script;
        expect(script.status).toBe("degraded");
        expect(script.callLog).toHaveLength(1);
        expect(script.callLog[0]).toMatchObject({ op: "read", status: "quota-exceeded" });
        expect(result.details.workspaceEvidence.mode).toBe("query");
        expect(result.details.workspaceEvidence.resources).toEqual([]);
    }, 20_000);

    it("infinite loop returns degraded within deadline", async () => {
        const t0 = Date.now();
        const result = await runScript(`while (true) {}`);
        const elapsed = Date.now() - t0;
        expect(result.details.upstreamDetails.script.status).toBe("degraded");
        expect(["interrupted", "timeout", "aborted"]).toContain(
            result.details.upstreamDetails.script.errorKind,
        );
        expect(elapsed).toBeLessThan(15_000);
    }, 25_000);

    it("Promise.all fan-out past the cap admits no more than the cap", async () => {
        const result = await runScript(
            `const ps = []; for (let i = 0; i < 100; i++) { ps.push(read("f.ts")); } const rs = await Promise.all(ps); return rs.length;`,
        );
        const script = result.details.upstreamDetails.script;
        expect(script.status).toBe("degraded");
        expect(script.callLog).toHaveLength(100);
        const ok = script.callLog.filter((e: any) => e.status === "ok").length;
        const quota = script.callLog.filter((e: any) => e.status === "quota-exceeded").length;
        expect(ok).toBeLessThanOrEqual(50);
        expect(quota).toBeGreaterThan(0);
    }, 20_000);
});

describe("script evidence visibility", () => {
    it("call log carries op + path/resource identity per call", async () => {
        writeFileSync(join(dir, "v.ts"), "export const scriptWiringVisToken = 1;\n");
        const result = await runScript(
            `const g = await grep("scriptWiringVisToken", { path: "v.ts", literal: true, limit: 5 }); const r = await read("v.ts"); return { hits: g.totalHits, lines: r.totalLines };`,
        );
        const log = result.details.upstreamDetails.script.callLog;
        expect(log).toHaveLength(2);
        expect(log[0]).toMatchObject({ op: "grep", status: "ok" });
        expect(log[1]).toMatchObject({ op: "read", status: "ok" });
        for (const entry of log) {
            expect(typeof entry.argsSummary).toBe("string");
            expect(typeof entry.elapsedMs).toBe("number");
            expect(entry.canonicalPathOrResourceId).toContain("v.ts");
        }
    }, 30_000);

    it("publishes the merged envelope exactly once per outer tool call", async () => {
        const publish = vi.fn();
        const tool = makeTool({ resolver: { publishInspection: publish } });
        await tool.execute("c1", { script: `const r = await read("f.ts"); return r.totalLines;` }, undefined, undefined, makeCtx());
        expect(publish).toHaveBeenCalledTimes(1);
        const [envelope, session, root] = publish.mock.calls[0]!;
        expect((envelope as any).mode).toBe("query");
        expect(session).toBe(sessionFile);
        expect(typeof root).toBe("string");
        // A degraded run with zero successful calls still publishes exactly
        // once (empty query envelope), never zero times, never twice.
        publish.mockClear();
        await tool.execute("c2", { script: `return await read("nope-missing-xyz.ts");` }, undefined, undefined, makeCtx());
        expect(publish).toHaveBeenCalledTimes(1);
        expect((publish.mock.calls[0]![0] as any).mode).toBe("query");
        expect((publish.mock.calls[0]![0] as any).resources).toEqual([]);
    }, 30_000);
});

describe("script cross-root behavior", () => {
    it("script read outside cwd works like a direct read (no boundary gating)", async () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), "inspect-script-xroot-")));
        try {
            const allowed = join(root, "allowed");
            const outside = join(root, "outside");
            const { mkdirSync } = await import("node:fs");
            mkdirSync(allowed, { recursive: true });
            mkdirSync(outside, { recursive: true });
            writeFileSync(join(root, "package.json"), "{}\n");
            writeFileSync(join(outside, "outside.ts"), "export function xrootSharedSymbol() { return 1; }\n");
            const session = join(root, "session.jsonl");
            writeFileSync(session, "", { mode: 0o600 });
            process.env.PI_SMARTREAD_ALLOWED_ROOT = allowed;

            const tool = createInspectV4Tool({ getSessionFilePath: () => session } as any);
            const ctx = { cwd: root } as any;
            const result = (await tool.execute(
                "cx",
                { script: `const r = await read("outside/outside.ts"); return r.contentText;` },
                undefined,
                undefined,
                ctx,
            )) as any;
            expect(result.details.upstreamDetails.script.status).toBe("ok");
            expect(result.details.upstreamDetails.script.returnValue).toContain("xrootSharedSymbol");
            const direct = computePathEvidence({ path: "outside/outside.ts", cwd: root, sessionFilePath: session });
            expect(result.details.upstreamDetails.script.returnValue).toBe(direct.contentText);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }, 20_000);
});
