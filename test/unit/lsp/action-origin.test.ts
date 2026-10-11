import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runBoundActionOperation, type BoundActionSession } from "../../../src/lsp/lsp-action-origin.js";
import type { ExecutorConnection } from "../../../src/lsp/lsp-executor.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import { captureCodeActionPayload } from "../../../src/lsp/lsp-code-action-payload.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function setup(response: unknown = [{ title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 }]) {
  const dir = await mkdtemp(join(tmpdir(), "action-origin-")); dirs.push(dir);
  const namedPath = join(dir, "source.ts"); const text = "const value = 1;"; await writeFile(namedPath, text); const path = await realpath(namedPath);
  const server = { descriptorId: "ts", name: "tsserver", languageId: "typescript", projectRoot: dir, positionEncoding: "utf-16" as const };
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: path, uri: pathToFileURL(path).href, version: 1, textHash: hash(text), mutationGeneration: 1, submissionStamp: 1,
    syncConfig: { openClose: true, change: "full" }, connectionId: "connection", transportId: "transport", storeId: "store", stateId: "state",
    descriptorId: "ts", projectRoot: dir, positionEncoding: "utf-16",
  };
  const wires: Array<{ method: string; params: unknown }> = [];
  const conn: ExecutorConnection = {
    descriptorId: "ts", name: "tsserver", languageId: "typescript", projectRoot: dir,
    getNegotiatedEncoding: () => "utf-16",
    prepareDocument: async (_path, submitted) => { expect(submitted).toBe(text); return receipt; },
    getDocumentReceipt: () => receipt,
    request: async (method, params) => { wires.push({ method, params }); return response; },
  };
  const session: BoundActionSession = { conn, server, registered: (candidate) => candidate === conn, deadlineMs: Date.now() + 5000 };
  const request = { operation: "codeActions" as const, path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, context: { diagnostics: [] } };
  return { path, text, receipt, wires, session, request };
}

describe("runBoundActionOperation", () => {
  it.each(["cancelled", "timeout"] as const)("withholds the origin when %s arrives during mocked receipt detachment", async (stop) => {
    const f = await setup();
    const action = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 };
    const caller = new AbortController();
    let time = 0;
    let copies = 0;
    const conn: ExecutorConnection = { ...f.session.conn, request: async (method, params) => {
      f.wires.push({ method, params });
      return method === "textDocument/codeAction" ? [action] : action;
    } };
    const session: BoundActionSession = {
      ...f.session, conn, registered: (candidate) => candidate === conn,
      signal: caller.signal, deadlineMs: 10_000, now: () => time,
    };
    const found = await runBoundActionOperation(f.request, session);
    expect(found.envelope.status).toBe("ok");
    const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    Object.defineProperty(f.receipt, "handoffCopyProbe", { enumerable: true, get: () => {
      copies++;
      if (stop === "cancelled") caller.abort(); else time = 10_000;
      return "injected host getter";
    } });
    const result = await runBoundActionOperation({ ...f.request, operation: "resolveCodeAction", selection }, session);
    expect(copies).toBe(1);
    expect(f.wires.at(-1)?.method).toBe("codeAction/resolve");
    expect(result.envelope.status).toBe(stop);
    expect(result.envelope.result).toBeNull();
    expect(result.origin).toBeUndefined();
  });

  it("retains the absolute invocation-time named alias for a relative request", async (test) => {
    const f = await setup();
    const action = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 };
    const namedPath = join(f.session.server.projectRoot, "source.ts");
    const path = relative(process.cwd(), namedPath);
    if (isAbsolute(path)) {
      test.skip(true, "Temporary source and cwd are on different drives");
      return;
    }
    const conn: ExecutorConnection = { ...f.session.conn, request: async (method, params) => {
      f.wires.push({ method, params });
      return method === "textDocument/codeAction" ? [action] : action;
    } };
    const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn };
    const request = { ...f.request, path };
    const found = await runBoundActionOperation(request, session);
    expect(found.envelope.status).toBe("ok");
    const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    const result = await runBoundActionOperation({ ...request, operation: "resolveCodeAction", selection }, session);
    expect(result.envelope.status).toBe("ok");
    expect(f.wires.at(-1)?.method).toBe("codeAction/resolve");
    expect(result.origin?.source.originalPath).toBe(resolve(path));
    expect(result.origin?.source.canonicalPath).toBe(f.path);
  });
  it.each(
    (["codeActions", "empty", "resolveCodeAction"] as const).flatMap((mode) =>
      (["cancelled", "timeout"] as const).map((stop) => ({ mode, stop }))),
  )("clears $mode publication when $stop arrives in the final receipt check", async ({ mode, stop }) => {
    const action = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 };
    const f = await setup();
    const controller = new AbortController();
    let now = 0;
    let armed = false;
    let receiptChecks = 0;
    const finalCheck = mode === "resolveCodeAction" ? 6 : 3;
    const conn: ExecutorConnection = {
      ...f.session.conn,
      getDocumentReceipt: () => {
        if (armed && ++receiptChecks === finalCheck) {
          if (stop === "cancelled") controller.abort();
          else now = 10_000;
        }
        return f.receipt;
      },
      request: async (method, params) => {
        f.wires.push({ method, params });
        return method === "textDocument/codeAction" ? (mode === "empty" ? [] : [action]) : action;
      },
    };
    const session: BoundActionSession = {
      ...f.session, conn, registered: (candidate) => candidate === conn,
      signal: controller.signal, deadlineMs: 10_000, now: () => now,
    };
    let selection: { actionId: string; sourceSha256: string } | undefined;
    if (mode === "resolveCodeAction") {
      const found = await runBoundActionOperation(f.request, session);
      expect(found.envelope.status).toBe("ok");
      const option = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
      selection = { actionId: option.actionId, sourceSha256: option.sourceSha256 };
    }
    armed = true;
    const result = await runBoundActionOperation({
      ...f.request, operation: mode === "resolveCodeAction" ? mode : "codeActions", selection,
    }, session);
    expect(receiptChecks).toBe(finalCheck);
    expect(f.wires.at(-1)?.method).toBe(mode === "resolveCodeAction" ? "codeAction/resolve" : "textDocument/codeAction");
    expect(result.envelope.status).toBe(stop);
    expect(result.envelope.result).toBeNull();
    expect(result.origin).toBeUndefined();
  });
  it("discovers a query-bound identity while preserving the complete candidate and receipt privately", async () => {
    const f = await setup();
    const result = await runBoundActionOperation(f.request, f.session);
    expect(result.envelope.status).toBe("ok");
    expect(f.wires[0]).toMatchObject({ method: "textDocument/codeAction", params: { context: { diagnostics: [] }, range: f.request.range } });
    expect(result.envelope.result).toMatchObject([{ title: "Fix", actionId: expect.any(String), sourceSha256: hash(f.text) }]);
    expect(JSON.stringify(result)).not.toContain("connection");
    expect(result.origin).toBeUndefined();
  });
  it("requires the original source hash and never resolves an action against changed source", async () => {
    const f = await setup();
    const discovered = await runBoundActionOperation(f.request, f.session);
    const actionId = (discovered.envelope.result as Array<{ actionId: string }>)[0]!.actionId;
    await writeFile(f.path, "const value = 2;");
    const result = await runBoundActionOperation({ ...f.request, operation: "resolveCodeAction", selection: { actionId, sourceSha256: hash(f.text) } }, f.session);
    expect(result.envelope.status).toBe("not_ready");
    expect(f.wires.filter((wire) => wire.method === "codeAction/resolve")).toHaveLength(0);
  });
  it("resolves exactly the complete rediscovered payload as the direct wire params", async () => {
    const f = await setup();
    const action = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 };
    const conn: ExecutorConnection = {
      ...f.session.conn,
      request: async (method, params) => {
        f.wires.push({ method, params });
        return method === "textDocument/codeAction" ? [action] : action;
      },
    };
    const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn };
    const found = await runBoundActionOperation(f.request, session);
    const selected = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    const resolved = await runBoundActionOperation({ ...f.request, operation: "resolveCodeAction", selection: selected }, session);
    expect(resolved.envelope.status).toBe("ok");
    expect(f.wires.at(-1)).toEqual({ method: "codeAction/resolve", params: action });
  });
  it("captures detached raw actions, source/query binding, and a mocked submitted receipt privately on resolve", async () => {
    const f = await setup();
    const original = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, diagnostics: [{ message: "original" }], vendor: { flag: true } };
    const resolvedAction = { ...original, edit: { changes: { [pathToFileURL(f.path).href]: [{ range: f.request.range, newText: "fixed" }] } } };
    const conn: ExecutorConnection = { ...f.session.conn, request: async (method, params) => {
      f.wires.push({ method, params });
      return method === "textDocument/codeAction" ? [original] : resolvedAction;
    } };
    const context = { diagnostics: [{ message: "query diagnostic" }] };
    const request = { ...f.request, context };
    const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn };
    const found = await runBoundActionOperation(request, session);
    const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    const result = await runBoundActionOperation({ ...request, operation: "resolveCodeAction", selection }, session);
    expect(result.envelope.status).toBe("ok");
    expect(result.origin).toMatchObject({
      source: { originalPath: f.path, canonicalPath: f.path, rawSha256: hash(f.text), textSha256: hash(f.text) },
      query: { range: request.range, context },
      selection: { actionId: selection.actionId, rawSha256: hash(f.text) },
      server: f.session.server,
      receipt: f.receipt,
      originalAction: original,
      resolvedAction,
    });
    expect(Object.isFrozen(result.origin)).toBe(true);
    expect(Object.isFrozen(result.origin?.receipt.syncConfig)).toBe(true);
    expect(Object.isFrozen(result.origin?.resolvedAction)).toBe(true);
    expect(Object.isFrozen((result.origin?.resolvedAction as { edit: { changes: Record<string, unknown> } }).edit.changes)).toBe(true);
    original.diagnostics[0]!.message = "mutated original";
    resolvedAction.edit.changes[pathToFileURL(f.path).href]![0]!.newText = "mutated response";
    context.diagnostics[0]!.message = "mutated query";
    Reflect.set(f.receipt.syncConfig, "change", "none");
    expect(result.origin?.originalAction).toMatchObject({ diagnostics: [{ message: "original" }] });
    expect(result.origin?.resolvedAction).toMatchObject({ edit: { changes: { [pathToFileURL(f.path).href]: [{ newText: "fixed" }] } }, diagnostics: [{ message: "original" }], vendor: { flag: true } });
    expect(result.origin?.query.context).toMatchObject({ diagnostics: [{ message: "query diagnostic" }] });
    expect(result.origin?.receipt.syncConfig.change).toBe("full");
    expect(result.envelope.result).not.toHaveProperty("vendor");
  });
  it("refuses commands, disabled actions, and incomplete over-cap coverage", async () => {
    for (const response of [[{ title: "Run", command: "execute" }], [{ title: "Disabled", disabled: { reason: "not safe" } }], Array.from({ length: 101 }, () => ({ title: "Fix" }))]) {
      const f = await setup(response);
      const result = await runBoundActionOperation(f.request, f.session);
      expect(result.envelope.status).toBe("unavailable");
      expect(result.envelope.result).toBeNull();
    }
  });
  it("checks the source again after rediscovery before publishing candidates", async () => {
    const f = await setup();
    const conn: ExecutorConnection = {
      ...f.session.conn,
      request: async (method, params) => {
        f.wires.push({ method, params });
        await writeFile(f.path, "changed during discovery");
        return [{ title: "Fix" }];
      },
    };
    const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn };
    const result = await runBoundActionOperation(f.request, session);
    expect(result.envelope.status).toBe("not_ready");
    expect(result.envelope.result).toBeNull();
  });
  it("requires positive live registration before preparation", async () => {
    const f = await setup();
    const session = { ...f.session, registered: () => false };
    const result = await runBoundActionOperation(f.request, session);
    expect(result.envelope.status).toBe("unavailable");
    expect(f.wires).toHaveLength(0);
  });
  it("accepts the production plural languageIds connection shape", async () => {
    const f = await setup();
    const { languageId: _ignored, ...base } = f.session.conn;
    const conn: ExecutorConnection = { ...base, languageIds: ["typescript"] };
    const result = await runBoundActionOperation(f.request, { ...f.session, conn, registered: (candidate) => candidate === conn });
    expect(result.envelope.status).toBe("ok");
    expect(f.wires).toHaveLength(1);
  });
  it("withdraws an in-flight deadline-expired request with its owned signal", async () => {
    const f = await setup();
    let now = 100;
    const controller = new AbortController();
    const callerSignal = controller.signal;
    let requestSignal: AbortSignal | undefined;
    let settle!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let underlying!: Promise<unknown>;
    const conn: ExecutorConnection = {
      ...f.session.conn,
      request: (_method, _params, opts) => {
        requestSignal = opts?.signal;
        underlying = new Promise((_resolve, reject) => {
          settle = () => reject(new Error("request withdrawn"));
          requestSignal?.addEventListener("abort", () => { settle(); }, { once: true });
        });
        entered();
        now = 110;
        return underlying;
      },
    };
    const resultPromise = runBoundActionOperation(f.request, { ...f.session, conn, registered: (candidate) => candidate === conn, signal: callerSignal, deadlineMs: 110, now: () => now });
    try {
      await enteredPromise;
      const result = await resultPromise;
      expect(result.envelope.status).toBe("timeout");
      expect(requestSignal?.aborted).toBe(true);
      expect(callerSignal.aborted).toBe(false);
    } finally {
      settle?.();
      await underlying?.catch(() => undefined);
      await resultPromise;
    }
  });
  it("refuses a resolve response that changes fields from the selected payload", async () => {
    const f = await setup();
    const original = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 };
    const changed = { ...original, title: "Changed", edit: { changes: {
      [pathToFileURL(f.path).href]: [{ range: f.request.range, newText: "fixed" }],
    } } };
    expect(captureCodeActionPayload(changed).ok).toBe(true);
    const conn: ExecutorConnection = { ...f.session.conn, request: async (method, params) => {
      f.wires.push({ method, params });
      return method === "textDocument/codeAction" ? [original] : changed;
    } };
    const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn };
    const found = await runBoundActionOperation(f.request, session);
    const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    const resolved = await runBoundActionOperation({ ...f.request, operation: "resolveCodeAction", selection }, session);
    expect(f.wires.filter((wire) => wire.method === "codeAction/resolve")).toHaveLength(1);
    expect(resolved.envelope.status).not.toBe("ok");
    expect(resolved.envelope.result).toBeNull();
  });
  it("accepts a new edit while preserving the selected action fields", async () => {
    const f = await setup();
    const original = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 };
    const resolvedAction = { ...original, edit: { changes: { [pathToFileURL(f.path).href]: [{ range: f.request.range, newText: "fixed" }] } } };
    const conn: ExecutorConnection = { ...f.session.conn, request: async (method, params) => {
      f.wires.push({ method, params });
      return method === "textDocument/codeAction" ? [original] : resolvedAction;
    } };
    const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn };
    const found = await runBoundActionOperation(f.request, session);
    const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    const resolved = await runBoundActionOperation({ ...f.request, operation: "resolveCodeAction", selection }, session);
    expect(resolved.envelope.status).toBe("ok");
    expect(resolved.envelope.result).toMatchObject({ title: "Fix", data: original.data, edit: expect.anything() });
    expect(f.wires.at(-1)).toEqual({ method: "codeAction/resolve", params: original });
  });
  it("rejects resolve mutations to opaque data and unknown vendor fields", async () => {
    const f = await setup();
    const original = { title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 };
    for (const changed of [{ ...original, data: { opaque: "changed" } }, { ...original, vendor: 8 }]) {
      const conn: ExecutorConnection = { ...f.session.conn, request: async (method, params) => {
        f.wires.push({ method, params });
        return method === "textDocument/codeAction" ? [original] : { ...changed, edit: { changes: { [pathToFileURL(f.path).href]: [{ range: f.request.range, newText: "fixed" }] } } };
      } };
      const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn };
      const found = await runBoundActionOperation(f.request, session);
      const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
      const resolved = await runBoundActionOperation({ ...f.request, operation: "resolveCodeAction", selection }, session);
      expect(resolved.envelope.status).not.toBe("ok");
      expect(resolved.envelope.result).toBeNull();
    }
  });
  it("sends the default empty diagnostics context when context is omitted", async () => {
    const f = await setup();
    const { context: _context, ...request } = f.request;
    const result = await runBoundActionOperation(request, f.session);
    expect(result.envelope.status).toBe("ok");
    expect(f.wires[0]).toMatchObject({ method: "textDocument/codeAction", params: { context: { diagnostics: [] } } });
  });
  it("rejects a rebound original symlink alias before resolve dispatch", async ({ skip }) => {
    const f = await setup();
    const alias = join(dirname(f.path), "alias.ts");
    const second = join(dirname(f.path), "other.ts");
    await writeFile(second, f.text);
    try { await symlink(f.path, alias); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") skip(`symlink creation is not permitted (${code})`);
      throw error;
    }
    const request = { ...f.request, path: alias };
    let discoveryCalls = 0;
    const conn: ExecutorConnection = { ...f.session.conn, request: async (method, params) => {
      f.wires.push({ method, params });
      if (method === "textDocument/codeAction" && ++discoveryCalls === 2) {
        await rm(alias);
        await symlink(second, alias);
      }
      return method === "textDocument/codeAction" ? [{ title: "Fix", kind: "quickfix", data: { opaque: "kept" }, vendor: 7 }] : { title: "Fix" };
    } };
    const session = { ...f.session, conn, registered: (candidate: ExecutorConnection) => candidate === conn };
    const found = await runBoundActionOperation(request, session);
    const selection = (found.envelope.result as Array<{ actionId: string; sourceSha256: string }>)[0]!;
    const resolved = await runBoundActionOperation({ ...request, operation: "resolveCodeAction", selection }, session);
    expect(resolved.envelope.status).not.toBe("ok");
    expect(f.wires.filter((wire) => wire.method === "codeAction/resolve")).toHaveLength(0);
    expect(discoveryCalls).toBe(2);
  });
  it("refuses oversized complete identity without throwing for an individually valid payload", async () => {
    const f = await setup();
    const payload = { title: "Fix", data: "x".repeat(48 * 1024 - 100) };
    expect(captureCodeActionPayload(payload).ok).toBe(true);
    const conn: ExecutorConnection = { ...f.session.conn, request: async (method, params) => {
      f.wires.push({ method, params });
      return [payload];
    } };
    const result = await runBoundActionOperation(f.request, {
      ...f.session, conn, registered: (candidate) => candidate === conn,
    });
    expect(f.wires).toHaveLength(1);
    expect(result.envelope.status).toBe("unavailable");
    expect(result.envelope.result).toBeNull();
  });
});
