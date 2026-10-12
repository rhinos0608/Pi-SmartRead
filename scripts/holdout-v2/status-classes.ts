/**
 * Error status classes for the §9.16 reporting additions.
 *
 * Classes: internal-limit timeouts (the runner's own 60 s deadline, recorded
 * `timeout:*`/`error:*` by adapter.ts:53-60), `timeout:watchdog-query`,
 * `error:watchdog-setup`, and any other error. Shared by the driver receipt
 * and the merge-attempts reporting additions.
 */

export type ErrorStatusClass =
    | "ok"
    | "over-token-cap"
    | "internal-limit"
    | "watchdog-query"
    | "watchdog-setup"
    | "other-error";

/** Classify one report outcome status (§9.16 reporting additions). */
export function errorStatusClass(status: string): ErrorStatusClass {
    if (status === "ok") return "ok";
    if (status === "over_token_cap") return "over-token-cap";
    if (status === "timeout:watchdog-query") return "watchdog-query";
    if (status === "error:watchdog-setup") return "watchdog-setup";
    if (status.startsWith("timeout:") || status === "error:timeout") return "internal-limit";
    return "other-error";
}

export interface StatusClassCounts {
    total: number;
    counts: Record<ErrorStatusClass, number>;
    /** Per-arm/per-execution rates: counts/total, 0 when total is 0. */
    rates: Record<ErrorStatusClass, number>;
}

const CLASSES: ErrorStatusClass[] = ["ok", "over-token-cap", "internal-limit", "watchdog-query", "watchdog-setup", "other-error"];

/** Count status classes over report outcomes (never inspects scores). */
export function countStatusClasses(outcomes: Array<{ status: string }>): StatusClassCounts {
    const counts = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ErrorStatusClass, number>;
    for (const outcome of outcomes) counts[errorStatusClass(outcome.status)] += 1;
    const total = outcomes.length;
    const rates = Object.fromEntries(CLASSES.map((c) => [c, total > 0 ? counts[c]! / total : 0])) as Record<
        ErrorStatusClass,
        number
    >;
    return { total, counts, rates };
}
