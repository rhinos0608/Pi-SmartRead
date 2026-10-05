/** Usage-text fidelity for the paired-comparison CLI (no engine IO). */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
    join(here, "../../../scripts/eval/judge/grep-e2e-compare.ts"),
    "utf8",
);

describe("grep-e2e-compare usage", () => {
    it("advertises --recompute (the flag the CLI actually parses)", () => {
        const usageLine = source.split("\n").find((line) => line.includes("Usage:"));
        expect(usageLine).toBeDefined();
        expect(usageLine).toContain("--recompute");
    });
});
