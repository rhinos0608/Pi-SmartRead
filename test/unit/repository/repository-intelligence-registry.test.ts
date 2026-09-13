import { describe, it, expect, beforeEach } from "vitest";
import {
  registerRepositoryIntelligence,
  getRepositoryIntelligence,
  resetRepositoryIntelligenceRegistry,
} from "../../src/repository-intelligence-registry.js";
import type { RepositoryIntelligenceService } from "../../src/repository-intelligence-types.js";

// Minimal stub: satisfies the interface for registry tests without implementing logic.
function stubService(): RepositoryIntelligenceService {
  const noop = async () => { throw new Error("not implemented in stub"); };
  return {
    getWorkspaceSnapshot: noop as RepositoryIntelligenceService["getWorkspaceSnapshot"],
    compareSnapshots: noop as RepositoryIntelligenceService["compareSnapshots"],
    rankWorkspace: noop as RepositoryIntelligenceService["rankWorkspace"],
    renderWorkspaceView: noop as RepositoryIntelligenceService["renderWorkspaceView"],
    getImpactCone: noop as RepositoryIntelligenceService["getImpactCone"],
    getRelationshipEvidence: noop as RepositoryIntelligenceService["getRelationshipEvidence"],
    getCapabilities: noop as RepositoryIntelligenceService["getCapabilities"],
  };
}

describe("repository-intelligence-registry", () => {
  beforeEach(() => {
    resetRepositoryIntelligenceRegistry();
  });

  it("returns null when no service is registered", () => {
    expect(getRepositoryIntelligence()).toBeNull();
  });

  it("registers and retrieves a service", () => {
    const svc = stubService();
    registerRepositoryIntelligence(svc);
    expect(getRepositoryIntelligence()).toBe(svc);
  });

  it("throws on double-register (singleton enforcement)", () => {
    const first = stubService();
    registerRepositoryIntelligence(first);
    expect(() => registerRepositoryIntelligence(stubService())).toThrow(
      /already registered/,
    );
    // Original is untouched
    expect(getRepositoryIntelligence()).toBe(first);
  });

  it("allows re-registration after reset", () => {
    const first = stubService();
    const second = stubService();
    registerRepositoryIntelligence(first);
    resetRepositoryIntelligenceRegistry();
    expect(getRepositoryIntelligence()).toBeNull();
    registerRepositoryIntelligence(second);
    expect(getRepositoryIntelligence()).toBe(second);
  });

  it("reset clears the registry completely", () => {
    registerRepositoryIntelligence(stubService());
    resetRepositoryIntelligenceRegistry();
    expect(getRepositoryIntelligence()).toBeNull();
  });
});
