/**
 * Compute the inspect tool's `details.workspaceEvidence` envelope.
 *
 * v3 multi-mode: path/query/symbol/map. Each mode produces an envelope
 * with the appropriate `mode` field. The path-mode behavior is the v1
 * single-file read-with-evidence path (preserved).
 *
 * - `path` mode: explicit file (or line-range). Hashes the session file path
 *   to derive a stable `sessionId`, rejects absent/ephemeral session identity,
 *   computes a deterministic `inspectionId` from session+workspace+resources.
 *   full-file resource carries full content sha256 + fresh=true.
 *   line-range resource MAY carry fullFileSha256 for inside-queue verification.
 * - `query` mode: intent-based multi-file search. Delegates to the search
 *   engine. Resources are derived from grep/definition hits and tagged
 *   with line-range coverage of the cited lines.
 * - `symbol` mode: symbol lookup. Delegates to the symbol engine. Resources
 *   are derived from the symbol's enclosing file with line-range coverage.
 * - `map` mode: repo structure. Resources are an empty set; the envelope
 *   is a marker that no file-level authorization was issued.
 */
import { realpathSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve as pathResolve, relative as pathRelative } from "node:path";
import {
    PROTOCOL_SCHEMA_VERSION,
    hashSessionFilePath,
    inspectionIdFor,
    resourceIdFor,
    canonicalizeWorkspaceRoot,
    type WorkspaceEvidenceEnvelope,
    type InspectedResource,
    type InspectMode,
} from "@rhinos0608/pi-workspace-protocol";
import { handleGrep, handleCode } from "./search-tool.js";
import { createRepoTool } from "./repomap-tool.js";
import { handleSymbol } from "./find-symbol-tool.js";

export interface ComputeInspectDetailsInput {
    readonly path?: string;
    readonly query?: string;
    readonly symbol?: string;
    readonly action?: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly depth?: "quick" | "deep";
    readonly directory?: string;
    readonly cwd: string;
    readonly sessionFilePath: string;
    /** Abort signal for delegated searches. */
    readonly signal?: AbortSignal;
}

export interface InspectDetails {
    readonly tool: "inspect";
    readonly mode: InspectMode;
    readonly workspaceEvidence: WorkspaceEvidenceEnvelope;
    /** Rendered content for the model. Always raw text. */
    readonly contentText: string;
    readonly lineCount: number;
    readonly byteLength: number;
    readonly truncated: boolean;
    /** Underlying search/symbol/map tool result details. */
    readonly upstreamDetails?: unknown;
}

function sha256OfString(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
}

function requireSessionFilePath(input: ComputeInspectDetailsInput): string {
    if (typeof input.sessionFilePath !== "string" || input.sessionFilePath.length === 0) {
        throw new Error("inspect requires a real session file path (in-memory/ephemeral identity is rejected)");
    }
    return input.sessionFilePath;
}

export function computeInspectDetails(input: ComputeInspectDetailsInput): InspectDetails {
    const mode = resolveMode(input);
    if (mode === "path") {
        if (typeof input.path !== "string" || input.path.length === 0) {
            throw new Error("inspect path mode requires a non-empty `path` argument");
        }
        return computePathInspectDetails(input);
    }
    // query/symbol/map are async via upstream engines; expose a synchronous
    // helper that returns the path-mode envelope shape only. Callers that
    // need the async modes should use `executeInspectDetails` instead.
    throw new Error(
        `inspect mode "${mode}" requires async execution; use executeInspectDetails() instead of computeInspectDetails()`,
    );
}

/**
 * Async entry point — dispatches to the correct mode engine and returns
 * the envelope + content text + upstream details.
 */
export async function executeInspectDetails(
    input: ComputeInspectDetailsInput,
): Promise<InspectDetails> {
    requireSessionFilePath(input);
    const mode = resolveMode(input);
    if (mode === "path") {
        if (typeof input.path !== "string" || input.path.length === 0) {
            throw new Error("inspect path mode requires a non-empty `path` argument");
        }
        return computePathInspectDetails(input);
    }
    if (mode === "query") {
        return executeQueryInspectDetails(input);
    }
    if (mode === "symbol") {
        return executeSymbolInspectDetails(input);
    }
    return executeMapInspectDetails(input);
}

export function resolveMode(input: ComputeInspectDetailsInput): InspectMode {
    if (typeof input.action === "string" && input.action === "map") return "map";
    if (typeof input.symbol === "string" && input.symbol.length > 0) return "symbol";
    if (typeof input.path === "string" && input.path.length > 0) return "path";
    if (typeof input.query === "string" && input.query.length > 0) return "query";
    throw new Error(
        'inspect requires one of: "path" (default), "query", "symbol", or action: "map"',
    );
}

// ── Path mode (v1 behavior, unchanged) ─────────────────────────────

function computePathInspectDetails(input: ComputeInspectDetailsInput): InspectDetails {
    if (typeof input.sessionFilePath !== "string" || input.sessionFilePath.length === 0) {
        throw new Error("inspect requires a real session file path (in-memory/ephemeral identity is rejected)");
    }

    const cwd = realpathSync(input.cwd);
    const absolutePath = pathResolve(cwd, input.path!);
    let canonicalFile: string;
    try {
        const stat = statSync(absolutePath);
        if (!stat.isFile()) {
            throw new Error(`inspect target is not a regular file: ${input.path}`);
        }
        canonicalFile = realpathSync(absolutePath);
    } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
            throw new Error(`file not found: ${input.path}`);
        }
        throw err;
    }

    const raw = readFileSync(canonicalFile);
    const fullContent = raw.toString("utf8");
    const fullFileSha256 = sha256OfString(fullContent);
    const allLines = fullContent.split("\n");
    const totalLines = allLines.length;
    const totalBytes = Buffer.byteLength(fullContent, "utf8");

    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(input.sessionFilePath);

    // Determine resource kind/coverage
    const offset = input.offset;
    const limit = input.limit;
    const hasRange = typeof offset === "number" || typeof limit === "number";
    let resource: InspectedResource;
    let renderedLines: string[];
    let truncated = false;

    if (!hasRange) {
        resource = {
            resourceId: resourceIdFor({ canonicalPath: canonicalFile, kind: "full" }),
            canonicalPath: canonicalFile,
            kind: "full",
            coverage: "full-file",
            allowedRanges: [{ startLine: 1, endLine: totalLines }],
            fullFileSha256,
            fresh: true,
            byteLength: totalBytes,
            lineCount: totalLines,
        };
        renderedLines = allLines;
    } else {
        const startLine = Math.max(1, Math.floor(offset ?? 1));
        const endLine =
            typeof limit === "number" && Number.isInteger(limit) && limit > 0
                ? Math.min(totalLines, startLine + limit - 1)
                : totalLines;
        if (endLine < startLine) {
            throw new Error(`inspect: limit/offset produces an empty range (startLine=${startLine}, endLine=${endLine})`);
        }
        const slice = allLines.slice(startLine - 1, endLine).join("\n");
        const rangeSliceSha = sha256OfString(slice);
        const rangeResourceId = resourceIdFor({
            canonicalPath: canonicalFile,
            kind: "range",
            range: { startLine, endLine },
        });
        resource = {
            resourceId: rangeResourceId,
            canonicalPath: canonicalFile,
            kind: "range",
            coverage: "line-range",
            allowedRanges: [{ startLine, endLine }],
            fullFileSha256,
            fresh: true,
            byteLength: Buffer.byteLength(slice, "utf8"),
            lineCount: endLine - startLine + 1,
        };
        renderedLines = slice.split("\n");
        truncated = startLine > 1 || endLine < totalLines;
        void rangeSliceSha;
    }

    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: canonicalRoot,
        resources: [{ canonicalPath: canonicalFile, ...(resource.kind === "range" ? { range: { startLine: resource.allowedRanges[0]!.startLine, endLine: resource.allowedRanges[0]!.endLine } } : {}) }],
    });

    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources: [resource],
        mode: "path",
    };

    const startLine = resource.allowedRanges[0]!.startLine;
    const contentText = renderedLines
        .map((line, i) => `${startLine + i}: ${line}`)
        .join("\n");

    return {
        tool: "inspect",
        mode: "path",
        workspaceEvidence: envelope,
        contentText,
        lineCount: resource.lineCount ?? renderedLines.length,
        byteLength: resource.byteLength ?? Buffer.byteLength(contentText, "utf8"),
        truncated,
    };
}

// ── Query mode ─────────────────────────────────────────────────────

interface QueryHit {
    file: string;
    relFile?: string;
    line: number;
    endLine?: number;
    name?: string;
    kind?: string;
    body?: string;
    snippet?: string;
}

async function executeQueryInspectDetails(
    input: ComputeInspectDetailsInput,
): Promise<InspectDetails> {
    const sessionFilePath = input.sessionFilePath;
    const cwd = realpathSync(input.cwd);
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(sessionFilePath);

    const query = (input.query ?? "").trim();
    if (!query) {
        throw new Error('inspect query mode requires a non-empty "query"');
    }
    const depth = input.depth ?? "quick";

    // Synthesize a toolCallId so the upstream search engine records the hits
    // in the file-read cache (handy for context hygiene). The id is
    // deterministic per (session, query) so cache lookups repeat safely.
    const toolCallId = sha256OfString(`${sessionId}:${query}:${depth}`).slice(0, 32);

    let searchResult: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
    if (depth === "deep") {
        // Deep path: use the search engine's deep mode (semantic + graph).
        // The default createSearchTool() handles dispatch.
        const searchToolFactory = (await import("./search-tool.js")).default;
        const searchTool = searchToolFactory();
        const fakeCtx = { cwd, sessionManager: undefined } as any;
        const result = await searchTool.execute(
            toolCallId,
            { query, depth: "deep" } as any,
            input.signal,
            undefined,
            fakeCtx,
        );
        const text = (result.content?.[0] as { type: "text"; text: string } | undefined)?.text ?? "";
        searchResult = {
            content: [{ type: "text", text }],
            details: (result.details ?? {}) as Record<string, unknown>,
        };
    } else {
        // Quick path: combine grep + code like the search tool does.
        const grepResult = await handleGrep(
            toolCallId,
            { query, matchMode: "literal" } as any,
            cwd,
            input.signal,
        );
        const codeResult = await handleCode(
            toolCallId,
            { query, matchMode: "literal" } as any,
            cwd,
            input.signal,
            false,
        );
        const parts: string[] = [];
        const codeText = (codeResult.content[0] as any)?.text ?? "";
        const grepText = (grepResult.content[0] as any)?.text ?? "";
        if (codeText && ((codeResult.details as any)?.total ?? 0) > 0) parts.push(codeText);
        if (grepText && ((grepResult.details as any)?.total ?? 0) > 0) parts.push(grepText);
        if (parts.length === 0) {
            parts.push(`[No matches for "${query}". Try depth: "deep" for semantic search.]`);
        }
        searchResult = {
            content: [{ type: "text", text: parts.join("\n") }],
            details: {
                total:
                    ((codeResult.details as any)?.total ?? 0) +
                    ((grepResult.details as any)?.total ?? 0),
                query,
                codeDefinitions: (codeResult.details as any)?.total ?? 0,
                textMatches: (grepResult.details as any)?.total ?? 0,
                definitionHits: (grepResult.details as any)?.definitionHits ?? 0,
                textHits: (grepResult.details as any)?.textHits ?? 0,
                matches: (grepResult.details as any)?.matches ?? [],
                filesScanned:
                    (codeResult.details as any)?.filesScanned ??
                    (grepResult.details as any)?.filesScanned ??
                    0,
            },
        };
    }

    const details = searchResult.details as Record<string, unknown>;
    const matches = (details.matches as QueryHit[] | undefined) ?? [];

    // Build resources from unique file:line hits. Each hit authorizes only
    // the cited line range — query mode is never full-file authority.
    const resourcesByPath = new Map<string, InspectedResource>();
    for (const m of matches) {
        if (typeof m.file !== "string") continue;
        let canonical: string;
        try {
            const st = statSync(m.file);
            if (!st.isFile()) continue;
            canonical = realpathSync(m.file);
        } catch {
            continue;
        }
        const startLine = Math.max(1, Math.floor(m.line ?? 1));
        const endLine = Math.max(startLine, Math.floor(m.endLine ?? startLine));
        const existing = resourcesByPath.get(canonical);
        if (existing) {
            // Merge the new range into the existing resource.
            const ranges = [...existing.allowedRanges, { startLine, endLine }];
            ranges.sort((a, b) => a.startLine - b.startLine);
            const merged: InspectedResource = {
                ...existing,
                allowedRanges: mergeRanges(ranges),
            };
            resourcesByPath.set(canonical, merged);
        } else {
            resourcesByPath.set(canonical, {
                resourceId: resourceIdFor({
                    canonicalPath: canonical,
                    kind: "range",
                    range: { startLine, endLine },
                }),
                canonicalPath: canonical,
                kind: "range",
                // Weak coverage: this is a match pointer from a search hit,
                // not a targeted read. No trustworthy fullFileSha256 is
                // available. patch must reject this coverage kind — the
                // model must path-mode inspect the file before mutating it.
                coverage: "search-match",
                allowedRanges: [{ startLine, endLine }],
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
            ...(r.kind === "range" && r.allowedRanges[0]
                ? { range: { startLine: r.allowedRanges[0].startLine, endLine: r.allowedRanges[0].endLine } }
                : {}),
        })),
    });

    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources,
        mode: "query",
    };

    const contentText = (searchResult.content[0] as any)?.text ?? "";
    return {
        tool: "inspect",
        mode: "query",
        workspaceEvidence: envelope,
        contentText,
        lineCount: contentText === "" ? 0 : contentText.split("\n").length,
        byteLength: Buffer.byteLength(contentText, "utf8"),
        truncated: false,
        upstreamDetails: details,
    };
}

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

// ── Symbol mode ────────────────────────────────────────────────────

async function executeSymbolInspectDetails(
    input: ComputeInspectDetailsInput,
): Promise<InspectDetails> {
    const sessionFilePath = input.sessionFilePath;
    const cwd = realpathSync(input.cwd);
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(sessionFilePath);

    const symbolName = (input.symbol ?? "").trim();
    if (!symbolName) {
        throw new Error('inspect symbol mode requires a non-empty "symbol"');
    }
    const maxResults = 30;

    const data = await handleSymbol(
        symbolName,
        maxResults,
        true, // includeBody for evidence
        cwd,
        cwd,
        input.signal,
    );

    const matches = (data.matches as Array<{ relative_path: string; line: number; end_line?: number }>) ?? [];

    // Each match authorizes a small line-range around the symbol.
    const resourcesByPath = new Map<string, InspectedResource>();
    for (const m of matches) {
        if (typeof m.relative_path !== "string" || m.relative_path.length === 0) continue;
        const abs = pathResolve(cwd, m.relative_path);
        let canonical: string;
        try {
            const st = statSync(abs);
            if (!st.isFile()) continue;
            canonical = realpathSync(abs);
        } catch {
            continue;
        }
        const startLine = Math.max(1, Math.floor(m.line ?? 1));
        const endLine = Math.max(startLine, Math.floor(m.end_line ?? startLine));
        const existing = resourcesByPath.get(canonical);
        if (existing) {
            // Merge into the existing resource instead of overwriting —
            // multiple symbol matches in the same file must all stay covered.
            const ranges = [...existing.allowedRanges, { startLine, endLine }];
            ranges.sort((a, b) => a.startLine - b.startLine);
            resourcesByPath.set(canonical, {
                ...existing,
                allowedRanges: mergeRanges(ranges),
            });
        } else {
            resourcesByPath.set(canonical, {
                resourceId: resourceIdFor({
                    canonicalPath: canonical,
                    kind: "range",
                    range: { startLine, endLine },
                }),
                canonicalPath: canonical,
                kind: "range",
                // Weak coverage: symbol lookup does not perform a targeted
                // read with a trustworthy fullFileSha256. patch must reject
                // this coverage kind.
                coverage: "search-match",
                allowedRanges: [{ startLine, endLine }],
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
            ...(r.kind === "range" && r.allowedRanges[0]
                ? { range: { startLine: r.allowedRanges[0].startLine, endLine: r.allowedRanges[0].endLine } }
                : {}),
        })),
    });

    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources,
        mode: "symbol",
    };

    // Render symbol matches as readable text (preserve v1 format).
    const lines: string[] = [
        `Found ${matches.length} symbol(s) matching "${symbolName}" (${data.totalDefs} defs scanned across ${data.filesScanned} files):`,
        "",
    ];
    for (const m of matches) {
        const lrange = m.end_line ? `L${m.line}-${m.end_line}` : `L${m.line}`;
        lines.push(`  ${pathRelative(cwd, pathResolve(cwd, m.relative_path))}  ${lrange}  ${(m as any).name ?? ""}`);
        lines.push("");
    }
    if (matches.length === 0) {
        lines.push(`  [No symbols found for "${symbolName}".]`);
        lines.push("");
    }
    const contentText = lines.join("\n");

    return {
        tool: "inspect",
        mode: "symbol",
        workspaceEvidence: envelope,
        contentText,
        lineCount: lines.length,
        byteLength: Buffer.byteLength(contentText, "utf8"),
        truncated: false,
        upstreamDetails: data,
    };
}

// ── Map mode ───────────────────────────────────────────────────────

async function executeMapInspectDetails(
    input: ComputeInspectDetailsInput,
): Promise<InspectDetails> {
    const sessionFilePath = input.sessionFilePath;
    const cwd = realpathSync(input.cwd);
    const canonicalRoot = canonicalizeWorkspaceRoot(cwd);
    const sessionId = hashSessionFilePath(sessionFilePath);

    const repoTool = createRepoTool();
    const fakeCtx = { cwd, sessionManager: undefined } as any;
    const result = await repoTool.execute(
        "inspect-map",
        { directory: input.directory ?? ".", mapTokens: 4096, compact: true } as any,
        input.signal,
        undefined,
        fakeCtx,
    );
    const contentText = (result.content?.[0] as { type: "text"; text: string } | undefined)?.text ?? "";

    // Map mode: zero resources. The envelope marks "no file-level
    // authorization issued" — the model is reading the repo shape, not
    // individual files.
    const inspectionId = inspectionIdFor({
        sessionId,
        workspaceRoot: canonicalRoot,
        resources: [],
    });
    const envelope: WorkspaceEvidenceEnvelope = {
        schemaVersion: PROTOCOL_SCHEMA_VERSION,
        inspectionId,
        sessionId,
        workspaceRoot: cwd,
        canonicalWorkspaceRoot: canonicalRoot,
        createdAt: new Date().toISOString(),
        resources: [],
        mode: "map",
    };

    return {
        tool: "inspect",
        mode: "map",
        workspaceEvidence: envelope,
        contentText,
        lineCount: contentText === "" ? 0 : contentText.split("\n").length,
        byteLength: Buffer.byteLength(contentText, "utf8"),
        truncated: false,
        upstreamDetails: result.details,
    };
}
