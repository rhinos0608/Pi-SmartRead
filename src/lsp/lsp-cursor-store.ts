/** Bounded opaque cursor store for truncated LSP list results. */

const MAX_ENTRIES = 256;
const TTL_MS = 10 * 60 * 1000;

interface CursorEntry {
  offset: number;
  createdAt: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 =
    typeof btoa === "function"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(token: string): Uint8Array | null {
  if (!/^[A-Za-z0-9\-_]+$/.test(token) || token.length === 0) return null;
  let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 1) return null;
  if (pad !== 0) b64 += "=".repeat(4 - pad);
  try {
    if (typeof atob === "function") {
      const binary = atob(b64);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return toBase64Url(bytes);
}

/** Opaque pagination cursors binding random id -> offset, server-side. */
export class LspCursorStore {
  private entries = new Map<string, CursorEntry>();

  create(offset: number, opts?: { now?: number }): string {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
    }
    const now = opts?.now ?? Date.now();
    const id = randomId();
    this.entries.set(id, { offset, createdAt: now });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return toBase64Url(new TextEncoder().encode(id));
  }

  resolve(cursor: string, opts?: { now?: number }): number | null {
    const now = opts?.now ?? Date.now();
    const raw = fromBase64Url(cursor);
    if (raw === null) return null;
    if (toBase64Url(raw) !== cursor) return null;
    let id: string;
    try {
      id = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return null;
    }
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (now - entry.createdAt > TTL_MS) {
      this.entries.delete(id);
      return null;
    }
    return entry.offset;
  }

  size(): number {
    return this.entries.size;
  }
}
