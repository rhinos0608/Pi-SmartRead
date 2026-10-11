const MAX_ACTION_JSON_BYTES = 48 * 1024;
const MAX_ACTION_JSON_DEPTH = 64;

export type ActionJson = null | boolean | number | string | readonly ActionJson[] | { readonly [key: string]: ActionJson };

class InvalidActionJson extends Error {
  constructor(readonly reason: "invalid-json" | "size-limit") { super(reason); }
}

function invalid(): never { throw new InvalidActionJson("invalid-json"); }

type WalkResult = { canonical: string; snapshot: ActionJson };

/** Reads validated JSON descriptor values once for both hashing and snapshotting. */
function walkActionJson(value: unknown): WalkResult {
  const ancestors = new Set<object>();
  let bytes = 0;
  const bounded = (text: string): string => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_ACTION_JSON_BYTES) throw new InvalidActionJson("size-limit");
    return text;
  };
  const visit = (current: unknown, depth: number): WalkResult => {
    if (depth > MAX_ACTION_JSON_DEPTH) return invalid();
    if (current === null) return { canonical: bounded("null"), snapshot: null };
    if (typeof current === "string") return { canonical: bounded(JSON.stringify(current)), snapshot: current };
    if (typeof current === "boolean") return { canonical: bounded(current ? "true" : "false"), snapshot: current };
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return invalid();
      return { canonical: bounded(Object.is(current, -0) ? "0" : JSON.stringify(current)), snapshot: current };
    }
    if (typeof current !== "object" || ancestors.has(current)) return invalid();
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) return invalid();
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const keys = Reflect.ownKeys(descriptors);
        if (keys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)))) return invalid();
        const lengthDescriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(descriptors, "length")?.value;
        if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return invalid();
        const length = lengthDescriptor.value;
        if (keys.length !== length + 1) return invalid();
        const entries: WalkResult[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
          entries.push(visit(descriptor.value, depth + 1));
        }
        const canonical = bounded("[") + entries.map((entry, index) => (index ? bounded(",") : "") + entry.canonical).join("") + bounded("]");
        return { canonical, snapshot: Object.freeze(entries.map((entry) => entry.snapshot)) };
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return invalid();
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string" || !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) return invalid();
      const values = new Map<string, WalkResult>();
      const snapshot: { [key: string]: ActionJson } = Object.create(null) as { [key: string]: ActionJson };
      for (const key of keys as string[]) {
        const child = visit(descriptors[key]!.value, depth + 1);
        values.set(key, child);
        Object.defineProperty(snapshot, key, { value: child.snapshot, enumerable: true, writable: false, configurable: false });
      }
      const canonicalEntries = [...values.keys()].sort().map((key) => bounded(JSON.stringify(key)) + bounded(":") + values.get(key)!.canonical);
      const canonical = bounded("{") + canonicalEntries.map((entry, index) => (index ? bounded(",") : "") + entry).join("") + bounded("}");
      return { canonical, snapshot: Object.freeze(snapshot) };
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value, 0);
}

/** Validates JSON data and returns its canonical, key-sorted representation. */
export function canonicalActionJson(value: unknown): string {
  return walkActionJson(value).canonical;
}

/** Creates a detached immutable JSON snapshot without changing property order. */
export function snapshotActionJson(value: unknown): ActionJson {
  return walkActionJson(value).snapshot;
}

export function actionJsonRefusal(error: unknown): "size-limit" | "invalid-json" {
  return error instanceof InvalidActionJson ? error.reason : "invalid-json";
}
