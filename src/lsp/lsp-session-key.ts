/** Session identity: canonical root + config fingerprint. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const SESSION_KEY_SCHEMA_VERSION = 1;

export function canonicalProjectRoot(p: string): string {
  try { return realpathSync(resolve(p)); } catch { return resolve(p); }
}

function stable(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export interface FingerprintInputs {
  descriptorId: string;
  executable: string;
  args: string[];
  initializationOptions?: unknown;
  settings?: unknown;
  workspaceFolders?: string[];
  /** Validated env overlay actually applied to spawn env. */
  envOverlay?: Record<string, string>;
  /** Values of requiredEnv keys (declared by candidate, read from process.env). */
  requiredEnvValues?: Record<string, string | undefined>;
}

export function computeConfigFingerprint(i: FingerprintInputs): string {
  const payload = stable({
    v: SESSION_KEY_SCHEMA_VERSION,
    descriptorId: i.descriptorId,
    executable: i.executable,
    args: i.args ?? [],
    initializationOptions: i.initializationOptions ?? null,
    settings: i.settings ?? null,
    workspaceFolders: [...(i.workspaceFolders ?? [])].sort(),
    envOverlay: i.envOverlay ?? {},
    requiredEnvValues: i.requiredEnvValues ?? {},
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function buildSessionKey(root: string, fp: FingerprintInputs & { fingerprint?: string }): string {
  const canonical = canonicalProjectRoot(root);
  const f = fp.fingerprint ?? computeConfigFingerprint(fp);
  return `${canonical}::${fp.descriptorId}::${f.slice(0, 16)}`;
}
