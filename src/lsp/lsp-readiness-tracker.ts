/**
 * ReadinessTracker (Wave 3 lane).
 *
 * Tracks $/progress + work-done tokens. readiness() returns
 * { state: confirmed|settling|unknown, basis }. No universal workspaceReady
 * gate — readiness is per-token, never a global block.
 */

export type ReadinessState = "confirmed" | "settling" | "unknown";

/** Evidence basis vocabulary (plan §readiness): never free prose. */
export type ReadinessBasis =
  | "progress"
  | "diagnostic-receipt"
  | "request-completion"
  | "server-specific"
  | "none";

export interface Readiness {
  state: ReadinessState;
  basis: ReadinessBasis;
}

interface TokenState {
  kind: string | null;
  title: string | null;
  message: string | null;
  percentage: number | null;
  phase: "begin" | "report" | "end" | null;
  cancellable: boolean;
  /** Wall-clock ms when phase became "end" (null until terminal). Used for TTL expiry. */
  endedAt: number | null;
}

/** Bound on total tracked tokens (LRU, evict-oldest). Unphased/active entries evicted only by this bound, never by TTL. */
export const READINESS_TOKEN_LIMIT = 128;
/** TTL for terminal (end-phase) entries; active/unphased entries never expire by TTL. */
export const READINESS_TERMINAL_TTL_MS = 5 * 60 * 1000;

export class LspReadinessTracker {
  private tokens = new Map<string, TokenState>();
  private workDoneTokens = new Set<string>();
  private readonly now: () => number;
  private readonly maxTokens: number;
  private readonly terminalTtlMs: number;

  constructor(opts?: { now?: () => number; maxTokens?: number; terminalTtlMs?: number }) {
    this.now = opts?.now ?? Date.now;
    this.maxTokens = opts?.maxTokens ?? READINESS_TOKEN_LIMIT;
    this.terminalTtlMs = opts?.terminalTtlMs ?? READINESS_TERMINAL_TTL_MS;
  }

  private freshState(): TokenState {
    return { kind: null, title: null, message: null, percentage: null, phase: null, cancellable: false, endedAt: null };
  }

  /** Mark token most-recently-used (Map insertion-order LRU). */
  private touch(token: string): void {
    const cur = this.tokens.get(token);
    if (!cur) return;
    this.tokens.delete(token);
    this.tokens.set(token, cur);
  }

  /** Insert token, evicting oldest entries while over the bound. */
  private insert(token: string, state: TokenState): void {
    if (this.tokens.has(token)) this.tokens.delete(token);
    this.tokens.set(token, state);
    while (this.tokens.size > this.maxTokens) {
      const oldest = this.tokens.keys().next().value;
      if (oldest === undefined) break;
      this.tokens.delete(oldest);
      this.workDoneTokens.delete(oldest);
    }
  }

  /** Expire terminal (end-phase) entries older than TTL. Active/unphased entries never expire. */
  private pruneExpired(): void {
    if (this.tokens.size === 0) return;
    const now = this.now();
    for (const [tok, t] of [...this.tokens]) {
      if (t.phase !== "end") continue;
      const endedAt = t.endedAt ?? now;
      if (now - endedAt >= this.terminalTtlMs) {
        this.tokens.delete(tok);
        this.workDoneTokens.delete(tok);
      }
    }
  }

  /** Track a token created via WorkDoneProgressCreate ($/progress or create request). */
  trackWorkDoneToken(token: string): void {
    this.pruneExpired();
    this.workDoneTokens.add(token);
    if (!this.tokens.has(token)) {
      this.insert(token, this.freshState());
    } else {
      this.touch(token);
    }
  }

  untrackWorkDoneToken(token: string): void {
    this.workDoneTokens.delete(token);
  }

  isWorkDoneToken(token: string): boolean {
    return this.workDoneTokens.has(token);
  }

  /** Handle a $/progress notification { token, value: { kind: begin|report|end, ... } }. */
  onProgress(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const p = params as Record<string, unknown>;
    const tokenRaw = p.token;
    if (typeof tokenRaw !== "string" && typeof tokenRaw !== "number") return;
    const token = String(tokenRaw);
    const value = p.value as Record<string, unknown> | undefined;
    if (!value || typeof value !== "object" || typeof value.kind !== "string") return;
    const kind = value.kind;
    if (kind !== "begin" && kind !== "report" && kind !== "end") return;
    const cur = this.tokens.get(token) ?? this.freshState();
    cur.kind = kind;
    cur.phase = kind;
    if (typeof value.title === "string") cur.title = value.title;
    if (typeof value.message === "string") cur.message = value.message;
    if (typeof value.percentage === "number") cur.percentage = value.percentage;
    if (typeof value.cancellable === "boolean") cur.cancellable = value.cancellable;
    if (kind === "end") {
      // Keep terminal state for basis evidence; token stays queryable until TTL expiry.
      cur.endedAt = this.now();
    }
    this.pruneExpired();
    this.insert(token, cur);
  }

  /** Per-token readiness. No universal gate. */
  readiness(token?: string): Readiness {
    this.pruneExpired();
    if (token !== undefined) {
      const key = String(token);
      const t = this.tokens.get(key);
      if (!t || !t.phase) return { state: "unknown", basis: "none" };
      this.touch(key);
      if (t.phase === "end") return { state: "confirmed", basis: "progress" };
      return { state: "settling", basis: "progress" };
    }
    if (this.tokens.size === 0) return { state: "unknown", basis: "none" };
    for (const entry of this.tokens.values()) {
      if (entry.phase == null) return { state: "unknown", basis: "none" };
    }
    const actives: string[] = [];
    for (const [tok, t] of this.tokens) {
      if (t.phase === "begin" || t.phase === "report") actives.push(tok);
    }
    if (actives.length === 0) return { state: "confirmed", basis: "progress" };
    return { state: "settling", basis: "progress" };
  }

  snapshot(): Record<string, TokenState> {
    const out: Record<string, TokenState> = {};
    for (const [k, v] of this.tokens) out[k] = { ...v };
    return out;
  }

  clear(): void {
    this.tokens.clear();
    this.workDoneTokens.clear();
  }
}
