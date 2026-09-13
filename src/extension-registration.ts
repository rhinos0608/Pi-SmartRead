/**
 * Extension registration — ordered tool + RPC wiring.
 *
 * Preserves the original src/index.ts activation order:
 * session hooks (with doom-reset wrapper) → inspect → grep →
 * core ToolRegistry loop → read → repository intelligence →
 * language-intelligence command → resolver + provider install.
 * All installs after repository intelligence are best-effort.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerSessionHooks } from "./hook.js";
import { initHandlers } from "./read/read-many.js";
import { ToolRegistry, ToolCategory } from "./tool-registry.js";
import { toToolDefinition } from "./types.js";
import "./mcp-registry.js";
import {
  buildInspectToolForExtension as buildInspectTool,
  installInspectAndResolver,
  getSharedEvidenceResolver,
  getSharedContextGraph,
  getWorkspaceRevision,
  getSharedContextGraphIfBuilt,
} from "./mcp-registry.js";
import type { ContextGraph } from "./context-graph.js";
import { getSharedLspInspectionProvider } from "./lsp/lsp-inspection.js";
import { createGrepTool, GREP_DESCRIPTION } from "./search/grep-tool.js";
import { createReadTool } from "./read/unified-read.js";
import { getLSPBridge } from "./lsp/lsp-bridge.js";
import { registerRepositoryIntelligence } from "./repository/repository-intelligence-registry.js";
import { createRepositoryIntelligenceService } from "./repository/repository-intelligence.js";
import { registerLanguageIntelligenceCommand } from "./language-intelligence/language-intelligence-command.js";
import { createLanguageIntelligenceProvider } from "./language-intelligence/language-intelligence-provider.js";
import { resetDoomLoopState } from "./runtime/doom-loop.js";
import type { ActivationState } from "./extension-lifecycle.js";

// ── Symbol resolution for read { symbol } (WP-5) ────────────────

// Canonical implementation lives in lsp-server-operation.ts (shared, cycle-free);
// re-exported here to preserve the public helper path (tests import from index.js).
import { lspUriToPath } from "./lsp/lsp-server-operation.js";
export { lspUriToPath };

/**
 * Resolve a qualified symbol name to a file path and optional line number.
 * Resolution order: LSP workspace/symbol first, then ContextGraph.findSymbolFiles() fallback.
 */
async function resolveSymbolForReadTool(
  symbol: string,
  cwd = process.cwd(),
  graphGetter?: (root: string) => ContextGraph | Promise<ContextGraph>,
): Promise<{ path: string; line?: number } | null> {
  const root = cwd;
  try {
    const bridge = await getLSPBridge();
    if (bridge?.isAvailable()) {
      const syms = await bridge.workspaceSymbol(symbol, root);
      if (syms.length > 0) {
        const best = syms.find((s) => s.name === symbol) ?? syms[0];
        if (best) {
          const { uri, range } = best.location;
          return { path: lspUriToPath(uri), line: range.start.line + 1 };
        }
      }
    }
  } catch {
    // LSP not available
  }
  try {
    const graph = graphGetter ? await graphGetter(root) : getSharedContextGraph(root);
    const files = await graph.findSymbolFiles(symbol);
    if (files.length > 0) {
      return { path: files[0]!.path };
    }
  } catch {
    // graph not built
  }
  return null;
}

// ── Ordered registration steps ───────────────────────────────────────

export function initInternalUrlHandlers(): void {
  initHandlers();
}

export function registerSessionHooksWithDoomReset(pi: ExtensionAPI, state: ActivationState): void {
  registerSessionHooks({
    ...pi,
    on: ((eventName: string, handler: (...args: any[]) => any) => {
      if (eventName === "session_start" || eventName === "before_agent_start") {
        return (pi.on as any)(eventName, (...args: any[]) => {
          resetDoomLoopState(state.doomLoopState);
          return handler(...args);
        });
      }
      return (pi.on as any)(eventName, handler);
    }) as ExtensionAPI["on"],
  } as ExtensionAPI);
}

export function registerInspectTool(state: ActivationState): void {
  // Unconditionally replace the eager MCP fallback with a Pi-runtime
  // definition wired to the dirty-aware freshGraphGetter.
  const inspectDef = buildInspectTool(() => null, state.freshGraphGetter, getSharedLspInspectionProvider());
  ToolRegistry.getInstance().registerOrReplace({
    name: "inspect",
    description: inspectDef.description,
    inputSchema: inspectDef.parameters as Record<string, unknown>,
    execute: inspectDef.execute,
    category: ToolCategory.READ,
  });
}

export function registerGrepTool(state: ActivationState): void {
  const grepDef = createGrepTool({
    contextGraph: state.freshGraphGetter,
    resolver: {
      publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
        getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
      },
    },
    // getSessionFilePath returns null so grep falls back to ctx at execute time.
    getSessionFilePath: () => null,
    getWorkspaceRevision,
    getSharedContextGraphIfBuilt,
  });
  ToolRegistry.getInstance().registerOrReplace({
    name: "grep",
    description: GREP_DESCRIPTION,
    inputSchema: grepDef.parameters as Record<string, unknown>,
    execute: grepDef.execute,
    category: ToolCategory.READ,
  });
  state.grepRegisteredRef.current = true;
}

export function registerCoreTools(pi: ExtensionAPI): void {
  const reg = ToolRegistry.getInstance();
  for (const tool of reg.getAll()) {
    pi.registerTool(
      toToolDefinition({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: tool.execute,
      }),
    );
  }
}

export function registerReadTool(pi: ExtensionAPI, state: ActivationState): void {
  // Override the builtin read with the enriched, evidence-emitting wrapper.
  // WP-5: inject LSP bridge symbol resolution for read { symbol: "..." }.
  pi.registerTool(
    createReadTool({
      publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
        getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
      },
      resolveSymbol: (s, cwd) => resolveSymbolForReadTool(s, cwd, state.freshGraphGetter),
    }),
  );
}

export function registerRepositoryIntelligenceBestEffort(): void {
  try {
    registerRepositoryIntelligence(createRepositoryIntelligenceService());
  } catch {
    /* already registered or module init issue — non-fatal */
  }
}

export function registerLanguageIntelligenceCommandStep(pi: ExtensionAPI): void {
  registerLanguageIntelligenceCommand(pi as any);
}

export function installResolverAndProviderBestEffort(pi: ExtensionAPI, state: ActivationState): void {
  if (!pi.events || typeof pi.events.on !== "function") return;
  void (async () => {
    try {
      const bus = pi.events as {
        emit: (c: string, d: unknown) => void;
        on: (c: string, h: (d: unknown) => void) => () => void;
      };
      await installInspectAndResolver(bus);
    } catch (err) {
      try {
        (pi as any).ui?.notify?.(
          `pi-workspace-protocol resolver unavailable: ${(err as Error).message}`,
        );
      } catch {
        /* ignore */
      }
    }
  })();
  // Language intelligence RPC provider (post-edit diagnostics)
  try {
    const liBus = pi.events as {
      emit: (c: string, d: unknown) => void;
      on: (c: string, h: (d: unknown) => void) => () => void;
    };
    const provider = createLanguageIntelligenceProvider(liBus as any);
    state.languageIntelligenceDispose = () => provider.dispose();
  } catch {
    /* non-fatal */
  }
}
