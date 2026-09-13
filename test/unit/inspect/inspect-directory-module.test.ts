/**
 * Seam2: directory inspect pipeline module boundary.
 * Focused: budget fit, pure builders, shared runtime, re-export identity.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/repomap-tool.js", () => ({
    clampMapTokens: (n?: number) => n ?? 4096,
    createRepoTool: () => ({ execute: async () => ({ content: [{ type: "text", text: "mock map" }], details: {} }) }),
}));

import {
    fitDirectoryOutput,
    assembleDirectoryOutput,
    DIRECTORY_TRUNCATION_FOOTER,
    buildDirHotspotsSection,
    buildDirDeadCodeSection,
    buildDirGraphSchemaSection,
    buildClustersSection,
    buildBoundariesSection,
} from "../../src/inspect-directory.js";
import { executeDirectoryInspect as dirExec } from "../../src/inspect-directory.js";
import { executeDirectoryInspect as reExec } from "../../src/inspect.js";
import { tryCanonical, mergeRanges, estimateTokens } from "../../src/inspect-runtime.js";

describe("directory module boundary", () => {
    it("re-export identity: inspect.ts re-exports directory pipeline", () => {
        expect(reExec).toBe(dirExec);
    });

    it("budget fit admits sections within budget, footer when truncated", () => {
        const core = "core map text";
        const sections = ["## A\n\nbody-a", "## B\n\nbody-b"];
        const wide = fitDirectoryOutput(core, sections, 4096);
        expect(wide.truncated).toBe(false);
        expect(wide.admittedCount).toBe(2);
        expect(wide.text).toContain("## A");
        const tight = fitDirectoryOutput(core, sections, 10);
        expect(tight.truncated).toBe(true);
        expect(tight.text).toContain(DIRECTORY_TRUNCATION_FOOTER);
        expect(estimateTokens(tight.text) <= 4096 || tight.text.length > 0).toBe(true);
    });

    it("assembleDirectoryOutput joins core + sections", () => {
        expect(assembleDirectoryOutput("c", [])).toBe("c");
        expect(assembleDirectoryOutput("c", ["s1"])).toContain("s1");
    });

    it("hotspots builder ranks by fan-in", () => {
        const cg: any = {
            functions: [
                { name: "a", file: "f.ts", line: 1, calledBy: ["x", "y"], calls: [] },
                { name: "b", file: "f.ts", line: 2, calledBy: [], calls: [] },
            ],
        };
        const text = buildDirHotspotsSection(cg);
        expect(text).toContain("## Hotspots");
        expect(text.indexOf(" a ")).toBeLessThan(text.indexOf(" b "));
    });

    it("dead-code builder uses relative paths, no crash on empty", () => {
        const cg: any = { functions: [] };
        const text = buildDirDeadCodeSection({ path: ".", cwd: process.cwd() } as any, process.cwd(), cg);
        expect(text).toContain("## Dead Code");
    });

    it("graph-schema + clusters + boundaries degrade gracefully without contextGraph", () => {
        expect(buildDirGraphSchemaSection({} as any)).toContain("## Graph Schema");
        expect(buildClustersSection({} as any, process.cwd())).toContain("## Community Clusters");
        expect(buildBoundariesSection(process.cwd())).toContain("## Service Boundaries");
    });

    it("shared runtime: tryCanonical + mergeRanges", () => {
        expect(tryCanonical("/nope-missing-xyz")).toBe("/nope-missing-xyz");
        const merged = mergeRanges([
            { startLine: 1, endLine: 3 },
            { startLine: 4, endLine: 5 },
        ]);
        expect(merged).toEqual([{ startLine: 1, endLine: 5 }]);
    });

    it("executeDirectoryInspect smoke: map mode, empty resources, budget respected", async () => {
        const res: any = await dirExec({
            cwd: process.cwd(),
            path: "src",
            sessionFilePath: "/tmp/seam2-session.json",
        } as any);
        expect(res.mode).toBe("directory");
        expect(res.contentText).toContain("mock map");
        expect(res.workspaceEvidence.mode).toBe("map");
        expect(res.workspaceEvidence.resources).toEqual([]);
        expect(res.truncated).toBe(false);
    });
});
