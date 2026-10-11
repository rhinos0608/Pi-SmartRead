import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeBoundAction } from "../../../src/lsp/lsp-action-adapter.js";
import type { BoundActionRequest } from "../../../src/lsp/lsp-action-origin.js";
import { LSPConnection } from "../../../src/lsp/lsp-connection.js";
import type { PreparedDocumentReceipt } from "../../../src/lsp/lsp-document-store.js";
import { cachedManager, evictManagerForRoot, sessionStore, type SessionEntry } from "../../../src/lsp/lsp-manager.js";
import { buildSessionKey, computeConfigFingerprint } from "../../../src/lsp/lsp-session-key.js";
import { discoverDiagnosticActions } from "../../../scripts/eval/lsp-ergonomics/diagnostic-actions.js";
import { selectCurrentDiagnosticAction } from "../../../scripts/eval/lsp-ergonomics/action-selection.js";
import type { StrictEnvelope, StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

const roots: string[] = [];
const keys: string[] = [];
afterEach(async () => {
  for (const key of keys.splice(0)) sessionStore.delete(key);
  for (const root of roots.splice(0)) {
    await evictManagerForRoot(join(root, "workspace"));
    await rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "production-identity-")));
  roots.push(parent);
  const root = join(parent, "workspace");
  await mkdir(root);
  const sourceNamed = join(parent, "origin.ts");
  const raw = Buffer.from("\uFEFFconst origin = 1;\n", "utf8");
  await writeFile(sourceNamed, raw);
  const source = await realpath(sourceNamed);
  const descriptorId = "production-identity-typescript";
  const conn = new LSPConnection();
  conn.descriptorId = descriptorId; conn.name = "TypeScript"; conn.projectRoot = root; conn.languageIds = ["typescript"];
  vi.spyOn(conn, "getNegotiatedEncoding").mockReturnValue("utf-16");
  vi.spyOn(conn, "shutdown").mockImplementation(() => {});
  const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  const receipt: PreparedDocumentReceipt = {
    canonicalPath: source, uri: pathToFileURL(source).href, version: 4, textHash: sha(decoded), mutationGeneration: 2, submissionStamp: 3,
    syncConfig: { openClose: true, change: "full" }, connectionId: conn.connectionId,
    transportId: "fixture-transport", storeId: "fixture-store", stateId: "fixture-state", descriptorId,
    projectRoot: root, positionEncoding: "utf-16",
  };
  vi.spyOn(conn, "prepareDocument").mockResolvedValue(receipt);
  vi.spyOn(conn, "getDocumentReceipt").mockReturnValue(receipt);
  const action = { title: "Fix", kind: "quickfix", data: { retained: true } };
  const methods: string[] = [];
  const rawParams: unknown[] = [];
  vi.spyOn(conn, "request").mockImplementation(async (method, params) => {
    methods.push(method);
    rawParams.push(params);
    if (method === "textDocument/codeAction") return [action];
    throw new Error(`unexpected method ${method}`);
  });
  const manager = cachedManager(root);
  const config = { command: "production-identity-fixture-command", args: [], languageIds: ["typescript"], descriptorId };
  manager.getAvailableConfigs().splice(0, Infinity, config);
  const fingerprintInputs = Reflect.get(manager, "fingerprintFor").call(manager, "typescript", config, { descriptorId, allowInstall: false, purpose: "request" });
  const key = buildSessionKey(root, fingerprintInputs);
  const fingerprint = computeConfigFingerprint(fingerprintInputs);
  keys.push(key); Reflect.set(conn, "sessionKey", key);
  const entry: SessionEntry = { conn, fingerprint, descriptorId, root, leases: 0, lastUsed: Date.now() };
  sessionStore.set(key, entry);
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } };
  const request: BoundActionRequest = { operation: "codeActions", path: source, range, context: { diagnostics: [], only: ["quickfix"] } };
  const found = await executeBoundAction(request, { projectRoot: root, languageId: "typescript", server: descriptorId }, { deadlineMs: Date.now() + 20_000 });
  if (found.kind !== "result") throw new Error("production action discovery did not return a result");
  let row: { actionId: string; sourceSha256: string } | undefined;
  try {
    if (!Array.isArray(found.envelope.result)) throw new Error("production action discovery returned malformed rows");
    const value: unknown = found.envelope.result[0];
    if (!value || typeof value !== "object" || !("actionId" in value) || !("sourceSha256" in value)
      || typeof value.actionId !== "string" || typeof value.sourceSha256 !== "string") {
      throw new Error("production action discovery returned a malformed identity row");
    }
    row = { actionId: value.actionId, sourceSha256: value.sourceSha256 };
  } finally {
    await found.cleanup;
  }
  if (!row) throw new Error("production action discovery returned no identity row");
  return { root, source, raw, descriptorId, range, action, request, row, entry, methods, rawParams };
}

describe("production action identity interoperability", () => {
  it("passes a production-issued identity through prototype discovery and current selection", async () => {
    const f = await fixture();
    const observed: StrictRequest[] = [];
    const server: NonNullable<StrictEnvelope["server"]> = {
      descriptorId: f.descriptorId, name: "TypeScript", languageId: "typescript", projectRoot: f.root, positionEncoding: "utf-16",
    };
    const execute = async (request: StrictRequest): Promise<StrictEnvelope> => {
      observed.push(request);
      if (request.operation === "diagnostics") {
        return { status: "empty", operation: "diagnostics", method: "textDocument/diagnostic", server, result: [], meta: { truncated: false, freshness: { state: "fresh" } } };
      }
      expect(request).toMatchObject({ operation: "codeActions", path: f.source, server: f.descriptorId, range: f.range, context: f.request.context });
      if (!request.path || !request.range) throw new Error("prototype codeActions request lacks path or range");
      const result = await executeBoundAction(
        { operation: "codeActions", path: request.path, range: request.range, context: request.context },
        { projectRoot: f.root, languageId: "typescript", server: f.descriptorId },
        { deadlineMs: Date.now() + 20_000 },
      );
      try {
        if (result.kind !== "result") throw new Error("production rediscovery refused the prototype query");
        return result.envelope;
      } finally {
        await result.cleanup;
      }
    };
    const input = { path: f.source, workspace: f.root, server: f.descriptorId, range: f.range, kind: "quickfix" as const };
    const context = { cwd: f.root, execute };
    try {
      expect(f.row.sourceSha256).toBe(sha(f.raw));
      const discovery = await discoverDiagnosticActions(input, context);
      const prototypeActionRequest = observed.find((request) => request.operation === "codeActions");
      expect(prototypeActionRequest).toMatchObject({ operation: "codeActions", path: f.request.path, server: f.descriptorId, range: f.request.range, context: f.request.context });
      expect(f.rawParams[0]).toMatchObject({ textDocument: { uri: pathToFileURL(f.source).href }, range: f.range, context: f.request.context });
      expect(f.rawParams[1]).toEqual(f.rawParams[0]);
      const actualActionEnvelope = discovery.details.envelopes.find((envelope) => envelope.operation === "codeActions");
      expect(actualActionEnvelope?.status).toBe("ok");
      expect(actualActionEnvelope?.result).toEqual([{ ...f.action, actionId: f.row.actionId, sourceSha256: f.row.sourceSha256 }]);
      expect(discovery.fingerprint?.sourceSha256).toBe(f.row.sourceSha256);
      expect(discovery.options).toHaveLength(1);
      expect(discovery.options[0]?.actionId).toBe(f.row.actionId);

      const selection = { actionId: f.row.actionId, sourceSha256: f.row.sourceSha256 };
      const selected = await selectCurrentDiagnosticAction({ ...input, selection }, context);
      expect(selected.status).toBe("selected");
      if (selected.status === "selected") {
        expect(selected.selection).toEqual(selection);
        expect(selected.action).toMatchObject(f.action);
      }
      expect(f.entry.leases).toBe(0);
      expect(f.methods).toEqual(["textDocument/codeAction", "textDocument/codeAction", "textDocument/codeAction"]);
      expect(f.rawParams[2]).toEqual(f.rawParams[0]);
    } finally {
      expect(f.entry.leases).toBe(0);
    }
  });
});
