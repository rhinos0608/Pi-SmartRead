import { createBoundActionBudget, runBoundActionOperation, type BoundActionRequest, type BoundActionSession } from "./lsp-action-origin.js";
import { startBoundActionContinuation, type BoundActionContinuationHandle, type BoundActionContinuationPacket, type BoundActionContinuationReason, type BoundActionContinuationResult, type BoundActionStageResult } from "./lsp-action-continuation.js";
import { acquireBoundSession, type BoundSessionLease } from "./lsp-manager.js";
import type { StrictEnvelope, StrictServerInfo, StrictStatus } from "./lsp-strict-contract.js";

type RefusalStatus = Exclude<StrictStatus, "ok" | "empty" | "error" | "ambiguous">;
export type BoundActionCleanup = { readonly state: "not-acquired" | "released" | "failed" };
export type BoundActionProposal = { readonly proposalId: string; readonly files: readonly string[]; readonly diff: string };

export type BoundActionOutcome =
  | { readonly kind: "result"; readonly envelope: StrictEnvelope; readonly proposal?: BoundActionProposal; readonly cleanup: Promise<BoundActionCleanup> }
  | { readonly kind: "refusal"; readonly status: RefusalStatus; readonly server?: StrictServerInfo; readonly cleanup: Promise<BoundActionCleanup> };

export interface BoundActionRoute {
  readonly projectRoot: string;
  readonly languageId: string;
  readonly server?: string;
}

export interface BoundActionAdapterDependencies {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly acquire?: typeof acquireBoundSession;
  readonly stage?: (packet: BoundActionContinuationPacket) => Promise<BoundActionStageResult>;
}

type Stop = "cancelled" | "timeout" | "unavailable" | "not_ready" | null;
type AdapterBudget = ReturnType<typeof createBoundActionBudget>;
type CleanupState = BoundActionCleanup["state"];
type WaitOutcome = { readonly lease: BoundSessionLease | null; readonly stop: Stop };

function stopReason(budget: AdapterBudget): Stop {
  const status = budget.check();
  return status === "stale" || status === "unsupported" ? "unavailable" : status;
}

function publicationStop(signal: AbortSignal | undefined, outer: Stop, known: RefusalStatus | null): RefusalStatus | null {
  if (signal?.aborted || outer === "cancelled" || known === "cancelled") return "cancelled";
  if (outer === "timeout" || known === "timeout") return "timeout";
  return outer ?? known;
}

function outcomeRefusal(status: RefusalStatus, cleanup: Promise<BoundActionCleanup>, server?: StrictServerInfo): BoundActionOutcome {
  return server ? { kind: "refusal", status, server, cleanup } : { kind: "refusal", status, cleanup };
}

function continuationStatus(reason: BoundActionContinuationReason): RefusalStatus {
  switch (reason) {
    case "no-edit":
    case "unsupported-encoding":
    case "command-or-disabled":
    case "malformed-edit":
    case "unsupported-semantics":
      return "unsupported";
    case "unavailable":
    case "not_ready":
    case "timeout":
    case "cancelled":
    case "unsupported":
      return reason;
  }
}

function settledCleanup(state: CleanupState): Promise<BoundActionCleanup> {
  return Promise.resolve(Object.freeze({ state }));
}

function makeCleanup(): { promise: Promise<BoundActionCleanup>; complete(state: CleanupState): void } {
  let resolve!: (state: BoundActionCleanup) => void;
  const promise = new Promise<BoundActionCleanup>((done) => { resolve = done; });
  let completed = false;
  return {
    promise,
    complete: (state) => {
      if (completed) return;
      completed = true;
      resolve(Object.freeze({ state }));
    },
  };
}

function releaseOnce(lease: BoundSessionLease, cleanup: ReturnType<typeof makeCleanup>): CleanupState {
  try {
    lease.release();
    cleanup.complete("released");
    return "released";
  } catch {
    cleanup.complete("failed");
    return "failed";
  }
}

async function waitForLease(
  route: BoundActionRoute,
  dependencies: BoundActionAdapterDependencies,
  cleanup: ReturnType<typeof makeCleanup>,
  budget: AdapterBudget,
): Promise<{ readonly waited: WaitOutcome; readonly stop: Stop }> {
  const acquire = dependencies.acquire ?? acquireBoundSession;
  let waitDone = false;
  let waitStop: Stop = null;
  let resolveWait!: (value: WaitOutcome) => void;
  const wait = new Promise<WaitOutcome>((resolve) => { resolveWait = resolve; });
  const finishWait = (lease: BoundSessionLease | null, stop: Stop) => {
    if (waitDone) return;
    waitDone = true;
    waitStop = stop;
    resolveWait({ lease, stop });
  };
  const onAbort = () => finishWait(null, stopReason(budget));
  budget.signal.addEventListener("abort", onAbort, { once: true });

  const acquisition = Promise.resolve().then(() => {
    const beforeDispatch = stopReason(budget);
    if (beforeDispatch) {
      finishWait(null, beforeDispatch);
      cleanup.complete("not-acquired");
      return null;
    }
    return acquire(route.projectRoot, route.languageId, {
      ...(route.server === undefined ? {} : { descriptorId: route.server }), allowInstall: false, purpose: "request",
    });
  });
  const observer = acquisition.then((lease) => {
    if (!lease) {
      cleanup.complete("not-acquired");
      finishWait(null, null);
      return;
    }
    if (waitDone) {
      releaseOnce(lease, cleanup);
      return;
    }
    finishWait(lease, null);
  }, () => {
    cleanup.complete("not-acquired");
    finishWait(null, null);
  }).catch(() => {
    cleanup.complete("failed");
    finishWait(null, null);
  });
  void observer;

  if (budget.signal.aborted) finishWait(null, stopReason(budget));
  const waited = await wait;
  budget.signal.removeEventListener("abort", onAbort);
  const stop = stopReason(budget) ?? waited.stop ?? waitStop;
  return { waited, stop };
}

async function runLeaseAction(
  request: BoundActionRequest,
  route: BoundActionRoute,
  dependencies: BoundActionAdapterDependencies,
  now: () => number,
  lease: BoundSessionLease,
  stop: Stop,
  budget: AdapterBudget,
): Promise<{ readonly server?: StrictServerInfo; readonly continuation?: BoundActionContinuationHandle; readonly proposed: { kind: "result"; envelope: StrictEnvelope } | { kind: "refusal"; status: RefusalStatus } }> {
  const registration = lease.registration;
  let server: StrictServerInfo | undefined;
  try {
    if (stop) return { proposed: { kind: "refusal", status: stop } };
    if (registration.projectRoot !== route.projectRoot || (route.server !== undefined && registration.descriptorId !== route.server) ||
        !registration.languageIds.includes(route.languageId)) return { proposed: { kind: "refusal", status: "unavailable" } };
    server = Object.freeze({
      descriptorId: registration.descriptorId,
      name: registration.name,
      projectRoot: registration.projectRoot,
      languageId: route.languageId,
      positionEncoding: registration.positionEncoding,
    });
    const current = (): boolean => {
      try { return lease.registration === registration && lease.isCurrent(); }
      catch { return false; }
    };
    if (!current()) return { server, proposed: { kind: "refusal", status: "not_ready" } };
    const session: BoundActionSession = {
      conn: lease.conn,
      server,
      registered: (conn, captured) => conn === lease.conn && captured.descriptorId === registration.descriptorId &&
        captured.name === registration.name && captured.projectRoot === registration.projectRoot &&
        captured.languageId === route.languageId && captured.positionEncoding === registration.positionEncoding && current(),
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      deadlineMs: dependencies.deadlineMs,
      now,
    };
    const engineResult = await runBoundActionOperation(request, session);
    const engineStop = publicationStop(dependencies.signal, stopReason(budget), engineResult.envelope.status === "timeout" ? "timeout" : null);
    if (engineStop) return { server, proposed: { kind: "refusal", status: engineStop } };
    if (!current()) return { server, proposed: { kind: "refusal", status: "not_ready" } };
    if (request.operation === "resolveCodeAction" && engineResult.envelope.status === "ok" && dependencies.stage) {
      if (!engineResult.origin) return { server, proposed: { kind: "refusal", status: "unavailable" } };
      return { server, continuation: startBoundActionContinuation(engineResult.origin, session, dependencies.stage), proposed: { kind: "result", envelope: engineResult.envelope } };
    }
    return { server, proposed: { kind: "result", envelope: engineResult.envelope } };
  } catch {
    return { server, proposed: { kind: "refusal", status: "unavailable" } };
  }
}

export async function executeBoundAction(
  request: BoundActionRequest,
  route: BoundActionRoute,
  dependencies: BoundActionAdapterDependencies,
): Promise<BoundActionOutcome> {
  const deadlineMs = dependencies.deadlineMs;
  const signal = dependencies.signal;
  const now = dependencies.now ?? Date.now;
  const acquire = dependencies.acquire ?? acquireBoundSession;
  const stage = dependencies.stage;
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

  const capturedDependencies = Object.freeze({ deadlineMs, signal, now, acquire, ...(stage ? { stage } : {}) });
  const cleanup = makeCleanup();
  const { waited, stop } = await waitForLease(route, capturedDependencies, cleanup, budget);
  if (!waited.lease) {
    const finalStop = stopReason(budget) ?? stop;
    budget.dispose();
    return outcomeRefusal(finalStop ?? "unavailable", cleanup.promise);
  }

  const lease = waited.lease;
  let action: Awaited<ReturnType<typeof runLeaseAction>>;
  try { action = await runLeaseAction(request, route, capturedDependencies, now, lease, stop, budget); }
  catch { action = { proposed: { kind: "refusal", status: "unavailable" } }; }
  let continuation: BoundActionContinuationResult | undefined;
  const handle = action.continuation;
  if (handle) {
    try { continuation = await handle.result; }
    catch { continuation = { kind: "refused", reason: "unavailable" }; }
  }
  if (handle && !handle.isSettled()) {
    void handle.workSettled.then(() => { releaseOnce(lease, cleanup); }, () => { releaseOnce(lease, cleanup); });
    const outerStop = stopReason(budget) ?? stop;
    const continuationStop = continuation?.kind === "refused" ? continuationStatus(continuation.reason) : null;
    const finalStop = publicationStop(signal, outerStop, continuationStop);
    budget.dispose();
    return outcomeRefusal(finalStop ?? "unavailable", cleanup.promise, action.server);
  }
  const releaseState = releaseOnce(lease, cleanup);
  const { server, proposed } = action;
  const outerStop = stopReason(budget) ?? stop;
  const continuationStop = continuation?.kind === "refused" ? continuationStatus(continuation.reason) : null;
  const proposedStop = proposed.kind === "refusal" ? proposed.status : proposed.envelope.status === "timeout" ? "timeout" : null;
  const finalStop = publicationStop(signal, outerStop, continuationStop ?? proposedStop);
  budget.dispose();
  if (finalStop) return outcomeRefusal(finalStop, cleanup.promise, server);
  if (releaseState === "failed") return outcomeRefusal("unavailable", cleanup.promise, server);
  if (proposed.kind === "refusal") return outcomeRefusal(proposed.status, cleanup.promise, server);
  if (continuation?.kind === "refused") {
    return outcomeRefusal(continuationStatus(continuation.reason), cleanup.promise, server);
  }
  const proposal = continuation?.kind === "staged" ? continuation.proposal : undefined;
  return { kind: "result", envelope: proposed.envelope, ...(proposal ? { proposal } : {}), cleanup: cleanup.promise };
}
