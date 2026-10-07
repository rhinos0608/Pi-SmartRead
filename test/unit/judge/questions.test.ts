import { describe, expect, it } from "vitest";
import {
    existsQuestion,
    findFileQuestion,
    signaturePointerQuestion,
    unitRelevanceQuestion,
} from "../../../src/judge/questions.js";

describe("questions", () => {
    it("unit relevance embeds the state ref and criteria", () => {
        const q = unitRelevanceQuestion("retry failed requests", "units.u3");
        expect(q.type).toBe("noul");
        expect(q.instructions).toBe(
            'Does `units.u3` substantively implement, define, or explain part of "retry failed requests"? Apply `criteria`.',
        );
        expect(q.criteria?.true).toContain("A helper implementing one requested step counts");
        expect(q.criteria?.false).toContain("only mentions, calls, imports, tests");
    });

    it("exists question matches the cookbook wording", () => {
        expect(existsQuestion("retry failed requests").instructions).toBe('Do any of the units answer "retry failed requests"?');
    });

    it("signature pointer reuses the per-unit wording", () => {
        expect(signaturePointerQuestion("q", "units.a")).toEqual(unitRelevanceQuestion("q", "units.a"));
    });

    it("find file question tags the file key and tree", () => {
        const q = findFileQuestion("configure embedding endpoint", "f7", "src/indexing/embedding.ts");
        expect(q.instructions).toContain('tagged f7 ("src/indexing/embedding.ts")');
        expect(q.instructions).toContain("`tree`");
        expect(q.criteria?.true).toContain("plausibly contains");
    });
});
