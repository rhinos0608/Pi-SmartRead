/**
 * Versioned event-RPC resolver for workspace evidence envelopes.
 *
 * Architecture (per v1 contract):
 * - Tool result `details.workspaceEvidence` is the durable source of truth.
 * - This resolver rebuilds an in-memory index from those tool result details
 *   on session_start (and on every tool_result that contains inspect details).
 * - The in-memory map is a cache/index; never parsed from rendered text.
 * - Wrong session/workspace or duplicate inspectionId with conflicting
 *   envelope is rejected.
 */

import {
    PROTOCOL_SCHEMA_VERSION,
    validateInspectionEnvelope,
    hashSessionFilePath,
    type WorkspaceEvidenceEnvelope,
} from "@rhinos0608/pi-workspace-protocol";

export interface ResolverBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface CreateEvidenceResolverOptions {
    readonly bus: ResolverBus;
    readonly channel: string;
}

/**
 * Maximum number of envelopes kept in the in-memory cache. When a publish
 * would exceed this bound, the oldest-inserted entry (Map insertion order)
 * is evicted. Bounded LRU-by-recency: a successful {@link EvidenceResolver.getEnvelope}
 * hit promotes the entry to the most-recent position.
 *
 * 200 is far above any realistic tool-result stream in one session while
 * keeping the cache footprint trivially small. Tune if profile dictates.
 */
export const EVIDENCE_RESOLVER_MAX_CACHE_ENTRIES = 200;

interface ResolveRequestPayload {
    readonly inspectionId: string;
    readonly sessionFilePath: string;
    readonly workspaceRoot: string;
}

interface CacheEntry {
    readonly envelope: WorkspaceEvidenceEnvelope;
    readonly sessionFilePath: string;
    readonly canonicalWorkspaceRoot: string;
    /** Per-resource: the canonical path it attests to, for identity checks. */
    readonly resourcePaths: Map<string, string>;
}

export interface EvidenceResolver {
    /** Subscribe to RPC requests on the bus. Returns a dispose function. */
    install(): Promise<() => void>;
    /** Persist a new envelope from tool result details. Validates strictly. */
    publishInspection(envelope: WorkspaceEvidenceEnvelope, sessionFilePath: string, workspaceRoot: string): void;
    /** Look up cached envelope. Returns null on miss. */
    getEnvelope(inspectionId: string): WorkspaceEvidenceEnvelope | null;
    /** For tests. */
    size(): number;
    /** Dispose internal RPC server. */
    dispose(): void;
}

export function createEvidenceResolver(opts: CreateEvidenceResolverOptions): EvidenceResolver {
    const cache = new Map<string, CacheEntry>();

    function getEntry(inspectionId: string): CacheEntry | undefined {
        return cache.get(inspectionId);
    }

    function publishInspection(envelope: WorkspaceEvidenceEnvelope, sessionFilePath: string, workspaceRoot: string): void {
        if (typeof sessionFilePath !== "string" || sessionFilePath.length === 0) {
            throw new Error("publishInspection: sessionFilePath required (no ephemeral identity)");
        }
        const v = validateInspectionEnvelope(envelope);
        if (!v.ok) throw new Error(`publishInspection: invalid envelope: ${v.error}`);

        // sessionId must match a hash of the supplied session file path
        const expectedSessionId = hashSessionFilePath(sessionFilePath);
        if (envelope.sessionId !== expectedSessionId) {
            throw new Error(
                `publishInspection: sessionId mismatch (envelope=${envelope.sessionId} expected=${expectedSessionId})`,
            );
        }

        // workspaceRoot must match envelope canonicalWorkspaceRoot
        if (envelope.canonicalWorkspaceRoot !== workspaceRoot) {
            throw new Error(
                `publishInspection: workspaceRoot mismatch (envelope=${envelope.canonicalWorkspaceRoot} expected=${workspaceRoot})`,
            );
        }

        // Duplicate inspectionId re-published for the SAME session: this is
        // the normal re-inspect-after-change case (a resource's resourceId
        // and inspectionId are content-independent by design — freshness is
        // checked at patch-time via SHA-256 comparison, not via envelope
        // identity). Overwrite rather than reject. Only a genuine identity
        // conflict (different session claiming the same inspectionId) is an
        // error.
        const existing = cache.get(envelope.inspectionId);
        if (existing && existing.sessionFilePath !== sessionFilePath) {
            throw new Error(`publishInspection: inspectionId ${envelope.inspectionId} already bound to a different session`);
        }

        const resourcePaths = new Map<string, string>();
        for (const r of envelope.resources) {
            if (!r.canonicalPath) {
                throw new Error("publishInspection: resource missing canonicalPath");
            }
            resourcePaths.set(r.resourceId, r.canonicalPath);
        }

        cache.set(envelope.inspectionId, {
            envelope,
            sessionFilePath,
            canonicalWorkspaceRoot: workspaceRoot,
            resourcePaths,
        });
        // Bound cache growth: evict the oldest entries on overflow.
        evictOldestIfOverCap();
    }

    function getEnvelope(inspectionId: string): WorkspaceEvidenceEnvelope | null {
        const e = cache.get(inspectionId);
        if (!e) return null;
        // Refresh recency: move to the tail of the Map so this entry is
        // considered the most-recently-used. Only safe because Map preserves
        // insertion order and delete+set is O(1) for a small constant cap.
        cache.delete(inspectionId);
        cache.set(inspectionId, e);
        return e.envelope;
    }

    function evictOldestIfOverCap(): void {
        // Map iteration order = insertion order. The first key is the oldest.
        // Drain to (just under) the cap so a single publish that overshoots
        // the bound by more than one still leaves the cache at the bound.
        while (cache.size > EVIDENCE_RESOLVER_MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next();
            if (oldest.done) return;
            cache.delete(oldest.value);
        }
    }

    function size(): number {
        return cache.size;
    }

    function handleResolve(payload: unknown): WorkspaceEvidenceEnvelope | { error: string } {
        if (!payload || typeof payload !== "object") return { error: "invalid resolve payload" };
        const p = payload as Partial<ResolveRequestPayload>;
        if (typeof p.inspectionId !== "string" || typeof p.sessionFilePath !== "string" || typeof p.workspaceRoot !== "string") {
            return { error: "invalid resolve payload: missing fields" };
        }
        if (typeof p.sessionFilePath !== "string" || p.sessionFilePath.length === 0) {
            return { error: "rejected: ephemeral session identity" };
        }
        const entry = getEntry(p.inspectionId);
        if (!entry) return { error: "rejected: unknown inspectionId (not in tool result details index)" };
        // Match session and workspace
        if (entry.sessionFilePath !== p.sessionFilePath) {
            return { error: "rejected: session identity mismatch" };
        }
        if (entry.canonicalWorkspaceRoot !== p.workspaceRoot) {
            return { error: "rejected: workspace root mismatch" };
        }
        return entry.envelope;
    }

    let off: (() => void) | null = null;
    async function install(): Promise<() => void> {
        if (off) return off;
        off = opts.bus.on(opts.channel, (raw) => {
            // Validate message shape
            if (!raw || typeof raw !== "object") return;
            const m = raw as { kind?: unknown; schemaVersion?: unknown; requestId?: unknown; rpc?: unknown; payload?: unknown };
            if (m.schemaVersion !== PROTOCOL_SCHEMA_VERSION) return;
            if (m.kind !== "request") return;
            if (typeof m.requestId !== "string" || m.requestId.length === 0) return;
            if (m.rpc !== "resolve_evidence") return;

            Promise.resolve()
                .then(() => handleResolve(m.payload))
                .then((result) => {
                    if ("error" in result) {
                        opts.bus.emit(opts.channel, {
                            kind: "reply",
                            schemaVersion: PROTOCOL_SCHEMA_VERSION,
                            requestId: m.requestId,
                            ok: false,
                            error: result.error,
                        });
                    } else {
                        opts.bus.emit(opts.channel, {
                            kind: "reply",
                            schemaVersion: PROTOCOL_SCHEMA_VERSION,
                            requestId: m.requestId,
                            ok: true,
                            payload: result,
                        });
                    }
                })
                .catch((err: unknown) => {
                    opts.bus.emit(opts.channel, {
                        kind: "reply",
                        schemaVersion: PROTOCOL_SCHEMA_VERSION,
                        requestId: m.requestId,
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
        });
        return off;
    }

    function dispose(): void {
        if (off) {
            off();
            off = null;
        }
        cache.clear();
    }

    return { install, publishInspection, getEnvelope, size, dispose };
}
