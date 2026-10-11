import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const fileIo = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: fileIo.open };
});

import { open } from "node:fs/promises";
import { readSource } from "../../../scripts/eval/lsp-ergonomics/source-locator.js";
import { createSourceRoutingExecutor } from "../../../scripts/eval/lsp-ergonomics/source-routing.js";
import { createLspTool } from "../../../src/lsp/lsp-tool.js";
import type { StrictEnvelope } from "../../../src/lsp/lsp-strict-contract.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  fileIo.open.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(bytes: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "source-snapshot-"));
  roots.push(root);
  const path = join(root, "source.ts");
  writeFileSync(path, bytes);
  return path;
}

async function actualHandle(path: string): Promise<FileHandle> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return actual.open(path, constants.O_RDONLY);
}

function mockStat(handle: FileHandle, size: number, regular = true): void {
  const originalStat = handle.stat.bind(handle);
  vi.spyOn(handle, "stat").mockImplementation(async () => {
    const stats = await originalStat();
    stats.size = size;
    stats.isFile = () => regular;
    return stats;
  });
}

async function withHandle(alter: (handle: FileHandle) => void): Promise<void> {
  fileIo.open.mockImplementation(async (openedPath: string, flags: number) => {
    expect(flags).toBe(constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const handle = await actualHandle(openedPath);
    alter(handle);
    return handle;
  });
  expect(open).toBe(fileIo.open);
}

describe("readSource snapshot IO bounds", () => {
  it("checks stat size before any read when the file is over the configured cap", async () => {
    const path = fixture(Buffer.from("0123456789abcdef-more"));
    let reads = 0;
    await withHandle((handle) => {
      mockStat(handle, 17);
      vi.spyOn(handle, "read").mockImplementation(async (...args) => {
        reads += 1;
        const actual = await actualHandle(path);
        try { return await actual.read(...args); } finally { await actual.close(); }
      });
    });
    const result = await readSource(path, { maxFileBytes: 16 }, Date.now() + 5_000);
    expect(result).toMatchObject({ ok: false, result: { status: "incomplete" } });
    expect(reads).toBe(0);
  });

  it("rejects non-regular files without reading them", async () => {
    const path = fixture(Buffer.from("content"));
    let reads = 0;
    await withHandle((handle) => {
      mockStat(handle, 7, false);
      vi.spyOn(handle, "read").mockImplementation(async (...args) => {
        reads += 1;
        const original = await actualHandle(path);
        try { return await original.read(...args); } finally { await original.close(); }
      });
    });
    const result = await readSource(path, { maxFileBytes: 16 }, Date.now() + 5_000);
    expect(result).toMatchObject({ ok: false, result: { status: "unsupported" } });
    expect(reads).toBe(0);
  });

  it.each([
    { bytes: "0123456789abcdef", withinLimit: true },
    { bytes: "0123456789abcdef-more", withinLimit: false },
  ])("bounds growth after stat with a real advancing cursor: $withinLimit", async ({ bytes, withinLimit }) => {
    const path = fixture(Buffer.from(bytes));
    let largestBuffer = 0;
    let bytesRead = 0;
    await withHandle((handle) => {
      const originalRead = handle.read.bind(handle);
      mockStat(handle, 4);
      vi.spyOn(handle, "read").mockImplementation(async (buffer) => {
        if (!Buffer.isBuffer(buffer)) throw new Error("Expected bounded Buffer read");
        largestBuffer = Math.max(largestBuffer, buffer.length);
        const result = await originalRead(buffer, 0, buffer.length, null);
        bytesRead += result.bytesRead;
        return result;
      });
    });
    const result = await readSource(path, { maxFileBytes: 16 }, Date.now() + 5_000);
    if (withinLimit) {
      expect(result).toMatchObject({ ok: true, source: bytes });
      expect(bytesRead).toBe(16);
    } else {
      expect(result).toMatchObject({ ok: false, result: { status: "incomplete", reason: "File exceeds byte limit" } });
      expect(bytesRead).toBe(17);
    }
    expect(largestBuffer).toBeLessThanOrEqual(17);
  });

  it("preserves invalid UTF-8 rejection and a UTF-8 BOM in decoded source", async () => {
    const invalidPath = fixture(Buffer.from([0xc3, 0x28]));
    fileIo.open.mockImplementation(async (path: string, flags: number) => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return actual.open(path, flags);
    });
    expect(await readSource(invalidPath, { maxFileBytes: 16 }, Date.now() + 5_000)).toMatchObject({
      ok: false, result: { status: "unsupported", reason: "Source is not valid UTF-8" },
    });
    const bom = Buffer.from("\uFEFFconst target = 1;\n");
    const bomPath = fixture(bom);
    const result = await readSource(bomPath, { maxFileBytes: 32 }, Date.now() + 5_000);
    expect(result).toMatchObject({ ok: true, source: "\uFEFFconst target = 1;\n", bytes: bom });
  });

  it("honors cancellation before open/read and cancellation triggered during read", async () => {
    const path = fixture(Buffer.from("small"));
    const before = new AbortController();
    before.abort();
    fileIo.open.mockClear();
    const cancelledBefore = await readSource(path, { signal: before.signal, maxFileBytes: 16 }, Date.now() + 5_000);
    expect(cancelledBefore).toMatchObject({ ok: false, result: { status: "incomplete" } });
    expect(fileIo.open).not.toHaveBeenCalled();

    const during = new AbortController();
    await withHandle((handle) => {
      vi.spyOn(handle, "read").mockImplementation(async (options) => {
        during.abort();
        if (!Buffer.isBuffer(options)) throw new Error("Expected bounded Buffer read");
        return { bytesRead: 0, buffer: options };
      });
    });
    const cancelledAfterRead = await readSource(path, { signal: during.signal, maxFileBytes: 16 }, Date.now() + 5_000);
    expect(cancelledAfterRead).toMatchObject({ ok: false, result: { status: "incomplete" } });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("source routing checked snapshot aborts", () => {
  it.each(["cancelled", "timeout"] as const)("retains %s when its bounded snapshot read is interrupted", async (kind) => {
    const path = fixture(Buffer.from("function target() {}\n"));
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let opened = 0;
    let closed = 0;
    fileIo.open.mockImplementation(async (openedPath: string, flags: number) => {
      const handle = await real.open(openedPath, flags);
      opened += 1;
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed += 1; });
      if (opened === 2) {
        vi.spyOn(handle, "read").mockImplementation(async (...args) => {
          entered.resolve();
          await release.promise;
          return read(...args);
        });
      }
      return handle;
    });
    const bootstrap: StrictEnvelope = {
      status: "ok", operation: "documentSymbols", method: "textDocument/documentSymbol",
      result: [], meta: { truncated: false },
      server: { descriptorId: "server-A", name: "test", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16" },
    };
    const executeOperation = vi.fn(async () => bootstrap);
    const tool = createLspTool();
    tool.execute = createSourceRoutingExecutor(tool.execute, { executeOperation });
    const now = Date.now;
    const clock = vi.spyOn(Date, "now");
    const start = now.call(Date);
    clock.mockReturnValue(start);
    const pending = tool.execute("id", { operation: "hover", source: { path, line: 1, identifier: "target" } }, controller.signal, undefined, { cwd: tmpdir() } as ExtensionContext);
    await entered.promise;
    if (kind === "cancelled") controller.abort();
    else clock.mockReturnValue(start + 60_000);
    release.resolve();
    const result = await pending;
    const first = result.content[0];
    if (!first || first.type !== "text") throw new Error("Expected JSON text result");
    expect(JSON.parse(first.text)).toMatchObject({ status: kind, result: null });
    const details = result.details;
    if (typeof details !== "object" || details === null || !("bootstrap" in details)) throw new Error("Expected bootstrap details");
    expect(details.bootstrap).toEqual(bootstrap);
    expect(executeOperation).toHaveBeenCalledTimes(1);
    expect(opened).toBe(2);
    expect(closed).toBe(opened);
  });
});
