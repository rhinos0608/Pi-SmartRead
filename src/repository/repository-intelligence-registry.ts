/**
 * Process-local registry for the RepositoryIntelligenceService singleton.
 *
 * Follows the same Symbol.for + globalThis pattern used by
 * mutation-ownership.ts and mcp-registry.ts for cross-module singletons.
 * One service instance per process. Registration is strict: double-register
 * throws to prevent accidental overwrite of a live service.
 */

import type { RepositoryIntelligenceService } from "./repository-intelligence-types.js";

// ── Registry key ─────────────────────────────────────────────────────

const REGISTRY_KEY = Symbol.for("pi-smartread.repository-intelligence.v1");

interface RegistrySlot {
  service: RepositoryIntelligenceService;
}

function getSlot(): RegistrySlot | undefined {
  const g = globalThis as Record<PropertyKey, unknown>;
  return g[REGISTRY_KEY] as RegistrySlot | undefined;
}

function setSlot(slot: RegistrySlot): void {
  const g = globalThis as Record<PropertyKey, unknown>;
  Object.defineProperty(g, REGISTRY_KEY, {
    value: slot,
    writable: false,
    enumerable: false,
    configurable: true, // allows delete for test teardown / reset
  });
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Register a RepositoryIntelligenceService instance for this process.
 * Throws if one is already registered — a second registration means either
 * a duplicate wiring path or a service that should have been disposed first.
 * Call `resetRepositoryIntelligenceRegistry()` to unregister before
 * re-registering (e.g. in tests or after process-level teardown).
 */
export function registerRepositoryIntelligence(
  service: RepositoryIntelligenceService,
): void {
  if (getSlot() !== undefined) {
    throw new Error(
      "RepositoryIntelligenceService already registered. " +
        "Call resetRepositoryIntelligenceRegistry() before re-registering.",
    );
  }
  setSlot({ service });
}

/**
 * Retrieve the registered RepositoryIntelligenceService.
 * Returns null if none is registered yet.
 */
export function getRepositoryIntelligence(): RepositoryIntelligenceService | null {
  return getSlot()?.service ?? null;
}

/**
 * Clear the registry. For test isolation and process teardown.
 */
export function resetRepositoryIntelligenceRegistry(): void {
  const g = globalThis as Record<PropertyKey, unknown>;
  delete g[REGISTRY_KEY];
}
