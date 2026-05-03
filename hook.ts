/**
 * SmartRead hooks — contextual enrichment for the built-in read tool
 * and startup repo-map injection.
 *
 * Design:
 *   - Contextual enrichment wraps the built-in read tool's execute method
 *     to append import relationships, git recency, and structural context
 *     to every file read. Uses a shared cached ContextGraph (max 3 repos).
 *   - Startup repo-map injection uses pi's session_start + before_agent_start
 *     events to eagerly generate and inject a compact repo map into the
 *     system prompt on the first turn — no wasted tool calls.
 *   - repo_map explicit tool calls are independent from startup injection.
 *   - Failure non-blocking: enrichment failures append a warning, never
 *     block the original read.
 */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { createReadToolDefinition } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import path from "node:path";
import { RepoMap } from "./repomap.js";
import { ContextGraph } from "./context-graph.js";
import { isRecentlyModified } from "./git-history.js";
import { LruCache } from "./utils.js";

// ── Shared ContextGraph cache (module-level) ──
// Build once per repo, reuse across reads. Prevents O(repo_files * read_calls) parsing.
const contextualGraphCache = new LruCache<ContextGraph>(3);

// ── Key computation ───────────────────────────────────────────────

function findGitRoot(dir: string): string | null {
  let current = path.resolve(dir);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function computeRepoKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const gitRoot = findGitRoot(resolved);
  return gitRoot ?? resolved;
}

// ── Repo map generation (shared by startup hook) ──

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
    try {
      const rm = new RepoMap(cwd);
      const result = await rm.getRepoMap({
        useImportBased: true,
        compact: true,
        mapTokens: 2048,
        verbose: false,
      });
      return { map: result.map, stats: result.stats as unknown as Record<string, unknown> };
    } catch {
      return null;
    }
  }
}

// ── Startup repo-map injection (event-based) ──────────────────────

/**
 * Module-level cache of in-flight or resolved repo map generation.
 * Keyed by repo key (git root or resolved cwd).
 * before_agent_start awaits the promise if generation is still in-flight.
 */
const startupRepoMapCache = new Map<string, Promise<string | null>>();

/** Only inject the map once per session (across reloads/resumes etc.) */
let repoMapInjectedThisSession = false;

/**
 * Reset session state — for testing and explicit reload scenarios.
 * Clears the injected flag and repo map cache.
 */
export function resetSessionState(): void {
  repoMapInjectedThisSession = false;
  startupRepoMapCache.clear();
}

/**
 * Register session lifecycle hooks for startup repo-map injection.
 *
 * - session_start (reason=startup): eagerly starts repo map generation.
 * - before_agent_start (first turn only): injects the repo map into the
 *   system prompt before the agent's first turn.
 * - session_shutdown: resets the injected-flag for the next session.
 */
export function registerSessionHooks(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") return;
    const key = computeRepoKey(ctx.cwd);
    const promise = generateCompactMap(ctx.cwd).then((r) => r?.map ?? null);
    startupRepoMapCache.set(key, promise);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (repoMapInjectedThisSession) return;
    repoMapInjectedThisSession = true;

    const key = computeRepoKey(ctx.cwd);
    const mapPromise = startupRepoMapCache.get(key) ?? Promise.resolve(null);
    const map = await mapPromise;
    if (!map) return;

    return {
      systemPrompt: [
        event.systemPrompt,
        "",
        "## Repository Map",
        "The following is a compact overview of this repository's structure:",
        "",
        map,
      ].join("\n"),
    };
  });

  pi.on("session_shutdown", () => {
    repoMapInjectedThisSession = false;
  });
}

// ── Response types ────────────────────────────────────────────────

interface HookResponse {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

// ── Contextual read enrichment ────────────────────────────────────

/**
 * Intercept a successful read result and append contextual annotations.
 *
 * Enriches every built-in read call with:
 *   1. Import relationships (what imports this file, what it imports)
 *   2. Git recency (was the file recently modified?)
 *
 * The ContextGraph is built once per repo and cached across calls.
 * Failures append a warning line instead of blocking the read.
 */
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
  // Execute the original read first
  const result = (await originalExecute(
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  )) as HookResponse;

  // Only enrich text content results
  if (!result || !Array.isArray(result.content)) {
    return result;
  }

  const filePath = params.path as string;
  if (!filePath) return result;

  const cwd = path.resolve((params.directory as string) ?? ctx.cwd);
  const fullPath = path.resolve(cwd, filePath);

  if (!existsSync(fullPath)) return result;

  const contextLines: string[] = ["", "---", `🔍 Context for ${filePath}:`];

  try {
    // 1. Structural context via shared cached ContextGraph
    let graph = contextualGraphCache.get(cwd);
    if (!graph) {
      graph = new ContextGraph(cwd);
      contextualGraphCache.set(cwd, graph);
    }
    await graph.buildContextGraph({
      forceRefresh: false,
      includeSymbols: true,
      includeCalls: false,
    });

    const neighbours = await graph.getFileNeighbours(fullPath, {
      includeSymbols: false,
      includeCalls: false,
    });

    const importedBy = neighbours
      .filter((n) => n.provenance.type === "imported_by")
      .map((n) => path.relative(cwd, n.path));
    const imports = neighbours
      .filter((n) => n.provenance.type === "imports")
      .map((n) => path.relative(cwd, n.path));

    if (importedBy.length > 0)
      contextLines.push(
        `• Imported by: ${importedBy.slice(0, 8).join(", ")}${importedBy.length > 8 ? "…" : ""}`,
      );
    if (imports.length > 0)
      contextLines.push(
        `• Imports: ${imports.slice(0, 8).join(", ")}${imports.length > 8 ? "…" : ""}`,
      );

    // 2. Git recency
    if (await isRecentlyModified(cwd, fullPath)) {
      contextLines.push("• Recently modified (last 7 days).");
    }
  } catch (err) {
    contextLines.push(`• Context unavailable: ${(err as Error).message}`);
  }

  // Only append if we found useful context
  if (contextLines.length > 2) {
    const textContent = result.content.find(
      (c: { type: string }) => c.type === "text",
    ) as { type: "text"; text: string } | undefined;
    if (textContent) {
      textContent.text += contextLines.join("\n");
    }
  }

  return result;
}

// ── Built-in read override ────────────────────────────────────────

/**
 * Factory for a `read` tool that overrides the built-in read with
 * contextual enrichment.
 *
 * The returned ToolDefinition:
 *   - Preserves the built-in read's name, label, description,
 *     promptSnippet, promptGuidelines, renderCall, and renderResult
 *   - Delegates dynamically to createReadToolDefinition(ctx.cwd) so
 *     the correct working directory is used at execution time
 *   - Wraps every read with contextual annotations (imports, git recency)
 *
 * No first-read repo-map intercept — that is handled by registerSessionHooks().
 */
export function wrapBuiltinReadTool(): ToolDefinition {
  const baseDef = createReadToolDefinition(".");

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
    parameters: baseDef.parameters,
    renderCall: baseDef.renderCall,
    renderResult: baseDef.renderResult,

    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      // Wrap with contextual enrichment only
      return interceptContextualRead(
        params,
        createDelegatedExecute(ctx),
        toolCallId,
        signal,
        onUpdate,
        ctx,
      );
    },
  } as unknown as ToolDefinition;
}
