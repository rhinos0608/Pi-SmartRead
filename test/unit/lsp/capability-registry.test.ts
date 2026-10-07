import { describe, expect, it } from "vitest";
import {
  buildDynamicRegistrationFlags,
  LspCapabilityRegistry,
} from "../../../src/lsp/lsp-capability-registry.js";

describe("capability registry static", () => {
  it("yes: static caps enable typed ops", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({
      capabilities: { definitionProvider: true, hoverProvider: { contentFormat: ["markdown"] } },
    });
    expect(r.can("definition")).toBe(true);
    expect(r.can("hover")).toBe(true);
  });
  it("no: absent caps deny typed ops", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({ capabilities: {} });
    expect(r.can("definition")).toBe(false);
    expect(r.can("rename")).toBe(false);
    const empty = LspCapabilityRegistry.fromInitializeResult(null);
    expect(empty.can("hover")).toBe(false);
  });
});

describe("capability registry dynamic add/remove", () => {
  it("dynamic register enables, unregister stops issuance", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({ capabilities: {} });
    expect(r.can("definition")).toBe(false);
    r.register({ registrations: [{ id: "d1", method: "textDocument/definition" }] });
    expect(r.can("definition")).toBe(true);
    r.unregister({ unregisterations: [{ id: "d1", method: "textDocument/definition" }] });
    expect(r.can("definition")).toBe(false);
  });
  it("unknown methods ignored; malformed params safe", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({ capabilities: {} });
    r.register({ registrations: [{ id: "x", method: "custom/magic" }] });
    expect(r.can("definition")).toBe(false);
    r.register(null);
    r.unregister(undefined);
    expect(r.can("definition")).toBe(false);
  });
});

describe("dynamicRegistration flags", () => {
  it("flip only when live handling exists", () => {
    const none = buildDynamicRegistrationFlags(new Set());
    expect(none.definition.dynamicRegistration).toBe(false);
    const live = buildDynamicRegistrationFlags(new Set(["definition", "hover"]));
    expect(live.definition.dynamicRegistration).toBe(true);
    expect(live.hover.dynamicRegistration).toBe(true);
    expect(live.rename.dynamicRegistration).toBe(false);
  });
  it("prepareRename requires prepareProvider, not bare renameProvider", () => {
    const bare = LspCapabilityRegistry.fromInitializeResult({ capabilities: { renameProvider: true } });
    expect(bare.can("rename")).toBe(true);
    expect(bare.can("prepareRename")).toBe(false);
    const noPrepare = LspCapabilityRegistry.fromInitializeResult({ capabilities: { renameProvider: {} } });
    expect(noPrepare.can("rename")).toBe(true);
    expect(noPrepare.can("prepareRename")).toBe(false);
    const prepared = LspCapabilityRegistry.fromInitializeResult({
      capabilities: { renameProvider: { prepareProvider: true } },
    });
    expect(prepared.can("rename")).toBe(true);
    expect(prepared.can("prepareRename")).toBe(true);
  });
  it("diagnostics methods map so dynamic pull registration resolves", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({ capabilities: {} });
    expect(r.can("diagnostics")).toBe(false);
    r.register({ registrations: [{ id: "dg", method: "textDocument/diagnostic" }] });
    expect(r.can("diagnostics")).toBe(true);
    expect([...r.liveDynamicFeatures()]).toContain("diagnostics");
    r.register({ registrations: [{ id: "wg", method: "workspace/diagnostic" }] });
    expect(r.can("workspaceDiagnostics")).toBe(true);
    r.unregister({ unregisterations: [{ id: "dg", method: "textDocument/diagnostic" }] });
    expect(r.can("diagnostics")).toBe(false);
    const staticDiag = LspCapabilityRegistry.fromInitializeResult({
      capabilities: { diagnosticProvider: { workspaceDiagnostics: true } },
    });
    expect(staticDiag.can("diagnostics")).toBe(true);
    expect(staticDiag.can("workspaceDiagnostics")).toBe(true);
  });
});

describe("workspaceDiagnostics exactness", () => {
  it("file-only provider (true) enables diagnostics, not workspace", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({ capabilities: { diagnosticProvider: true } });
    expect(r.can("diagnostics")).toBe(true);
    expect(r.can("workspaceDiagnostics")).toBe(false);
  });
  it("object without workspace flag enables diagnostics, not workspace", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({
      capabilities: { diagnosticProvider: { identifier: "x", interFileDependencies: true } },
    });
    expect(r.can("diagnostics")).toBe(true);
    expect(r.can("workspaceDiagnostics")).toBe(false);
  });
  it("object with workspaceDiagnostics:true enables both", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({
      capabilities: { diagnosticProvider: { identifier: "x", workspaceDiagnostics: true } },
    });
    expect(r.can("diagnostics")).toBe(true);
    expect(r.can("workspaceDiagnostics")).toBe(true);
  });
  it("dynamic workspace-only registration does not cross-enable file pull", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({ capabilities: {} });
    r.register({ registrations: [{ id: "wg", method: "workspace/diagnostic" }] });
    expect(r.can("workspaceDiagnostics")).toBe(true);
    expect(r.can("diagnostics")).toBe(false);
    r.unregister({ unregisterations: [{ id: "wg", method: "workspace/diagnostic" }] });
    expect(r.can("workspaceDiagnostics")).toBe(false);
  });
  it("dynamic file-pull registration does not cross-enable workspace", () => {
    const r = LspCapabilityRegistry.fromInitializeResult({ capabilities: {} });
    r.register({ registrations: [{ id: "dg", method: "textDocument/diagnostic" }] });
    expect(r.can("diagnostics")).toBe(true);
    expect(r.can("workspaceDiagnostics")).toBe(false);
  });
});
