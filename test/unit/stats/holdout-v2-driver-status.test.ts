import { describe, expect, it } from "vitest";
import { countStatusClasses, errorStatusClass } from "../../../scripts/holdout-v2/status-classes.js";

describe("errorStatusClass", () => {
    it("classifies ok and over-token-cap as non-errors", () => {
        expect(errorStatusClass("ok")).toBe("ok");
        expect(errorStatusClass("over_token_cap")).toBe("over-token-cap");
    });
    it("classifies internal-limit timeouts (the 60 s runner deadline)", () => {
        expect(errorStatusClass("timeout:The operation was aborted due to timeout")).toBe("internal-limit");
        expect(errorStatusClass("timeout:Operation aborted")).toBe("internal-limit");
        expect(errorStatusClass("error:timeout")).toBe("internal-limit");
    });
    it("classifies the §9.16 watchdog statuses", () => {
        expect(errorStatusClass("timeout:watchdog-query")).toBe("watchdog-query");
        expect(errorStatusClass("error:watchdog-setup")).toBe("watchdog-setup");
    });
    it("classifies anything else error-shaped as other-error", () => {
        expect(errorStatusClass("error:ENOENT")).toBe("other-error");
        expect(errorStatusClass("error:Operation aborted")).toBe("other-error");
    });
});

describe("countStatusClasses", () => {
    it("counts classes and reports arm rates", () => {
        const outcomes = [
            { status: "ok" },
            { status: "ok" },
            { status: "timeout:Operation aborted" },
            { status: "timeout:watchdog-query" },
            { status: "error:watchdog-setup" },
            { status: "error:boom" },
        ];
        const counted = countStatusClasses(outcomes);
        expect(counted.total).toBe(6);
        expect(counted.counts).toEqual({
            ok: 2,
            "over-token-cap": 0,
            "internal-limit": 1,
            "watchdog-query": 1,
            "watchdog-setup": 1,
            "other-error": 1,
        });
        expect(counted.rates["watchdog-query"]).toBeCloseTo(1 / 6, 10);
        expect(counted.rates["internal-limit"]).toBeCloseTo(1 / 6, 10);
    });
});
