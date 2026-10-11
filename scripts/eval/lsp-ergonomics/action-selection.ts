import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { discoverDiagnosticActions, validateDiagnosticActionContext, validateDiagnosticActionInput, type DiagnosticActionContext, type DiagnosticActionDiscovery, type DiagnosticActionInput, type DiagnosticActionOption } from "./diagnostic-actions.js";
import { AFFORDANCE_BOUNDS } from "../../../src/lsp/affordance-contract.js";
import { readSource } from "./source-locator.js";
import type { StrictEnvelope } from "../../../src/lsp/lsp-strict-contract.js";

export interface DiagnosticActionSelectionInput extends DiagnosticActionInput {
  selection: { actionId: string; sourceSha256: string };
}
export type DiagnosticActionSelectionResult =
  | { status: "selected"; action: Record<string, unknown>; option: DiagnosticActionOption; envelope: StrictEnvelope; selection: { actionId: string; sourceSha256: string }; deadlineMs: number; details: DiagnosticActionDiscovery }
  | { status: "refused"; code: "invalid-input" | "cancelled" | "timeout" | "stale" | "no-match" | "ambiguous" | "coverage-unconfirmed" | "error"; details: DiagnosticActionDiscovery };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
type Selection = { actionId: string; sourceSha256: string };
type Stop = () => "cancelled" | "timeout" | undefined;
function refused(code: Extract<DiagnosticActionSelectionResult, { status: "refused" }>["code"], details: DiagnosticActionDiscovery): DiagnosticActionSelectionResult { return { status: "refused", code, details }; }
function parseInput(value: unknown, context: DiagnosticActionContext): { input: DiagnosticActionInput; selection: Selection } | undefined {
  try {
    validateDiagnosticActionContext(context);
    if (!isRecord(value) || !plain(value)) return undefined;
    const fields: Array<[string, unknown]> = [];
    let selector: unknown;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      if (key === "selection") selector = descriptor.value;
      else fields.push([key, descriptor.value]);
    }
    if (!isRecord(selector) || !plain(selector)) return undefined;
    const selectorKeys = Reflect.ownKeys(selector);
    if (selectorKeys.length !== 2 || !selectorKeys.every((key) => key === "actionId" || key === "sourceSha256")) return undefined;
    const actionIdDescriptor = Object.getOwnPropertyDescriptor(selector, "actionId");
    const sourceShaDescriptor = Object.getOwnPropertyDescriptor(selector, "sourceSha256");
    if (!actionIdDescriptor || !("value" in actionIdDescriptor) || !sourceShaDescriptor || !("value" in sourceShaDescriptor)) return undefined;
    const actionId = actionIdDescriptor.value;
    const sourceSha256 = sourceShaDescriptor.value;
    if (typeof actionId !== "string" || !actionId || typeof sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(sourceSha256)) return undefined;
    return { input: validateDiagnosticActionInput(Object.fromEntries(fields)), selection: { actionId, sourceSha256 } };
  } catch { return undefined; }
}
function plain(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function discoveryRefusal(discovery: DiagnosticActionDiscovery): "stale" | "cancelled" | "timeout" | undefined {
  const statuses = [discovery.diagnostics.status, discovery.actions.status];
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("cancelled")) return "cancelled";
  if (statuses.includes("timeout")) return "timeout";
  return undefined;
}
function completeDiscovery(discovery: DiagnosticActionDiscovery): { fingerprint: NonNullable<DiagnosticActionDiscovery["fingerprint"]>; range: NonNullable<DiagnosticActionDiscovery["range"]>; envelope: StrictEnvelope } | undefined {
  const fingerprint = discovery.fingerprint, range = discovery.range, envelope = discovery.details.envelopes.at(-1);
  const candidates = discovery.details.candidates;
  if (discovery.actions.coverage !== "complete" || discovery.diagnostics.coverage !== "complete" || discovery.truncated || (discovery.actions.status !== "confirmed" && discovery.actions.status !== "confirmed-empty") || !fingerprint || !range || !discovery.server || !envelope || candidates.length > 100 || !Array.isArray(envelope.result) || envelope.meta.truncated || envelope.meta.nextCursor || envelope.result.length !== candidates.length || envelope.result.length > 100) return undefined;
  return { fingerprint, range, envelope };
}
function matches(candidates: unknown[], binding: { path: string; sha: string; descriptor: string; encoding: NonNullable<StrictEnvelope["server"]>["positionEncoding"]; range: NonNullable<DiagnosticActionDiscovery["range"]>; kind: NonNullable<DiagnosticActionInput["kind"]> }, selection: Selection, stopped: Stop, discovery: DiagnosticActionDiscovery): Record<string, unknown>[] | DiagnosticActionSelectionResult {
  const found: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    const stop = stopped();
    if (stop) return refused(stop, discovery);
    if (!isRecord(candidate) || candidate.disabled !== undefined || candidate.command !== undefined || !kindMatches(candidate.kind, binding.kind)) continue;
    if (candidate.actionId === selection.actionId && candidate.sourceSha256 === binding.sha) found.push(candidate);
  }
  return found;
}
function kindMatches(value: unknown, kind: NonNullable<DiagnosticActionInput["kind"]>): boolean { return value === undefined || (typeof value === "string" && (value === kind || value.startsWith(`${kind}.`))); }
async function sourceStillCurrent(path: string, context: DiagnosticActionContext, deadlineMs: number, now: () => number, sha: string, canonicalPath: string): Promise<boolean> {
  const current = await readSource(resolve(context.cwd, path), { signal: context.signal, maxFileBytes: 1024 * 1024 }, Date.now() + Math.max(0, deadlineMs - now()));
  return current.ok && current.canonicalPath === canonicalPath && digest(current.bytes) === sha;
}

/** Conservatively re-discovers one explicit action choice. Selection is not preparation or authorization. */
export async function selectCurrentDiagnosticAction(inputValue: unknown, context: DiagnosticActionContext): Promise<DiagnosticActionSelectionResult> {
  const parsed = parseInput(inputValue, context);
  if (!parsed) return refused("invalid-input", emptyDetails());
  const { input, selection } = parsed;
  const now = context.now ?? Date.now;
  const deadlineMs = now() + Math.min(AFFORDANCE_BOUNDS.aggregateDeadlineMs, input.timeoutMs ?? AFFORDANCE_BOUNDS.aggregateDeadlineMs);
  const stopped: Stop = () => context.signal?.aborted ? "cancelled" : now() >= deadlineMs ? "timeout" : undefined;
  const before = stopped();
  if (before) return refused(before, emptyDetails());
  const discovery = await discoverDiagnosticActions(input, context, { expectedSourceSha256: selection.sourceSha256, deadlineMs });
  const terminal = stopped() ?? discoveryRefusal(discovery);
  if (terminal) return refused(terminal, discovery);
  const complete = completeDiscovery(discovery);
  if (!complete) return refused("coverage-unconfirmed", discovery);
  if (complete.fingerprint.sourceSha256 !== selection.sourceSha256) return refused("stale", discovery);
  return selectFromDiscovery(input, context, selection, deadlineMs, now, stopped, discovery, complete);
}
async function selectFromDiscovery(input: DiagnosticActionInput, context: DiagnosticActionContext, selection: Selection, deadlineMs: number, now: () => number, stopped: Stop, discovery: DiagnosticActionDiscovery, complete: NonNullable<ReturnType<typeof completeDiscovery>>): Promise<DiagnosticActionSelectionResult> {
  const kind = input.kind ?? "quickfix";
  const found = matches(discovery.details.candidates, { path: complete.fingerprint.canonicalPath, sha: complete.fingerprint.sourceSha256, descriptor: complete.envelope.server!.descriptorId, encoding: complete.envelope.server!.positionEncoding, range: complete.range, kind }, selection, stopped, discovery);
  if (!Array.isArray(found)) return found;
  const eligible = discovery.options.filter((option) => option.actionId === selection.actionId && option.kind === kind);
  if (found.length > 1 || eligible.length > 1) return refused("ambiguous", discovery);
  if (found.length !== 1 || eligible.length !== 1) return refused("no-match", discovery);
  const terminal = stopped();
  if (terminal) return refused(terminal, discovery);
  const current = await sourceStillCurrent(input.path, context, deadlineMs, now, selection.sourceSha256, complete.fingerprint.canonicalPath);
  const finalStop = stopped();
  if (finalStop) return refused(finalStop, discovery);
  if (!current) return refused("stale", discovery);
  const selectedAction = found[0]!;
  if (selectedAction.actionId !== selection.actionId || selectedAction.sourceSha256 !== selection.sourceSha256) return refused("no-match", discovery);
  return { status: "selected", action: selectedAction, option: eligible[0]!, envelope: complete.envelope, selection, deadlineMs, details: discovery };
}
function emptyDetails(): DiagnosticActionDiscovery {
  return { diagnostics: { status: "coverage-unconfirmed", coverage: "incomplete", count: null }, actions: { status: "coverage-unconfirmed", coverage: "incomplete", count: null, omitted: {} }, fingerprint: null, range: null, server: null, options: [], steps: [], details: { envelopes: [], candidates: [] }, truncated: false };
}
