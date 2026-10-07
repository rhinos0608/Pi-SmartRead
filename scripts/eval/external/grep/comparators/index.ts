/**
 * Comparator registry for the external grep benchmark (harness only).
 *
 * Maps --system names to runners and builds the disclosed manifest fragment
 * (tool versions, checksums, exact search rules) embedded in each report.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codannaBinary, codannaManifest, runCodanna } from "./codanna.js";
import { probeBinary, probeManifest, runProbe } from "./probe.js";
import { ripgrepManifest, runRipgrep } from "./ripgrep.js";
import type { ComparatorManifest, ComparatorName, ComparatorRunner } from "./types.js";

export type { ComparatorManifest, ComparatorName, ComparatorRunner };
export type { ComparatorOutput, ComparatorUnit } from "./types.js";

export const COMPARATORS: Record<ComparatorName, ComparatorRunner> = {
    ripgrep: runRipgrep,
    probe: runProbe,
    codanna: runCodanna,
};

export function isComparatorName(value: string): value is ComparatorName {
    return value === "ripgrep" || value === "probe" || value === "codanna";
}

function sha256OfFile(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function toolsDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/tools");
}

function rgVersion(): string {
    try {
        return (
            execFileSync("rg", ["--version"], { timeout: 15000 })
                .toString("utf8")
                .split("\n")[0]
                ?.trim() ?? "unknown"
        );
    } catch {
        return "unknown";
    }
}

/** Build the disclosed manifest fragment for a comparator system. */
export function comparatorManifest(system: ComparatorName): ComparatorManifest {
    if (system === "ripgrep") return ripgrepManifest(rgVersion());
    if (system === "probe") {
        const archive = join(toolsDir(), "probe/probe.tar.gz");
        const checksum = existsSync(archive) ? sha256OfFile(archive) : `binary:${sha256OfFile(probeBinary())}`;
        return probeManifest(checksum);
    }
    const archive = join(toolsDir(), "codanna/codanna.tar.xz");
    const checksum = existsSync(archive) ? sha256OfFile(archive) : `binary:${sha256OfFile(codannaBinary())}`;
    return codannaManifest(checksum);
}
