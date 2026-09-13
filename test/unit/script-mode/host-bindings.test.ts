import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunBudget } from "../../../src/script-mode/run-budget.js";
import {
    buildHostBindings,
    clampLspTimeoutMs,
    HostBudgetExceeded,
    LSP_DEFAULT_TIMEOUT_MS,
    MIN_LSP_TIMEOUT_MS,
} from "../../../src/script-mode/host-bindings.js";
import type { LspInspectionProvider } from "../../../src/lsp/lsp-inspection.js";

const cwd = process.cwd();
const sessionFilePath = "/tmp/fake-script-mode-session.jsonl";

function budgetWith(overrides: ConstructorParameters<typeof RunBudget>[0] = {}): RunBudget {
    return new RunBudget({ deadlineMs: 20_000, ...overrides });
}

describe("host bindings", () => {
    it("freezes the returned API object recursively", () => {
        const budget = budgetWith();
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            expect(Object.isFrozen(api)).toBe(true);
            expect(Object.isFrozen(api.lsp)).toBe(true);
            expect(Object.isFrozen(api.graph)).toBe(true);
            expect(Object.isFrozen(api.grep)).toBe(true);
        } finally {
            budget.dispose();
        }
    });

    it("read returns content + path-mode evidence and logs ok", async () => {
        const budget = budgetWith();
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            const { value, evidence } = await api.read("package.json", { limit: 5 });
            const v = value as { contentText: string; truncated: boolean };
            expect(v.contentText).toContain("pi-smartread");
            expect(evidence).not.toBeNull();
            expect(evidence!.mode).toBe("path");
            expect(budget.callLog).toHaveLength(1);
            expect(budget.callLog[0]).toMatchObject({ op: "read", status: "ok" });
        } finally {
            budget.dispose();
        }
    });

    it("grep (literal) returns hits + query-mode evidence", async () => {
        const budget = budgetWith();
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            const { value, evidence } = await api.grep("typecheck", { path: "package.json", literal: true, limit: 5 });
            const v = value as { totalHits: number; shown: unknown[] };
            expect(v.totalHits).toBeGreaterThan(0);
            expect(v.shown.length).toBeGreaterThan(0);
            expect(evidence).not.toBeNull();
            expect(evidence!.mode).toBe("query");
        } finally {
            budget.dispose();
        }
    });

    it("inspectFile reuses executeInspectV4 with evidence attached", async () => {
        const budget = budgetWith();
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            const { value, evidence } = await api.inspectFile("package.json", {});
            const v = value as { mode: string; contentText: string };
            expect(v.mode).toBe("file");
            expect(typeof v.contentText).toBe("string");
            expect(evidence).not.toBeNull();
        } finally {
            budget.dispose();
        }
    });

    it("missing file logs error and throws", async () => {
        const budget = budgetWith();
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            await expect(api.read("does-not-exist-12345.ts", {})).rejects.toThrow();
            expect(budget.callLog).toHaveLength(1);
            expect(budget.callLog[0]!.status).toBe("error");
        } finally {
            budget.dispose();
        }
    });

    it("quota exhaustion logs quota-exceeded and throws HostBudgetExceeded", async () => {
        const budget = budgetWith({ maxTotalCalls: 1 });
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            await api.read("package.json", { limit: 3 });
            await expect(api.read("package.json", { limit: 3 })).rejects.toBeInstanceOf(HostBudgetExceeded);
            expect(budget.callLog.map((e) => e.status)).toEqual(["ok", "quota-exceeded"]);
        } finally {
            budget.dispose();
        }
    });

    it("lsp sub-cap rejects with quota-exceeded", async () => {
        const budget = budgetWith({ maxLspCalls: 0 });
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            await expect(api.lsp["documentSymbols"]!({ path: "package.json" })).rejects.toBeInstanceOf(HostBudgetExceeded);
            expect(budget.callLog[0]!.status).toBe("quota-exceeded");
        } finally {
            budget.dispose();
        }
    });

    it("graph dir-only/file-only validation mirrors tool errors", async () => {
        const budget = budgetWith();
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            await expect(api.graph["clusters"]!({ path: "package.json" })).rejects.toThrow(/directory target/);
            await expect(api.graph["callGraph"]!({ path: "." })).rejects.toThrow(/file target/);
        } finally {
            budget.dispose();
        }
    });

    it("concurrent Promise.all fan-out cannot exceed the total-call cap (§4, binding layer)", async () => {
        const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "script-bindings-cap-")));
        try {
            writeFileSync(path.join(dir, "f.ts"), "const x = 1;\n");
            const session = "/tmp/fake-script-mode-cap-session.jsonl";
            // High concurrency ceiling so only the total-call cap binds.
            const budget = new RunBudget({ deadlineMs: 20_000, maxTotalCalls: 10, maxConcurrent: 100 });
            try {
                const api = buildHostBindings({ budget, cwd: dir, sessionFilePath: session });
                const results = await Promise.allSettled(
                    Array.from({ length: 100 }, () => api.read("f.ts", {})),
                );
                const ok = results.filter((r) => r.status === "fulfilled").length;
                const rejected = results.filter((r) => r.status === "rejected").length;
                expect(ok).toBe(10);
                expect(rejected).toBe(90);
                for (const r of results) {
                    if (r.status === "rejected") expect(r.reason).toBeInstanceOf(HostBudgetExceeded);
                }
                expect(budget.callLog.filter((e) => e.status === "ok")).toHaveLength(10);
                expect(budget.callLog.filter((e) => e.status === "quota-exceeded")).toHaveLength(90);
            } finally {
                budget.dispose();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("clampLspTimeoutMs is min(default 5000, remaining) floored", () => {
        expect(clampLspTimeoutMs(20_000)).toBe(LSP_DEFAULT_TIMEOUT_MS);
        expect(clampLspTimeoutMs(5000)).toBe(5000);
        expect(clampLspTimeoutMs(300)).toBe(300);
        expect(clampLspTimeoutMs(200)).toBe(MIN_LSP_TIMEOUT_MS);
        expect(clampLspTimeoutMs(5)).toBe(MIN_LSP_TIMEOUT_MS);
        expect(clampLspTimeoutMs(0)).toBe(MIN_LSP_TIMEOUT_MS);
        expect(clampLspTimeoutMs(-10)).toBe(MIN_LSP_TIMEOUT_MS);
        expect(clampLspTimeoutMs(Number.NaN)).toBe(MIN_LSP_TIMEOUT_MS);
    });

    it("injected LSP provider receives a remaining-budget-clamped timeoutMs", async () => {
        const seen: Array<number | undefined> = [];
        const provider: LspInspectionProvider = {
            inspectNavigation: (async (input: { timeoutMs?: number }) => {
                seen.push(input.timeoutMs);
                return { status: "empty", operation: "documentSymbols" as const, items: [], truncated: false };
            }) as LspInspectionProvider["inspectNavigation"],
            inspectDiagnostics: (async () => ({ status: "unavailable", diagnostics: [], truncated: false })) as LspInspectionProvider["inspectDiagnostics"],
        };
        // ~1s of budget left: clamped timeout must be <= remaining and < default.
        const budget = budgetWith({ deadlineMs: 1000 });
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath, lspInspectionProvider: provider });
            await api.lsp["documentSymbols"]!({ path: "package.json" });
            expect(seen).toHaveLength(1);
            expect(seen[0]).toBeGreaterThanOrEqual(MIN_LSP_TIMEOUT_MS);
            expect(seen[0]).toBeLessThanOrEqual(1000);
            expect(seen[0]).toBeLessThan(LSP_DEFAULT_TIMEOUT_MS);
        } finally {
            budget.dispose();
        }
    });

    it("oversized results are rejected past the per-call byte cap", async () => {
        const budget = budgetWith({ maxBytesPerCall: 10 });
        try {
            const api = buildHostBindings({ budget, cwd, sessionFilePath });
            await expect(api.read("package.json", { limit: 5 })).rejects.toBeInstanceOf(HostBudgetExceeded);
            expect(budget.callLog[0]!.status).toBe("quota-exceeded");
        } finally {
            budget.dispose();
        }
    });
});
