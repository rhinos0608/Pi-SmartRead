/**
 * Affordance investigation recipes — Lane P WP-A2.
 *
 * One model-facing `investigate` operation layered over strict LSP ops.
 * Consumes the frozen `AnchorResolution` / `AffordanceExecContext` seam and
 * the single `executeLspOperation` dispatch seam only. No raw requests, no
 * SmartEdit mutation, no invented server metadata.
 *
 * Fail-closed rules (see `affordance-contract.ts` and the bundle plan):
 * - Target XOR: explicit `{ path, position }` XOR declaration
 *   `{ symbol, path? }`. Both or neither is a caller error (throw).
 * - Pathless symbol targets never dispatch: the anchor resolver returns
 *   `not_ready` / `anchor_search_incomplete` discovery, propagated here.
 * - Explicit files follow strict executor semantics (no root jail on
 *   explicit files; canonicalized when the file exists). `scope` is an
 *   independent canonical file/directory filter INSIDE the chosen
 *   workspace; invalid scope throws before any server request.
 * - Shared budget: every internal strict call — including anchor
 *   resolution — counts under the same ≤6 requests / 15 s aggregate /
 *   100-results-per-step envelope. Admission precedes every await.
 * - Freshness is re-checked immediately before post-resolution dispatch;
 *   drift yields `error` / `stale_anchor`, never a guessed dispatch.
 * - `callers` passes exact opaque `prepareCallHierarchy` items unchanged
 *   into `incomingCalls` (every item, max 3).
 * - Every strict envelope is preserved verbatim in `steps`; the rendered
 *   `result` projection is bounded while envelopes stay intact.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import {
  AFFORDANCE_BOUNDS,
  type AffordanceExecContext,
  type AffordanceInvestigateInput,
  type InvestigationOutput,
  type InvestigationStep,
  type InvestigateTask,
} from "./affordance-contract.js";
import { resolveAffordanceAnchor } from "./affordance-anchor.js";
import { executeLspOperation, type ExecutorDeps } from "./lsp-executor.js";
import type {
  StrictEnvelope,
  StrictServerInfo,
  StrictStatus,
} from "./lsp-strict-contract.js";

const CALLERS_ITEMS_MAX = 3;

const VALID_TASKS: ReadonlySet<string> = new Set([
  "definition",
  "type",
  "references",
  "implementations",
  "callers",
]);

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "operation", "task", "path", "position", "symbol",
  "scope", "workspace", "server", "timeoutMs",
]);

type Gate = { status: "cancelled" | "timeout" | "error"; message: string };
type DispatchResult = StrictEnvelope | Gate;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidPosition(v: unknown): v is { line: number; character: number } {
  if (!isRecord(v)) return false;
  const { line, character } = v as { line?: unknown; character?: unknown };
  return (
    typeof line === "number" && Number.isInteger(line) && line >= 0 &&
    typeof character === "number" && Number.isInteger(character) && character >= 0
  );
}

function isGate(v: DispatchResult): v is Gate {
  return (v as StrictEnvelope).server === undefined;
}

function failedStatus(status: StrictStatus): boolean {
  return status !== "ok" && status !== "empty";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function hashOfFile(abs: string): string | null {
  try {
    return sha256(readFileSync(abs, "utf-8"));
  } catch {
    return null;
  }
}

function uriToPath(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Extract a candidate file path from a location-ish result entry. */
function locationPathOf(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  const direct = uriToPath(entry.uri);
  if (direct) return direct;
  const target = uriToPath(entry.targetUri);
  if (target) return target;
  for (const key of ["from", "to"] as const) {
    const nested = entry[key];
    if (isRecord(nested)) {
      const p = uriToPath(nested.uri);
      if (p) return p;
    }
  }
  return null;
}

function underDir(file: string, dir: string): boolean {
  if (file === dir) return true;
  return file.startsWith(dir.endsWith(pathSep) ? dir : dir + pathSep);
}

interface ParsedTarget {
  kind: "explicit" | "symbol";
  path?: string;
  position?: { line: number; character: number };
  symbol?: string;
  symbolPath?: string;
}

/** Validate the target XOR; throw on caller error (strict tool-error path). */
function parseTarget(input: AffordanceInvestigateInput): ParsedTarget {
  const { path, position, symbol } = input;
  const hasPosition = position !== undefined;
  const hasSymbol = symbol !== undefined;
  // Plan XOR: `{ symbol, path? }` is mutually exclusive with `position`.
  // `path` alone qualifies either form (anchor file vs coordinate file).
  if (hasPosition && hasSymbol) {
    throw new Error('investigate: "symbol" is mutually exclusive with "position"');
  }
  if (hasSymbol) {
    if (typeof symbol !== "string" || symbol.length === 0) {
      throw new Error('investigate: "symbol" must be a non-empty string');
    }
    const sp = (input as { path?: unknown }).path;
    if (sp !== undefined && (typeof sp !== "string" || sp.length === 0)) {
      throw new Error('investigate: "path" must be a non-empty string');
    }
    return { kind: "symbol", symbol, symbolPath: sp as string | undefined };
  }
  if (typeof path !== "string" || path.length === 0) {
    throw new Error('investigate: explicit targets require a non-empty "path"');
  }
  if (!isValidPosition(position)) {
    throw new Error('investigate: explicit targets require a 0-based "position" {line, character}');
  }
  return { kind: "explicit", path, position: { line: position.line, character: position.character } };
}

export interface AffordanceScope {
  /** Canonical scope path (file or directory), or null when unscoped. */
  scopeAbs: string | null;
  /** True when the scope names a regular file (exact match only). */
  scopeIsFile: boolean;
}

/**
 * Validate the independent `scope` filter: canonical file/dir INSIDE the
 * chosen workspace. Throws (caller error) before any server request on
 * missing, non-file/dir, realpath failure, or workspace escape. Scope
 * filters result projections only — never explicit dispatch paths.
 */
export function resolveInvestigateScope(scope: unknown, workspaceRoot: string): AffordanceScope {
  if (scope === undefined) return { scopeAbs: null, scopeIsFile: false };
  if (typeof scope !== "string" || scope.length === 0) {
    throw new Error('investigate: "scope" must be a non-empty string');
  }
  const canonicalRoot = realpathSync(resolvePath(workspaceRoot));
  const abs = resolvePath(canonicalRoot, scope);
  let canonical: string;
  try {
    canonical = realpathSync(abs);
    const rest = statSync(canonical);
    if (!rest.isFile() && !rest.isDirectory()) {
      throw new Error(`investigate: scope is not a file or directory: ${scope}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("investigate: scope")) throw err;
    throw new Error(`investigate: scope does not exist or is inaccessible: ${scope}`);
  }
  if (!underDir(canonical, canonicalRoot)) {
    throw new Error(`investigate: scope escapes the workspace: ${scope}`);
  }
  return { scopeAbs: canonical, scopeIsFile: statSync(canonical).isFile() };
}

function applyScope(items: unknown[], scope: AffordanceScope): { items: unknown[]; filteredOut: number } {
  if (!scope.scopeAbs) return { items, filteredOut: 0 };
  const kept: unknown[] = [];
  let filteredOut = 0;
  for (const entry of items) {
    const p = locationPathOf(entry);
    if (p === null) {
      kept.push(entry);
      continue;
    }
    let canonical = p;
    try {
      canonical = realpathSync(p);
    } catch {
      // Unresolvable alias: keep the entry rather than guessing scope.
      kept.push(entry);
      continue;
    }
    const inside = scope.scopeIsFile ? canonical === scope.scopeAbs : underDir(canonical, scope.scopeAbs!);
    if (inside) kept.push(entry);
    else filteredOut += 1;
  }
  return { items: kept, filteredOut };
}

/** Bound the rendered projection by UTF-8 bytes; full envelopes stay verbatim in steps. */
function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

export function renderBounded(value: unknown[]): { projection: unknown[]; truncated: boolean } {
  const maxBytes = AFFORDANCE_BOUNDS.outputBytes;
  if (utf8Bytes(value) <= maxBytes) return { projection: value, truncated: false };
  let end = value.length;
  while (end > 0) {
    const candidate = value.slice(0, end);
    if (utf8Bytes(candidate) <= maxBytes) return { projection: candidate, truncated: true };
    end = Math.floor(end / 2);
  }
  return { projection: [], truncated: true };
}

interface RecipeState {
  steps: InvestigationStep[];
  requests: number;
  maxRequests: number;
  deadlineMs: number;
  started: number;
  now: () => number;
  signal?: AbortSignal;
  exec: (req: unknown, deps?: ExecutorDeps) => Promise<StrictEnvelope>;
  root: string;
  workspace?: string;
  server?: string;
  timeoutCap?: number;
  scope: AffordanceScope;
  dispatchServer: StrictServerInfo | null;
}

function baseArgs(state: RecipeState, path: string): Record<string, unknown> {
  return {
    ...(state.workspace ? { workspace: state.workspace } : {}),
    ...(state.dispatchServer && state.dispatchServer.descriptorId !== "unknown"
      ? { server: state.dispatchServer.descriptorId }
      : state.server ? { server: state.server } : {}),
    path,
  };
}

function admission(state: RecipeState): Gate | null {
  if (state.signal?.aborted) {
    return { status: "cancelled", message: "investigation cancelled" };
  }
  if (state.now() - state.started >= state.deadlineMs) {
    return { status: "timeout", message: "investigation aggregate deadline exceeded" };
  }
  if (state.requests >= state.maxRequests) {
    return { status: "error", message: `investigation request budget exhausted (${state.maxRequests})` };
  }
  return null;
}

/** Dispatch one strict request under the shared budget; admission before await. */
async function dispatch(state: RecipeState, id: string, req: Record<string, unknown>): Promise<DispatchResult> {
  const gate = admission(state);
  if (gate) return gate;
  state.requests += 1;
  const remaining = Math.max(0, state.deadlineMs - (state.now() - state.started));
  const timeoutMs = Math.max(1, Math.min(state.timeoutCap ?? remaining, remaining || 1));
  try {
    const envelope = await state.exec({ ...req, timeoutMs }, { cwd: state.root, signal: state.signal });
    state.steps.push({ id, args: { ...req }, envelope });
    return envelope;
  } catch (err) {
    return { status: "error", message: `investigation transport failure: ${String((err as Error)?.message ?? err)}` };
  }
}

/** Validate input fields; throw on caller error. Returns the recipe + timeout cap. */
function validateInput(input: AffordanceInvestigateInput): { recipe: InvestigateTask; timeoutCap?: number } {
  if (!isRecord(input)) throw new Error("investigate: input must be an object");
  if ((input as { operation?: unknown }).operation !== "investigate") {
    throw new Error('investigate: operation must be "investigate"');
  }
  const task = (input as { task?: unknown }).task;
  if (typeof task !== "string" || !VALID_TASKS.has(task)) {
    throw new Error(`investigate: unknown task: ${String(task)}`);
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`investigate: foreign field "${key}"`);
  }
  const timeoutCap = (input as { timeoutMs?: unknown }).timeoutMs;
  if (timeoutCap !== undefined) {
    if (typeof timeoutCap !== "number" || !Number.isInteger(timeoutCap) || timeoutCap <= 0) {
      throw new Error('investigate: "timeoutMs" must be a positive integer');
    }
  }
  for (const field of ["workspace", "server"] as const) {
    const v = (input as Record<string, unknown>)[field];
    if (v !== undefined && (typeof v !== "string" || v.length === 0)) {
      throw new Error(`investigate: "${field}" must be a non-empty string`);
    }
  }
  parseTarget(input); // XOR + shape validation (throws on caller error).
  return { recipe: task as InvestigateTask, timeoutCap: timeoutCap as number | undefined };
}

interface ResolvedDispatch {
  path: string;
  position: { line: number; character: number };
  server: StrictServerInfo | null;
  output?: InvestigationOutput;
}

/**
 * Resolve the dispatch target. Symbol targets go through the anchor
 * resolver with the REMAINING shared budget (never a reset); explicit
 * targets canonicalize when the file exists and pass through otherwise.
 * Returns `output` when resolution itself terminates the investigation.
 */
interface ResolveDeps {
  ctx: AffordanceExecContext;
  now: () => number;
  started: number;
  maxRequests: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

async function resolveExplicitTarget(
  state: RecipeState,
  target: ParsedTarget,
  root: string,
): Promise<ResolvedDispatch> {
  const effectiveRoot = state.workspace ? resolvePath(state.workspace) : root;
  const abs = resolvePath(effectiveRoot, target.path!);
  let dispatchPath = abs;
  try {
    if (statSync(abs).isFile()) dispatchPath = realpathSync(abs);
  } catch {
    // Unresolvable explicit path: pass through; the server envelope reports.
  }
  return { path: dispatchPath, position: { ...target.position! }, server: null };
}

async function resolveSymbolTarget(
  state: RecipeState,
  target: ParsedTarget,
  deps: ResolveDeps,
): Promise<ResolvedDispatch> {
  const anchorArgs = { symbol: target.symbol!, ...(target.symbolPath ? { path: target.symbolPath } : {}) };
  // Pre-resolution content snapshot for the explicit anchor file (when it
  // exists): drift between this snapshot and post-resolution dispatch is
  // an observed within-request race → `stale_anchor`. No claim about
  // earlier-turn edits is made (statelessness cannot detect them).
  const anchorFileAbs = target.symbolPath
    ? (() => {
        try {
          const root = deps.ctx.workspace ? resolvePath(deps.ctx.workspace) : deps.ctx.root;
          return resolvePath(root, target.symbolPath);
        } catch {
          return null;
        }
      })()
    : null;
  const preHash = anchorFileAbs ? hashOfFile(anchorFileAbs) : null;
  const gate = admission(state);
  if (gate) {
    return {
      path: "", position: { line: 0, character: 0 }, server: null,
      output: { status: gate.status, result: { code: gate.status, message: gate.message, partial: true }, steps: state.steps },
    };
  }
  const anchorCtx: AffordanceExecContext = {
    root: deps.ctx.root,
    ...(state.workspace ? { workspace: state.workspace } : {}),
    ...(state.server ? { server: state.server } : {}),
    budget: {
      maxCandidates: AFFORDANCE_BOUNDS.discoveryCandidates,
      get maxRequests() { return Math.max(0, deps.maxRequests - state.requests); },
      get deadlineMs() { return Math.max(0, deps.deadlineMs - (deps.now() - deps.started)); },
      signal: deps.signal,
    },
    exec: async (req, innerDeps) => {
      // Shared counter: anchor requests consume the SAME recipe budget.
      // The strict request carries the REMAINING aggregate time capped by
      // the caller's timeoutMs, computed before the await — never a fresh
      // aggregate. The envelope returns verbatim: no synthetic statuses,
      // no counter reset, exactly one increment per anchor lookup.
      state.requests += 1;
      const remaining = Math.max(0, state.deadlineMs - (state.now() - state.started));
      const timeoutMs = Math.max(1, Math.min(state.timeoutCap ?? remaining, remaining || 1));
      const strictReq = isRecord(req) ? { ...req, timeoutMs } : req;
      return state.exec(strictReq, innerDeps);
    },
    now: deps.now,
  };
  const resolution = await resolveAffordanceAnchor(anchorArgs, anchorCtx);
  if (resolution.kind === "unresolved") {
    for (const envelope of resolution.envelopes) {
      state.steps.push({ id: "anchor.resolve", args: { ...anchorArgs }, envelope });
    }
    return {
      path: "", position: { line: 0, character: 0 }, server: null,
      output: {
        status: resolution.status,
        result: {
          code: resolution.code, message: resolution.message,
          candidates: resolution.candidates,
          ...(resolution.retry ? { retry: resolution.retry } : {}),
          partial: true,
        },
        steps: state.steps,
      },
    };
  }
  const stale = (message: string): ResolvedDispatch => ({
    path: "", position: { line: 0, character: 0 }, server: null,
    output: { status: "error", result: { code: "stale_anchor", message, partial: true }, steps: state.steps },
  });
  state.steps.push({ id: "anchor.resolve", args: anchorArgs, envelope: resolution.resolutionEnvelope });
  if (resolution.resolutionEnvelope.meta?.freshness?.state === "stale") {
    return stale("anchor source changed during resolution; re-read and retry");
  }
  let canonicalNow: string;
  try {
    canonicalNow = realpathSync(resolution.path);
  } catch {
    return stale("anchor file vanished between resolution and dispatch; re-read and retry");
  }
  if (canonicalNow !== resolution.path) {
    return stale("anchor file identity changed between resolution and dispatch; re-read and retry");
  }
  const before = preHash ?? hashOfFile(resolution.path);
  const after = hashOfFile(resolution.path);
  if (before !== null && after !== null && before !== after) {
    return stale("anchor source changed between resolution and dispatch; re-read and retry");
  }
  return { path: resolution.path, position: { ...resolution.position }, server: resolution.server };
}

async function resolveDispatchTarget(
  state: RecipeState,
  target: ParsedTarget,
  deps: ResolveDeps,
): Promise<ResolvedDispatch> {
  if (target.kind === "explicit") return resolveExplicitTarget(state, target, deps.ctx.root);
  return resolveSymbolTarget(state, target, deps);
}

function projectItems(
  recipe: InvestigateTask,
  raw: unknown,
  envelope: StrictEnvelope,
  scope: AffordanceScope,
): { summary: Record<string, unknown>; status: StrictStatus } {
  const rawItems = Array.isArray(raw) ? raw : raw === null ? [] : [raw];
  const { items, filteredOut } = applyScope(rawItems, scope);
  const capped = items.length > AFFORDANCE_BOUNDS.perStepResults
    ? items.slice(0, AFFORDANCE_BOUNDS.perStepResults)
    : items;
  const { projection, truncated } = renderBounded(capped);
  const capHit = capped.length !== items.length;
  return {
    summary: {
      task: recipe,
      ...(Array.isArray(raw) ? { count: items.length, items: projection } : { value: projection }),
      truncated: truncated || capHit || envelope.meta.truncated,
      ...(envelope.meta.nextCursor ? { nextCursor: envelope.meta.nextCursor } : {}),
      filteredOutByScope: filteredOut,
    },
    status: envelope.status,
  };
}

function failureOutput(
  recipe: InvestigateTask,
  envelope: StrictEnvelope,
  state: RecipeState,
): InvestigationOutput {
  return {
    status: envelope.status,
    result: {
      task: recipe,
      code: envelope.error?.code ?? envelope.status,
      message: envelope.error?.message ?? `${recipe} ${envelope.status}`,
      partial: true,
      envelopeMeta: envelope.meta,
    },
    steps: state.steps,
  };
}

/** Single-dispatch recipes: definition / type / references / implementations. */
async function runSingleRecipe(
  recipe: Exclude<InvestigateTask, "callers">,
  state: RecipeState,
  path: string,
  at: { line: number; character: number },
): Promise<InvestigationOutput> {
  const spec: Record<string, { operation: string; extra?: Record<string, unknown> }> = {
    definition: { operation: "goToDefinition" },
    type: { operation: "hover" },
    references: { operation: "findReferences", extra: { includeDeclaration: false } },
    implementations: { operation: "goToImplementation" },
  };
  const { operation, extra } = spec[recipe]!;
  const out = await dispatch(state, `investigate.${recipe}`, {
    operation, ...baseArgs(state, path), position: { ...at }, ...(extra ?? {}),
  });
  if (isGate(out)) {
    return { status: out.status, result: { task: recipe, code: out.status, message: out.message, partial: true }, steps: state.steps };
  }
  if (failedStatus(out.status)) return failureOutput(recipe, out, state);
  const { summary, status } = projectItems(recipe, out.result, out, state.scope);
  return { status, result: summary, steps: state.steps };
}

/** Callers recipe: prepare once, then exact-item incomingCalls for every item. */
async function runCallersRecipe(
  state: RecipeState,
  path: string,
  at: { line: number; character: number },
): Promise<InvestigationOutput> {
  const recipe = "callers" as const;
  const prep = await dispatch(state, "callers.prepare", {
    operation: "prepareCallHierarchy", ...baseArgs(state, path), position: { ...at },
  });
  if (isGate(prep)) {
    return { status: prep.status, result: { task: recipe, code: prep.status, message: prep.message, partial: true }, steps: state.steps };
  }
  if (failedStatus(prep.status)) return failureOutput(recipe, prep, state);
  const items = Array.isArray(prep.result) ? prep.result : [];
  const chosen = items.slice(0, CALLERS_ITEMS_MAX);
  const incoming: unknown[] = [];
  let degraded: StrictEnvelope | null = null;
  for (let i = 0; i < chosen.length; i += 1) {
    const res = await dispatch(state, `callers.incoming[${i}]`, {
      operation: "incomingCalls",
      ...(state.workspace ? { workspace: state.workspace } : {}),
      ...(state.dispatchServer && state.dispatchServer.descriptorId !== "unknown"
        ? { server: state.dispatchServer.descriptorId }
        : state.server ? { server: state.server } : {}),
      // Exact opaque hierarchy item, unchanged — never reconstructed.
      item: chosen[i] as Record<string, unknown>,
    });
    if (isGate(res)) {
      return {
        status: res.status,
        result: { task: recipe, code: res.status, message: res.message, partial: true, prepared: items.length, completed: i },
        steps: state.steps,
      };
    }
    if (failedStatus(res.status)) {
      degraded = res;
      continue;
    }
    if (Array.isArray(res.result)) incoming.push(...res.result);
    else if (res.result !== null) incoming.push(res.result);
  }
  const { items: scoped, filteredOut } = applyScope(incoming, state.scope);
  const capped = scoped.length > AFFORDANCE_BOUNDS.perStepResults
    ? scoped.slice(0, AFFORDANCE_BOUNDS.perStepResults)
    : scoped;
  const { projection, truncated } = renderBounded(capped);
  const omittedPrepared = items.length - chosen.length;
  const status: StrictStatus = degraded ? degraded.status : "ok";
  return {
    status,
    result: {
      task: recipe,
      prepared: items.length,
      queried: chosen.length,
      ...(omittedPrepared > 0
        ? {
            omittedPrepared,
            partial: true,
            omission: `only ${chosen.length} of ${items.length} prepared hierarchy items queried; result is incomplete`,
          }
        : {}),
      count: scoped.length,
      items: projection,
      truncated: truncated || omittedPrepared > 0 || capped.length !== scoped.length || prep.meta.truncated,
      filteredOutByScope: filteredOut,
      ...(prep.meta.nextCursor ? { prepareCursor: prep.meta.nextCursor } : {}),
      ...(degraded ? { code: degraded.error?.code ?? degraded.status, message: degraded.error?.message, partial: true } : {}),
    },
    steps: state.steps,
  };
}

/**
 * Run one `investigate` recipe over strict LSP operations.
 *
 * Only `investigateAffordanceTarget` is WP-A2-owned; sibling resolver entry
 * points live in `affordance-anchor.ts` and the frozen shapes in
 * `affordance-contract.ts`.
 */
export async function investigateAffordanceTarget(
  input: AffordanceInvestigateInput,
  ctx: AffordanceExecContext,
): Promise<InvestigationOutput> {
  const { recipe, timeoutCap } = validateInput(input);
  const target = parseTarget(input);
  const now = ctx.now ?? Date.now;
  const started = now();
  const maxRequests = ctx.budget?.maxRequests ?? AFFORDANCE_BOUNDS.underlyingRequests;
  const deadlineMs = ctx.budget?.deadlineMs ?? AFFORDANCE_BOUNDS.aggregateDeadlineMs;
  const signal = ctx.budget?.signal;
  const baseExec = ctx.exec ?? ((req, deps) => executeLspOperation(req, deps));
  const effectiveWorkspace = (input.workspace ?? ctx.workspace ?? ctx.root) as string;
  // Scope validation precedes every server request (caller error, no dispatch).
  const scope = resolveInvestigateScope((input as { scope?: unknown }).scope, effectiveWorkspace);
  const state: RecipeState = {
    steps: [], requests: 0, maxRequests, deadlineMs, started, now, signal,
    exec: baseExec, root: ctx.root,
    workspace: (input.workspace ?? ctx.workspace) as string | undefined,
    server: (input.server ?? ctx.server) as string | undefined,
    timeoutCap, scope, dispatchServer: null,
  };
  const resolved = await resolveDispatchTarget(state, target, {
    ctx, now, started, maxRequests, deadlineMs, signal,
  });
  if (resolved.output) return resolved.output;
  state.dispatchServer = resolved.server;
  if (recipe === "callers") return runCallersRecipe(state, resolved.path, resolved.position);
  return runSingleRecipe(recipe as Exclude<InvestigateTask, "callers">, state, resolved.path, resolved.position);
}
