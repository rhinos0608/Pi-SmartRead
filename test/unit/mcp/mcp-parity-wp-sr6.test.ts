/**
 * MCP parity verification for the canonical SmartRead surfaces.
 * Public inspect owns structural/architectural analysis; strict LSP owns
 * compiler-backed semantics; grep owns broad/structural discovery. Verify the
 * same split is exposed through the MCP registry/server and that MCP content
 * remains self-sufficient after rich `details` are dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { buildToolRegistry } from "../../../src/mcp-registry.js";
import { validateInspectionEnvelope } from "@rhinos0608/pi-workspace-protocol";

let workdir: string;

beforeEach(() => {
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-parity-wp6-")));
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(workdir, "src", "b.ts"), "export function foo(){ return 42; }\n", "utf8");
  writeFileSync(join(workdir, "hello.ts"), "export const hello = 'world';\nexport function greet(){ return hello; }\n", "utf8");
});

afterEach(() => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
});

function makeCtx(dir: string = workdir): any {
  return {
    cwd: dir,
    sessionManager: { getSessionFile: () => join(dir, "session.jsonl") },
  };
}

function toMcpContent(result: any): string {
  // MCP server maps result.content to {content, isError} and drops details
  return (result.content?.[0] as any)?.text ?? "";
}

function findTool(name: string): any {
  const tools = buildToolRegistry();
  const t = tools.find((x: any) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found in registry`);
  return t;
}

// ── MCP stdio helpers (exercise src/mcp-server.ts handlers, not registry direct) ──
const __filenameStdio = fileURLToPath(import.meta.url);
const __dirnameStdio = dirname(__filenameStdio);
const MCP_SERVER_PATH = join(__dirnameStdio, "../../../src/mcp-server.ts");
const requireStdio = createRequire(import.meta.url);
// --import requires a file:// URL on Windows (bare D:\ paths throw
// ERR_UNSUPPORTED_ESM_URL_SCHEME). Convert the resolved loader to a URL.
const TSX_LOADER_PATH = pathToFileURL(requireStdio.resolve("tsx")).href;
function mcpInit(): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } };
}
function mcpInited(): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
}
function callMcpViaStdio(msgs: Record<string, unknown> | Record<string, unknown>[], childCwd?: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("MCP server timeout")); }, timeoutMs);
    const child = spawn("node", ["--import", TSX_LOADER_PATH, MCP_SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"], cwd: childCwd ?? join(__dirnameStdio, "../../..") });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const responses: Record<string, unknown>[] = [];
    let pending = "";
    child.stdout.on("data", (d: Buffer) => {
      pending += d.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const raw of lines) { const l = raw.trim(); if (!l) continue; try { responses.push(JSON.parse(l)); } catch {} }
    });
    child.on("error", (e) => { clearTimeout(timeout); reject(e); });
    child.on("close", () => { clearTimeout(timeout); if (responses.length === 0) { reject(new Error("No JSON-RPC response" + stderr.slice(-500))); return; } resolve(responses[responses.length - 1]!); });
    const messages = Array.isArray(msgs) ? msgs : [msgs];
    const poll = setInterval(() => {
      if (stderr.includes("[pi-smartread] MCP server running on")) {
        clearInterval(poll);
        for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
        child.stdin.end();
      }
    }, 80);
  });
}

describe("MCP parity — canonical tool split", () => {
  it("tools/list exposes inspect, grep, LSP, and skill without edit/read mutation surfaces", () => {
    const tools = buildToolRegistry();
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("inspect");
    expect(names).toContain("grep");
    expect(names).toContain("find");
    expect(names).toContain("LSP");
    expect(names).toContain("skill");
    expect(names).not.toContain("pilens_definition");
    expect(names).not.toContain("pilens_references");
    expect(names).not.toContain("pilens_diagnostics");
    expect(names).not.toContain("structural_search");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("read");
  });

  it("schemas separate inspect structure from strict LSP semantics and keep grep.structural", () => {
    const inspect = findTool("inspect");
    const lsp = findTool("LSP");
    const grep = findTool("grep");
    const inspectSchema: any = inspect.parameters;
    const lspSchema: any = lsp.parameters;
    const grepSchema: any = grep.parameters;

    expect(inspectSchema.type).toBe("object");
    expect(inspectSchema.anyOf).toBeUndefined();
    expect(inspectSchema.oneOf).toBeUndefined();
    const iprops = inspectSchema.properties ?? {};
    expect(iprops.navigation).toBeUndefined();
    expect(iprops.diagnostics).toBeUndefined();
    expect(JSON.stringify(iprops.mode)).not.toContain("navigate");
    expect(inspectSchema.description).toMatch(/use LSP/i);

    expect(lspSchema.properties.operation.enum).toContain("goToDefinition");
    expect(lspSchema.properties.operation.enum).toContain("findReferences");
    expect(lspSchema.properties.operation.enum).toContain("diagnostics");
    expect(lspSchema.description).toMatch(/use inspect instead/i);

    const gprops = grepSchema.properties ?? grepSchema;
    expect(gprops.structural).toBeDefined();
    expect(gprops.structural.properties.skip).toBeDefined();
    expect(gprops.structural.properties.groupByFile).toBeDefined();
    const qprops = gprops.queries?.items?.properties ?? {};
    expect(qprops.structural).toBeDefined();
  });
});

describe("MCP parity — rendered text self-sufficient (MCP drops details)", () => {
  it("strict LSP result is self-sufficient JSON text and preserves its envelope in details", async () => {
    const lsp = findTool("LSP");
    const result: any = await lsp.execute("c", { operation: "capabilities" }, undefined, undefined, makeCtx());
    expect(result.details?.envelope).toBeDefined();
    expect(result.details.envelope.operation).toBe("capabilities");
    const parsed = JSON.parse(toMcpContent(result));
    expect(parsed).toEqual(result.details.envelope);
    expect(parsed.operation).toBe("capabilities");
    expect(typeof parsed.status).toBe("string");
  });

  it("strict LSP validation is reachable through the MCP registry", async () => {
    const lsp = findTool("LSP");
    await expect(
      lsp.execute("c", { operation: "workspaceSymbols", query: "a", path: "src" } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/foreign field "path"/);
    await expect(
      lsp.execute("c", { operation: "findReferences", path: "hello.ts" } as any, undefined, undefined, makeCtx()),
    ).rejects.toThrow(/requires field "position"/);
  });

  it("grep.structural ok: text contains header + status line + read args for each match (MCP drops details)", async () => {
    const grep = findTool("grep");
    // ensure at least one structural hit in this workdir
    writeFileSync(join(workdir, "src", "s.ts"), "console.log(a)\n", "utf8");
    const result: any = await grep.execute("c", { pattern: "console.log($ARG)", structural: {} }, undefined, undefined, makeCtx());
    expect(result.details?.structuralSearch).toBeDefined();
    expect(result.details.structuralSearch.schemaVersion).toBe(1);
    expect(validateInspectionEnvelope(result.details.workspaceEvidence).ok).toBe(true);
    const text = toMcpContent(result);
    if (result.details.structuralSearch.status === "unavailable") {
      // unavailable path is also self-sufficient in text
      expect(text).toContain("structural search unavailable");
      expect(text).toContain("structural: status=unavailable");
      expect(result.details.workspaceEvidence.resources.length).toBe(0);
    } else {
      expect(result.details.structuralSearch.status).toBe("ok");
      // canonical header self-describes structural search
      expect(text).toContain("[structural]");
      expect(text).toContain("structural: status=ok");
      expect(text).toContain("skip=");
      expect(text).toContain("groupByFile=");
      expect(text).toContain("total=");
      expect(text).toContain("shown=");
      expect(text).toContain("truncated=");
      // each match line has read={path:"...",offset:...,limit:...} — what an MCP client needs to fetch the hit
      expect(text).toContain('read={path:');
      expect(result.details.structuralSearch.matches[0]?.read).toBeDefined();
      expect(result.details.workspaceEvidence.resources[0]?.coverage).toBe("search-match");
    }
  });

  it("grep.structural unavailable forced: text explains reason and still shows status line (no silent zero)", async () => {
    const { _setUnavailableForTests, _resetAstGrepCacheForTests } = await import("../../../src/structural/structural-search.js");
    _setUnavailableForTests("forced unavailable for test");
    try {
      const grep = findTool("grep");
      const result: any = await grep.execute("c", { pattern: "console.log($ARG)", structural: {} }, undefined, undefined, makeCtx());
      expect(result.details.structuralSearch.status).toBe("unavailable");
      expect(result.details.structuralSearch.reason).toBeTruthy();
      const text = toMcpContent(result);
      expect(text).toContain("structural search unavailable");
      expect(text).toContain("structural: status=unavailable");
      expect(result.details.workspaceEvidence.resources.length).toBe(0);
      // not a silent zero — text explicitly says unavailable, not "(no structural matches)" alone
      expect(result.details.structuralSearch.status).not.toBe("ok");
    } finally {
      _resetAstGrepCacheForTests();
    }
  });

  it("grep.structural groupByFile: text still self-sufficient when grouping requested", async () => {
    const { isStructuralSearchAvailable } = await import("../../../src/structural/structural-search.js");
    if (!(await isStructuralSearchAvailable())) return;
    writeFileSync(join(workdir, "src", "g1.ts"), "console.log(x)\n", "utf8");
    writeFileSync(join(workdir, "src", "g2.ts"), "console.log(y)\n", "utf8");
    const grep = findTool("grep");
    const result: any = await grep.execute("c", { pattern: "console.log($ARG)", structural: { groupByFile: true } }, undefined, undefined, makeCtx());
    if (result.details.structuralSearch.status === "unavailable") return;
    expect(result.details.structuralSearch.groupByFile).toBe(true);
    const text = toMcpContent(result);
    expect(text).toContain("groupByFile=true");
  });
});

describe("MCP stdio round-trip (src/mcp-server.ts tools/list & tools/call, content-only, no details)", () => {
  const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../.."));
  let stdioDir: string = repoRoot;
  const stdioProbeDirs: string[] = [];
  beforeEach(() => {
    // Use repo root as cwd so LSP and graph-backed tools see a real project. Seed a tiny
    // file under repo for grep.structural uniqueness without polluting src/.
    stdioDir = repoRoot;
    const probeDir = join(repoRoot, ".tmp-mcp-sr6-" + Math.random().toString(36).slice(2));
    try { mkdirSync(probeDir, { recursive: true }); writeFileSync(join(probeDir, "s.ts"), "console.log(a)\n", "utf8"); stdioProbeDirs.push(probeDir); } catch {}
  });
  afterEach(() => {
    for (const d of stdioProbeDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it("tools/list via stdio exposes strict LSP and removes inspect navigation/diagnostics", async () => {
    const res = await callMcpViaStdio([mcpInit(), mcpInited(), { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }], stdioDir);
    const tools = (res.result as any)?.tools as any[];
    expect(Array.isArray(tools)).toBe(true);
    const inspect = tools.find((t) => t.name === "inspect");
    const lsp = tools.find((t) => t.name === "LSP");
    const grep = tools.find((t) => t.name === "grep");
    expect(inspect).toBeDefined();
    expect(lsp).toBeDefined();
    expect(grep).toBeDefined();
    expect(inspect.inputSchema.type).toBe("object");
    expect(inspect.inputSchema.properties.navigation).toBeUndefined();
    expect(inspect.inputSchema.properties.diagnostics).toBeUndefined();
    expect(lsp.inputSchema.properties.operation.enum).toContain("goToDefinition");
    expect(lsp.inputSchema.properties.operation.enum).toContain("diagnostics");
    expect(grep.inputSchema.properties.structural).toBeDefined();
    expect(tools.map((t) => t.name)).not.toContain("structural_search");
  }, 60_000);

  it("tools/call strict LSP via MCP handler returns content-only self-sufficient JSON", async () => {
    const { handleMcpToolCall } = await import("../../../src/mcp-server.js");
    const ctx = makeCtx();
    const mcpResult: any = await handleMcpToolCall("LSP", { operation: "capabilities" }, ctx as any);
    expect(mcpResult.isError).toBe(false);
    const text = mcpResult.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text);
    expect(parsed.operation).toBe("capabilities");
    expect(typeof parsed.status).toBe("string");
    expect((mcpResult as any).details).toBeUndefined();
  }, 90_000);

  it("tools/call rejects removed inspect navigate mode instead of routing it", async () => {
    const { handleMcpToolCall } = await import("../../../src/mcp-server.js");
    const ctx = makeCtx();
    const mcpResult: any = await handleMcpToolCall(
      "inspect",
      { mode: "navigate", path: "hello.ts", navigation: { operation: "documentSymbols" } } as any,
      ctx as any,
    );
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.content?.[0]?.text ?? "").toMatch(/Invalid params|file.*directory.*script/i);
  }, 90_000);

  it("tools/call grep structural via stdio returns MCP content only with status line and read hints", async () => {
    const res = await callMcpViaStdio([mcpInit(), mcpInited(), { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "grep", arguments: { pattern: "console.log($ARG)", structural: {} } } }], stdioDir);
    const result = res.result as any;
    expect(result.isError).toBe(false);
    const text = result.content?.[0]?.text ?? "";
    expect((result as any).details).toBeUndefined();
    if (text.includes("structural search unavailable")) {
      expect(text).toContain("structural: status=unavailable");
    } else {
      expect(text).toContain("[structural]");
      expect(text).toContain("structural: status=ok");
      expect(text).toContain('read={path:');
    }
  }, 60_000);
});
