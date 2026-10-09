/**
 * CLI argument parsing for the external grep comparator runner (harness only).
 *
 * Split out of run-comparators.ts so the parsing (including the frozen
 * --manifest mode) is unit-testable without executing a benchmark run.
 */

import { isComparatorName, type ComparatorName } from "./types.js";
import type { Formulation } from "../instance.js";
import { assertMultiSweBenchLicense } from "../multi-swe-bench.js";

export interface ComparatorCliArgs {
    system: ComparatorName;
    split: string;
    formulations: Formulation[];
    limit: number | null;
    timeoutMs: number;
    seed: string;
    offline: boolean;
    multiSweBench: boolean;
    manifestPath: string | null;
    openHoldout: boolean;
}

export function takeValue(flag: string, argv: string[], i: number): string {
    const value = argv[i];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value (got ${value ?? "nothing"})`);
    }
    return value;
}

/**
 * Parse comparator CLI args. Frozen manifests (--manifest PATH) span
 * Multi-SWE-bench rows, so --manifest requires --accept-license-review, and
 * --split holdout is refused unless --open-holdout is also given (D41).
 * Without --manifest, --split holdout is refused (the holdout only exists
 * frozen) and --split must be pilot|dev.
 */
export function parseComparatorArgs(argv: string[]): ComparatorCliArgs {
    let system: ComparatorName | null = null;
    let split = "pilot";
    let formulationArg = "both";
    let limit: number | null = null;
    let timeoutMs = 60000;
    let seed = "external-grep-v1";
    let offline = false;
    let multiSweBench = false;
    let manifestPath: string | null = null;
    let openHoldout = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--system") {
            const value = takeValue(arg, argv, ++i);
            if (!isComparatorName(value)) throw new Error("--system must be ripgrep|probe|codanna");
            system = value;
        } else if (arg === "--split") split = takeValue(arg, argv, ++i);
        else if (arg === "--formulation") formulationArg = takeValue(arg, argv, ++i);
        else if (arg === "--limit") limit = Number(takeValue(arg, argv, ++i));
        else if (arg === "--timeout-ms") timeoutMs = Number(takeValue(arg, argv, ++i));
        else if (arg === "--seed") seed = takeValue(arg, argv, ++i);
        else if (arg === "--offline") offline = true;
        else if (arg === "--multi-swe-bench") multiSweBench = true;
        else if (arg === "--manifest") manifestPath = takeValue(arg, argv, ++i);
        else if (arg === "--open-holdout") openHoldout = true;
        else if (arg === "--accept-license-review") continue;
        else if (arg === "--help" || arg === "-h") {
            console.log(
                "Usage: run-comparators.ts --system ripgrep|probe|codanna [--split pilot|dev] [--formulation title|body|both] [--limit N] [--timeout-ms N] [--seed SEED] [--offline]",
            );
            console.log(
                "   or: run-comparators.ts --system ripgrep|probe|codanna --manifest PATH [--split dev|holdout] [--open-holdout] [--accept-license-review] [...]",
            );
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (system === null) throw new Error("--system is required (ripgrep|probe|codanna)");
    if (multiSweBench) assertMultiSweBenchLicense(argv);
    if (manifestPath !== null) {
        // Frozen manifests span Multi-SWE-bench rows: same license gate as --multi-swe-bench.
        assertMultiSweBenchLicense(argv);
        if (!["dev", "holdout"].includes(split)) throw new Error("--split must be dev|holdout with --manifest");
    } else if (split === "holdout") {
        throw new Error("--split holdout requires --manifest (the holdout only exists frozen)");
    } else if (!["pilot", "dev"].includes(split)) throw new Error("--split must be pilot|dev");
    if (!["title", "body", "both"].includes(formulationArg)) throw new Error("--formulation must be title|body|both");
    const formulations: Formulation[] =
        formulationArg === "both" ? ["title", "body"] : [formulationArg as Formulation];
    return { system, split, formulations, limit, timeoutMs, seed, offline, multiSweBench, manifestPath, openHoldout };
}
