import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDiagnosticActions } from "../../../scripts/eval/lsp-ergonomics/diagnostic-actions.js";

const server = { descriptorId: "srv", name: "fake", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16" as const };
const envelope = (operation: "diagnostics" | "codeActions", result: unknown, status: "ok" | "empty" = "ok", serverInfo = server) => ({
  status, operation, method: operation === "diagnostics" ? "textDocument/diagnostic" : "textDocument/codeAction",
  server: serverInfo, result, meta: { truncated: false, freshness: { state: "fresh" as const } },
});

async function fixture(run: Parameters<typeof discoverDiagnosticActions>[1]["execute"], input: Record<string, unknown> = {}, signal?: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), "lsp-actions-"));
  const path = join(dir, "a.ts");
  const source = "const x = '😀';\r\n";
  await writeFile(path, source, "utf8");
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const execute = async (request: Parameters<typeof run>[0], deps?: Parameters<typeof run>[1]) => {
    const result = await run(request, deps);
    if (request.operation !== "codeActions" || !Array.isArray(result.result)) return result;
    return { ...result, result: result.result.map((row, index) => row && typeof row === "object" ? { ...row, actionId: `Fixture:Row:${index}`, sourceSha256 } : row) };
  };
  try {
    return await discoverDiagnosticActions({ path, ...input }, { cwd: dir, execute, ...(signal ? { signal } : {}) });
  } finally {
    const after = await readFile(path);
    expect(after.toString("utf8")).toBe("const x = '😀';\r\n");
    await rm(dir, { recursive: true, force: true });
  }
}

describe("diagnostic/action discovery seam", () => {
  it("queries actions after confirmed empty diagnostics and returns source actions", async () => {
    const execute = vi.fn(async (request: { operation: string }) => request.operation === "diagnostics"
      ? envelope("diagnostics", [], "empty")
      : envelope("codeActions", [{ title: "Organize", kind: "source.organizeImports", edit: { changes: [] }, data: { token: "x" } }]));
    const result = await fixture(execute, { kind: "source.organizeImports" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.diagnostics.status).toBe("confirmed-empty");
    expect(result.options).toHaveLength(1);
    expect(result.options[0]?.title).toBe("Organize");
  });

  it("passes complete overlapping diagnostics, not bare ranges, to code actions", async () => {
    const inside = { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } }, message: "Unknown name", severity: 1, code: "missing-name", source: "fake", data: { ticket: 3 } };
    const outside = { range: { start: { line: 0, character: 12 }, end: { line: 0, character: 15 } }, message: "Outside selection" };
    const execute = vi.fn(async (request: { operation: string }) => request.operation === "diagnostics"
      ? envelope("diagnostics", [inside, outside]) : envelope("codeActions", [], "empty"));
    const result = await fixture(execute, { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } } });
    expect(result.steps[1]?.request.context).toEqual({ diagnostics: [inside], only: ["quickfix"] });
  });

  it("keeps hierarchical kinds, unresolved actions, and optional action kinds eligible", async () => {
    const actions = [
      { title: "Lint fixes", kind: "source.fixAll.eslint", edit: { changes: [] } },
      { title: "Resolve fixes", kind: "source.fixAll", data: { ticket: 2 } },
      { title: "Unclassified fix", edit: { changes: [] } },
    ];
    const execute = vi.fn(async (request: { operation: string }) => request.operation === "diagnostics"
      ? envelope("diagnostics", [], "empty") : envelope("codeActions", actions));
    const result = await fixture(execute, { kind: "source.fixAll" });
    expect(result.options.map((option) => option.title)).toEqual(actions.map((action) => action.title));
    expect(result.actions.omitted).toEqual({});
    expect(result.details.candidates).toEqual(actions.map((action, index) => ({ ...action, actionId: `Fixture:Row:${index}`, sourceSha256: createHash("sha256").update("const x = '😀';\r\n").digest("hex") })));
  });

  it("does not bind synthetic failed-diagnostic encoding to explicit-range actions", async () => {
    const action = { title: "Fix", kind: "quickfix", edit: { changes: [] } };
    const execute = vi.fn(async (request: { operation: string }) => request.operation === "diagnostics"
      ? { ...envelope("diagnostics", null), status: "not_ready" as const, server: { ...server, positionEncoding: "utf-8" as const }, meta: { truncated: false } }
      : envelope("codeActions", [action]));
    const result = await fixture(execute, { server: "srv", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.diagnostics.status).toBe("coverage-unconfirmed");
    expect(result.actions.status).toBe("confirmed");
    expect(result.options).toHaveLength(1);
  });

  it("does not infer a full-file range from unconfirmed diagnostics", async () => {
    const execute = vi.fn(async () => ({ ...envelope("diagnostics", [], "empty"), meta: { truncated: false } }));
    const result = await fixture(execute, { server: "srv" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.actions.status).toBe("coverage-unconfirmed");
  });

  it("allows explicit range actions despite unconfirmed diagnostics", async () => {
    const execute = vi.fn(async (request: { operation: string }) => request.operation === "diagnostics"
      ? { ...envelope("diagnostics", []), meta: { truncated: false } }
      : envelope("codeActions", [] , "empty"));
    const result = await fixture(execute, { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.actions.status).toBe("confirmed-empty");
    expect(result.diagnostics.status).toBe("coverage-unconfirmed");
  });

  it("rejects foreign runtime fields before filesystem and executor access", async () => {
    const execute = vi.fn();
    await expect(discoverDiagnosticActions({ path: "/missing", smuggle: true }, { cwd: "/", execute })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("retains completed steps when cancellation is observed after executor await", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async () => { controller.abort(); return envelope("diagnostics", [], "empty"); });
    const result = await fixture(execute, {}, controller.signal);
    expect(result.steps).toHaveLength(1);
    expect(result.diagnostics.status).toBe("cancelled");
  });
});
