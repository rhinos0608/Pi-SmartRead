import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverDiagnosticActions } from "../../../scripts/eval/lsp-ergonomics/diagnostic-actions.js";
import { normalizeCodeActions } from "../../../src/lsp/lsp-response-normalizer.js";
import type { StrictEnvelope, StrictRequest } from "../../../src/lsp/lsp-strict-contract.js";

const server: NonNullable<StrictEnvelope["server"]> = {
  descriptorId: "contract-server", name: "fake", languageId: "typescript", projectRoot: "/", positionEncoding: "utf-16",
};
function envelope(request: StrictRequest, result: unknown, options: { truncated?: boolean; nextCursor?: string } = {}): StrictEnvelope {
  return {
    status: Array.isArray(result) && result.length === 0 ? "empty" : "ok",
    operation: request.operation,
    method: request.operation === "diagnostics" ? "textDocument/diagnostic" : "textDocument/codeAction",
    server,
    result,
    meta: { truncated: options.truncated ?? false, ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}), freshness: { state: "fresh" } },
  };
}
async function withSource<T>(text: string, run: (path: string, cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "diagnostic-contract-"));
  const path = join(cwd, "sample.ts");
  const bytes = Buffer.from(text, "utf8");
  await writeFile(path, bytes);
  try { return await run(path, cwd); }
  finally {
    expect(await readFile(path)).toEqual(bytes);
    await rm(cwd, { recursive: true, force: true });
  }
}
async function runFor(path: string, cwd: string, actions: unknown[] = [], diagnostics: unknown[] = [], meta: { truncated?: boolean; nextCursor?: string } = {}, fixtureActionIds: ReadonlyMap<number, string> = new Map()) {
  const normalized = normalizeCodeActions(actions);
  if (!normalized) throw new Error("fixture code actions failed normalization");
  const sourceSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  const bound = normalized.map((row, index) => ({ ...row, actionId: fixtureActionIds.get(index) ?? `Fixture:Row:${index}`, sourceSha256 }));
  const execute = async (request: StrictRequest): Promise<StrictEnvelope> => {
    if (request.operation === "diagnostics") return envelope(request, diagnostics);
    if (request.operation === "codeActions") return envelope(request, bound, meta);
    throw new Error(`unexpected request: ${request.operation}`);
  };
  return discoverDiagnosticActions({ path }, { cwd, execute });
}
const end = (line: number, character: number) => ({ start: { line: 0, character: 0 }, end: { line, character } });
const encodings = [
  ["utf-8", 5], ["utf-16", 3], ["utf-32", 2],
] as const;

describe("diagnostic/action discovery contract matrix", () => {
  it.each(encodings)("computes physical EOF for %s text without final newline", async (encoding, character) => {
    const serverInfo = { ...server, positionEncoding: encoding };
    await withSource("c😀", async (path, cwd) => {
      const execute = async (request: StrictRequest): Promise<StrictEnvelope> => {
        if (request.operation === "diagnostics") return { ...envelope(request, []), server: serverInfo };
        if (request.operation === "codeActions") return { ...envelope(request, []), server: serverInfo };
        throw new Error("unexpected request");
      };
      const result = await discoverDiagnosticActions({ path }, { cwd, execute });
      expect(result.steps[1]?.request.range).toEqual(end(0, character));
      expect(result.range).toEqual(end(0, character));
    });
  });

  it.each([
    ["BOM-only", "\uFEFF", [0, 3]],
    ["mixed CRLF and CR", "a\r\nb\rc😀", [2, 5]],
    ["empty", "", [0, 0]],
    ["trailing newline", "x\n", [1, 0]],
  ] as const)("computes EOF for %s using negotiated encoding", async (_label, text, _unused) => {
    await withSource(text, async (path, cwd) => {
      for (const [encoding, character] of encodings) {
        const serverInfo = { ...server, positionEncoding: encoding };
        const execute = async (request: StrictRequest): Promise<StrictEnvelope> => {
          if (request.operation === "diagnostics" || request.operation === "codeActions") return { ...envelope(request, []), server: serverInfo };
          throw new Error("unexpected request");
        };
        const result = await discoverDiagnosticActions({ path }, { cwd, execute });
        const [line, endCharacter] = text === "\uFEFF" ? [0, encoding === "utf-8" ? 3 : encoding === "utf-16" ? 1 : 1] : text === "a\r\nb\rc😀" ? [2, character] : text === "x\n" ? [1, 0] : [0, 0];
        expect(result.steps[1]?.request.range).toEqual(end(line, endCharacter));
        expect(result.range).toEqual(end(line, endCharacter));
      }
    });
  });

  it.each([100, 101])("reports action coverage for %i returned candidates", async (count) => {
    await withSource("x", async (path, cwd) => {
      const actions = Array.from({ length: count }, (_, index) => ({ title: `a${index}`, kind: "quickfix", data: { id: index } }));
      const result = await runFor(path, cwd, actions);
      expect(result.actions).toMatchObject({ count: 100, coverage: count === 100 ? "complete" : "incomplete" });
      expect(result.truncated).toBe(count > 100);
      expect(result.details.candidates).toHaveLength(100);
      expect(result.details.envelopes[1]?.result).toHaveLength(count);
    });
  });

  it("discloses diagnostics omitted by the local cap", async () => {
    await withSource("x", async (path, cwd) => {
      const diagnostics = Array.from({ length: 101 }, (_, index) => ({
        range: end(0, 1), message: `Diagnostic ${index}`, severity: 1,
      }));
      const result = await runFor(path, cwd, [{ title: "one", kind: "quickfix", data: { id: 1 } }], diagnostics);
      expect(result.diagnostics).toMatchObject({ count: 100, coverage: "incomplete" });
      expect(result.details.envelopes[0]?.result).toHaveLength(101);
      expect(result.truncated).toBe(true);
    });
  });

  it.each([
    { label: "object", result: {} }, { label: "null", result: null },
    { label: "string", result: "not diagnostics" }, { label: "missing range/message", result: [{}] },
    { label: "missing message", result: [{ range: end(0, 1) }] },
  ])("does not claim clean diagnostics for a malformed positive result: $label", async ({ result: malformed }) => {
    await withSource("x", async (path, cwd) => {
      const execute = async (request: StrictRequest): Promise<StrictEnvelope> => {
        if (request.operation !== "diagnostics") throw new Error("Malformed diagnostics must not establish default-range metadata");
        return envelope(request, malformed);
      };
      const result = await discoverDiagnosticActions({ path }, { cwd, execute });
      expect(result.diagnostics).toMatchObject({ status: "coverage-unconfirmed", count: null, coverage: "incomplete" });
      expect(result.range).toBeNull();
      expect(result.options).toEqual([]);
      expect(result.steps).toHaveLength(1);
    });
  });

  it("marks opaque cursors incomplete without following them", async () => {
    await withSource("x", async (path, cwd) => {
      const result = await runFor(path, cwd, [{ title: "fix", kind: "quickfix", data: { id: 1 } }], [], { nextCursor: "opaque" });
      expect(result.truncated).toBe(true);
      expect(result.actions.coverage).toBe("incomplete");
      expect(result.steps).toHaveLength(2);
    });
  });

  it("counts withheld duplicate identities as candidates and rejects ineligible action forms", async () => {
    await withSource("x", async (path, cwd) => {
      const actions = [
        { title: "duplicate", kind: "quickfix", data: { id: 1 } },
        { title: "duplicate", kind: "quickfix", data: { id: 1 } },
        { title: "disabled", kind: "quickfix", disabled: { reason: "no" } },
        { title: "command", kind: "quickfix", command: "run" },
        { title: "both", kind: "quickfix", command: "run", edit: { changes: { "file:///sample.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }] } } },
        { title: "wrong", kind: "source.fixAll", data: { id: 2 } },
        { title: "hierarchy", kind: "quickfix.refactor", data: { id: 3 } },
        { title: "missing kind", data: { id: 4 } },
        { title: "edit", kind: "quickfix", edit: { changes: { "file:///sample.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }] } } },
      ];
      const result = await runFor(path, cwd, actions, [], {}, new Map([[0, "Fixture:Row:duplicate"], [1, "Fixture:Row:duplicate"]]));
      expect(result.actions.count).toBe(9);
      expect(result.actions.omitted).toEqual({ "duplicate-identity": 2, disabled: 1, command: 2, "wrong-kind": 1 });
      expect(result.details.candidates).toHaveLength(9);
      expect(result.options.map((option) => option.title)).toEqual(["hierarchy", "missing kind", "edit"]);
      expect(result.options.map((option) => option.requiresResolution)).toEqual([true, true, false]);
    });
  });

  it("hashes nested prototype-looking action data without mutation or identity collision", async () => {
    await withSource("x", async (path, cwd) => {
      const nested: unknown = JSON.parse('{"__proto__":{"polluted":true},"id":1}');
      const result = await runFor(path, cwd, [
        { title: "nested", kind: "quickfix", data: nested },
        { title: "nested", kind: "quickfix", data: { id: 1 } },
      ]);
      expect(result.options).toHaveLength(2);
      expect(result.options[0]?.actionId).not.toBe(result.options[1]?.actionId);
      expect(Object.prototype).not.toHaveProperty("polluted");
      expect(Object.prototype.hasOwnProperty.call(nested, "__proto__")).toBe(true);
    });
  });
});
