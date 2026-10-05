/**
 * Shared types for external grep comparator adapters (benchmark harness only).
 *
 * Each comparator maps its tool output to a ranked list of file-level units
 * (deduped by first file appearance downstream in metrics.ts) plus the exact
 * rendered text used for the common rendered-token-cap metric (D14).
 */

import type { BenchmarkInstance, Formulation } from "../instance.js";

export type ComparatorName = "ripgrep" | "probe" | "codanna";

/** One ranked hit: file plus optional line range and match text. */
export interface ComparatorUnit {
    relFile: string;
    line: number;
    endLine: number;
    name: string;
    text?: string;
}

/** Result of one comparator run (one instance + one formulation). */
export interface ComparatorOutput {
    units: ComparatorUnit[];
    /** Exact rendered text the token-cap metric is computed over. */
    renderedText: string;
    /** Per-query wall time in ms (excludes setup/index time). */
    elapsedMs: number;
    /** Per-instance setup/index wall time in ms (0 when not applicable). */
    setupMs: number;
    status: string;
}

export interface ComparatorOptions {
    timeoutMs: number;
    toolsDir?: string;
}

export interface ComparatorRunner {
    (
        instance: BenchmarkInstance,
        snapshotRoot: string,
        formulation: Formulation,
        options: ComparatorOptions,
    ): Promise<ComparatorOutput>;
}

/** Manifest fragment describing a comparator run (versions, preprocessing). */
export interface ComparatorManifest {
    system: string;
    tool: string;
    version: string;
    checksumOrCommit: string;
    binaryPath: string;
    /** Exact preprocessing/search rule (disclosed per D13). */
    searchRule: string;
    formulationSource: string;
    tokenCap: number;
}
