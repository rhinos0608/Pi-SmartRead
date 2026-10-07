/** Shared SmartEdit/SmartRead post-mutation diagnostics ownership. */
const KEY = Symbol.for("pi-smart-edit.postMutationDiagnostics.owner.v1");
const TTL = 60_000;
function claims(): Map<string, number> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let value = g[KEY] as Map<string, number> | undefined;
  if (!value) { value = new Map(); Object.defineProperty(g, KEY, { value, enumerable: false }); }
  return value;
}
export function isDiagnosticsClaimed(id: string): boolean {
  const now = Date.now();
  const map = claims();
  for (const [key, at] of map) if (now - at > TTL) map.delete(key);
  const at = map.get(id);
  return at !== undefined && now - at <= TTL;
}
