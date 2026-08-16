import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LSPBridge, LSPDiagnostic } from "../../src/lsp-bridge.js";

// Same shared key SmartEdit's mutation-ownership.ts writes to. Duplicated
// here (per the task spec) rather than imported across repos — SmartRead
// only ever reads it.
const CLAIM_KEY = Symbol.for("pi-smart-edit.postMutationDiagnostics.owner.v1");

function claimsMap(): Map<string, number> {
  const g = globalThis as Record<PropertyKey, unknown>;
  let value = g[CLAIM_KEY] as Map<string, number> | undefined;
  if (!value) {
    value = new Map();
    Object.defineProperty(g, CLAIM_KEY, { value, enumerable: false, configurable: true });
  }
  return value;
}

let mockBridge: (Partial<LSPBridge> & { isAvailable: () => boolean }) | null;

vi.mock("../../src/lsp-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lsp-bridge.js")>();
  return {
    ...actual,
    getLSPBridge: vi.fn(async () => mockBridge as unknown as import("../../src/lsp-bridge.js").LSPBridge | null),
  };
});

const { runPostEditDiagnosticsFallback, formatDiagnosticsBlock } = await import("../../src/post-edit-fallback.js");

describe("post-edit LSP diagnostics fallback", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-smartread-post-edit-"));
    filePath = join(dir, "example.ts");
    writeFileSync(filePath, "export const value = 1;\n");
    claimsMap().clear();
    mockBridge = null;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeAvailableBridge(diagnostics: LSPDiagnostic[], opts: { emptyFirst?: boolean } = {}) {
    let calls = 0;
    const openFile = vi.fn(async () => {});
    const updateFile = vi.fn(async () => {});
    const didSave = vi.fn(async () => {});
    const getDiagnostics = vi.fn(async () => {
      calls++;
      if (opts.emptyFirst && calls === 1) return [];
      return diagnostics;
    });
    mockBridge = {
      isAvailable: () => true,
      openFile,
      updateFile,
      didSave,
      getDiagnostics,
    };
    return { openFile, updateFile, didSave, getDiagnostics };
  }

  it("appends a diagnostics block for a successful, unclaimed native write", async () => {
    const diagnostics: LSPDiagnostic[] = [
      { message: "Unused variable 'value'", severity: 2, range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } } },
    ];
    const { openFile, updateFile, didSave } = makeAvailableBridge(diagnostics);

    const result = await runPostEditDiagnosticsFallback({
      toolName: "write",
      toolCallId: "w-1",
      isError: false,
      input: { path: filePath },
      content: [{ type: "text", text: "wrote file" }],
      cwd: dir,
    }, { waitMs: 500, pollIntervalMs: 10 });

    expect(result).toBeDefined();
    expect(result!.content).toHaveLength(2);
    const block = (result!.content[1] as { text: string }).text;
    expect(block).toContain("[LSP diagnostics:");
    expect(block).toContain("warning");
    expect(block).toContain("Unused variable 'value'");
    expect(openFile).toHaveBeenCalled();
    expect(updateFile).toHaveBeenCalled();
    expect(didSave).toHaveBeenCalled();
  });

  it("appends a diagnostics block for a successful, unclaimed native edit", async () => {
    const diagnostics: LSPDiagnostic[] = [
      { message: "Type 'string' is not assignable to type 'number'", severity: 1, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } } },
    ];
    makeAvailableBridge(diagnostics);

    const result = await runPostEditDiagnosticsFallback({
      toolName: "edit",
      toolCallId: "e-1",
      isError: false,
      input: { path: filePath },
      content: [{ type: "text", text: "edited file" }],
      cwd: dir,
    }, { waitMs: 500, pollIntervalMs: 10 });

    expect(result).toBeDefined();
    const block = (result!.content[1] as { text: string }).text;
    expect(block).toContain("error");
    expect(block).toContain("not assignable");
  });

  it("skips the fallback when Pi-SmartEdit already claimed the toolCallId", async () => {
    const { openFile } = makeAvailableBridge([{ message: "should not appear" }]);
    claimsMap().set("claimed-1", Date.now());

    const result = await runPostEditDiagnosticsFallback({
      toolName: "write",
      toolCallId: "claimed-1",
      isError: false,
      input: { path: filePath },
      content: [{ type: "text", text: "wrote file" }],
      cwd: dir,
    }, { waitMs: 500, pollIntervalMs: 10 });

    expect(result).toBeUndefined();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("skips the fallback for an errored tool_result and never touches the bridge", async () => {
    const { openFile } = makeAvailableBridge([{ message: "should not appear" }]);

    const result = await runPostEditDiagnosticsFallback({
      toolName: "write",
      toolCallId: "w-err",
      isError: true,
      input: { path: filePath },
      content: [{ type: "text", text: "write failed" }],
      cwd: dir,
    }, { waitMs: 500, pollIntervalMs: 10 });

    expect(result).toBeUndefined();
    expect(openFile).not.toHaveBeenCalled();
  });

  it("no-ops when the LSP bridge is unavailable (null)", async () => {
    mockBridge = null;
    const result = await runPostEditDiagnosticsFallback({
      toolName: "write",
      toolCallId: "w-2",
      isError: false,
      input: { path: filePath },
      content: [{ type: "text", text: "wrote file" }],
      cwd: dir,
    }, { waitMs: 500, pollIntervalMs: 10 });

    expect(result).toBeUndefined();
  });

  it("proceeds when the bridge is non-null even if isAvailable() reports false (first-use init)", async () => {
    const openFile = vi.fn(async () => {});
    mockBridge = {
      isAvailable: () => false,
      openFile,
      updateFile: vi.fn(async () => {}),
      didSave: vi.fn(async () => {}),
      getDiagnostics: vi.fn(async () => [{ message: "first-use diagnostic", severity: 1 }]),
    };

    const result = await runPostEditDiagnosticsFallback({
      toolName: "write",
      toolCallId: "w-3",
      isError: false,
      input: { path: filePath },
      content: [{ type: "text", text: "wrote file" }],
      cwd: dir,
    }, { waitMs: 500, pollIntervalMs: 10 });

    expect(result).toBeDefined();
    expect(openFile).toHaveBeenCalled();
  });

  it("never throws and resolves promptly when diagnostics never arrive (bounded timeout, no hang)", async () => {
    makeAvailableBridge([], { emptyFirst: false });
    // getDiagnostics always resolves to [] — the wait loop must give up at
    // the configured (short) waitMs rather than polling forever.
    const start = Date.now();
    const result = await runPostEditDiagnosticsFallback({
      toolName: "write",
      toolCallId: "w-4",
      isError: false,
      input: { path: filePath },
      content: [{ type: "text", text: "wrote file" }],
      cwd: dir,
    }, { waitMs: 200, pollIntervalMs: 25 });
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(2000);
  });

  it("resolves promptly with a diagnostics block once a delayed publishDiagnostics lands within the wait window", async () => {
    const diagnostics: LSPDiagnostic[] = [{ message: "delayed diagnostic", severity: 1 }];
    makeAvailableBridge(diagnostics, { emptyFirst: true });

    const result = await runPostEditDiagnosticsFallback({
      toolName: "write",
      toolCallId: "w-5",
      isError: false,
      input: { path: filePath },
      content: [{ type: "text", text: "wrote file" }],
      cwd: dir,
    }, { waitMs: 500, pollIntervalMs: 10 });

    expect(result).toBeDefined();
    expect((result!.content[1] as { text: string }).text).toContain("delayed diagnostic");
  });

  it("normalizes line breaks in diagnostic messages so one message cannot exceed MAX_DIAGNOSTIC_LINES", () => {
    const block = formatDiagnosticsBlock([
      { message: "line one\nline two\r\nline three\rline four", severity: 1 },
    ], "example.ts");

    expect(block).toBeDefined();
    expect(block!.split("\n")).toHaveLength(2); // header + one normalized line
    expect(block).toContain("line one line two line three line four");
  });
});
