import { afterEach, describe, it, expect } from "vitest";
import {
    createEvidenceResolver,
    type ResolverBus,
} from "../../src/workspace-evidence-resolver.js";
import {
    getSharedEvidenceResolver,
    installInspectAndResolver,
    resetSharedEvidenceResolver,
} from "../../src/mcp-registry.js";
import {
    PROTOCOL_SCHEMA_VERSION,
    RPC_CHANNELS,
    validateInspectionEnvelope,
    validateEventMessage,
    hashSessionFilePath,
} from "@rhinos0608/pi-workspace-protocol";

function makeBus(): { bus: ResolverBus; emitted: Array<{ channel: string; data: unknown }>; onEmit: (cb: (channel: string, data: unknown) => void) => void } {
    const subs = new Map<string, Set<(d: unknown) => void>>();
    const emitted: Array<{ channel: string; data: unknown }> = [];
    const external: Array<(channel: string, data: unknown) => void> = [];
    const bus: ResolverBus = {
        emit(channel: string, data: unknown) {
            emitted.push({ channel, data });
            for (const h of [...(subs.get(channel) || [])]) h(data);
            for (const cb of external) cb(channel, data);
        },
        on(channel: string, handler: (data: unknown) => void) {
            if (!subs.has(channel)) subs.set(channel, new Set());
            subs.get(channel)!.add(handler);
            return () => subs.get(channel)!.delete(handler);
        },
    };
    return { bus, emitted, onEmit: (cb) => external.push(cb) };
}

describe("createEvidenceResolver", () => {
    const SESSION_FILE = "/sessions/x.jsonl";
    const SESSION_ID = hashSessionFilePath(SESSION_FILE);
    const CANONICAL_WS = "/ws";

    afterEach(() => resetSharedEvidenceResolver());

    function envelopeFor(inspectionId: string, resources: any[]): any {
        return {
            schemaVersion: PROTOCOL_SCHEMA_VERSION,
            inspectionId,
            sessionId: SESSION_ID,
            workspaceRoot: CANONICAL_WS,
            canonicalWorkspaceRoot: CANONICAL_WS,
            createdAt: "2026-07-12T00:00:00.000Z",
            resources,
        };
    }

    it("rebinds the shared resolver when Pi replaces the extension event bus", async () => {
        const firstBus = makeBus();
        await installInspectAndResolver(firstBus.bus);

        const secondBus = makeBus();
        await installInspectAndResolver(secondBus.bus);
        const resolver = getSharedEvidenceResolver();
        const inspectionId = "e".repeat(64);
        resolver.publishInspection(
            envelopeFor(inspectionId, [{
                resourceId: "f".repeat(64),
                canonicalPath: "/ws/reloaded.ts",
                kind: "full",
                coverage: "full-file",
                allowedRanges: [{ startLine: 1, endLine: 1 }],
                fullFileSha256: "1".repeat(64),
                fresh: true,
            }]),
            SESSION_FILE,
            CANONICAL_WS,
        );

        const replyPromise = new Promise<any>((resolve) => {
            secondBus.bus.on(RPC_CHANNELS.inspectPatch, (data) => {
                const message = validateEventMessage(data);
                if (message.ok && message.value.kind === "reply" && message.value.requestId === "after-reload") {
                    resolve(message.value);
                }
            });
        });
        secondBus.bus.emit(RPC_CHANNELS.inspectPatch, {
            kind: "request",
            schemaVersion: PROTOCOL_SCHEMA_VERSION,
            requestId: "after-reload",
            rpc: "resolve_evidence",
            payload: { inspectionId, sessionFilePath: SESSION_FILE, workspaceRoot: CANONICAL_WS },
        });

        await expect(replyPromise).resolves.toMatchObject({ ok: true });
    });

    it("rejects RPC requests on the wrong session", async () => {
        const { bus } = makeBus();
        const resolver = createEvidenceResolver({
            bus,
            channel: "test.rpc",
        });
        await resolver.install();
        resolver.publishInspection(
            envelopeFor("a".repeat(64), [
                {
                    resourceId: "b".repeat(64),
                    canonicalPath: "/ws/a.ts",
                    kind: "full",
                    coverage: "full-file",
                    allowedRanges: [{ startLine: 1, endLine: 5 }],
                    fullFileSha256: "c".repeat(64),
                    fresh: true,
                },
            ]),
            SESSION_FILE,
            CANONICAL_WS,
        );

        const request = {
            kind: "request" as const,
            schemaVersion: PROTOCOL_SCHEMA_VERSION,
            requestId: "r1",
            rpc: "resolve_evidence" as const,
            payload: { inspectionId: "a".repeat(64), sessionFilePath: "/different/session.jsonl", workspaceRoot: CANONICAL_WS },
        };
        const replyPromise = new Promise<any>((resolve) => {
            const off = bus.on("test.rpc", (data) => {
                const v = validateEventMessage(data);
                if (v.ok && v.value.kind === "reply" && v.value.requestId === "r1") {
                    off();
                    resolve(v.value);
                }
            });
        });
        bus.emit("test.rpc", request);
        const reply = await replyPromise;
        expect(reply.ok).toBe(false);
        expect(reply.error).toMatch(/session/i);
    });

    it("resolves published inspection on matching session and workspace", async () => {
        const { bus } = makeBus();
        const resolver = createEvidenceResolver({ bus, channel: "test.rpc" });
        await resolver.install();
        const inspectionId = "b".repeat(64);
        resolver.publishInspection(
            envelopeFor(inspectionId, [
                {
                    resourceId: "0".repeat(64),
                    canonicalPath: "/ws/a.ts",
                    kind: "full",
                    coverage: "full-file",
                    allowedRanges: [{ startLine: 1, endLine: 5 }],
                    fullFileSha256: "d".repeat(64),
                    fresh: true,
                },
            ]),
            SESSION_FILE,
            CANONICAL_WS,
        );

        const request = {
            kind: "request" as const,
            schemaVersion: PROTOCOL_SCHEMA_VERSION,
            requestId: "r2",
            rpc: "resolve_evidence" as const,
            payload: { inspectionId, sessionFilePath: SESSION_FILE, workspaceRoot: CANONICAL_WS },
        };
        const replyPromise = new Promise<any>((resolve) => {
            const off = bus.on("test.rpc", (data) => {
                const v = validateEventMessage(data);
                if (v.ok && v.value.kind === "reply" && v.value.requestId === "r2") {
                    off();
                    resolve(v.value);
                }
            });
        });
        bus.emit("test.rpc", request);
        const reply = await replyPromise;
        expect(reply.ok).toBe(true);
        const v = validateInspectionEnvelope(reply.payload);
        expect(v.ok).toBe(true);
    });

    it("overwrites (does not throw) when the same session re-publishes the same inspectionId with different content (re-inspect after change)", async () => {
        const { bus } = makeBus();
        const resolver = createEvidenceResolver({ bus, channel: "test.rpc" });
        await resolver.install();
        const inspectionId = "c".repeat(64);
        const base = envelopeFor(inspectionId, [
            {
                resourceId: "1".repeat(64),
                canonicalPath: "/ws/a.ts",
                kind: "full",
                coverage: "full-file",
                allowedRanges: [{ startLine: 1, endLine: 5 }],
                fullFileSha256: "2".repeat(64),
                fresh: true,
            },
        ]);
        resolver.publishInspection(base, SESSION_FILE, CANONICAL_WS);
        const updated = JSON.parse(JSON.stringify(base));
        updated.resources[0].fullFileSha256 = "9".repeat(64);
        expect(() => resolver.publishInspection(updated, SESSION_FILE, CANONICAL_WS)).not.toThrow();
        expect(resolver.getEnvelope(inspectionId)?.resources[0]?.fullFileSha256).toBe("9".repeat(64));
    });

    it("rejects the same inspectionId re-published from a different session (genuine identity conflict)", async () => {
        const { bus } = makeBus();
        const resolver = createEvidenceResolver({ bus, channel: "test.rpc" });
        await resolver.install();
        const inspectionId = "c".repeat(64);
        const base = envelopeFor(inspectionId, [
            {
                resourceId: "1".repeat(64),
                canonicalPath: "/ws/a.ts",
                kind: "full",
                coverage: "full-file",
                allowedRanges: [{ startLine: 1, endLine: 5 }],
                fullFileSha256: "2".repeat(64),
                fresh: true,
            },
        ]);
        resolver.publishInspection(base, SESSION_FILE, CANONICAL_WS);
        // Same inspectionId, but stamped with a different session's sessionId
        // (as if two independently-hashed sessions collided on inspectionId).
        const otherSession = "/sessions/other.jsonl";
        const otherEnvelope = { ...base, sessionId: hashSessionFilePath(otherSession) };
        expect(() => resolver.publishInspection(otherEnvelope, otherSession, CANONICAL_WS)).toThrow(
            /different session/i,
        );
    });

    it("rejects unknown inspectionId", async () => {
        const { bus } = makeBus();
        const resolver = createEvidenceResolver({ bus, channel: "test.rpc" });
        await resolver.install();
        const request = {
            kind: "request" as const,
            schemaVersion: PROTOCOL_SCHEMA_VERSION,
            requestId: "r4",
            rpc: "resolve_evidence" as const,
            payload: { inspectionId: "d".repeat(64), sessionFilePath: SESSION_FILE, workspaceRoot: CANONICAL_WS },
        };
        const replyPromise = new Promise<any>((resolve) => {
            const off = bus.on("test.rpc", (data) => {
                const v = validateEventMessage(data);
                if (v.ok && v.value.kind === "reply" && v.value.requestId === "r4") {
                    off();
                    resolve(v.value);
                }
            });
        });
        bus.emit("test.rpc", request);
        const reply = await replyPromise;
        expect(reply.ok).toBe(false);
        expect(reply.error).toMatch(/not found|unknown|missing/i);
    });

    it("rejects envelope that fails schema validation", () => {
        const { bus } = makeBus();
        const resolver = createEvidenceResolver({ bus, channel: "test.rpc" });
        expect(() => resolver.publishInspection({ schemaVersion: 99 } as any, SESSION_FILE, CANONICAL_WS)).toThrow();
    });

    it("evicts oldest entries when publish would exceed the cache cap", () => {
        const { bus } = makeBus();
        const resolver = createEvidenceResolver({ bus, channel: "test.rpc" });
        // Publish one more than the cap, oldest should be gone.
        const cap = 200;
        for (let i = 0; i < cap + 1; i++) {
            const inspectionId = i.toString(16).padStart(64, "0");
            const resourceId = (i + 0x1000).toString(16).padStart(64, "0");
            resolver.publishInspection(
                envelopeFor(inspectionId, [
                    {
                        resourceId,
                        canonicalPath: `/ws/file-${i}.ts`,
                        kind: "full",
                        coverage: "full-file",
                        allowedRanges: [{ startLine: 1, endLine: 1 }],
                        fullFileSha256: "f".repeat(64),
                        fresh: true,
                    },
                ]),
                SESSION_FILE,
                CANONICAL_WS,
            );
        }
        // Cap must be honored.
        expect(resolver.size()).toBe(cap);
        // Oldest (i=0) must be evicted; newest (i=200) must remain.
        const oldest = "0".repeat(64);
        const newest = (cap).toString(16).padStart(64, "0");
        expect(resolver.getEnvelope(oldest)).toBeNull();
        expect(resolver.getEnvelope(newest)).not.toBeNull();
    });

    it("promotes the entry on successful resolve (LRU-by-recency)", () => {
        const { bus } = makeBus();
        const resolver = createEvidenceResolver({ bus, channel: "test.rpc" });
        const cap = 200;
        // Fill the cache with cap entries.
        for (let i = 0; i < cap; i++) {
            const inspectionId = i.toString(16).padStart(64, "0");
            const resourceId = (i + 0x2000).toString(16).padStart(64, "0");
            resolver.publishInspection(
                envelopeFor(inspectionId, [
                    {
                        resourceId,
                        canonicalPath: `/ws/lru-${i}.ts`,
                        kind: "full",
                        coverage: "full-file",
                        allowedRanges: [{ startLine: 1, endLine: 1 }],
                        fullFileSha256: "9".repeat(64),
                        fresh: true,
                    },
                ]),
                SESSION_FILE,
                CANONICAL_WS,
            );
        }
        // Resolve the oldest entry directly. This must promote it to the
        // tail of the Map.
        const oldestId = "0".repeat(64);
        const promoted = resolver.getEnvelope(oldestId);
        expect(promoted).not.toBeNull();
        // After promoting, a single new publish must NOT evict the
        // just-resolved oldest — the just-published entry becomes the new
        // oldest instead.
        const newInspectionId = "f".repeat(64);
        const newResourceId = "e".repeat(64);
        resolver.publishInspection(
            envelopeFor(newInspectionId, [
                {
                    resourceId: newResourceId,
                    canonicalPath: "/ws/lru-new.ts",
                    kind: "full",
                    coverage: "full-file",
                    allowedRanges: [{ startLine: 1, endLine: 1 }],
                    fullFileSha256: "a".repeat(64),
                    fresh: true,
                },
            ]),
            SESSION_FILE,
            CANONICAL_WS,
        );
        expect(resolver.size()).toBe(cap);
        // The promoted entry is still there.
        expect(resolver.getEnvelope(oldestId)).not.toBeNull();
        // After promoting entry 0 to the tail, entry 1 became the head
        // (oldest). One publish above cap must evict entry 1, not the
        // promoted entry.
        const secondId = "1".padStart(64, "0");
        expect(resolver.getEnvelope(secondId)).toBeNull();
        // The previously-newest entry (i=199) is still there.
        const secondToLastId = (cap - 1).toString(16).padStart(64, "0");
        expect(resolver.getEnvelope(secondToLastId)).not.toBeNull();
    });
});
