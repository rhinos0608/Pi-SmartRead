/**
 * LSP capability registry (Wave 2 lane P).
 *
 * Fed by static initialize result plus dynamic client/registerCapability and
 * client/unregisterCapability. Every typed op asks registry first via can().
 * Removal stops issuance. Own module — never imports lsp-types owner file.
 */

export type LspFeatureId =
  | "definition"
  | "references"
  | "documentSymbol"
  | "implementation"
  | "hover"
  | "callHierarchy"
  | "rename"
  | "prepareRename"
  | "codeAction"
  | "formatting"
  | "workspaceSymbol"
  | "declaration"
  | "typeDefinition"
  | "diagnostics"
  | "workspaceDiagnostics";

/** Server capability key backing each typed feature. */
const FEATURE_TO_CAPABILITY_KEY: Record<LspFeatureId, string> = {
  definition: "definitionProvider",
  references: "referencesProvider",
  documentSymbol: "documentSymbolProvider",
  implementation: "implementationProvider",
  hover: "hoverProvider",
  callHierarchy: "callHierarchyProvider",
  rename: "renameProvider",
  prepareRename: "renameProvider",
  codeAction: "codeActionProvider",
  formatting: "documentFormattingProvider",
  workspaceSymbol: "workspaceSymbolProvider",
  declaration: "declarationProvider",
  typeDefinition: "typeDefinitionProvider",
  diagnostics: "diagnosticProvider",
  workspaceDiagnostics: "diagnosticProvider",
};

/** client/registerCapability method -> feature mapping. */
const REGISTER_METHOD_TO_FEATURE: Record<string, LspFeatureId> = {
  "textDocument/definition": "definition",
  "textDocument/references": "references",
  "textDocument/documentSymbol": "documentSymbol",
  "textDocument/implementation": "implementation",
  "textDocument/hover": "hover",
  "textDocument/prepareCallHierarchy": "callHierarchy",
  "textDocument/rename": "rename",
  "textDocument/prepareRename": "prepareRename",
  "textDocument/codeAction": "codeAction",
  "textDocument/formatting": "formatting",
  "workspace/symbol": "workspaceSymbol",
  "textDocument/declaration": "declaration",
  "textDocument/typeDefinition": "typeDefinition",
  "textDocument/diagnostic": "diagnostics",
  "workspace/diagnostic": "workspaceDiagnostics",
};

function capabilityPresent(caps: Record<string, unknown>, key: string): boolean {
  const v = caps[key];
  if (v === undefined || v === null || v === false) return false;
  return true;
}

/** Static workspace pull ⟺ diagnosticProvider is OBJECT with workspaceDiagnostics===true. */
function hasWorkspaceDiagnosticsSupport(caps: Record<string, unknown>): boolean {
  const dp = caps.diagnosticProvider;
  return !!dp && typeof dp === "object" && (dp as Record<string, unknown>).workspaceDiagnostics === true;
}

/** True only when renameProvider advertises prepare support (object with truthy prepareProvider). */
function hasRenamePrepareSupport(caps: Record<string, unknown>): boolean {
  const rp = caps.renameProvider;
  return !!rp && typeof rp === "object" && !!(rp as Record<string, unknown>).prepareProvider;
}

export interface Registration {
  id: string;
  method: string;
}

export class LspCapabilityRegistry {
  private staticCaps = new Set<LspFeatureId>();
  private dynamic = new Map<string, LspFeatureId>();

  private constructor() {}

  /** Build from static initialize result capabilities object. */
  static fromInitializeResult(initResult: unknown): LspCapabilityRegistry {
    const r = new LspCapabilityRegistry();
    let caps: Record<string, unknown> | null = null;
    try {
      const raw = (initResult as Record<string, unknown> | null)?.capabilities;
      if (raw && typeof raw === "object") caps = raw as Record<string, unknown>;
    } catch {
      caps = null;
    }
    if (!caps) return r;
    for (const [feature, key] of Object.entries(FEATURE_TO_CAPABILITY_KEY)) {
      if (feature === "prepareRename") continue;
      if (feature === "workspaceDiagnostics") continue;
      if (capabilityPresent(caps, key)) r.staticCaps.add(feature as LspFeatureId);
    }
    // workspaceDiagnostics exactness: boolean-true or object-without-flag = file pull only.
    if (hasWorkspaceDiagnosticsSupport(caps)) r.staticCaps.add("workspaceDiagnostics");
    // prepareRename requires renameProvider with prepare support flag — a bare
    // renameProvider (boolean true or object without prepareProvider) is rename only.
    if (hasRenamePrepareSupport(caps)) r.staticCaps.add("prepareRename");
    return r;
  }

  /** Handle client/registerCapability params ({ registrations: [{id, method}] }). */
  register(params: unknown): void {
    const regs = (params as { registrations?: Registration[] } | null)?.registrations;
    if (!Array.isArray(regs)) return;
    for (const reg of regs) {
      if (!reg || typeof reg.id !== "string" || typeof reg.method !== "string") continue;
      const feature = REGISTER_METHOD_TO_FEATURE[reg.method];
      if (feature) this.dynamic.set(reg.id, feature);
    }
  }

  /** Handle client/unregisterCapability params ({ unregisterations: [{id, method}] }). */
  unregister(params: unknown): void {
    const unregs = (params as { unregisterations?: Registration[] } | null)?.unregisterations;
    if (!Array.isArray(unregs)) return;
    for (const unreg of unregs) {
      if (!unreg || typeof unreg.id !== "string") continue;
      this.dynamic.delete(unreg.id);
    }
  }

  /** Every typed op asks this first. True from static caps or live dynamic. */
  can(feature: LspFeatureId): boolean {
    if (this.staticCaps.has(feature)) return true;
    for (const f of this.dynamic.values()) if (f === feature) return true;
    return false;
  }

  /** Live dynamic features currently registered. */
  liveDynamicFeatures(): Set<LspFeatureId> {
    return new Set(this.dynamic.values());
  }

  snapshot(): { static: LspFeatureId[]; dynamic: LspFeatureId[] } {
    return { static: [...this.staticCaps], dynamic: [...this.dynamic.values()] };
  }
}

/**
 * Per-feature dynamicRegistration flags. Flip ONLY when live handling exists
 * (feature present in live set) — never blindly true.
 */
export function buildDynamicRegistrationFlags(
  live: ReadonlySet<LspFeatureId>,
): Record<LspFeatureId, { dynamicRegistration: boolean }> {
  const out = {} as Record<LspFeatureId, { dynamicRegistration: boolean }>;
  for (const feature of Object.keys(FEATURE_TO_CAPABILITY_KEY) as LspFeatureId[]) {
    out[feature] = { dynamicRegistration: live.has(feature) };
  }
  return out;
}
