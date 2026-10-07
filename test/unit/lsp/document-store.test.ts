import { join, resolve } from "node:path";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { diffRange, LspDocumentStore, sha256OfText, syncConfigFromCapability } from "../../../src/lsp/lsp-document-store.js";

const file = (...segs: string[]) => resolve(join(...segs));

describe("LspDocumentStore", () => {
  it("closed document prepares as didOpen with monotonic version 1", () => {
    const store = new LspDocumentStore();
    const d = store.prepare(file("/tmp", "a.ts"), "const a = 1;");
    expect(d.action).toBe("didOpen");
    if (d.action === "didOpen") {
      expect(d.version).toBe(1);
      expect(d.languageId).toBe("typescript");
      expect(d.uri).toContain("a.ts");
    }
    expect(store.isOpen(file("/tmp", "a.ts"))).toBe(false); // open only after markSynced
    store.markSynced(file("/tmp", "a.ts"));
    expect(store.isOpen(file("/tmp", "a.ts"))).toBe(true);
  });

  it("unchanged content prepares as none (no wire)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "b.ts");
    store.prepare(p, "x");
    store.markSynced(p);
    const d = store.prepare(p, "x");
    expect(d.action).toBe("none");
    expect(store.getVersion(p)).toBe(1);
  });

  it("changed content uses incremental range edit when advertised, full otherwise", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "c.ts");
    store.prepare(p, "const a = 1;\n", { syncMode: "incremental" });
    store.markSynced(p);
    const inc = store.prepare(p, "const a = 2;\n", { syncMode: "incremental" });
    expect(inc.action).toBe("didChange-incremental");
    if (inc.action === "didChange-incremental") {
      expect(inc.range).toBeTruthy();
      expect(typeof inc.rangeLength).toBe("number");
    }
    const full = store.prepare(p, "const a = 3;\n", { syncMode: "full" });
    expect(full.action).toBe("didChange-full");
  });

  it("versions are monotonic and mutation generation bumps on change/close", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "d.ts");
    store.prepare(p, "a");
    store.markSynced(p);
    store.prepare(p, "b");
    const s = store.get(p)!;
    expect(s.version).toBe(2);
    expect(s.mutationGeneration).toBe(1);
    store.markClosed(p);
    expect(store.get(p)!.mutationGeneration).toBe(2);
    expect(store.isOpen(p)).toBe(false);
  });

  it("diagnostic receipts clear on mutation (post-edit invalidation)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "e.ts");
    store.prepare(p, "a");
    store.markSynced(p);
    const r = store.recordDiagnosticReceipt(p, "rid-1");
    expect(store.get(p)!.diagnosticReceipt).toBe(r);
    expect(store.get(p)!.resultId).toBe("rid-1");
    store.prepare(p, "b");
    expect(store.get(p)!.diagnosticReceipt).toBeNull();
    expect(store.get(p)!.resultId).toBeNull();
  });

  it("serializes per-document work in order", async () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "f.ts");
    const order: string[] = [];
    await Promise.all([
      store.serialize(p, async () => { await new Promise((r) => setTimeout(r, 20)); order.push("first"); }),
      store.serialize(p, async () => { order.push("second"); }),
    ]);
    expect(order).toEqual(["first", "second"]);
  });

  it("legacy syncMode none without openClose sends no wire (back-compat closed)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "g.ts");
    const first = store.prepare(p, "const a = 1;", { syncMode: "none" });
    expect(first.action).toBe("none");
    if (first.action === "none") expect(first.changed).toBe(true);
    expect(store.isOpen(p)).toBe(false);
    const second = store.prepare(p, "const a = 2;", { syncMode: "none" });
    expect(second.action).toBe("none");
    expect(store.isOpen(p)).toBe(false);
  });

  it("openClose true + change none: first touch didOpen, later changes track with no wire", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "g2.ts");
    const first = store.prepare(p, "const a = 1;", { syncConfig: { openClose: true, change: "none" } });
    expect(first.action).toBe("didOpen");
    store.markSynced(p);
    expect(store.isOpen(p)).toBe(true);
    const receipt = store.recordDiagnosticReceipt(p, "rid-1");
    expect(store.get(p)!.diagnosticReceipt).toBe(receipt);
    const genBefore = store.get(p)!.mutationGeneration;
    const second = store.prepare(p, "const a = 2;", { syncConfig: { openClose: true, change: "none" } });
    expect(second.action).toBe("none");
    if (second.action === "none") expect(second.changed).toBe(true);
    // No version bump for no-wire change, but content tracked + receipts cleared + generation bumped.
    expect(store.getVersion(p)).toBe(1);
    expect(store.get(p)!.lastContent).toBe("const a = 2;");
    expect(store.get(p)!.diagnosticReceipt).toBeNull();
    expect(store.get(p)!.resultId).toBeNull();
    expect(store.get(p)!.mutationGeneration).toBe(genBefore + 1);
    expect(store.isOpen(p)).toBe(true);
    const same = store.prepare(p, "const a = 2;", { syncConfig: { openClose: true, change: "none" } });
    expect(same.action).toBe("none");
    if (same.action === "none") expect(same.changed).toBe(false);
  });

  it("openClose false never opens; content still tracked with receipt invalidation", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "g3.ts");
    const first = store.prepare(p, "a", { syncConfig: { openClose: false, change: "none" } });
    expect(first.action).toBe("none");
    expect(store.isOpen(p)).toBe(false);
    store.recordDiagnosticReceipt(p, "rid-x");
    const genBefore = store.get(p)!.mutationGeneration;
    const second = store.prepare(p, "b", { syncConfig: { openClose: false, change: "none" } });
    expect(second.action).toBe("none");
    if (second.action === "none") expect(second.changed).toBe(true);
    expect(store.isOpen(p)).toBe(false);
    expect(store.get(p)!.lastContent).toBe("b");
    expect(store.get(p)!.diagnosticReceipt).toBeNull();
    expect(store.get(p)!.resultId).toBeNull();
    expect(store.get(p)!.mutationGeneration).toBe(genBefore + 1);
    store.markSynced(p);
    expect(store.isOpen(p)).toBe(false);
  });

  it("incremental decision carries baseText (old synchronized source)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "g4.ts");
    store.prepare(p, "const a = 1;\n", { syncMode: "incremental" });
    store.markSynced(p);
    const d = store.prepare(p, "const a = 2;\n", { syncMode: "incremental" });
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

  it("openClose:false with change mode sends no wire (didChange requires didOpen)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "g5.ts");
    const first = store.prepare(p, "a", { syncConfig: { openClose: false, change: "full" } });
    expect(first.action).toBe("none");
    if (first.action === "none") expect(first.changed).toBe(true);
    expect(store.isOpen(p)).toBe(false);
    const genBefore = store.get(p)!.mutationGeneration;
    const second = store.prepare(p, "b", { syncConfig: { openClose: false, change: "full" } });
    expect(second.action).toBe("none");
    if (second.action === "none") expect(second.changed).toBe(true);
    expect(store.isOpen(p)).toBe(false);
    expect(store.get(p)!.lastContent).toBe("b");
    expect(store.get(p)!.mutationGeneration).toBe(genBefore + 1);
  });

  it("symlinked and real paths share one entry (canonical key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "docstore-sym-"));
    try {
      const real = join(dir, "real.ts");
      writeFileSync(real, "const a = 1;");
      const link = join(dir, "link.ts");
      symlinkSync(real, link);
      const store = new LspDocumentStore();
      store.prepare(link, "const a = 1;");
      store.markSynced(link);
      // Same canonical entry visible via real path.
      expect(store.isOpen(real)).toBe(true);
      expect(store.getVersion(real)).toBe(1);
      const viaLink = store.prepare(real, "const a = 1;");
      expect(viaLink.action).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nonexistent path falls back to lexical key (no throw)", () => {
    const store = new LspDocumentStore();
    const p = file("/tmp", "no-such-dir-xyz", "missing.ts");
    const d = store.prepare(p, "x");
    expect(d.action).toBe("didOpen");
    store.markSynced(p);
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
