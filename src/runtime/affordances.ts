import { createHash } from "node:crypto";
import { isAffordancesEnabled } from "../lsp/affordance-contract.js";

export interface CapturedSelector {
  readonly enabled: boolean;
  readonly invalid?: string;
}

export interface AffordanceSelectors {
  readonly general: CapturedSelector;
  readonly inspect: CapturedSelector;
}

function captureSelector(raw: string | undefined, enabledByExistingSelector: boolean): CapturedSelector {
  if (raw === undefined || raw === "0") return Object.freeze({ enabled: false });
  if (raw === "1") return Object.freeze({ enabled: enabledByExistingSelector });
  return Object.freeze({ enabled: false, invalid: raw });
}

/** Capture both environment selectors once; later environment changes have no effect. */
export function captureAffordanceSelectors(env: NodeJS.ProcessEnv = process.env): AffordanceSelectors {
  const generalRaw = env.PI_SMARTREAD_AFFORDANCES;
  const inspectRaw = env.PI_SMARTREAD_INSPECT_AFFORDANCES;
  const generalEnabled = isAffordancesEnabled({ PI_SMARTREAD_AFFORDANCES: generalRaw });
  return Object.freeze({
    general: captureSelector(generalRaw, generalEnabled),
    inspect: captureSelector(inspectRaw, inspectRaw === "1"),
  });
}

export type SurfaceVariant = "baseline" | "affordance-bundle" | "inspect-bundle";

export interface EffectiveAffordanceIdentity {
  readonly selectors: AffordanceSelectors;
  readonly variants: SurfaceVariants;
  readonly surfaceIdentity: string;
  readonly schemaHash: string;
  readonly guidanceHash: string;
}

let effectiveIdentity: EffectiveAffordanceIdentity | undefined;
let identityLogged = false;

export function getEffectiveAffordanceIdentity(): EffectiveAffordanceIdentity | undefined {
  return effectiveIdentity;
}

export function recordEffectiveAffordanceIdentity(
  selectors: AffordanceSelectors,
  variants: SurfaceVariants,
  schema: unknown,
  description: string,
  guidance: string,
): EffectiveAffordanceIdentity {
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  const value = Object.freeze({
    selectors,
    variants,
    surfaceIdentity: surfaceIdentity(selectors, variants, { schema, description, guidance }),
    schemaHash: hash(schema),
    guidanceHash: hash(guidance),
  });
  effectiveIdentity = value;
  if (!identityLogged && process.env.PI_SMARTREAD_SURFACE_IDENTITY_LOG === "1") {
    process.stderr.write(`[pi-smartread:surface-identity] ${JSON.stringify(value)}\n`);
    identityLogged = true;
  }
  return value;
}

export interface SurfaceVariants {
  readonly lsp: SurfaceVariant;
  readonly inspect: SurfaceVariant;
  readonly grep: SurfaceVariant;
  readonly guidance: SurfaceVariant;
  readonly mcpInstructions: SurfaceVariant;
  readonly note?: "wp-c-unbuilt";
}

/** Choose one effective variant per surface; unbuilt WP-C is explicitly baseline. */
export function selectSurfaceVariants(selectors: AffordanceSelectors): SurfaceVariants {
  if (selectors.inspect.enabled) {
    return Object.freeze({
      lsp: selectors.general.enabled ? "affordance-bundle" : "baseline",
      inspect: "inspect-bundle",
      grep: "baseline",
      guidance: "inspect-bundle",
      mcpInstructions: "inspect-bundle",
    });
  }
  if (selectors.general.enabled) {
    return Object.freeze({
      lsp: "affordance-bundle",
      inspect: "baseline",
      grep: "baseline",
      guidance: "affordance-bundle",
      mcpInstructions: "affordance-bundle",
      note: "wp-c-unbuilt",
    });
  }
  return Object.freeze({
    lsp: "baseline",
    inspect: "baseline",
    grep: "baseline",
    guidance: "baseline",
    mcpInstructions: "baseline",
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** Stable per-run SHA-256 identity for captured selectors, chosen variants, and surface inputs. */
export function surfaceIdentity(
  selectors: AffordanceSelectors,
  variants: SurfaceVariants,
  surfaceInputs?: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ selectors, variants, surfaceInputs }), "utf8")
    .digest("hex");
}
