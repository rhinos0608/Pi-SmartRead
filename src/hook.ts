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
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { RepoMap } from "./repomap.js";
import {
   autoPopulateEdgeStore,
   buildStartupGitContext,
   findGitRoot as findGitRootAsync,
} from "./git/git-context.js";
import { loadGitContextConfig, validateEmbeddingConfig } from "./config.js";
import { formatBranchNotes, scanBranchNotes } from "./git/git-notes.js";
import {
   ensureHashlineReady,
} from "./utils.js";
import {
   applyTextEnrichment,
   attachPathEvidence,
   normalizeReadParams,
} from "./read/hook-enrich.js";
import { buildFileContextLines } from "./read/file-context.js";
import {
  attestStructuralOutline,
  publishEvidence,
  sessionFileFromCtx,
} from "./evidence/read-evidence.js";
import { resolveAstOutlineConfig, outlineSupportsPath, buildAstOutline, renderAstOutline } from "./structural/ast-outline.js";
import { getGraphifyEnricher } from "./graph/graphify-enricher.js";
import { SMARTREAD_TOOL_GUIDE_TITLE, renderSmartReadToolGuide } from "./runtime/tool-guidance.js";
import { startResourceDiagnostics, stopResourceDiagnostics } from "./runtime/resource-diagnostics.js";
import {
  scanMicroagents as doScanMicroagents,
  matchMicroagents,
  renderMicroagentContext,
  type Microagent,
} from "./runtime/microagents.js";
import { findProjectWorkspace, isProjectWorkspace, projectWorkspaceForFile } from "./workspace/workspace-scope.js";
import { createReadManyTool } from "./read/read-many.js";
import { retrieveQuery } from "./read/query-retrieval.js";
import { disposeSemanticIndexes, effectiveSemanticRoot, getOrCreateSemanticIndex } from "./indexing/semantic-index-registry.js";

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

const STARTUP_CONTEXT_WAIT_MS = 750;

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
   let timer: ReturnType<typeof setTimeout> | undefined;
   try {
      return await Promise.race([
         promise.catch(() => fallback),
         new Promise<T>((resolve) => {
            timer = setTimeout(() => resolve(fallback), timeoutMs);
         }),
      ]);
   } finally {
      if (timer) clearTimeout(timer);
   }
}

async function generateCompactMap(
   cwd: string,
   _signal?: AbortSignal,
): Promise<{ map: string; stats: Record<string, unknown> } | null> {
   let map: string | null = null;
   let stats: Record<string, unknown> = {};

   try {
      const rm = new RepoMap(cwd);
      const result = await rm.getRepoMap({
         useImportBased: true,
         autoFallback: false,
         compact: true,
         mapTokens: 2048,
         verbose: false,
      });
      map = result.map;
      stats = result.stats as unknown as Record<string, unknown>;
   } catch {
      try {
         const rm = new RepoMap(cwd);
         const result = await rm.getRepoMap({
            useImportBased: true,
            compact: true,
            mapTokens: 2048,
            verbose: false,
         });
         map = result.map;
         stats = result.stats as unknown as Record<string, unknown>;
      } catch {
         return null;
      }
   }

   // Enrich with graphify knowledge graph data (when available)
   try {
      const enricher = getGraphifyEnricher(cwd);
      if (enricher.isAvailable) {
         const s = enricher.stats;
         const sections: string[] = [
            "",
            "## Graph Knowledge",
            `The knowledge graph contains ${s?.nodeCount ?? "?"} concepts across ${s?.fileCount ?? "?"} files ` +
            `with ${s?.edgeCount ?? "?"} relationships in ${s?.communityCount ?? "?"} architectural clusters.`,
            "",
         ];

         // God nodes — core abstractions of the codebase
         const gods = enricher.getGodNodes(8);
         if (gods.length > 0) {
            sections.push("Core abstractions (most connected concepts):");
            for (const g of gods) {
               sections.push(`  • ${g.label} — ${g.degree} connections`);
            }
            sections.push("");
         }

         // Describe communities briefly — useful for high-level orientation
         if ((s?.communityCount ?? 0) > 1) {
            sections.push("Architectural clusters:");
            for (let cid = 0; cid < Math.min(s?.communityCount ?? 0, 8); cid++) {
               const files = enricher.getCommunityFiles(cid);
               if (files.length === 0) continue;
               // Pick representative filename stems for the community
               const stems = files
                  .map((f) => f.split("/").pop() ?? f)
                  .slice(0, 4);
               sections.push(`  • Cluster ${cid}: ${stems.join(", ")}${files.length > 4 ? ` (+${files.length - 4})` : ""}`);
            }
         }

         map = map ? map + "\n" + sections.join("\n") : sections.join("\n");
      }
   } catch {
      // Graphify enrichment is best-effort
   }

   return { map, stats };
}

// ── Startup repo-map injection (event-based) ──────────────────────

/**
 * Module-level cache of in-flight or resolved repo map generation.
 * Keyed by repo key (git root or resolved cwd).
 * before_agent_start awaits the promise if generation is still in-flight.
 */
const startupRepoMapCache = new Map<string, Promise<string | null>>();
const startupGitContextCache = new Map<string, Promise<{ contextString: string | null; notesString: string | null } | null>>();

/** Only inject the map once per session (across reloads/resumes etc.) */
let repoMapInjectedThisSession = false;
let searchLowResultHintShownThisSession = false;

/** Session-scoped git context cache for file-read path (avoids repeated config/root lookups) */
interface SessionGitCache {
   gitConfig: ReturnType<typeof loadGitContextConfig>;
   gitRoot: string | null;
}
let sessionGitCache: SessionGitCache | null = null;
let sessionGitCacheKey: string | null = null;

export function shouldShowLowResultHint(): boolean {
   if (searchLowResultHintShownThisSession) return false;
   searchLowResultHintShownThisSession = true;
   return true;
}

/**
 * Reset session state — for testing and explicit reload scenarios.
 * Clears the injected flag, repo map cache, and session-scoped search hints.
 */
export function resetSessionState(): void {
   repoMapInjectedThisSession = false;
   searchLowResultHintShownThisSession = false;
   startupRepoMapCache.clear();
   startupGitContextCache.clear();
   stopResourceDiagnostics();
   disposeSemanticIndexes();
   // ── Microagent cache ──────────────────────────────────────────────
   cachedMicroagents = [];
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
   pi.on("session_start", (_event, ctx) => {
      resetSessionState();
      startResourceDiagnostics(ctx.cwd);
      const key = computeRepoKey(ctx.cwd);
      const mapPromise = isProjectWorkspace(ctx.cwd)
         ? generateCompactMap(ctx.cwd).then((r) => r?.map ?? null)
         : Promise.resolve(null);
      const gitConfig = loadGitContextConfig(ctx.cwd);
      const gitBudget = gitConfig.tokenBudget.gitLog + gitConfig.tokenBudget.coCommitHotspots;
      const gitPromise = gitConfig.enabled ? buildStartupGitContext(ctx.cwd, gitBudget)
         .then(async (result) => {
            const gitRoot = result.coCommitPairs.length > 0 || result.branchCommits.length > 0
               ? await findGitRootAsync(ctx.cwd)
               : null;
            if (gitRoot && result.coCommitPairs.length > 0) {
               await autoPopulateEdgeStore(gitRoot, result.coCommitPairs);
            }
            if (!gitRoot || result.branchCommits.length === 0) {
               return { contextString: result.contextString, notesString: null };
            }

            const notes = await scanBranchNotes(gitRoot, result.branchCommits, gitConfig.notesRefs);
            const notesString = formatBranchNotes(notes, gitConfig.tokenBudget.gitNotes);
            return {
               contextString: result.contextString,
               notesString: notesString || null,
            };
         })
         .catch(() => null) : Promise.resolve(null);

      startupRepoMapCache.set(key, mapPromise);
      startupGitContextCache.set(key, gitPromise);

      // Cache git config/root for file-read path to avoid repeated lookups
      sessionGitCacheKey = key;
      sessionGitCache = { gitConfig, gitRoot: gitConfig.enabled ? findGitRoot(ctx.cwd) : null };

      // Scan microagents and cache them for the session
      cachedMicroagents = doScanMicroagents(ctx.cwd);

      // Start async semantic index warm-up (fire-and-forget, non-blocking).
      // Only for bounded project workspaces with embedding config.
      if (isProjectWorkspace(ctx.cwd)) {
        const projectRoot = findProjectWorkspace(ctx.cwd);
        const embedConfig = projectRoot ? validateEmbeddingConfig(projectRoot) : null;
        let semanticRoot: string | null = null;
        try {
          semanticRoot = projectRoot ? effectiveSemanticRoot(ctx.cwd, projectRoot) : null;
        } catch {
          // Invalid/disjoint boundary: skip advisory semantic warm-up.
        }
        if (semanticRoot && embedConfig) {
          const semIdx = getOrCreateSemanticIndex(semanticRoot, { config: embedConfig });
          semIdx.initialize().then(() => semIdx.updateIndex()).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            if (!/disposed during update/i.test(message)) {
              console.warn(`[Pi-SmartRead] semantic index warm-up unavailable: ${message}`);
            }
          });
        }
      }
   });

   pi.on("before_agent_start", async (event, ctx) => {
      if (repoMapInjectedThisSession) return;
      repoMapInjectedThisSession = true;

      const key = computeRepoKey(ctx.cwd);
      const [map, gitCtx] = await Promise.all([
         settleWithin(
            startupRepoMapCache.get(key) ?? Promise.resolve(null),
            STARTUP_CONTEXT_WAIT_MS,
            null,
         ),
         settleWithin(
            startupGitContextCache.get(key) ?? Promise.resolve(null),
            STARTUP_CONTEXT_WAIT_MS,
            null,
         ),
      ]);

      const rawSystemPrompt = (event as any).systemPrompt;
      const systemPromptParts = (Array.isArray(rawSystemPrompt) ? rawSystemPrompt : [rawSystemPrompt])
         .filter((part): part is string => typeof part === "string" && part.length > 0);

      const additions: string[] = [...systemPromptParts];

      additions.push("", `## ${SMARTREAD_TOOL_GUIDE_TITLE}`, renderSmartReadToolGuide());

      if (map) {
         additions.push("", "## Repository Map",
            "The following is a compact overview of this repository's structure:",
            "", map);
      }

      if (gitCtx?.contextString) {
         additions.push("", gitCtx.contextString);
      }

      if (gitCtx?.notesString) {
         additions.push("", gitCtx.notesString);
      }

      // Add alwaysLoad microagents to system prompt
      const alwaysLoadMicroagents = cachedMicroagents.filter(m => m.frontmatter.alwaysLoad);
      if (alwaysLoadMicroagents.length > 0) {
         additions.push("", renderMicroagentContext(alwaysLoadMicroagents));
      }

      return {
         systemPrompt: additions.join("\n"),
      };
   });

   pi.on("session_shutdown", () => {
    repoMapInjectedThisSession = false;
    searchLowResultHintShownThisSession = false;
    sessionGitCache = null;
    sessionGitCacheKey = null;
    stopResourceDiagnostics();
    disposeSemanticIndexes();
  });
}

// ── Response types ────────────────────────────────────────────────

interface HookResponse {
   content: { type: "text"; text: string }[];
   details: Record<string, unknown>;
}

// ── Read evidence attestation (Seam 3) lives in ./read-evidence.js ───
// Lifecycle, dispatch, enrichment, anchors, and microagents stay here.
// Re-exported so existing `import { shownMatchesAttested } from "./hook.js"`
// call sites keep working.
export { shownMatchesAttested } from "./evidence/read-evidence.js";

// ── Contextual read enrichment ────────────────────────────────────

/**
 * Attempt a structural AST outline for a large, unbounded, supported-
 * language read. Returns null on any unsupported/oversized/parse-failure
 * condition so the caller falls through to the normal full-file read.
 * Evidence is best-effort and, unlike a normal path read, never full-file:
 * only the rendered declaration lines are authorized (see
 * computeStructuralOutlineEvidence).
 */
async function tryStructuralOutlineRead(
   fullPath: string,
   targetPath: string,
   ctx: ExtensionContext,
   opts: WrapReadToolOptions | undefined,
): Promise<HookResponse | null> {
   try {
      const outlineConfig = resolveAstOutlineConfig();
      if (!outlineConfig.enabled) return null;
      if (!outlineSupportsPath(targetPath)) return null;

      const stat = statSync(fullPath);
      if (!stat.isFile() || stat.size <= outlineConfig.thresholdBytes) return null;

      const content = readFileSync(fullPath, "utf8");
      const outline = await buildAstOutline(content, targetPath);
      if (!outline) return null;

      const rendered = renderAstOutline(outline, targetPath, stat.size);
      const response: HookResponse = {
         content: [{ type: "text", text: rendered.text }],
         details: {
            structuralOutline: true,
            path: targetPath,
            symbolCount: rendered.symbolCount,
            renderedCount: rendered.renderedCount,
            totalLines: outline.totalLines,
         },
      };

      const sessionFilePath = sessionFileFromCtx(ctx);
      if (sessionFilePath && rendered.declarationLines.length > 0) {
         // attestStructuralOutline fails closed (null) but never throws:
         // the outline read still succeeds with or without evidence.
         const attested = attestStructuralOutline({
            path: targetPath,
            cwd: ctx.cwd,
            sessionFilePath,
            fullContent: content,
            declarationLines: rendered.declarationLines,
         });
         if (attested) {
            response.details.workspaceEvidence = attested.workspaceEvidence;
            publishEvidence(
               opts?.publishInspection,
               attested.workspaceEvidence,
               sessionFilePath,
               attested.workspaceEvidence.canonicalWorkspaceRoot,
            );
         }
      }

      return response;
   } catch {
      return null; // any failure degrades cleanly to the normal read path
   }
}

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
   opts?: WrapReadToolOptions,
   /** True only for the top-level single-path dispatch; false for symbol-mode
    * and internal batch reads, which must keep their existing read shape. */
   allowStructuralOutline = false,
): Promise<unknown> {
   const filePath = params.path as string;
   if (!filePath) {
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
   }
   // Selector/dispatch normalize lives in ./hook-enrich.js (no boundary gating).
   const { targetPath, rawMode, normalizedParams, displayStartLine } = normalizeReadParams(params);

   if (rawMode) {
      return originalExecute(toolCallId, normalizedParams, signal, onUpdate, ctx);
   }

   const fullPath = path.resolve(ctx.cwd, targetPath);

   // Unbounded reads of large supported source files get a compact AST
   // symbol outline instead of the full dump. Only the top-level single-path
   // dispatch opts in (allowStructuralOutline=true); symbol-mode and internal
   // batch reads keep their existing shape regardless of opts.
   const unbounded = normalizedParams.offset === undefined && normalizedParams.limit === undefined;
   if (allowStructuralOutline && unbounded) {
      const outlineResponse = await tryStructuralOutlineRead(fullPath, targetPath, ctx, opts);
      if (outlineResponse) return outlineResponse;
   }

   // Explicit paths may cross cwd/workspace; external tooling owns permission.
   const result = (await originalExecute(
      toolCallId,
      normalizedParams,
      signal,
      onUpdate,
      ctx,
   )) as HookResponse;

   // Only enrich text content results
   if (!result || !Array.isArray(result.content)) {
      return result;
   }

   // Ensure hashline engine is ready for anchor computation
   await ensureHashlineReady();

   const cwd = path.resolve((params.directory as string) ?? ctx.cwd);

   if (!existsSync(fullPath)) return result;

   // ── Workspace evidence ────────────────────────────────────────────
   // Same strong path-mode envelope inspect produces; best-effort, never
   // blocks the read. Binding root ctx.cwd, TOCTOU revalidation, and
   // zero-lines skip enforced in ./hook-enrich.js.
   const isImageResult = result.content.some((c: { type: string }) => c.type === "image");
   const sessionFilePath = sessionFileFromCtx(ctx);
   const builtinText = (result.content.find((c: { type: string }) => c.type === "text") as
      | { type: "text"; text: string }
      | undefined)?.text;
   attachPathEvidence({
      result,
      fullPath,
      cwd: ctx.cwd,
      sessionFilePath,
      builtinText,
      isImageResult,
      normalizedParams,
      displayStartLine,
      ...(opts?.publishInspection ? { publishInspection: opts.publishInspection } : {}),
   });

   // Enrichment footer: imports, git history, git notes, graph, LSP
   const repoKeyForGit = computeRepoKey(cwd);
   const fileProjectRoot = projectWorkspaceForFile(fullPath);
   const callerProjectRoot = projectWorkspaceForFile(ctx.cwd);
   const canReuseSessionGitCache = sessionGitCacheKey === repoKeyForGit
      && sessionGitCache !== null
      && fileProjectRoot !== null
      && fileProjectRoot === callerProjectRoot;
   const contextLines = await buildFileContextLines({
      fullPath,
      cwd,
      ...(canReuseSessionGitCache
         ? { gitConfig: sessionGitCache!.gitConfig, gitRoot: sessionGitCache!.gitRoot }
         : {}),
   });

   // Anchors + footer assembly lives in ./hook-enrich.js; preserves
   // displayContent snapshot, anchor skip, and contextFooter separation so
   // batch packing/evidence/cache still describe rendered file content only.
   applyTextEnrichment(result, displayStartLine, contextLines);

   return result;
}

// ── Extended Read Schema ────────────────────────────────────────────
// Four read modes share one flattened schema: the required selector key
// (path | paths | query | symbol) discriminates. The mode XOR and
// per-branch foreign-key rejection are enforced at runtime by the
// selectedModes check and rejectForeignKeys below.

const PathEntrySchema = Type.Object({
  path: Type.String({ description: "Path to the file (relative or absolute)" }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
}, { additionalProperties: false });

// Flattened schema — providers (e.g. Console Go upstream) require a root
// JSON Schema of type "object" and reject anyOf unions at the top level.
// The four-mode XOR is enforced at runtime in execute() + rejectForeignKeys.
const ReadSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Path to a single file (relative or absolute). Use with optional offset/limit." })),
  paths: Type.Optional(Type.Array(PathEntrySchema, { minItems: 1, maxItems: 100, description: "Multiple files to read in the exact order listed (max 100)." })),
  stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first error (paths mode; default false)." })),
  query: Type.Optional(Type.String({ description: "Natural-language intent. Ranks and reads most relevant files in cwd/directory. Falls back to grep+AST when semantic search unavailable." })),
  directory: Type.Optional(Type.String({ description: "Directory to scan (only with query; default: cwd)." })),
  topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max files to return when query is set (default: 20)." })),
  symbol: Type.Optional(Type.String({ description: "Resolve qualified name (e.g. 'AuthService.login') to file+line via LSP, then read surrounding code." })),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line. Single-file and symbol modes only." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines. Single-file and symbol modes only." })),
}, {
  additionalProperties: false,
  description: "Read modes: { path, offset?, limit? } single file; { paths, stopOnError? } batch; { query, directory?, topK? } intent; { symbol, offset?, limit? } symbol. Exactly one selector per call.",
});

type ReadInput = ReadParams;

export interface SingleFileReadParams { path: string; offset?: number; limit?: number; }
export interface MultiFileReadParams { paths: { path: string; offset?: number; limit?: number; }[]; stopOnError?: boolean; }
export interface QueryReadParams { query: string; directory?: string; topK?: number; }
export interface SymbolReadParams { symbol: string; offset?: number; limit?: number; }
export type ReadParams = SingleFileReadParams | MultiFileReadParams | QueryReadParams | SymbolReadParams;

/** Reject keys that do not belong to this branch — the runtime half of the discriminated union. */
function rejectForeignKeys(raw: Record<string, unknown>, selector: string, allowed: ReadonlySet<string>): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return `Error: read param "${key}" is not valid with "${selector}" mode`;
    }
  }
  return undefined;
}

const PATH_KEYS: ReadonlySet<string> = new Set(["path", "offset", "limit"]);
const PATHS_KEYS: ReadonlySet<string> = new Set(["paths", "stopOnError"]);
const QUERY_KEYS: ReadonlySet<string> = new Set(["query", "directory", "topK"]);
const SYMBOL_KEYS: ReadonlySet<string> = new Set(["symbol", "offset", "limit"]);

// ── WrapReadToolOptions ──────────────────────────────────────────

/**
 * Symbol resolution result from LSP or ContextGraph fallback.
 */
export interface SymbolResolution {
   path: string;
   line?: number;
}

export interface WrapReadToolOptions {
   readonly publishInspection?: (envelope: unknown, sessionFilePath: string, workspaceRoot: string) => void;
   /**
    * Resolve a qualified symbol name to a file path and optional line number.
    * Injected by WP-5 from LSP bridge + ContextGraph fallback.
    * Resolution order: LSP exact qualified-name match first, then
    * ContextGraph.findSymbolFiles() fallback.
    */
   readonly resolveSymbol?: (symbol: string, cwd?: string) => Promise<SymbolResolution | null>;
}

function requirePositiveInteger(value: unknown, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

interface ReadBranchCtx {
  toolCallId: string;
  signal: AbortSignal | undefined;
  onUpdate: unknown;
  ctx: ExtensionContext;
  opts?: WrapReadToolOptions;
}

async function handleSymbolRead(symbol: SymbolReadParams, b: ReadBranchCtx): Promise<unknown> {
  const raw = symbol as unknown as Record<string, unknown>;
  const foreignErr = rejectForeignKeys(raw, "symbol", SYMBOL_KEYS);
  if (foreignErr) throw new Error(foreignErr);
  if (!symbol.symbol.trim()) throw new Error("symbol must not be empty");
  requirePositiveInteger(symbol.offset, "offset");
  requirePositiveInteger(symbol.limit, "limit");
  if (!b.opts?.resolveSymbol) {
    throw new Error(`Symbol "${symbol.symbol}" not found in workspace`);
  }
  const resolution = await b.opts.resolveSymbol(symbol.symbol, b.ctx.cwd);
  if (!resolution) {
    throw new Error(`Symbol "${symbol.symbol}" not found in workspace`);
  }
  const offset = resolution.line ? Math.max(1, resolution.line - 5) : symbol.offset;
  return interceptContextualRead(
    { path: resolution.path, offset, limit: symbol.limit } as Record<string, unknown>,
    createDelegatedExecute(b.ctx),
    b.toolCallId,
    b.signal,
    b.onUpdate,
    b.ctx,
    b.opts,
  );
}

async function handleSingleRead(single: SingleFileReadParams, b: ReadBranchCtx): Promise<unknown> {
  const raw = single as unknown as Record<string, unknown>;
  const foreignErr = rejectForeignKeys(raw, "path", PATH_KEYS);
  if (foreignErr) throw new Error(foreignErr);
  if (!single.path.trim()) throw new Error("path must not be empty");
  requirePositiveInteger(single.offset, "offset");
  requirePositiveInteger(single.limit, "limit");
  return interceptContextualRead(
    { path: single.path, offset: single.offset, limit: single.limit } as Record<string, unknown>,
    createDelegatedExecute(b.ctx),
    b.toolCallId,
    b.signal,
    b.onUpdate,
    b.ctx,
    b.opts,
    true, // top-level single-path dispatch: eligible for the large-file outline
  );
}

async function handlePathsRead(multi: MultiFileReadParams, b: ReadBranchCtx): Promise<unknown> {
  const raw = multi as unknown as Record<string, unknown>;
  const foreignErr = rejectForeignKeys(raw, "paths", PATHS_KEYS);
  if (foreignErr) throw new Error(foreignErr);
  if (multi.paths.length === 0) throw new Error("paths must contain at least one file");
  for (const [index, request] of multi.paths.entries()) {
    requirePositiveInteger(request.offset, `paths[${index}].offset`);
    requirePositiveInteger(request.limit, `paths[${index}].limit`);
  }
  const singleReadFactory = createEvidenceReadFactory(b.ctx);
  const manyTool = createReadManyTool(singleReadFactory, { publishInspection: b.opts?.publishInspection });
  return manyTool.execute(b.toolCallId, {
    files: multi.paths,
    stopOnError: multi.stopOnError,
  } as never, b.signal, b.onUpdate as never, b.ctx);
}

async function handleQueryRead(queryParams: QueryReadParams, b: ReadBranchCtx): Promise<unknown> {
  const raw = queryParams as unknown as Record<string, unknown>;
  const foreignErr = rejectForeignKeys(raw, "query", QUERY_KEYS);
  if (foreignErr) throw new Error(foreignErr);
  const query = queryParams.query.trim();
  if (!query) throw new Error("query must not be empty or whitespace-only");
  requirePositiveInteger(queryParams.topK, "topK");
  const retrieval = await retrieveQuery({
    query,
    cwd: b.ctx.cwd,
    directory: queryParams.directory,
    topK: queryParams.topK,
    signal: b.signal,
    toolCallId: b.toolCallId,
  });
  if (retrieval.hits.length === 0) {
    return {
      content: [{ type: "text" as const, text: `[No ${retrieval.strategy} matches for "${query}".]` }],
      details: {
        query,
        retrievalStrategy: retrieval.strategy,
        ...(retrieval.strategy === "fallback" ? { fallbackReason: retrieval.reason } : {}),
        processedCount: 0,
        successCount: 0,
        errorCount: 0,
      },
    };
  }
  const singleReadFactory = createEvidenceReadFactory(b.ctx);
  const manyTool = createReadManyTool(singleReadFactory, { publishInspection: b.opts?.publishInspection });
  const result = await manyTool.execute(b.toolCallId, {
    files: retrieval.hits.map((hit) => ({ path: hit.absolutePath })),
    stopOnError: false,
  } as never, b.signal, b.onUpdate as never, b.ctx);
  const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
  return {
    ...result,
    details: {
      ...details,
      query,
      retrievalStrategy: retrieval.strategy,
      ...(retrieval.strategy === "fallback" ? { fallbackReason: retrieval.reason } : {}),
    },
  };
}

/**
 * Factory for an extended `read` tool that supports three modes:
 *   - Single file: { path, offset?, limit? }
 *   - Multiple files: { paths: [{ path, offset?, limit? }, ...] }
 *   - Semantic search: { query, directory?, topK? }
 *
 * Every mode returns a versioned `details.workspaceEvidence` envelope
 * with coverage semantics that determine patch authority.
 */
export function createExtendedReadTool(opts?: WrapReadToolOptions): ToolDefinition {
  return {
    name: "read",
    label: "read",
    description: "Read files with strong workspace evidence. Single file: { path: \"src/auth.ts\" } or { path, offset, limit }. Multiple files: { paths: [{ path: \"a.ts\" }, { path: \"b.ts\" }] }. Query: { query: \"auth flow\" } — uses shared indexed BM25+embedding RRF and reads selected files, with grep+AST discovery only when semantic retrieval is unavailable. Batch evidence covers complete file blocks actually rendered; partial or omitted blocks are not authorized. Large supported source files read without offset/limit return a compact AST symbol outline (signatures + line ranges, no bodies) instead of the full file — use offset/limit or symbol to read a specific part. Chasing a multi-hop lead across dependent grep/read/inspect calls? Compose the chase in one call with `inspect({ mode: \"script\", script })`.",
    parameters: ReadSchema as unknown as Record<string, unknown>,

    async execute(
      toolCallId: string,
      params: ReadInput,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const raw = params as unknown as Record<string, unknown>;
      const hasPath = raw.path !== undefined;
      const hasPaths = raw.paths !== undefined;
      const hasQuery = raw.query !== undefined;
      const hasSymbol = raw.symbol !== undefined;
      const selectedModes = [hasPath, hasPaths, hasQuery, hasSymbol].filter(Boolean).length;
      if (selectedModes !== 1) {
        throw new Error("Provide exactly one of: path, paths, query, or symbol");
      }

      const branch: ReadBranchCtx = { toolCallId, signal, onUpdate, ctx, opts };
      if (hasSymbol) return handleSymbolRead(params as SymbolReadParams, branch);
      if (hasPath) return handleSingleRead(params as SingleFileReadParams, branch);
      if (hasPaths) return handlePathsRead(params as MultiFileReadParams, branch);
      // hasQuery implied by the selectedModes check above
      return handleQueryRead(params as QueryReadParams, branch);
    },
  } as unknown as ToolDefinition;
}

function createEvidenceReadFactory(
  ctx: ExtensionContext,
): typeof import("@mariozechner/pi-coding-agent").createReadTool {
  return (() => ({
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
    ) => interceptContextualRead(
      params,
      createDelegatedExecute(ctx),
      toolCallId,
      signal,
      onUpdate,
      ctx,
      // Internal reads expose evidence to the batch aggregator but do not publish
      // per-file envelopes; only the final rendered batch is published.
      undefined,
    ),
  })) as unknown as typeof import("@mariozechner/pi-coding-agent").createReadTool;
}

/**
 * Build the original execute delegate that creates a fresh
 * definition with the runtime cwd on every call.
 */
function createDelegatedExecute(
  ctx: ExtensionContext,
): (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  _ctx: ExtensionContext,
) => Promise<unknown> {
  const freshDef = createReadToolDefinition(ctx.cwd);
  return freshDef.execute.bind(freshDef) as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    _ctx: ExtensionContext,
  ) => Promise<unknown>;
}

// ── Microagent system ──────────────────────────────────────────────

/** Module-level cache of scanned microagents (scanned once per session) */
let cachedMicroagents: Microagent[] = [];

/**
 * Export for other tools to retrieve matching microagent context.
 * Returns rendered microagent context string, or null if no matches.
 *
 * @param query - Query string to match against microagent triggers
 * @returns Rendered context string or null if no matching agents
 */
export function getMatchingMicroagents(query: string): string | null {
   const matched = matchMicroagents(cachedMicroagents, query);
   if (matched.length === 0) return null;
   return renderMicroagentContext(matched);
}

/**
 * Export cached microagents (for testing/debugging).
 */
export function getCachedMicroagents(): Microagent[] {
   return cachedMicroagents;
}
