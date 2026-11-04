/**
 * Unit tests for comparator runner CLI parsing (harness only, E9 gap fix).
 *
 * Covers the frozen --manifest mode: comparators must run on exactly the
 * same frozen dev queries as SmartRead, with the same license gate and
 * holdout guard as the ours runner. Pure arg parsing only — no dataset
 * content, no network, no binaries.
 */
import { describe, expect, it } from "vitest";
import { parseComparatorArgs } from "../../../scripts/eval/external/grep/comparators/args.js";

const LICENSE = ["--accept-license-review"];

describe("parseComparatorArgs", () => {
    it("parses --system with provisional defaults (pilot, both formulations)", () => {
        const args = parseComparatorArgs(["--system", "ripgrep"]);
        expect(args.system).toBe("ripgrep");
        expect(args.split).toBe("pilot");
        expect(args.formulations).toEqual(["title", "body"]);
        expect(args.manifestPath).toBeNull();
        expect(args.openHoldout).toBe(false);
    });

    it("parses frozen --manifest mode with --split dev", () => {
        const args = parseComparatorArgs([
            "--system",
            "probe",
            "--manifest",
            "/tmp/dev64.json",
            "--split",
            "dev",
            ...LICENSE,
        ]);
        expect(args.manifestPath).toBe("/tmp/dev64.json");
        expect(args.split).toBe("dev");
    });

    it("parses --open-holdout for an explicit holdout run", () => {
        const args = parseComparatorArgs([
            "--system",
            "codanna",
            "--manifest",
            "/tmp/dev64.json",
            "--split",
            "holdout",
            "--open-holdout",
            ...LICENSE,
        ]);
        expect(args.openHoldout).toBe(true);
    });

    it("requires --system", () => {
        expect(() => parseComparatorArgs(["--split", "dev"])).toThrow(/--system is required/);
    });

    it("rejects unknown systems", () => {
        expect(() => parseComparatorArgs(["--system", "zoekt"])).toThrow(/--system must be/);
    });

    it("rejects --split holdout without --manifest", () => {
        expect(() => parseComparatorArgs(["--system", "ripgrep", "--split", "holdout"])).toThrow(
            /--split holdout requires --manifest/,
        );
    });

    it("rejects non-dev|holdout splits with --manifest", () => {
        expect(() =>
            parseComparatorArgs(["--system", "ripgrep", "--manifest", "/tmp/m.json", "--split", "pilot", ...LICENSE]),
        ).toThrow(/--split must be dev\|holdout with --manifest/);
    });

    it("requires the license flag for --manifest (frozen splits span Multi-SWE-bench rows)", () => {
        expect(() => parseComparatorArgs(["--system", "ripgrep", "--manifest", "/tmp/m.json", "--split", "dev"])).toThrow(
            /license review flag missing/,
        );
    });

    it("rejects value-taking flags with missing values", () => {
        expect(() => parseComparatorArgs(["--system"])).toThrow(/--system requires a value/);
        expect(() => parseComparatorArgs(["--system", "ripgrep", "--manifest"])).toThrow(/--manifest requires a value/);
        expect(() => parseComparatorArgs(["--system", "ripgrep", "--manifest", "--offline"])).toThrow(
            /--manifest requires a value/,
        );
    });

    it("rejects unknown arguments and bad splits/formulations", () => {
        expect(() => parseComparatorArgs(["--system", "ripgrep", "--bogus"])).toThrow(/Unknown argument/);
        expect(() => parseComparatorArgs(["--system", "ripgrep", "--split", "dev64"])).toThrow(/--split must be/);
        expect(() => parseComparatorArgs(["--system", "ripgrep", "--formulation", "query"])).toThrow(
            /--formulation must be/,
        );
    });

    it("parses --formulation/--limit/--timeout-ms/--offline", () => {
        const args = parseComparatorArgs([
            "--system",
            "ripgrep",
            "--formulation",
            "title",
            "--limit",
            "3",
            "--timeout-ms",
            "1000",
            "--offline",
        ]);
        expect(args.formulations).toEqual(["title"]);
        expect(args.limit).toBe(3);
        expect(args.timeoutMs).toBe(1000);
        expect(args.offline).toBe(true);
    });
});
