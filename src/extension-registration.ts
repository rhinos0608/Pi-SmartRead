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
import { createFindTool } from "./search/find-tool.js";
import { createLspTool } from "./lsp/lsp-tool.js";
import { createReadTool } from "./read/unified-read.js";
import { getLSPBridge } from "./lsp/lsp-bridge.js";
import { registerRepositoryIntelligence } from "./repository/repository-intelligence-registry.js";
import { createRepositoryIntelligenceService } from "./repository/repository-intelligence.js";
import { registerLanguageIntelligenceCommand } from "./language-intelligence/language-intelligence-command.js";
import { registerJudgeCommand } from "./judge/judge-command.js";
import { getSharedVonSidecarManager } from "./judge/von-sidecar.js";
import { resolvePiJudge } from "./judge/judge-runtime.js";
import { createLanguageIntelligenceProvider } from "./language-intelligence/language-intelligence-provider.js";
import { setWorkspaceEditBus } from "./lsp/lsp-workspace-edit.js";
import { resetDoomLoopState } from "./runtime/doom-loop.js";
import { getSmartReadToolGuidance } from "./runtime/tool-guidance.js";
import { logEffectiveAffordanceIdentity, recordEffectiveAffordanceIdentity, selectSurfaceVariants, type AffordanceSelectors } from "./runtime/affordances.js";
import type { ActivationState } from "./extension-lifecycle.js";

// ── Symbol resolution for read { symbol } (WP-5) ────────────────

// Canonical implementation lives in lsp-server-operation.ts (shared, cycle-free);
// re-exported here to preserve the public helper path (tests import from index.js).
import { lspUriToPath } from "./lsp/lsp-server-operation.js";
export { lspUriToPath };

/**
 * Fail-closed URI handling for LSP symbol hits: null/empty paths rejected.
 */
function symbolPathFromLspBest(
  best:
    | { location: { uri: string; range: { start: { line: number } } } }
    | undefined,
): { path: string; line: number } | null {
  if (!best) return null;
  const { uri, range } = best.location;
  const symbolPath = lspUriToPath(uri);
  if (!symbolPath) return null;
  return { path: symbolPath, line: range.start.line + 1 };
}

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
        const resolved = symbolPathFromLspBest(best);
        if (resolved) return resolved;
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

let piAffordanceSelectors: AffordanceSelectors | undefined;

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
  const selectors = state.affordanceSelectors;
  piAffordanceSelectors = selectors;
  const inspectDef = buildInspectTool(() => null, state.freshGraphGetter, getSharedLspInspectionProvider(), selectors.inspect.enabled);
  const guidance = getSmartReadToolGuidance("inspect", selectors.general.enabled, selectors.inspect.enabled);
  ToolRegistry.getInstance().registerOrReplace({
    name: "inspect",
    description: inspectDef.description,
    inputSchema: inspectDef.parameters as Record<string, unknown>,
    execute: inspectDef.execute,
    category: ToolCategory.READ,
    ...(guidance !== undefined
      ? { promptSnippet: guidance.snippet, promptGuidelines: [...guidance.guidelines] }
      : {}),
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
    judge: {
      resolveJudge: (root, runtimeContext) => resolvePiJudge(root ?? process.cwd(), runtimeContext),
      getGraphIfBuilt: getSharedContextGraphIfBuilt,
    },
  });
  const grepGuidance = getSmartReadToolGuidance("grep");
  ToolRegistry.getInstance().registerOrReplace({
    name: "grep",
    description: GREP_DESCRIPTION,
    inputSchema: grepDef.parameters as Record<string, unknown>,
    execute: grepDef.execute,
    category: ToolCategory.READ,
    ...(grepGuidance !== undefined
      ? { promptSnippet: grepGuidance.snippet, promptGuidelines: [...grepGuidance.guidelines] }
      : {}),
  });
  state.grepRegisteredRef.current = true;
}

export function registerLspTool(state: ActivationState, selectors: AffordanceSelectors): void {
  void state;
  const lspDef = createLspTool({ affordances: selectors.general.enabled });
  const lspGuidance = getSmartReadToolGuidance("LSP", selectors.general.enabled);
  ToolRegistry.getInstance().registerOrReplace({
    name: "LSP",
    description: lspDef.description,
    inputSchema: lspDef.parameters as Record<string, unknown>,
    execute: lspDef.execute,
    category: ToolCategory.READ,
    ...(lspGuidance !== undefined
      ? { promptSnippet: lspGuidance.snippet, promptGuidelines: [...lspGuidance.guidelines] }
      : {}),
  });
}

export function registerCoreTools(pi: ExtensionAPI): void {
  const reg = ToolRegistry.getInstance();
  for (const tool of reg.getAll()) {
    // Registry-carried fields win; otherwise fall back to per-tool guidance
    // by name (covers eagerly registered tools such as skill that were
    // registered before guidance existed). Tools without guidance (e.g.
    // experimental ones) register unchanged.
    const fallback = getSmartReadToolGuidance(tool.name);
    const promptSnippet = tool.promptSnippet ?? fallback?.snippet;
    const promptGuidelines = tool.promptGuidelines ??
      (fallback !== undefined ? [...fallback.guidelines] : undefined);
    pi.registerTool(
      toToolDefinition({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        execute: tool.execute,
        ...(promptSnippet !== undefined ? { promptSnippet } : {}),
        ...(promptGuidelines !== undefined ? { promptGuidelines } : {}),
      }),
    );
  }
  if (piAffordanceSelectors) {
    const selectors = piAffordanceSelectors;
    const inspect = reg.get("inspect");
    const lsp = reg.get("LSP");
    if (inspect && lsp) {
      const inspectGuidance = getSmartReadToolGuidance("inspect", selectors.general.enabled, selectors.inspect.enabled)!;
      const lspGuidance = getSmartReadToolGuidance("LSP", selectors.general.enabled)!;
      const variants = selectSurfaceVariants(selectors);
      recordEffectiveAffordanceIdentity(
        selectors, variants, lsp.inputSchema, lsp.description,
        [lspGuidance.snippet, ...lspGuidance.guidelines].join("\n"),
      );
      recordEffectiveAffordanceIdentity(
        selectors, variants, inspect.inputSchema, inspect.description,
        [inspectGuidance.snippet, ...inspectGuidance.guidelines].join("\n"), "inspect",
      );
      logEffectiveAffordanceIdentity();
    }
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
      editMode: state.editMode,
    }),
  );
}

/**
 * Register SmartRead's `find` AFTER registerCoreTools so the same-name
 * registration overrides pi's builtin `find` (same pattern as
 * registerReadTool overriding `read`). Resolver wiring mirrors grep:
 * best-effort publish, envelope in details stays authoritative.
 */
export function registerFindTool(pi: ExtensionAPI): void {
  const def = createFindTool({
    resolver: {
      publishInspection: (envelope, sessionFilePath, workspaceRoot) => {
        getSharedEvidenceResolver().publishInspection(envelope as any, sessionFilePath, workspaceRoot);
      },
    },
    getSessionFilePath: () => null,
    resolveJudge: (root, runtimeContext, signal) => resolvePiJudge(root, runtimeContext, signal),
  });
  pi.registerTool(def as any);
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

/**
 * Register the `/judge` command and wire von sidecar shutdown into the
 * activation state. Registration performs no network or process work;
 * the sidecar starts lazily on the first judged query.
 */
export function registerJudgeCommandStep(pi: ExtensionAPI, state: ActivationState): void {
  try {
    registerJudgeCommand(pi as any);
    state.judgeSidecarDispose = () => {
      try {
        getSharedVonSidecarManager().dispose();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* non-fatal: judging stays off */
  }
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
  // SmartEdit workspace-edit RPC bridge (Stage 4 option A): stage/apply
  // proposals over the live event bus. MCP stdio has no bus, so the bridge
  // stays null there and applyProposal returns unavailable.
  try {
    const editBus = pi.events as {
      emit: (c: string, d: unknown) => void;
      on: (c: string, h: (d: unknown) => void) => () => void;
    };
    if (editBus && typeof editBus.on === "function") setWorkspaceEditBus(editBus);
  } catch {
    /* non-fatal */
  }
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
