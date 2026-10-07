/**
 * Canonical-path helpers — single home for realpathSync-based canonicalization.
 *
 * Evidence contract (AGENTS.md): `canonicalPath` values in workspace-evidence
 * envelopes MUST be true realpaths (symlinks resolved) via plain
 * `realpathSync`, so Pi-SmartEdit SHA-256 freshness verification stays stable.
 * These wrappers all use plain `realpathSync` (not `.native`) to preserve the
 * exact resolution flavor the migrated call sites already relied on.
 */

/* eslint-disable no-restricted-syntax -- this module is the sanctioned realpathSync home */
import { realpathSync } from "node:fs";

/**
 * Strict canonicalization. Throws when the path cannot be resolved.
 * Use inside an existing try/catch whose failure policy is handled by caller.
 */
export function canonicalPathStrict(filePath: string): string {
    return realpathSync(filePath);
}

/**
 * Canonicalize, falling back to the input when resolution fails
 * (e.g. non-existent path). Evidence paths stay usable; unresolved symlinks
 * keep their lexical form.
 */
export function canonicalPathOrFallback(filePath: string): string {
    try {
        return realpathSync(filePath);
    } catch {
        return filePath;
    }
}

/**
 * Canonicalize, returning null when resolution fails.
 * Use where a missing path is a validation error, not a fallback.
 */
export function canonicalPathOrNull(filePath: string): string | null {
    try {
        return realpathSync(filePath);
    } catch {
        return null;
    }
}
