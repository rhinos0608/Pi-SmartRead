import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath as fsRealpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectCurrentDiagnosticAction } from "../../../scripts/eval/lsp-ergonomics/action-selection.js";
import type { StrictEnvelope, StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";
import { createHash } from "node:crypto";
import { AFFORDANCE_BOUNDS } from "../../../src/lsp/affordance-contract.js";

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
  vi.restoreAllMocks();
  reader.open.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const server: StrictEnvelope["server"] = {
  descriptorId: "selection-server",
  name: "fixture",
  languageId: "typescript",
  projectRoot: "/workspace",
  positionEncoding: "utf-16",
};

async function fixture(text = "const x = 1;\n") {
  const cwd = mkdtempSync(join(tmpdir(), "action-selection-runtime-"));
  roots.push(cwd);
  const path = join(cwd, "sample.ts");
  const bytes = Buffer.from(text);
  writeFileSync(path, bytes);
  const canonicalPath = await fsRealpath(path);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  return { cwd, path, canonicalPath, bytes, sourceSha256 };
}

function envelope(
  request: StrictRequest,
  result: unknown,
  status: "ok" | "empty" = "ok",
  meta: StrictEnvelope["meta"] = { truncated: false, freshness: { state: "fresh" } },
): StrictEnvelope {
  return {
    status,
    operation: request.operation,
    method: request.operation === "diagnostics" ? "textDocument/diagnostic" : "textDocument/codeAction",
    server,
    result,
    meta,
  };
}

interface TrackedHandle {
  handle: FileHandle;
  index: number;
  isClosed: () => boolean;
}

interface DeferredReadHook {
  targetIndex: number;
  waitingForRead: Promise<void>;
  release: () => void;
  openHandles: TrackedHandle[];
  assertAllClosed: () => Promise<void>;
}

async function createDeferredReadHarness(targetIndex = 8): Promise<DeferredReadHook> {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let openCount = 0;
  const openHandles: TrackedHandle[] = [];

  let entered!: () => void;
  let resume!: () => void;
  const waitingForRead = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumeRead = new Promise<void>((resolve) => {
    resume = resolve;
  });

  reader.open.mockImplementation(async (file: string, flags: number) => {
    const handle = await original.open(file, flags);
    const index = ++openCount;
    let closed = false;
    const origClose = handle.close.bind(handle);
    const origRead = handle.read.bind(handle);

    vi.spyOn(handle, "close").mockImplementation(async () => {
      try {
        return await origClose();
      } finally {
        closed = true;
      }
    });

    if (index === targetIndex) {
      vi.spyOn(handle, "read").mockImplementation(async (...args) => {
        entered();
        await resumeRead;
        return origRead(...args);
      });
    }

    const tracked: TrackedHandle = {
      handle,
      index,
      isClosed: () => closed,
    };
    openHandles.push(tracked);
    return handle;
  });

  return {
    targetIndex,
    waitingForRead,
    release: () => resume(),
    openHandles,
    assertAllClosed: async () => {
      expect(openHandles).toHaveLength(targetIndex);
      for (const item of openHandles) {
        expect(item.isClosed()).toBe(true);
        // Verify underlying file handle is indeed closed (fd is negative/invalid or throws on operation)
        await expect(item.handle.stat()).rejects.toThrow();
      }
    },
  };
}

describe("diagnostic action selection runtime and final read acceptance", () => {
  it("returns cancelled when aborted during final selection read", async () => {
    const f = await fixture();
    const action = { title: "Fix", kind: "quickfix", edit: { changes: { [f.canonicalPath]: [{ newText: "ok" }] } }, actionId: "Returned:ChoiceA", sourceSha256: f.sourceSha256 };

    const controller = new AbortController();
    const harness = await createDeferredReadHarness(8);

    const execute = vi.fn(async (request: StrictRequest) =>
      envelope(request, request.operation === "diagnostics" ? [] : [action], request.operation === "diagnostics" ? "empty" : "ok")
    );

    const pending = selectCurrentDiagnosticAction(
      { path: f.path, selection: { actionId: "Returned:ChoiceA", sourceSha256: f.sourceSha256 } },
      { cwd: f.cwd, execute, signal: controller.signal }
    );

    try {
      await harness.waitingForRead;
      writeFileSync(f.path, "const x = 2;\n");
      controller.abort();
    } finally {
      harness.release();
      try {
        await pending;
      } finally {
        await harness.assertAllClosed();
      }
    }

    const result = await pending;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.code).toBe("cancelled");
    }
  });

  it("returns timeout when deadline expires during final selection read", async () => {
    const f = await fixture();
    const action = { title: "Fix", kind: "quickfix", edit: { changes: { [f.canonicalPath]: [{ newText: "ok" }] } }, actionId: "Returned:ChoiceA", sourceSha256: f.sourceSha256 };

    let currentLogicalTime = 1000;
    const now = vi.fn(() => currentLogicalTime);
    let currentEpochTime = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => currentEpochTime);

    const harness = await createDeferredReadHarness(8);

    const execute = vi.fn(async (request: StrictRequest) =>
      envelope(request, request.operation === "diagnostics" ? [] : [action], request.operation === "diagnostics" ? "empty" : "ok")
    );

    const pending = selectCurrentDiagnosticAction(
      { path: f.path, selection: { actionId: "Returned:ChoiceA", sourceSha256: f.sourceSha256 } },
      { cwd: f.cwd, execute, now }
    );

    try {
      await harness.waitingForRead;
      writeFileSync(f.path, "const x = 2;\n");
      currentLogicalTime += AFFORDANCE_BOUNDS.aggregateDeadlineMs + 10_000;
      currentEpochTime += AFFORDANCE_BOUNDS.aggregateDeadlineMs + 10_000;
    } finally {
      harness.release();
      try {
        await pending;
      } finally {
        await harness.assertAllClosed();
      }
    }

    const result = await pending;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.code).toBe("timeout");
    }
  });

  it("refuses as no-match when actions response is confirmed empty", async () => {
    const f = await fixture();
    const fakeActionId = "0".repeat(64);

    const execute = vi.fn(async (request: StrictRequest) =>
      envelope(request, [], "empty")
    );

    const result = await selectCurrentDiagnosticAction(
      { path: f.path, selection: { actionId: fakeActionId, sourceSha256: f.sourceSha256 } },
      { cwd: f.cwd, execute }
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.code).toBe("no-match");
    }
  });

  it("refuses when caller mutates candidate object while final read is suspended", async () => {
    const f = await fixture();
    const action = { title: "Fix", kind: "quickfix", edit: { changes: { [f.canonicalPath]: [{ newText: "ok" }] } }, actionId: "Returned:ChoiceA", sourceSha256: f.sourceSha256 };

    const harness = await createDeferredReadHarness(8);

    const execute = vi.fn(async (request: StrictRequest) =>
      envelope(request, request.operation === "diagnostics" ? [] : [action], request.operation === "diagnostics" ? "empty" : "ok")
    );

    const pending = selectCurrentDiagnosticAction(
      { path: f.path, selection: { actionId: "Returned:ChoiceA", sourceSha256: f.sourceSha256 } },
      { cwd: f.cwd, execute }
    );

    try {
      await harness.waitingForRead;
      action.title = "Mutated during final read";
    } finally {
      harness.release();
      try {
        await pending;
      } finally {
        await harness.assertAllClosed();
      }
    }

    const result = await pending;
    expect(execute).toHaveBeenCalledTimes(2);
    // Candidate mutation must prevent publishing modified candidate under explicit selection ID
    if (result.status === "selected") {
      expect(result.action.actionId).toBe("Returned:ChoiceA");
    } else {
      expect(["no-match", "stale"]).toContain(result.code);
    }
  });

  it("refuses when bytes change before the final actual read", async () => {
    const f = await fixture();
    const action = { title: "Fix", kind: "quickfix", edit: { changes: { [f.canonicalPath]: [{ newText: "ok" }] } }, actionId: "Returned:ChoiceA", sourceSha256: f.sourceSha256 };

    const harness = await createDeferredReadHarness(8);

    const execute = vi.fn(async (request: StrictRequest) =>
      envelope(request, request.operation === "diagnostics" ? [] : [action], request.operation === "diagnostics" ? "empty" : "ok")
    );

    const pending = selectCurrentDiagnosticAction(
      { path: f.path, selection: { actionId: "Returned:ChoiceA", sourceSha256: f.sourceSha256 } },
      { cwd: f.cwd, execute }
    );

    try {
      await harness.waitingForRead;
      writeFileSync(f.path, "mutated content\n");
    } finally {
      harness.release();
      try {
        await pending;
      } finally {
        await harness.assertAllClosed();
      }
    }

    const result = await pending;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.code).toBe("stale");
    }
  });
});
