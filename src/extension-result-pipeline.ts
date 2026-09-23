/**
 * Extension result pipeline — ordered named transforms for tool events.
 *
 * Preserves the original src/index.ts semantics:
 * - tool_call returns undefined (side-effect only)
 * - tool_result returns undefined when unchanged, early-returns when a
 *   guard rewrites content (skipping later transforms)
 * - context returns undefined when messages are identical
 * - successful-mutation invalidation order: fs-scan → semantic →
 *   incremental → graph; failed results never mutate state
 * - all advisory fallbacks are best-effort and never block the result
 */
import { resolve as pathResolve } from "node:path";
import { canonicalPathOrFallback } from "./canonical-path.js";
import { coerceText } from "./utils.js";
import {
  buildContextHygieneMetadata,
  buildFileResource,
  recordAnchorDelta,
  type AnchorDeltaEntry,
  type AnchorHygieneEvent,
  type ContextHygieneMetadata,
  type ContextHygieneResource,
} from "./runtime/context-hygiene.js";
import { applyContextHygieneStaleContext } from "./runtime/context-application.js";
import {
  consumeDoomLoopWarning,
  formatDoomLoopMessage,
  recordToolCall,
  recordToolResult,
} from "./runtime/doom-loop.js";
import {
  applyBashContextGuard,
  resolveGuardProfile,
  suggestShellCommands,
} from "./runtime/bash-context-guard.js";
import { invalidateFsScanCache } from "./workspace/fs-scan-cache.js";
import {
  canonicalizeWorkspaceRoot,
  validateMutationDetails,
  type MutationDetails,
} from "@rhinos0608/pi-workspace-protocol";
import { getLSPBridge } from "./lsp/lsp-bridge.js";
import { invalidateSharedGraph } from "./mcp-registry.js";
import { getSemanticIndex } from "./indexing/semantic-index-registry.js";
import { getIncrementalIndex } from "./indexing/incremental-index.js";
import { runPostEditDiagnosticsFallback } from "./runtime/post-edit-fallback.js";
import { runPostEditImpactSummary } from "./runtime/post-edit-impact.js";
import { isDiagnosticsClaimed } from "./runtime/mutation-ownership.js";
import type { ActivationState } from "./extension-lifecycle.js";

const SMARTREAD_GUARD_TOOLS = new Set(["inspect", "git_notes_read"]);

// ── Helpers ──────────────────────────────────────────────────────────

function canonicalResourcePath(rawPath: string, workspaceRoot = process.cwd()): string {
  const root = canonicalizeWorkspaceRoot(workspaceRoot);
  return canonicalPathOrFallback(pathResolve(root, rawPath));
}

export function resourcesForTool(
  _toolName: string,
  input: Record<string, unknown>,
  workspaceRoot = process.cwd(),
): ContextHygieneResource[] {
  const path = typeof input.path === "string" ? input.path : undefined;
  if (path) return [buildFileResource(canonicalResourcePath(path, workspaceRoot))];
  if (typeof input.filePath === "string") return [buildFileResource(canonicalResourcePath(input.filePath, workspaceRoot))];
  if (typeof input.relative_path === "string") return [buildFileResource(canonicalResourcePath(input.relative_path, workspaceRoot))];
  return [];
}

/**
 * Extract authoritative mutation paths from a tool result's
 * `details.changedResources[*].canonicalPath`. Untrusted runtime data, so
 * shape and string-ness are validated; malformed entries are dropped.
 */
function mutationDetailsFromDetails(details: unknown): MutationDetails | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = validateMutationDetails(details);
  return value.ok ? value.value : undefined;
}

/** Extract paths only from protocol-valid, applied mutation details. */
export function changedPathsFromDetails(details: unknown): string[] {
  const mutation = mutationDetailsFromDetails(details);
  if (mutation) {
    return mutation.status.kind === "applied"
      ? mutation.changedResources.map((resource) => resource.canonicalPath)
      : [];
  }
  // Native write/edit results do not carry MutationDetails. Keep their
  // existing changedResources contract; malformed lifecycle-shaped details
  // fail closed above rather than being treated as an applied mutation.
  if (details && typeof details === "object" && ("tool" in details || "status" in details)) return [];
  const changedResources = (details as Record<string, unknown> | null)?.changedResources;
  if (!Array.isArray(changedResources)) return [];
  return changedResources.flatMap((resource) => {
    if (!resource || typeof resource !== "object") return [];
    const path = (resource as Record<string, unknown>).canonicalPath;
    return typeof path === "string" && path.length > 0 ? [path] : [];
  });
}

function mutationApplied(details: unknown): boolean | undefined {
  const mutation = mutationDetailsFromDetails(details);
  return mutation ? mutation.status.kind === "applied" : undefined;
}

export function mutationResourcesForTool(
  toolName: string,
  input: Record<string, unknown>,
  changedPaths: string[],
  workspaceRoot = process.cwd(),
): ContextHygieneResource[] {
  if (toolName === "graph_mutate") {
    const resources: ContextHygieneResource[] = [];
    if (typeof input.from === "string") resources.push(buildFileResource(canonicalResourcePath(input.from, workspaceRoot)));
    if (typeof input.to === "string") resources.push(buildFileResource(canonicalResourcePath(input.to, workspaceRoot)));
    return resources;
  }
  if (toolName === "write" || toolName === "edit" || toolName === "transfer") {
    // changedResources.canonicalPath is authoritative for edit/transfer results when present.
    if (changedPaths.length > 0) return changedPaths.map((p) => buildFileResource(canonicalResourcePath(p, workspaceRoot)));
    return resourcesForTool(toolName, input, workspaceRoot);
  }
  return [];
}

export function classificationForTool(toolName: string): ContextHygieneMetadata["classification"] {
  if (toolName === "graph_mutate" || toolName === "write" || toolName === "edit" || toolName === "transfer") return "mutation";
  if (toolName === "bash") return "command-output";
  return "read-context";
}

// ── Pipeline state ───────────────────────────────────────────────────

interface PipelineState {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  details: Record<string, unknown>;
  changedPaths: string[];
  outputEvent: any;
  outputChanged: boolean;
}

// ── Named transforms (executed in order) ─────────────────────────────

function recordMutationOrRead(state: ActivationState, s: PipelineState): void {
  const event = s.outputEvent;
  const lifecycleApplied = mutationApplied(s.details);
  const failedMutation =
    (lifecycleApplied !== undefined ? !lifecycleApplied : event.isError) &&
    (s.toolName === "write" || s.toolName === "edit" || s.toolName === "transfer" || s.toolName === "graph_mutate");
  const mutationResources = failedMutation
    ? []
    : mutationResourcesForTool(s.toolName, s.input, s.changedPaths, process.cwd());
  if (mutationResources.length > 0) {
    state.hygieneTracker.recordMutation(mutationResources, { resultId: s.toolCallId, tool: s.toolName });
    return;
  }
  const metadata = buildContextHygieneMetadata({
    tool: s.toolName,
    classification: failedMutation ? "read-context" : classificationForTool(s.toolName),
    resources: failedMutation ? [] : resourcesForTool(s.toolName, s.input, process.cwd()),
  });
  state.hygieneTracker.record(metadata, { resultId: s.toolCallId });
}

function anchorPathsForEdit(s: PipelineState): string[] {
  if (s.changedPaths.length > 0) return s.changedPaths;
  if (typeof s.input.path === "string") return [s.input.path];
  return [];
}

function recordAnchorDeltaStep(state: ActivationState, s: PipelineState): void {
  if (s.toolName !== "edit" || s.outputEvent.isError || !s.details.anchorDelta) return;
  const ad = s.details.anchorDelta as {
    summary: string;
    shifted: number;
    deleted: number;
    changed: number;
  };
  const totalChanges = (ad.shifted || 0) + (ad.deleted || 0) + (ad.changed || 0);
  if (totalChanges <= 0) return;
  for (const filePath of anchorPathsForEdit(s)) {
    const entries: AnchorDeltaEntry[] = [];
    const event_: AnchorHygieneEvent = {
      file: filePath,
      timestamp: Date.now(),
      deltas: entries,
      churnExceeded: totalChanges > 20,
    };
    try {
      recordAnchorDelta(state.hygieneTracker, event_);
    } catch {
      // Anchor delta recording is advisory
    }
  }
}

export function recordHygieneAndAnchor(state: ActivationState, s: PipelineState): void {
  if (!s.toolCallId) return;
  recordMutationOrRead(state, s);
  // Anchor hygiene: consume anchor delta from edit results
  recordAnchorDeltaStep(state, s);
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v ? v : undefined;
}

async function closeLspFiles(paths: string[], root: string): Promise<void> {
  if (paths.length === 0) return;
  try {
    const bridge = await getLSPBridge();
    if (!bridge) return;
    await Promise.all(paths.map((p) => bridge.closeFile(p, root).catch(() => {})));
  } catch {
    // LSP tracking is best-effort; never block the tool result.
  }
}

async function trackReadDocument(lspInput: Record<string, unknown>): Promise<void> {
  const readPath = stringField(lspInput, "path") ?? stringField(lspInput, "filePath");
  if (!readPath) return;
  // Shared canonicalizer only — direct reads stay ungated by
  // PI_SMARTREAD_ALLOWED_ROOT. A resolution failure propagates (no
  // process.cwd() fallback); bridge failures stay best-effort below.
  const root = canonicalizeWorkspaceRoot(process.cwd());
  await getLSPBridge()
    .then((bridge) => bridge?.openFile(readPath, root))
    .catch(() => {});
}

function trackGraphMutateClose(lspInput: Record<string, unknown>): Promise<void> {
  const closePaths = [stringField(lspInput, "from"), stringField(lspInput, "to")].filter(
    (p): p is string => typeof p === "string",
  );
  if (closePaths.length === 0) return Promise.resolve();
  const root = stringField(lspInput, "root") ?? process.cwd();
  return closeLspFiles(closePaths, root);
}

function trackMutationClose(s: PipelineState, lspInput: Record<string, unknown>): Promise<void> {
  if (s.outputEvent.isError) return Promise.resolve();
  if (mutationApplied(s.details) === false) return Promise.resolve();
  const editPaths =
    s.changedPaths.length > 0 ? s.changedPaths : stringField(lspInput, "path") ? [lspInput.path as string] : [];
  return closeLspFiles(editPaths, process.cwd());
}

export async function trackLspDocuments(s: PipelineState): Promise<void> {
  if (!s.toolCallId || !s.outputEvent.input) return;
  const lspInput = s.outputEvent.input as Record<string, unknown>;
  if (s.toolName === "read") {
    await trackReadDocument(lspInput);
    return;
  }
  if (s.toolName === "graph_mutate") {
    await trackGraphMutateClose(lspInput);
    return;
  }
  if (s.toolName === "write" || s.toolName === "edit" || s.toolName === "transfer") await trackMutationClose(s, lspInput);
}

const CACHE_INVALIDATING_MUTATION_TOOLS = new Set(["write", "edit", "transfer", "graph_mutate"]);

/**
 * Centralized successful mutation invalidation. Only successful
 * write/edit/transfer/graph_mutate results invalidate caches. Failed tool results
 * must NOT mutate state. Order per target: fs-scan → semantic, then
 * incremental once, then graph. graph_mutate invalidates the graph only.
 */
export function invalidateCachesOnMutation(s: PipelineState): void {
  if (!CACHE_INVALIDATING_MUTATION_TOOLS.has(s.toolName)) return;
  const applied = mutationApplied(s.details);
  if (applied === false || (applied === undefined && s.outputEvent.isError)) return;
  if (s.toolName === "graph_mutate") {
    // Graph mutation must cause a graph rebuild on next use.
    invalidateSharedGraph();
    return;
  }
  const targets =
    (s.toolName === "edit" || s.toolName === "transfer") && s.changedPaths.length > 0
      ? s.changedPaths
      : [s.input.path, s.input.filePath, s.input.relative_path].filter(
          (p): p is string => typeof p === "string",
        );
  for (const target of targets) {
    invalidateFsScanCache(target);
    try {
      const semIdx = getSemanticIndex(process.cwd());
      if (semIdx && typeof semIdx.markFilesStale === "function") {
        semIdx.markFilesStale([target]);
      }
    } catch {
      // semantic invalidation is advisory
    }
  }
  try {
    getIncrementalIndex(process.cwd()).invalidate();
  } catch {
    // incremental-index invalidation is advisory
  }
  // A successful write/edit invalidates the graph: it must be rebuilt
  // on next graph-dependent use (revision-based, not a boolean flag).
  invalidateSharedGraph();
}

export function recordResultForDoomDetection(state: ActivationState, s: PipelineState): void {
  if (!s.toolCallId) return;
  const resultText = Array.isArray(s.outputEvent.content)
    ? s.outputEvent.content
        .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
        .map((c: any) => (typeof c.text === "string" ? c.text : ""))
        .join("\n")
    : "";
  recordToolResult(state.doomLoopState, s.toolCallId, resultText);
}

export function injectDoomLoopWarning(state: ActivationState, s: PipelineState): void {
  const doomLoop = consumeDoomLoopWarning(state.doomLoopState, s.toolCallId);
  if (!doomLoop || !Array.isArray(s.outputEvent.content)) return;
  const content = [...s.outputEvent.content];
  const prefix = `${formatDoomLoopMessage(doomLoop)}\n\n---\n`;
  let textIndex = -1;
  for (let i = 0; i < content.length; i++) {
    const item = content[i] as { type?: unknown; text?: unknown };
    if (item.type === "text") {
      textIndex = i;
      break;
    }
  }
  if (textIndex >= 0) {
    const item = content[textIndex] as { type: "text"; text?: unknown };
    content[textIndex] = { ...item, text: `${prefix}${coerceText(item.text)}` };
  } else {
    content.unshift({ type: "text" as const, text: prefix });
  }
  s.outputEvent = { ...s.outputEvent, content };
  s.outputChanged = true;
}

/**
 * Cap oversized output for SmartRead tools. Returns the rewritten event
 * when trimming applies (caller must early-return, skipping later
 * transforms); returns null when unchanged.
 */
export function applySmartReadOutputGuard(state: ActivationState, s: PipelineState): any | null {
  void state;
  if (!SMARTREAD_GUARD_TOOLS.has(s.toolName) || !Array.isArray(s.outputEvent.content)) return null;
  const textContent = s.outputEvent.content
    .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
    .map((c: any) => coerceText(c.text))
    .join("\n");

  if (!textContent) return null;
  const profile = resolveGuardProfile(s.toolName, state.bashContextGuardConfig);
  const lineCount = textContent === "" ? 0 : textContent.split("\n").length;
  const byteCount = Buffer.byteLength(textContent, "utf8");
  const trimWanted =
    profile.maxLines > 0 &&
    profile.maxBytes > 0 &&
    (lineCount > profile.maxLines || byteCount > profile.maxBytes);

  if (!trimWanted) return null;
  const result = applyBashContextGuard({
    text: textContent,
    command: undefined,
    toolName: s.toolName,
    details: s.outputEvent.details,
    config: {
      enabled: true,
      maxLines: profile.maxLines,
      maxBytes: profile.maxBytes,
      headLines: profile.headLines,
      tailLines: profile.tailLines,
    },
  });

  if (result.text === textContent) return null;
  const nonTextContent = s.outputEvent.content.filter((c: any) => c.type !== "text");
  return {
    ...s.outputEvent,
    content: [{ type: "text", text: result.text }, ...nonTextContent],
    details: {
      ...(s.outputEvent.details && typeof s.outputEvent.details === "object"
        ? s.outputEvent.details
        : {}),
      bashContextGuard: { ...result.metadata, toolName: s.toolName },
    },
  };
}

/**
 * Cap oversized bash output. Returns rewritten event when trimming
 * applies (caller must early-return); null when unchanged.
 */
export function applyBashOutputGuard(state: ActivationState, s: PipelineState): any | null {
  if (s.toolName !== "bash" || !state.bashContextGuardConfig.enabled || !Array.isArray(s.outputEvent.content))
    return null;
  const textContent = s.outputEvent.content
    .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
    .map((c: any) => coerceText(c.text))
    .join("\n");

  if (!textContent) return null;
  const guarded = applyBashContextGuard({
    text: textContent,
    command:
      typeof s.outputEvent.input?.command === "string" ? s.outputEvent.input.command : undefined,
    config: state.bashContextGuardConfig,
  });

  if (guarded.text === textContent) return null;
  const nonTextContent = s.outputEvent.content.filter((c: any) => c.type !== "text");
  return {
    ...s.outputEvent,
    content: [{ type: "text", text: guarded.text }, ...nonTextContent],
    details: {
      ...(s.outputEvent.details && typeof s.outputEvent.details === "object"
        ? s.outputEvent.details
        : {}),
      bashContextGuard: guarded.metadata,
    },
  };
}

/**
 * Append shell suggestions for failed bash commands. Returns rewritten
 * event (caller must early-return); null when no suggestions apply.
 */
export function appendBashFailureSuggestions(s: PipelineState): any | null {
  if (s.toolName !== "bash") return null;
  const typedInput = s.outputEvent.input as Record<string, unknown> | undefined;
  const cmd = typeof typedInput?.command === "string" ? typedInput.command : undefined;
  const exit = typeof typedInput?.exitCode === "number" ? typedInput.exitCode : undefined;
  const outputText = Array.isArray(s.outputEvent.content)
    ? s.outputEvent.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => coerceText(c.text))
        .join("\n")
    : "";
  if (!cmd || exit === undefined || exit === 0) return null;
  const suggestions = suggestShellCommands(cmd, outputText, exit);
  if (suggestions.length === 0) return null;
  const suggestionBlock = "\n\nCommand suggestions:\n" + suggestions.map((x) => `  • ${x}`).join("\n");
  const content = Array.isArray(s.outputEvent.content) ? [...s.outputEvent.content] : [];
  let textIndex = -1;
  for (let i = 0; i < content.length; i++) {
    const item = content[i] as any;
    if (item.type === "text") {
      textIndex = i;
      break;
    }
  }
  if (textIndex < 0) return null;
  const item = content[textIndex] as { type: "text"; text?: unknown };
  content[textIndex] = { ...item, text: coerceText(item.text) + suggestionBlock };
  return { ...s.outputEvent, content };
}

export function appendGrepLowResultHint(state: ActivationState, s: PipelineState): void {
  if (s.toolName !== "grep" || s.outputEvent.isError || !state.grepRegisteredRef.current) return;
  const rawContent = s.outputEvent.content;
  const textItems = Array.isArray(rawContent) ? rawContent : [];
  const textContent = textItems
    .filter((c: any): c is { type: "text"; text?: unknown } => c.type === "text")
    .map((c: any) => coerceText(c.text))
    .join("\n");
  const isNoMatch = textContent.trim() === "No matches found";
  const lineCount = textContent.split("\n").filter((l: string) => l.trim()).length;
  const lowMatches = isNoMatch || (lineCount > 0 && lineCount < 4);
  if (!lowMatches) return;
  const hint = `\n[hint] Low result count. Broaden or rephrase the pattern, or relax the path/glob scope for more matches.`;
  const content = [...textItems];
  const textIdx = content.findIndex((c: any) => c.type === "text");
  if (textIdx >= 0) {
    content[textIdx] = { ...content[textIdx], text: coerceText((content[textIdx] as any).text) + hint };
  } else {
    content.push({ type: "text", text: hint });
  }
  s.outputEvent = { ...s.outputEvent, content };
  s.outputChanged = true;
}

/**
 * Pi-SmartEdit owns post-mutation diagnostics for write/edit; only step
 * in when it did not claim this toolCallId so the model still sees
 * LSP-detected issues. Best-effort; never blocks the tool result.
 */
export async function runDiagnosticsFallbackStep(s: PipelineState): Promise<void> {
  if (
    (s.toolName !== "write" && s.toolName !== "edit") ||
    s.outputEvent.isError ||
    !s.toolCallId ||
    isDiagnosticsClaimed(s.toolCallId)
  )
    return;
  try {
    const fallback = await runPostEditDiagnosticsFallback({
      toolName: s.toolName,
      toolCallId: s.toolCallId,
      isError: s.outputEvent.isError,
      input: s.outputEvent.input as Record<string, unknown> | undefined,
      content: s.outputEvent.content,
      cwd: process.cwd(),
    });
    if (fallback) {
      s.outputEvent = { ...s.outputEvent, content: fallback.content };
      s.outputChanged = true;
    }
  } catch {
    // Fallback diagnostics are best-effort; never block the tool result.
  }
}

/**
 * Post-edit impact summary (SmartRead-only, advisory, always additive).
 * Runs regardless of diagnostics ownership. Best-effort.
 */
export async function runImpactSummaryStep(s: PipelineState): Promise<void> {
  if ((s.toolName !== "write" && s.toolName !== "edit") || s.outputEvent.isError) return;
  try {
    const impact = await runPostEditImpactSummary({
      toolName: s.toolName,
      isError: s.outputEvent.isError,
      input: s.outputEvent.input as Record<string, unknown> | undefined,
      details: ((s.outputEvent.details ?? {}) as Record<string, unknown>),
      content: s.outputEvent.content,
      cwd: process.cwd(),
    });
    if (impact) {
      s.outputEvent = { ...s.outputEvent, content: impact.content };
      s.outputChanged = true;
    }
  } catch {
    // Impact summary is best-effort; never block the tool result.
  }
}

// ── Event handlers ───────────────────────────────────────────────────

export function handleToolCall(state: ActivationState, event: any): undefined {
  const toolName = event.toolName as string;
  recordToolCall(
    state.doomLoopState,
    toolName,
    event.toolCallId,
    (event.input ?? {}) as Record<string, unknown>,
  );
  return undefined;
}

/**
 * Ordered tool_result pipeline. Early-return guards (SmartRead guard,
 * bash guard, bash suggestions) return immediately when they rewrite,
 * skipping later transforms — matching the original handler.
 */
export async function handleToolResult(state: ActivationState, event: any): Promise<any> {
  const workspaceRoot = canonicalizeWorkspaceRoot(process.cwd());
  const s: PipelineState = {
    toolName: event.toolName as string,
    toolCallId: event.toolCallId as string,
    input: (event.input ?? {}) as Record<string, unknown>,
    details: (event.details ?? {}) as Record<string, unknown>,
    // changedResources.canonicalPath is authoritative for edit/transfer results when present.
    changedPaths:
      ((event.toolName as string) === "edit" || (event.toolName as string) === "transfer") && !event.isError
        ? changedPathsFromDetails(event.details ?? {}).map((path) => canonicalResourcePath(path, workspaceRoot))
        : [],
    outputEvent: event,
    outputChanged: false,
  };

  recordHygieneAndAnchor(state, s);
  await trackLspDocuments(s);
  invalidateCachesOnMutation(s);
  recordResultForDoomDetection(state, s);
  injectDoomLoopWarning(state, s);

  const smartReadGuarded = applySmartReadOutputGuard(state, s);
  if (smartReadGuarded) return smartReadGuarded;

  const bashGuarded = applyBashOutputGuard(state, s);
  if (bashGuarded) return bashGuarded;

  const withSuggestions = appendBashFailureSuggestions(s);
  if (withSuggestions) return withSuggestions;

  appendGrepLowResultHint(state, s);
  await runDiagnosticsFallbackStep(s);
  await runImpactSummaryStep(s);

  return s.outputChanged ? s.outputEvent : undefined;
}

export function handleContext(state: ActivationState, event: any): any {
  if (!Array.isArray(event.messages)) return undefined;
  const report = state.hygieneTracker.generateReport();
  const messages = applyContextHygieneStaleContext(event.messages, report);
  if (messages === event.messages) return undefined;
  return { messages };
}
