/**
 * Run identity helpers for the external grep benchmark runner.
 *
 * Engine source identity uses the shared hashEngineSources helper from
 * the judge e2e contract (never duplicated here). Unknown hashes stay
 * "unknown:*" and never claim a known identity (see isKnownSourceHash).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Git root derived from the caller's script location, never from an arbitrary cwd. */
export function gitRootFromScript(scriptUrl: string): string | null {
    try {
        const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd: dirname(fileURLToPath(scriptUrl)),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return root.length > 0 ? root : null;
    } catch {
        return null;
    }
}

export interface ExternalRunDigestInput {
    engineSourceHash: string;
    manifestSha256: string;
    seed: string;
    rankingKnobs: unknown;
    outcomesJson: string;
}

/** Short run digest bound to outcomes AND engine/code identity. */
export function computeExternalRunDigest(input: ExternalRunDigestInput): string {
    return createHash("sha256")
        .update(JSON.stringify(input))
        .digest("hex")
        .slice(0, 8);
}
