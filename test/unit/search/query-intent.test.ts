import { describe, expect, it } from "vitest";
import { isNaturalLanguageQuery } from "../../../src/search/query-intent.js";

describe("isNaturalLanguageQuery", () => {
    it.each([
        "where do we retry failed API requests?",
        "what decides which language server handles a file",
        "files that configure the embedding endpoint",
        "how is grep output truncated",
    ])("accepts behavioural description: %s", (query) => {
        expect(isNaturalLanguageQuery(query)).toBe(true);
    });

    it.each([
        "",
        "resolveEditMode",
        "grep cascade",
        "src/**/*.ts",
        "foo|bar",
        "^export function",
        "import.meta.dirname",
        "fuseAndDedup(bm25Hits, symbolHits)",
        "const x = 1",
        "createGrepTool runSmartCascade fuseAndDedup",
        "\"where do we retry\"",
    ])("rejects identifiers, globs, regexes, and code: %s", (query) => {
        expect(isNaturalLanguageQuery(query)).toBe(false);
    });
});
