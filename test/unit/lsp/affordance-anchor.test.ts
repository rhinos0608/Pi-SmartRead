import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveAffordanceAnchor } from "../../../src/lsp/affordance-anchor.js";
import type { AffordanceExecContext } from "../../../src/lsp/affordance-contract.js";
import type { StrictEnvelope } from "../../../src/lsp/lsp-strict-contract.js";

// Fail-closed realpath regression seam: fail ONLY the anchor's canonicalization
// via a global flag; every other node:fs export delegates to the original.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const real = actual.realpathSync;
  return {
    ...actual,
    realpathSync: ((p: string, ...rest: never[]) => {
      if ((globalThis as Record<string, unknown>).__anchorFailRealpath) {
        throw new Error("injected realpath failure");
      }
      return (real as (p: string, ...rest: never[]) => string)(p, ...rest);
    }) as typeof actual.realpathSync,
  };
});

const R = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

function serverInfo(descriptorId = "ts", encoding: "utf-8" | "utf-16" | "utf-32" = "utf-16") {
  return { descriptorId, name: descriptorId, languageId: "typescript", projectRoot: "/repo", positionEncoding: encoding };
}

function docSymbolsEnvelope(result: unknown, over: Partial<StrictEnvelope> = {}): StrictEnvelope {
  return {
    status: "ok",
    operation: "documentSymbols",
    method: "textDocument/documentSymbol",
    server: serverInfo(),
    result,
    meta: { truncated: false },
    ...over,
  };
}

function workspaceEnvelope(result: unknown, over: Partial<StrictEnvelope> = {}): StrictEnvelope {
  return {
    status: "ok",
    operation: "workspaceSymbols",
    method: "workspace/symbol",
    server: { ...serverInfo(), descriptorId: "unknown" },
    result,
    meta: { truncated: false },
    ...over,
  };
}

function docSymbol(name: string, sel: ReturnType<typeof R>, extra: Record<string, unknown> = {}) {
  return {
    name,
    kind: 12,
    range: R(0, 0, 20, 0),
    selectionRange: sel,
    selectionProvenance: "explicit",
    ...extra,
  };
}

/** Fake strict executor: calls are recorded so dispatch counts are auditable. */
function fakeCtx(script: Array<StrictEnvelope | Error>, over: Partial<AffordanceExecContext> = {}) {
  const calls: Array<{ req: unknown; deps: unknown }> = [];
  const respond = vi.fn(async (_req: unknown, _deps: unknown): Promise<StrictEnvelope> => {
    throw new Error("fake executor out of script");
  });
  const exec = vi.fn(async (req: unknown, deps: unknown) => {
    calls.push({ req, deps });
    return respond(req, deps);
  });
  if (script.length > 0) {
    for (const next of script) {
      if (next instanceof Error) respond.mockRejectedValueOnce(next);
      else respond.mockResolvedValueOnce(next);
    }
  }
  const root = mkdtempSync(join(tmpdir(), "anchor-"));
  const ctx: AffordanceExecContext = {
    root,
    budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 15000 },
    exec: exec as never,
    ...over,
  };
  return { ctx, calls, exec, respond, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function writeTarget(root: string, rel = "src/a.ts"): string {
  const abs = join(root, rel);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(abs, "export function start() {}\n");
  return abs;
}

describe("resolveAffordanceAnchor — explicit path", () => {
  it("accepts a genuine DocumentSymbol selectionRange and carries the envelope verbatim", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx([]);
    const abs = writeTarget(root);
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(3, 9, 3, 14))]);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("resolved");
      if (out.kind !== "resolved") return;
      expect(out.path).toBe(realpathSync(abs));
      expect(out.position).toEqual({ line: 3, character: 9 });
      expect(out.resolutionEnvelope).toBe(envelope);
      expect(calls).toHaveLength(1);
      expect((calls[0]!.req as { operation: string }).operation).toBe("documentSymbols");
    } finally {
      done();
    }
  });

  it("blocks a collapsed SymbolInformation broad range (never dispatches on it)", async () => {
    const { ctx, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    try {
      const uri = pathToFileURL(join(root, "src/a.ts")).href;
      const envelope = docSymbolsEnvelope([
        {
          name: "start",
          kind: 12,
          range: R(0, 0, 20, 0),
          selectionRange: R(0, 0, 20, 0),
          selectionProvenance: "collapsed",
          uri,
        },
      ]);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("not_ready");
      expect(out.code).toBe("anchor_search_incomplete");
      expect(out.envelopes[0]).toBe(envelope);
    } finally {
      done();
    }
  });

  it("treats legacy symbols without provenance as unusable (fail-closed)", async () => {
    const { ctx, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    try {
      const envelope = docSymbolsEnvelope([{ name: "start", kind: 12, range: R(0, 0, 5, 0), selectionRange: R(1, 0, 1, 5) }]);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.code).toBe("anchor_search_incomplete");
    } finally {
      done();
    }
  });

  it("rejects an absent explicit path distinctly without any server request", async () => {
    const { ctx, exec, done } = fakeCtx([]);
    try {
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/missing.ts" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("error");
      expect(out.code).toBe("anchor_invalid_path");
      expect(exec).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });

  it("rejects a non-file explicit path distinctly", async () => {
    const { ctx, exec, root, done } = fakeCtx([]);
    try {
      mkdirSync(join(root, "adir"), { recursive: true });
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "adir" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.code).toBe("anchor_invalid_path");
      expect(exec).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });

  it("reports zero matches as file-scoped anchor_not_found", async () => {
    const { ctx, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    try {
      const envelope = docSymbolsEnvelope([docSymbol("other", R(1, 0, 1, 5))]);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("error");
      expect(out.code).toBe("anchor_not_found");
      expect(out.envelopes[0]).toBe(envelope);
    } finally {
      done();
    }
  });

  it("reports duplicate declarations as ambiguous with bounded candidates", async () => {
    const { ctx, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    try {
      const syms = Array.from({ length: 12 }, (_, i) => docSymbol("start", R(i, 0, i, 5)));
      const envelope = docSymbolsEnvelope(syms);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("ambiguous");
      expect(out.code).toBe("ambiguous_anchor");
      expect(out.candidates.length).toBeLessThanOrEqual(10);
      expect(out.retry).toMatch(/path/);
    } finally {
      done();
    }
  });

  it("matches hierarchy segments exactly with JSON Pointer escapes, never fuzzy", async () => {
    const { ctx, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    try {
      const envelope = docSymbolsEnvelope([
        {
          name: "Outer",
          kind: 5,
          range: R(0, 0, 20, 0),
          selectionRange: R(0, 6, 0, 11),
          selectionProvenance: "explicit",
          children: [
            { name: "A/B", kind: 12, range: R(2, 0, 4, 0), selectionRange: R(2, 9, 2, 12), selectionProvenance: "explicit" },
            { name: "start", kind: 12, range: R(6, 0, 8, 0), selectionRange: R(6, 9, 6, 14), selectionProvenance: "explicit" },
          ],
        },
        docSymbol("star", R(10, 0, 10, 4)),
      ]);
      respond.mockResolvedValue(envelope);
      const escaped = await resolveAffordanceAnchor({ symbol: "Outer/A~1B", path: "src/a.ts" }, ctx);
      expect(escaped.kind).toBe("resolved");
      if (escaped.kind !== "resolved") return;
      expect(escaped.position).toEqual({ line: 2, character: 9 });
      // "star" must not fuzzy-match "start" — but "start" exists once, so check a non-present name.
      const fuzzy = await resolveAffordanceAnchor({ symbol: "starx", path: "src/a.ts" }, ctx);
      expect(fuzzy.kind).toBe("unresolved");
      if (fuzzy.kind !== "unresolved") return;
      expect(fuzzy.code).toBe("anchor_not_found");
    } finally {
      done();
    }
  });

  it("propagates unavailable and malformed envelopes with verbatim evidence", async () => {
    const { ctx, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    try {
      const unavailable: StrictEnvelope = {
        ...docSymbolsEnvelope(null),
        status: "unavailable",
        result: null,
        error: { code: "unavailable", message: "no session" },
      };
      respond.mockResolvedValueOnce(unavailable);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("unavailable");
      expect(out.envelopes[0]).toBe(unavailable);

      const malformed: StrictEnvelope = {
        ...docSymbolsEnvelope(null),
        status: "error",
        result: null,
        error: { code: "normalization", message: "malformed documentSymbols response" },
      };
      respond.mockResolvedValueOnce(malformed);
      const out2 = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out2.kind).toBe("unresolved");
      if (out2.kind !== "unresolved") return;
      expect(out2.status).toBe("error");
      expect(out2.envelopes[0]).toBe(malformed);
    } finally {
      done();
    }
  });

  it("reports observed stale resolution evidence as stale_anchor", async () => {
    const { ctx, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(1, 0, 1, 5))], {
        meta: { truncated: false, documentVersion: 3, freshness: { state: "stale", documentVersion: 3 } },
      });
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("error");
      expect(out.code).toBe("stale_anchor");
    } finally {
      done();
    }
  });

  it("preserves the negotiated-encoding server identity verbatim", async () => {
    const { ctx, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(1, 4, 1, 9))], {
        server: serverInfo("ts", "utf-8"),
      });
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("resolved");
      if (out.kind !== "resolved") return;
      expect(out.server.positionEncoding).toBe("utf-8");
      expect(out.position).toEqual({ line: 1, character: 4 });
    } finally {
      done();
    }
  });

  it("rejects position targets and malformed targets as caller errors", async () => {
    const { ctx, done } = fakeCtx([]);
    try {
      await expect(
        resolveAffordanceAnchor({ path: "src/a.ts", position: { line: 0, character: 0 } } as never, ctx),
      ).rejects.toThrow();
      await expect(resolveAffordanceAnchor({ symbol: "" } as never, ctx)).rejects.toThrow();
    } finally {
      done();
    }
  });
});

describe("resolveAffordanceAnchor — canonical identity and explicit-path scope", () => {
  function trySymlink(target: string, link: string): boolean {
    try {
      symlinkSync(target, link);
      return true;
    } catch {
      return false; // Windows CI without symlink privilege: skip alias coverage there.
    }
  }

  it("dispatches the canonical symlink target, binding resolution to the same identity", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    const link = join(root, "src", "link.ts");
    if (!trySymlink("a.ts", link)) {
      done();
      return;
    }
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(1, 0, 1, 5))]);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/link.ts" }, ctx);
      const canonical = realpathSync(join(root, "src", "a.ts"));
      expect(calls).toHaveLength(1);
      expect((calls[0]!.req as { path: string }).path).toBe(canonical);
      expect(out.kind).toBe("resolved");
      if (out.kind !== "resolved") return;
      expect(out.path).toBe(canonical);
      expect(out.resolutionEnvelope).toBe(envelope);
    } finally {
      done();
    }
  });

  it("permits an explicit symlink whose canonical target lives outside the root (strict allows it)", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx([]);
    const outsideBase = mkdtempSync(join(tmpdir(), "anchor-outside-"));
    const link = join(root, "src", "ext.ts");
    const outsideFile = join(outsideBase, "b.ts");
    writeFileSync(outsideFile, "export const start = 1;\n");
    if (!trySymlink(outsideFile, link)) {
      rmSync(outsideBase, { recursive: true, force: true });
      done();
      return;
    }
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(1, 0, 1, 5))]);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/ext.ts" }, ctx);
      const canonical = realpathSync(outsideFile);
      expect(calls).toHaveLength(1);
      expect((calls[0]!.req as { path: string }).path).toBe(canonical);
      expect(out.kind).toBe("resolved");
      if (out.kind !== "resolved") return;
      expect(out.path).toBe(canonical);
    } finally {
      rmSync(outsideBase, { recursive: true, force: true });
      done();
    }
  });

  it("permits relative-parent and absolute explicit files outside the root (no path jail)", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx([]);
    const outsideBase = mkdtempSync(join(tmpdir(), "anchor-outside-"));
    const outsideFile = join(outsideBase, "b.ts");
    writeFileSync(outsideFile, "export const start = 1;\n");
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(1, 0, 1, 5))]);
      respond.mockResolvedValue(envelope);
      const relParent = relative(root, outsideFile);
      expect(relParent.startsWith("..")).toBe(true);
      const viaParent = await resolveAffordanceAnchor({ symbol: "start", path: relParent }, ctx);
      expect(viaParent.kind).toBe("resolved");
      const viaAbs = await resolveAffordanceAnchor({ symbol: "start", path: outsideFile }, ctx);
      expect(viaAbs.kind).toBe("resolved");
      if (viaAbs.kind !== "resolved") return;
      expect(viaAbs.path).toBe(realpathSync(outsideFile));
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(outsideBase, { recursive: true, force: true });
      done();
    }
  });

  it("resolves relative explicit paths against ctx.workspace when supplied (strict effective root)", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx([]);
    const ws = mkdtempSync(join(tmpdir(), "anchor-ws-"));
    writeTarget(ws);
    const wsCtx: AffordanceExecContext = { ...ctx, workspace: ws };
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(1, 0, 1, 5))]);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, wsCtx);
      expect(calls).toHaveLength(1);
      expect((calls[0]!.req as { workspace: string }).workspace).toBe(ws);
      expect((calls[0]!.req as { path: string }).path).toBe(realpathSync(join(ws, "src", "a.ts")));
      expect(out.kind).toBe("resolved");
      void root;
    } finally {
      rmSync(ws, { recursive: true, force: true });
      done();
    }
  });

  it("fails closed with anchor_invalid_path when canonicalization fails (never falls back)", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx([]);
    writeTarget(root);
    (globalThis as Record<string, unknown>).__anchorFailRealpath = true;
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(1, 0, 1, 5))]);
      respond.mockResolvedValue(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("error");
      expect(out.code).toBe("anchor_invalid_path");
      expect(calls).toHaveLength(0);
    } finally {
      delete (globalThis as Record<string, unknown>).__anchorFailRealpath;
      done();
    }
  });
});

describe("resolveAffordanceAnchor — pathless discovery", () => {
  it("never dispatches a single discovery candidate (not_ready + path retry)", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx([]);
    try {
      const uri = pathToFileURL(join(root, "src/a.ts")).href;
      // Discovery candidates carry uri/path form; the resolver must still refuse dispatch.
      const envelope = workspaceEnvelope([
        {
          name: "start",
          kind: 12,
          range: R(0, 0, 20, 0),
          selectionRange: R(0, 0, 20, 0),
          selectionProvenance: "collapsed",
          uri,
        },
      ]);
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start" }, ctx);
      expect((calls[0]!.req as { operation: string }).operation).toBe("workspaceSymbols");
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("not_ready");
      expect(out.code).toBe("anchor_search_incomplete");
      expect(out.retry).toMatch(/path/);
      expect(calls).toHaveLength(1);
    } finally {
      done();
    }
  });

  it("reports empty discovery as incomplete, never workspace-wide not_found", async () => {
    const { ctx, respond, done } = fakeCtx([]);
    try {
      respond.mockResolvedValueOnce(workspaceEnvelope([]));
      const out = await resolveAffordanceAnchor({ symbol: "absent-everywhere" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("not_ready");
      expect(out.code).toBe("anchor_search_incomplete");
      expect(out.candidates).toEqual([]);
    } finally {
      done();
    }
  });

  it("bounds discovery at 100 candidates and stays incomplete", async () => {
    const { ctx, respond, done } = fakeCtx([]);
    try {
      const many = Array.from({ length: 140 }, (_, i) => ({
        name: "start",
        kind: 12,
        range: R(0, 0, 1, 0),
        selectionRange: R(0, 0, 1, 0),
        selectionProvenance: "collapsed",
        uri: `file:///repo/src/f${i}.ts`,
      }));
      respond.mockResolvedValueOnce(workspaceEnvelope(many));
      const out = await resolveAffordanceAnchor({ symbol: "start" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.code).toBe("anchor_search_incomplete");
      expect(out.candidates.length).toBeLessThanOrEqual(100);
    } finally {
      done();
    }
  });
});

describe("resolveAffordanceAnchor — budgets", () => {
  it("honours cancellation before any request", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, exec, done } = fakeCtx([], {
      budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 15000, signal: controller.signal },
    });
    try {
      const out = await resolveAffordanceAnchor({ symbol: "start" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("cancelled");
      expect(exec).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });

  it("enforces the aggregate deadline", async () => {
    const { ctx, exec, done } = fakeCtx([], {
      budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 0 },
    });
    try {
      const out = await resolveAffordanceAnchor({ symbol: "start" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("timeout");
      expect(exec).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });

  it("rejects exhausted request admission without dispatch", async () => {
    const { ctx, exec, done } = fakeCtx([], {
      budget: { maxCandidates: 100, maxRequests: 0, deadlineMs: 15000 },
    });
    try {
      const out = await resolveAffordanceAnchor({ symbol: "start" }, ctx);
      expect(out.kind).toBe("unresolved");
      if (out.kind !== "unresolved") return;
      expect(out.status).toBe("error");
      expect(out.code).toBe("anchor_budget_exceeded");
      expect(exec).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });

  it("forwards the exact server routing hint when provided", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx([], { server: "ts-exact" });
    writeTarget(root);
    try {
      const envelope = docSymbolsEnvelope([docSymbol("start", R(1, 0, 1, 5))], {
        server: serverInfo("ts-exact"),
      });
      respond.mockResolvedValueOnce(envelope);
      const out = await resolveAffordanceAnchor({ symbol: "start", path: "src/a.ts" }, ctx);
      expect(out.kind).toBe("resolved");
      if (out.kind !== "resolved") return;
      expect((calls[0]!.req as { server?: string }).server).toBe("ts-exact");
      expect(out.server.descriptorId).toBe("ts-exact");
    } finally {
      done();
    }
  });
});
