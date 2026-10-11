import { actionJsonRefusal, snapshotActionJson, type ActionJson } from "./lsp-action-json.js";
import { normalizeCodeActionEntry, type NormalizedCodeAction } from "./lsp-response-normalizer.js";

export type CodeActionPayloadResult =
  | { ok: true; projection: NormalizedCodeAction; payload: ActionJson; selectable: boolean }
  | { ok: false; reason: "invalid-json" | "size-limit" | "malformed-action" };

/** Captures one raw slot before using the normalizer's existing display projection. */
export function captureCodeActionPayload(raw: unknown): CodeActionPayloadResult {
  let payload: ActionJson;
  try {
    payload = snapshotActionJson(raw);
  } catch (error) {
    return { ok: false, reason: actionJsonRefusal(error) };
  }
  const projection = normalizeCodeActionEntry(payload);
  if (!projection) return { ok: false, reason: "malformed-action" };
  return {
    ok: true,
    projection,
    payload,
    selectable: projection.command === undefined && projection.disabled === undefined,
  };
}
