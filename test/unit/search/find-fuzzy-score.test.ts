import { describe, expect, it } from "vitest";
import { scoreFuzzyPath } from "../../../src/search/fuzzy-path-score.js";

describe("scoreFuzzyPath", () => {
    it("returns -1 when the query is not a subsequence", () => {
        expect(scoreFuzzyPath("zzz", "src/auth.ts")).toBe(-1);
        expect(scoreFuzzyPath("", "src/auth.ts")).toBe(-1);
        expect(scoreFuzzyPath("toolongquery", "a.ts")).toBe(-1);
    });

    it("is case-insensitive", () => {
        expect(scoreFuzzyPath("AUTH", "src/auth.ts")).toBeGreaterThanOrEqual(0);
    });

    it("prefers the basename when the query has no separator (VS Code label preference)", () => {
        const atBoundary = scoreFuzzyPath("auth", "src/auth.ts");
        const midWord = scoreFuzzyPath("auth", "src/xxauthyy.ts");
        expect(atBoundary).toBeGreaterThan(midWord);
    });

    it("falls back to the full path when the basename does not match", () => {
        expect(scoreFuzzyPath("srcauth", "src/auth.ts")).toBeGreaterThanOrEqual(0);
    });

    it("scores the full path when the query contains a separator", () => {
        const full = scoreFuzzyPath("src/auth", "src/auth.ts");
        const noSep = scoreFuzzyPath("srcauth", "src/auth.ts");
        expect(full).toBeGreaterThanOrEqual(0);
        expect(noSep).toBeGreaterThanOrEqual(0);
        expect(full).not.toBe(noSep);
    });

    it("rewards matches after a path boundary", () => {
        expect(scoreFuzzyPath("auth", "src/auth.ts")).toBeGreaterThan(
            scoreFuzzyPath("auth", "src/xauth.ts"),
        );
    });

    it("rewards word-boundary matches after _ - .", () => {
        expect(scoreFuzzyPath("cfg", "app_config.ts")).toBeGreaterThan(
            scoreFuzzyPath("cfg", "appxconfig.ts"),
        );
    });

    it("rewards camelCase boundary matches", () => {
        expect(scoreFuzzyPath("fb", "fooBar.ts")).toBeGreaterThan(
            scoreFuzzyPath("fb", "fooxbar.ts"),
        );
    });

    it("rewards consecutive matches over gapped ones", () => {
        expect(scoreFuzzyPath("abc", "xxabc.ts")).toBeGreaterThan(
            scoreFuzzyPath("abc", "xxaxbxc.ts"),
        );
    });

    it("orders an exact basename above partial alternatives", () => {
        const exact = scoreFuzzyPath("auth", "auth.ts");
        const partial = scoreFuzzyPath("auth", "authentication-service.ts");
        expect(exact).toBeGreaterThan(partial);
    });
});
