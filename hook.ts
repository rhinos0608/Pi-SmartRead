/**
 * Repo-map hook — intercepts the first read/read-many/intent-read call
 * per repo/session to return a compact repo map for agent orientation.
 *
 * Design:
 *   - Wraps tools at registration time (no monkey-patching)
 *   - State keyed by normalized repo root (git root, or resolved cwd)
 *   - Rich state: mapShown, explicitlyCalled, inFlight promise
 *   - Concurrency guard: in-flight promise shared across concurrent callers
 *   - Failure non-blocking: pass through to original read with warning
 *   - Typed intercept response: caller cannot confuse with normal output
 *   - Explicit repo_map calls mark state, suppressing later hooks in that repo
 */
import type { TSchema } from "@sinclair/typebox";
import {
  createReadToolDefinition,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import path from "node:path";
import { RepoMap } from "./repomap.js";
import { ContextGraph } from "./context-graph.js";
import { getCoCommittedFiles, isRecentlyModified } from "./git-history.js";

// ── State types ───────────────────────────────────────────────────

interface RepoSessionState {
  /** Compact repo map was shown via interceptor */
  mapShown: boolean;
  /** repo_map was called explicitly by the agent */
  explicitlyCalled: boolean;
  /** In-flight generation promise (concurrency guard) */
  inFlight: Promise<{ map: string; stats: Record<string, unknown> } | null> | null;
}

/** Module-level state store, keyed by normalized repo root */
const sessionStates = new Map<string, RepoSessionState>();

// ── Key computation ───────────────────────────────────────────────

/**
 * Compute a stable repo/session key from a working directory.
 *
 * Prefers git root over raw cwd so that /repo and /repo/packages/foo
 * share the same key. Falls back to resolved absolute path.
 */
function computeRepoKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const gitRoot = findGitRoot(resolved);
  return gitRoot ?? resolved;
}

function findGitRoot(dir: string): string | null {
  let current = path.resolve(dir);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── State management ──────────────────────────────────────────────

function getOrCreateState(key: string): RepoSessionState {
  let state = sessionStates.get(key);
  if (!state) {
    state = { mapShown: false, explicitlyCalled: false, inFlight: null };
    sessionStates.set(key, state);
  }
  return state;
}

/**
 * Mark the repo map as explicitly called for a given cwd.
 * Called by repo_map tool after successful generation.
 * This suppresses the hook for subsequent reads in the same repo.
 *
 * Creates repo state if needed so an explicit repo_map call can
 * suppress the first read even before any read has occurred.
 */
export function markRepoMapExplicitlyCalled(cwd: string): void {
  const key = computeRepoKey(cwd);
  const state = getOrCreateState(key);
  state.explicitlyCalled = true;
}

// ── Intercept response ────────────────────────────────────────────

interface HookResponse {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

/**
 * Build a typed intercept response that clearly communicates
 * the original read was skipped and should be re-issued.
 */
function buildInterceptResponse(
  toolName: string,
  repoKey: string,
  compactMap: string,
  stats: Record<string, unknown>,
): HookResponse {
  return {
    content: [
      {
        type: "text" as const,
        text: [
          `[REPO MAP — ${toolName.toUpperCase()} INTERCEPTED]`,
          "",
          "The first file-read tool call in this repository was intercepted to provide",
          "a compact repository map for agent orientation. The original read was NOT executed.",
          "",
          compactMap || "[No source files found to map.]",
          "",
          "──",
          `Session key: ${repoKey}`,
          "Total files: " + String(stats.totalFiles ?? "?"),
          "Ranking method: " + String(stats.rankMethod ?? "?"),
          "",
          "Please re-issue your read call. Future reads will pass through normally.",
        ].join("\n"),
      },
    ],
    details: {
      intercepted: true,
      originalTool: toolName,
      repoKey,
      totalFiles: stats.totalFiles,
      totalTags: stats.totalTags,
      rankMethod: stats.rankMethod,
    },
  };
}

/**
 * Build a failure pass-through response — repo-map generation failed,
 * so the original read proceeds with a warning.
 */
function buildFailurePassthrough(
  originalResponse: unknown,
  errorMessage: string,
): HookResponse {
  const orig = originalResponse as HookResponse;
  return {
    content: orig?.content ?? [],
    details: {
      ...(orig?.details ?? {}),
      _repoMapHook: {
        failed: true,
        error: errorMessage,
      },
    },
  };
}

// ── Repo map generation ───────────────────────────────────────────

async function generateCompactMap(
  cwd: string,
  _signal?: AbortSignal,
): Promise<{ map: string; stats: Record<string, unknown> } | null> {
  try {
    const rm = new RepoMap(cwd);
    const result = await rm.getRepoMap({
      useImportBased: false,
      autoFallback: true,
      compact: true,
      mapTokens: 2048,
      verbose: false,
    });
    return { map: result.map, stats: result.stats as unknown as Record<string, unknown> };
  } catch {
    // Fall back to import-based if tree-sitter fails (autoFallback should handle this)
    try {
      const rm = new RepoMap(cwd);
      const result = await rm.getRepoMap({
        useImportBased: true,
        compact: true,
        mapTokens: 2048,
        verbose: false,
      });
      return { map: result.map, stats: result.stats as unknown as Record<string, unknown> };
    } catch (err) {
      return null;
    }
  }
}

// ── Interceptor logic ─────────────────────────────────────────────

async function interceptFirstRead(
  params: Record<string, unknown>,
  toolName: string,
  originalExecute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>,
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<unknown> {
  const cwd = path.resolve(params.directory as string ?? ctx.cwd);
  const key = computeRepoKey(cwd);
  const state = getOrCreateState(key);

  // ── Gate 1: skip-map escape hatch ──
  const p = params as Record<string, unknown>;
  const m = p._meta as Record<string, unknown> | undefined;
  if (m?.skipRepoMapHook) {
    return originalExecute(toolCallId, params, signal, onUpdate, ctx);
  }

  // ── Gate 2: map already shown or explicitly called ──
  if (state.mapShown || state.explicitlyCalled) {
    return originalExecute(toolCallId, params, signal, onUpdate, ctx);
  }

  // ── Gate 3: concurrency guard
  if (state.inFlight) {
    const result = await state.inFlight;
    if (result === null) {
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
    }
    return buildInterceptResponse(
      toolName,
      key,
      result.map,
      result.stats ?? { totalFiles: 0, totalTags: 0, rankMethod: "cached" },
    );
  }

  // ── Generate repo map with in-flight guard
  const generatePromise = generateCompactMap(cwd, signal);
  state.inFlight = generatePromise;

  try {
    const result = await generatePromise;
    state.inFlight = null;

    if (result === null || result.map === "") {
      const orig = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
      return buildFailurePassthrough(
        orig,
        result === null ? "repo-map generation failed" : "no source files found",
      );
    }

    state.mapShown = true;

    return buildInterceptResponse(toolName, key, result.map, result.stats);
  } catch (err) {
    state.inFlight = null;
    const orig = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
    return buildFailurePassthrough(orig, (err as Error).message);
  }
}

// ── Schema augmentation ───────────────────────────────────────────

/**
 * Augment a tool's parameter schema with the `_meta` hook-control field.
 *
 * Injects `_meta` as a flat property on the schema rather than using
 * TypeBox Intersect (which produces {allOf: [...]} that the framework
 * cannot flatten), so the model sees the full parameter shape.
 */
function augmentSchema(originalSchema: TSchema): TSchema {
  const schema = JSON.parse(JSON.stringify(originalSchema)) as Record<
    string,
    unknown
  >;
  const properties = (schema.properties as Record<string, unknown>) ?? {};
  properties._meta = {
    type: "object" as const,
    properties: {
      skipRepoMapHook: {
        type: "boolean" as const,
        description:
          "Hook-control: skip the repo-map orientation hook for this call",
      },
    },
  };
  schema.properties = properties;
  return schema as unknown as TSchema;
}

// ── Tool wrapping ─────────────────────────────────────────────────

/**
 * Wrap a read-like tool definition with the repo-map hook interceptor.
 *
 * The wrapped tool:
 *   - Has the same name, label, and description
 *   - Augments the parameter schema with `_meta` hook-control field
 *   - Intercepts the first read per repo/session to return a compact repo map
 *   - Passes through all subsequent calls normally
 */
function wrapReadTool(originalDef: ToolDefinition): ToolDefinition {
  const originalExecute = originalDef.execute.bind(originalDef) as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  const toolName = originalDef.name;

  return {
    name: originalDef.name,
    label: originalDef.label,
    description: originalDef.description,
    parameters: augmentSchema(originalDef.parameters as TSchema),

    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      return interceptFirstRead(
        params,
        toolName,
        originalExecute,
        toolCallId,
        signal,
        onUpdate,
        ctx,
      );
    },
  } as unknown as ToolDefinition;
}

// ── Registration ──────────────────────────────────────────────────

/**
 * Register the wrapped tools using ESM-compatible dynamic import.
 * Called from index.ts with explicitly constructed tool definitions.
 */
export function wrapReadManyTool(toolDef: ToolDefinition): ToolDefinition {
  return wrapReadTool(toolDef);
}

export function wrapIntentReadTool(toolDef: ToolDefinition): ToolDefinition {
  return wrapReadTool(toolDef);
}

// ── Contextual Read Interceptor ───────────────────────────────────

async function interceptContextualRead(
  params: Record<string, unknown>,
  originalExecute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>,
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<unknown> {
  // Execute the original read to get the file contents
  const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx) as HookResponse;

  if (!result || !Array.isArray(result.content)) {
    return result; // Unexpected format, return as is
  }

  const filePath = params.path as string;
  if (!filePath) {
    return result; // No path specified, shouldn't happen for read tool but just in case
  }

  const cwd = path.resolve(params.directory as string ?? ctx.cwd);
  const fullPath = path.resolve(cwd, filePath);

  if (!existsSync(fullPath)) {
    return result; // Original read likely failed too
  }

  const contextLines: string[] = [];
  contextLines.push("---");
  contextLines.push(`🔍 Context Map for ${filePath}:`);

  try {
    // 1. Structural Context (Imports, Calls, Definitions)
    const graph = new ContextGraph(cwd);
    // Don't force refresh every read to keep it fast, but do include symbols and calls
    await graph.buildContextGraph({ forceRefresh: false, includeSymbols: true, includeCalls: true });
    
    const neighbours = await graph.getFileNeighbours(fullPath, { includeSymbols: true, includeCalls: true });
    
    const importedBy = neighbours.filter(n => n.provenance.type === "imported_by").map(n => path.relative(cwd, n.path));
    const imports = neighbours.filter(n => n.provenance.type === "imports").map(n => path.relative(cwd, n.path));
    const calls = neighbours.filter(n => n.provenance.type === "calls").map(n => path.relative(cwd, n.path));
    const calledBy = neighbours.filter(n => n.provenance.type === "called_by").map(n => path.relative(cwd, n.path));

    if (importedBy.length > 0) contextLines.push(`• Imported by: ${importedBy.slice(0, 5).join(", ")}${importedBy.length > 5 ? "..." : ""}`);
    if (imports.length > 0) contextLines.push(`• Imports: ${imports.slice(0, 5).join(", ")}${imports.length > 5 ? "..." : ""}`);
    if (calledBy.length > 0) contextLines.push(`• Called by functions in: ${calledBy.slice(0, 5).join(", ")}${calledBy.length > 5 ? "..." : ""}`);
    if (calls.length > 0) contextLines.push(`• Calls functions in: ${calls.slice(0, 5).join(", ")}${calls.length > 5 ? "..." : ""}`);

    // 2. Temporal Context (Git History)
    const coCommits = await getCoCommittedFiles(cwd, fullPath);
    if (coCommits.length > 0) {
      const coCommitStrings = coCommits.map(c => `${path.relative(cwd, c.path)} (${Math.round(c.correlation * 100)}%)`);
      contextLines.push(`• Historically co-modified with: ${coCommitStrings.join(", ")}`);
    }
    
    if (await isRecentlyModified(cwd, fullPath)) {
      contextLines.push(`• Note: This file was recently modified.`);
    }

  } catch (err) {
    contextLines.push(`• Warning: Context generation failed (${(err as Error).message})`);
  }

  // Only append if we actually found meaningful context beyond the header
  if (contextLines.length > 2) {
    const textContent = result.content.find(c => c.type === "text");
    if (textContent) {
      textContent.text += "\n\n" + contextLines.join("\n");
    }
  }

  return result;
}

// ── Built-in read override ────────────────────────────────────────

/**
 * Factory for a `read` tool that overrides the built-in read when
 * registered via `pi.registerTool()`.
 *
 * The returned ToolDefinition:
 *   - Preserves the built-in read's name, label, description,
 *     promptSnippet, promptGuidelines, renderCall, and renderResult
 *   - Augments the parameter schema with a `_meta` hook-control field
 *   - On first read per repo/session: returns a compact repo map
 *     instructing the agent to re-issue the read
 *   - On subsequent reads: dynamically delegates to
 *     `createReadToolDefinition(ctx.cwd)` so the correct working
 *     directory is used at execution time (not at registration time)
 */
export function wrapBuiltinReadTool(): ToolDefinition {
  // Create a base definition to inherit renderCall/renderResult and
  // metadata properties.  The captured cwd (".") is never used for
  // file resolution — we override execute to create a fresh
  // definition with the actual ctx.cwd at call time.
  const baseDef = createReadToolDefinition(".");
  const toolName = baseDef.name;

  // Build the original execute delegate that creates a fresh
  // definition with the runtime cwd on every call.
  const createDelegatedExecute = (
    ctx: ExtensionContext,
  ): ((
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    _ctx: ExtensionContext,
  ) => Promise<unknown>) => {
    const freshDef = createReadToolDefinition(ctx.cwd);
    return freshDef.execute.bind(freshDef) as (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      _ctx: ExtensionContext,
    ) => Promise<unknown>;
  };

  return {
    name: baseDef.name,
    label: baseDef.label,
    description: baseDef.description,
    promptSnippet: baseDef.promptSnippet,
    promptGuidelines: baseDef.promptGuidelines,
    parameters: augmentSchema(baseDef.parameters as unknown as TSchema),
    renderCall: baseDef.renderCall,
    renderResult: baseDef.renderResult,

    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      // First wrap the base execute in our contextual read interceptor
      const contextualExecute = async (
        tId: string,
        p: Record<string, unknown>,
        sig: AbortSignal | undefined,
        onUp: unknown,
        context: ExtensionContext
      ) => {
        return interceptContextualRead(p, createDelegatedExecute(context), tId, sig, onUp, context);
      };

      // Then wrap that in the first-read interceptor
      return interceptFirstRead(
        params,
        toolName,
        contextualExecute,
        toolCallId,
        signal,
        onUpdate,
        ctx,
      );
    },
  } as unknown as ToolDefinition;
}
