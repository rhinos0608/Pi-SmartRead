import { join, resolve } from "node:path";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { diffRange, LspDocumentStore, sha256OfText, syncConfigFromCapability } from "../../../src/lsp/lsp-document-store.js";

const file = (...segs: string[]) => resolve(join(...segs));

const mockCtx = {
  connectionId: "conn-1",
  transportId: "trans-1",
  descriptorId: "desc-1",
  projectRoot: "/workspace",
  positionEncoding: "utf-16" as const,
};

describe("LspDocumentStore", () => {
  it("closed document prepares as didOpen with monotonic version 1, open only after commit", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "a.ts");
    const d = store.planPrepare(p, "const a = 1;");
    expect(d.action).toBe("didOpen");
    if (d.action === "didOpen") {
      expect(d.version).toBe(1);
      expect(d.languageId).toBe("typescript");
      expect(d.uri).toContain("a.ts");
    }
    expect(store.isOpen(p)).toBe(false); // open only after commit
    const receipt = store.commitSubmitted(d, mockCtx);
    expect(store.isOpen(p)).toBe(true);
    expect(receipt.version).toBe(1);
    expect(receipt.canonicalPath).toBe(p);
    expect(receipt.connectionId).toBe("conn-1");
  });

  it("unchanged content prepares as none reusing submitted receipt", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "b.ts");
    const d1 = store.planPrepare(p, "x");
    const receipt1 = store.commitSubmitted(d1, mockCtx);
    const d2 = store.planPrepare(p, "x");
    expect(d2.action).toBe("none");
    if (d2.action === "none") {
      expect(d2.receipt).toBe(receipt1);
    }
    expect(store.getVersion(p)).toBe(1);
  });

  it("changed content uses incremental range edit when advertised, full otherwise", () => {
    const store = new LspDocumentStore();
    const p1 = file("/tmp", "c_inc.ts");
    const d1 = store.planPrepare(p1, "const a = 1;\n", { syncConfig: { openClose: true, change: "incremental" } });
    store.commitSubmitted(d1, mockCtx);
    const inc = store.planPrepare(p1, "const a = 2;\n", { syncConfig: { openClose: true, change: "incremental" } });
    expect(inc.action).toBe("didChange-incremental");
    if (inc.action === "didChange-incremental") {
      expect(inc.range).toBeTruthy();
      expect(typeof inc.rangeLength).toBe("number");
    }
    store.commitSubmitted(inc, mockCtx);

    const p2 = file("/tmp", "c_full.ts");
    const d2 = store.planPrepare(p2, "const a = 1;\n", { syncConfig: { openClose: true, change: "full" } });
    store.commitSubmitted(d2, mockCtx);
    const full = store.planPrepare(p2, "const a = 2;\n", { syncConfig: { openClose: true, change: "full" } });
    expect(full.action).toBe("didChange-full");
  });

  it("versions are monotonic and mutation generation bumps on change/close", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "d.ts");
    const d1 = store.planPrepare(p, "a");
    store.commitSubmitted(d1, mockCtx);
    const d2 = store.planPrepare(p, "b");
    store.commitSubmitted(d2, mockCtx);
    const s = store.get(p)!;
    expect(s.submittedVersion).toBe(2);
    expect(s.mutationGeneration).toBe(2);
    store.markClosed(p);
    expect(store.get(p)!.mutationGeneration).toBe(3);
    expect(store.isOpen(p)).toBe(false);
    expect(store.getSubmittedReceipt(p)).toBeNull();
  });

  it("diagnostic receipts clear on mutation (post-edit invalidation)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "e.ts");
    const d1 = store.planPrepare(p, "a");
    store.commitSubmitted(d1, mockCtx);
    const r = store.recordDiagnosticReceipt(p, "rid-1");
    expect(store.get(p)!.diagnosticReceipt).toBe(r);
    expect(store.get(p)!.resultId).toBe("rid-1");
    const d2 = store.planPrepare(p, "b");
    store.commitSubmitted(d2, mockCtx);
    expect(store.get(p)!.diagnosticReceipt).toBeNull();
    expect(store.get(p)!.resultId).toBeNull();
  });

  it("serializes per-document work in order, releasing queue even on failure", async () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "f.ts");
    const order: string[] = [];
    await Promise.allSettled([
      store.serialize(p, async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("first-fail");
        throw new Error("fail in queue");
      }),
      store.serialize(p, async () => {
        order.push("second-pass");
      }),
    ]);
    expect(order).toEqual(["first-fail", "second-pass"]);
  });

  it("no-sync or openClose:false throws (cannot produce valid receipt)", () => {
    const store = new LspDocumentStore();
    const p1 = file("/tmp", "g1.ts");
    expect(() => store.planPrepare(p1, "a", { syncConfig: { openClose: false, change: "full" } }))
      .toThrow(/synchronization not supported/);
    const p2 = file("/tmp", "g2.ts");
    expect(() => store.planPrepare(p2, "a", { syncConfig: { openClose: true, change: "none" } }))
      .toThrow(/synchronization not supported/);
  });

  it("uncertain write refuses preparation until established new document lifecycle", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "uncert.ts");
    const d1 = store.planPrepare(p, "const a = 1;\n", { syncConfig: { openClose: true, change: "incremental" } });
    store.commitSubmitted(d1, mockCtx);
    expect(store.getSubmittedReceipt(p)).not.toBeNull();

    // Mark uncertain (simulates write error or abort)
    store.markUncertain(p);
    expect(store.getSubmittedReceipt(p)).toBeNull();
    expect(store.get(p)!.uncertain).toBe(true);

    // Uncertain state must remain refused without silent wire recovery
    expect(() => store.planPrepare(p, "const a = 2;\n", { syncConfig: { openClose: true, change: "incremental" } }))
      .toThrow(/uncertain/);

    // Establishing a new lifecycle (close) resets uncertain state and permits fresh didOpen
    store.markClosed(p);
    const d2 = store.planPrepare(p, "const a = 2;\n", { syncConfig: { openClose: true, change: "incremental" } });
    expect(d2.action).toBe("didOpen");
  });

  it("markClosed during write must refuse commit and never reopen old plan", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "closed-during-write.ts");
    const d1 = store.planPrepare(p, "v1");
    store.commitSubmitted(d1, mockCtx);
    expect(store.isOpen(p)).toBe(true);

    const d2 = store.planPrepare(p, "v2");
    // Simulate didClose occurring during the deferred write of v2
    store.markClosed(p);
    expect(store.isOpen(p)).toBe(false);

    // Attempting to commit the old plan after markClosed must refuse and never reopen
    expect(() => store.commitSubmitted(d2, mockCtx)).toThrow(/refused|mismatch/);
    expect(store.isOpen(p)).toBe(false);
  });

  it("incremental decision carries baseText (old synchronized source)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "g4.ts");
    const d1 = store.planPrepare(p, "const a = 1;\n", { syncConfig: { openClose: true, change: "incremental" } });
    store.commitSubmitted(d1, mockCtx);
    const d = store.planPrepare(p, "const a = 2;\n", { syncConfig: { openClose: true, change: "incremental" } });
    expect(d.action).toBe("didChange-incremental");
    if (d.action === "didChange-incremental") expect(d.baseText).toBe("const a = 1;\n");
  });

  it("syncConfigFromCapability maps numeric and object forms to both dimensions", () => {
    expect(syncConfigFromCapability(null)).toEqual({ openClose: true, change: "full" });
    expect(syncConfigFromCapability({ textDocumentSync: 2 })).toEqual({ openClose: true, change: "incremental" });
    expect(syncConfigFromCapability({ textDocumentSync: 1 })).toEqual({ openClose: true, change: "full" });
    expect(syncConfigFromCapability({ textDocumentSync: 0 })).toEqual({ openClose: false, change: "none" });
    expect(syncConfigFromCapability({ textDocumentSync: { change: 2 } })).toEqual({ openClose: false, change: "incremental" });
    expect(syncConfigFromCapability({ textDocumentSync: { change: 1 } })).toEqual({ openClose: false, change: "full" });
    expect(syncConfigFromCapability({ textDocumentSync: { openClose: true } })).toEqual({ openClose: true, change: "none" });
    expect(syncConfigFromCapability({ textDocumentSync: { openClose: false } })).toEqual({ openClose: false, change: "none" });
    expect(syncConfigFromCapability({ textDocumentSync: { openClose: false, change: 2 } })).toEqual({ openClose: false, change: "incremental" });
  });

  it("symlinked and real paths share one entry (canonical key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstore-sym-"));
    try {
      const real = join(dir, "real.ts");
      writeFileSync(real, "const a = 1;");
      const link = join(dir, "link.ts");
      symlinkSync(real, link);
      const store = new LspDocumentStore();
      const d1 = store.planPrepare(link, "const a = 1;");
      store.commitSubmitted(d1, mockCtx);
      // Same canonical entry visible via real path.
      expect(store.isOpen(real)).toBe(true);
      expect(store.getVersion(real)).toBe(1);
      const viaLink = store.planPrepare(real, "const a = 1;");
      expect(viaLink.action).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nonexistent path falls back to lexical key (no throw)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "no-such-dir-xyz", "missing.ts");
    const d = store.planPrepare(p, "x");
    expect(d.action).toBe("didOpen");
    store.commitSubmitted(d, mockCtx);
    expect(store.isOpen(p)).toBe(true);
  });

  it("sha256OfText is stable and content-bound", () => {
    expect(sha256OfText("a")).toBe(sha256OfText("a"));
    expect(sha256OfText("a")).not.toBe(sha256OfText("b"));
  });

  it("diffRange returns null for identical text and a range otherwise", () => {
    expect(diffRange("same", "same")).toBeNull();
    const d = diffRange("const a = 1;\n", "const a = 2;\n");
    expect(d).not.toBeNull();
    expect(d!.range.start.line).toBe(0);
  });
});
