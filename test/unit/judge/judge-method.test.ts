import { describe, expect, it } from "vitest";
import { judgeMethodForModel } from "../../../src/judge/judge-method.js";

describe("judgeMethodForModel (owner ruling D-80)", () => {
    it("uses M1 for openai/gpt-6-luna-decisions", () => {
        expect(judgeMethodForModel("openai/gpt-6-luna-decisions")).toBe("M1");
    });

    it("uses M2 for perplexity/pplx-decider-v1.1-27b", () => {
        expect(judgeMethodForModel("perplexity/pplx-decider-v1.1-27b")).toBe("M2");
    });

    it("keeps ~typesafe/jev-latest on M0", () => {
        expect(judgeMethodForModel("~typesafe/jev-latest")).toBe("M0");
    });

    it("fails safe to M0 for unknown models", () => {
        expect(judgeMethodForModel("some-other/model")).toBe("M0");
        expect(judgeMethodForModel("")).toBe("M0");
    });

    it("matches exact model ids only (no prefix/case/substring match)", () => {
        expect(judgeMethodForModel("openai/gpt-6-luna-decisions-v2")).toBe("M0");
        expect(judgeMethodForModel("OpenAI/gpt-6-luna-decisions")).toBe("M0");
        expect(judgeMethodForModel("prefix:openai/gpt-6-luna-decisions")).toBe("M0");
        expect(judgeMethodForModel("perplexity/pplx-decider-v1.1-27b-other")).toBe("M0");
    });
});
