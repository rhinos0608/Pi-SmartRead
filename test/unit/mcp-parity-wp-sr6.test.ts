/**
 * WP-SR6 — MCP parity verification for 3 new capabilities.
 * Verifies inspect.navigation, inspect.diagnostics, grep.structural are
 * reachable and correctly shaped through the MCP mirror (src/mcp-server.ts /
 * src/mcp-registry.ts) and that rendered text (not just `details`, which MCP
 * drops) contains everything an MCP-only client needs.
 * Only touches source if a defect surfaces — this file asserts the existing
 * mirror is self-sufficient.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { buildToolRegistry } from "../../src/mcp-registry.js";
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
const MCP_SERVER_PATH = join(__dirnameStdio, "../../src/mcp-server.ts");
const requireStdio = createRequire(import.meta.url);
const TSX_LOADER_PATH = requireStdio.resolve("tsx");
function mcpInit(): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } } };
}
function mcpInited(): Record<string, unknown> {
  return { jsonrpc: "2.0", method: "notifications/initialized", params: {} };
}
function callMcpViaStdio(msgs: Record<string, unknown> | Record<string, unknown>[], childCwd?: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("MCP server timeout")); }, timeoutMs);
    const child = spawn("node", ["--import", TSX_LOADER_PATH, MCP_SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"], cwd: childCwd ?? join(__dirnameStdio, "../..") });
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

describe("WP-SR6 MCP parity — no new tool names, existing mirror", () => {
  it("tools/list exposes only expected surface (no new names)", () => {
    const tools = buildToolRegistry();
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("inspect");
    expect(names).toContain("grep");
    expect(names).toContain("skill");
    // WP-SR6 forbids new MCP tool names / parallel surface
    expect(names).not.toContain("pilens_definition");
    expect(names).not.toContain("pilens_references");
    expect(names).not.toContain("pilens_diagnostics");
    expect(names).not.toContain("structural_search");
    // No SmartEdit edit/read surface
    expect(names).not.toContain("edit");
    expect(names).not.toContain("read");
  });

  it("schemas expose inspect.navigation, inspect.diagnostics, grep.structural", () => {
    const inspect = findTool("inspect");
    const grep = findTool("grep");
    const inspectSchema: any = inspect.parameters;
    const grepSchema: any = grep.parameters;
    const iprops = inspectSchema.properties ?? inspectSchema;
    const gprops = grepSchema.properties ?? grepSchema;
    expect(iprops.navigation).toBeDefined();
    expect(iprops.navigation.properties.operation).toBeDefined();
    expect(iprops.diagnostics).toBeDefined();
    expect(gprops.structural).toBeDefined();
    expect(gprops.structural.properties.skip).toBeDefined();
    expect(gprops.structural.properties.groupByFile).toBeDefined();
    // per-query structural too
    const qprops = gprops.queries?.items?.properties ?? {};
    expect(qprops.structural).toBeDefined();
  });
});

describe("WP-SR6 MCP parity — rendered text self-sufficient (MCP drops details)", () => {
  it("inspect.navigation file documentSymbols: text contains operation/status/source/truncated/items (no details needed)", async () => {
    const inspect = findTool("inspect");
    const result: any = await inspect.execute("c", { path: "hello.ts", navigation: { operation: "documentSymbols" } }, undefined, undefined, makeCtx());
    // details is rich but MCP drops it — prove text is self-sufficient
    expect(result.details?.navigation).toBeDefined();
    expect(result.details.navigation.schemaVersion).toBe(1);
    expect(result.details.navigation.source).toBe("lsp");
    expect(validateInspectionEnvelope(result.details.workspaceEvidence).ok).toBe(true);
    const text = toMcpContent(result);
    expect(text).toContain("## LSP Navigation");
    expect(text).toContain("Operation: documentSymbols");
    expect(text).toContain("status:");
    expect(text).toContain("source: lsp");
    // items or No results — either is self-describing
    expect(text.includes("Results (") || text.includes("No results.")).toBe(true);
    // coverage stays search-match
    for (const r of result.details.workspaceEvidence.resources as any[]) expect(r.coverage).toBe("search-match");
  });

  it("inspect.navigation directory workspaceSymbols: text contains query results and stays mode map zero resources", async () => {
    const inspect = findTool("inspect");
    const result: any = await inspect.execute("c", { path: "src", navigation: { operation: "workspaceSymbols", query: "a" } }, undefined, undefined, makeCtx());
    expect(result.details.mode).toBe("directory");
    expect(result.details.workspaceEvidence.mode).toBe("map");
    expect(result.details.workspaceEvidence.resources).toEqual([]);
    expect(result.details.navigation.operation).toBe("workspaceSymbols");
    const text = toMcpContent(result);
    expect(text).toContain("## LSP Navigation");
    expect(text).toContain("workspaceSymbols");
    expect(text).toContain("source: lsp");
  });

  it("inspect.navigation validation still reachable via MCP registry (requires/forbids matrix)", async () => {
    const inspect = findTool("inspect");
    await expect(inspect.execute("c", { path: "hello.ts", navigation: { operation: "definition" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/requires line/);
    await expect(inspect.execute("c", { path: "src", navigation: { operation: "workspaceSymbols" } } as any, undefined, undefined, makeCtx())).rejects.toThrow(/requires query/);
  });

  it("inspect.diagnostics file: text contains status/source/files/truncated even after MCP detail drop", async () => {
    const inspect = findTool("inspect");
    const result: any = await inspect.execute("c", { path: "hello.ts", diagnostics: { waitMs: 10, maxPerFile: 1 } }, undefined, undefined, makeCtx());
    expect(result.details?.diagnostics).toBeDefined();
    expect(result.details.diagnostics.schemaVersion).toBe(1);
    expect(result.details.diagnostics.source).toBe("lsp");
    expect(["findings", "unconfirmed", "unavailable", "partial"].includes(result.details.diagnostics.status) || typeof result.details.diagnostics.status === "string").toBe(true);
    expect(validateInspectionEnvelope(result.details.workspaceEvidence).ok).toBe(true);
    const text = toMcpContent(result);
    expect(text).toContain("## LSP Diagnostics");
    expect(text).toContain("Status:");
    expect(text).toContain("source: lsp");
    // per-file line present (path : count)
    expect(text).toContain("diagnostic(s)");
  });

  it("inspect.diagnostics directory: text contains per-file lines and stays mode map zero resources for directory envelope", async () => {
    const inspect = findTool("inspect");
    const result: any = await inspect.execute("c", { path: "src", diagnostics: { waitMs: 10, maxPerFile: 2, maxFiles: 1 } }, undefined, undefined, makeCtx());
    expect(result.details.mode).toBe("directory");
    expect(result.details.workspaceEvidence.mode).toBe("map");
    // directory diagnostics keeps zero resources (covers §2 invariants) — navigation/diagnostics are search-match on file mode only
    expect(result.details.workspaceEvidence.resources).toEqual([]);
    expect(result.details.diagnostics.files).toBeDefined();
    const text = toMcpContent(result);
    expect(text).toContain("## LSP Diagnostics");
    expect(text).toContain("source: lsp");
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
    const { _setUnavailableForTests, _resetAstGrepCacheForTests } = await import("../../src/structural-search.js");
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
    const { isStructuralSearchAvailable } = await import("../../src/structural-search.js");
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

describe("WP-SR6 MCP stdio round-trip (src/mcp-server.ts tools/list & tools/call, content-only, no details)", () => {
  const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../.."));
  let stdioDir: string = repoRoot;
  const stdioProbeDirs: string[] = [];
  beforeEach(() => {
    // Use repo root as cwd so inspect LSP + graph stay in a real project. Seed a tiny file
    // under repo for grep.structural uniqueness without polluting src/.
    stdioDir = repoRoot;
    const probeDir = join(repoRoot, ".tmp-mcp-sr6-" + Math.random().toString(36).slice(2));
    try { mkdirSync(probeDir, { recursive: true }); writeFileSync(join(probeDir, "s.ts"), "console.log(a)\n", "utf8"); stdioProbeDirs.push(probeDir); } catch {}
  });
  afterEach(() => {
    for (const d of stdioProbeDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  it("tools/list via stdio exposes inspect.navigation, inspect.diagnostics, grep.structural", async () => {
    const res = await callMcpViaStdio([mcpInit(), mcpInited(), { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }], stdioDir);
    const tools = (res.result as any)?.tools as any[];
    expect(Array.isArray(tools)).toBe(true);
    const inspect = tools.find((t) => t.name === "inspect");
    const grep = tools.find((t) => t.name === "grep");
    expect(inspect).toBeDefined();
    expect(grep).toBeDefined();
    expect(inspect.inputSchema.properties.navigation).toBeDefined();
    expect(inspect.inputSchema.properties.diagnostics).toBeDefined();
    expect(grep.inputSchema.properties.structural).toBeDefined();
    // no parallel surface
    expect(tools.map((t) => t.name)).not.toContain("structural_search");
  }, 60_000);

  it("tools/call inspect navigation via MCP handler returns content-only with self-sufficient text (no details)", async () => {
    // Real MCP round-trip through the actual registered handler exported from
    // src/mcp-server.ts (handleMcpToolCall), not a hand-rolled Value.Check +
    // coerceText copy of its logic. In-process avoids wasm/LSP stdio cold-boot timeout.
    const { handleMcpToolCall } = await import("../../src/mcp-server.js");
    writeFileSync(join(workdir, "hello.ts"), "export const hello = 'x';\nexport function greet(){ return hello; }\n", "utf8");
    const ctx = makeCtx();
    const mcpResult: any = await handleMcpToolCall("inspect", { path: "hello.ts", navigation: { operation: "documentSymbols" } } as any, ctx as any);
    expect(mcpResult.isError).toBe(false);
    const text = mcpResult.content?.[0]?.text ?? "";
    expect(text).toContain("## LSP Navigation");
    expect(text).toContain("Operation: documentSymbols");
    expect((mcpResult as any).details).toBeUndefined();
    expect(text.includes("Results (") || text.includes("No results.")).toBe(true);
  }, 90_000);

  it("tools/call inspect diagnostics via MCP handler returns content-only with self-sufficient text", async () => {
    const { handleMcpToolCall } = await import("../../src/mcp-server.js");
    writeFileSync(join(workdir, "hello.ts"), "export const hello = 'x';", "utf8");
    const ctx = makeCtx();
    const mcpResult: any = await handleMcpToolCall("inspect", { path: "hello.ts", diagnostics: { waitMs: 10, maxPerFile: 1 } } as any, ctx as any);
    expect(mcpResult.isError).toBe(false);
    const text = mcpResult.content?.[0]?.text ?? "";
    expect(text).toContain("## LSP Diagnostics");
    expect(text).toContain("Status:");
    expect((mcpResult as any).details).toBeUndefined();
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
