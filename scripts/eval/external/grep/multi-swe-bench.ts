/**
 * Multi-SWE-bench loader placeholder (D12: license unresolved).
 *
 * The HF card shows "License: other" (not the claimed Apache-2.0), so this
 * loader refuses to run unless the operator passes --accept-license-review,
 * confirming the license has been reviewed and cleared.
 */

export const MULTI_SWE_BENCH_LICENSE_STATUS = "unresolved: HF card shows License: other";

export function assertMultiSweBenchLicense(args: string[]): void {
    if (!args.includes("--accept-license-review")) {
        throw new Error(
            `Refusing Multi-SWE-bench load: license unresolved (${MULTI_SWE_BENCH_LICENSE_STATUS}). ` +
                "Re-run with --accept-license-review only after the license review clears (D12).",
        );
    }
}
