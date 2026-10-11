import { resolve } from "node:path";
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { waitForLease, type BoundActionCleanup, type BoundActionOutcome } from "./lsp-action-adapter.js";
import type { BoundActionStageResult } from "./lsp-action-continuation.js";
import { ACTION_SERIALIZED_EDIT_MAX_BYTES, snapshotActionJson } from "./lsp-action-json.js";
import { convertFormattingTextEdits, convertRawWorkspaceEdit } from "./lsp-action-edit-preparation.js";
import { awaitBoundAction, createBoundActionBudget, receiptMatches, sameReceipt, type BoundActionBudget } from "./lsp-action-origin.js";
import { ACTION_SEMANTIC_EDIT_MAX_BYTES, snapshotActionSource, type ActionSourceSnapshot } from "./lsp-action-source.js";
import type { PreparedDocumentReceipt } from "./lsp-document-store.js";
import { acquireBoundSession, type BoundSessionLease } from "./lsp-manager.js";
import { getOperationDef } from "./lsp-operation-registry.js";
import { normalizeTextEdits, normalizeWorkspaceEdit } from "./lsp-response-normalizer.js";
import {
  classifyStatus,
  type StrictEnvelope,
  type StrictMeta,
  type StrictPosition,
  type StrictRange,
  type StrictRequest,
  type StrictServerInfo,
  type StrictStatus,
} from "./lsp-strict-contract.js";

export type BoundSemanticEditOperation = "rename" | "formatDocument" | "formatRange" | "formatOnType";
export type BoundSemanticEditOutcome = BoundActionOutcome;

export interface BoundSemanticEditRoute {
  readonly projectRoot: string;
  readonly languageId: string;
  readonly server?: string;
}

/** Private staging packet; a superset of the code-action packet with a wider `operation`. */
export interface BoundSemanticEditPacket {
  readonly prepared: LspWorkspaceEdit;
  readonly document: Readonly<{ canonicalPath: string; sha256: string }>;
  readonly serverDescriptor: StrictServerInfo;
  readonly operation: BoundSemanticEditOperation;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly originalSignal?: AbortSignal;
  readonly ownedSignal: AbortSignal;
}

export interface BoundSemanticEditDependencies {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly acquire?: typeof acquireBoundSession;
  readonly stage?: (packet: BoundSemanticEditPacket) => Promise<BoundActionStageResult>;
}

type RefusalStatus = Exclude<StrictStatus, "ok" | "empty" | "error" | "ambiguous">;
type Stop = "cancelled" | "timeout" | "unavailable" | "not_ready" | null;
type CleanupState = BoundActionCleanup["state"];
type CleanupHandle = { readonly promise: Promise<BoundActionCleanup>; complete(state: CleanupState): void };
type BoundProposal = { readonly proposalId: string; readonly files: readonly string[]; readonly diff: string };
type Produced =
  | { readonly kind: "result"; readonly envelope: StrictEnvelope; readonly proposal?: BoundProposal }
  | { readonly kind: "refusal"; readonly status: RefusalStatus };

interface CapturedRequest {
  readonly operation: BoundSemanticEditOperation;
  readonly path: string;
  readonly position?: StrictPosition;
  readonly range?: StrictRange;
  readonly newName?: string;
  readonly ch?: string;
  readonly formatting: { readonly tabSize: number; readonly insertSpaces: boolean };
}

const OPERATION_METHODS: Readonly<Record<BoundSemanticEditOperation, string>> = {
  rename: "textDocument/rename",
  formatDocument: "textDocument/formatting",
  formatRange: "textDocument/rangeFormatting",
  formatOnType: "textDocument/onTypeFormatting",
};
const DEFAULT_FORMATTING = Object.freeze({ tabSize: 2, insertSpaces: true });

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function validPosition(value: unknown): value is StrictPosition {
  return !!value && typeof value === "object" && isCount((value as StrictPosition).line) && isCount((value as StrictPosition).character);
}
function validRange(value: unknown): value is StrictRange {
  if (!value || typeof value !== "object") return false;
  const { start, end } = value as StrictRange;
  return validPosition(start) && validPosition(end) && (end.line > start.line || (end.line === start.line && end.character >= start.character));
}

/** Copies the explicit request fields so later caller mutation cannot change wire params. Never infers a target. */
function captureRequest(request: StrictRequest): CapturedRequest | null {
  const { operation, path } = request;
  if (operation !== "rename" && operation !== "formatDocument" && operation !== "formatRange" && operation !== "formatOnType") return null;
  if (typeof path !== "string" || path.length === 0) return null;
  const formatting = request.formatting === undefined ? DEFAULT_FORMATTING : request.formatting;
  if (!formatting || !Number.isSafeInteger(formatting.tabSize) || typeof formatting.insertSpaces !== "boolean") return null;
  const base = { operation, path, formatting: { tabSize: formatting.tabSize, insertSpaces: formatting.insertSpaces } };
  switch (operation) {
    case "rename":
      return validPosition(request.position) && typeof request.newName === "string" && request.newName.length > 0
        ? { ...base, position: structuredClone(request.position), newName: request.newName } : null;
    case "formatDocument":
      return base;
    case "formatRange":
      return validRange(request.range) ? { ...base, range: structuredClone(request.range) } : null;
    case "formatOnType":
      return validPosition(request.position) && typeof request.ch === "string" && request.ch.length > 0
        ? { ...base, position: structuredClone(request.position), ch: request.ch } : null;
  }
}

/** Mirrors the executor's buildParams for these operations. */
function wireParams(request: CapturedRequest, uri: string): Record<string, unknown> {
  const textDocument = { uri };
  switch (request.operation) {
    case "rename": return { textDocument, position: request.position, newName: request.newName };
    case "formatDocument": return { textDocument, options: request.formatting };
    case "formatRange": return { textDocument, range: request.range, options: request.formatting };
    case "formatOnType": return { textDocument, position: request.position, ch: request.ch, options: request.formatting };
  }
}

function detachedReceipt(receipt: PreparedDocumentReceipt): PreparedDocumentReceipt {
  return Object.freeze({ ...receipt, syncConfig: Object.freeze({ ...receipt.syncConfig }) });
}

function stopReason(budget: BoundActionBudget): Stop {
  const status = budget.check();
  return status === "stale" || status === "unsupported" ? "unavailable" : status;
}

function publicationStop(signal: AbortSignal | undefined, outer: Stop, known: RefusalStatus | null): RefusalStatus | null {
  if (signal?.aborted || outer === "cancelled" || known === "cancelled") return "cancelled";
  if (outer === "timeout" || known === "timeout") return "timeout";
  return outer ?? known;
}

function outcomeRefusal(status: RefusalStatus, cleanup: Promise<BoundActionCleanup>, server?: StrictServerInfo): BoundSemanticEditOutcome {
  return server ? { kind: "refusal", status, server, cleanup } : { kind: "refusal", status, cleanup };
}

function settledCleanup(state: CleanupState): Promise<BoundActionCleanup> {
  return Promise.resolve(Object.freeze({ state }));
}

function makeCleanup(): CleanupHandle {
  let resolveCleanup!: (state: BoundActionCleanup) => void;
  const promise = new Promise<BoundActionCleanup>((done) => { resolveCleanup = done; });
  let completed = false;
  return {
    promise,
    complete: (state) => {
      if (completed) return;
      completed = true;
      resolveCleanup(Object.freeze({ state }));
    },
  };
}

function releaseOnce(lease: BoundSessionLease, cleanup: CleanupHandle): CleanupState {
  try {
    lease.release();
    cleanup.complete("released");
    return "released";
  } catch {
    cleanup.complete("failed");
    return "failed";
  }
}

type RequestSettlement = { readonly ok: true; readonly raw: unknown } | { readonly ok: false; readonly error: unknown };

function failureEnvelope(
  operation: BoundSemanticEditOperation,
  server: StrictServerInfo,
  error: { code: string; message: string },
): StrictEnvelope {
  return {
    status: classifyStatus({ kind: "transport-error" }), operation, method: OPERATION_METHODS[operation], server,
    result: null, meta: { truncated: false }, error,
  };
}

function normalizeReply(operation: BoundSemanticEditOperation, raw: unknown): { value: unknown; malformed: boolean } {
  if (raw === null || raw === undefined) return { value: null, malformed: false };
  const value = operation === "rename" ? normalizeWorkspaceEdit(raw) : normalizeTextEdits(raw);
  return value === null ? { value: null, malformed: true } : { value, malformed: false };
}

const isEmptyValue = (value: unknown): boolean => value === null || value === undefined || (Array.isArray(value) && value.length === 0);

function projectStageResult(value: unknown): { kind: "staged"; proposal: BoundProposal } | { kind: "refused"; status: RefusalStatus } {
  const unavailable = { kind: "refused", status: "unavailable" } as const;
  try {
    if (!value || typeof value !== "object") return unavailable;
    const result = value as { kind?: unknown; reason?: unknown; proposal?: { proposalId?: unknown; files?: unknown; diff?: unknown } };
    if (result.kind === "refused") {
      const reason = result.reason === "stale" ? "not_ready" : result.reason;
      return reason === "cancelled" || reason === "timeout" || reason === "not_ready" || reason === "unsupported"
        ? { kind: "refused", status: reason } : unavailable;
    }
    const proposal = result.kind === "staged" ? result.proposal : undefined;
    if (!proposal || typeof proposal.proposalId !== "string" || proposal.proposalId.length === 0 ||
        typeof proposal.diff !== "string" || !Array.isArray(proposal.files) || proposal.files.some((file) => typeof file !== "string")) return unavailable;
    return { kind: "staged", proposal: Object.freeze({ proposalId: proposal.proposalId, files: Object.freeze([...proposal.files as string[]]), diff: proposal.diff }) };
  } catch { return unavailable; }
}

interface Occupancy { pending: Promise<void> | null; settled: boolean }

interface ProduceContext {
  readonly request: CapturedRequest;
  readonly route: BoundSemanticEditRoute;
  readonly lease: BoundSessionLease;
  readonly deps: Required<Pick<BoundSemanticEditDependencies, "deadlineMs" | "now">> & Pick<BoundSemanticEditDependencies, "signal" | "stage">;
  readonly budget: BoundActionBudget;
  readonly stop: Stop;
  readonly occupancy: Occupancy;
}

async function produce(ctx: ProduceContext): Promise<{ readonly server?: StrictServerInfo; readonly produced: Produced }> {
  const { request, route, lease, deps, budget, occupancy } = ctx;
  const { operation } = request;
  const registration = lease.registration;
  let server: StrictServerInfo | undefined;
  const refuse = (status: RefusalStatus): { server?: StrictServerInfo; produced: Produced } => {
    const stopped = stopReason(budget);
    return { ...(server ? { server } : {}), produced: { kind: "refusal", status: stopped ?? status } };
  };
  try {
    if (ctx.stop) return refuse(ctx.stop);
    if (registration.projectRoot !== route.projectRoot || (route.server !== undefined && registration.descriptorId !== route.server) ||
        !registration.languageIds.includes(route.languageId)) return refuse("unavailable");
    server = Object.freeze({
      descriptorId: registration.descriptorId,
      name: registration.name,
      projectRoot: registration.projectRoot,
      languageId: route.languageId,
      positionEncoding: registration.positionEncoding,
    });
    const info = server;
    const conn = lease.conn;
    const current = (): boolean => {
      try { return lease.registration === registration && lease.isCurrent(); }
      catch { return false; }
    };
    const connMatches = (): boolean => {
      try {
        return conn.descriptorId === info.descriptorId && conn.name === info.name && conn.projectRoot === info.projectRoot &&
          conn.languageIds.includes(info.languageId) && conn.getNegotiatedEncoding?.() === info.positionEncoding &&
          typeof conn.prepareDocument === "function" && typeof conn.getDocumentReceipt === "function";
      } catch { return false; }
    };
    const valid = (): boolean => current() && connMatches();
    if (!current()) return refuse("not_ready");
    if (!connMatches()) return refuse("unavailable");

    const preview = (envelope: StrictEnvelope): { server?: StrictServerInfo; produced: Produced } => ({ server: info, produced: { kind: "result", envelope } });
    const method = OPERATION_METHODS[operation];
    const def = getOperationDef(operation);
    let supported: boolean | null = null;
    try {
      const registry = def?.capability ? conn.getCapabilityRegistry?.() ?? null : null;
      if (registry && def?.capability) supported = registry.can(def.capability);
    } catch { supported = null; }
    if (supported === false) {
      return preview({ status: classifyStatus({ kind: "unsupported" }), operation, method, server: info, result: null, meta: { truncated: false } });
    }

    const snapshotOptions = { signal: budget.signal, deadlineMs: budget.deadlineMs, now: budget.now, maxBytes: ACTION_SEMANTIC_EDIT_MAX_BYTES };
    const sourceCheck = async (): Promise<ActionSourceSnapshot | "stale" | { refusal: RefusalStatus }> => {
      const read = await awaitBoundAction(snapshotActionSource(request.path, snapshotOptions), budget);
      if ("refusal" in read) return { refusal: read.refusal === "stale" ? "not_ready" : read.refusal };
      if (read.value.ok) return read.value.snapshot;
      if (read.value.reason === "cancelled" || read.value.reason === "timeout") return { refusal: read.value.reason };
      if (read.value.reason === "unavailable") return { refusal: "unavailable" };
      return read.value.reason === "stale" ? "stale" : { refusal: "unsupported" };
    };

    const initial = await awaitBoundAction(snapshotActionSource(request.path, snapshotOptions), budget);
    if ("refusal" in initial) return refuse(initial.refusal === "stale" ? "not_ready" : initial.refusal);
    let source: ActionSourceSnapshot | null = null;
    if (initial.value.ok) source = initial.value.snapshot;
    else if (initial.value.reason === "cancelled" || initial.value.reason === "timeout") return refuse(initial.value.reason);
    else if (initial.value.reason === "stale") return refuse("not_ready");
    else if (initial.value.reason === "unavailable") return refuse("unavailable");
    // too-large / invalid-utf8: the preview is still produced, but the document is not stage-eligible.
    if (!valid()) return refuse("not_ready");
    const beforePrepare = stopReason(budget);
    if (beforePrepare) return refuse(beforePrepare);

    const prepared = await awaitBoundAction(
      Promise.resolve().then(() => conn.prepareDocument!(source?.canonicalPath ?? resolve(request.path), source?.text, { signal: budget.signal, deadlineMs: budget.deadlineMs })),
      budget,
    );
    if ("refusal" in prepared) return refuse(prepared.refusal === "stale" ? "not_ready" : prepared.refusal);
    if (!prepared.value || !valid()) return refuse("not_ready");
    const target = source?.canonicalPath ?? prepared.value.canonicalPath;
    const before = conn.getDocumentReceipt!(target);
    // Without a source snapshot there is no expected hash; reuse the live hash so only that clause is bypassed.
    if (!receiptMatches(before, target, source?.textSha256 ?? before?.textHash ?? "", info) || !sameReceipt(before, prepared.value)) return refuse("not_ready");
    const receipt = detachedReceipt(before);
    const unchanged = (): boolean => valid() && sameReceipt(receipt, conn.getDocumentReceipt!(target));

    const params = wireParams(request, receipt.uri);
    const beforeQuery = stopReason(budget);
    if (beforeQuery) return refuse(beforeQuery);
    const settled = await awaitBoundAction<RequestSettlement>(
      Promise.resolve().then(() => conn.request(method, params, { signal: budget.signal })).then(
        (raw): RequestSettlement => ({ ok: true, raw }), (error): RequestSettlement => ({ ok: false, error })),
      budget,
    );
    if ("refusal" in settled) return refuse(settled.refusal === "stale" ? "not_ready" : settled.refusal);
    if (!settled.value.ok) {
      const error = settled.value.error as { name?: string; message?: unknown } | null;
      if (error?.name === "AbortError" || error?.name === "LspRequestCancelledError") return refuse("cancelled");
      if (error?.name === "LspRequestTimeoutError") return refuse("timeout");
      return preview(failureEnvelope(operation, info, { code: error?.name ?? "error", message: String(error?.message ?? "request failed") }));
    }
    if (!unchanged()) return refuse("not_ready");

    // One reply, captured once: detached JSON when within the staging cap, else the raw reply (preview only).
    let captured: unknown = settled.value.raw;
    let withinCap = false;
    try {
      captured = snapshotActionJson(settled.value.raw, { maxBytes: ACTION_SERIALIZED_EDIT_MAX_BYTES });
      withinCap = true;
    } catch { /* oversized or non-JSON reply: preview-only */ }

    const { value, malformed } = normalizeReply(operation, captured);
    if (malformed) return preview(failureEnvelope(operation, info, { code: "normalization", message: `malformed ${operation} response` }));
    const publish = (freshness: "fresh" | "unknown", proposal?: BoundProposal): { server?: StrictServerInfo; produced: Produced } => {
      const meta: StrictMeta = { truncated: false, documentVersion: receipt.version, freshness: { state: freshness, documentVersion: receipt.version } };
      const envelope: StrictEnvelope = {
        status: classifyStatus({ kind: isEmptyValue(value) ? "success-empty" : "success-value" }), operation, method, server: info, result: value, meta,
      };
      return { server: info, produced: { kind: "result", envelope, ...(proposal ? { proposal } : {}) } };
    };

    const eligible = !!deps.stage && !!source && withinCap && !isEmptyValue(value) &&
      info.positionEncoding === "utf-16" && receipt.positionEncoding === "utf-16";
    if (!eligible || !source) return publish("unknown");
    const edit = operation === "rename"
      ? convertRawWorkspaceEdit(captured, { canonicalPath: source.canonicalPath, rawSha256: source.rawSha256, receiptVersion: receipt.version })
      : convertFormattingTextEdits(captured, { canonicalPath: source.canonicalPath, rawSha256: source.rawSha256 });
    if (edit.kind === "refusal") return publish("unknown");

    const sourceUnchanged = async (): Promise<RefusalStatus | null> => {
      const again = await sourceCheck();
      if (typeof again === "string") return "not_ready";
      if ("refusal" in again) return again.refusal;
      return again.canonicalPath === source.canonicalPath && again.rawSha256 === source.rawSha256 ? null : "not_ready";
    };
    const staleBeforeStage = await sourceUnchanged();
    if (staleBeforeStage) return refuse(staleBeforeStage);
    if (!unchanged()) return refuse("not_ready");
    const beforeStage = stopReason(budget);
    if (beforeStage) return refuse(beforeStage);

    const packet: BoundSemanticEditPacket = Object.freeze({
      prepared: edit.workspaceEdit,
      document: edit.document,
      serverDescriptor: info,
      operation,
      deadlineMs: budget.deadlineMs,
      now: budget.now,
      ...(deps.signal ? { originalSignal: deps.signal } : {}),
      ownedSignal: budget.signal,
    });
    const staging = Promise.resolve().then(() => deps.stage!(packet));
    occupancy.settled = false;
    occupancy.pending = staging.then(() => undefined, () => undefined).then(() => { occupancy.settled = true; });
    const staged = await awaitBoundAction<unknown>(staging, budget);
    if ("refusal" in staged) return refuse(staged.refusal === "stale" ? "not_ready" : staged.refusal);
    const projected = projectStageResult(staged.value);
    if (projected.kind === "refused") {
      if (projected.status === "cancelled" || projected.status === "timeout" || projected.status === "not_ready") return refuse(projected.status);
      return publish("unknown");
    }
    const staleAfterStage = await sourceUnchanged();
    if (staleAfterStage) return refuse(staleAfterStage);
    if (!unchanged()) return refuse("not_ready");
    const finalStop = stopReason(budget);
    if (finalStop) return refuse(finalStop);
    return publish("fresh", projected.proposal);
  } catch {
    return refuse("unavailable");
  }
}

/**
 * Bounded producer for rename/format staging proposals. One lease, one budget, exactly one semantic
 * request. The public envelope is the read-only preview; a proposal exists only when the staging
 * caps and eligibility checks pass and the stage dependency accepts the packet.
 */
export async function executeBoundSemanticEdit(
  request: StrictRequest,
  route: BoundSemanticEditRoute,
  dependencies: BoundSemanticEditDependencies,
): Promise<BoundSemanticEditOutcome> {
  const deadlineMs = dependencies.deadlineMs;
  const signal = dependencies.signal;
  const now = dependencies.now ?? Date.now;
  const acquire = dependencies.acquire ?? acquireBoundSession;
  const captured = captureRequest(request);
  if (!captured) return outcomeRefusal("unsupported", settledCleanup("not-acquired"));
  if (signal?.aborted) return outcomeRefusal("cancelled", settledCleanup("not-acquired"));
  if (!Number.isFinite(deadlineMs)) return outcomeRefusal("unsupported", settledCleanup("not-acquired"));
  let initialTime: number;
  try { initialTime = now(); } catch {
    return outcomeRefusal(signal?.aborted ? "cancelled" : "unsupported", settledCleanup("not-acquired"));
  }
  if (signal?.aborted) return outcomeRefusal("cancelled", settledCleanup("not-acquired"));
  if (!Number.isFinite(initialTime)) return outcomeRefusal("unsupported", settledCleanup("not-acquired"));
  const budget = createBoundActionBudget(deadlineMs, signal, now);
  const initialStop = budget.check();
  if (initialStop) {
    budget.dispose();
    return outcomeRefusal(initialStop === "stale" ? "unavailable" : initialStop, settledCleanup("not-acquired"));
  }

  const cleanup = makeCleanup();
  const { waited, stop } = await waitForLease(route, { deadlineMs, acquire }, cleanup, budget);
  if (!waited.lease) {
    const finalStop = stopReason(budget) ?? stop;
    budget.dispose();
    return outcomeRefusal(finalStop ?? "unavailable", cleanup.promise);
  }

  const lease = waited.lease;
  const occupancy: Occupancy = { pending: null, settled: true };
  let work: Awaited<ReturnType<typeof produce>>;
  try {
    work = await produce({
      request: captured, route, lease, budget, stop, occupancy,
      deps: { deadlineMs, now, ...(signal ? { signal } : {}), ...(dependencies.stage ? { stage: dependencies.stage } : {}) },
    });
  } catch { work = { produced: { kind: "refusal", status: "unavailable" } }; }

  let releaseState: CleanupState | null = null;
  if (occupancy.pending && !occupancy.settled) {
    void occupancy.pending.then(() => { releaseOnce(lease, cleanup); });
  } else {
    releaseState = releaseOnce(lease, cleanup);
  }
  const { server, produced } = work;
  const outerStop = stopReason(budget) ?? stop;
  const producedStop = produced.kind === "refusal" ? produced.status : null;
  const finalStop = publicationStop(signal, outerStop, producedStop);
  budget.dispose();
  if (finalStop) return outcomeRefusal(finalStop, cleanup.promise, server);
  if (releaseState === "failed") return outcomeRefusal("unavailable", cleanup.promise, server);
  if (produced.kind === "refusal") return outcomeRefusal(produced.status, cleanup.promise, server);
  return { kind: "result", envelope: produced.envelope, ...(produced.proposal ? { proposal: produced.proposal } : {}), cleanup: cleanup.promise };
}
