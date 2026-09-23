import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LspDiagnosticsBroker } from "../../../src/lsp/lsp-diagnostics-broker.js";
import { LspCapabilityRegistry } from "../../../src/lsp/lsp-capability-registry.js";

const file = (...segs: string[]) => resolve(join(...segs));

function brokerWith(opts?: {
  caps?: Record<string, unknown>;
  requestImpl?: (method: string, params: unknown) => Promise<unknown>;
  registry?: LspCapabilityRegistry | null;
}): LspDiagnosticsBroker {
  return new LspDiagnosticsBroker({
    request: opts?.requestImpl ?? (async () => null),
    getCapabilityRegistry: () => opts?.registry ?? null,
    getServerCapabilities: () => opts?.caps ?? null,
    supportsPull: () => {
      const dp = opts?.caps?.diagnosticProvider;
      return dp === true || (typeof dp === "object" && dp !== null);
    },
    supportsWorkspacePull: () => {
      const dp = opts?.caps?.diagnosticProvider as Record<string, unknown> | undefined;
      return !!dp && typeof dp === "object" && dp.workspaceDiagnostics === true;
    },
  });
}

describe("LspDiagnosticsBroker", () => {
  it("push cache returns source push with receipt; absent cache is unconfirmed, never clean", () => {
    const b = brokerWith();
    const p = file("/tmp", "a.ts");
    const unconfirmed = b.readPush(p);
    expect(unconfirmed).toMatchObject({ source: "push", confirmed: false, diagnostics: [] });
    const receipt = b.recordPush(p, [{ message: "err", severity: 1 }], { version: 3 });
    const confirmed = b.readPush(p);
    expect(confirmed.source).toBe("push");
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.receipt).toBe(receipt);
    expect(confirmed.diagnostics).toHaveLength(1);
  });

  it("version stays optional: push without version still confirms", () => {
    const b = brokerWith();
    const p = file("/tmp", "b.ts");
    b.recordPush(p, []);
    expect(b.readPush(p).confirmed).toBe(true);
    expect(b.readPush(p).diagnostics).toEqual([]);
  });

  it("post-edit invalidation drops the push cache back to unconfirmed", () => {
    const b = brokerWith();
    const p = file("/tmp", "c.ts");
    b.recordPush(p, [{ message: "stale", severity: 1 }]);
    b.invalidate(p);
    expect(b.readPush(p).confirmed).toBe(false);
  });

  it("pull returns source pull with items when supported", async () => {
    const request = vi.fn(async () => ({ kind: "full", items: [{ message: "x", severity: 2 }], resultId: "r1" }));
    const b = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: request });
    const r = await b.pullDocument("file:///tmp/d.ts");
    expect(r.source).toBe("pull");
    expect(r.confirmed).toBe(true);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.resultId).toBe("r1");
  });

  it("pull unsupported stays unconfirmed (never confirmed-clean)", async () => {
    const request = vi.fn(async () => ({ items: [] }));
    const b = brokerWith({ caps: {}, requestImpl: request });
    const r = await b.pullDocument("file:///tmp/e.ts");
    expect(r.confirmed).toBe(false);
    expect(request).not.toHaveBeenCalled();
    const wsOnly = LspCapabilityRegistry.fromInitializeResult({ capabilities: {} });
    wsOnly.register({ registrations: [{ id: "ws-1", method: "workspace/diagnostic" }] });
    const wsRequest = vi.fn(async () => ({ kind: "full", items: [] }));
    const bWsOnly = brokerWith({ caps: {}, registry: wsOnly, requestImpl: wsRequest });
    expect((await bWsOnly.pullDocument("file:///tmp/e.ts")).confirmed).toBe(false);
    expect(wsRequest).not.toHaveBeenCalled();
  });

  it("null transport failure on pull is unconfirmed, distinct from confirmed empty pull", async () => {
    const bNull = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: async () => null });
    expect((await bNull.pullDocument("file:///x.ts")).confirmed).toBe(false);
    const bEmpty = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: async () => ({ kind: "full", items: [] }) });
    const empty = await bEmpty.pullDocument("file:///x.ts");
    expect(empty.confirmed).toBe(true);
    expect(empty.diagnostics).toEqual([]);
  });

  it("full pull caches resultId in getPullState (absolute path and URI normalize)", async () => {
    const request = vi.fn(async () => ({ kind: "full", items: [{ message: "x", severity: 1 }], resultId: "rc1" }));
    const b = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: request });
    expect(b.getPullState(file("/tmp", "pull-cache.ts"))).toBeNull();
    await b.pullDocument("file:///tmp/pull-cache.ts");
    expect(b.getPullState(file("/tmp", "pull-cache.ts"))).toMatchObject({ resultId: "rc1" });
    expect(b.getPullState("file:///tmp/pull-cache.ts")!.diagnostics).toHaveLength(1);
  });

  it("unchanged pull WITH prior full replays cached diagnostics as confirmed", async () => {
    let mode: "full" | "unchanged" = "full";
    const request = vi.fn(async () =>
      mode === "full"
        ? { kind: "full", items: [{ message: "cached", severity: 1 }], resultId: "r9" }
        : { kind: "unchanged", resultId: "r9" },
    );
    const b = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: request });
    await b.pullDocument("file:///tmp/replay.ts");
    mode = "unchanged";
    const r = await b.pullDocument("file:///tmp/replay.ts", { previousResultId: "r9" });
    expect(r.confirmed).toBe(true);
    expect(r.resultId).toBe("r9");
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ message: "cached" });
  });

  it("unchanged pull WITHOUT prior full is unconfirmed, never empty-clean", async () => {
    const b = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: async () => ({ kind: "unchanged", resultId: "r9" }) });
    const r = await b.pullDocument("file:///tmp/no-prior.ts", { previousResultId: "r9" });
    expect(r.confirmed).toBe(false);
    expect(r.diagnostics).toEqual([]);
    expect(r.resultId).toBe("r9");
  });

  it("post-edit invalidate drops pull cache (unchanged after edit is unconfirmed)", async () => {
    let mode: "full" | "unchanged" = "full";
    const request = vi.fn(async () =>
      mode === "full"
        ? { kind: "full", items: [{ message: "stale", severity: 1 }], resultId: "ri1" }
        : { kind: "unchanged", resultId: "ri1" },
    );
    const b = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: request });
    await b.pullDocument("file:///tmp/inv-pull.ts");
    expect(b.getPullState(file("/tmp", "inv-pull.ts"))).not.toBeNull();
    b.invalidate(file("/tmp", "inv-pull.ts"));
    expect(b.getPullState(file("/tmp", "inv-pull.ts"))).toBeNull();
    mode = "unchanged";
    const r = await b.pullDocument("file:///tmp/inv-pull.ts", { previousResultId: "ri1" });
    expect(r.confirmed).toBe(false);
  });

  it("workspace pull returns source workspace-pull when supported, unconfirmed otherwise", async () => {
    const b = brokerWith({
      caps: { diagnosticProvider: { workspaceDiagnostics: true } },
      requestImpl: async () => ({ items: [{ uri: "file:///a.ts", kind: "full", items: [{ message: "w", severity: 1 }] }] }),
    });
    const r = await b.pullWorkspace();
    expect(r.source).toBe("workspace-pull");
    expect(r.confirmed).toBe(true);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]!).toMatchObject({ uri: "file:///a.ts", kind: "full" });
    expect(r.reports[0]!.diagnostics).toHaveLength(1);
    const bNo = brokerWith({ caps: {} });
    expect((await bNo.pullWorkspace()).confirmed).toBe(false);
    const wsDyn = LspCapabilityRegistry.fromInitializeResult({ capabilities: {} });
    wsDyn.register({ registrations: [{ id: "ws-1", method: "workspace/diagnostic" }] });
    const dynRequest = vi.fn(async () => ({ items: [{ uri: "file:///a.ts", kind: "full", items: [] }] }));
    const bDyn = brokerWith({ caps: {}, registry: wsDyn, requestImpl: dynRequest });
    const rDyn = await bDyn.pullWorkspace();
    expect(rDyn.confirmed).toBe(true);
    expect(rDyn.reports).toHaveLength(1);
    expect(rDyn.reports[0]!).toMatchObject({ uri: "file:///a.ts", kind: "full" });
  });

  it("settle uses observed evidence, not a fixed sleep as truth", async () => {
    const b = brokerWith();
    let n = 0;
    const { settled, value } = await b.settle(
      () => ++n,
      (v) => v >= 3,
      { deadlineMs: 500, intervalMs: 10 },
    );
    expect(settled).toBe(true);
    expect(value).toBe(3);
    const missed = await b.settle(() => 0, (v) => v === 1, { deadlineMs: 60, intervalMs: 10 });
    expect(missed.settled).toBe(false);
  });
  it("pull threads identifier/previousResultId through and preserves push version metadata", async () => {
    const request = vi.fn(async () => ({ kind: "full", items: [], resultId: "r2" }));
    const b = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: request });
    const r = await b.pullDocument("file:///tmp/f.ts", {
      identifier: "doc-1",
      previousResultId: "r1",
    });
    expect(request).toHaveBeenCalledWith(
      "textDocument/diagnostic",
      expect.objectContaining({
        identifier: "doc-1",
        previousResultId: "r1",
      }),
    );
    expect(r.resultId).toBe("r2");
    expect(r.version).toBeNull();
    const p = file("/tmp", "f.ts");
    b.recordPush(p, [{ message: "m", severity: 1 }], { version: 7, resultId: "pr" });
    const push = b.getPush(p)!;
    expect(push.version).toBe(7);
    expect(push.resultId).toBe("pr");
    expect(b.readPush(p).resultId).toBe("pr");
    expect(b.readPush(p).version).toBe(7);
  });
  it("workspace pull preserves entry resultId and threads identifiers", async () => {
    const request = vi.fn(async () => ({
      items: [{ uri: "file:///a.ts", kind: "full", resultId: "wr1", items: [{ message: "w", severity: 1 }] }],
    }));
    const b = brokerWith({
      caps: { diagnosticProvider: { workspaceDiagnostics: true } },
      requestImpl: request,
    });
    const r = await b.pullWorkspace({
      identifier: "ws-1",
      previousResultIds: [{ uri: "file:///a.ts", value: "wr0" }],
    });
    expect(request).toHaveBeenCalledWith(
      "workspace/diagnostic",
      expect.objectContaining({
        identifier: "ws-1",
        previousResultIds: [{ uri: "file:///a.ts", value: "wr0" }],
      }),
    );
    expect(r.confirmed).toBe(true);
    expect(r.resultId).toBe("wr1");
    expect(r.version).toBeNull();
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]!).toMatchObject({ uri: "file:///a.ts", resultId: "wr1", kind: "full" });
    expect(r.reports[0]!.diagnostics).toHaveLength(1);
  });
  it("workspace pull preserves per-document uri/version/resultId with unchanged entry listed", async () => {
    let round = 0;
    const request = vi.fn(async () => {
      round++;
      if (round === 1) {
        return {
          items: [
            { uri: "file:///a.ts", version: 3, kind: "full", resultId: "wa1", items: [{ message: "w", severity: 1 }] },
            { uri: "file:///b.ts", version: 5, kind: "full", resultId: "wb1", items: [] },
          ],
        };
      }
      return {
        items: [
          { uri: "file:///a.ts", version: 3, kind: "full", resultId: "wa1", items: [{ message: "w", severity: 1 }] },
          { uri: "file:///b.ts", version: 5, kind: "unchanged", resultId: "wb1" },
        ],
      };
    });
    const b = brokerWith({
      caps: { diagnosticProvider: { workspaceDiagnostics: true } },
      requestImpl: request,
    });
    await b.pullWorkspace();
    const r = await b.pullWorkspace();
    expect(request).toHaveBeenCalledTimes(2);
    expect(r.confirmed).toBe(true);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.resultId).toBe("wa1");
    expect(r.reports).toHaveLength(2);
    expect(r.reports[0]!).toMatchObject({ uri: "file:///a.ts", version: 3, resultId: "wa1", kind: "full" });
    expect(r.reports[0]!.diagnostics).toHaveLength(1);
    expect(r.reports[1]!).toMatchObject({ uri: "file:///b.ts", version: 5, resultId: "wb1", kind: "unchanged" });
    expect(r.reports[1]!.diagnostics).toEqual([]);
    expect(r.resultIds).toEqual([
      { uri: "file:///a.ts", value: "wa1" },
      { uri: "file:///b.ts", value: "wb1" },
    ]);
  });
  it("workspace pull omits identifier and previousResultIds when absent", async () => {
    const request = vi.fn(async () => ({ items: [] }));
    const b = brokerWith({
      caps: { diagnosticProvider: { workspaceDiagnostics: true } },
      requestImpl: request,
    });
    await b.pullWorkspace();
    expect(request).toHaveBeenCalledWith("workspace/diagnostic", {});
  });
  it("workspace pull builds previousResultIds from cache with resultId", async () => {
    const seen: unknown[] = [];
    const request = vi.fn(async (_m: string, p: unknown) => {
      seen.push(p);
      return { items: [{ uri: "file:///a.ts", kind: "full", resultId: "wr1", items: [{ message: "w", severity: 1 }] }] };
    });
    const b = brokerWith({
      caps: { diagnosticProvider: { workspaceDiagnostics: true } },
      requestImpl: request,
    });
    await b.pullWorkspace({ identifier: "ws-1" });
    expect(seen[0]).toEqual({ identifier: "ws-1" });
    await b.pullWorkspace({ identifier: "ws-1" });
    expect(seen[1]).toEqual({ identifier: "ws-1", previousResultIds: [{ uri: "file:///a.ts", value: "wr1" }] });
  });
  it("workspace full replaces cache; unchanged replays cache as confirmed", async () => {
    let mode: "full" | "unchanged" = "full";
    const request = vi.fn(async () =>
      mode === "full"
        ? { items: [{ uri: "file:///a.ts", kind: "full", resultId: "w1", items: [{ message: "cached", severity: 1 }] }] }
        : { items: [{ uri: "file:///a.ts", kind: "unchanged", resultId: "w1" }] },
    );
    const b = brokerWith({
      caps: { diagnosticProvider: { workspaceDiagnostics: true } },
      requestImpl: request,
    });
    await b.pullWorkspace();
    mode = "unchanged";
    const r = await b.pullWorkspace();
    expect(r.confirmed).toBe(true);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ message: "cached" });
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]!).toMatchObject({ uri: "file:///a.ts", kind: "unchanged" });
    expect(r.reports[0]!.diagnostics).toHaveLength(1);
  });
  it("workspace unchanged WITHOUT prior cache is unconfirmed, never clean", async () => {
    const b = brokerWith({
      caps: { diagnosticProvider: { workspaceDiagnostics: true } },
      requestImpl: async () => ({ items: [{ uri: "file:///b.ts", kind: "unchanged", resultId: "wb1" }] }),
    });
    const r = await b.pullWorkspace();
    expect(r.confirmed).toBe(false);
    expect(r.diagnostics).toEqual([]);
    expect(r.reports).toHaveLength(1);
    expect(r.reports[0]!.diagnostics).toEqual([]);
  });
  it("clearPush drops push cache only, preserves prior pull cache", async () => {
    const request = vi.fn(async () => ({ kind: "full", items: [{ message: "p", severity: 1 }], resultId: "rk1" }));
    const b = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: request });
    const p = file("/tmp", "clear-push.ts");
    await b.pullDocument("file:///tmp/clear-push.ts");
    b.recordPush(p, [{ message: "stale", severity: 1 }]);
    expect(b.getPullState(p)).not.toBeNull();
    b.clearPush(p);
    expect(b.readPush(p).confirmed).toBe(false);
    expect(b.getPullState(p)).toMatchObject({ resultId: "rk1" });
  });
  it("clear drops both push and pull caches", async () => {
    const request = vi.fn(async () => ({ kind: "full", items: [{ message: "p", severity: 1 }], resultId: "rk2" }));
    const b = brokerWith({ caps: { diagnosticProvider: true }, requestImpl: request });
    const p = file("/tmp", "clear-both.ts");
    await b.pullDocument("file:///tmp/clear-both.ts");
    b.recordPush(p, [{ message: "q", severity: 1 }]);
    b.clear(p);
    expect(b.readPush(p).confirmed).toBe(false);
    expect(b.getPullState(p)).toBeNull();
  });
});
