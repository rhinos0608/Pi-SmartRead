/**
 * Typed read-only host API for script mode.
 *
 * Every binding is a thin wrapper over a real compute-layer function —
 * never a registered tool wrapper, so no resolver publish happens inside
 * these (publish stays owned by the outer tool result). Per binding:
 *  1. atomic budget admission synchronously at entry, before any await;
 *  2. real compute-layer call (`executeInspectV4`, grep's
 *     `runGrepQueryWithEvidence`, `computePathEvidence`);
 *  3. run `AbortSignal` threaded through grep/inspect/lsp/graph (all accept
 *     one); `read` is the exception — a synchronous fast-path over
 *     `computePathEvidence` (`readFileSync`, accepts no signal), so it
 *     checks abort pre-entry and is otherwise bounded by the sandbox
 *     failsafe timer;
 *  4. serialized-size measurement against per-call + running-total caps;
 *  5. a `HostCallLogEntry` appended to the run budget;
 *  6. `{ value, evidence }` returned (null evidence only when the
 *     operation legitimately has no file-scoped output).
 *
 * `inspectFile`/`inspectDir`, every `lsp.*`, and every `graph.*` binding
 * reuse `executeInspectV4`'s existing evidence-attached path: a valid
 * `InspectV4Input` needs nothing else, and its per-call envelope already
 * covers navigation/diagnostics/impact/deadCode/clusters/hotspots/routes/
 * layers/boundaries/graphSchema/diff via the existing flags. Only `grep`
 * and `read` sit outside `executeInspectV4` and call their own compute
 * layer directly.
 *
 * Deviation note (documented, not silent): per-flag structured results
 * for `graph.*` (impact/deadCode/clusters/…) are NOT exposed as typed
 * fields on `InspectV4Result` today — only `.navigation`, `.diagnostics`,
 * and `.upstreamDetails` are. Rather than duplicate compute logic (and
 * bypass evidence auth) by importing each analysis module directly,
 * `graph.*` bindings return the admitted section text
 * (`contentText`/`truncated`/`mode`) together with the full per-call
 * envelope. Scripts synthesize JSON from that text; evidence stays
 * authoritative.
 */
import { realpathSync, statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { WorkspaceEvidenceEnvelope } from "@rhinos0608/pi-workspace-protocol";
import { executeInspectV4 } from "../inspect/inspect.js";
import type {
    CallDirection,
    ContextGraphGetter,
    DiffTarget,
    InspectV4Input,
    NavigationOperation,
} from "../inspect/inspect-types.js";
import { runGrepQueryWithEvidence } from "../search/grep-tool.js";
import { computePathEvidence } from "../evidence/path-evidence.js";
import type { ContextGraph } from "../context-graph.js";
import type { LspInspectionProvider } from "../lsp/lsp-inspection.js";
import { RunBudget } from "./run-budget.js";
import type { HostCallLogEntry, HostCallResult } from "./types.js";

export interface HostBindingsOptions {
    readonly budget: RunBudget;
    readonly cwd: string;
    readonly sessionFilePath: string;
    readonly contextGraph?: ContextGraph | ContextGraphGetter;
    readonly lspInspectionProvider?: LspInspectionProvider;
}

export type HostFn = (...args: any[]) => Promise<HostCallResult>;

export interface ScriptHostApi {
    readonly grep: HostFn;
    readonly read: HostFn;
    readonly inspectFile: HostFn;
    readonly inspectDir: HostFn;
    readonly lsp: Readonly<Record<string, HostFn>>;
    readonly graph: Readonly<Record<string, HostFn>>;
}

export class HostBudgetExceeded extends Error {
    constructor(message: string) {
        super(message);
        this.name = "HostBudgetExceeded";
    }
}

/** File-targeted LSP ops (workspaceSymbols is directory-targeted). */
export const FILE_LSP_OPS: ReadonlySet<string> = new Set([
    "definition",
    "references",
    "implementation",
    "hover",
    "documentSymbols",
    "prepareCallHierarchy",
    "incomingCalls",
    "outgoingCalls",
]);

const DIFF_TARGETS: ReadonlySet<string> = new Set(["unstaged", "staged", "HEAD"]);

// ── LSP timeout clamp (§2) ─────────────────────────────────────────────
//
// Finding: `InspectV4Input["navigation"]` (`NavigationParams`) has NO
// `timeoutMs` field, and neither `runNavOutcome`
// (`inspect-file-sections.ts`) nor `buildDirNavigationSection`
// (`inspect-directory.ts`) forwards one — so the LSP navigation path
// always runs under `lsp-inspection.ts`'s 5000ms default, even with 200ms
// of run budget left. There is genuinely no timeoutMs channel to clamp
// through `executeInspectV4` (fixing that means touching inspect/*, out of
// scope here), so the clamp is enforced at the two places script mode
// owns: (1) the injected `lspInspectionProvider` boundary —
// `NavigationInput`/`DiagnosticsInput` DO accept `timeoutMs`, so the
// wrapper below imposes `min(5000, remaining)` for real whenever a
// provider is injected; (2) a pre-dispatch floor check that refuses to
// start an LSP op when the remaining budget is already below the floor,
// failing fast instead of dispatching a doomed call. In-flight calls on
// the direct (no-provider) path are still bounded by the run AbortSignal,
// which is threaded through as `input.signal`.
/** Mirrors `DEFAULT_TIMEOUT_MS` in `lsp-inspection.ts`. */
export const LSP_DEFAULT_TIMEOUT_MS = 5000;
/**
 * Floor for the clamped LSP timeout. A near-zero remaining budget yields
 * this instead of a 0ms timeout (which would be a meaningless immediate
 * failure inside the LSP layer rather than a clean budget abort here).
 */
export const MIN_LSP_TIMEOUT_MS = 250;

export function clampLspTimeoutMs(remainingMs: number): number {
    if (!Number.isFinite(remainingMs) || remainingMs < 0) return MIN_LSP_TIMEOUT_MS;
    return Math.max(MIN_LSP_TIMEOUT_MS, Math.min(LSP_DEFAULT_TIMEOUT_MS, Math.floor(remainingMs)));
}

/** Fail fast (AbortError-shaped) when an LSP op cannot usefully start. */
function throwIfLspBudgetTooLow(ctx: BinderCtx, signal: AbortSignal, op: string): void {
    signal.throwIfAborted();
    if (ctx.budget.remainingMs < MIN_LSP_TIMEOUT_MS) {
        const err = new Error(`${op}: run budget exhausted (${ctx.budget.remainingMs}ms left); refusing LSP dispatch`);
        err.name = "AbortError";
        throw err;
    }
}

// ── arg coercion (guest values are untrusted) ─────────────────────────

function asRecord(v: unknown): Record<string, unknown> {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | undefined {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
    return typeof v === "boolean" ? v : undefined;
}

const SENSITIVE_KEY = /token|secret|password|auth|api[_-]?key/i;

function summarizeArgs(args: unknown[]): string {
    try {
        const redacted = JSON.stringify(args, (key, value) =>
            SENSITIVE_KEY.test(key) ? "[redacted]" : value,
        );
        return redacted.length > 500 ? redacted.slice(0, 500) + "…(truncated)" : redacted;
    } catch {
        return "(unserializable args)";
    }
}

// ── shared binder context ─────────────────────────────────────────────

interface BinderCtx {
    readonly budget: RunBudget;
    readonly cwd: string;
    readonly sessionFilePath: string;
    readonly graphSource?: ContextGraph | ContextGraphGetter;
    cachedGraph?: ContextGraph;
    graphPromise?: Promise<ContextGraph | undefined>;
    readonly lspInspectionProvider?: LspInspectionProvider;
}

function canonicalHint(ctx: BinderCtx, target: string | undefined): string | null {
    const raw = target ?? ctx.cwd;
    try {
        return realpathSync(pathResolve(ctx.cwd, raw));
    } catch {
        return raw;
    }
}

/** Resolve the graph source once and cache it; concurrent callers share one build. */
async function resolveGraph(ctx: BinderCtx): Promise<ContextGraph | undefined> {
    if (ctx.cachedGraph) return ctx.cachedGraph;
    const src = ctx.graphSource;
    if (!src) return undefined;
    if (!ctx.graphPromise) {
        ctx.graphPromise = (async () => {
            const g = typeof src === "function" ? await src() : src;
            ctx.cachedGraph = g;
            return g;
        })();
    }
    return ctx.graphPromise;
}

async function baseInput(ctx: BinderCtx, path: string, signal: AbortSignal, opts?: { needGraph?: boolean }): Promise<InspectV4Input> {
    const input: InspectV4Input = { path, cwd: ctx.cwd, sessionFilePath: ctx.sessionFilePath, signal };
    const graph = opts?.needGraph ? await resolveGraph(ctx) : ctx.cachedGraph;
    if (graph) input.contextGraph = graph;
    if (ctx.lspInspectionProvider) input.lspInspectionProvider = ctx.lspInspectionProvider;
    return input;
}

/**
 * Admission + accounting + logging wrapper. The two admission calls
 * (`tryEnter`, `tryAdmit`) run synchronously in the same tick the binding
 * is invoked — before the first await — so concurrent `Promise.all`
 * fan-out cannot pass a stale check (§4).
 */
async function guarded(
    ctx: BinderCtx,
    op: string,
    rawArgs: unknown[],
    pathHint: string | undefined,
    fn: (signal: AbortSignal) => Promise<{ value: unknown; evidence: WorkspaceEvidenceEnvelope | null }>,
): Promise<HostCallResult> {
    const { budget } = ctx;
    const t0 = Date.now();
    const argsSummary = summarizeArgs(rawArgs);
    const canonicalPathOrResourceId = canonicalHint(ctx, pathHint);
    const done = (status: HostCallLogEntry["status"]): void => {
        budget.record({ op, argsSummary, canonicalPathOrResourceId, status, elapsedMs: Date.now() - t0 });
    };
    // Tracks whether the try body already recorded an audit entry (serialization
    // failure, byte-cap rejection, success) so the outer catch records exactly one.
    let recorded = false;
    const mark = (status: HostCallLogEntry["status"]): void => {
        recorded = true;
        done(status);
    };
    if (!budget.tryEnter()) {
        done("quota-exceeded");
        throw new HostBudgetExceeded(`${op}: max concurrent host operations exceeded`);
    }
    if (!budget.tryAdmit(op)) {
        budget.releaseSlot();
        done("quota-exceeded");
        throw new HostBudgetExceeded(`${op}: host-call budget exceeded`);
    }
    try {
        const { value, evidence } = await fn(budget.signal);
        let bytes = 0;
        try {
            bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
        } catch {
            mark("error");
            throw new Error(`${op}: result is not JSON-serializable`);
        }
        if (!budget.tryAccountBytes(bytes)) {
            mark("quota-exceeded");
            throw new HostBudgetExceeded(`${op}: result size cap exceeded (${bytes} bytes)`);
        }
        mark("ok");
        return { value, evidence };
    } catch (err) {
        const aborted = budget.signal.aborted || (err as { name?: string } | null)?.name === "AbortError";
        if (!recorded && !(err instanceof HostBudgetExceeded)) done(aborted ? "aborted" : "error");
        throw err;
    } finally {
        budget.releaseSlot();
    }
}

function projectInspectResult(result: Awaited<ReturnType<typeof executeInspectV4>>): unknown {
    return {
        mode: result.mode,
        contentText: result.contentText,
        lineCount: result.lineCount,
        byteLength: result.byteLength,
        truncated: result.truncated,
        ...(result.navigation ? { navigation: result.navigation } : {}),
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        ...(result.upstreamDetails ? { upstreamDetails: result.upstreamDetails } : {}),
    };
}

function statKind(ctx: BinderCtx, target: string): "file" | "directory" {
    const st = statSync(pathResolve(ctx.cwd, target));
    if (st.isDirectory()) return "directory";
    if (st.isFile()) return "file";
    throw new Error(`script host: path is neither file nor directory: ${target}`);
}

// ── inspect opts passthrough ──────────────────────────────────────────

function pickCoreOpts(o: Record<string, unknown>): Partial<InspectV4Input> {
    return {
        ...(o.signals !== undefined ? { signals: o.signals as InspectV4Input["signals"] } : {}),
        ...(asNumber(o.mapTokens) !== undefined ? { mapTokens: asNumber(o.mapTokens)! } : {}),
        ...(Array.isArray(o.focus)
            ? { focus: o.focus.filter((f): f is string => typeof f === "string") }
            : {}),
        ...(asBool(o.compact) !== undefined ? { compact: asBool(o.compact)! } : {}),
        ...(asNumber(o.callDepth) !== undefined ? { callDepth: asNumber(o.callDepth)! } : {}),
        ...(typeof o.callDirection === "string" ? { callDirection: o.callDirection as CallDirection } : {}),
        ...(typeof o.diff === "string" ? { diff: o.diff as DiffTarget } : {}),
    };
}

function pickFlagOpts(o: Record<string, unknown>): Partial<InspectV4Input> {
    return {
        ...(asBool(o.deadCode) !== undefined ? { deadCode: asBool(o.deadCode)! } : {}),
        ...(asBool(o.impact) !== undefined ? { impact: asBool(o.impact)! } : {}),
        ...(asBool(o.clusters) !== undefined ? { clusters: asBool(o.clusters)! } : {}),
        ...(asBool(o.graphSchema) !== undefined ? { graphSchema: asBool(o.graphSchema)! } : {}),
        ...(asBool(o.hotspots) !== undefined ? { hotspots: asBool(o.hotspots)! } : {}),
        ...(asBool(o.boundaries) !== undefined ? { boundaries: asBool(o.boundaries)! } : {}),
        ...(asBool(o.routes) !== undefined ? { routes: asBool(o.routes)! } : {}),
        ...(asBool(o.layers) !== undefined ? { layers: asBool(o.layers)! } : {}),
    };
}

function pickBaseOpts(raw: unknown): Partial<InspectV4Input> {
    const o = asRecord(raw);
    return { ...pickCoreOpts(o), ...pickFlagOpts(o) };
}

/** Whitelisted inspect opts (guest cannot override identity/signal/graph). */
function pickInspectOpts(ctx: BinderCtx, raw: unknown): Partial<InspectV4Input> {
    const o = asRecord(raw);
    const nav = asRecord(o.navigation);
    const diag = asRecord(o.diagnostics);
    const navigation: InspectV4Input["navigation"] | undefined =
        typeof nav.operation === "string"
            ? ({
                  operation: nav.operation as NavigationOperation,
                  ...(asNumber(nav.line) !== undefined ? { line: asNumber(nav.line)! } : {}),
                  ...(asNumber(nav.character) !== undefined ? { character: asNumber(nav.character)! } : {}),
                  ...(asString(nav.query) !== undefined ? { query: asString(nav.query)! } : {}),
                  ...(asNumber(nav.maxResults) !== undefined ? { maxResults: asNumber(nav.maxResults)! } : {}),
              } as InspectV4Input["navigation"])
            : undefined;
    // Clamp diagnostics wait to the remaining run budget (§2).
    const diagnostics: InspectV4Input["diagnostics"] | undefined =
        Object.keys(diag).length > 0
            ? ({
                  ...(asNumber(diag.waitMs) !== undefined
                      ? { waitMs: Math.min(asNumber(diag.waitMs)!, ctx.budget.remainingMs) }
                      : {}),
                  ...(asNumber(diag.maxPerFile) !== undefined ? { maxPerFile: asNumber(diag.maxPerFile)! } : {}),
                  ...(asNumber(diag.maxFiles) !== undefined ? { maxFiles: asNumber(diag.maxFiles)! } : {}),
              } as InspectV4Input["diagnostics"])
            : undefined;
    return {
        ...pickBaseOpts(raw),
        ...(navigation ? { navigation } : {}),
        ...(diagnostics ? { diagnostics } : {}),
    };
}

// ── grep / read (outside executeInspectV4) ────────────────────────────

async function grepBinding(ctx: BinderCtx, pattern: unknown, opts: unknown): Promise<HostCallResult> {
    return guarded(ctx, "grep", [pattern, opts], asRecord(opts).path as string | undefined, async (signal) => {
        if (typeof pattern !== "string" || pattern.length === 0) {
            throw new Error("grep(pattern) requires a non-empty string");
        }
        const o = asRecord(opts);
        const graph = asString(o.graphFilter) ? await resolveGraph(ctx) : ctx.cachedGraph;
        const { result, evidence } = await runGrepQueryWithEvidence(
            {
                pattern,
                ...(asString(o.path) ? { path: asString(o.path)! } : {}),
                ...(asString(o.glob) ? { glob: asString(o.glob)! } : {}),
                ...(asBool(o.ignoreCase) !== undefined ? { ignoreCase: asBool(o.ignoreCase)! } : {}),
                ...(asBool(o.literal) !== undefined ? { literal: asBool(o.literal)! } : {}),
                ...(asNumber(o.limit) !== undefined ? { limit: asNumber(o.limit)! } : {}),
                ...(asNumber(o.contextLines) !== undefined ? { contextLines: asNumber(o.contextLines)! } : {}),
                ...(asString(o.graphFilter) ? { graphFilter: asString(o.graphFilter)! } : {}),
            },
            ctx.cwd,
            // Resolve the graph lazily and only when a graphFilter actually needs it.
            graph ? { contextGraph: graph } : {},
            signal,
            ctx.sessionFilePath,
        );
        return {
            value: {
                pattern: result.pattern,
                totalHits: result.totalHits,
                shown: result.shown,
                truncated: result.truncated,
                engines: result.engines,
                elapsedMs: result.elapsedMs,
            },
            evidence,
        };
    });
}

async function readBinding(ctx: BinderCtx, path: unknown, opts: unknown): Promise<HostCallResult> {
    return guarded(ctx, "read", [path, opts], typeof path === "string" ? path : undefined, async (signal) => {
        // Sync fast path: `computePathEvidence` is `readFileSync` with no
        // signal channel, so check abort BEFORE touching disk — post-deadline
        // dispatches fail fast instead of doing I/O. (Defense in depth:
        // `guarded()` admission normally rejects these first.)
        signal.throwIfAborted();
        if (typeof path !== "string" || path.length === 0) {
            throw new Error("read(path) requires a non-empty string");
        }
        const o = asRecord(opts);
        const r = computePathEvidence({
            path,
            ...(asNumber(o.offset) !== undefined ? { offset: asNumber(o.offset)! } : {}),
            ...(asNumber(o.limit) !== undefined ? { limit: asNumber(o.limit)! } : {}),
            cwd: ctx.cwd,
            sessionFilePath: ctx.sessionFilePath,
        });
        return {
            value: {
                contentText: r.contentText,
                lineCount: r.lineCount,
                totalLines: r.totalLines,
                byteLength: r.byteLength,
                truncated: r.truncated,
            },
            evidence: r.workspaceEvidence,
        };
    });
}

async function inspectFileBinding(ctx: BinderCtx, path: unknown, opts: unknown): Promise<HostCallResult> {
    return guarded(ctx, "inspectFile", [path, opts], typeof path === "string" ? path : undefined, async (signal) => {
        if (typeof path !== "string" || path.length === 0) {
            throw new Error("inspectFile(path) requires a non-empty string");
        }
        const needGraph = asRecord(opts).impact === true || asRecord(opts).graphSchema === true;
        const result = await executeInspectV4({
            ...(await baseInput(ctx, path, signal, { needGraph })),
            ...pickInspectOpts(ctx, opts),
        });
        return { value: projectInspectResult(result), evidence: result.workspaceEvidence };
    });
}

async function inspectDirBinding(ctx: BinderCtx, path: unknown, opts: unknown): Promise<HostCallResult> {
    return guarded(ctx, "inspectDir", [path, opts], typeof path === "string" ? path : undefined, async (signal) => {
        if (typeof path !== "string" || path.length === 0) {
            throw new Error("inspectDir(path) requires a non-empty string");
        }
        const needGraph = asRecord(opts).impact === true || asRecord(opts).graphSchema === true;
        const result = await executeInspectV4({
            ...(await baseInput(ctx, path, signal, { needGraph })),
            ...pickInspectOpts(ctx, opts),
        });
        return { value: projectInspectResult(result), evidence: result.workspaceEvidence };
    });
}

// ── lsp.* (via executeInspectV4 navigation) ───────────────────────────

function makeFileLspOp(ctx: BinderCtx, operation: string): HostFn {
    return async (params: unknown) => {
        return guarded(ctx, `lsp.${operation}`, [params], asRecord(params).path as string | undefined, async (signal) => {
            throwIfLspBudgetTooLow(ctx, signal, `lsp.${operation}`);
            const p = asRecord(params);
            const target = asString(p.path);
            if (!target) throw new Error(`lsp.${operation}(params) requires params.path`);
            const navigation: InspectV4Input["navigation"] = {
                operation: operation as NavigationOperation,
                ...(asNumber(p.line) !== undefined ? { line: asNumber(p.line)! } : {}),
                ...(asNumber(p.character) !== undefined ? { character: asNumber(p.character)! } : {}),
                ...(asNumber(p.maxResults) !== undefined ? { maxResults: asNumber(p.maxResults)! } : {}),
            };
            const result = await executeInspectV4({ ...(await baseInput(ctx, target, signal)), navigation });
            return {
                value: result.navigation ?? { status: "degraded", operation, items: [], truncated: false },
                evidence: result.workspaceEvidence,
            };
        });
    };
}

async function lspWorkspaceSymbols(ctx: BinderCtx, params: unknown): Promise<HostCallResult> {
    return guarded(ctx, "lsp.workspaceSymbols", [params], asRecord(params).path as string | undefined, async (signal) => {
        throwIfLspBudgetTooLow(ctx, signal, "lsp.workspaceSymbols");
        const p = asRecord(params);
        const query = asString(p.query);
        if (!query) throw new Error("lsp.workspaceSymbols(params) requires params.query");
        const target = asString(p.path) ?? ".";
        if (statKind(ctx, target) !== "directory") {
            throw new Error(`Error: inspect navigation operation "workspaceSymbols" requires a directory target`);
        }
        const result = await executeInspectV4({
            ...(await baseInput(ctx, target, signal)),
            navigation: {
                operation: "workspaceSymbols",
                query,
                ...(asNumber(p.maxResults) !== undefined ? { maxResults: asNumber(p.maxResults)! } : {}),
            },
        });
        return {
            value: result.navigation ?? { status: "degraded", operation: "workspaceSymbols", items: [], truncated: false },
            evidence: result.workspaceEvidence,
        };
    });
}

// ── graph.* (via executeInspectV4 flags; see module deviation note) ───

function makeGraphOp(
    ctx: BinderCtx,
    op: string,
    apply: (params: Record<string, unknown>, input: InspectV4Input) => void,
    opts?: { dirOnly?: boolean; fileOnly?: boolean },
): HostFn {
    return async (params: unknown) => {
        return guarded(ctx, `graph.${op}`, [params], asRecord(params).path as string | undefined, async (signal) => {
            const p = asRecord(params);
            const target = asString(p.path) ?? ".";
            const kind = statKind(ctx, target);
            if (opts?.dirOnly && kind !== "directory") {
                throw new Error(`Error: inspect param "${op}" requires a directory target (got file: ${target})`);
            }
            if (opts?.fileOnly && kind !== "file") {
                throw new Error(`Error: inspect graph.${op} requires a file target`);
            }
            const input = await baseInput(ctx, target, signal, { needGraph: true });
            apply(p, input);
            const result = await executeInspectV4(input);
            return { value: projectInspectResult(result), evidence: result.workspaceEvidence };
        });
    };
}

function applyDiffTarget(p: Record<string, unknown>, input: InspectV4Input): void {
    const target = asString(p.target) ?? "unstaged";
    if (!DIFF_TARGETS.has(target)) throw new Error(`graph.diff requires target unstaged|staged|HEAD (got ${target})`);
    input.diff = target as DiffTarget;
}

function applyCallGraph(p: Record<string, unknown>, input: InspectV4Input): void {
    input.callDepth = Math.min(Math.max(Math.trunc(asNumber(p.depth) ?? 1), 1), 5);
    if (typeof p.direction === "string") input.callDirection = p.direction as CallDirection;
}

// ── builder ───────────────────────────────────────────────────────────

/**
 * Wrap an injected LSP provider so every navigation/diagnostics call
 * carries `timeoutMs = min(5000, remaining run budget)` (floored). This is
 * a real clamp at the `NavigationInput`/`DiagnosticsInput` boundary — the
 * one timeout channel script mode owns (§2).
 */
function clampProviderTimeouts(
    provider: LspInspectionProvider,
    budget: RunBudget,
): LspInspectionProvider {
    return {
        inspectNavigation: (input) =>
            provider.inspectNavigation({ ...input, timeoutMs: clampLspTimeoutMs(budget.remainingMs) }),
        inspectDiagnostics: (input) =>
            provider.inspectDiagnostics({ ...input, timeoutMs: clampLspTimeoutMs(budget.remainingMs) }),
    };
}

export function buildHostBindings(opts: HostBindingsOptions): ScriptHostApi {
    const ctx: BinderCtx = {
        budget: opts.budget,
        cwd: opts.cwd,
        sessionFilePath: opts.sessionFilePath,
        ...(opts.contextGraph ? { graphSource: opts.contextGraph } : {}),
        ...(opts.lspInspectionProvider
            ? { lspInspectionProvider: clampProviderTimeouts(opts.lspInspectionProvider, opts.budget) }
            : {}),
    };
    const api: ScriptHostApi = {
        grep: (pattern: unknown, o: unknown) => grepBinding(ctx, pattern, o),
        read: (path: unknown, o: unknown) => readBinding(ctx, path, o),
        inspectFile: (path: unknown, o: unknown) => inspectFileBinding(ctx, path, o),
        inspectDir: (path: unknown, o: unknown) => inspectDirBinding(ctx, path, o),
        lsp: {
            definition: makeFileLspOp(ctx, "definition"),
            references: makeFileLspOp(ctx, "references"),
            implementation: makeFileLspOp(ctx, "implementation"),
            hover: makeFileLspOp(ctx, "hover"),
            documentSymbols: makeFileLspOp(ctx, "documentSymbols"),
            workspaceSymbols: (params: unknown) => lspWorkspaceSymbols(ctx, params),
            prepareCallHierarchy: makeFileLspOp(ctx, "prepareCallHierarchy"),
            incomingCalls: makeFileLspOp(ctx, "incomingCalls"),
            outgoingCalls: makeFileLspOp(ctx, "outgoingCalls"),
        },
        graph: {
            impact: makeGraphOp(ctx, "impact", (_p, input) => {
                input.impact = true;
            }),
            deadCode: makeGraphOp(ctx, "deadCode", (_p, input) => {
                input.deadCode = true;
            }),
            callGraph: makeGraphOp(ctx, "callGraph", applyCallGraph, { fileOnly: true }),
            hotspots: makeGraphOp(ctx, "hotspots", (_p, input) => {
                input.hotspots = true;
            }),
            routes: makeGraphOp(ctx, "routes", (_p, input) => {
                input.routes = true;
            }),
            diff: makeGraphOp(ctx, "diff", applyDiffTarget),
            clusters: makeGraphOp(ctx, "clusters", (_p, input) => {
                input.clusters = true;
            }, { dirOnly: true }),
            layers: makeGraphOp(ctx, "layers", (_p, input) => {
                input.layers = true;
            }, { dirOnly: true }),
            boundaries: makeGraphOp(ctx, "boundaries", (_p, input) => {
                input.boundaries = true;
            }, { dirOnly: true }),
        },
    };

    // §1: freeze the exposed host API object (and namespaces) before
    // injection, so host-side code cannot monkey-patch bindings mid-run.
    // (Guest-side immutability is enforced separately in sandbox.ts via
    // non-writable, non-configurable prop definitions.)
    deepFreeze(api);
    return api;
}

function deepFreeze(api: ScriptHostApi): void {
    Object.freeze(api);
    Object.freeze(api.lsp);
    Object.freeze(api.graph);
    for (const fn of [api.grep, api.read, api.inspectFile, api.inspectDir, ...Object.values(api.lsp), ...Object.values(api.graph)]) {
        Object.freeze(fn);
    }
}
