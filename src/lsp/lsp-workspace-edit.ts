/**
 * SmartEdit workspace-edit RPC bridge (Stage 4, option A).
 *
 * Staging/applied proposals live in SmartEdit behind event-bus RPC on
 * RPC_CHANNELS.workspaceEdit. This module converts strict-LSP envelopes into
 * the protocol LspWorkspaceEdit shape, stages them with a short timeout, and
 * applies staged proposals. Staging failures resolve to null — callers keep
 * today's read-only result. Apply distinguishes "nothing sent" (unavailable)
 * from "sent but unconfirmed" (unknown outcome).
 */
import { fileURLToPath } from "node:url";
import {
  RPC_CHANNELS,
  WORKSPACE_EDIT_RPC_METHODS,
  createRpcClient,
  type ApplyStagedEditResponse,
  type LspWorkspaceEdit,
  type StageWorkspaceEditResponse,
} from "@rhinos0608/pi-workspace-protocol";
import { invalidateFsScanCache } from "../workspace/fs-scan-cache.js";
import { getSemanticIndex } from "../indexing/semantic-index-registry.js";
import { getIncrementalIndex } from "../indexing/incremental-index.js";
import { invalidateSharedGraph } from "../graph/shared-context-graph.js";
import { invalidatePaths as invalidateFileReadSnapshots } from "../read/file-read-cache.js";

export interface BusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** Short RPC timeout: staging must never stall a read-only answer. */
export const WORKSPACE_EDIT_RPC_TIMEOUT_MS = 2000;

/**
 * Apply commits the write and then runs SmartEdit's post-edit lanes
 * (diagnostics, LSP waits), exactly like the edit tool, so it needs the
 * same patience rather than the staging timeout.
 */
export const WORKSPACE_EDIT_APPLY_TIMEOUT_MS = 120_000;

let sharedBus: BusLike | null = null;

/** Bound at extension activation from the live Pi event bus. */
export function setWorkspaceEditBus(bus: BusLike | null): void {
  sharedBus = bus;
}

export function getWorkspaceEditBus(): BusLike | null {
  return sharedBus;
}

/** Test-only reset. */
export function resetWorkspaceEditBus(): void {
  sharedBus = null;
}

interface ProtoEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

interface ProtoFileEdits {
  filePath: string;
  edits: ProtoEdit[];
}

function toWorkspaceEdit(fileEdits: ProtoFileEdits[]): LspWorkspaceEdit | null {
  if (fileEdits.length === 0) return null;
  return {
    positionEncoding: "utf-16",
    fileEdits: fileEdits.map((f) => ({
      filePath: f.filePath,
      edits: f.edits.map((e) => ({ filePath: f.filePath, range: e.range, newText: e.newText })),
    })),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function uriToPath(uri: string): string | null {
  try {
    if (uri.startsWith("file://")) return fileURLToPath(uri);
  } catch {
    return null;
  }
  // Bare absolute path (normalized executor shape always uses file:// URIs).
  return uri.startsWith("/") ? uri : null;
}

function toProtoEdits(rawEdits: unknown): ProtoEdit[] | null {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) return null;
  const out: ProtoEdit[] = [];
  for (const e of rawEdits) {
    if (!isRecord(e) || !isRecord(e.range) || !isRecord(e.range.start) || !isRecord(e.range.end)) return null;
    const sl = e.range.start.line;
    const sc = e.range.start.character;
    const el = e.range.end.line;
    const ec = e.range.end.character;
    if (![sl, sc, el, ec].every((n) => typeof n === "number" && Number.isInteger(n) && (n as number) >= 0)) return null;
    if (typeof e.newText !== "string") return null;
    out.push({
      range: {
        start: { line: sl as number, character: sc as number },
        end: { line: el as number, character: ec as number },
      },
      newText: e.newText,
    });
  }
  return out;
}

/**
 * Convert a strict-LSP envelope result into the protocol LspWorkspaceEdit
 * shape. Handles executor-normalized `{changes:[{uri,edits}]}` (rename),
 * `TextEdit[]` (formatting), resolved-action `{edit}` wrappers, and raw LSP
 * `{changes:{uri:edits}}` / `{documentChanges}` shapes. Returns null when
 * nothing actionable is present.
 */
export function envelopeResultToWorkspaceEdit(result: unknown, fallbackFilePath?: string): LspWorkspaceEdit | null {
  const raw = isRecord(result) && "edit" in result ? result.edit : result;
  if (Array.isArray(raw)) {
    // Formatting TextEdit[] — file comes from the request path.
    if (!fallbackFilePath) return null;
    const edits = toProtoEdits(raw);
    if (!edits) return null;
    return toWorkspaceEdit([{ filePath: fallbackFilePath, edits }]);
  }
  if (!isRecord(raw)) return null;
  // Normalized executor shape: {changes:[{uri,edits}]}.
  if (Array.isArray(raw.changes)) {
    const fileEdits: ProtoFileEdits[] = [];
    for (const c of raw.changes) {
      if (!isRecord(c) || typeof c.uri !== "string") return null;
      const filePath = uriToPath(c.uri);
      const edits = toProtoEdits(c.edits);
      if (!filePath || !edits) return null;
      fileEdits.push({ filePath, edits });
    }
    return toWorkspaceEdit(fileEdits);
  }
  // Raw LSP map shape: {changes:{uri:TextEdit[]}}.
  if (isRecord(raw.changes)) {
    const fileEdits: ProtoFileEdits[] = [];
    for (const [uri, editsRaw] of Object.entries(raw.changes)) {
      const filePath = uriToPath(uri);
      const edits = toProtoEdits(editsRaw);
      if (!filePath || !edits) return null;
      fileEdits.push({ filePath, edits });
    }
    return toWorkspaceEdit(fileEdits);
  }
  // Raw LSP documentChanges shape.
  if (Array.isArray(raw.documentChanges)) {
    const fileEdits: ProtoFileEdits[] = [];
    for (const dc of raw.documentChanges) {
      if (!isRecord(dc) || !isRecord(dc.textDocument) || typeof dc.textDocument.uri !== "string") return null;
      if (typeof dc.kind === "string") return null;
      const filePath = uriToPath(dc.textDocument.uri);
      const edits = toProtoEdits(dc.edits);
      if (!filePath || !edits) return null;
      fileEdits.push({ filePath, edits });
    }
    return toWorkspaceEdit(fileEdits);
  }
  return null;
}

function isStageOk(payload: unknown): payload is StageWorkspaceEditResponse & { ok: true } {
  return isRecord(payload) && payload.ok === true && typeof payload.proposalId === "string";
}

function isApplyPayload(payload: unknown): payload is ApplyStagedEditResponse {
  return (
    isRecord(payload) &&
    typeof payload.ok === "boolean" &&
    (payload.status === "applied" || payload.status === "rejected" || payload.status === "failed") &&
    typeof payload.text === "string" &&
    Array.isArray(payload.diagnostics) &&
    Array.isArray(payload.changedFiles)
  );
}

export interface StageInput {
  bus: BusLike | null;
  workspaceEdit: LspWorkspaceEdit;
  operation: string;
  serverDescriptorId?: string;
  sessionFilePath: string | null;
  cwd: string;
}

/** Stage a workspace edit with SmartEdit. Null on any failure — never throws. */
export async function stageWorkspaceEdit(input: StageInput): Promise<StageWorkspaceEditResponse | null> {
  if (!input.bus || !input.sessionFilePath) return null;
  const client = createRpcClient({ bus: input.bus, channel: RPC_CHANNELS.workspaceEdit, timeoutMs: WORKSPACE_EDIT_RPC_TIMEOUT_MS });
  try {
    const reply = await client.request(WORKSPACE_EDIT_RPC_METHODS.stage, {
      workspaceEdit: input.workspaceEdit,
      source: {
        operation: input.operation,
        ...(input.serverDescriptorId ? { serverDescriptorId: input.serverDescriptorId } : {}),
      },
      sessionFilePath: input.sessionFilePath,
      cwd: input.cwd,
    });
    if (!reply.ok) return null;
    const payload = reply.payload as StageWorkspaceEditResponse;
    if (isStageOk(payload)) return payload;
    return isRecord(payload) && payload.ok === false ? payload : null;
  } catch {
    return null;
  } finally {
    client.dispose();
  }
}

export interface ApplyInput {
  bus: BusLike | null;
  proposalId: string;
  toolCallId: string;
  sessionFilePath: string | null;
  cwd: string;
}

export type ApplyStagedProposalOutcome =
  /** Nothing was sent: no event bus or no session identity. */
  | { kind: "unavailable" }
  | { kind: "reply"; payload: ApplyStagedEditResponse }
  /** The request was sent but no valid reply arrived; the write may have committed. */
  | { kind: "unknown"; reason: string };

/** Apply a staged proposal through SmartEdit. Never throws. */
export async function applyStagedProposal(input: ApplyInput): Promise<ApplyStagedProposalOutcome> {
  if (!input.bus || !input.sessionFilePath) return { kind: "unavailable" };
  const client = createRpcClient({ bus: input.bus, channel: RPC_CHANNELS.workspaceEdit, timeoutMs: WORKSPACE_EDIT_APPLY_TIMEOUT_MS });
  try {
    const reply = await client.request(WORKSPACE_EDIT_RPC_METHODS.apply, {
      proposalId: input.proposalId,
      toolCallId: input.toolCallId,
      sessionFilePath: input.sessionFilePath,
      cwd: input.cwd,
    });
    if (!reply.ok) return { kind: "unknown", reason: `SmartEdit error: ${reply.error ?? "unspecified"}` };
    if (!isApplyPayload(reply.payload)) return { kind: "unknown", reason: "SmartEdit returned a malformed apply reply" };
    return { kind: "reply", payload: reply.payload };
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    client.dispose();
  }
}

/**
 * Invalidate SmartRead file-content caches for changed paths. Same
 * invalidation order as the file watcher and mutation pipeline: fs-scan →
 * semantic → incremental → graph, plus per-session read snapshots. Advisory:
 * never throws.
 */
export function invalidateCachesForPaths(paths: readonly string[]): void {
  for (const p of paths) {
    try {
      invalidateFsScanCache(p);
    } catch {
      /* advisory */
    }
    try {
      const semIdx = getSemanticIndex(process.cwd());
      if (semIdx && typeof semIdx.markFilesStale === "function") semIdx.markFilesStale([p]);
    } catch {
      /* advisory */
    }
  }
  try {
    getIncrementalIndex(process.cwd()).invalidate();
  } catch {
    /* advisory */
  }
  try {
    invalidateSharedGraph();
  } catch {
    /* advisory */
  }
  try {
    invalidateFileReadSnapshots(paths);
  } catch {
    /* advisory */
  }
}
