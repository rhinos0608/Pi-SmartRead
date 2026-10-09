import { describe, expect, it } from "vitest";
import {
    deriveProvisionalCaps,
    emptyCensusBuckets,
    errorSample,
    mapViewToFlags,
    recordCensusFile,
    TREE_SITTER_EXTENSIONS,
} from "../../../scripts/eval/inspect-affordance/microbench.js";

describe("inspect-affordance microbench helpers", () => {
    it("counts files/bytes per extension and supported syntax separately", () => {
        const buckets = emptyCensusBuckets();
        recordCensusFile(buckets, ".ts", 100);
        recordCensusFile(buckets, ".md", 50);
        expect(buckets.files).toBe(2);
        expect(buckets.bytes).toBe(150);
        expect(buckets.byExt[".ts"]).toEqual({ files: 1, bytes: 100 });
        expect(buckets.supportedFiles).toBe(1);
        expect(buckets.supportedBytes).toBe(100);
        expect(TREE_SITTER_EXTENSIONS.has(".d.ts" as never)).toBe(false);
    });

    it("maps each approved view to an explicit engine flag set", () => {
        expect(mapViewToFlags("overview", "file")).toEqual({});
        expect(mapViewToFlags("overview", "directory")).toEqual({ mapTokens: 1024 });
        expect(mapViewToFlags("dependencies", "file")).toEqual({ callDepth: 1, callDirection: "both" });
        expect(mapViewToFlags("architecture", "directory")).toEqual({ layers: true, boundaries: true });
        expect(mapViewToFlags("change-review", "file")).toEqual({ diff: "HEAD" });
        expect(mapViewToFlags("routes", "directory")).toEqual({ routes: true });
        expect(() => mapViewToFlags("dependencies", "directory")).toThrow();
        expect(() => mapViewToFlags("architecture", "file")).toThrow();
    });

    it("derives provisional caps from census maxima with no wall-time budget and no headroom fabrication", () => {
        const caps = deriveProvisionalCaps({ files: 9331, bytes: 51_530_838 });
        expect(caps.maxFilesPerScope).toBe(9331);
        expect(caps.maxBytesPerScope).toBe(51_530_838);
        expect(caps.basis).toContain("provisional");
        expect(caps.basis).toContain("no wall-time budget");
        expect("maxWallMsPerStage" in caps).toBe(false);
        const empty = deriveProvisionalCaps({ files: 0, bytes: 0 });
        expect(empty.maxFilesPerScope).toBe(1);
    });

    it("keeps failed/timed-out child samples visible with explicit status", () => {
        const failed = errorSample("error", "cold sample 0: exit 1");
        expect(failed.status).toBe("error");
        expect(failed.notes).toContain("cold sample 0");
        expect(failed.pid).toBe(-1);
        const timedOut = errorSample("timeout", "child exceeded 120000ms");
        expect(timedOut.status).toBe("timeout");
    });
});
