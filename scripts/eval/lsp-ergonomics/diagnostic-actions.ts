import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { AFFORDANCE_BOUNDS } from "../../../src/lsp/affordance-contract.js";
import { convertOffset, type PositionEncoding } from "../../../src/lsp/lsp-position-codec.js";
import type { ExecutorDeps } from "../../../src/lsp/lsp-executor.js";
import type { StrictEnvelope, StrictRange, StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";
import { readSource } from "./source-locator.js";

export type DiagnosticActionKind = "quickfix" | "source.fixAll" | "source.organizeImports";
export interface DiagnosticActionInput {
  path: string;
  range?: StrictRange;
  kind?: DiagnosticActionKind;
  workspace?: string;
  server?: string;
  timeoutMs?: number;
  limit?: number;
}
export interface DiagnosticActionContext {
  cwd: string;
  signal?: AbortSignal;
  now?: () => number;
  execute: (request: StrictRequest, deps?: ExecutorDeps) => Promise<StrictEnvelope>;
}
export type ComponentStatus = "confirmed" | "confirmed-empty" | "coverage-unconfirmed" | "cancelled" | "timeout" | "stale" | "error";
export interface DiagnosticActionOption {
  title: string;
  actionId: string;
  kind: DiagnosticActionKind;
  requiresResolution: boolean;
  provenance: { descriptorId: string; positionEncoding: PositionEncoding; range: StrictRange };
}
export interface DiagnosticActionDiscovery {
  diagnostics: { status: ComponentStatus; coverage: "complete" | "incomplete"; count: number | null };
  actions: { status: ComponentStatus; coverage: "complete" | "incomplete"; count: number | null; omitted: Record<string, number>; error?: { code: string } }
  fingerprint: { canonicalPath: string; sourceSha256: string } | null;
  range: StrictRange | null;
  server: { descriptorId: string; positionEncoding: PositionEncoding } | null;
  options: DiagnosticActionOption[];
  steps: Array<{ id: "diagnostics" | "codeActions"; request: StrictRequest; envelope: StrictEnvelope }>;
  details: { envelopes: StrictEnvelope[]; candidates: unknown[] };
  truncated: boolean;
}
const kinds = new Set<DiagnosticActionKind>(["quickfix", "source.fixAll", "source.organizeImports"]);
const fields = new Set(["path", "range", "kind", "workspace", "server", "timeoutMs", "limit"]);
const encodings = new Set<PositionEncoding>(["utf-8", "utf-16", "utf-32"]);
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function validateDiagnosticActionInput(value: unknown): DiagnosticActionInput {
  if (!record(value) || Object.keys(value).some((key) => !fields.has(key)) || typeof value.path !== "string" || !value.path.trim()) throw new Error("diagnosticActions: invalid input");
  if (value.kind !== undefined && !kinds.has(value.kind as DiagnosticActionKind)) throw new Error("diagnosticActions: invalid kind");
  for (const key of ["workspace", "server"] as const) if (value[key] !== undefined && (typeof value[key] !== "string" || !value[key])) throw new Error(`diagnosticActions: invalid ${key}`);
  for (const key of ["timeoutMs", "limit"] as const) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1)) throw new Error(`diagnosticActions: invalid ${key}`);
  if (value.range !== undefined && !validRange(value.range)) throw new Error("diagnosticActions: invalid range");
  return value as unknown as DiagnosticActionInput;
}
function position(v: unknown): v is { line: number; character: number } { return record(v) && Number.isSafeInteger(v.line) && (v.line as number) >= 0 && Number.isSafeInteger(v.character) && (v.character as number) >= 0 && Object.keys(v).every((k) => k === "line" || k === "character") && Object.keys(v).length === 2; }
function validRange(v: unknown): v is StrictRange { return record(v) && Object.keys(v).length === 2 && position(v.start) && position(v.end) && (v.end.line! > v.start.line! || (v.end.line === v.start.line && v.end.character! >= v.start.character!)); }
function fullRange(source: string, encoding: PositionEncoding): StrictRange {
  const lines = source.split(/\r\n|\n|\r/);
  const last = lines.length - 1;
  return { start: { line: 0, character: 0 }, end: { line: last, character: convertOffset(lines[last]!, lines[last]!.length, "utf-16", encoding) } };
}
function hasFresh(envelope: StrictEnvelope): boolean { return envelope.meta?.freshness?.state === "fresh"; }
function actionFreshnessAccepted(envelope: StrictEnvelope): boolean { return envelope.meta?.freshness === undefined || hasFresh(envelope); }
type AcceptedServer = NonNullable<StrictEnvelope["server"]> & { descriptorId: string; positionEncoding: PositionEncoding };
function metadata(envelope: StrictEnvelope): envelope is StrictEnvelope & { server: AcceptedServer } {
  return record(envelope.server) && typeof envelope.server.descriptorId === "string" && envelope.server.descriptorId.length > 0 && envelope.server.descriptorId !== "unknown" && encodings.has(envelope.server.positionEncoding);
}
function overlap(a: StrictRange, b: StrictRange): boolean {
  const cmp = (x: StrictRange["start"], y: StrictRange["start"]) => x.line - y.line || x.character - y.character;
  return cmp(a.start, b.end) <= 0 && cmp(b.start, a.end) <= 0;
}
function outcome(): DiagnosticActionDiscovery { return { diagnostics: { status: "coverage-unconfirmed", coverage: "incomplete", count: null }, actions: { status: "coverage-unconfirmed", coverage: "incomplete", count: null, omitted: {} }, fingerprint: null, range: null, server: null, options: [], steps: [], details: { envelopes: [], candidates: [] }, truncated: false }; }

interface Runtime {
  now: () => number;
  deadline: number;
  statusCheck: () => ComponentStatus | undefined;
  readDeadline: () => number;
}
export function validateDiagnosticActionContext(context: DiagnosticActionContext): void {
  if (!record(context) || typeof context.cwd !== "string" || !context.cwd || typeof context.execute !== "function" || Object.keys(context).some((key) => !["cwd", "signal", "now", "execute"].includes(key))) throw new Error("diagnosticActions: invalid invocation context");
  if (context.signal !== undefined && !(context.signal instanceof AbortSignal)) throw new Error("diagnosticActions: invalid signal");
  if (context.now !== undefined && typeof context.now !== "function") throw new Error("diagnosticActions: invalid clock");
}
function createRuntime(input: DiagnosticActionInput, context: DiagnosticActionContext, guards: DiagnosticActionGuards): Runtime {
  const now = context.now ?? Date.now;
  const relativeDeadline = now() + Math.min(AFFORDANCE_BOUNDS.aggregateDeadlineMs, input.timeoutMs ?? AFFORDANCE_BOUNDS.aggregateDeadlineMs);
  const deadline = Math.min(relativeDeadline, guards.deadlineMs ?? relativeDeadline);
  return {
    now, deadline,
    statusCheck: () => context.signal?.aborted ? "cancelled" : now() >= deadline ? "timeout" : undefined,
    readDeadline: () => Date.now() + Math.max(0, deadline - now()),
  };
}
function stopActions(result: DiagnosticActionDiscovery, status: ComponentStatus): void {
  result.actions = { ...result.actions, status, coverage: "incomplete" };
  result.options = [];
}
function digestBytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function diagnosticsEnvelopeAccepted(envelope: StrictEnvelope, input: DiagnosticActionInput): envelope is StrictEnvelope & { server: AcceptedServer } {
  return (envelope.status === "ok" || envelope.status === "empty") && envelope.operation === "diagnostics" && envelope.method === "textDocument/diagnostic" && metadata(envelope) && hasFresh(envelope) && (!input.server || input.server === envelope.server.descriptorId);
}
function validDiagnosticList(values: unknown[] | null): values is Record<string, unknown>[] {
  return values !== null && values.every((value) => record(value) && validRange(value.range) && typeof value.message === "string");
}
function confirmDiagnostics(envelope: StrictEnvelope | undefined, input: DiagnosticActionInput, source: string, result: DiagnosticActionDiscovery) {
  if (envelope?.status === "timeout" || envelope?.status === "cancelled") result.diagnostics.status = envelope.status;
  if (!envelope || !diagnosticsEnvelopeAccepted(envelope, input)) return { descriptor: undefined, encoding: undefined, confirmed: false, overlapping: [] as Record<string, unknown>[] };
  const all = Array.isArray(envelope.result) ? envelope.result : null;
  const truncated = envelope.meta.truncated || !!envelope.meta.nextCursor || (all !== null && all.length > 100);
  result.truncated ||= Boolean(truncated);
  const values = all?.slice(0, 100) ?? [];
  if (!validDiagnosticList(all)) return { descriptor: undefined, encoding: undefined, confirmed: false, overlapping: [] as Record<string, unknown>[] };
  const descriptor = envelope.server.descriptorId;
  const encoding = envelope.server.positionEncoding;
  const range = input.range ?? fullRange(source, encoding);
  const overlapping = values.filter((value) => overlap(value.range as StrictRange, range));
  result.diagnostics = { status: values.length ? "confirmed" : "confirmed-empty", coverage: truncated ? "incomplete" : "complete", count: values.length };
  return { descriptor, encoding, confirmed: true, overlapping };
}
function actionEnvelopeIsTrusted(envelope: StrictEnvelope, input: DiagnosticActionInput, descriptor?: string, encoding?: PositionEncoding): envelope is StrictEnvelope & { server: AcceptedServer } {
  return (envelope.status === "ok" || envelope.status === "empty") && metadata(envelope) && envelope.operation === "codeActions" && envelope.method === "textDocument/codeAction" && actionFreshnessAccepted(envelope) && !(descriptor !== undefined && (envelope.server.descriptorId !== descriptor || (encoding !== undefined && envelope.server.positionEncoding !== encoding))) && !(input.server !== undefined && envelope.server.descriptorId !== input.server);
}
function collectOptions(envelope: StrictEnvelope & { server: AcceptedServer }, input: DiagnosticActionInput, _path: string, digest: string, range: StrictRange, result: DiagnosticActionDiscovery): { omitted: Record<string, number>; identityInvalid: boolean } {
  const raw = Array.isArray(envelope.result) ? envelope.result.slice(0, 100) : [];
  const omitted: Record<string, number> = {};
  const omit = (reason: string) => { omitted[reason] = (omitted[reason] ?? 0) + 1; };
  result.details.candidates.push(...raw);
  const groups = new Map<string, Record<string, unknown>[]>();
  let invalidIdentities = 0;
  for (const value of raw) {
    if (!record(value)) { invalidIdentities++; continue; }
    const id = value.actionId;
    const sourceSha256 = value.sourceSha256;
    if (typeof id !== "string" || id.length === 0 || typeof sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceSha256) || sourceSha256 !== digest) {
      invalidIdentities++;
      continue;
    }
    groups.set(id, [...(groups.get(id) ?? []), value]);
  }
  if (invalidIdentities) {
    omitted["malformed-identity"] = invalidIdentities;
    return { omitted, identityInvalid: true };
  }
  const requestedKind = input.kind ?? "quickfix";
  for (const [id, group] of groups) {
    if (group.length > 1) {
      omitted["duplicate-identity"] = (omitted["duplicate-identity"] ?? 0) + group.length;
      continue;
    }
    const value = group[0]!;
    if (typeof value.title !== "string" || !value.title.trim()) { omit("malformed-title"); continue; }
    if (value.disabled !== undefined) { omit("disabled"); continue; }
    if (value.command !== undefined) { omit("command"); continue; }
    const matches = value.kind === undefined || (typeof value.kind === "string" && (value.kind === requestedKind || value.kind.startsWith(`${requestedKind}.`)));
    if (!matches) { omit("wrong-kind"); continue; }
    result.options.push({ title: value.title, actionId: id, kind: requestedKind, requiresResolution: !record(value.edit), provenance: { descriptorId: envelope.server.descriptorId, positionEncoding: envelope.server.positionEncoding, range } });
  }
  return { omitted, identityInvalid: false };
}
function finalizeActions(envelope: StrictEnvelope, omitted: Record<string, number>, result: DiagnosticActionDiscovery): void {
  const raw = Array.isArray(envelope.result) ? envelope.result.slice(0, 100) : [];
  const truncated = envelope.meta.truncated || !!envelope.meta.nextCursor || (Array.isArray(envelope.result) && envelope.result.length > 100) || !Array.isArray(envelope.result);
  result.truncated ||= Boolean(truncated);
  result.actions = { status: raw.length === 0 && !truncated ? "confirmed-empty" : "confirmed", coverage: truncated ? "incomplete" : "complete", count: raw.length, omitted };
  if (Object.keys(omitted).length || result.truncated) result.actions.coverage = "incomplete";
}
function boundedOutput(result: DiagnosticActionDiscovery): boolean {
  const serialized = JSON.stringify({ diagnostics: result.diagnostics, actions: result.actions, fingerprint: result.fingerprint, range: result.range, server: result.server, options: result.options, truncated: result.truncated });
  if (Buffer.byteLength(serialized, "utf8") <= AFFORDANCE_BOUNDS.outputBytes) return true;
  result.actions = { ...result.actions, status: "error", coverage: "incomplete", error: { code: "output-limit" } };
  result.options = [];
  result.truncated = true;
  return false;
}

export interface DiagnosticActionGuards {
  expectedSourceSha256?: string;
  deadlineMs?: number;
}
function validateGuards(value: unknown): DiagnosticActionGuards {
  if (value === undefined) return {};
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.keys(value).some((key) => key !== "expectedSourceSha256" && key !== "deadlineMs")) throw new Error("diagnosticActions: invalid guards");
  if (value.expectedSourceSha256 !== undefined && (typeof value.expectedSourceSha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.expectedSourceSha256))) throw new Error("diagnosticActions: invalid expected source fingerprint");
  if (value.deadlineMs !== undefined && (typeof value.deadlineMs !== "number" || !Number.isFinite(value.deadlineMs))) throw new Error("diagnosticActions: invalid deadline");
  return value;
}

/** Discover bounded diagnostic/action choices. This offline library does not stage or apply edits. */
export async function discoverDiagnosticActions(inputValue: unknown, context: DiagnosticActionContext, guardsValue?: DiagnosticActionGuards): Promise<DiagnosticActionDiscovery> {
  const input = validateDiagnosticActionInput(inputValue);
  validateDiagnosticActionContext(context);
  const guards = validateGuards(guardsValue);
  const runtime = createRuntime(input, context, guards);
  const result = outcome();
  if (runtime.statusCheck()) { result.diagnostics.status = runtime.statusCheck()!; return result; }
  const absolute = resolve(context.cwd, input.path);
  const snapshot = await readSource(absolute, { signal: context.signal, maxFileBytes: 1024 * 1024 }, runtime.readDeadline());
  const afterSnapshot = runtime.statusCheck();
  if (afterSnapshot) { result.diagnostics.status = afterSnapshot; return result; }
  if (!snapshot.ok) { result.diagnostics.status = "error"; return result; }
  const digest = digestBytes(snapshot.bytes);
  result.fingerprint = { canonicalPath: snapshot.canonicalPath, sourceSha256: digest };
  if (guards.expectedSourceSha256 && guards.expectedSourceSha256.toLowerCase() !== digest) {
    result.diagnostics.status = "stale";
    return result;
  }
  const base = { path: snapshot.canonicalPath, ...(input.workspace ? { workspace: input.workspace } : {}), ...(input.server ? { server: input.server } : {}) };
  const freshSnapshot = async () => {
    if (runtime.statusCheck()) return false;
    const current = await readSource(absolute, { signal: context.signal, maxFileBytes: 1024 * 1024 }, runtime.readDeadline());
    if (runtime.statusCheck()) return false;
    return current.ok && current.canonicalPath === snapshot.canonicalPath && digestBytes(current.bytes) === digest;
  };
  const call = async (id: "diagnostics" | "codeActions", req: StrictRequest): Promise<StrictEnvelope | undefined> => {
    const target = result[id === "diagnostics" ? "diagnostics" : "actions"];
    const stopped = runtime.statusCheck();
    if (stopped) { target.status = stopped; return undefined; }
    if (result.steps.length >= AFFORDANCE_BOUNDS.underlyingRequests) { target.status = "coverage-unconfirmed"; return undefined; }
    const unchanged = await freshSnapshot();
    const readStop = runtime.statusCheck();
    if (readStop) { target.status = readStop; return undefined; }
    if (!unchanged) { target.status = "stale"; return undefined; }
    const dispatched = { ...req, timeoutMs: Math.max(1, Math.floor(runtime.deadline - runtime.now())) };
    const envelope = await context.execute(dispatched, { cwd: context.cwd, signal: context.signal });
    result.steps.push({ id, request: dispatched, envelope });
    result.details.envelopes.push(envelope);
    const afterWait = runtime.statusCheck();
    if (afterWait) { result[id === "diagnostics" ? "diagnostics" : "actions"].status = afterWait; return undefined; }
    const unchangedAfter = await freshSnapshot();
    const readStopAfter = runtime.statusCheck();
    if (readStopAfter) { target.status = readStopAfter; return undefined; }
    if (!unchangedAfter) { target.status = "stale"; return undefined; }
    return envelope;
  };
  const request: StrictRequest = { operation: "diagnostics", ...base, timeoutMs: Math.max(1, Math.floor(runtime.deadline - runtime.now())), limit: Math.min(input.limit ?? 100, 100) };
  const diagnosticEnvelope = await call("diagnostics", request);
  const diagnosticInfo = confirmDiagnostics(diagnosticEnvelope, input, snapshot.source, result);
  const chosenRange = input.range ?? (diagnosticInfo.confirmed && diagnosticInfo.descriptor && diagnosticInfo.encoding ? fullRange(snapshot.source, diagnosticInfo.encoding) : null);
  result.range = chosenRange;
  if (!chosenRange) { result.actions.status = "coverage-unconfirmed"; result.truncated ||= Boolean(diagnosticEnvelope?.meta.truncated || diagnosticEnvelope?.meta.nextCursor); return result; }
  const exactServer = diagnosticInfo.confirmed && diagnosticInfo.descriptor && diagnosticInfo.encoding;
  const actionRequest: StrictRequest = { operation: "codeActions", ...base, ...(exactServer ? { server: diagnosticInfo.descriptor } : {}), range: chosenRange, context: { diagnostics: diagnosticInfo.overlapping.slice(0, 100), only: [input.kind ?? "quickfix"] }, limit: Math.min(input.limit ?? 100, 100) };
  const actionEnvelope = await call("codeActions", actionRequest);
  if (!actionEnvelope) return result;
  if (!actionEnvelopeIsTrusted(actionEnvelope, input, diagnosticInfo.descriptor, diagnosticInfo.encoding)) {
    result.actions.status = actionEnvelope.status === "timeout" || actionEnvelope.status === "cancelled" ? actionEnvelope.status : "coverage-unconfirmed";
    return result;
  }
  result.server = { descriptorId: actionEnvelope.server.descriptorId, positionEncoding: actionEnvelope.server.positionEncoding };
  const collected = collectOptions(actionEnvelope, input, snapshot.canonicalPath, digest, chosenRange, result);
  finalizeActions(actionEnvelope, collected.omitted, result);
  if (collected.identityInvalid) stopActions(result, "coverage-unconfirmed");
  const unchanged = await freshSnapshot();
  const stopped = runtime.statusCheck();
  if (stopped) { stopActions(result, stopped); return result; }
  if (!unchanged) { stopActions(result, "stale"); return result; }
  if (!boundedOutput(result)) return result;
  const finalStop = runtime.statusCheck();
  if (finalStop) { stopActions(result, finalStop); return result; }
  const finalUnchanged = await freshSnapshot();
  const finalReadStop = runtime.statusCheck();
  if (finalReadStop) stopActions(result, finalReadStop);
  else if (!finalUnchanged) stopActions(result, "stale");
  return result;
}
