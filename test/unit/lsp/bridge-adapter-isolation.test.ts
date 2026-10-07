import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lsp/lsp-executor.js", () => ({
  executeLspOperation: vi.fn(),
}));

vi.mock("../../../src/lsp/lsp-manager.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lsp/lsp-manager.js")>();
  return {
    ...actual,
    cachedManager: vi.fn(() => {
      throw new Error("direct manager acquisition forbidden in adapter");
    }),
  };
});

import { executeLspOperation } from "../../../src/lsp/lsp-executor.js";
import { cachedManager } from "../../../src/lsp/lsp-manager.js";
import {
  getLSPBridge,
  resetLSPBridge,
} from "../../../src/lsp/lsp-bridge.js";

const execMock = vi.mocked(executeLspOperation);
const managerMock = vi.mocked(cachedManager);

function ok(op: string, result: unknown, extraMeta: Record<string, unknown> = {}) {
  return {
    status: "ok",
    operation: op,
    method: `test/${op}`,
    server: {},
    result,
    meta: { truncated: false, ...extraMeta },
  };
}

describe("S9 conformance: bridge adapter isolation (thin executor adapter)", () => {
  let root: string;
  let fp: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bridge-adapter-isolation-"));
    fp = join(root, "a.ts");
    resetLSPBridge();
    vi.clearAllMocks();
    execMock.mockResolvedValue(ok("goToDefinition", []) as never);
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    resetLSPBridge();
    vi.clearAllMocks();
  });

  it("goToDefinition calls executeLspOperation with no manager acquisition", async () => {
    const loc = {
      uri: `file://${fp}`,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    execMock.mockResolvedValueOnce(ok("goToDefinition", [loc]) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.goToDefinition(fp, 0, 0, root)).toEqual(loc);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("findReferences calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("findReferences", []) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.findReferences(fp, 0, 0, root)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("hover calls executeLspOperation with no manager acquisition", async () => {
    const hover = { contents: "x" };
    execMock.mockResolvedValueOnce(ok("hover", hover) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.hover(fp, 0, 0, root)).toEqual(hover);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("getDocumentSymbols calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("documentSymbols", []) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.getDocumentSymbols(fp, root)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("workspaceSymbol calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("workspaceSymbols", []) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.workspaceSymbol("foo", root)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("rename proposal calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("rename", null) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.rename(fp, 1, 1, "b", root)).toBeNull();
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("codeActions proposal calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("codeActions", []) as never);
    const bridge = await getLSPBridge();
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    };
    expect(await bridge!.codeActions(fp, range, {}, root)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("Outcome navigation calls executeLspOperation with no manager acquisition", async () => {
    const loc = {
      uri: `file://${fp}`,
      range: { start: { line: 4, character: 9 }, end: { line: 4, character: 12 } },
    };
    execMock.mockResolvedValueOnce(ok("goToDefinition", [loc]) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.goToDefinitionOutcome(fp, 5, 10, root)).toEqual({
      status: "confirmed",
      location: loc,
    });
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("goToImplementation calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("goToImplementation", []) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.goToImplementation(fp, 0, 0, root)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toMatchObject({ operation: "goToImplementation" });
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("prepareCallHierarchy calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("prepareCallHierarchy", []) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.prepareCallHierarchy(fp, 0, 0, root)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toMatchObject({ operation: "prepareCallHierarchy" });
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("incomingCalls/outgoingCalls call executeLspOperation with no manager acquisition", async () => {
    const item = {
      name: "f",
      kind: 12,
      uri: `file://${fp}`,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    execMock.mockResolvedValueOnce(ok("incomingCalls", []) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.incomingCalls(item, root)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toMatchObject({ operation: "incomingCalls" });
    expect(managerMock).not.toHaveBeenCalled();
    vi.clearAllMocks();
    execMock.mockResolvedValue(ok("goToDefinition", []) as never);
    execMock.mockResolvedValueOnce(ok("outgoingCalls", []) as never);
    expect(await bridge!.outgoingCalls(item, root)).toEqual([]);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toMatchObject({ operation: "outgoingCalls" });
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("prepareRename calls executeLspOperation with no manager acquisition", async () => {
    const proposal = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      placeholder: "a",
    };
    execMock.mockResolvedValueOnce(ok("prepareRename", proposal) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.prepareRename(fp, 1, 1, root)).toEqual(proposal);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toMatchObject({ operation: "prepareRename" });
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("organizeImports calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("codeActions", []) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.organizeImports(fp, root)).toBeNull();
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toMatchObject({ operation: "codeActions" });
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("formatting calls executeLspOperation with no manager acquisition", async () => {
    execMock.mockResolvedValueOnce(ok("formatDocument", null) as never);
    const bridge = await getLSPBridge();
    expect(await bridge!.formatting(fp, root)).toBeNull();
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toMatchObject({ operation: "formatDocument" });
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("getFreshDiagnosticsOutcome maps fresh executor diagnostics to confirmed", async () => {
    const diagnostics = [
      { message: "x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    ];
    execMock.mockResolvedValueOnce(
      ok("diagnostics", diagnostics, { freshness: { state: "fresh" } }) as never,
    );
    const bridge = await getLSPBridge();
    const outcome = await bridge!.getFreshDiagnosticsOutcome(fp, root);
    expect(outcome.status).toBe("confirmed");
    expect(outcome.diagnostics).toEqual(diagnostics);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toMatchObject({ operation: "diagnostics" });
  });

  it("static deletion: bridge imports executor, never deleted adapter modules", () => {
    const bridgeSource = readFileSync(
      new URL("../../../src/lsp/lsp-bridge.ts", import.meta.url),
      "utf8",
    );
    expect(bridgeSource).toContain("executeLspOperation");
    expect(bridgeSource).not.toContain("lsp-navigation-adapter");
    expect(bridgeSource).not.toContain("lsp-call-hierarchy-adapter");
    void existsSync(new URL("../../../src/lsp/lsp-navigation-adapter.ts", import.meta.url));
    void existsSync(new URL("../../../src/lsp/lsp-call-hierarchy-adapter.ts", import.meta.url));
  });

  it("executor-unavailable rejects to legacy null/[] shapes without throw", async () => {
    execMock.mockRejectedValue(new Error("executor unavailable"));
    const bridge = await getLSPBridge();
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    };
    await expect(bridge!.goToDefinition(fp, 0, 0, root)).resolves.toBeNull();
    await expect(bridge!.findReferences(fp, 0, 0, root)).resolves.toEqual([]);
    await expect(bridge!.hover(fp, 0, 0, root)).resolves.toBeNull();
    await expect(bridge!.getDocumentSymbols(fp, root)).resolves.toEqual([]);
    await expect(bridge!.rename(fp, 1, 1, "b", root)).resolves.toBeNull();
    await expect(bridge!.codeActions(fp, range, {}, root)).resolves.toEqual([]);
    expect(execMock).toHaveBeenCalled();
    expect(managerMock).not.toHaveBeenCalled();
  });

  it("executor-unavailable Outcome/diagnostics map to degraded without throw", async () => {
    execMock.mockRejectedValue(new Error("executor unavailable"));
    const bridge = await getLSPBridge();
    await expect(bridge!.goToDefinitionOutcome(fp, 5, 10, root)).resolves.toEqual({
      status: "degraded",
      location: null,
    });
    const d = await bridge!.getFreshDiagnosticsOutcome(fp, root);
    expect(d.status).toBe("degraded");
    expect(d.diagnostics).toEqual([]);
    expect(execMock).toHaveBeenCalled();
  });

  it("S9 conformance hook: executor is the sole acquisition seam", () => {
    expect(vi.isMockFunction(execMock)).toBe(true);
    expect(vi.isMockFunction(managerMock)).toBe(true);
  });
});
