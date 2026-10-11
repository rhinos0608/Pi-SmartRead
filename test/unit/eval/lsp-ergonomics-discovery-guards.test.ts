import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverDiagnosticActions } from "../../../scripts/eval/lsp-ergonomics/diagnostic-actions.js";
import type { StrictEnvelope, StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

const reader = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...original, open: reader.open };
});
const roots: string[] = [];
beforeEach(async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  reader.open.mockImplementation(original.open);
});
afterEach(() => {
  reader.open.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const server: StrictEnvelope["server"] = { descriptorId: "guard-server", name: "fake", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16" };
function envelope(request: StrictRequest): StrictEnvelope {
  return { status: "empty", operation: request.operation, method: request.operation === "diagnostics" ? "textDocument/diagnostic" : "textDocument/codeAction", server, result: [], meta: { truncated: false, freshness: { state: "fresh" } } };
}
async function withSource(run: (path: string, cwd: string, bytes: Buffer) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), "diagnostic-guards-")); roots.push(cwd);
  const path = join(cwd, "sample.ts");
  const bytes = Buffer.from("const value = 1;\n");
  writeFileSync(path, bytes);
  try { await run(path, cwd, bytes); }
  finally { expect(await readFile(path)).toEqual(bytes); }
}
describe("diagnostic/action discovery guards", () => {
  it("returns stale without semantic callbacks for a mismatched source fingerprint", async () => {
    await withSource(async (path, cwd, bytes) => {
      const execute = vi.fn(async (request: StrictRequest) => envelope(request));
      const result = await discoverDiagnosticActions({ path }, { cwd, execute }, { expectedSourceSha256: "0".repeat(64) });
      expect(result.diagnostics).toEqual({ status: "stale", coverage: "incomplete", count: null });
      expect(result.options).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(result.fingerprint?.sourceSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    });
  });

  it("accepts a matching uppercase fingerprint", async () => {
    await withSource(async (path, cwd, bytes) => {
      const execute = vi.fn(async (request: StrictRequest) => envelope(request));
      const hash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
      const result = await discoverDiagnosticActions({ path }, { cwd, execute }, { expectedSourceSha256: hash });
      expect(result.diagnostics.status).toBe("confirmed-empty");
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  it("bounds both requests by the earlier absolute deadline", async () => {
    await withSource(async (path, cwd) => {
      const now = 100;
      const requests: StrictRequest[] = [];
      const execute = vi.fn(async (request: StrictRequest) => { requests.push(request); return envelope(request); });
      await discoverDiagnosticActions({ path, timeoutMs: 500 }, { cwd, now: () => now, execute }, { deadlineMs: 180 });
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.timeoutMs === 80)).toBe(true);
    });
  });

  it("does no filesystem or semantic work when the absolute deadline elapsed", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const spy = vi.fn(actual.open);
    reader.open.mockImplementation(spy);
    const execute = vi.fn(async (request: StrictRequest) => envelope(request));
    const result = await discoverDiagnosticActions({ path: "/not-read" }, { cwd: "/", now: () => 10, execute }, { deadlineMs: 10 });
    expect(spy).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.diagnostics.status).toBe("timeout");
    reader.open.mockReset();
  });

  it("bridges an arbitrary-origin logical clock to the filesystem deadline", async () => {
    await withSource(async (path, cwd) => {
      const now = vi.fn(() => -50_000);
      const execute = vi.fn(async (request: StrictRequest) => envelope(request));
      const result = await discoverDiagnosticActions({ path }, { cwd, now, execute }, { deadlineMs: -49_900 });
      expect(result.diagnostics.status).toBe("confirmed-empty");
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["cancelled", "timeout"])("gives %s during the initial awaited read priority over mismatch", async (status) => {
    await withSource(async (path, cwd) => {
      const controller = new AbortController();
      let now = 100;
      let opened = 0;
      let closed = 0;
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const resume = new Promise<void>((resolve) => { release = resolve; });
      reader.open.mockImplementation(async (file: string, flags: number) => {
        const handle = await actual.open(file, flags);
        opened += 1;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed += 1; });
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...args) => { entered(); await resume; return read(...args); });
        return handle;
      });
      const execute = vi.fn(async (request: StrictRequest) => envelope(request));
      const pending = discoverDiagnosticActions({ path }, { cwd, signal: controller.signal, now: () => now, execute }, { expectedSourceSha256: "0".repeat(64), deadlineMs: 1100 });
      try {
        await waiting;
        if (status === "cancelled") controller.abort();
        else now = 1100;
        release();
        const result = await pending;
        expect(result.diagnostics.status).toBe(status);
        expect(execute).not.toHaveBeenCalled();
      } finally {
        release();
        await pending;
        expect(closed).toBe(opened);
      }
    });
  });

  it.each([
    [{ unexpected: true }],
    [{ expectedSourceSha256: "not-a-sha" }],
    [{ expectedSourceSha256: "0".repeat(64), deadlineMs: Infinity }],
    [{ deadlineMs: "soon" }],
  ])("rejects malformed guard %j before filesystem or semantic work", async (guard) => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const spy = vi.fn(actual.open);
    reader.open.mockImplementation(spy);
    const execute = vi.fn(async (request: StrictRequest) => envelope(request));
    await expect(Reflect.apply(discoverDiagnosticActions, undefined, [{ path: "/not-read" }, { cwd: "/", execute }, guard])).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    reader.open.mockReset();
  });
});
