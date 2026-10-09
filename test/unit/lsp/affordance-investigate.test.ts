import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { investigateAffordanceTarget } from "../../../src/lsp/affordance-investigate.js";
import type {
  AffordanceExecContext,
  AffordanceInvestigateInput,
} from "../../../src/lsp/affordance-contract.js";
import type { StrictEnvelope } from "../../../src/lsp/lsp-strict-contract.js";

const R = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

function serverInfo(descriptorId = "ts", encoding: "utf-8" | "utf-16" | "utf-32" = "utf-16") {
  return { descriptorId, name: descriptorId, languageId: "typescript", projectRoot: "/repo", positionEncoding: encoding };
}

function envelope(op: StrictEnvelope["operation"], result: unknown, over: Partial<StrictEnvelope> = {}): StrictEnvelope {
  return {
    status: "ok",
    operation: op,
    method: `test/${op}`,
    server: serverInfo(),
    result,
    meta: { truncated: false },
    ...over,
  };
}

function docSymbolsOk(names: string[], over: Partial<StrictEnvelope> = {}): StrictEnvelope {
  return envelope(
    "documentSymbols",
    names.map((name, i) => ({
      name,
      kind: 12,
      range: R(0, 0, 20, 0),
      selectionRange: R(i + 1, 4, i + 1, 4 + name.length),
      selectionProvenance: "explicit",
    })),
    over,
  );
}

function fakeCtx(over: Partial<AffordanceExecContext> = {}) {
  const calls: Array<{ req: unknown; deps: unknown }> = [];
  const respond = vi.fn(async (_req: unknown, _deps: unknown): Promise<StrictEnvelope> => {
    throw new Error("fake executor out of script");
  });
  const exec = vi.fn(async (req: unknown, deps: unknown) => {
    calls.push({ req, deps });
    return respond(req, deps);
  });
  const root = mkdtempSync(join(tmpdir(), "investigate-"));
  const ctx: AffordanceExecContext = {
    root,
    budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 15000 },
    exec: exec as never,
    ...over,
  };
  return { ctx, calls, exec, respond, root, done: () => rmSync(root, { recursive: true, force: true }) };
}

function writeTarget(root: string, rel = "src/a.ts", content = "export function start() {}\n"): string {
  const abs = join(root, rel);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function locationFor(root: string, rel: string, line = 5) {
  return { uri: pathToFileURL(join(root, rel)).href, range: R(line, 0, line, 5) };
}

describe("investigate — input validation (caller errors, no dispatch)", () => {
  it("rejects symbol+position mixing, missing targets, foreign fields, unknown tasks", async () => {
    const { ctx, exec, done } = fakeCtx();
    try {
      const bad: AffordanceInvestigateInput[] = [
        { operation: "investigate", task: "definition", path: "src/a.ts", position: { line: 0, character: 0 }, symbol: "start" },
        { operation: "investigate", task: "references" },
        { operation: "investigate", task: "definition", path: "src/a.ts" },
        { operation: "investigate", task: "nope" as never, path: "src/a.ts", position: { line: 0, character: 0 } },
        { operation: "investigate", task: "type", path: "src/a.ts", position: { line: 0, character: 0 }, limit: 5 } as never,
      ];
      for (const input of bad) {
        await expect(investigateAffordanceTarget(input, ctx)).rejects.toThrow();
      }
      expect(exec).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });

  it("rejects escaping or missing scope before any server request", async () => {
    const { ctx, exec, root, done } = fakeCtx();
    writeTarget(root);
    try {
      await expect(
        investigateAffordanceTarget(
          { operation: "investigate", task: "definition", path: "src/a.ts", position: { line: 1, character: 4 }, scope: "../outside" },
          ctx,
        ),
      ).rejects.toThrow(/scope/);
      await expect(
        investigateAffordanceTarget(
          { operation: "investigate", task: "definition", path: "src/a.ts", position: { line: 1, character: 4 }, scope: "src/nope" },
          ctx,
        ),
      ).rejects.toThrow(/scope/);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });
});

describe("investigate — single-dispatch recipes", () => {
  it.each([
    ["definition", "goToDefinition"],
    ["type", "hover"],
    ["references", "findReferences"],
    ["implementations", "goToImplementation"],
  ] as const)("recipe %s dispatches strict %s with verbatim step envelope", async (task, op) => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    const abs = writeTarget(root);
    try {
      const result = [locationFor(root, "src/a.ts")];
      const env = envelope(op, result);
      respond.mockResolvedValueOnce(env);
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task, path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      expect(out.status).toBe("ok");
      expect(calls).toHaveLength(1);
      const req = calls[0]!.req as Record<string, unknown>;
      expect(req.operation).toBe(op);
      expect(req.path).toBe(realpathSync(abs));
      expect(req.position).toEqual({ line: 1, character: 4 });
      expect(out.steps).toHaveLength(1);
      expect(out.steps[0]!.envelope).toBe(env);
      expect(out.steps[0]!.id).toBe(`investigate.${task}`);
    } finally {
      done();
    }
  });

  it("references excludes declarations via includeDeclaration:false", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      respond.mockResolvedValueOnce(envelope("findReferences", []));
      await investigateAffordanceTarget(
        { operation: "investigate", task: "references", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      expect((calls[0]!.req as { includeDeclaration?: boolean }).includeDeclaration).toBe(false);
    } finally {
      done();
    }
  });

  it("propagates strict failure truthfully with verbatim envelope (never sole empty success)", async () => {
    const { ctx, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      const env = envelope("goToDefinition", null, {
        status: "unsupported",
        error: { code: "unsupported", message: "no capability" },
      });
      respond.mockResolvedValueOnce(env);
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "definition", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      expect(out.status).toBe("unsupported");
      expect(out.steps).toHaveLength(1);
      expect(out.steps[0]!.envelope).toBe(env);
      expect((out.result as { code?: string }).code).toBe("unsupported");
    } finally {
      done();
    }
  });

  it("truncates the rendered projection at 100 items while keeping the full envelope", async () => {
    const { ctx, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      const many = Array.from({ length: 140 }, (_, i) => locationFor(root, "src/a.ts", i));
      const env = envelope("findReferences", many);
      respond.mockResolvedValueOnce(env);
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "references", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      expect(out.status).toBe("ok");
      const result = out.result as { items: unknown[]; count: number; truncated: boolean };
      expect(result.count).toBe(140);
      expect(result.items.length).toBeLessThanOrEqual(100);
      expect(result.truncated).toBe(true);
      expect(out.steps[0]!.envelope.result).toBe(many);
    } finally {
      done();
    }
  });

  it("passes positions through verbatim under utf-8/16/32 server encodings", async () => {
    for (const enc of ["utf-8", "utf-16", "utf-32"] as const) {
      const { ctx, calls, respond, root, done } = fakeCtx();
      writeTarget(root, "src/a.ts", "export const café = '☃️';\n");
      try {
        respond.mockResolvedValueOnce(envelope("hover", { contents: "x" }, { server: serverInfo("ts", enc) }));
        const pos = { line: 0, character: 15 };
        const out = await investigateAffordanceTarget(
          { operation: "investigate", task: "type", path: "src/a.ts", position: pos },
          ctx,
        );
        expect(out.status).toBe("ok");
        expect((calls[0]!.req as { position: unknown }).position).toEqual(pos);
      } finally {
        done();
      }
    }
  });
});

describe("investigate — declaration anchors", () => {
  it("resolves symbol+path then dispatches at the selectionRange start under one budget", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    const abs = writeTarget(root);
    try {
      respond.mockResolvedValueOnce(docSymbolsOk(["start"]));
      const loc = locationFor(root, "src/a.ts");
      const dispatchEnv = envelope("goToDefinition", [loc]);
      respond.mockResolvedValueOnce(dispatchEnv);
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "definition", symbol: "start", path: "src/a.ts" },
        ctx,
      );
      expect(out.status).toBe("ok");
      expect(calls).toHaveLength(2);
      expect((calls[0]!.req as { operation: string }).operation).toBe("documentSymbols");
      const dispatchReq = calls[1]!.req as { operation: string; path: string; position: unknown };
      expect(dispatchReq.operation).toBe("goToDefinition");
      expect(dispatchReq.path).toBe(realpathSync(abs));
      expect(dispatchReq.position).toEqual({ line: 1, character: 4 });
      expect(out.steps.map((s) => s.id)).toEqual(["anchor.resolve", "investigate.definition"]);
      expect(out.steps[0]!.envelope.operation).toBe("documentSymbols");
      expect(out.steps[1]!.envelope).toBe(dispatchEnv);
    } finally {
      done();
    }
  });

  it("propagates anchor ambiguity without dispatching the recipe", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      const syms = Array.from({ length: 3 }, (_, i) => ({
        name: "start", kind: 12, range: R(0, 0, 20, 0),
        selectionRange: R(i, 0, i, 5), selectionProvenance: "explicit",
      }));
      const env = envelope("documentSymbols", syms);
      respond.mockResolvedValueOnce(env);
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "references", symbol: "start", path: "src/a.ts" },
        ctx,
      );
      expect(out.status).toBe("ambiguous");
      expect((out.result as { code?: string }).code).toBe("ambiguous_anchor");
      expect(calls).toHaveLength(1);
      expect(out.steps[0]!.envelope).toBe(env);
    } finally {
      done();
    }
  });

  it("never auto-dispatches pathless discovery (not_ready + verbatim envelope)", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    try {
      const uri = pathToFileURL(join(root, "src/a.ts")).href;
      const env = envelope("workspaceSymbols", [{ name: "start", kind: 12, uri }], {
        server: { ...serverInfo(), descriptorId: "unknown" },
      });
      respond.mockResolvedValueOnce(env);
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "references", symbol: "start" },
        ctx,
      );
      expect(out.status).toBe("not_ready");
      expect((out.result as { code?: string }).code).toBe("anchor_search_incomplete");
      expect(calls).toHaveLength(1);
      expect((calls[0]!.req as { operation: string }).operation).toBe("workspaceSymbols");
      expect(out.steps[0]!.envelope).toBe(env);
    } finally {
      done();
    }
  });

  it("reports observed staleness between resolution and dispatch as stale_anchor", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    const abs = writeTarget(root);
    try {
      respond.mockImplementationOnce(async () => {
        // Mid-flight edit between resolution lookup and recipe dispatch.
        writeFileSync(abs, "export function start() { /* changed */ }\n");
        return docSymbolsOk(["start"]);
      });
      respond.mockResolvedValueOnce(envelope("goToDefinition", []));
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "definition", symbol: "start", path: "src/a.ts" },
        ctx,
      );
      expect(out.status).toBe("error");
      expect((out.result as { code?: string }).code).toBe("stale_anchor");
      // Resolution envelope is retained; no dispatch followed the stale read.
      expect(out.steps).toHaveLength(1);
      expect(out.steps[0]!.id).toBe("anchor.resolve");
      expect(calls).toHaveLength(1);
    } finally {
      done();
    }
  });

  it("shares one 6-request budget across anchor resolution and recipe dispatch", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx({
      budget: { maxCandidates: 100, maxRequests: 1, deadlineMs: 15000 },
    });
    writeTarget(root);
    try {
      respond.mockResolvedValue(docSymbolsOk(["start"]));
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "definition", symbol: "start", path: "src/a.ts" },
        ctx,
      );
      // Anchor consumed the single request; dispatch admission fails closed.
      expect(calls).toHaveLength(1);
      expect(out.steps.map((s) => s.id)).toEqual(["anchor.resolve"]);
      expect(out.status).toBe("error");
      expect((out.result as { message?: string }).message).toMatch(/budget exhausted/);
    } finally {
      done();
    }
  });

  it("preserves the exact negotiated-encoding server identity on dispatch", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      respond.mockResolvedValueOnce(docSymbolsOk(["start"], { server: serverInfo("ts-exact", "utf-8") }));
      respond.mockResolvedValueOnce(envelope("hover", { contents: "t" }, { server: serverInfo("ts-exact", "utf-8") }));
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "type", symbol: "start", path: "src/a.ts" },
        ctx,
      );
      expect(out.status).toBe("ok");
      expect((calls[1]!.req as { server?: string }).server).toBe("ts-exact");
      expect((calls[1]!.req as { position: unknown }).position).toEqual({ line: 1, character: 4 });
    } finally {
      done();
    }
  });
});

describe("investigate — callers recipe", () => {
  it("queries incomingCalls for EVERY prepared item with exact opaque items (max 3)", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      const items = [0, 1, 2, 3].map((i) => ({ id: `h${i}`, data: { n: i }, uri: pathToFileURL(join(root, "src/a.ts")).href }));
      respond.mockResolvedValueOnce(envelope("prepareCallHierarchy", items));
      for (let i = 0; i < 3; i += 1) {
        respond.mockResolvedValueOnce(envelope("incomingCalls", [{ from: items[i], fromRanges: [] }]));
      }
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "callers", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      expect(out.status).toBe("ok");
      expect(calls).toHaveLength(4);
      expect((calls[0]!.req as { operation: string }).operation).toBe("prepareCallHierarchy");
      for (let i = 0; i < 3; i += 1) {
        const req = calls[i + 1]!.req as { operation: string; item: unknown };
        expect(req.operation).toBe("incomingCalls");
        expect(req.item).toBe(items[i]);
      }
      const result = out.result as { prepared: number; queried: number; count: number };
      expect(result.prepared).toBe(4);
      expect(result.queried).toBe(3);
      expect(result.count).toBe(3);
    } finally {
      done();
    }
  });

  it("keeps partial incoming evidence on degraded steps (never sole empty success)", async () => {
    const { ctx, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      const items = [{ id: "h0" }, { id: "h1" }];
      respond.mockResolvedValueOnce(envelope("prepareCallHierarchy", items));
      respond.mockResolvedValueOnce(envelope("incomingCalls", [{ from: items[0] }]));
      respond.mockResolvedValueOnce(envelope("incomingCalls", null, {
        status: "unsupported",
        error: { code: "unsupported", message: "nope" },
      }));
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "callers", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      expect(out.status).toBe("unsupported");
      expect((out.result as { partial?: boolean }).partial).toBe(true);
      expect(out.steps).toHaveLength(3);
    } finally {
      done();
    }
  });
});

describe("investigate — scope filter and budgets", () => {
  it("filters result locations to a canonical directory scope, counting the rest", async () => {
    const { ctx, respond, root, done } = fakeCtx();
    writeTarget(root, "src/a.ts");
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "other", "b.ts"), "export const x = 1;\n");
    try {
      const result = [locationFor(root, "src/a.ts"), locationFor(root, "other/b.ts")];
      respond.mockResolvedValueOnce(envelope("findReferences", result));
      const out = await investigateAffordanceTarget(
        {
          operation: "investigate", task: "references",
          path: "src/a.ts", position: { line: 1, character: 4 }, scope: "other",
        },
        ctx,
      );
      expect(out.status).toBe("ok");
      const res = out.result as { count: number; filteredOutByScope: number };
      expect(res.count).toBe(1);
      expect(res.filteredOutByScope).toBe(1);
      // Full envelope stays verbatim in steps.
      expect((out.steps[0]!.envelope.result as unknown[]).length).toBe(2);
    } finally {
      done();
    }
  });

  it("honours mid-flight cancellation with retained steps", async () => {
    const controller = new AbortController();
    const { ctx, respond, root, done } = fakeCtx({
      budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 15000, signal: controller.signal },
    });
    writeTarget(root);
    try {
      const items = [{ id: "h0" }, { id: "h1" }];
      respond.mockImplementationOnce(async () => {
        controller.abort();
        return envelope("prepareCallHierarchy", items);
      });
      respond.mockResolvedValue(envelope("incomingCalls", []));
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "callers", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      expect(out.status).toBe("cancelled");
      expect(out.steps.length).toBeGreaterThanOrEqual(1);
    } finally {
      done();
    }
  });

  it("RED: anchor lookup forwards the remaining aggregate time as strict timeoutMs", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      respond.mockResolvedValueOnce(docSymbolsOk(["start"]));
      respond.mockResolvedValueOnce(envelope("goToDefinition", []));
      await investigateAffordanceTarget(
        { operation: "investigate", task: "definition", symbol: "start", path: "src/a.ts" },
        ctx,
      );
      const anchorReq = calls[0]!.req as Record<string, unknown>;
      expect(anchorReq.operation).toBe("documentSymbols");
      expect(typeof anchorReq.timeoutMs).toBe("number");
      expect(anchorReq.timeoutMs as number).toBeLessThanOrEqual(15000);
      expect(anchorReq.timeoutMs as number).toBeGreaterThan(0);
    } finally {
      done();
    }
  });

  it("RED: anchor lookup honours a tiny caller timeout cap instead of the full aggregate", async () => {
    const { ctx, calls, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      respond.mockResolvedValueOnce(docSymbolsOk(["start"]));
      respond.mockResolvedValueOnce(envelope("goToDefinition", []));
      await investigateAffordanceTarget(
        { operation: "investigate", task: "definition", symbol: "start", path: "src/a.ts", timeoutMs: 50 },
        ctx,
      );
      const anchorReq = calls[0]!.req as Record<string, unknown>;
      expect(anchorReq.timeoutMs as number).toBeLessThanOrEqual(50);
    } finally {
      done();
    }
  });

  it("RED: consumed aggregate time shrinks the anchor strict timeout (no fresh 15s)", async () => {
    // Engine sequence: investigate captures `started` on the first now()
    // call, then computes the anchor timeout from remaining time at dispatch
    // (investigate-affordance `resolveSymbolTarget` exec wrapper). Advancing
    // inside the executor mock would be too late (timeout already stamped),
    // so the deterministic clock advances BEFORE anchor dispatch: first read
    // fixes `started`, every later read observes consumed aggregate time.
    const START = 1000;
    const CONSUMED = 14000;
    let reads = 0;
    const { ctx, calls, respond, root, done } = fakeCtx({
      now: () => {
        reads += 1;
        return reads === 1 ? START : START + CONSUMED;
      },
      budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 15000 },
    });
    writeTarget(root);
    try {
      respond.mockResolvedValueOnce(docSymbolsOk(["start"]));
      respond.mockResolvedValueOnce(envelope("goToDefinition", []));
      await investigateAffordanceTarget(
        { operation: "investigate", task: "definition", symbol: "start", path: "src/a.ts" },
        ctx,
      );
      const anchorReq = calls[0]!.req as Record<string, unknown>;
      // Remaining at dispatch is 15000 - 14000 = 1000, not a fresh 15000.
      // A reset/missing-timeout mutant would stamp 15000 (or nothing) here.
      expect(anchorReq.operation).toBe("documentSymbols");
      expect(typeof anchorReq.timeoutMs).toBe("number");
      expect(anchorReq.timeoutMs).toBe(1000);
      expect(anchorReq.timeoutMs as number).toBeLessThan(15000);
      expect(anchorReq.timeoutMs as number).toBeGreaterThan(0);
    } finally {
      done();
    }
  });

  it("RED: caller hierarchy over 3 prepared items is truncated with an omission count", async () => {
    const { ctx, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      const items = [0, 1, 2, 3, 4].map((i) => ({ id: `h${i}`, uri: pathToFileURL(join(root, "src/a.ts")).href }));
      respond.mockResolvedValueOnce(envelope("prepareCallHierarchy", items));
      for (let i = 0; i < 3; i += 1) {
        respond.mockResolvedValueOnce(envelope("incomingCalls", []));
      }
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "callers", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      const result = out.result as { truncated?: boolean; partial?: boolean; omittedPrepared?: number; prepared?: number; queried?: number };
      expect(result.prepared).toBe(5);
      expect(result.queried).toBe(3);
      expect(result.omittedPrepared).toBe(2);
      expect(result.truncated).toBe(true);
      expect(result.partial).toBe(true);
    } finally {
      done();
    }
  });

  it("RED: unicode payload that fits in chars but exceeds bytes is truncated (envelope intact)", async () => {
    const { ctx, respond, root, done } = fakeCtx();
    writeTarget(root);
    try {
      // One entry: ~40000 UTF-16 units but ~80000 UTF-8 bytes (non-BMP).
      // Char-length fits the 48KiB bound; byte-length exceeds it.
      const note = "\u{1F600}".repeat(20000);
      const many = [{
        uri: pathToFileURL(join(root, "src/a.ts")).href,
        range: R(0, 0, 0, 1),
        note,
      }];
      const fullChars = (JSON.stringify(many) ?? "").length;
      const fullBytes = Buffer.byteLength(JSON.stringify(many) ?? "", "utf8");
      expect(fullChars).toBeLessThanOrEqual(48 * 1024);
      expect(fullBytes).toBeGreaterThan(48 * 1024);
      const env = envelope("findReferences", many);
      respond.mockResolvedValueOnce(env);
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "references", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      void fullChars;
      const result = out.result as { items: unknown[]; truncated: boolean };
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result.items) ?? "", "utf8")).toBeLessThanOrEqual(48 * 1024);
      expect((out.steps[0]!.envelope.result as unknown[]).length).toBe(1);
    } finally {
      done();
    }
  });

  it("enforces the aggregate deadline without dispatch", async () => {
    const { ctx, exec, root, done } = fakeCtx({
      budget: { maxCandidates: 100, maxRequests: 6, deadlineMs: 0 },
    });
    writeTarget(root);
    try {
      const out = await investigateAffordanceTarget(
        { operation: "investigate", task: "definition", path: "src/a.ts", position: { line: 1, character: 4 } },
        ctx,
      );
      expect(out.status).toBe("timeout");
      expect(exec).not.toHaveBeenCalled();
    } finally {
      done();
    }
  });
});
