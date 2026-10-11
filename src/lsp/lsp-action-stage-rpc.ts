import {
  RPC_CHANNELS,
  WORKSPACE_EDIT_RPC_METHODS,
  createRpcClient,
} from "@rhinos0608/pi-workspace-protocol";
import type { BoundActionContinuationPacket, BoundActionStageResult } from "./lsp-action-continuation.js";
import type { BusLike } from "./lsp-workspace-edit.js";

const MAX_TIMER_DELAY = 2_147_483_647;
type Refusal = Extract<BoundActionStageResult, { kind: "refused" }>["reason"];
const refused = (reason: Refusal): BoundActionStageResult => Object.freeze({ kind: "refused", reason });
type Stop = "cancelled" | "timeout" | "unavailable";

function record(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined;
}

function projectReply(reply: unknown): BoundActionStageResult {
  try {
    if (!record(reply) || field(reply, "ok") !== true) return refused("unavailable");
    const payload = field(reply, "payload");
    if (!record(payload) || field(payload, "ok") !== true) return refused("unavailable");
    const proposalId = field(payload, "proposalId");
    const filesValue = field(payload, "files");
    const diff = field(payload, "diff");
    if (typeof proposalId !== "string" || proposalId.length === 0 || !Array.isArray(filesValue) || typeof diff !== "string") {
      return refused("unavailable");
    }
    const files: string[] = [];
    const length = Object.getOwnPropertyDescriptor(filesValue, "length")?.value;
    if (Object.getPrototypeOf(filesValue) !== Array.prototype || !Number.isSafeInteger(length)) return refused("unavailable");
    for (let index = 0; index < length; index++) {
      const item = Object.getOwnPropertyDescriptor(filesValue, String(index));
      if (!item || !("value" in item) || !item.enumerable || typeof item.value !== "string") return refused("unavailable");
      files.push(item.value);
    }
    return Object.freeze({ kind: "staged", proposal: Object.freeze({ proposalId, files: Object.freeze(files), diff }) });
  } catch {
    return refused("unavailable");
  }
}

export function createBoundActionStageRequester(context: {
  readonly bus: BusLike | null;
  readonly sessionFilePath: string | null;
  readonly cwd: string;
}): (packet: BoundActionContinuationPacket) => Promise<BoundActionStageResult> {
  const bus = context.bus;
  const sessionFilePath = context.sessionFilePath;
  const cwd = context.cwd;

  return async (packet) => {
    let deadlineMs: number;
    let now: () => number;
    let originalSignal: AbortSignal | undefined;
    let ownedSignal: AbortSignal;
    let prepared: BoundActionContinuationPacket["prepared"];
    let document: BoundActionContinuationPacket["document"];
    let serverDescriptorId: string;
    let operation: BoundActionContinuationPacket["operation"];
    try {
      deadlineMs = packet.deadlineMs;
      now = packet.now;
      originalSignal = packet.originalSignal;
      ownedSignal = packet.ownedSignal;
      prepared = packet.prepared;
      document = packet.document;
      serverDescriptorId = packet.serverDescriptor.descriptorId;
      operation = packet.operation;
    } catch { return refused("unavailable"); }
    if (operation !== "resolveCodeAction" || typeof now !== "function" || !Number.isFinite(deadlineMs) ||
        !ownedSignal || !document || typeof document.canonicalPath !== "string" || typeof document.sha256 !== "string" ||
        typeof serverDescriptorId !== "string" || !prepared) return refused("unavailable");

    let deadlineExpired = false;
    let clockUnavailable = false;
    const stop = (): Stop | null => {
      if (originalSignal?.aborted) return "cancelled";
      if (deadlineExpired) return "timeout";
      if (clockUnavailable) return "unavailable";
      try {
        const current = now();
        if (originalSignal?.aborted) return "cancelled";
        if (!Number.isFinite(current)) {
          clockUnavailable = true;
          return "unavailable";
        }
        if (current >= deadlineMs) {
          deadlineExpired = true;
          return "timeout";
        }
        return ownedSignal.aborted ? "unavailable" : null;
      } catch {
        if (originalSignal?.aborted) return "cancelled";
        clockUnavailable = true;
        return "unavailable";
      }
    };
    const before = stop();
    if (before) return refused(before);
    if (!bus || !sessionFilePath || typeof cwd !== "string") return refused("unavailable");
    let current: number;
    try { current = now(); } catch { clockUnavailable = true; return refused(originalSignal?.aborted ? "cancelled" : "unavailable"); }
    if (!Number.isFinite(current)) { clockUnavailable = true; return refused(originalSignal?.aborted ? "cancelled" : "unavailable"); }
    const remaining = deadlineMs - current;
    if (!Number.isFinite(remaining) || remaining <= 0) { deadlineExpired = remaining <= 0; return refused(originalSignal?.aborted ? "cancelled" : deadlineExpired ? "timeout" : "unavailable"); }
    const timeoutMs = Math.ceil(Math.min(remaining, MAX_TIMER_DELAY));
    const afterBudget = stop();
    if (afterBudget) return refused(afterBudget);

    let client: ReturnType<typeof createRpcClient> | undefined;
    let request: Promise<unknown> | undefined;
    let cleanupFailed = false;
    let outcome: BoundActionStageResult = refused("unavailable");
    try {
      client = createRpcClient({ bus, channel: RPC_CHANNELS.workspaceEdit, timeoutMs });
      const beforeSend = stop();
      if (beforeSend) outcome = refused(beforeSend);
      else {
        request = client.request(WORKSPACE_EDIT_RPC_METHODS.stage, {
          workspaceEdit: prepared,
          source: {
            operation,
            serverDescriptorId,
            document: { canonicalPath: document.canonicalPath, sha256: document.sha256 },
          },
          sessionFilePath,
          cwd,
        }, { signal: ownedSignal });
        try {
          const reply = await request;
          const afterReply = stop();
          outcome = afterReply ? refused(afterReply) : projectReply(reply);
        } catch { outcome = refused(stop() ?? "unavailable"); }
      }
    } catch { outcome = refused(stop() ?? "unavailable"); }
    finally {
      if (request) {
        try { await request.catch(() => undefined); } catch { cleanupFailed = true; }
      }
      try { client?.dispose(); } catch { cleanupFailed = true; }
    }
    const publicationStop = stop();
    return publicationStop ? refused(publicationStop) : cleanupFailed ? refused("unavailable") : outcome;
  };
}
