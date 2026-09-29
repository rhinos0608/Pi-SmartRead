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
  return typeof v === "object" && v !== null;
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

function isNonNegativeInt(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 0;
}

interface ProtoRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

function toProtoRange(range: Record<string, unknown>): ProtoRange | null {
  if (!isRecord(range.start)) return null;
  if (!isRecord(range.end)) return null;
  const coords = [range.start.line, range.start.character, range.end.line, range.end.character];
  for (const n of coords) {
    if (!isNonNegativeInt(n)) return null;
  }
  const [sl, sc, el, ec] = coords as [number, number, number, number];
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

function toProtoEdit(e: unknown): ProtoEdit | null {
  if (!isRecord(e) || !isRecord(e.range)) return null;
  const range = toProtoRange(e.range);
  if (!range || typeof e.newText !== "string") return null;
  return { range, newText: e.newText };
}

function toProtoEdits(rawEdits: unknown): ProtoEdit[] | null {
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) return null;
  const out: ProtoEdit[] = [];
  for (const e of rawEdits) {
    const edit = toProtoEdit(e);
    if (!edit) return null;
    out.push(edit);
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
/** Single-document-change validation: only plain insert/delete edits stage. */
function asTextDocumentChange(dc: unknown): { uri: string; edits: unknown } | null {
	if (!isRecord(dc) || !isRecord(dc.textDocument)) return null;
	if (typeof dc.textDocument.uri !== "string") return null;
	if (typeof dc.kind === "string") return null;
	return { uri: dc.textDocument.uri, edits: dc.edits };
}

/** Convert one uri + raw edits pair into staged file edits. */
function toSingleFileEdits(uri: string, rawEdits: unknown): ProtoFileEdits | null {
	const edits = toProtoEdits(rawEdits);
	const filePath = uriToPath(uri);
	if (!filePath || !edits) return null;
	return { filePath, edits };
}

function editArrayToWorkspaceEdit(raw: unknown[], fallbackFilePath?: string): LspWorkspaceEdit | null {
  // Formatting TextEdit[] — file comes from the request path.
  if (!fallbackFilePath) return null;
  const edits = toProtoEdits(raw);
  if (!edits) return null;
  return toWorkspaceEdit([{ filePath: fallbackFilePath, edits }]);
}

function normalizedChangesToWorkspaceEdit(changes: unknown[]): LspWorkspaceEdit | null {
  // Normalized executor shape: {changes:[{uri,edits}]}.
  const fileEdits: ProtoFileEdits[] = [];
  for (const c of changes) {
    if (!isRecord(c) || typeof c.uri !== "string") return null;
    const single = toSingleFileEdits(c.uri, c.edits);
    if (!single) return null;
    fileEdits.push(single);
  }
  return toWorkspaceEdit(fileEdits);
}

function mapChangesToWorkspaceEdit(changes: Record<string, unknown>): LspWorkspaceEdit | null {
  // Raw LSP map shape: {changes:{uri:TextEdit[]}}.
  const fileEdits: ProtoFileEdits[] = [];
  for (const [uri, editsRaw] of Object.entries(changes)) {
    const single = toSingleFileEdits(uri, editsRaw);
    if (!single) return null;
    fileEdits.push(single);
  }
  return toWorkspaceEdit(fileEdits);
}

function documentChangesToWorkspaceEdit(docs: unknown[]): LspWorkspaceEdit | null {
  // Raw LSP documentChanges shape.
  const fileEdits: ProtoFileEdits[] = [];
  for (const dc of docs) {
    const change = asTextDocumentChange(dc);
    if (!change) return null;
    const single = toSingleFileEdits(change.uri, change.edits);
    if (!single) return null;
    fileEdits.push(single);
  }
  return toWorkspaceEdit(fileEdits);
}

export function envelopeResultToWorkspaceEdit(result: unknown, fallbackFilePath?: string): LspWorkspaceEdit | null {
  const raw = isRecord(result) && "edit" in result ? result.edit : result;
  if (Array.isArray(raw)) return editArrayToWorkspaceEdit(raw, fallbackFilePath);
  if (!isRecord(raw)) return null;
  if (Array.isArray(raw.changes)) return normalizedChangesToWorkspaceEdit(raw.changes);
  if (isRecord(raw.changes)) return mapChangesToWorkspaceEdit(raw.changes);
  if (Array.isArray(raw.documentChanges)) return documentChangesToWorkspaceEdit(raw.documentChanges);
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
