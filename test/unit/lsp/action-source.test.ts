import { constants } from "node:fs";
import { mkdtemp, open, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTION_SOURCE_MAX_BYTES, type ActionSourceIO, snapshotActionSource } from "../../../src/lsp/lsp-action-source.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "action-source-")); dirs.push(dir);
  const file = join(dir, "source.ts"); await writeFile(file, bytes); return file;
}

interface OpenedHandle {
  readonly handle: FileHandle;
  closeCalls: number;
  forwardedBytes: number;
  flags: number;
}

function instrumentIO(hooks: {
  afterStat?: (handle: FileHandle) => Promise<void>;
  beforeRead?: (handle: FileHandle) => Promise<void>;
  afterRead?: (handle: FileHandle, bytesRead: number) => Promise<void>;
  afterClose?: (handle: FileHandle) => Promise<void>;
  readError?: boolean;
} = {}) {
  const opened: OpenedHandle[] = [];
  const io: ActionSourceIO = {
    realpath,
    stat,
    open: async (path, flags) => {
      const handle = await open(path, flags);
      const tracked: OpenedHandle = { handle, closeCalls: 0, forwardedBytes: 0, flags };
      opened.push(tracked);
      return {
        stat: async () => {
          const info = await handle.stat();
          await hooks.afterStat?.(handle);
          return info;
        },
        read: async (buffer, offset, length, position) => {
          await hooks.beforeRead?.(handle);
          if (hooks.readError) throw new Error("injected adapter read error");
          const result = await handle.read(buffer, offset, length, position);
          tracked.forwardedBytes += result.bytesRead;
          await hooks.afterRead?.(handle, result.bytesRead);
          return result;
        },
        close: async () => {
          tracked.closeCalls++;
          await handle.close();
          await hooks.afterClose?.(handle);
        },
      };
    },
  };
  return { io, opened };
}

function expectClosedExactlyOnce(opened: OpenedHandle[]): void {
  expect(opened.length).toBe(1);
  for (const { handle, closeCalls } of opened) {
    expect(closeCalls).toBe(1);
    expect(handle.fd).toBe(-1);
  }
}

describe("snapshotActionSource", () => {
  it("keeps BOM in decoded text while hashing raw bytes and text separately", async () => {
    const file = await fixture(Buffer.from("\uFEFFconst x = 1;", "utf8"));
    const result = await snapshotActionSource(file, { deadlineMs: Date.now() + 5000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.text.startsWith("\uFEFF")).toBe(true);
      expect(result.snapshot.rawSha256).toBe(result.snapshot.textSha256);
    }
  });
  it("rejects invalid UTF-8 and files over the cap", async () => {
    const invalid = await fixture(Buffer.from([0xff]));
    expect(await snapshotActionSource(invalid, { deadlineMs: Date.now() + 5000 })).toMatchObject({ ok: false, reason: "invalid-utf8" });
    const large = await fixture(Buffer.alloc(1024 * 1024 + 1));
    expect(await snapshotActionSource(large, { deadlineMs: Date.now() + 5000 })).toMatchObject({ ok: false, reason: "too-large" });
  });
  it("opens a symlink through its canonical target", async () => {
    const file = await fixture(Buffer.from("source"));
    const link = join(file, "..", "source-link.ts"); await symlink(file, link);
    const result = await snapshotActionSource(link, { deadlineMs: Date.now() + 5000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.canonicalPath).toBe(await realpath(file));
  });

  it("closes the actual descriptor after a successful snapshot and forwards only O_RDONLY plus O_NONBLOCK", async () => {
    const file = await fixture(Buffer.from("source"));
    const { io, opened } = instrumentIO();
    try {
      expect((await snapshotActionSource(file, { deadlineMs: Date.now() + 5000, io })).ok).toBe(true);
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.flags).toBe(constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      expect(opened[0]!.forwardedBytes).toBe(Buffer.byteLength("source"));
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("closes the actual descriptor after invalid UTF-8", async () => {
    const file = await fixture(Buffer.from([0xff]));
    const { io, opened } = instrumentIO();
    try {
      expect(await snapshotActionSource(file, { deadlineMs: Date.now() + 5000, io })).toMatchObject({ ok: false, reason: "invalid-utf8" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(1);
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("rejects a pre-read oversized file without reading and closes its descriptor", async () => {
    const file = await fixture(Buffer.alloc(ACTION_SOURCE_MAX_BYTES + 1));
    const { io, opened } = instrumentIO();
    try {
      expect(await snapshotActionSource(file, { deadlineMs: Date.now() + 5000, io })).toMatchObject({ ok: false, reason: "too-large" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(0);
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("prioritizes cancellation after fstat over the oversized-file result", async () => {
    const file = await fixture(Buffer.alloc(ACTION_SOURCE_MAX_BYTES + 1));
    const controller = new AbortController();
    const { io, opened } = instrumentIO({ afterStat: async () => controller.abort() });
    try {
      expect(await snapshotActionSource(file, { deadlineMs: Date.now() + 5000, signal: controller.signal, io })).toMatchObject({ ok: false, reason: "cancelled" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(0);
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("rejects a non-finite deadline before opening a descriptor", async () => {
    const file = await fixture(Buffer.from("source"));
    const { io, opened } = instrumentIO();
    try {
      expect(await snapshotActionSource(file, { deadlineMs: Number.POSITIVE_INFINITY, io })).toMatchObject({ ok: false, reason: "timeout" });
      expect(opened).toHaveLength(0);
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("closes a directory descriptor after rejecting its non-file stat", async () => {
    const file = await fixture(Buffer.from("source"));
    const { io, opened } = instrumentIO();
    try {
      expect(await snapshotActionSource(join(file, ".."), { deadlineMs: Date.now() + 5000, io })).toMatchObject({ ok: false, reason: "unavailable" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(0);
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("bounds actual reads when a file grows after its initial fstat", async () => {
    const file = await fixture(Buffer.from("small"));
    let grew = false;
    const { io, opened } = instrumentIO({ afterStat: async () => {
      if (!grew) { grew = true; await writeFile(file, Buffer.alloc(ACTION_SOURCE_MAX_BYTES + 20)); }
    } });
    try {
      expect(await snapshotActionSource(file, { deadlineMs: Date.now() + 5000, io })).toMatchObject({ ok: false, reason: "too-large" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(ACTION_SOURCE_MAX_BYTES + 1);
      expect(opened[0]!.forwardedBytes).toBeLessThanOrEqual(ACTION_SOURCE_MAX_BYTES + 1);
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("detects named-path replacement after reading the original descriptor", async () => {
    const file = await fixture(Buffer.from("original"));
    const replacement = join(file, "..", "replacement.ts");
    await writeFile(replacement, "replacement");
    let replaced = false;
    const { io, opened } = instrumentIO({ afterRead: async (_handle, bytesRead) => {
      if (!replaced && bytesRead > 0) {
        replaced = true;
        await rename(replacement, file);
      }
    } });
    try {
      expect(await snapshotActionSource(file, { deadlineMs: Date.now() + 5000, io })).toMatchObject({ ok: false, reason: "stale" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(Buffer.byteLength("original"));
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("closes the actual descriptor after an injected adapter read error", async () => {
    const file = await fixture(Buffer.from("source"));
    const { io, opened } = instrumentIO({ readError: true });
    try {
      expect(await snapshotActionSource(file, { deadlineMs: Date.now() + 5000, io })).toMatchObject({ ok: false, reason: "unavailable" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(0);
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("prioritizes cancellation that arrives while the final descriptor close is awaited", async () => {
    const file = await fixture(Buffer.from("source"));
    const controller = new AbortController();
    const { io, opened } = instrumentIO({ afterClose: async () => controller.abort() });
    try {
      const result = await snapshotActionSource(file, { deadlineMs: Date.now() + 5000, signal: controller.signal, io });
      expect(result).toMatchObject({ ok: false, reason: "cancelled" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(Buffer.byteLength("source"));
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });

  it("prioritizes a deadline crossed while the final descriptor close is awaited", async () => {
    const file = await fixture(Buffer.from("source"));
    let now = 0;
    const { io, opened } = instrumentIO({ afterClose: async () => { now = 10; } });
    try {
      const result = await snapshotActionSource(file, { deadlineMs: 10, now: () => now, io });
      expect(result).toMatchObject({ ok: false, reason: "timeout" });
      expectClosedExactlyOnce(opened);
      expect(opened[0]!.forwardedBytes).toBe(Buffer.byteLength("source"));
    } finally {
      await Promise.all(opened.map(async ({ handle }) => { if (handle.fd !== -1) await handle.close(); }));
    }
  });
});
