import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutorConnection } from "./lsp-executor.js";
import type { PreparedDocumentReceipt } from "./lsp-document-store.js";
import type { StrictEnvelope, StrictRange, StrictServerInfo } from "./lsp-strict-contract.js";
import { captureCodeActionPayload } from "./lsp-code-action-payload.js";
import { canonicalActionJson, type ActionJson } from "./lsp-action-json.js";
import { snapshotActionSource } from "./lsp-action-source.js";

export interface BoundActionRequest {
  readonly operation: "codeActions" | "resolveCodeAction";
  readonly path: string;
  readonly range: StrictRange;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly selection?: { readonly actionId: string; readonly sourceSha256: string };
}

export interface BoundActionSession {
  readonly conn: ExecutorConnection;
  readonly server: StrictServerInfo;
  readonly registered: (conn: ExecutorConnection, server: StrictServerInfo) => boolean;
  readonly signal?: AbortSignal;
  readonly deadlineMs: number;
  readonly now?: () => number;
}

/** Private origin data, not stage/apply authority; consumers must revalidate before staging. */
export interface BoundActionOriginHandoff {
  readonly source: { readonly originalPath: string; readonly canonicalPath: string; readonly rawSha256: string; readonly textSha256: string };
  readonly query: { readonly range: StrictRange; readonly context: Readonly<Record<string, unknown>> };
  readonly selection: { readonly actionId: string; readonly rawSha256: string };
  readonly server: StrictServerInfo;
  readonly receipt: PreparedDocumentReceipt;
  readonly originalAction: ActionJson;
  readonly resolvedAction: ActionJson;
}

export interface BoundActionOperationResult {
  readonly envelope: StrictEnvelope;
  readonly origin?: BoundActionOriginHandoff;
}

export type BoundActionOriginRevalidation =
  | { readonly kind: "current" }
  | { readonly kind: "refusal"; readonly status: Exclude<StrictEnvelope["status"], "ok" | "empty" | "error" | "ambiguous"> };

/** Narrow test seam around the production bounded source snapshot algorithm. */
export type BoundActionSourceSnapshotDependency = typeof snapshotActionSource;

const MAX_ACTIONS = 100;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
type Refusal = "unavailable" | "not_ready" | "stale" | "timeout" | "cancelled" | "unsupported";

interface ActionBudget {
  readonly signal: AbortSignal;
  readonly callerSignal?: AbortSignal;
  readonly deadlineMs: number;
  readonly now: () => number;
  check(): Refusal | null;
  dispose(): void;
}

function createActionBudget(deadlineMs: number, callerSignal: AbortSignal | undefined, now: () => number): ActionBudget {
  const controller = new AbortController();
  let deadlineExpired = false;
  let clockUnavailable = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const terminalStop = (): Refusal | null => {
    if (callerSignal?.aborted) {
      controller.abort();
      return "cancelled";
    }
    if (deadlineExpired) {
      controller.abort();
      return "timeout";
    }
    if (clockUnavailable) {
      controller.abort();
      return "unavailable";
    }
    return null;
  };
  const readClock = (): number | Refusal => {
    const terminal = terminalStop();
    if (terminal) return terminal;
    let currentTime: number;
    try { currentTime = now(); }
    catch {
      const afterCallback = terminalStop();
      if (afterCallback) return afterCallback;
      clockUnavailable = true;
      controller.abort();
      return "unavailable";
    }
    const afterCallback = terminalStop();
    if (afterCallback) return afterCallback;
    if (!Number.isFinite(currentTime)) {
      clockUnavailable = true;
      controller.abort();
      return "unavailable";
    }
    return currentTime;
  };
  const check = (): Refusal | null => {
    const terminal = terminalStop();
    if (terminal) return terminal;
    const currentTime = readClock();
    if (typeof currentTime !== "number") return currentTime;
    if (currentTime >= deadlineMs) {
      deadlineExpired = true;
      controller.abort();
      return callerSignal?.aborted ? "cancelled" : "timeout";
    }
    return terminalStop();
  };
  const schedule = (): void => {
    if (disposed || controller.signal.aborted) return;
    const stopped = check();
    if (stopped) return;
    const currentTime = readClock();
    if (typeof currentTime !== "number") return;
    if (currentTime >= deadlineMs) {
      deadlineExpired = true;
      controller.abort();
      return;
    }
    const remaining = deadlineMs - currentTime;
    if (!Number.isFinite(remaining)) {
      clockUnavailable = true;
      controller.abort();
      return;
    }
    const delay = Math.max(1, Math.ceil(Math.min(remaining, 2_147_483_647)));
    timer = setTimeout(schedule, delay);
  };
  const onCallerAbort = () => { controller.abort(); };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  schedule();
  return {
    signal: controller.signal,
    callerSignal,
    deadlineMs,
    now,
    check,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function detachedReceipt(receipt: PreparedDocumentReceipt): PreparedDocumentReceipt {
  return Object.freeze({ ...receipt, syncConfig: Object.freeze({ ...receipt.syncConfig }) });
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function receiptMatches(receipt: PreparedDocumentReceipt | null, path: string, textHash: string, server: StrictServerInfo): receipt is PreparedDocumentReceipt {
  return !!receipt && receipt.canonicalPath === path && receipt.uri === pathToFileURL(path).href &&
    receipt.textHash === textHash && receipt.positionEncoding === server.positionEncoding &&
    receipt.descriptorId === server.descriptorId && receipt.projectRoot === server.projectRoot &&
    receipt.version > 0 && receipt.submissionStamp > 0 && receipt.mutationGeneration >= 0 &&
    receipt.connectionId.length > 0 && receipt.transportId.length > 0 && receipt.storeId.length > 0 && receipt.stateId.length > 0 &&
    receipt.syncConfig.openClose && receipt.syncConfig.change !== "none";
}

export function sameReceipt(a: PreparedDocumentReceipt, b: PreparedDocumentReceipt | null | undefined): boolean {
  return !!b && a.canonicalPath === b.canonicalPath && a.uri === b.uri && a.version === b.version && a.textHash === b.textHash &&
    a.mutationGeneration === b.mutationGeneration && a.submissionStamp === b.submissionStamp &&
    a.syncConfig.openClose === b.syncConfig.openClose && a.syncConfig.change === b.syncConfig.change &&
    a.connectionId === b.connectionId && a.transportId === b.transportId && a.storeId === b.storeId && a.stateId === b.stateId &&
    a.descriptorId === b.descriptorId && a.projectRoot === b.projectRoot && a.positionEncoding === b.positionEncoding;
}

function envelope(operation: BoundActionRequest["operation"], server: StrictServerInfo, status: Refusal | "ok" | "empty", result: unknown = null): StrictEnvelope {
  return { status: status === "stale" ? "not_ready" : status, operation, method: operation === "codeActions" ? "textDocument/codeAction" : "codeAction/resolve", server, result, meta: { truncated: false } };
}

function preservesOriginalAction(original: ActionJson, resolved: ActionJson): boolean {
  if (!original || typeof original !== "object" || Array.isArray(original) ||
      !resolved || typeof resolved !== "object" || Array.isArray(resolved)) return false;
  const originalRecord = original as Readonly<Record<string, ActionJson>>;
  const resolvedRecord = resolved as Readonly<Record<string, ActionJson>>;
  try {
    for (const key of Object.keys(originalRecord)) {
      if (!Object.hasOwn(resolvedRecord, key) || canonicalActionJson(originalRecord[key]) !== canonicalActionJson(resolvedRecord[key])) return false;
    }
    for (const key of Object.keys(resolvedRecord)) {
      if (!Object.hasOwn(originalRecord, key) && (key !== "edit" || Object.hasOwn(originalRecord, "edit"))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validRange(range: unknown): range is StrictRange {
  if (!range || typeof range !== "object") return false;
  const r = range as StrictRange;
  return [r.start?.line, r.start?.character, r.end?.line, r.end?.character].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    (r.end.line > r.start.line || (r.end.line === r.start.line && r.end.character >= r.start.character));
}

async function awaited<T>(promise: Promise<T>, budget: ActionBudget): Promise<{ value: T } | { refusal: Refusal }> {
  const pending = promise.then((value) => ({ value }), () => ({ refusal: "unavailable" as const }));
  const stopped = new Promise<{ refusal: Refusal }>((resolveStop) => {
    const onAbort = () => resolveStop({ refusal: budget.check() ?? "cancelled" });
    budget.signal.addEventListener("abort", onAbort, { once: true });
    if (budget.signal.aborted) onAbort();
    void pending.finally(() => budget.signal.removeEventListener("abort", onAbort));
  });
  const result = await Promise.race([pending, stopped]);
  const after = budget.check();
  return after ? { refusal: after } : result;
}

export type BoundActionBudget = ActionBudget;
export const createBoundActionBudget = createActionBudget;
export const awaitBoundAction = awaited;

/**
 * Revalidate an immutable private action origin while its exact session lease is held.
 * `current` means only that the caller-observed source, submission receipt, and
 * registration still match; it is not server acknowledgement, indexing, or apply authority.
 */
export async function revalidateBoundActionOrigin(
  origin: BoundActionOriginHandoff,
  session: BoundActionSession,
  deps: { readonly snapshot?: BoundActionSourceSnapshotDependency } = {},
): Promise<BoundActionOriginRevalidation> {
  const refused = (status: Refusal): BoundActionOriginRevalidation => ({ kind: "refusal", status: status === "stale" ? "not_ready" : status });
  const callerSignal = session.signal;
  if (callerSignal?.aborted) return refused("cancelled");
  const deadlineMs = session.deadlineMs;
  if (callerSignal?.aborted) return refused("cancelled");
  if (!Number.isFinite(deadlineMs)) return refused("unavailable");
  const now = session.now ?? Date.now;
  if (callerSignal?.aborted) return refused("cancelled");
  const budget = createActionBudget(deadlineMs, callerSignal, now);
  const stop = (): Refusal | null => {
    try { return budget.check(); } catch { return "unavailable"; }
  };
  const registered = (): boolean => {
    try {
      const { conn, server } = session;
      const languages = Array.isArray(conn.languageIds) ? conn.languageIds : [conn.languageId];
      return session.conn === conn && conn.descriptorId === server.descriptorId && conn.name === server.name &&
        conn.projectRoot === server.projectRoot && languages.includes(server.languageId) &&
        conn.getNegotiatedEncoding?.() === server.positionEncoding && session.registered(conn, server) === true;
    } catch { return false; }
  };
  try {
    const atEntry = stop();
    if (atEntry) return refused(atEntry);
    const { source, server, receipt, selection } = origin;
    if (!source || !origin.query || !server || !receipt || !selection || !source.originalPath || !source.canonicalPath ||
        !validRange(origin.query.range) || !origin.query.context || typeof origin.query.context !== "object" || Array.isArray(origin.query.context) ||
        !/^[a-f0-9]{64}$/.test(source.rawSha256) || !/^[a-f0-9]{64}$/.test(source.textSha256) ||
        selection.rawSha256 !== source.rawSha256 || !/^[a-f0-9]{64}$/.test(selection.actionId) || !originSelectionMatches(origin) ||
        server.descriptorId !== session.server.descriptorId || server.name !== session.server.name ||
        server.languageId !== session.server.languageId || server.projectRoot !== session.server.projectRoot ||
        server.positionEncoding !== session.server.positionEncoding || !registered() || !connReceiptAvailable(session.conn)) {
      return refused(stop() ?? "stale");
    }
    const firstStop = stop();
    if (firstStop) return refused(firstStop);
    const currentReceipt = session.conn.getDocumentReceipt!(source.canonicalPath);
    const afterGetter = stop();
    if (afterGetter) return refused(afterGetter);
    if (!receiptMatches(receipt, source.canonicalPath, source.textSha256, server) || !sameReceipt(receipt, currentReceipt) ||
        !registered()) return refused(stop() ?? "stale");

    const read = await awaited((deps.snapshot ?? snapshotActionSource)(source.originalPath, {
      signal: budget.signal, deadlineMs: budget.deadlineMs, now: budget.now,
    }), budget);
    if ("refusal" in read) return refused(read.refusal);
    if (!read.value.ok) {
      const afterReadFailure = stop();
      return refused(afterReadFailure ?? (read.value.reason === "cancelled" || read.value.reason === "timeout" ? read.value.reason : "stale"));
    }
    const afterRead = stop();
    if (afterRead) return refused(afterRead);
    if (read.value.snapshot.canonicalPath !== source.canonicalPath ||
        read.value.snapshot.rawSha256 !== source.rawSha256 || read.value.snapshot.textSha256 !== source.textSha256 ||
        !registered()) return refused(stop() ?? "stale");
    const finalReceipt = session.conn.getDocumentReceipt!(source.canonicalPath);
    const afterFinalGetter = stop();
    if (afterFinalGetter) return refused(afterFinalGetter);
    if (!sameReceipt(receipt, finalReceipt) || !registered()) return refused(stop() ?? "stale");
    const publicationStop = stop();
    if (publicationStop) return refused(publicationStop);
    return { kind: "current" };
  } catch {
    return refused(stop() ?? "unavailable");
  } finally {
    budget.dispose();
  }
}

function originSelectionMatches(origin: BoundActionOriginHandoff): boolean {
  try {
    const { source, query, selection, server, originalAction } = origin;
    const identity = {
      version: "pi-smartread-code-action-v2", payload: originalAction,
      query: { path: source.canonicalPath, sourceSha256: source.rawSha256, range: query.range, context: query.context ?? null },
      server,
    };
    return sha256(canonicalActionJson(identity)) === selection.actionId;
  } catch { return false; }
}

function connReceiptAvailable(conn: ExecutorConnection): boolean {
  return typeof conn.getDocumentReceipt === "function";
}

export async function runBoundActionOperation(request: BoundActionRequest, session: BoundActionSession): Promise<BoundActionOperationResult> {
  const deadlineMs = session.deadlineMs;
  if (!Number.isFinite(deadlineMs)) throw new Error("deadlineMs must be finite");
  const callerSignal = session.signal;
  const now = session.now ?? Date.now;
  const budget = createActionBudget(deadlineMs, callerSignal, now);
  try { return await runBoundActionOperationWithBudget(request, session, budget); }
  finally { budget.dispose(); }
}

async function runBoundActionOperationWithBudget(request: BoundActionRequest, session: BoundActionSession, budget: ActionBudget): Promise<BoundActionOperationResult> {
  const { operation, path, range } = request;
  const conn = session.conn;
  const server = Object.freeze({ ...session.server });
  const fail = (status: Refusal | "ok" | "empty", result: unknown = null): BoundActionOperationResult => {
    const stopped = budget.check();
    return { envelope: stopped ? envelope(operation, server, stopped) : envelope(operation, server, status, result) };
  };
  const entryStop = budget.check();
  if (entryStop) return fail(entryStop);
  if ((operation !== "codeActions" && operation !== "resolveCodeAction") || typeof path !== "string" || !path || !validRange(range) ||
      (request.context !== undefined && (!request.context || typeof request.context !== "object" || Array.isArray(request.context))) ||
      (operation === "resolveCodeAction" && (!request.selection || typeof request.selection.actionId !== "string" || !/^[a-f0-9]{64}$/.test(request.selection.actionId) || !/^[a-f0-9]{64}$/.test(request.selection.sourceSha256)))) {
    throw new Error("invalid bound action request");
  }
  if (server.positionEncoding !== "utf-16" && server.positionEncoding !== "utf-8" && server.positionEncoding !== "utf-32") return fail("unsupported");
  const languageMatches = Array.isArray(conn.languageIds)
    ? conn.languageIds.includes(server.languageId)
    : conn.languageId === server.languageId;
  if (conn.descriptorId !== server.descriptorId || conn.name !== server.name || !languageMatches ||
      conn.projectRoot !== server.projectRoot || conn.getNegotiatedEncoding?.() !== server.positionEncoding) return fail("unavailable");
  const capturedRange = structuredClone(range);
  const selection = request.selection === undefined ? undefined : structuredClone(request.selection);
  let capturedContext: Record<string, unknown>;
  try { capturedContext = request.context === undefined
    ? { diagnostics: [] }
    : JSON.parse(canonicalActionJson(request.context)) as Record<string, unknown>; }
  catch { throw new Error("invalid bound action context"); }
  const sourcePath = resolve(path);
  const checkRegistration = () => {
    try { return session.conn === conn && session.registered(conn, server) === true; }
    catch { return false; }
  };
  const validSession = () => checkRegistration() && conn.getDocumentReceipt !== undefined;
  if (!validSession()) return fail(budget.check() ?? "unavailable");
  const beforeSourceStop = budget.check();
  if (beforeSourceStop) return fail(beforeSourceStop);
  const initial = await awaited(snapshotActionSource(sourcePath, { signal: budget.signal, deadlineMs: budget.deadlineMs, now: budget.now }), budget);
  if ("refusal" in initial) return fail(initial.refusal);
  if (!initial.value.ok) return fail(initial.value.reason === "timeout" || initial.value.reason === "cancelled" ? initial.value.reason : "stale");
  const source = initial.value.snapshot;
  if (operation === "resolveCodeAction" && selection!.sourceSha256 !== source.rawSha256) return fail(budget.check() ?? "stale");
  if (!validSession()) return fail(budget.check() ?? "stale");
  if (!conn.prepareDocument || !conn.getDocumentReceipt) return fail("unavailable");
  const beforePrepareStop = budget.check();
  if (beforePrepareStop) return fail(beforePrepareStop);
  const prepared = await awaited(conn.prepareDocument(source.canonicalPath, source.text, { signal: budget.signal, deadlineMs: budget.deadlineMs }), budget);
  if ("refusal" in prepared) return fail(prepared.refusal);
  if (!prepared.value || !validSession()) return fail(budget.check() ?? "stale");
  const before = conn.getDocumentReceipt(source.canonicalPath);
  if (!receiptMatches(before, source.canonicalPath, source.textSha256, server) || !sameReceipt(before, prepared.value)) return fail(budget.check() ?? "stale");
  const methodParams = {
    textDocument: { uri: pathToFileURL(source.canonicalPath).href },
    range: capturedRange,
    ...(capturedContext ? { context: capturedContext } : {}),
  };
  const beforeQueryStop = budget.check();
  if (beforeQueryStop) return fail(beforeQueryStop);
  const queried = await awaited(conn.request("textDocument/codeAction", methodParams, { signal: budget.signal }), budget);
  if ("refusal" in queried) return fail(queried.refusal);
  if (!validSession() || !sameReceipt(before, conn.getDocumentReceipt(source.canonicalPath))) return fail(budget.check() ?? "stale");
  const finalSource = await awaited(snapshotActionSource(sourcePath, { signal: budget.signal, deadlineMs: budget.deadlineMs, now: budget.now }), budget);
  if ("refusal" in finalSource) return fail(finalSource.refusal);
  if (!finalSource.value.ok) return fail(finalSource.value.reason === "timeout" || finalSource.value.reason === "cancelled" ? finalSource.value.reason : "stale");
  if ((finalSource.value.snapshot.canonicalPath !== source.canonicalPath || finalSource.value.snapshot.rawSha256 !== source.rawSha256) || !validSession() || !sameReceipt(before, conn.getDocumentReceipt(source.canonicalPath))) return fail(budget.check() ?? "stale");
  if (!Array.isArray(queried.value)) return fail("unavailable");
  if (queried.value.length > MAX_ACTIONS) return fail("unavailable");
  const candidates: Array<{ id: string; payload: ActionJson; projection: unknown; selectable: boolean }> = [];
  const seen = new Set<string>();
  for (const raw of queried.value) {
    const captured = captureCodeActionPayload(raw);
    if (!captured.ok || !captured.selectable) return fail("unavailable");
    const identity = {
      version: "pi-smartread-code-action-v2", payload: captured.payload,
      query: { path: source.canonicalPath, sourceSha256: source.rawSha256, range: capturedRange, context: capturedContext ?? null },
      server,
    };
    let id: string;
    try { id = sha256(canonicalActionJson(identity)); }
    catch { return fail("unavailable"); }
    if (seen.has(id)) return fail("unavailable");
    seen.add(id);
    candidates.push({ id, payload: captured.payload, projection: captured.projection, selectable: captured.selectable });
  }
  if (operation === "codeActions") {
    if (!candidates.length) return fail("empty", []);
    return fail("ok", candidates.map(({ id, projection }) => ({ ...(projection as object), actionId: id, sourceSha256: source.rawSha256 })));
  }
  const matches = candidates.filter((candidate) => candidate.id === selection!.actionId && candidate.selectable);
  if (matches.length !== 1 || selection!.sourceSha256 !== source.rawSha256) return fail(budget.check() ?? "stale");
  if (!validSession() || !sameReceipt(before, conn.getDocumentReceipt(source.canonicalPath))) return fail(budget.check() ?? "stale");
  const beforeResolveStop = budget.check();
  if (beforeResolveStop) return fail(beforeResolveStop);
  const resolved = await awaited(conn.request("codeAction/resolve", matches[0]!.payload, { signal: budget.signal }), budget);
  if ("refusal" in resolved) return fail(resolved.refusal);
  if (!validSession() || !sameReceipt(before, conn.getDocumentReceipt(source.canonicalPath))) return fail(budget.check() ?? "stale");
  const lastSource = await awaited(snapshotActionSource(sourcePath, { signal: budget.signal, deadlineMs: budget.deadlineMs, now: budget.now }), budget);
  if ("refusal" in lastSource) return fail(lastSource.refusal);
  if (!lastSource.value.ok) return fail(lastSource.value.reason === "timeout" || lastSource.value.reason === "cancelled" ? lastSource.value.reason : "stale");
  if ((lastSource.value.snapshot.canonicalPath !== source.canonicalPath || lastSource.value.snapshot.rawSha256 !== source.rawSha256) || !validSession() || !sameReceipt(before, conn.getDocumentReceipt(source.canonicalPath))) return fail(budget.check() ?? "stale");
  const captured = captureCodeActionPayload(resolved.value);
  if (!captured.ok || !captured.selectable || !preservesOriginalAction(matches[0]!.payload, captured.payload)) return fail("unsupported");
  const result = fail("ok", { ...captured.projection, sourceDocument: { canonicalPath: source.canonicalPath, sha256: source.rawSha256 }, selection });
  if (result.envelope.status !== "ok") return result;
  const origin: BoundActionOriginHandoff = Object.freeze({
    source: Object.freeze({ originalPath: sourcePath, canonicalPath: source.canonicalPath, rawSha256: source.rawSha256, textSha256: source.textSha256 }),
    query: Object.freeze({ range: freezeTree(capturedRange), context: freezeTree(capturedContext) }),
    selection: Object.freeze({ actionId: matches[0]!.id, rawSha256: source.rawSha256 }),
    server,
    receipt: detachedReceipt(before),
    originalAction: matches[0]!.payload,
    resolvedAction: captured.payload,
  });
  const stopped = budget.check();
  return stopped ? { envelope: envelope(operation, server, stopped) } : { envelope: result.envelope, origin };
}
