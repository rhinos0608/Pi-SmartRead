/**
 * Context-hygiene metadata — tracks tool results and detects stale context.
 *
 * When a mutation occurs (graph_mutate receives breakage edges from Smart-Edit),
 * prior read/search results that reference the mutated file are marked stale.
 * The context-application module replaces stale messages with placeholders
 * in the context window.
 *
 * Adapted from pi-hashline-readmap (MIT, github.com/coctostan/pi-hashline-readmap).
 */

export const CONTEXT_HYGIENE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_CONTEXT_HYGIENE_MAX_EVENTS = 1000;

export type ContextHygieneClassification =
  | "read-context"
  | "search-context"
  | "command-output"
  | "mutation";

export type ContextHygieneResourceKind = "file" | "symbol" | "command";

export type ContextHygieneCommandKind =
  | "test"
  | "typecheck"
  | "build"
  | "lint"
  | "vcs"
  | "install"
  | "other";

export interface ContextHygieneFileResource {
  kind: "file";
  key: string;
  path: string;
}

export interface ContextHygieneSymbolResource {
  kind: "symbol";
  key: string;
  path: string;
  symbolName: string;
  symbolKind?: string;
}

export interface ContextHygieneCommandResource {
  kind: "command";
  key: string;
  command: string;
  commandKind: ContextHygieneCommandKind;
}

export type ContextHygieneResource =
  | ContextHygieneFileResource
  | ContextHygieneSymbolResource
  | ContextHygieneCommandResource;

export interface ContextHygieneRehydrateDescriptor {
  tool: "read" | "search";
  input: Record<string, unknown>;
}

export type ContextHygieneStaleInvalidationReason =
  | "mutation-after-read"
  | "bash-repo-state-after-mutation"
  | "bash-verification-success-rerun" | "anchor-drift";

export type ContextHygieneRetirementReason = "command-rerun" | "same-command-success-rerun";

export interface ContextHygieneStaleRecord {
  status: "stale";
  originalTool: string;
  originalEventId?: number;
  originalResultId?: string;
  staleResourceKeys: string[];
  invalidatingMutationEventId: number;
  invalidatingMutationResultId?: string;
  reason: ContextHygieneStaleInvalidationReason;
  rehydrate?: ContextHygieneRehydrateDescriptor;
  command?: string;
}

export interface ContextHygieneRetiredRecord {
  status: "retired";
  originalTool: string;
  originalEventId?: number;
  originalResultId?: string;
  retiredResourceKeys: string[];
  supersededByEventId: number;
  supersededByResultId?: string;
  reason: ContextHygieneRetirementReason;
  command?: string;
}

export interface ContextHygieneAppliedEffects {
  retired: { count: number; resultIds: string[]; reasons: string[] };
  stale: { count: number; resultIds: string[]; reasons: string[] };
}

export interface ContextHygieneMetadata {
  schemaVersion: typeof CONTEXT_HYGIENE_SCHEMA_VERSION;
  tool: string;
  classification: ContextHygieneClassification;
  resources: ContextHygieneResource[];
  rehydrate?: ContextHygieneRehydrateDescriptor;
  appliedEffects?: ContextHygieneAppliedEffects;
}

// ─── Path normalization ──────────────────────────────────────────────

export function normalizePathForContextHygiene(path: string): string {
  if (path === "") return "";
  const slashPath = path.replace(/\\+/g, "/");
  const isAbsolute = slashPath.startsWith("/");
  const parts: string[] = [];
  for (const part of slashPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const normalized = `${isAbsolute ? "/" : ""}${parts.join("/")}`;
  return normalized || (isAbsolute ? "/" : ".");
}

// ─── Resource builders ───────────────────────────────────────────────

export function buildFileResource(path: string): ContextHygieneFileResource {
  const normalizedPath = normalizePathForContextHygiene(path);
  return { kind: "file", key: `file:${normalizedPath}`, path: normalizedPath };
}

export function buildSymbolResource(
  path: string,
  symbolName: string,
  symbolKind?: string,
): ContextHygieneSymbolResource {
  const normalizedPath = normalizePathForContextHygiene(path);
  const normalizedKind = symbolKind?.trim();
  const keyPayload = JSON.stringify([normalizedPath, normalizedKind ?? "", symbolName]);
  return {
    kind: "symbol",
    key: `symbol:${keyPayload}`,
    path: normalizedPath,
    symbolName,
    ...(normalizedKind ? { symbolKind: normalizedKind } : {}),
  };
}

export function buildCommandResource(command: string): ContextHygieneCommandResource {
  const normalizedCommand = command.replace(/\s+/g, " ").trim();
  let commandKind: ContextHygieneCommandKind = "other";
  if (/^(git|gh)\b/.test(normalizedCommand)) commandKind = "vcs";
  else if (/\b(install|ci|add)\b/.test(normalizedCommand)) commandKind = "install";
  else if (/\b(typecheck|tsc\b)/.test(normalizedCommand)) commandKind = "typecheck";
  else if (/\b(test|vitest|jest|mocha)\b/.test(normalizedCommand)) commandKind = "test";
  else if (/\b(lint|eslint|biome|prettier)\b/.test(normalizedCommand)) commandKind = "lint";
  else if (/\b(build|tsup|vite build|rollup|webpack|make)\b/.test(normalizedCommand)) commandKind = "build";
  return {
    kind: "command",
    key: `command:${commandKind}:${normalizedCommand}`,
    command: normalizedCommand,
    commandKind,
  };
}

// ─── Metadata builder ────────────────────────────────────────────────

export function buildContextHygieneMetadata(input: {
  tool: string;
  classification: ContextHygieneClassification;
  resources?: readonly (ContextHygieneResource | null | undefined)[];
  rehydrate?: ContextHygieneRehydrateDescriptor | null;
}): ContextHygieneMetadata {
  const resources: ContextHygieneResource[] = [];
  const seenResourceKeys = new Set<string>();
  for (const resource of input.resources ?? []) {
    if (!resource || seenResourceKeys.has(resource.key)) continue;
    seenResourceKeys.add(resource.key);
    resources.push({ ...resource } as ContextHygieneResource);
  }
  const metadata: ContextHygieneMetadata = {
    schemaVersion: CONTEXT_HYGIENE_SCHEMA_VERSION,
    tool: input.tool,
    classification: input.classification,
    resources,
  };
  if (input.rehydrate) metadata.rehydrate = { ...input.rehydrate, input: { ...input.rehydrate.input } };
  return metadata;
}

// ─── Stale / retired record builders ─────────────────────────────────

export function buildStaleContextRecord(input: {
  originalTool: string;
  originalEventId?: number;
  originalResultId?: string;
  staleResourceKeys: readonly string[];
  invalidatingMutationEventId: number;
  invalidatingMutationResultId?: string;
  reason?: ContextHygieneStaleInvalidationReason;
  rehydrate?: ContextHygieneRehydrateDescriptor;
  command?: string;
}): ContextHygieneStaleRecord {
  const record: ContextHygieneStaleRecord = {
    status: "stale",
    originalTool: input.originalTool,
    staleResourceKeys: [...new Set(input.staleResourceKeys)].sort(),
    invalidatingMutationEventId: input.invalidatingMutationEventId,
    reason: input.reason ?? "mutation-after-read",
  };
  if (input.originalEventId !== undefined) record.originalEventId = input.originalEventId;
  if (input.originalResultId) record.originalResultId = input.originalResultId;
  if (input.invalidatingMutationResultId) record.invalidatingMutationResultId = input.invalidatingMutationResultId;
  if (input.rehydrate) record.rehydrate = { ...input.rehydrate, input: { ...input.rehydrate.input } };
  if (input.command) record.command = input.command;
  return record;
}

export function buildRetiredContextRecord(input: {
  originalTool: string;
  originalEventId?: number;
  originalResultId?: string;
  retiredResourceKeys: readonly string[];
  supersededByEventId: number;
  supersededByResultId?: string;
  reason: ContextHygieneRetirementReason;
  command?: string;
}): ContextHygieneRetiredRecord {
  const record: ContextHygieneRetiredRecord = {
    status: "retired",
    originalTool: input.originalTool,
    retiredResourceKeys: [...new Set(input.retiredResourceKeys)].sort(),
    supersededByEventId: input.supersededByEventId,
    reason: input.reason,
  };
  if (input.originalEventId !== undefined) record.originalEventId = input.originalEventId;
  if (input.originalResultId) record.originalResultId = input.originalResultId;
  if (input.supersededByResultId) record.supersededByResultId = input.supersededByResultId;
  if (input.command) record.command = input.command;
  return record;
}

// ─── Placeholder renderers ───────────────────────────────────────────

export function renderStaleReadPlaceholder(): string {
  return "[Stale read context: file content changed after this result. Re-run read to refresh.]";
}

export function renderStaleGrepPlaceholder(): string {
  return "[Stale grep context: matched file content changed after this result. Re-run grep to refresh.]";
}

export function renderStaleRepoMapPlaceholder(): string {
  return "[Stale repo_map context: repository structure changed after this result. Re-run repo_map to refresh.]";
}

export function renderStaleBashPlaceholder(record: ContextHygieneStaleRecord): string {
  const command = record.command ? ` Command: ${record.command}` : "";
  return `[Stale bash context: ${record.reason}. Re-run the Bash command to refresh.${command}]`;
}

export function renderRetiredContextPlaceholder(record: ContextHygieneRetiredRecord): string {
  const command = record.command ? ` Command: ${record.command}` : "";
  return `[Retired bash context: ${record.reason}. Superseded by a later successful Bash command.${command}]`;
}

export function renderStaleContextPlaceholder(record: ContextHygieneStaleRecord): string {
  switch (record.originalTool) {
    case "read":
    case "read_files":
    case "symbol":
      return renderStaleReadPlaceholder();
    case "repo_map":
      return renderStaleRepoMapPlaceholder();
    case "grep":
    case "search":
      return renderStaleGrepPlaceholder();
    case "bash":
      return renderStaleBashPlaceholder(record);
    default:
      return "[Stale tool context: resource content changed after this result. Re-run the original tool to refresh.]";
  }
}

// ─── Tracker ─────────────────────────────────────────────────────────

export interface ContextHygieneEvent {
  id: number;
  resultId?: string;
  tool: string;
  classification: ContextHygieneClassification;
  resources: ContextHygieneResource[];
  rehydrate?: ContextHygieneRehydrateDescriptor;
}

export interface ContextHygieneReport {
  eventCount: number;
  resourceCount: number;
  readReuse: Array<{ resourceKey: string; count: number; eventIds: number[]; resultIds: string[] }>;
  mutationAfterRead: Array<{ resourceKey: string; readEventIds: number[]; mutationEventId: number }>;
  staleCandidates: Array<{
    resourceKey: string;
    staleEventIds: number[];
    mutationEventId: number;
    reason: ContextHygieneStaleInvalidationReason;
    staleResults: ContextHygieneStaleRecord[];
  }>;
  retirementCandidates: Array<{
    resourceKey: string;
    eventIds: number[];
    supersededByEventId: number;
    reason: ContextHygieneRetirementReason;
    retiredResults?: ContextHygieneRetiredRecord[];
  }>;
}

export interface ContextHygieneTracker {
  record(metadata: ContextHygieneMetadata, options?: { resultId?: string }): ContextHygieneEvent;
  /**
   * Record a mutation event explicitly (e.g., from graph_mutate tool).
   * Stores the mutation and, on the next generateReport() call, automatically
   * creates stale records for any prior read-context results whose resources
   * overlap with the mutated file paths.
   *
   * Non-blocking: if recording fails, logs and continues.
   */
  recordMutation(
    mutationResources: ContextHygieneResource[],
    options?: { resultId?: string; rehydrate?: ContextHygieneRehydrateDescriptor; tool?: string },
  ): ContextHygieneEvent;
  generateReport(): ContextHygieneReport;
}

class DefaultContextHygieneTracker implements ContextHygieneTracker {
  private readonly events: ContextHygieneEvent[] = [];
  private readonly maxEvents: number;
  private nextEventId = 1;

  constructor(options: { maxEvents?: number } = {}) {
    this.maxEvents = Math.max(1, Math.floor(options.maxEvents ?? DEFAULT_CONTEXT_HYGIENE_MAX_EVENTS));
  }

  record(metadata: ContextHygieneMetadata, options: { resultId?: string } = {}): ContextHygieneEvent {
    const event: ContextHygieneEvent = {
      id: this.nextEventId++,
      tool: metadata.tool,
      classification: metadata.classification,
      resources: metadata.resources.map((r) => ({ ...r } as ContextHygieneResource)),
    };
    if (options.resultId) event.resultId = options.resultId;
    if (metadata.rehydrate) event.rehydrate = { ...metadata.rehydrate, input: { ...metadata.rehydrate.input } };
    this.events.push(event);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    return event;
  }

  recordMutation(
    mutationResources: ContextHygieneResource[],
    options: { resultId?: string; rehydrate?: ContextHygieneRehydrateDescriptor; tool?: string } = {},
  ): ContextHygieneEvent {
    try {
      // Deduplicate resources by key to match generateReport's bucketing
      const seen = new Set<string>();
      const deduped: ContextHygieneResource[] = [];
      for (const r of mutationResources) {
        if (seen.has(r.key)) continue;
        seen.add(r.key);
        deduped.push({ ...r } as ContextHygieneResource);
      }

      const event: ContextHygieneEvent = {
        id: this.nextEventId++,
        tool: options.tool ?? "graph_mutate",
        classification: "mutation",
        resources: deduped,
      };
      if (options.resultId) event.resultId = options.resultId;
      if (options.rehydrate) event.rehydrate = { ...options.rehydrate, input: { ...options.rehydrate.input } };

      this.events.push(event);
      if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
      return event;
    } catch (err) {
      // Non-blocking: log and continue
      console.error("[context-hygiene] recordMutation failed:", err instanceof Error ? err.message : String(err));
      // Return a no-op event so callers don't break
      return {
        id: -1,
        tool: options.tool ?? "graph_mutate",
        classification: "mutation" as const,
        resources: [],
      };
    }
  }

  generateReport(): ContextHygieneReport {
    const eventsByResource = new Map<string, ContextHygieneEvent[]>();
    const readEventsByResource = new Map<string, ContextHygieneEvent[]>();
    const mutationEventsByResource = new Map<string, ContextHygieneEvent[]>();

    for (const event of this.events) {
      for (const resource of event.resources) {
        const bucket = eventsByResource.get(resource.key) ?? [];
        bucket.push(event);
        eventsByResource.set(resource.key, bucket);
        if (event.classification === "read-context" || event.classification === "search-context") {
          const readBucket = readEventsByResource.get(resource.key) ?? [];
          readBucket.push(event);
          readEventsByResource.set(resource.key, readBucket);
        }
        if (event.classification === "mutation") {
          const mutBucket = mutationEventsByResource.get(resource.key) ?? [];
          mutBucket.push(event);
          mutationEventsByResource.set(resource.key, mutBucket);
        }
      }
    }

    const readReuse = [...readEventsByResource.keys()].sort().flatMap((resourceKey) => {
      const events = readEventsByResource.get(resourceKey) ?? [];
      if (events.length < 2) return [];
      return [{
        resourceKey,
        count: events.length,
        eventIds: events.map((e) => e.id),
        resultIds: events.map((e) => e.resultId).filter(Boolean) as string[],
      }];
    });

    const mutationAfterRead: ContextHygieneReport["mutationAfterRead"] = [];
    const staleCandidates: ContextHygieneReport["staleCandidates"] = [];

    for (const resourceKey of [...mutationEventsByResource.keys()].sort()) {
      const reads = readEventsByResource.get(resourceKey) ?? [];
      const mutations = mutationEventsByResource.get(resourceKey) ?? [];
      for (const mutation of mutations) {
        const priorReads = reads.filter((read) => read.id < mutation.id);
        const priorReadIds = priorReads.map((r) => r.id);
        if (priorReadIds.length === 0) continue;
        mutationAfterRead.push({ resourceKey, readEventIds: priorReadIds, mutationEventId: mutation.id });
        staleCandidates.push({
          resourceKey,
          staleEventIds: priorReadIds,
          mutationEventId: mutation.id,
          reason: "mutation-after-read",
          staleResults: priorReads.map((read) => buildStaleContextRecord({
            originalTool: read.tool,
            originalEventId: read.id,
            originalResultId: read.resultId,
            staleResourceKeys: [resourceKey],
            invalidatingMutationEventId: mutation.id,
            invalidatingMutationResultId: mutation.resultId,
            reason: "mutation-after-read",
            rehydrate: read.rehydrate,
          })),
        });
      }
    }

    return {
      eventCount: this.events.length,
      resourceCount: eventsByResource.size,
      readReuse,
      mutationAfterRead,
      staleCandidates,
      retirementCandidates: [],
    };
  }
}

export function createContextHygieneTracker(options: { maxEvents?: number } = {}): ContextHygieneTracker {
  return new DefaultContextHygieneTracker(options);
}

let globalContextHygieneTracker = createContextHygieneTracker();

export function resetContextHygieneTracker(options: { maxEvents?: number } = {}): ContextHygieneTracker {
  globalContextHygieneTracker = createContextHygieneTracker(options);
  return globalContextHygieneTracker;
}

export function getContextHygieneTracker(): ContextHygieneTracker {
  return globalContextHygieneTracker;
}

// ─── Lint-on-write ────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LintResult {
  passed: boolean;
  output: string;
  lineErrors: number[];
}

export async function runLint(fullPath: string, cwd: string): Promise<LintResult | null> {
  const ext = fullPath.split(".").pop()?.toLowerCase();
  if (!ext) return null;

  let command: string;
  let args: string[];

  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx") {
    command = "npx";
    args = ["tsc", "--noEmit", fullPath];
  } else if (ext === "py") {
    command = "python";
    args = ["-m", "py_compile", fullPath];
  } else if (ext === "go") {
    command = "go";
    args = ["vet", fullPath];
  } else {
    return null;
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: 30000,
    });
    const output = stdout + stderr;
    const lineErrors: number[] = [];
    const lineMatch = /:(\d+):/g;
    let match;
    while ((match = lineMatch.exec(output)) !== null) {
      const num = match[1];
      if (num) lineErrors.push(parseInt(num, 10));
    }
    return { passed: true, output, lineErrors };
  } catch (error: unknown) {
    const output = error instanceof Error ? (error.message ?? String(error)) : String(error);
    const lineErrors: number[] = [];
    const lineMatch = /:(\d+):/g;
    let match;
    while ((match = lineMatch.exec(output)) !== null) {
      const num = match[1];
      if (num) lineErrors.push(parseInt(num, 10));
    }
    return { passed: false, output, lineErrors };
  }
}

export async function lintAfterMutation(
  fullPath: string,
  cwd: string,
  tracker: ContextHygieneTracker,
): Promise<void> {
  const result = await runLint(fullPath, cwd);
  if (!result || result.passed) return;

  const lintMetadata = buildContextHygieneMetadata({
    tool: "bash",
    classification: "command-output",
    resources: [
      buildFileResource(fullPath),
      buildCommandResource(`lint ${fullPath}`),
    ],
  });

  tracker.record(lintMetadata);
}

// ─── Anchor-level hygiene ─────────────────────────────────────────────

export interface AnchorDeltaEntry {
  hash: string;
  oldLine: number;
  newLine: number;
  contentChanged: boolean;
  status: "shifted" | "deleted" | "changed";
}

export interface AnchorHygieneEvent {
  file: string;
  timestamp: number;
  deltas: AnchorDeltaEntry[];
  churnExceeded: boolean;
}

export function recordAnchorDelta(
  tracker: ContextHygieneTracker,
  event: AnchorHygieneEvent,
): void {
  const resource = buildFileResource(event.file);
  tracker.recordMutation([resource], { resultId: undefined, tool: "anchor-delta" });

  if (event.churnExceeded) {
    // Generate report to trigger stale candidate computation.
    // generateReport cross-references mutations with prior reads
    // and produces staleCandidates for any resource that was read
    // before the mutation.
    tracker.generateReport();
  }
}

export function buildAnchorStaleRecord(input: {
  file: string;
  deltas: AnchorDeltaEntry[];
  churnExceeded: boolean;
}): ContextHygieneStaleRecord {
  const resource = buildFileResource(input.file);
  return buildStaleContextRecord({
    originalTool: "read",
    staleResourceKeys: [resource.key],
    invalidatingMutationEventId: -1,
    reason: "anchor-drift",
    command: undefined,
  });
}

export function renderAnchorDriftPlaceholder(
  deltas: AnchorDeltaEntry[],
  churnExceeded: boolean,
): string {
  if (churnExceeded) {
    return "[Anchor drift: significant structural change. Re-read file to refresh anchors.]";
  }
  const count = deltas.length;
  return `[Anchor drift: ${count} anchors shifted/deleted/changed. Re-read affected sections.]`;
}
