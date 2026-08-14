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
import { Type, type Static } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import path from "node:path";
import { RepoMap } from "./repomap.js";
import {
   autoPopulateEdgeStore,
   buildStartupGitContext,
   findGitRoot as findGitRootAsync,
} from "./git-context.js";
import { loadGitContextConfig, validateEmbeddingConfig } from "./config.js";
import { formatBranchNotes, scanBranchNotes } from "./git-notes.js";
import {
   ensureHashlineReady,
   prefixLinesWithAnchors,
   selectorToOffsetLimit,
   splitPathAndSelector,
} from "./utils.js";
import { buildFileContextLines } from "./file-context.js";
import { computePathEvidence } from "./path-evidence.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { SMARTREAD_TOOL_GUIDE_TITLE, renderSmartReadToolGuide } from "./tool-guidance.js";
import { startResourceDiagnostics, stopResourceDiagnostics } from "./resource-diagnostics.js";
import {
  scanMicroagents as doScanMicroagents,
  matchMicroagents,
  renderMicroagentContext,
  type Microagent,
} from "./microagents.js";
import { findProjectWorkspace, isProjectWorkspace, projectWorkspaceForFile } from "./workspace-scope.js";
import { createReadManyTool } from "./read-many.js";
import { retrieveQuery } from "./query-retrieval.js";
import { disposeSemanticIndexes, effectiveSemanticRoot, getOrCreateSemanticIndex } from "./semantic-index-registry.js";

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

// ── Evidence comparison helper ────────────────────────────────────

/**
 * The builtin read appends a continuation note ONLY for user-limited,
 * non-truncated reads that stop before EOF (see pi-coding-agent
 * dist/core/tools/read.js). Rather than stripping note-shaped suffixes
 * (which could eat genuine file content), reconstruct the exact expected
 * note from the evidence-read state and accept only exact matches.
 * Any other shape → mismatch → the caller skips evidence (fail safe).
 */
export function shownMatchesAttested(args: {
   builtinText: string;
   truncationContent: string | undefined;
   sliceText: string;
   totalLines: number;
   evidenceOffset: number | undefined;
   evidenceLimit: number | undefined;
}): boolean {
   const { builtinText, truncationContent, sliceText, totalLines, evidenceOffset, evidenceLimit } = args;
   if (typeof truncationContent === "string") return truncationContent === sliceText;
   if (builtinText === sliceText) return true;
   if (evidenceLimit === undefined) return false;
   const startLine = evidenceOffset ?? 1;
   const endLine = Math.min(totalLines, startLine + evidenceLimit - 1);
   const remaining = totalLines - endLine;
   if (remaining <= 0) return false;
   const note = `\n\n[${remaining} more lines in file. Use offset=${endLine + 1} to continue.]`;
   return builtinText === sliceText + note;
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
   opts?: WrapReadToolOptions,
): Promise<unknown> {
   const filePath = params.path as string;
   if (!filePath) {
      return originalExecute(toolCallId, params, signal, onUpdate, ctx);
   }
   const embeddedSelector = typeof params.__smartReadSelector === "string"
      ? params.__smartReadSelector
      : undefined;
   const { path: targetPath, selector: pathSelector } = splitPathAndSelector(filePath);
   const selector = embeddedSelector ?? pathSelector;
   const selectorArgs = selectorToOffsetLimit(selector);
   const rawMode = selectorArgs.raw === true;
   const normalizedParams: Record<string, unknown> = { ...params, path: targetPath };
   delete normalizedParams.__smartReadSelector;
   if (selectorArgs.offset !== undefined) normalizedParams.offset = selectorArgs.offset;
   if (selectorArgs.limit !== undefined) normalizedParams.limit = selectorArgs.limit;

   const displayStartLine = selectorArgs.offset ?? (typeof params.offset === "number" ? params.offset : undefined) ?? 1;

   if (rawMode) {
      return originalExecute(toolCallId, normalizedParams, signal, onUpdate, ctx);
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
   const fullPath = path.resolve(ctx.cwd, targetPath);

   if (!existsSync(fullPath)) return result;

   // ── Workspace evidence ────────────────────────────────────────────
   // Emit the same strong path-mode envelope inspect produces so patch
   // can accept an evidenceRef from a plain read. Best-effort: never
   // blocks the read. Three review-blocker rules are enforced:
   //   1. Binding root: resolve targetPath against ctx.cwd, not the
   //      params.directory-derived cwd used for enrichment.
   //   2. Revalidation (TOCTOU): skip evidence when the attested slice
   //      (evidence.sliceText) differs from what the model was shown.
   //   3. Zero shown lines: firstLineExceedsLimit / invalid offset/limit
   //      → no evidence.
   const isImageResult = result.content.some((c: { type: string }) => c.type === "image");
   const sessionFilePath = sessionFileFromCtx(ctx);
   const builtinText = (result.content.find((c: { type: string }) => c.type === "text") as
      | { type: "text"; text: string }
      | undefined)?.text;
   if (sessionFilePath && !isImageResult && typeof builtinText === "string") {
      try {
         const truncation = (result.details as Record<string, unknown> | undefined)?.truncation as
            | { truncated?: boolean; outputLines?: number; firstLineExceedsLimit?: boolean; content?: string }
            | undefined;
         if (truncation?.firstLineExceedsLimit) throw new Error("zero lines shown");
         let evidenceOffset = typeof normalizedParams.offset === "number" ? normalizedParams.offset : undefined;
         let evidenceLimit = typeof normalizedParams.limit === "number" ? normalizedParams.limit : undefined;
         if (truncation?.truncated && typeof truncation.outputLines === "number") {
            // Truncated output must not claim full-file coverage: clamp the
            // evidence range to the lines the model actually saw.
            evidenceOffset = displayStartLine;
            evidenceLimit = truncation.outputLines;
         }
         const evidence = computePathEvidence({
            path: fullPath,
            ...(evidenceOffset !== undefined ? { offset: evidenceOffset } : {}),
            ...(evidenceLimit !== undefined ? { limit: evidenceLimit } : {}),
            cwd: ctx.cwd,
            sessionFilePath,
         });
         // Revalidate: only attest content the model actually saw. The
         // builtin read and computePathEvidence hit the disk at different
         // instants — if the file changed in between, skip evidence.
         const matches = shownMatchesAttested({
            builtinText,
            truncationContent: truncation?.truncated && typeof truncation.content === "string"
               ? truncation.content
               : undefined,
            sliceText: evidence.sliceText,
            totalLines: evidence.totalLines,
            evidenceOffset,
            evidenceLimit,
         });
         if (!matches) throw new Error("shown/attested content mismatch");
         if (!result.details || typeof result.details !== "object") result.details = {};
         (result.details as Record<string, unknown>).workspaceEvidence = evidence.workspaceEvidence;
         try {
            opts?.publishInspection?.(
               evidence.workspaceEvidence,
               sessionFilePath,
               evidence.workspaceEvidence.canonicalWorkspaceRoot,
            );
         } catch { /* publish is best-effort */ }
      } catch { /* evidence is best-effort */ }
   }

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

   // Find text content for anchor embedding and context appending
   const textContent = result.content.find(
      (c: { type: string }) => c.type === "text",
   ) as { type: "text"; text: string } | undefined;

   if (textContent) {
      const originalText = textContent.text;
      if (result.details && typeof result.details === "object") {
         (result.details as Record<string, unknown>).displayContent = {
            text: originalText,
            startLine: displayStartLine,
         };
      }
      // Embed hashline LINE+ID| anchors so the model can reference specific
      // lines via hashline-format edits (e.g., "42ab|function foo() {").
      // Only apply anchoring when content doesn't already have anchors.
      // Detect both legacy "42|" and hashline "42ab|" prefixes.
      const firstFewLines = textContent.text.split("\n", 5).join("\n");
      const alreadyAnchored = /^\d+[a-z]{0,2}\|/m.test(firstFewLines);
      if (!alreadyAnchored) {
         textContent.text = prefixLinesWithAnchors(textContent.text, displayStartLine);
      }

      // Preserve footer separately for internal batch reads. Batch packing must
      // keep source text separate from enrichment so evidence, cache, and line
      // numbering continue to describe only rendered file content.
      if (result.details && typeof result.details === "object" && contextLines.length > 0) {
         (result.details as Record<string, unknown>).contextFooter = contextLines.join("\n");
      }

      // Append contextual annotations to direct single-file output.
      if (contextLines.length > 0) {
         textContent.text += contextLines.join("\n");
      }
   }

   return result;
}

// ── Extended Read Schema ────────────────────────────────────────────

const ReadSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Path to a single file (relative or absolute). Use with optional offset/limit." })),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line. Single file mode only." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read. Single file mode only." })),
  paths: Type.Optional(Type.Array(
    Type.Object({
      path: Type.String({ description: "Path to the file (relative or absolute)" }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
    }),
    { minItems: 1, maxItems: 10000, description: "Multiple files to read in the exact order listed (max 10000)." },
  )),
  query: Type.Optional(Type.String({ description: "Natural-language intent. Ranks and reads most relevant files in cwd/directory. Falls back to grep+AST when semantic search unavailable." })),
  directory: Type.Optional(Type.String({ description: "Directory to scan (only with query; default: cwd)." })),
  topK: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Max files to return when query is set (default: 20)." })),
  stopOnError: Type.Optional(Type.Boolean({ description: "Stop on first error (default false)." })),
  symbol: Type.Optional(Type.String({ description: "Resolve qualified name (e.g. 'AuthService.login') to file+line via LSP, then read surrounding code."
  })),
});

type ReadInput = Static<typeof ReadSchema>;

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

/**
 * Factory for an extended `read` tool that supports three modes:
 *   - Single file: { path, offset?, limit? }
 *   - Multiple files: { paths: [{ path, offset?, limit? }, ...] }
 *   - Semantic search: { query, directory?, topK? }
 *
 * Every mode returns a `details.workspaceEvidence` envelope (schema v3)
 * that authorizes patch.
 */
export function createExtendedReadTool(opts?: WrapReadToolOptions): ToolDefinition {
  return {
    name: "read",
    label: "read",
    description: "Read files with strong workspace evidence. Single file: { path: \"src/auth.ts\" } or { path, offset, limit }. Multiple files: { paths: [{ path: \"a.ts\" }, { path: \"b.ts\" }] }. Query: { query: \"auth flow\" } — uses shared indexed BM25+embedding RRF and reads selected files, with grep+AST discovery only when semantic retrieval is unavailable. Batch evidence covers complete file blocks actually rendered; partial or omitted blocks are not authorized.",
    parameters: ReadSchema as unknown as Record<string, unknown>,

    async execute(
      toolCallId: string,
      params: ReadInput,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      // Symbol param takes precedence over path/query (spec §1.3)
      if (params.symbol !== undefined && params.symbol.trim().length > 0) {
        if (!opts?.resolveSymbol) {
          throw new Error(`Symbol "${params.symbol}" not found in workspace`);
        }
        const resolution = await opts.resolveSymbol(params.symbol, ctx.cwd);
        if (!resolution) {
          throw new Error(`Symbol "${params.symbol}" not found in workspace`);
        }
        const offset = resolution.line ? Math.max(1, resolution.line - 5) : params.offset;
        return interceptContextualRead(
          { path: resolution.path, offset, limit: params.limit } as Record<string, unknown>,
          createDelegatedExecute(ctx),
          toolCallId,
          signal,
          onUpdate,
          ctx,
          opts,
        );
      }

      const selectedModes = [params.path !== undefined, params.paths !== undefined, params.query !== undefined]
        .filter(Boolean).length;
      if (selectedModes !== 1) {
        throw new Error("Provide exactly one of: path, paths, or query");
      }

      const singleReadFactory = createEvidenceReadFactory(ctx);
      if (params.path !== undefined) {
        if (!params.path.trim()) throw new Error("path must not be empty");
        requirePositiveInteger(params.offset, "offset");
        requirePositiveInteger(params.limit, "limit");
        if (params.directory !== undefined || params.topK !== undefined || params.stopOnError !== undefined) {
          throw new Error("directory, topK, and stopOnError are not valid with path mode");
        }
        return interceptContextualRead(
          { path: params.path, offset: params.offset, limit: params.limit } as Record<string, unknown>,
          createDelegatedExecute(ctx),
          toolCallId,
          signal,
          onUpdate,
          ctx,
          opts,
        );
      }

      if (params.paths !== undefined) {
        if (params.paths.length === 0) throw new Error("paths must contain at least one file");
        for (const [index, request] of params.paths.entries()) {
          requirePositiveInteger(request.offset, `paths[${index}].offset`);
          requirePositiveInteger(request.limit, `paths[${index}].limit`);
        }
        if (params.offset !== undefined || params.limit !== undefined || params.directory !== undefined || params.topK !== undefined) {
          throw new Error("offset, limit, directory, and topK are not valid with paths mode");
        }
        const manyTool = createReadManyTool(singleReadFactory, { publishInspection: opts?.publishInspection });
        return manyTool.execute(toolCallId, {
          files: params.paths,
          stopOnError: params.stopOnError,
        } as never, signal, onUpdate as never, ctx);
      }

      const query = params.query!.trim();
      if (!query) throw new Error("query must not be empty or whitespace-only");
      requirePositiveInteger(params.topK, "topK");
      if (params.offset !== undefined || params.limit !== undefined || params.stopOnError !== undefined) {
        throw new Error("offset, limit, and stopOnError are not valid with query mode");
      }
      const retrieval = await retrieveQuery({
        query,
        cwd: ctx.cwd,
        directory: params.directory,
        topK: params.topK,
        signal,
        toolCallId,
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

      const manyTool = createReadManyTool(singleReadFactory, { publishInspection: opts?.publishInspection });
      const result = await manyTool.execute(toolCallId, {
        files: retrieval.hits.map((hit) => ({ path: hit.absolutePath })),
        stopOnError: false,
      } as never, signal, onUpdate as never, ctx);
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
 * Local helper: extract the canonical session file path from context.
 * Duplicated rather than imported from inspect-tool.ts to avoid the
 * import cycle (search-tool.ts ⟶ hook.ts ⟶ … ⟶ inspect-tool.ts ⟶ inspect.ts).
 */
function sessionFileFromCtx(ctx: ExtensionContext): string | null {
   try {
      const sm = (ctx as { sessionManager?: { getSessionFile?: () => string | undefined } }).sessionManager;
      if (!sm || typeof sm.getSessionFile !== "function") return null;
      const p = sm.getSessionFile();
      return typeof p === "string" && p.length > 0 ? p : null;
   } catch {
      return null;
   }
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
