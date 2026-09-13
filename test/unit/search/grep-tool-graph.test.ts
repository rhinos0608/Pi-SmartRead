/**
 * Grep tool tests — graph filtering (split from grep-tool.test.ts, P3.1).
 *
 * Covers: graphFilter schema (WP-2), graphFilter wiring (WP-5),
 * graphFilter single-pass over-fetch.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { createGrepTool } from "../../src/grep-tool.js";
import { disposeSemanticIndexes } from "../../src/semantic-index-registry.js";
import { makeCtx, makeOpts, seedStandardWorkdir } from "../helpers/grep-tool-fixtures.js";
let workdir: string;

beforeEach(() => {
    workdir = realpathSync(mkdtempSync(join(tmpdir(), "grep-tool-")));
    seedStandardWorkdir(workdir);
});

afterEach(() => {
    disposeSemanticIndexes();
    rmSync(workdir, { recursive: true, force: true });
});
// ── WP-2: graphFilter schema ───────────────────────────────────────

describe("grep tool — graphFilter schema (WP-2)", () => {
    it("accepts valid graphFilter param in schema", () => {
        const tool = createGrepTool(makeOpts());
        const schema = tool.parameters as any;
        expect(schema.properties.graphFilter).toBeDefined();
        expect(schema.properties.graphFilter.type).toBe("string");
    });

    it("graphFilter is optional in schema", () => {
        const tool = createGrepTool(makeOpts());
        const schema = tool.parameters as any;
        // graphFilter should not be in required array
        const required: string[] = schema.required ?? [];
        expect(required).not.toContain("graphFilter");
    });

    it("graphFilter description mentions EDGE_TYPE->target format", () => {
        const tool = createGrepTool(makeOpts());
        const schema = tool.parameters as any;
        const desc = schema.properties.graphFilter.description;
        expect(desc).toContain("EDGE_TYPE->target");
        expect(desc).toContain("CALLS");
        expect(desc).toContain("IMPORTED_BY");
    });
});
// ── WP-5: graphFilter wiring ─────────────────────────────────────

describe("grep tool — graphFilter wiring (WP-5)", () => {
    test.for([
        { name: "graphFilter without contextGraph", params: { pattern: "authenticate", graphFilter: "CALLS->auth.login" } as any, error: "graphFilter requires an indexed context graph", withGraph: false },
        { name: "invalid graphFilter format", params: { pattern: "authenticate", graphFilter: "INVALID->target" } as any, error: 'Invalid graphFilter: expected "EDGE_TYPE->target" format', withGraph: true },
    ])("graphFilter errors — $name", async ({ params, error, withGraph }) => {
        // Invalid edge type "INVALID" should throw spec error
        const { ContextGraph } = await import("../../src/context-graph.js");
        const tool = withGraph
            ? createGrepTool(makeOpts({ contextGraph: new ContextGraph(workdir) }))
            : createGrepTool(makeOpts());
        await expect(
            tool.execute("t-gf-error", params, undefined, undefined, makeCtx(workdir)),
        ).rejects.toThrow(error);
    });

    it("contextGraph is accepted as a valid option", async () => {
        const { ContextGraph } = await import("../../src/context-graph.js");
        const graph = new ContextGraph(workdir);
        // Add a file that imports auth.ts so graphFilter has an edge to check
        writeFileSync(
            join(workdir, "src", "importer.ts"),
            [
                'import { authenticate } from "./auth";',
                "export function useAuth() {",
                "  return authenticate;",
                "}",
            ].join("\n"),
            "utf8",
        );
        // Build the context graph so import edges are populated for filtering
        await graph.buildContextGraph();
        const tool = createGrepTool(makeOpts({ contextGraph: graph }));
        expect(tool).toBeDefined();

        // Execute with graphFilter; only importer.ts imports auth.ts → survives filter
        const result = await tool.execute(
            "t-gf-exec",
            { pattern: "authenticate", literal: true, graphFilter: "IMPORTED_BY->src/auth.ts", limit: 10 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        const details = result.details as any;
        const resources = details.workspaceEvidence.resources;
        expect(resources).toHaveLength(1);
        expect(resources[0].canonicalPath).toContain("importer.ts");
    });

    it("awaits an async contextGraph getter before applying graphFilter (runtime wiring)", async () => {
        // Add a file that imports auth.ts so graphFilter has an edge to check
        writeFileSync(
            join(workdir, "src", "importer.ts"),
            [
                'import { authenticate } from "./auth";',
                "export function useAuth() {",
                "  return authenticate;",
                "}",
            ].join("\n"),
            "utf8",
        );
        let built = false;
        let getterRoot: string | undefined;
        // Simulate the runtime DI: an async getter that builds the shared graph
        // (with call graph) — the tool must await it before graphFilter.
        const { ContextGraph } = await import("../../src/context-graph.js");
        const tool = createGrepTool(makeOpts({
            contextGraph: async (root) => {
                getterRoot = root;
                const graph = new ContextGraph(workdir);
                await graph.buildContextGraph({ includeCalls: true });
                built = true;
                return graph;
            },
        }));

        const result = await tool.execute(
            "t-gf-async",
            { pattern: "authenticate", literal: true, graphFilter: "IMPORTED_BY->src/auth.ts", limit: 10 },
            undefined,
            undefined,
            makeCtx(workdir),
        );
        expect(built).toBe(true);
        expect(getterRoot).toBe(workdir);
        const details = result.details as any;
        const resources = details.workspaceEvidence.resources;
        expect(resources).toHaveLength(1);
        expect(resources[0].canonicalPath).toContain("importer.ts");
    });
});
// ── graphFilter single-pass over-fetch ──────────────────────────
// N3 regression: when graphFilter is present, the gather loop requests the
// maximum candidate set in a single pass instead of re-running the corpus
// search per gather step. Counts applyGraphFilter invocations (one per loop
// iteration) via ESM live binding to prove the loop does not re-evaluate.
describe("grep tool — graphFilter single-pass over-fetch", () => {
    it("fetches the maximum candidate set in one pass when filtering starves hits below topK", async () => {
        // Seed a modest corpus so the search has candidates to gather.
        for (let i = 0; i < 12; i++) {
            writeFileSync(
                join(workdir, "src", `file_${String(i).padStart(2, "0")}.ts`),
                `export const token${i} = ${i};
`,
                "utf8",
            );
        }

        const { ContextGraph } = await import("../../src/context-graph.js");
        const graphFilterModule = await import("../../src/graph-filter.js");
        const graph = new ContextGraph(workdir);

        // Force a filter that keeps no hits — the single-pass gather must still
        // evaluate the graph filter exactly once (no repeated corpus searches).
        const tool = createGrepTool(makeOpts({ contextGraph: graph }));
        const spy = vi.spyOn(graphFilterModule, "applyGraphFilter");

        await tool.execute(
            "t-overfetch",
            { pattern: "token", literal: true, graphFilter: "CALLS->nonexistent.symbol", limit: 100 },
            undefined,
            undefined,
            makeCtx(workdir),
        );

        // Exactly one filter pass: the gather loop requests the maximum
        // candidate set once instead of re-running the search per gather step.
        expect(spy.mock.calls.length).toBe(1);
        spy.mockRestore();
    });
});
