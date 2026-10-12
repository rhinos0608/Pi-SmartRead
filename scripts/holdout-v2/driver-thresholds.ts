/**
 * Holdout v2 kill-and-resume driver thresholds (§9.16, owner-approved 2026-10-12).
 *
 * Every value below cites §9.16. They are overridable ONLY via test-only
 * injection (the supervisor's testHooks), never via CLI flags, so a study
 * execution cannot run with altered thresholds.
 */

/** Frozen engine identity the driver executes against (prereg §1, §9.16). */
export const FROZEN_ENGINE_HASH =
    "sha256:e5fad8375eb02281e2b29ab9b12136d756b9f0a8f03f8ccfe94c95e9ea74ca4e:281-files";

/** Per-query internal deadline, unchanged from the runner (adapter.ts:82). */
export const INTERNAL_QUERY_LIMIT_MS = 60000;

export interface DriverThresholds {
    /** §9.16 query-phase rule: kill a query still running this long after query-start. */
    queryWatchdogMs: number;
    /** §9.16 setup rule: one stall check covers this wall window. */
    setupCheckMs: number;
    /** §9.16 setup rule: stall = no progress and under this CPU in each check. */
    setupStallCpuSeconds: number;
    /** §9.16 setup rule: consecutive stalled checks that declare a stall. */
    setupStallChecks: number;
    /** §9.16 setup rule: a wall gap over this between checks resets the count. */
    setupCheckGapResetMs: number;
    /** §9.16 setup rule: hard cap per instance setup. */
    setupHardCapMs: number;
    /** §9.16 kill procedure: grace between SIGTERM and SIGKILL. */
    killGraceMs: number;
    /** §9.11 sampler, restored by §9.16: sidecar load/CPU sample interval. */
    loadSampleMs: number;
}

/** §9.16 values exactly: 120 s query; 10 × 60 s setup checks at < 5 CPU-s; 180 s gap reset; 30 min cap; 10 s grace; 60 s sampler. */
export const DRIVER_THRESHOLDS: DriverThresholds = {
    queryWatchdogMs: 120000,
    setupCheckMs: 60000,
    setupStallCpuSeconds: 5,
    setupStallChecks: 10,
    setupCheckGapResetMs: 180000,
    setupHardCapMs: 30 * 60000,
    killGraceMs: 10000,
    loadSampleMs: 60000,
};
