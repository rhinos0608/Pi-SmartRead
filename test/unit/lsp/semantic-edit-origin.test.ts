import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBoundSemanticEdit, type BoundSemanticEditPacket } from "../../../src/lsp/lsp-semantic-edit-origin.js";
import type { BoundActionStageResult } from "../../../src/lsp/lsp-action-continuation.js";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import type { BoundSessionLease } from "../../../src/lsp/lsp-manager.js";
import type { StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";
import { ACTION_SEMANTIC_EDIT_MAX_BYTES } from "../../../src/lsp/lsp-action-source.js";
import { ACTION_SERIALIZED_EDIT_MAX_BYTES } from "../../../src/lsp/lsp-action-json.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const staged: BoundActionStageResult = { kind: "staged", proposal: { proposalId: "proposal-1", files: ["/x"], diff: "diff" } };
const editAt = (newText: string) => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface FixtureOptions {
  readonly content?: string | Buffer;
  readonly encoding?: "utf-8" | "utf-16";
  readonly reply?: (uri: string) => unknown;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(options: FixtureOptions = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "semantic-edit-"));
  roots.push(temporaryRoot);
  const root = await realpath(temporaryRoot);
  const namedPath = join(root, "source.ts");
  const content = options.content ?? "const value = 1;";
  await writeFile(namedPath, content);
  const path = await realpath(namedPath);
  const text = typeof content === "string" ? content : content.toString("latin1");
  const uri = pathToFileURL(path).href;
  const encoding = options.encoding ?? "utf-16";
  const descriptorId = "typescript-language-server";
  const registration = Object.freeze({ descriptorId, name: "TypeScript", projectRoot: root, languageIds: Object.freeze(["typescript"]), positionEncoding: encoding });
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: path, uri, version: 1, textHash: hash(content), mutationGeneration: 1, submissionStamp: 1,
    syncConfig: { openClose: true, change: "full" }, connectionId: "connection-secret", transportId: "transport-secret", storeId: "store-secret", stateId: "state-secret",
    descriptorId, projectRoot: root, positionEncoding: encoding,
  };
  const wires: Array<{ method: string; params: unknown; signal?: AbortSignal }> = [];
  const prepares: Array<{ path: string; submitted: string | undefined }> = [];
  const conn = new LSPConnection();
  conn.descriptorId = descriptorId;
  conn.name = registration.name;
  conn.projectRoot = root;
  conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue(encoding);
  vi.spyOn(conn, "prepareDocument").mockImplementation(async (filePath, submitted) => {
    prepares.push({ path: filePath, submitted });
    return receipt;
  });
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  const reply = options.reply ?? (() => [editAt("let")]);
  vi.spyOn(conn, "request").mockImplementation(async (method, params, requestOptions) => {
    wires.push({ method, params, signal: requestOptions?.signal });
    return reply(uri);
  });
  const release = vi.fn();
  const current = vi.fn(() => true);
  const lease: BoundSessionLease = { conn, key: "opaque-lease-key", registration, isCurrent: current, release };
  const route = { projectRoot: root, languageId: "typescript", server: descriptorId };
  const acquire = vi.fn(async () => lease);
  const stage = vi.fn(async (_packet: BoundSemanticEditPacket): Promise<BoundActionStageResult> => staged);
  const formatRequest: StrictRequest = { operation: "formatDocument", path };
  return { root, path, uri, text, content, conn, receipt, wires, prepares, lease, release, current, route, acquire, stage, formatRequest, deadlineMs: Date.now() + 60_000 };
}

const renameReply = (uri: string) => ({ changes: { [uri]: [editAt("renamed")] } });
const renameRequest = (f: Fixture): StrictRequest => ({ operation: "rename", path: f.path, position: { line: 0, character: 6 }, newName: "renamed" });

async function run(f: Fixture, request: StrictRequest, extra: Partial<Parameters<typeof executeBoundSemanticEdit>[2]> = {}) {
  return executeBoundSemanticEdit(request, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire, stage: f.stage, ...extra });
}

describe("executeBoundSemanticEdit", () => {
  it("stages a rename after exactly one wire request with only the mandatory packet fields", async () => {
    const f = await fixture({ reply: renameReply });
    const outcome = await run(f, renameRequest(f));
    expect(f.wires).toHaveLength(1);
    expect(f.wires[0]).toMatchObject({ method: "textDocument/rename", params: { textDocument: { uri: f.uri }, position: { line: 0, character: 6 }, newName: "renamed" } });
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    expect(outcome.proposal).toEqual(staged.kind === "staged" ? staged.proposal : undefined);
    expect(outcome.envelope).toMatchObject({ status: "ok", operation: "rename", method: "textDocument/rename" });
    expect(f.stage).toHaveBeenCalledTimes(1);
    const packet = f.stage.mock.calls[0]![0];
    expect(packet).toMatchObject({
      operation: "rename",
      document: { canonicalPath: f.path, sha256: hash(f.content) },
      serverDescriptor: { descriptorId: "typescript-language-server", positionEncoding: "utf-16" },
      deadlineMs: f.deadlineMs,
    });
    expect(packet.prepared.fileEdits).toEqual([{ filePath: f.path, edits: [expect.objectContaining({ filePath: f.path, newText: "renamed" })] }]);
    expect(typeof packet.now).toBe("function");
    expect(packet.ownedSignal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(packet).sort()).toEqual(["deadlineMs", "document", "now", "operation", "ownedSignal", "prepared", "serverDescriptor"]);
    expect(f.release).toHaveBeenCalledTimes(1);
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it.each([
    ["formatDocument", {}, "textDocument/formatting", {}],
    ["formatRange", { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }, "textDocument/rangeFormatting", { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }],
    ["formatOnType", { position: { line: 0, character: 3 }, ch: ";" }, "textDocument/onTypeFormatting", { position: { line: 0, character: 3 }, ch: ";" }],
  ] as const)("stages %s with executor-identical wire params and one request", async (operation, fields, method, extraParams) => {
    const f = await fixture();
    const outcome = await run(f, { operation, path: f.path, ...fields, formatting: { tabSize: 4, insertSpaces: false } });
    expect(f.wires).toEqual([expect.objectContaining({ method, params: { textDocument: { uri: f.uri }, ...extraParams, options: { tabSize: 4, insertSpaces: false } } })]);
    expect(outcome.kind === "result" && outcome.proposal?.proposalId).toBe("proposal-1");
    expect(f.stage.mock.calls[0]![0]).toMatchObject({ operation, document: { canonicalPath: f.path, sha256: hash(f.content) } });
    await outcome.cleanup;
  });

  it("defaults format options like the executor", async () => {
    const f = await fixture();
    const outcome = await run(f, f.formatRequest);
    expect(f.wires[0]!.params).toEqual({ textDocument: { uri: f.uri }, options: { tabSize: 2, insertSpaces: true } });
    await outcome.cleanup;
  });

  it("acquires the exact route without install", async () => {
    const f = await fixture();
    const outcome = await run(f, f.formatRequest);
    expect(f.acquire).toHaveBeenCalledWith(f.root, "typescript", { descriptorId: "typescript-language-server", allowInstall: false, purpose: "request" });
    await outcome.cleanup;
  });

  it("keeps a read-only preview without staging when no stage dependency is supplied", async () => {
    const f = await fixture();
    const outcome = await executeBoundSemanticEdit(f.formatRequest, f.route, { deadlineMs: f.deadlineMs, acquire: f.acquire });
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "ok" } });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.wires).toHaveLength(1);
    await outcome.cleanup;
  });

  it("keeps a preview and never stages a source over the 4 MiB cap", async () => {
    const f = await fixture({ content: Buffer.alloc(ACTION_SEMANTIC_EDIT_MAX_BYTES + 1, 97) });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "ok", operation: "formatDocument" } });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).not.toHaveBeenCalled();
    expect(f.wires).toHaveLength(1);
    expect(f.prepares).toEqual([{ path: f.path, submitted: undefined }]);
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("keeps a preview and never stages a source that is not valid UTF-8", async () => {
    const f = await fixture({ content: Buffer.from([0xff, 0xfe, 0x41]) });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "ok" } });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).not.toHaveBeenCalled();
    expect(f.wires).toHaveLength(1);
    await outcome.cleanup;
  });

  it("keeps a preview and never stages a reply over the 16 MiB serialized cap", async () => {
    const f = await fixture({ reply: () => [editAt("x".repeat(ACTION_SERIALIZED_EDIT_MAX_BYTES + 1))] });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "ok" } });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).not.toHaveBeenCalled();
    expect(f.wires).toHaveLength(1);
    await outcome.cleanup;
  });

  it("keeps a preview and never stages a non-UTF-16 negotiated encoding", async () => {
    const f = await fixture({ encoding: "utf-8" });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "ok", server: { positionEncoding: "utf-8" } } });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).not.toHaveBeenCalled();
    await outcome.cleanup;
  });

  it("keeps a preview for a well-formed WorkspaceEdit with unsupported versioned semantics", async () => {
    const f = await fixture({ reply: (uri) => ({ documentChanges: [{ textDocument: { uri, version: 99 }, edits: [editAt("renamed")] }] }) });
    const outcome = await run(f, renameRequest(f));
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "ok" } });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).not.toHaveBeenCalled();
    await outcome.cleanup;
  });

  it("returns the existing malformed-reply envelope without staging", async () => {
    const f = await fixture({ reply: () => ({ not: "a text edit list" }) });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "error", result: null, error: { code: "normalization" } } });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).not.toHaveBeenCalled();
    await outcome.cleanup;
  });

  it.each([[[]], [null]])("keeps an empty preview for no-op reply %j", async (reply) => {
    const f = await fixture({ reply: () => reply });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "empty" } });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).not.toHaveBeenCalled();
    await outcome.cleanup;
  });

  it("allows rename edits for other files and uses only the request target as origin", async () => {
    // Build the "other file" URI by resolving a sibling of the real fixture URI:
    // a hardcoded POSIX "file:///elsewhere/other.ts" throws ERR_INVALID_FILE_URL_PATH
    // under fileURLToPath on Windows, so production refuses the reply and stages no
    // proposal. Deriving via URL keeps a valid file: URI (with drive letter) on win32.
    let otherPath = "";
    const f = await fixture({ reply: (uri) => {
      const otherUri = new URL("./other.ts", uri).href;
      otherPath = fileURLToPath(otherUri);
      return { changes: { [uri]: [editAt("a")], [otherUri]: [editAt("b")] } };
    } });
    const outcome = await run(f, renameRequest(f));
    expect(outcome.kind === "result" && outcome.proposal).toBeTruthy();
    const packet = f.stage.mock.calls[0]![0];
    expect(packet.document).toEqual({ canonicalPath: f.path, sha256: hash(f.content) });
    expect(packet.prepared.fileEdits.map((file) => file.filePath).sort()).toEqual([f.path, otherPath].sort());
    await outcome.cleanup;
  });

  it("keeps private origin data out of the envelope and outcome", async () => {
    const f = await fixture({ reply: renameReply });
    const outcome = await run(f, renameRequest(f));
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    const visible = JSON.stringify({ envelope: outcome.envelope, proposal: outcome.proposal });
    for (const secret of ["connection-secret", "transport-secret", "store-secret", "state-secret", "opaque-lease-key", "submissionStamp", "rawSha256", hash(f.content)]) {
      expect(visible).not.toContain(secret);
    }
    expect(Object.keys(outcome).sort()).toEqual(["cleanup", "envelope", "kind", "proposal"]);
    await outcome.cleanup;
  });

  it.each([
    ["rename without newName", (f: Fixture): StrictRequest => ({ operation: "rename", path: f.path, position: { line: 0, character: 1 } })],
    ["formatRange without range", (f: Fixture): StrictRequest => ({ operation: "formatRange", path: f.path })],
    ["formatOnType without ch", (f: Fixture): StrictRequest => ({ operation: "formatOnType", path: f.path, position: { line: 0, character: 1 } })],
    ["unsupported operation", (f: Fixture): StrictRequest => ({ operation: "hover", path: f.path, position: { line: 0, character: 1 } })],
    ["missing explicit target", (): StrictRequest => ({ operation: "formatDocument" })],
  ])("refuses %s before acquiring a session", async (_label, build) => {
    const f = await fixture();
    const outcome = await run(f, build(f));
    expect(outcome).toMatchObject({ kind: "refusal", status: "unsupported" });
    expect(f.acquire).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "not-acquired" });
  });

  it("refuses without wire traffic when the prepared receipt does not match the snapshot", async () => {
    const f = await fixture();
    vi.mocked(f.conn.prepareDocument).mockResolvedValue({ ...f.receipt, textHash: hash("different") });
    vi.mocked(f.conn.getDocumentReceipt).mockReturnValue({ ...f.receipt, textHash: hash("different") });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "refusal", status: "not_ready" });
    expect(f.wires).toHaveLength(0);
    expect(f.stage).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("refuses a missing target file without wire traffic", async () => {
    const f = await fixture();
    const outcome = await run(f, { operation: "formatDocument", path: join(f.root, "absent.ts") });
    expect(outcome).toMatchObject({ kind: "refusal" });
    expect(f.wires).toHaveLength(0);
    expect(f.stage).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("refuses with no proposal when the receipt changes after the reply", async () => {
    const f = await fixture();
    vi.mocked(f.conn.request).mockImplementation(async (method, params, options) => {
      f.wires.push({ method, params, signal: options?.signal });
      vi.mocked(f.conn.getDocumentReceipt).mockReturnValue({ ...f.receipt, version: 2 });
      return [editAt("let")];
    });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "refusal", status: "not_ready" });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("refuses with no proposal when the session stops being current after the reply", async () => {
    const f = await fixture();
    vi.mocked(f.conn.request).mockImplementation(async (method, params, options) => {
      f.wires.push({ method, params, signal: options?.signal });
      f.current.mockReturnValue(false);
      return [editAt("let")];
    });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "refusal", status: "not_ready" });
    expect(f.stage).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("refuses with no proposal when the source file changes during the request", async () => {
    const f = await fixture();
    vi.mocked(f.conn.request).mockImplementation(async (method, params, options) => {
      f.wires.push({ method, params, signal: options?.signal });
      await writeFile(f.path, "const value = 2;");
      return [editAt("let")];
    });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "refusal", status: "not_ready" });
    expect(f.stage).not.toHaveBeenCalled();
    await outcome.cleanup;
  });

  it("gives caller cancellation priority over an expired deadline and never stages", async () => {
    const f = await fixture();
    const caller = new AbortController();
    let time = 0;
    vi.mocked(f.conn.request).mockImplementation(async (method, params, options) => {
      f.wires.push({ method, params, signal: options?.signal });
      time = 1000;
      caller.abort();
      return [editAt("let")];
    });
    const outcome = await run(f, f.formatRequest, { deadlineMs: 1000, now: () => time, signal: caller.signal });
    expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(f.stage).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("reports an expired deadline as timeout and never stages", async () => {
    const f = await fixture();
    let time = 0;
    vi.mocked(f.conn.request).mockImplementation(async (method, params, options) => {
      f.wires.push({ method, params, signal: options?.signal });
      time = 1000;
      return [editAt("let")];
    });
    const outcome = await run(f, f.formatRequest, { deadlineMs: 1000, now: () => time });
    expect(outcome).toMatchObject({ kind: "refusal", status: "timeout" });
    expect(f.stage).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("refuses a pre-aborted caller without acquiring", async () => {
    const f = await fixture();
    const caller = new AbortController(); caller.abort();
    const outcome = await run(f, f.formatRequest, { signal: caller.signal });
    expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(f.acquire).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "not-acquired" });
  });

  it("withdraws the in-flight semantic request when the caller cancels and releases once", async () => {
    const f = await fixture();
    const caller = new AbortController();
    const entered = deferred<void>();
    const pending = deferred<unknown>();
    vi.mocked(f.conn.request).mockImplementation((method, params, options) => {
      f.wires.push({ method, params, signal: options?.signal });
      entered.resolve();
      return pending.promise;
    });
    const running = run(f, f.formatRequest, { signal: caller.signal });
    try {
      await entered.promise;
      caller.abort();
      const outcome = await running;
      expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
      expect(f.wires[0]!.signal?.aborted).toBe(true);
      expect(f.stage).not.toHaveBeenCalled();
      await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve([]);
      await running;
    }
  });

  it("releases a late lease exactly once when cancelled during acquisition", async () => {
    const f = await fixture();
    const caller = new AbortController();
    const entered = deferred<void>();
    const late = deferred<BoundSessionLease | null>();
    const acquire = vi.fn(() => { entered.resolve(); return late.promise; });
    const running = run(f, f.formatRequest, { signal: caller.signal, acquire });
    try {
      await entered.promise;
      caller.abort();
      const outcome = await running;
      expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
      late.resolve(f.lease);
      await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.wires).toHaveLength(0);
    } finally {
      late.resolve(null);
      await running;
    }
  });

  it("refuses mismatched captured route metadata and releases", async () => {
    const f = await fixture();
    const outcome = await run(f, f.formatRequest, { acquire: async () => ({ ...f.lease, registration: Object.freeze({ ...f.lease.registration, descriptorId: "other" }) }) });
    expect(outcome).toMatchObject({ kind: "refusal", status: "unavailable" });
    expect(f.wires).toHaveLength(0);
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("holds the lease while a hung stage is occupied and releases when it settles", async () => {
    const f = await fixture();
    const caller = new AbortController();
    const entered = deferred<void>();
    const hung = deferred<BoundActionStageResult>();
    f.stage.mockImplementation(() => { entered.resolve(); return hung.promise; });
    const running = run(f, f.formatRequest, { signal: caller.signal });
    try {
      await entered.promise;
      caller.abort();
      const outcome = await running;
      expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
      expect(outcome).not.toHaveProperty("proposal");
      expect(f.release).not.toHaveBeenCalled();
      hung.resolve(staged);
      await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
      expect(f.release).toHaveBeenCalledTimes(1);
    } finally {
      hung.resolve(staged);
      await running;
    }
  });

  it("discards a staged proposal when the source changes while staging", async () => {
    const f = await fixture();
    f.stage.mockImplementation(async () => { await writeFile(f.path, "const value = 3;"); return staged; });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "refusal", status: "not_ready" });
    expect(outcome).not.toHaveProperty("proposal");
    await outcome.cleanup;
  });

  it("returns a preview for stage refusals, maps stage throws to refusals, and still releases", async () => {
    const f = await fixture();
    f.stage.mockResolvedValueOnce({ kind: "refused", reason: "unsupported" });
    const refused = await run(f, f.formatRequest);
    expect(refused.kind).toBe("result");
    if (refused.kind !== "result") return;
    expect(refused.envelope).toMatchObject({ status: "ok", operation: "formatDocument" });
    expect(refused).not.toHaveProperty("proposal");
    await expect(refused.cleanup).resolves.toEqual({ state: "released" });
    f.stage.mockRejectedValueOnce(new Error("rpc exploded"));
    const thrown = await run(f, f.formatRequest);
    expect(thrown).toMatchObject({ kind: "refusal", status: "unavailable" });
    await expect(thrown.cleanup).resolves.toEqual({ state: "released" });
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it("returns a read-only preview without a proposal when staging is unavailable", async () => {
    const f = await fixture();
    f.stage.mockResolvedValueOnce({ kind: "refused", reason: "unavailable" });
    const outcome = await run(f, f.formatRequest);
    expect(outcome.kind).toBe("result");
    if (outcome.kind !== "result") return;
    expect(outcome.envelope).toMatchObject({ status: "ok", operation: "formatDocument" });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.wires).toHaveLength(1);
    expect(f.stage).toHaveBeenCalledTimes(1);
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it.each(["not_ready", "stale"] as const)("refuses with no proposal when staging reports %s", async (reason) => {
    const f = await fixture();
    f.stage.mockResolvedValueOnce({ kind: "refused", reason } as unknown as BoundActionStageResult);
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "refusal", status: "not_ready" });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).toHaveBeenCalledTimes(1);
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("reports a cancelled staging refusal as cancelled with no proposal", async () => {
    const f = await fixture();
    f.stage.mockResolvedValueOnce({ kind: "refused", reason: "cancelled" });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "refusal", status: "cancelled" });
    expect(outcome).not.toHaveProperty("proposal");
    expect(f.stage).toHaveBeenCalledTimes(1);
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });

  it("reports release failure as cleanup failure and never succeeds", async () => {
    const f = await fixture();
    f.release.mockImplementation(() => { throw new Error("release failed"); });
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "refusal", status: "unavailable" });
    await expect(outcome.cleanup).resolves.toEqual({ state: "failed" });
  });

  it("returns an unsupported-capability envelope without staging or wire traffic", async () => {
    const f = await fixture();
    vi.spyOn(f.conn, "getCapabilityRegistry").mockReturnValue({ can: () => false } as never);
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "unsupported" } });
    expect(f.wires).toHaveLength(0);
    expect(f.stage).not.toHaveBeenCalled();
    await outcome.cleanup;
  });

  it("turns a semantic request failure into the existing error envelope", async () => {
    const f = await fixture();
    vi.mocked(f.conn.request).mockRejectedValue(new Error("server failed"));
    const outcome = await run(f, f.formatRequest);
    expect(outcome).toMatchObject({ kind: "result", envelope: { status: "error", result: null } });
    expect(f.stage).not.toHaveBeenCalled();
    await expect(outcome.cleanup).resolves.toEqual({ state: "released" });
  });
});
