import { describe, expect, it } from "vitest";
import {
    detectFindMode,
    findModeLabel,
    FIND_DEFAULT_LIMIT,
    FIND_DEFAULT_NL_LIMIT,
    FIND_MAX_LIMIT,
    resolveFindLimit,
} from "../../../src/search/find-modes.js";

describe("detectFindMode", () => {
    it.each([
        ["*.ts", "glob"],
        ["src/**/*.spec.ts", "glob"],
        ["file?.txt", "glob"],
        ["src/[abc].ts", "glob"],
        ["src/{a,b}.ts", "glob"],
        ["auth", "fuzzy"],
        ["AuthService", "fuzzy"],
        ["src/auth", "fuzzy"],
        ["config.ts", "fuzzy"],
    ])("pattern %p → %p", (pattern, expected) => {
        expect(detectFindMode(pattern)).toBe(expected);
    });

    it("routes natural-language descriptions to natural-language mode", () => {
        expect(detectFindMode("files that configure the embedding endpoint")).toBe("natural-language");
        expect(detectFindMode("where do we retry failed requests")).toBe("natural-language");
    });

    it("prefers glob when glob metacharacters are present", () => {
        expect(detectFindMode("*.ts")).toBe("glob");
    });

    it("keeps exact identifiers and paths in fuzzy mode", () => {
        expect(detectFindMode("authenticate")).toBe("fuzzy");
        expect(detectFindMode("src/auth.ts")).toBe("fuzzy");
    });
});

describe("resolveFindLimit", () => {
    it("defaults to 100 for glob/fuzzy and 20 for natural language", () => {
        expect(resolveFindLimit(undefined, "glob")).toBe(FIND_DEFAULT_LIMIT);
        expect(resolveFindLimit(undefined, "fuzzy")).toBe(FIND_DEFAULT_LIMIT);
        expect(resolveFindLimit(undefined, "natural-language")).toBe(FIND_DEFAULT_NL_LIMIT);
    });

    it("clamps to [1, 500]", () => {
        expect(resolveFindLimit(0, "glob")).toBe(1);
        expect(resolveFindLimit(-5, "fuzzy")).toBe(1);
        expect(resolveFindLimit(1000, "glob")).toBe(FIND_MAX_LIMIT);
        expect(resolveFindLimit(500, "natural-language")).toBe(500);
        expect(resolveFindLimit(42, "glob")).toBe(42);
    });

    it("falls back on non-finite input", () => {
        expect(resolveFindLimit(Number.NaN, "glob")).toBe(FIND_DEFAULT_LIMIT);
    });
});

describe("findModeLabel", () => {
    it("labels each mode", () => {
        expect(findModeLabel("glob")).toBe("glob");
        expect(findModeLabel("fuzzy")).toBe("fuzzy name");
        expect(findModeLabel("natural-language")).toBe("natural language");
    });
});
