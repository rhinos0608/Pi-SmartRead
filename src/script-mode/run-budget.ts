/**
 * Engine-agnostic run budget for script mode. No QuickJS import —
 * unit-testable in isolation.
 *
 * Load-bearing invariant (§4): admission check + counter increment happen
 * in one synchronous call before any `await`, so
 * `Promise.all([...100 calls])` cannot all pass a stale pre-increment read.
 * This holds by construction (single-threaded synchronous mutation), not
 * by locking — the test in `test/unit/script-mode/run-budget.test.ts`
 * proves it under concurrent `Promise.all` admission attempts.
 */
import type { HostCallLogEntry, RunBudgetOptions } from "./types.js";

export const DEFAULT_BUDGET: Required<RunBudgetOptions> = {
    maxTotalCalls: 50,
    maxLspCalls: 10,
    maxConcurrent: 5,
    maxBytesPerCall: 200_000,
    maxTotalBytes: 1_000_000,
    deadlineMs: 5000,
    maxReturnBytes: 200_000,
};

/** Call categories. `lsp.*` gets its own tighter sub-cap (§3). */
export type BudgetCategory = "lsp" | "other";

export function categoryForOp(op: string): BudgetCategory {
    return op.startsWith("lsp.") ? "lsp" : "other";
}

export class RunBudget {
    readonly signal: AbortSignal;
    readonly deadline: number;
    private readonly opts: Required<RunBudgetOptions>;
    private readonly controller: AbortController;
    private readonly deadlineTimer: ReturnType<typeof setTimeout>;
    private totalCalls = 0;
    private lspCalls = 0;
    private inFlight = 0;
    private totalBytes = 0;
    private readonly log: HostCallLogEntry[] = [];
    private disposed = false;

    constructor(options: RunBudgetOptions = {}, outerSignal?: AbortSignal) {
        this.opts = { ...DEFAULT_BUDGET, ...options };
        this.deadline = Date.now() + this.opts.deadlineMs;
        this.controller = new AbortController();
        this.signal = this.controller.signal;
        if (outerSignal?.aborted) this.controller.abort();
        else outerSignal?.addEventListener("abort", () => this.controller.abort(), { once: true });
        this.deadlineTimer = setTimeout(() => this.controller.abort(), this.opts.deadlineMs);
        this.deadlineTimer.unref?.();
    }

    get options(): Required<RunBudgetOptions> {
        return this.opts;
    }

    get aborted(): boolean {
        return this.controller.signal.aborted;
    }

    get remainingMs(): number {
        return Math.max(0, this.deadline - Date.now());
    }

    get acceptedTotalCalls(): number {
        return this.totalCalls;
    }

    get acceptedLspCalls(): number {
        return this.lspCalls;
    }

    get inFlightCount(): number {
        return this.inFlight;
    }

    get returnedBytes(): number {
        return this.totalBytes;
    }

    /**
     * Atomic admission: check + increment synchronously, before any await.
     * Returns true when the call is admitted (counters incremented).
     * Rejects immediately past deadline/abort or over a cap — the caller
     * must not enter the host function body on false.
     */
    tryAdmit(op: string): boolean {
        if (this.disposed || this.controller.signal.aborted || Date.now() >= this.deadline) return false;
        if (this.totalCalls >= this.opts.maxTotalCalls) return false;
        if (categoryForOp(op) === "lsp" && this.lspCalls >= this.opts.maxLspCalls) return false;
        this.totalCalls++;
        if (categoryForOp(op) === "lsp") this.lspCalls++;
        return true;
    }

    /**
     * Atomic concurrency slot: check + increment synchronously.
     * Pair every `true` with exactly one `releaseSlot()` on settle.
     */
    tryEnter(): boolean {
        if (this.disposed || this.controller.signal.aborted) return false;
        if (this.inFlight >= this.opts.maxConcurrent) return false;
        this.inFlight++;
        return true;
    }

    releaseSlot(): void {
        if (this.inFlight > 0) this.inFlight--;
    }

    /**
     * Post-call byte accounting. Measures the already-serialized result:
     * rejects (false) when this single result exceeds the per-call cap or
     * would push the running total past the run cap; otherwise records
     * the bytes and returns true.
     */
    tryAccountBytes(byteLength: number): boolean {
        if (byteLength > this.opts.maxBytesPerCall) return false;
        if (this.totalBytes + byteLength > this.opts.maxTotalBytes) return false;
        this.totalBytes += byteLength;
        return true;
    }

    record(entry: HostCallLogEntry): void {
        this.log.push(entry);
    }

    get callLog(): readonly HostCallLogEntry[] {
        return this.log;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        clearTimeout(this.deadlineTimer);
        if (!this.controller.signal.aborted) this.controller.abort();
    }
}
