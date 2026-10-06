/**
 * Frozen-manifest runs for the external grep benchmark (D15/D41).
 *
 * --manifest PATH loads a frozen dev/holdout manifest
 * (scripts/eval/external/grep/freeze-dev-holdout.ts output), verifies
 * integrity with the existing manifest-integrity check (fail closed on
 * mismatch), and selects --split dev ids from it without re-freezing or
 * rewriting any manifest.
 *
 * --split holdout is refused unless --open-holdout is also given: the
 * holdout is single-use per D41, so opening it prints a warning.
 */

import { readFileSync } from "node:fs";
import { verifyDevHoldoutManifest, type DevHoldoutManifest } from "./sampling.js";

/**
 * Load a frozen manifest and verify integrity. Throws fail-closed on a
 * missing/unparseable file, an unexpected version, or a sha256 mismatch.
 */
export function loadFrozenManifest(manifestPath: string): DevHoldoutManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    } catch (error) {
        throw new Error(
            `manifest unreadable: ${manifestPath} (${error instanceof Error ? error.message : String(error)})`,
        );
    }
    if (typeof parsed !== "object" || parsed === null || (parsed as { version?: unknown }).version !== 2) {
        throw new Error(`manifest version mismatch: ${manifestPath} is not a frozen dev/holdout (v2) manifest`);
    }
    const manifest = parsed as DevHoldoutManifest;
    if (!verifyDevHoldoutManifest(manifest)) {
        throw new Error(`manifest integrity mismatch (sha256): ${manifestPath}; refusing to run`);
    }
    return manifest;
}

/**
 * Select split ids from a loaded frozen manifest. Holdout requires
 * openHoldout; when opened, a single-use warning is returned for the
 * caller to print. Never freezes or writes anything.
 */
export function frozenSplitIds(
    manifest: DevHoldoutManifest,
    split: string,
    opts: { openHoldout: boolean },
): { ids: string[]; holdoutWarning: string | null } {
    if (split === "dev") {
        return { ids: manifest.dev.map((d) => d.id), holdoutWarning: null };
    }
    if (split === "holdout") {
        if (!opts.openHoldout) {
            throw new Error(
                "refuses-holdout: --split holdout is single-use per D41; " +
                    "re-run with --open-holdout to confirm you intend to consume it",
            );
        }
        return {
            ids: manifest.holdout.map((h) => h.id),
            holdoutWarning:
                "warning: holdout is single-use per D41 — this run consumes it; " +
                "do not reuse these results for model selection",
        };
    }
    throw new Error(`--split must be dev|holdout for a frozen manifest (got ${JSON.stringify(split)})`);
}
