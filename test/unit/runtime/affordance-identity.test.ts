import { afterEach, expect, it, vi } from "vitest";

const PREFIX = "[pi-smartread:surface-identity] ";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

function spyOnIdentityWrites(onIdentityWrite: (line: string) => void) {
  return vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    if (typeof chunk === "string" && chunk.startsWith(PREFIX)) onIdentityWrite(chunk);
    return true;
  }) as typeof process.stderr.write);
}

function identityFromLine(line: string): unknown {
  return JSON.parse(line.slice(PREFIX.length));
}

function hasSchemaProperty(schema: Record<string, unknown> | undefined, name: string): boolean {
  const properties = schema?.properties;
  return typeof properties === "object" && properties !== null && name in properties;
}

it("binds the selected LSP and inspect schema, description, and guidance in every Pi selector arm", async () => {
    for (const [general, inspect] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      vi.stubEnv("PI_SMARTREAD_SURFACE_IDENTITY_LOG", "0");
      vi.resetModules();
      const affordances = await import("../../../src/runtime/affordances.js");
      const guidance = await import("../../../src/runtime/tool-guidance.js");
      const registration = await import("../../../src/extension-registration.js");
      const registryModule = await import("../../../src/tool-registry.js");
      const selectors = affordances.captureAffordanceSelectors({
        PI_SMARTREAD_AFFORDANCES: general ? "1" : "0",
        PI_SMARTREAD_INSPECT_AFFORDANCES: inspect ? "1" : "0",
      });
      const state = { affordanceSelectors: selectors, freshGraphGetter: async () => { throw new Error("unused"); } } as never;
      registration.registerInspectTool(state);
      registration.registerLspTool(state, selectors);
      registration.registerCoreTools({ registerTool: () => undefined } as never);

      const inspectTool = registryModule.ToolRegistry.getInstance().get("inspect")!;
      const lspTool = registryModule.ToolRegistry.getInstance().get("LSP")!;
      const inspectGuidance = guidance.getSmartReadToolGuidance("inspect", general, inspect)!;
      const lspGuidance = guidance.getSmartReadToolGuidance("LSP", general)!;
      const expected = affordances.surfaceIdentity(selectors, affordances.selectSurfaceVariants(selectors), {
        schema: lspTool.inputSchema,
        description: lspTool.description,
        guidance: [lspGuidance.snippet, ...lspGuidance.guidelines].join("\n"),
        inspect: {
          schema: inspectTool.inputSchema,
          description: inspectTool.description,
          guidance: [inspectGuidance.snippet, ...inspectGuidance.guidelines].join("\n"),
        },
      });
      expect(affordances.getEffectiveAffordanceIdentity()?.surfaceIdentity).toBe(expected);
      if (general && !inspect) expect(affordances.getEffectiveAffordanceIdentity()?.variants.note).toBe("wp-c-unbuilt");
    }
});

it("binds both MCP surfaces and host-reader inspect guidance for every selector arm", async () => {
    for (const [general, inspect] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      vi.stubEnv("PI_SMARTREAD_SURFACE_IDENTITY_LOG", "0");
      vi.stubEnv("PI_SMARTREAD_AFFORDANCES", general ? "1" : "0");
      vi.stubEnv("PI_SMARTREAD_INSPECT_AFFORDANCES", inspect ? "1" : "0");
      vi.resetModules();
      const mcp = await import("../../../src/mcp-registry.js");
      const affordances = await import("../../../src/runtime/affordances.js");
      const guidance = await import("../../../src/runtime/tool-guidance.js");
      const tools = mcp.buildToolRegistry();
      const lsp = tools.find((tool) => tool.name === "LSP")!;
      const inspectTool = tools.find((tool) => tool.name === "inspect")!;
      const selectors = mcp.getMcpAffordanceSelectors();
      const lspGuidance = guidance.getSmartReadToolGuidance("LSP", general)!;
      const inspectGuidance = guidance.getSmartReadToolGuidance("inspect", general, inspect, true)!;
      const expected = affordances.surfaceIdentity(selectors, affordances.selectSurfaceVariants(selectors), {
        schema: lsp.parameters,
        description: lsp.description,
        guidance: [lspGuidance.snippet, ...lspGuidance.guidelines].join("\n"),
        inspect: {
          schema: inspectTool.parameters,
          description: inspectTool.description,
          guidance: [inspectGuidance.snippet, ...inspectGuidance.guidelines].join("\n"),
        },
      });
      expect(affordances.getEffectiveAffordanceIdentity()?.surfaceIdentity).toBe(expected);
    }
});

it("logs the final Pi identity only after both selected tools are registered", async () => {
    vi.stubEnv("PI_SMARTREAD_SURFACE_IDENTITY_LOG", "1");
    vi.stubEnv("PI_SMARTREAD_AFFORDANCES", "1");
    vi.stubEnv("PI_SMARTREAD_INSPECT_AFFORDANCES", "1");
    const runtime: { registry?: typeof import("../../../src/tool-registry.js") } = {};
    const writes: string[] = [];
    let selectedAtWrite = false;
    spyOnIdentityWrites((line) => {
      writes.push(line);
      const inspect = runtime.registry?.ToolRegistry.getInstance().get("inspect");
      const lsp = runtime.registry?.ToolRegistry.getInstance().get("LSP");
      selectedAtWrite = hasSchemaProperty(inspect?.inputSchema, "view") && hasSchemaProperty(lsp?.inputSchema, "symbol");
    });

    vi.resetModules();
    const registration = await import("../../../src/extension-registration.js");
    const affordances = await import("../../../src/runtime/affordances.js");
    runtime.registry = await import("../../../src/tool-registry.js");
    expect(writes).toHaveLength(0);
    const selectors = affordances.captureAffordanceSelectors();
    const state = { affordanceSelectors: selectors, freshGraphGetter: async () => { throw new Error("unused"); } } as never;
    registration.registerInspectTool(state);
    registration.registerLspTool(state, selectors);
    expect(writes).toHaveLength(0);
    const registered: string[] = [];
    registration.registerCoreTools({ registerTool: (tool: { name: string }) => registered.push(tool.name) } as never);

    expect(registered).toContain("inspect");
    expect(registered).toContain("LSP");
    expect(selectedAtWrite).toBe(true);
    expect(writes).toHaveLength(1);
    expect(identityFromLine(writes[0]!)).toEqual(affordances.getEffectiveAffordanceIdentity());
});

it("does not log during eager MCP construction and logs once after the full tool list exists", async () => {
    vi.stubEnv("PI_SMARTREAD_SURFACE_IDENTITY_LOG", "1");
    vi.stubEnv("PI_SMARTREAD_AFFORDANCES", "1");
    vi.stubEnv("PI_SMARTREAD_INSPECT_AFFORDANCES", "1");
    const runtime: { registry?: typeof import("../../../src/tool-registry.js") } = {};
    const writes: string[] = [];
    let selectedAtWrite = false;
    spyOnIdentityWrites((line) => {
      writes.push(line);
      const inspect = runtime.registry?.ToolRegistry.getInstance().get("inspect");
      const lsp = runtime.registry?.ToolRegistry.getInstance().get("LSP");
      selectedAtWrite = hasSchemaProperty(inspect?.inputSchema, "view") && hasSchemaProperty(lsp?.inputSchema, "symbol");
    });

    vi.resetModules();
    const mcp = await import("../../../src/mcp-registry.js");
    const affordances = await import("../../../src/runtime/affordances.js");
    runtime.registry = await import("../../../src/tool-registry.js");
    expect(writes).toHaveLength(0);
    const tools = mcp.buildToolRegistry();
    expect(tools.map((tool) => tool.name)).toContain("inspect");
    expect(tools.map((tool) => tool.name)).toContain("LSP");
    expect(selectedAtWrite).toBe(true);
    expect(writes).toHaveLength(1);
    expect(identityFromLine(writes[0]!)).toEqual(affordances.getEffectiveAffordanceIdentity());
    mcp.buildToolRegistry();
    expect(writes).toHaveLength(1);
});
