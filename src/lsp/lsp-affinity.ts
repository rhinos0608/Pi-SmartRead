/**
 * LspAffinity — sticky routing hint for LSP session selection.
 *
 * Follow-up operations prefer the last-successful session when several
 * candidates exist. Exact selection stays owned by the executor: affinity
 * never overrides explicit server selection or ambiguity reporting;
 * `preferred()` is advisory only (returns a hint or null).
 *
 * Dependency-free: operates on opaque string keys only. No timers, no I/O.
 * Bounded LRU: max 64 scopes, each max 8 remembered descriptors
 * (most-recent-first).
 */

export const LSP_AFFINITY_MAX_SCOPES = 64;
export const LSP_AFFINITY_MAX_DESCRIPTORS_PER_SCOPE = 8;

export class LspAffinity {
  private readonly scopes = new Map<string, string[]>();

  noteSuccess(scopeKey: string, descriptorId: string): void {
    if (!scopeKey || !descriptorId) return;
    const existing = this.scopes.get(scopeKey);
    if (existing !== undefined) {
      // Refresh scope recency.
      this.scopes.delete(scopeKey);
      const next = [descriptorId, ...existing.filter((d) => d !== descriptorId)];
      this.scopes.set(scopeKey, next.slice(0, LSP_AFFINITY_MAX_DESCRIPTORS_PER_SCOPE));
      return;
    }
    this.scopes.set(scopeKey, [descriptorId]);
    if (this.scopes.size > LSP_AFFINITY_MAX_SCOPES) {
      const oldest = this.scopes.keys().next();
      if (!oldest.done) this.scopes.delete(oldest.value);
    }
  }

  preferred(scopeKey: string, candidates: string[]): string | null {
    if (!scopeKey || candidates.length === 0) return null;
    const remembered = this.scopes.get(scopeKey);
    if (remembered === undefined) return null;
    for (const descriptorId of remembered) {
      if (candidates.includes(descriptorId)) return descriptorId;
    }
    return null;
  }

  clear(scopeKey?: string): void {
    if (scopeKey === undefined) {
      this.scopes.clear();
      return;
    }
    this.scopes.delete(scopeKey);
  }
}
