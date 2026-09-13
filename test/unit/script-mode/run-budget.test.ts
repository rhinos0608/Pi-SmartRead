import { describe, it, expect } from "vitest";
import { RunBudget, categoryForOp } from "../../../src/script-mode/run-budget.js";

describe("RunBudget atomic admission (§4)", () => {
    it("caps concurrent Promise.all admission attempts at maxTotalCalls", async () => {
        const budget = new RunBudget({ maxTotalCalls: 10, deadlineMs: 10_000 });
        try {
            // Mimic binding entry: synchronous admission before the first await.
            const admitted = await Promise.all(
                Array.from({ length: 100 }, async () => {
                    const ok = budget.tryAdmit("grep");
                    if (ok) await Promise.resolve();
                    return ok;
                }),
            );
            expect(admitted.filter(Boolean).length).toBe(10);
            expect(budget.acceptedTotalCalls).toBe(10);
        } finally {
            budget.dispose();
        }
    });

    it("enforces the tighter lsp.* sub-cap independently of the total cap", async () => {
        const budget = new RunBudget({ maxTotalCalls: 50, maxLspCalls: 3, deadlineMs: 10_000 });
        try {
            const lsp = await Promise.all(
                Array.from({ length: 20 }, async () => {
                    const ok = budget.tryAdmit("lsp.definition");
                    if (ok) await Promise.resolve();
                    return ok;
                }),
            );
            expect(lsp.filter(Boolean).length).toBe(3);
            // Non-lsp calls still admitted up to the total cap.
            const other = await Promise.all(
                Array.from({ length: 60 }, async () => {
                    const ok = budget.tryAdmit("grep");
                    if (ok) await Promise.resolve();
                    return ok;
                }),
            );
            expect(other.filter(Boolean).length).toBe(50 - 3);
        } finally {
            budget.dispose();
        }
    });

    it("bounds max concurrent in-flight slots", () => {
        const budget = new RunBudget({ maxConcurrent: 2, deadlineMs: 10_000 });
        try {
            expect(budget.tryEnter()).toBe(true);
            expect(budget.tryEnter()).toBe(true);
            expect(budget.tryEnter()).toBe(false);
            budget.releaseSlot();
            expect(budget.tryEnter()).toBe(true);
        } finally {
            budget.dispose();
        }
    });

    it("rejects oversized single results and running-total overflow", () => {
        const budget = new RunBudget({ maxBytesPerCall: 100, maxTotalBytes: 150, deadlineMs: 10_000 });
        try {
            expect(budget.tryAccountBytes(101)).toBe(false);
            expect(budget.tryAccountBytes(100)).toBe(true);
            expect(budget.tryAccountBytes(51)).toBe(false);
            expect(budget.returnedBytes).toBe(100);
        } finally {
            budget.dispose();
        }
    });

    it("aborts on deadline and rejects admission past it", async () => {
        const budget = new RunBudget({ deadlineMs: 50 });
        expect(budget.tryAdmit("grep")).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(budget.aborted).toBe(true);
        expect(budget.tryAdmit("grep")).toBe(false);
        budget.dispose();
    });

    it("records call log entries in order", () => {
        const budget = new RunBudget({ deadlineMs: 10_000 });
        try {
            budget.record({ op: "grep", argsSummary: "[]", canonicalPathOrResourceId: null, status: "ok", elapsedMs: 1 });
            budget.record({ op: "read", argsSummary: "[]", canonicalPathOrResourceId: null, status: "error", elapsedMs: 2 });
            expect(budget.callLog.map((e) => e.op)).toEqual(["grep", "read"]);
        } finally {
            budget.dispose();
        }
    });

    it("categorizes lsp.* ops separately", () => {
        expect(categoryForOp("lsp.definition")).toBe("lsp");
        expect(categoryForOp("grep")).toBe("other");
        expect(categoryForOp("graph.impact")).toBe("other");
    });
});
