import { describe, expect, it } from "vitest";
import { LspReadinessTracker, READINESS_TOKEN_LIMIT, READINESS_TERMINAL_TTL_MS } from "../../../src/lsp/lsp-readiness-tracker.js";
import { convertOffset, resolveNegotiatedEncoding } from "../../../src/lsp/lsp-position-codec.js";

describe("LspReadinessTracker", () => {
  it("unknown with no tokens observed", () => {
    const t = new LspReadinessTracker();
    expect(t.readiness()).toMatchObject({ state: "unknown" });
  });

  it("begin/report is settling, end is confirmed (per-token, no universal gate)", () => {
    const t = new LspReadinessTracker();
    t.onProgress({ token: "build", value: { kind: "begin", title: "Indexing" } });
    expect(t.readiness("build").state).toBe("settling");
    expect(t.readiness().state).toBe("settling");
    t.onProgress({ token: "build", value: { kind: "report", message: "halfway", percentage: 50 } });
    expect(t.readiness("build").state).toBe("settling");
    t.onProgress({ token: "build", value: { kind: "end", message: "done" } });
    expect(t.readiness("build").state).toBe("confirmed");
    expect(t.readiness().state).toBe("confirmed");
    expect(t.readiness("build").basis).toBe("progress");
  });

  it("one ended token does not gate an unrelated active token", () => {
    const t = new LspReadinessTracker();
    t.onProgress({ token: "a", value: { kind: "end" } });
    t.onProgress({ token: "b", value: { kind: "begin", title: "Other" } });
    expect(t.readiness("a").state).toBe("confirmed");
    expect(t.readiness("b").state).toBe("settling");
    expect(t.readiness().state).toBe("settling");
  });

  it("unknown token is unknown, malformed progress is ignored", () => {
    const t = new LspReadinessTracker();
    expect(t.readiness("nope").state).toBe("unknown");
    t.onProgress(null);
    t.onProgress({ token: "x", value: { kind: "bogus" } });
    expect(t.readiness().state).toBe("unknown");
  });

  it("work-done tokens track and untrack", () => {
    const t = new LspReadinessTracker();
    t.trackWorkDoneToken("wd-1");
    expect(t.isWorkDoneToken("wd-1")).toBe(true);
    t.onProgress({ token: "wd-1", value: { kind: "begin", title: "Work" } });
    expect(t.readiness("wd-1").state).toBe("settling");
    t.untrackWorkDoneToken("wd-1");
    expect(t.isWorkDoneToken("wd-1")).toBe(false);
  });

  it("tracked work-done token with no progress is unknown until begin", () => {
    const t = new LspReadinessTracker();
    t.trackWorkDoneToken("t");
    expect(t.readiness()).toMatchObject({ state: "unknown", basis: "none" });
    expect(t.readiness("t")).toMatchObject({ state: "unknown", basis: "none" });
    t.onProgress({ token: "t", value: { kind: "begin", title: "Work" } });
    expect(t.readiness()).toMatchObject({ state: "settling" });
    t.onProgress({ token: "t", value: { kind: "end", message: "done" } });
    expect(t.readiness()).toMatchObject({ state: "confirmed" });
  });

  it("mixed unphased and ended tokens stay globally unknown", () => {
    const t = new LspReadinessTracker();
    t.onProgress({ token: "done", value: { kind: "end", message: "done" } });
    t.trackWorkDoneToken("pending");
    expect(t.readiness("done").state).toBe("confirmed");
    expect(t.readiness()).toMatchObject({ state: "unknown", basis: "none" });
  });

  it("bounds total tokens LRU at READINESS_TOKEN_LIMIT (evicts oldest)", () => {
    const t = new LspReadinessTracker({ maxTokens: 4 });
    for (let i = 0; i < 6; i++) {
      t.onProgress({ token: `tok-${i}`, value: { kind: "begin", title: `T${i}` } });
    }
    expect(Object.keys(t.snapshot())).toHaveLength(4);
    expect(t.readiness("tok-0").state).toBe("unknown");
    expect(t.readiness("tok-1").state).toBe("unknown");
    expect(t.readiness("tok-5").state).toBe("settling");
    expect(READINESS_TOKEN_LIMIT).toBe(128);
  });

  it("expires terminal entries after TTL, never active entries", () => {
    let now = 1_000_000;
    const t = new LspReadinessTracker({ now: () => now, terminalTtlMs: 5 * 60 * 1000 });
    t.onProgress({ token: "done", value: { kind: "end", message: "done" } });
    t.onProgress({ token: "active", value: { kind: "begin", title: "Work" } });
    expect(t.readiness("done").state).toBe("confirmed");
    now += READINESS_TERMINAL_TTL_MS + 1;
    // Terminal entry expired; active entry survives TTL.
    expect(t.readiness("done").state).toBe("unknown");
    expect(t.readiness("active").state).toBe("settling");
    expect("done" in t.snapshot()).toBe(false);
  });

  it("unphased tracked tokens never expire by TTL", () => {
    let now = 0;
    const t = new LspReadinessTracker({ now: () => now, terminalTtlMs: 1000 });
    t.trackWorkDoneToken("pending");
    now += 60 * 60 * 1000;
    expect(t.readiness()).toMatchObject({ state: "unknown", basis: "none" });
    expect("pending" in t.snapshot()).toBe(true);
  });
});

describe("positions round-trip all three encodings", () => {
  const line = "aé☕x";
  it("utf-8 <-> utf-16 <-> utf-32 round-trip via line source", () => {
    for (const enc of ["utf-8", "utf-16", "utf-32"] as const) {
      for (const target of ["utf-8", "utf-16", "utf-32"] as const) {
        const peer = enc === "utf-8" ? "utf-16" : "utf-8";
        void peer;
        const start = convertOffset(line, 2, "utf-16", enc);
        const back = convertOffset(line, start, enc, "utf-16");
        expect(back).toBe(2);
        const toTarget = convertOffset(line, 2, "utf-16", target);
        const backTo16 = convertOffset(line, toTarget, target, "utf-16");
        expect(backTo16).toBe(2);
      }
    }
  });

  it("resolveNegotiatedEncoding honors server offer, defaults to utf-16", () => {
    expect(resolveNegotiatedEncoding({ capabilities: { positionEncoding: "utf-8" } })).toBe("utf-8");
    expect(resolveNegotiatedEncoding({ capabilities: {} })).toBe("utf-16");
  });
});
