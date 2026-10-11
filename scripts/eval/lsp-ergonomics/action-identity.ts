import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { PositionEncoding } from "../../../src/lsp/lsp-position-codec.js";
import { actionJsonRefusal, canonicalActionJson } from "../../../src/lsp/lsp-action-json.js";

export interface ActionIdentityBinding {
  canonicalPath: string;
  sourceSha256: string;
  descriptorId: string;
  positionEncoding: PositionEncoding;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  kind: "quickfix" | "source.fixAll" | "source.organizeImports";
  action: unknown;
}
export type ActionIdentityResult = { ok: true; actionId: string } | { ok: false; reason: string };

const bindingKeys = ["action", "canonicalPath", "descriptorId", "kind", "positionEncoding", "range", "sourceSha256"];
const encodings = new Set<PositionEncoding>(["utf-8", "utf-16", "utf-32"]);
const kinds = new Set(["quickfix", "source.fixAll", "source.organizeImports"]);

class InvalidInput extends Error {}
function reject(): never { throw new InvalidInput(); }
function dataRecord(value: unknown, allowedKeys?: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return reject();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return reject();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") return reject();
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable || (allowedKeys && !allowedKeys.includes(key))) return reject();
  }
  return value as Record<string, unknown>;
}
function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : reject();
}
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }



function validateBinding(input: unknown): ActionIdentityBinding {
  const record = dataRecord(input, bindingKeys);
  if (Object.keys(record).length !== bindingKeys.length) return reject();
  const canonicalPath = ownValue(record, "canonicalPath");
  const sourceSha256 = ownValue(record, "sourceSha256");
  const descriptorId = ownValue(record, "descriptorId");
  const positionEncoding = ownValue(record, "positionEncoding");
  const kind = ownValue(record, "kind");
  if (typeof canonicalPath !== "string" || !isAbsolute(canonicalPath)) return reject();
  if (typeof sourceSha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(sourceSha256)) return reject();
  if (typeof descriptorId !== "string" || descriptorId.length === 0 || descriptorId === "unknown") return reject();
  if (!encodings.has(positionEncoding as PositionEncoding) || !kinds.has(kind as string)) return reject();
  const range = dataRecord(ownValue(record, "range"), ["start", "end"]);
  if (Object.keys(range).length !== 2) return reject();
  const start = dataRecord(ownValue(range, "start"), ["line", "character"]);
  const end = dataRecord(ownValue(range, "end"), ["line", "character"]);
  if (Object.keys(start).length !== 2 || Object.keys(end).length !== 2) return reject();
  const startLine = ownValue(start, "line"), startCharacter = ownValue(start, "character");
  const endLine = ownValue(end, "line"), endCharacter = ownValue(end, "character");
  if (![startLine, startCharacter, endLine, endCharacter].every(integer)) return reject();
  if ((endLine as number) < (startLine as number) || (endLine === startLine && (endCharacter as number) < (startCharacter as number))) return reject();
  return { canonicalPath, sourceSha256: sourceSha256.toLowerCase(), descriptorId, positionEncoding: positionEncoding as PositionEncoding,
    range: { start: { line: startLine as number, character: startCharacter as number }, end: { line: endLine as number, character: endCharacter as number } },
    kind: kind as ActionIdentityBinding["kind"], action: ownValue(record, "action") };
}

/** Build a stable identity from caller-canonicalized source and action data. Canonical paths are asserted, not verified here. */
export function createActionIdentity(input: unknown): ActionIdentityResult {
  try {
    const binding = validateBinding(input);
    const canonical = canonicalActionJson(binding);
    const actionId = createHash("sha256").update(`pi-smartread:lsp-action-identity:v1\n${canonical}`, "utf8").digest("hex");
    return { ok: true, actionId };
  } catch (error) {
    return { ok: false, reason: error instanceof InvalidInput && error.message === "size-limit" || actionJsonRefusal(error) === "size-limit" ? "size-limit" : "invalid-binding" };
  }
}
