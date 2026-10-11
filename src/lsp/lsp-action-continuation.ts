import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { prepareBoundActionEdit, type ActionEditRefusal } from "./lsp-action-edit-preparation.js";
import {
  awaitBoundAction,
  createBoundActionBudget,
  revalidateBoundActionOrigin,
  type BoundActionBudget,
  type BoundActionOriginHandoff,
  type BoundActionSession,
} from "./lsp-action-origin.js";
import type { StrictServerInfo } from "./lsp-strict-contract.js";

/** Closed set of semantic operations whose edits may be staged over the SmartEdit RPC. */
export const STAGEABLE_SEMANTIC_OPERATIONS = Object.freeze(["resolveCodeAction", "rename", "formatDocument", "formatRange", "formatOnType"] as const);
export type StageableSemanticOperation = (typeof STAGEABLE_SEMANTIC_OPERATIONS)[number];

export function isStageableSemanticOperation(value: unknown): value is StageableSemanticOperation {
  return typeof value === "string" && (STAGEABLE_SEMANTIC_OPERATIONS as readonly string[]).includes(value);
}

export interface BoundActionContinuationPacket {
  readonly prepared: LspWorkspaceEdit;
  readonly document: Readonly<{ canonicalPath: string; sha256: string }>;
  readonly serverDescriptor: StrictServerInfo;
  readonly operation: StageableSemanticOperation;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly originalSignal?: AbortSignal;
  readonly ownedSignal: AbortSignal;
}

export type BoundActionStageResult =
  | { readonly kind: "staged"; readonly proposal: { readonly proposalId: string; readonly files: readonly string[]; readonly diff: string } }
  | { readonly kind: "refused"; readonly reason: "unavailable" | "cancelled" | "timeout" | "not_ready" | "unsupported" };

export type BoundActionContinuationReason = ActionEditRefusal | "unavailable" | "not_ready" | "timeout" | "cancelled" | "unsupported";

export type BoundActionContinuationResult =
  | { readonly kind: "staged"; readonly proposal: { readonly proposalId: string; readonly files: readonly string[]; readonly diff: string } }
  | { readonly kind: "refused"; readonly reason: BoundActionContinuationReason };

export interface BoundActionContinuationHandle {
  readonly result: Promise<BoundActionContinuationResult>;
  readonly workSettled: Promise<void>;
  isSettled(): boolean;
}

const refusal = (reason: BoundActionContinuationReason): BoundActionContinuationResult => Object.freeze({ kind: "refused", reason });
const controlledReasons: readonly BoundActionContinuationReason[] = [
  "no-edit", "unsupported-encoding", "command-or-disabled", "malformed-edit", "unsupported-semantics",
  "unavailable", "not_ready", "timeout", "cancelled", "unsupported",
];
const asReason = (status: string): BoundActionContinuationReason => {
  const normalized = status === "stale" ? "not_ready" : status;
  return controlledReasons.find((reason) => reason === normalized) ?? "unavailable";
};

type DataField = { readonly present: true; readonly value: unknown } | { readonly present: false } | null;
function dataField(value: object, key: string, enumerable = true): DataField {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return { present: false };
  return "value" in descriptor && (!enumerable || descriptor.enumerable) ? { present: true, value: descriptor.value } : null;
}

function plainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyFiles(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = dataField(value, "length", false);
  if (!length?.present || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0) return null;
  const files: string[] = [];
  for (let index = 0; index < length.value; index++) {
    const item = dataField(value, String(index));
    if (!item?.present || typeof item.value !== "string") return null;
    files.push(item.value);
  }
  return Object.freeze(files);
}

function snapshotRefusal(value: object): BoundActionContinuationResult {
  const reason = dataField(value, "reason");
  return reason?.present && typeof reason.value === "string" ? refusal(asReason(reason.value)) : refusal("unavailable");
}

function snapshotProposal(value: object): BoundActionContinuationResult {
  const proposalField = dataField(value, "proposal");
  if (!proposalField?.present || !plainRecord(proposalField.value)) return refusal("unavailable");
  const proposalId = dataField(proposalField.value, "proposalId");
  const files = dataField(proposalField.value, "files");
  const diff = dataField(proposalField.value, "diff");
  if (!proposalId?.present || typeof proposalId.value !== "string" || proposalId.value.length === 0 ||
      !files?.present || !diff?.present || typeof diff.value !== "string") return refusal("unavailable");
  const copiedFiles = copyFiles(files.value);
  if (!copiedFiles) return refusal("unavailable");
  const proposal = Object.freeze({ proposalId: proposalId.value, files: copiedFiles, diff: diff.value });
  return Object.freeze({ kind: "staged", proposal });
}

function snapshotStageResult(value: unknown): BoundActionContinuationResult {
  if (!plainRecord(value)) return refusal("unavailable");
  const kind = dataField(value, "kind");
  if (!kind?.present || typeof kind.value !== "string") return refusal("unavailable");
  if (kind.value === "refused") return snapshotRefusal(value);
  return kind.value === "staged" ? snapshotProposal(value) : refusal("unavailable");
}

function preparePacket(
  origin: BoundActionOriginHandoff,
  originalSignal: AbortSignal | undefined,
  budget: BoundActionBudget,
  operation: StageableSemanticOperation,
): BoundActionContinuationPacket | BoundActionContinuationResult {
  const prepared = prepareBoundActionEdit(origin);
  if (prepared.kind === "refusal") return refusal(prepared.reason);
  const serverDescriptor = Object.freeze({ ...origin.server });
  return Object.freeze({
    prepared: prepared.workspaceEdit,
    document: prepared.document,
    serverDescriptor,
    operation,
    deadlineMs: budget.deadlineMs,
    now: budget.now,
    ...(originalSignal ? { originalSignal } : {}),
    ownedSignal: budget.signal,
  });
}

/** Starts a private continuation; the caller result may stop before the actual callback does. */
export function startBoundActionContinuation(
  origin: BoundActionOriginHandoff,
  session: BoundActionSession,
  stage: (packet: BoundActionContinuationPacket) => Promise<BoundActionStageResult>,
  operation: StageableSemanticOperation,
): BoundActionContinuationHandle {
  if (!isStageableSemanticOperation(operation)) return completed(refusal("unsupported"));
  const deadlineMs = session.deadlineMs;
  const originalSignal = session.signal;
  const now = session.now ?? Date.now;
  const capturedSession: BoundActionSession = {
    conn: session.conn,
    server: session.server,
    registered: session.registered,
    signal: originalSignal,
    deadlineMs,
    now,
  };
  if (!Number.isFinite(deadlineMs) || originalSignal?.aborted) {
    const reason = originalSignal?.aborted ? "cancelled" : "unavailable";
    return completed(refusal(reason));
  }
  const budget = createBoundActionBudget(deadlineMs, originalSignal, now);
  const initialStop = budget.check();
  if (initialStop) {
    budget.dispose();
    return completed(refusal(asReason(initialStop)));
  }
  let packet: BoundActionContinuationPacket | BoundActionContinuationResult;
  try { packet = preparePacket(origin, originalSignal, budget, operation); }
  catch {
    budget.dispose();
    return completed(refusal("unavailable"));
  }
  if ("kind" in packet) {
    budget.dispose();
    return completed(packet);
  }

  let isDone = false;
  const actualWork = (async (): Promise<BoundActionContinuationResult> => {
    try { return await continueAction(origin, capturedSession, packet, stage, budget); }
    catch { return refusal(asReason(budget.check() ?? "unavailable")); }
    finally {
      try { budget.dispose(); }
      finally { isDone = true; }
    }
  })();
  const workSettled = actualWork.then(() => undefined, () => undefined);
  const result = awaitBoundAction(actualWork, budget).then((bounded) => {
    const publicationStop = budget.check();
    if (publicationStop) return refusal(asReason(publicationStop));
    return "refusal" in bounded ? refusal(asReason(bounded.refusal)) : bounded.value;
  });
  return Object.freeze({ result, workSettled, isSettled: () => isDone });
}

async function continueAction(
  origin: BoundActionOriginHandoff,
  session: BoundActionSession,
  packet: BoundActionContinuationPacket,
  stage: (packet: BoundActionContinuationPacket) => Promise<BoundActionStageResult>,
  budget: BoundActionBudget,
): Promise<BoundActionContinuationResult> {
  const before = budget.check();
  if (before) return refusal(asReason(before));
  const current = await revalidateBoundActionOrigin(origin, session);
  const afterPrevalidation = budget.check();
  if (afterPrevalidation) return refusal(asReason(afterPrevalidation));
  if (current.kind !== "current") return refusal(asReason(current.status));
  const beforeStage = budget.check();
  if (beforeStage) return refusal(asReason(beforeStage));

  let callbackResult: unknown;
  try { callbackResult = await stage(packet); }
  catch { return refusal(asReason(budget.check() ?? "unavailable")); }
  const snapshot = snapshotStageResult(callbackResult);
  const afterProjection = budget.check();
  if (afterProjection) return refusal(asReason(afterProjection));
  if (snapshot.kind === "refused") return snapshot;

  const revalidated = await revalidateBoundActionOrigin(origin, session);
  const afterRevalidation = budget.check();
  if (afterRevalidation) return refusal(asReason(afterRevalidation));
  if (revalidated.kind !== "current") return refusal(asReason(revalidated.status));
  const publicationStop = budget.check();
  return publicationStop ? refusal(asReason(publicationStop)) : snapshot;
}

function completed(value: BoundActionContinuationResult): BoundActionContinuationHandle {
  const result = Promise.resolve(value);
  const workSettled = Promise.resolve();
  return Object.freeze({ result, workSettled, isSettled: () => true });
}
