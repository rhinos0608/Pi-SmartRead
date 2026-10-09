import { describe, expect, it } from "vitest";
import {
    DEFAULT_INSPECT_BUDGET,
    admitInspectWork,
    validateInspectTaskCompatibility,
    type InspectTaskView,
    type InspectSectionRecord,
    type InspectStageRecord,
} from "../../../src/inspect/inspect-task-contract.js";

describe("inspect task contract", () => {
    it("accepts all supported view/mode combinations from the compatibility matrix", () => {
        const legal: Array<[InspectTaskView, "file" | "directory", boolean]> = [
            ["overview", "file", false], ["overview", "directory", false],
            ["dependencies", "file", false], ["architecture", "directory", false],
            ["change-review", "file", true], ["change-review", "directory", true],
            ["routes", "file", false], ["routes", "directory", false],
        ];
        for (const [view, mode, withDiff] of legal) {
            expect(() => validateInspectTaskCompatibility({ view, mode, hasAnalysis: false, diff: withDiff ? "HEAD" : undefined, targetIsDirectory: mode === "directory" })).not.toThrow();
        }
    });

    it("rejects incompatible selectors, modes, diff requirements, and target types", () => {
        const invalid = [
            { view: "overview" as const, mode: "file" as const, hasAnalysis: true, targetIsDirectory: false },
            { view: "overview" as const, mode: "script" as const, hasAnalysis: false, targetIsDirectory: false },
            { view: "dependencies" as const, mode: "directory" as const, hasAnalysis: false, targetIsDirectory: true },
            { view: "architecture" as const, mode: "file" as const, hasAnalysis: false, targetIsDirectory: false },
            { view: "change-review" as const, mode: "file" as const, hasAnalysis: false, targetIsDirectory: false },
            { view: "overview" as const, mode: "file" as const, hasAnalysis: false, targetIsDirectory: true },
            { view: "overview" as const, mode: "directory" as const, hasAnalysis: false, targetIsDirectory: false },
        ];
        for (const input of invalid) expect(() => validateInspectTaskCompatibility(input)).toThrow();
    });

    it("admits usage under provisional limits and refuses over-budget work", () => {
        expect(admitInspectWork({ ...DEFAULT_INSPECT_BUDGET, stages: 1, candidates: 1, scannedFiles: 1, scannedBytes: 1, corroborationFiles: 1, wallMs: 1, outputBytes: 1 })).toEqual({ admitted: true, reasons: [] });
        expect(admitInspectWork({ ...DEFAULT_INSPECT_BUDGET, scannedFiles: DEFAULT_INSPECT_BUDGET.scannedFiles + 1 })).toMatchObject({ admitted: false });
    });

    it("exposes stable per-section and stage record shapes", () => {
        const section: InspectSectionRecord = { scope: "/repo", relationKind: "imports", inspectedCount: 2, displayedCount: 1, omissions: [], unresolved: [], failures: [], truncationReason: "display-cap", coverage: "partial", citations: [{ path: "a.ts", range: { start: 1, end: 2 } }] };
        expect(section).toMatchObject({ scope: expect.any(String), coverage: "partial", citations: expect.any(Array) });
        const stage: InspectStageRecord = { name: "candidates", args: {}, derivation: "fixed recipe", status: "ok", observed: { files: 1, bytes: 2, wallMs: 3, outputBytes: 4 } };
        expect(stage).toMatchObject({ status: "ok", observed: { files: 1, bytes: 2, wallMs: 3, outputBytes: 4 } });
    });
});
