/**
 * Codanna comparator (benchmark harness only, D13/D17).
 *
 * Codanna (bartolli/codanna, Apache-2.0) builds a local index (local ONNX
 * embeddings; no keys, no network) and answers symbol search.
 *
 * Setup (timed separately as setupMs, once per instance): write an
 * instance-scoped settings.toml under the tools cache (index stored OUTSIDE
 * the snapshot so `.codanna/` never pollutes the searchable tree), then
 * `codanna -c <cfg> index <snapshotRoot>`. A matching index marker skips
 * re-indexing across formulations of the same instance.
 *
 * Search (timed as elapsedMs): the formulation text (issue title or full
 * body — the same source text given to every system) is passed verbatim as
 * JSON args to the symbol-search tool:
 * `codanna -c <cfg> mcp search_symbols --args '{"query":<text>,"limit":50}' --json`
 *
 * The JSON-args transport is required because `retrieve search` parses
 * `word:word` tokens out of positional args as key:value pairs and rejects
 * any query containing a colon ("search requires a query") — issue bodies
 * routinely contain colons. The indexed content and ranking are Codanna's;
 * only the arg transport differs, and it carries the text verbatim.
 * A "not_found" JSON reply (exit 1 with data:null) is a valid empty result,
 * not an error. Results keep Codanna's rank order; ranks dedupe by first
 * file appearance downstream.
 *
 * Rendered text: at most CODANNA_MAX_RESULTS (50) lines of
 * `<relFile>:<line>:<signature>` in rank order.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formulationText, type BenchmarkInstance, type Formulation } from "../instance.js";
import type { ComparatorManifest, ComparatorOptions, ComparatorOutput, ComparatorUnit } from "./types.js";

export const CODANNA_VERSION = "v0.16.0";
export const CODANNA_COMMIT = "12e823c";
export const CODANNA_MAX_RESULTS = 50;

export function codannaBinary(): string {
    return join(homedir(), ".cache/pi-smartread-bench/tools/codanna/codanna-0.16.0-macos-arm64/codanna");
}

export function codannaWorkDir(): string {
    return join(homedir(), ".cache/pi-smartread-bench/tools/codanna");
}

export function codannaConfigPath(instanceId: string): string {
    return join(codannaWorkDir(), "configs", `${instanceId}.toml`);
}

export function codannaIndexPath(instanceId: string): string {
    return join(codannaWorkDir(), "indexes", instanceId);
}

export function codannaMarkerPath(instanceId: string): string {
    return join(codannaIndexPath(instanceId), ".bench-index-marker");
}

interface CodannaHit {
    symbol?: {
        file_path?: unknown;
        name?: unknown;
        signature?: unknown;
        /** 0-based (retrieve search shape). */
        range?: { start_line?: unknown; end_line?: unknown };
        /** 1-based (mcp search_symbols shape). */
        line?: unknown;
    };
    file_path?: unknown;
}

/**
 * Parse Codanna search JSON stdout into rank-ordered units. Accepts both the
 * `retrieve search` shape (0-based range) and the `mcp search_symbols`
 * shape (1-based line). Unparseable output yields [].
 */
export function parseCodannaJson(stdout: string): ComparatorUnit[] {
    const start = stdout.indexOf("{");
    if (start < 0) return [];
    let doc: { data?: CodannaHit[] };
    try {
        doc = JSON.parse(stdout.slice(start)) as { data?: CodannaHit[] };
    } catch {
        return [];
    }
    const hits = Array.isArray(doc.data) ? doc.data : [];
    const units: ComparatorUnit[] = [];
    for (const hit of hits) {
        if (typeof hit !== "object" || hit === null) continue;
        const rel =
            typeof hit.symbol?.file_path === "string"
                ? hit.symbol.file_path
                : typeof hit.file_path === "string"
                  ? hit.file_path
                  : null;
        if (rel === null || rel === "" || rel.startsWith("..") || rel.startsWith("/")) continue;
        const rawStart = hit.symbol?.range?.start_line;
        const rawEnd = hit.symbol?.range?.end_line;
        const rawLine = hit.symbol?.line;
        let line: number;
        let endLine: number;
        if (typeof rawStart === "number" && rawStart >= 0) {
            // retrieve shape: 0-based lines, convert to 1-based.
            line = rawStart + 1;
            endLine = typeof rawEnd === "number" && rawEnd >= 0 ? Math.max(line, rawEnd + 1) : line;
        } else if (typeof rawLine === "number" && rawLine >= 1) {
            // mcp shape: already 1-based.
            line = rawLine;
            endLine = rawLine;
        } else {
            line = 1;
            endLine = 1;
        }
        const name = typeof hit.symbol?.name === "string" ? hit.symbol.name : "";
        const text = typeof hit.symbol?.signature === "string" ? hit.symbol.signature.slice(0, 200) : name;
        units.push({ relFile: rel, line, endLine, name, text });
    }
    return units;
}

/** Render at most CODANNA_MAX_RESULTS rank-ordered result lines. */
export function renderCodannaText(units: ComparatorUnit[]): string {
    return units
        .slice(0, CODANNA_MAX_RESULTS)
        .map((u) => `${u.relFile}:${u.line}:${u.text ?? ""}`)
        .join("\n");
}

function errorStatus(error: unknown): string {
    if (error instanceof Error) {
        const timedOut = /ETIMEDOUT|timed out/i.test(error.message);
        const code = error.message.split(":")[0]?.trim().slice(0, 80) || "unknown";
        return `${timedOut ? "timeout" : "error"}:${code}`;
    }
    return "error:unknown";
}

/** Stdout carried by a failed exec call (codanna prints JSON even on exit 1). */
function stdoutOf(error: unknown): string {
    if (typeof error === "object" && error !== null && "stdout" in error) {
        const out = (error as { stdout?: unknown }).stdout;
        if (typeof out === "string") return out;
        if (out instanceof Buffer) return out.toString("utf8");
    }
    return "";
}

function writeCodannaConfig(instanceId: string, snapshotRoot: string): string {
    const configPath = codannaConfigPath(instanceId);
    mkdirSync(join(codannaWorkDir(), "configs"), { recursive: true });
    const toml =
        `version = 1\nindex_path = "${codannaIndexPath(instanceId)}"\n` +
        `workspace_root = "${snapshotRoot}"\n[indexing]\nindexed_paths = ["${snapshotRoot}"]\n`;
    writeFileSync(configPath, toml);
    return configPath;
}

/** Build (or reuse) the per-instance local index; returns setup wall ms. */
export function ensureCodannaIndex(
    instance: BenchmarkInstance,
    snapshotRoot: string,
    timeoutMs: number,
): { setupMs: number; status: string } {
    const marker = codannaMarkerPath(instance.instanceId);
    const configPath = writeCodannaConfig(instance.instanceId, snapshotRoot);
    if (existsSync(marker) && readFileSync(marker, "utf8").trim() === instance.baseCommit) {
        return { setupMs: 0, status: "ok" };
    }
    const started = performance.now();
    try {
        execFileSync(codannaBinary(), ["-c", configPath, "index", snapshotRoot], {
            timeout: timeoutMs,
            maxBuffer: 256 * 1024 * 1024,
        });
    } catch (error) {
        return { setupMs: performance.now() - started, status: errorStatus(error) };
    }
    const setupMs = performance.now() - started;
    mkdirSync(codannaIndexPath(instance.instanceId), { recursive: true });
    writeFileSync(marker, instance.baseCommit);
    return { setupMs, status: "ok" };
}

/** Run Codanna search for one instance+formulation (index built on demand). */
export async function runCodanna(
    instance: BenchmarkInstance,
    snapshotRoot: string,
    formulation: Formulation,
    options: ComparatorOptions,
): Promise<ComparatorOutput> {
    const query = formulationText(instance, formulation);
    if (query.trim() === "") {
        return { units: [], renderedText: "", elapsedMs: 0, setupMs: 0, status: "empty-query" };
    }
    const setup = ensureCodannaIndex(instance, snapshotRoot, options.timeoutMs);
    if (setup.status !== "ok") {
        return { units: [], renderedText: "", elapsedMs: 0, setupMs: setup.setupMs, status: setup.status };
    }
    const started = performance.now();
    let status = "ok";
    let units: ComparatorUnit[] = [];
    const argsPayload = JSON.stringify({ query, limit: CODANNA_MAX_RESULTS });
    try {
        const out: Buffer = execFileSync(
            codannaBinary(),
            ["-c", codannaConfigPath(instance.instanceId), "mcp", "search_symbols", "--args", argsPayload, "--json"],
            { timeout: options.timeoutMs, maxBuffer: 256 * 1024 * 1024, cwd: snapshotRoot },
        );
        units = parseCodannaJson(out.toString("utf8"));
    } catch (error) {
        // not_found arrives as exit 1 with JSON on stdout: valid empty result.
        const unitsFromError = parseCodannaJson(stdoutOf(error));
        const parsed = unitsFromError.length > 0 || stdoutOf(error).includes('"status"');
        if (parsed) {
            units = unitsFromError;
        } else {
            status = errorStatus(error);
        }
    }
    const elapsedMs = performance.now() - started;
    return { units, renderedText: renderCodannaText(units), elapsedMs, setupMs: setup.setupMs, status };
}

export function codannaManifest(checksum: string): ComparatorManifest {
    return {
        system: "codanna",
        tool: "codanna",
        version: `${CODANNA_VERSION} (${CODANNA_COMMIT}) (bartolli/codanna, Apache-2.0)`,
        checksumOrCommit: `sha256:${checksum}`,
        binaryPath: codannaBinary(),
        searchRule:
            "per-instance local index (local ONNX embeddings, no keys) stored " +
            "outside the snapshot; formulation text verbatim via 'mcp " +
            "search_symbols --args {query,limit:50} --json' (JSON transport; " +
            "'retrieve search' positionals misparse queries containing " +
            "colons); not_found JSON is an empty result; semantic_search_with_context unavailable: index EMBED stage embeds 0 items so no embeddings exist",
        formulationSource: "issue title (primary) / full body (stress), same source text",
        tokenCap: 8000,
    };
}
