/**
 * Wrapped grep tool — primary code search with BM25 + AST symbol cascade.
 *
 * literal:true → direct lexical grep.
 * Otherwise: Layer1 BM25 + Layer2 AST symbol → RRF fusion → dedup →
 * embedding retry (wider topK) → lexical grep fallback.
 */
import { relative, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
} from "@rhinos0608/pi-workspace-protocol";
import { handleGrep } from "./search-tool.js";
import { handleSymbol } from "./find-symbol-tool.js";
import { getSemanticIndex } from "./semantic-index-registry.js";
import { pathPrefixForDirectory } from "./semantic-index.js";
import type { ContextGraph } from "./context-graph.js";
import { applyGraphFilter, parseGraphFilter } from "./graph-filter.js";

// ── Schema ──────────────────────────────────────────────────────────

const GrepSchema = Type.Object({
    pattern: Type.String({ description: "Text, symbol name, or concept to search for.", minLength: 1 }),
    path: Type.Optional(Type.String({ description: "Directory or file to search in (default: cwd)." })),
    glob: Type.Optional(Type.String({ description: "File filter, e.g. '*.ts' or 'src/**/*.py'." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
    literal: Type.Optional(Type.Boolean({ description: "Exact substring match — skip BM25/semantic (default: false)." })),
    limit: Type.Optional(Type.Number({ description: "Max results (default: 20, max: 100).", default: 20, minimum: 1, maximum: 100 })),
    contextLines: Type.Optional(Type.Number({ description: "Lines of context per match (default: 2, max: 10).", default: 2, minimum: 0, maximum: 10 })),
    graphFilter: Type.Optional(Type.String({ description: 'Filter results by graph relationship. Format: "EDGE_TYPE->target" e.g. "CALLS->auth.login" or "IMPORTED_BY->src/core".' })),
});

type GrepInput = Static<typeof GrepSchema>;

export const GREP_DESCRIPTION = `Search code for a text pattern, symbol name, or concept.
Use this as your primary tool for finding code — it handles exact matches,
symbol lookups, and conceptual queries automatically.
Example: grep('auth middleware') finds authentication code even if the
function is named validateToken.

Parameters: pattern (required), path (scope directory/file), glob (file filter),
ignoreCase, literal, contextLines, graphFilter. Results are ranked and deduplicated.

graphFilter: filter results by graph relationship. Format "EDGE_TYPE->target",
e.g. "CALLS->auth.login" (only files that call auth.login) or
"IMPORTED_BY->src/core" (only files imported by src/core).`;

// ── Types ───────────────────────────────────────────────────────────

interface GrepHit {
    file: string;
    relFile: string;
    line: number;
    endLine: number;
    name: string;
    kind: string;
    snippet: string;
    engines: string[];
    score: number;
}

// ── Factory ─────────────────────────────────────────────────────────

export interface GrepToolOptions {
    readonly resolver?: {
        publishInspection(envelope: unknown, sessionFilePath: string, workspaceRoot: string): void;
    };
    readonly getSessionFilePath?: () => string | null | undefined;
    /** ContextGraph instance or getter for graphFilter edge checks (WP-5 DI). */
    readonly contextGraph?: ContextGraph | (() => ContextGraph);
}

export function createGrepTool(opts: GrepToolOptions): ToolDefinition {
    return {
        name: "grep",
        label: "grep",
        description: GREP_DESCRIPTION,
        parameters: GrepSchema as unknown as Record<string, unknown>,

        async execute(
            toolCallId: string,
            params: GrepInput & Record<string, unknown>,
            signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: ExtensionContext,
        ) {
            const cwd = ctx.cwd;
            const searchDir = params.path ? resolve(cwd, params.path) : cwd;
            const topK = clamp(params.limit ?? 20, 1, 100);
            const gatherK = Math.min(topK * 2, 200); // expanded pool for graphFilter to work on
            const contextLines = clamp(params.contextLines ?? 2, 0, 10);
            const caseSensitive = !(params.ignoreCase ?? false);
            const startTime = Date.now();

            let hits: GrepHit[];
            let engines: string[];

            if (params.literal) {
                const result = await runLiteralGrep(
                    params.pattern, searchDir, gatherK, contextLines, caseSensitive, cwd, signal,
                );
                hits = result.hits;
                engines = result.engines;
            } else {
                const result = await runSmartCascade(
                    params.pattern, searchDir, gatherK, contextLines, caseSensitive, cwd, signal,
                );
                hits = result.hits;
                engines = result.engines;
            }

            // ── Glob filter ───────────────────────────────────────────
            const glob = params.glob;
            if (glob) {
                const { minimatch } = await import("minimatch");
                hits = hits.filter((h) => minimatch(h.relFile, glob));
            }

            // ── Graph filter (WP-5 wiring) ──────────────────────────────
            let graphFilterNotes: string[] = [];
            if (params.graphFilter !== undefined) {
                // Validate format first — throws spec error for invalid format
                if (!parseGraphFilter(params.graphFilter)) {
                    throw new Error('Invalid graphFilter: expected "EDGE_TYPE->target" format');
                }
                const contextGraph = typeof opts.contextGraph === "function" ? opts.contextGraph() : opts.contextGraph;
                if (!contextGraph) {
                    throw new Error("graphFilter requires an indexed context graph");
                }
                const result = await applyGraphFilter(hits, params.graphFilter, contextGraph);
                hits = result.hits;
                graphFilterNotes = result.notes;
            }

            const shown = hits.slice(0, topK);
            const truncated = hits.length > topK;

            const elapsed = Date.now() - startTime;
            const text = formatOutput(params.pattern, shown, hits.length, engines, truncated, elapsed, graphFilterNotes);
            const evidence = buildEvidence(shown, cwd, opts);

            // Publish into the resolver (best-effort).
            if (opts.resolver) {
                const sessionFilePath = opts.getSessionFilePath?.();
                if (typeof sessionFilePath === "string" && sessionFilePath.length > 0) {
                    try {
                        opts.resolver.publishInspection(
                            evidence,
                            sessionFilePath,
                            evidence.canonicalWorkspaceRoot,
                        );
                    } catch { /* best-effort */ }
                }
            }

            return {
                content: [{ type: "text" as const, text }],
                details: {
                    workspaceEvidence: evidence,
                    mode: "query",
                    toolCallId,
                    totalHits: hits.length,
                    shownHits: shown.length,
                    truncated,
                    engines,
                },
            };
        },
    };
}

// ── Smart cascade ───────────────────────────────────────────────────

async function runSmartCascade(
    pattern: string,
    searchDir: string,
    gatherK: number,
    contextLines: number,
    caseSensitive: boolean,
    cwd: string,
    signal: AbortSignal | undefined,
): Promise<{ hits: GrepHit[]; engines: string[] }> {
    const bigK = gatherK;
    const bm25Hits = new Map<string, GrepHit>();
    const symbolHits = new Map<string, GrepHit>();
    const engines: string[] = [];

    // ── Layer 1: BM25 lexical ───────────────────────────────────────
    const semanticIndex = getSemanticIndex(searchDir);
    if (semanticIndex?.isAvailable()) {
        try {
            const prefix = pathPrefixForDirectory(semanticIndex.root, searchDir);
            const results = await semanticIndex.search(pattern, { topK: bigK, pathPrefix: prefix });
            for (const r of results) {
                const absPath = resolve(semanticIndex.root, r.filePath);
                const relFile = relative(cwd, absPath).replace(/\\/g, "/");
                const line = r.lineStart;
                const key = `${absPath}:${line}`;
                bm25Hits.set(key, {
                    file: absPath,
                    relFile,
                    line,
                    endLine: r.lineEnd,
                    name: r.symbolKind,
                    kind: "bm25",
                    snippet: r.codeSnippet,
                    engines: ["bm25"],
                    score: r.score,
                });
            }
            if (bm25Hits.size > 0) engines.push("bm25");
        } catch { /* index unavailable or search failed */ }
    }

    if (signal?.aborted) throw new Error("Operation aborted");

    // ── Layer 2: AST symbol match ───────────────────────────────────
    try {
        const symResult = await handleSymbol(pattern, bigK, false, searchDir, cwd, signal);
        for (const m of symResult.matches) {
            const absPath = resolve(cwd, m.relative_path);
            const relFile = m.relative_path;
            const key = `${absPath}:${m.line}`;
            if (!symbolHits.has(key)) {
                symbolHits.set(key, {
                    file: absPath,
                    relFile,
                    line: m.line,
                    endLine: m.end_line ?? m.line,
                    name: m.name,
                    kind: m.kind,
                    snippet: m.body ?? "",
                    engines: ["symbol"],
                    score: 0,
                });
            }
        }
        if (symbolHits.size > 0) engines.push("symbol");
    } catch { /* symbol search failed */ }

    if (signal?.aborted) throw new Error("Operation aborted");

    // ── RRF fusion + dedup ──────────────────────────────────────────
    let fused = fuseAndDedup(bm25Hits, symbolHits);

    // ── Fallback: embedding semantic retry (wider topK) ─────────────
    if (fused.length === 0 && semanticIndex?.isAvailable()) {
        try {
            const prefix = pathPrefixForDirectory(semanticIndex.root, searchDir);
            const results = await semanticIndex.search(pattern, { topK: bigK * 3, pathPrefix: prefix });
            const retryHits = new Map<string, GrepHit>();
            for (const r of results) {
                const absPath = resolve(semanticIndex.root, r.filePath);
                const relFile = relative(cwd, absPath).replace(/\\/g, "/");
                const line = r.lineStart;
                const key = `${absPath}:${line}`;
                retryHits.set(key, {
                    file: absPath,
                    relFile,
                    line,
                    endLine: r.lineEnd,
                    name: r.symbolKind,
                    kind: "semantic-retry",
                    snippet: r.codeSnippet,
                    engines: ["semantic-retry"],
                    score: r.score,
                });
            }
            if (retryHits.size > 0) {
                fused = [...retryHits.values()];
                engines.push("semantic-retry");
            }
        } catch { /* retry failed */ }
    }

    if (signal?.aborted) throw new Error("Operation aborted");

    // ── Fallback: lexical grep passthrough ───────────────────────────
    if (fused.length === 0) {
        const fallback = await runLiteralGrep(pattern, searchDir, bigK, contextLines, caseSensitive, cwd, signal);
        return { hits: fallback.hits, engines: ["lexical-passthrough"] };
    }

    // Fill snippet for hits missing one (symbol hits often lack snippet).
    await enrichSnippets(fused, contextLines);

    return { hits: fused, engines };
}

// ── Literal grep passthrough ────────────────────────────────────────

async function runLiteralGrep(
    pattern: string,
    searchDir: string,
    topK: number,
    contextLines: number,
    caseSensitive: boolean,
    cwd: string,
    signal: AbortSignal | undefined,
): Promise<{ hits: GrepHit[]; engines: string[] }> {
    const result = await handleGrep(
        `grep-literal:${pattern}`,
        {
            query: pattern,
            directory: searchDir,
            maxResults: topK,
            matchMode: "literal",
            caseSensitive,
            contextLines,
        } as never,
        searchDir,
        signal,
    );
    const rawMatches: Array<{
        file?: unknown;
        relFile?: unknown;
        line?: unknown;
        endLine?: unknown;
        name?: unknown;
        kind?: unknown;
        snippet?: unknown;
    }> = (((result.details as Record<string, unknown> | undefined)?.matches) as never) ?? [];

    const hits: GrepHit[] = [];
    for (const m of rawMatches) {
        if (typeof m.file !== "string") continue;
        const absPath = m.file as string;
        hits.push({
            file: absPath,
            relFile: (typeof m.relFile === "string" ? m.relFile : relative(cwd, absPath).replace(/\\/g, "/")),
            line: typeof m.line === "number" ? m.line : 1,
            endLine: typeof m.endLine === "number" ? m.endLine : (typeof m.line === "number" ? m.line : 1),
            name: typeof m.name === "string" ? m.name : "(text match)",
            kind: typeof m.kind === "string" ? m.kind : "text",
            snippet: typeof m.snippet === "string" ? m.snippet : "",
            engines: ["lexical"],
            score: 0,
        });
    }
    return { hits, engines: ["lexical"] };
}

// ── RRF fusion + dedup ─────────────────────────────────────────────

function fuseAndDedup(
    bm25Hits: Map<string, GrepHit>,
    symbolHits: Map<string, GrepHit>,
): GrepHit[] {
    const merged = new Map<string, GrepHit>();

    let rank = 0;
    for (const [key, hit] of bm25Hits) {
        rank++;
        const existing = merged.get(key);
        if (existing) {
            existing.score += 1 / (60 + rank);
            if (!existing.engines.includes("bm25")) existing.engines.push("bm25");
        } else {
            merged.set(key, { ...hit, score: 1 / (60 + rank) });
        }
    }

    rank = 0;
    for (const [key, hit] of symbolHits) {
        rank++;
        const existing = merged.get(key);
        if (existing) {
            existing.score += 1 / (60 + rank);
            if (!existing.engines.includes("symbol")) existing.engines.push("symbol");
        } else {
            merged.set(key, { ...hit, score: 1 / (60 + rank) });
        }
    }

    const results = [...merged.values()];
    results.sort((a, b) => b.score - a.score);
    return results;
}

// ── Enrich snippets for hits missing one ───────────────────────────

async function enrichSnippets(hits: GrepHit[], contextLines: number): Promise<void> {
    const fs = await import("node:fs/promises");
    for (const hit of hits) {
        if (hit.snippet) continue;
        try {
            const content = await fs.readFile(hit.file, "utf-8");
            const lines = content.split(/\r?\n/);
            const start = Math.max(0, hit.line - 1 - contextLines);
            const end = Math.min(lines.length - 1, hit.line - 1 + contextLines);
            const snippetLines: string[] = [];
            for (let i = start; i <= end; i++) {
                snippetLines.push(`    ${String(i + 1).padStart(4, " ")} | ${lines[i] ?? ""}`);
            }
            hit.snippet = snippetLines.join("\n");
        } catch { /* file unreadable */ }
    }
}

// ── Evidence envelope ───────────────────────────────────────────────

function buildEvidence(
    hits: GrepHit[],
    cwd: string,
    toolOpts: GrepToolOptions,
): WorkspaceEvidenceEnvelope {
    const sessionFilePath = toolOpts.getSessionFilePath?.() as string | null | undefined;
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = typeof sessionFilePath === "string" && sessionFilePath.length > 0
        ? hashSessionFilePath(sessionFilePath)
        : "0".repeat(64);

    const resourcesByPath = new Map<string, InspectedResource>();
    for (const hit of hits) {
        const canonical = hit.file;
        const existing = resourcesByPath.get(canonical);
        const range = { startLine: hit.line, endLine: hit.endLine };
        if (existing) {
            const merged = mergeRanges([...existing.allowedRanges, range]);
            resourcesByPath.set(canonical, { ...existing, allowedRanges: merged });
        } else {
            resourcesByPath.set(canonical, {
                resourceId: resourceIdFor({ canonicalPath: canonical, kind: "range", range }),
                canonicalPath: canonical,
                kind: "range",
                coverage: "search-match",
                allowedRanges: [range],
                fresh: false,
            });
        }
    }

    const resources = [...resourcesByPath.values()];
    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: canonicalRoot,
        resources: resources.map((r) => ({
            canonicalPath: r.canonicalPath,
            ...(r.allowedRanges[0] ? { range: r.allowedRanges[0] } : {}),
        })),
    });

    return {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources,
        mode: "query" as any,
    };
}

// ── Output formatting ──────────────────────────────────────────────

function formatOutput(
    pattern: string,
    shown: GrepHit[],
    totalHits: number,
    engines: string[],
    truncated: boolean,
    elapsedMs: number,
    graphFilterNotes?: string[],
): string {
    const engineStr = engines.join(" + ");
    const lines: string[] = [
        `${totalHits} result(s) for "${pattern}" (${engineStr}, ${(elapsedMs / 1000).toFixed(1)}s)`,
        "",
    ];

    for (const hit of shown) {
        const symbolPart = hit.name ? `  ${hit.name}` : "";
        const lineRange = hit.endLine > hit.line ? `L${hit.line}-${hit.endLine}` : `L${hit.line}`;
        lines.push(`${hit.relFile}  ${lineRange}${symbolPart}`);
        if (hit.snippet) {
            lines.push(hit.snippet);
        }
        lines.push("");
    }

    if (truncated) {
        lines.push(`(truncated: ${shown.length} of ${totalHits}, narrow search for more)`);
    }

    if (graphFilterNotes && graphFilterNotes.length > 0) {
        for (const note of graphFilterNotes) {
            lines.push(`graphFilter note: ${note}`);
        }
    }

    return lines.join("\n");
}

// ── Range merge ─────────────────────────────────────────────────────

function mergeRanges(ranges: Array<{ startLine: number; endLine: number }>): Array<{ startLine: number; endLine: number }> {
    if (ranges.length <= 1) return ranges;
    const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
    const out: Array<{ startLine: number; endLine: number }> = [];
    for (const r of sorted) {
        const last = out[out.length - 1];
        if (last && r.startLine <= last.endLine + 1) {
            last.endLine = Math.max(last.endLine, r.endLine);
        } else {
            out.push({ ...r });
        }
    }
    return out;
}

// ── Helpers ─────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, Math.trunc(value)));
}
