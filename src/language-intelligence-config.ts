import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, unlinkSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────

export interface LanguageOverride {
  descriptorId?: string;
  command?: string;
  args?: string[];
}

export interface LanguageIntelligenceConfig {
  overrides?: Record<string, LanguageOverride>;
  disabled?: string[];
  installMode?: "off" | "auto";
}

function configPath(home = homedir()): string {
  return join(home, ".pi", "agent", "language-intelligence.json");
}

function trustPath(home = homedir()): string {
  return join(home, ".pi", "agent", "language-intelligence", "trust.json");
}

export function loadConfig(home = homedir()): LanguageIntelligenceConfig {
  const p = configPath(home);
  try {
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: LanguageIntelligenceConfig = {};
    if (parsed.overrides && typeof parsed.overrides === "object" && !Array.isArray(parsed.overrides)) {
      const ov: Record<string, LanguageOverride> = {};
      for (const [k, v] of Object.entries(parsed.overrides as Record<string, unknown>)) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const vv = v as Record<string, unknown>;
        const entry: LanguageOverride = {};
        if (typeof vv.descriptorId === "string") entry.descriptorId = vv.descriptorId;
        if (typeof vv.command === "string") entry.command = vv.command;
        if (Array.isArray(vv.args) && vv.args.every((a) => typeof a === "string")) entry.args = vv.args as string[];
        if (entry.command || entry.descriptorId) ov[k] = entry;
      }
      if (Object.keys(ov).length) out.overrides = ov;
    }
    if (Array.isArray(parsed.disabled) && parsed.disabled.every((x: unknown) => typeof x === "string")) {
      out.disabled = parsed.disabled as string[];
    }
    if (parsed.installMode === "off" || parsed.installMode === "auto") {
      out.installMode = parsed.installMode;
    }
    return out;
  } catch {
    return {};
  }
}

export function getOverrideForLanguage(languageId: string, home = homedir()): LanguageOverride | undefined {
  const cfg = loadConfig(home);
  return cfg.overrides?.[languageId];
}

export function isLanguageDisabled(languageId: string, home = homedir()): boolean {
  const cfg = loadConfig(home);
  return cfg.disabled?.includes(languageId) ?? false;
}

// ── Trust store ────────────────────────────────────────────────────

function tryCanonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

let trustCache: string[] | null = null;

function readTrustRaw(home = homedir()): string[] {
  const p = trustPath(home);
  try {
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const arr = (parsed as Record<string, unknown>).trustedRoots;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function cachedTrustRoots(home = homedir()): string[] {
  // Use cache only when home is default homedir (avoid cross-home pollution in tests)
  const isDefault = home === homedir();
  if (isDefault && trustCache !== null) return trustCache;
  const roots = readTrustRaw(home);
  if (isDefault) trustCache = roots;
  return roots;
}

export function listTrustedRoots(home = homedir()): string[] {
  return [...cachedTrustRoots(home)];
}

export function isRootTrusted(root: string, home = homedir()): boolean {
  const canonical = tryCanonical(root);
  const roots = cachedTrustRoots(home);
  return roots.includes(canonical);
}

export function trustRoot(root: string, home = homedir()): void {
  const canonical = tryCanonical(root);
  const existing = readTrustRaw(home);
  if (existing.includes(canonical)) return;
  const next = [...existing, canonical];
  const p = trustPath(home);
  const dir = dirname(p);
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
  const tmp = `${p}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, JSON.stringify({ trustedRoots: next }, null, 2), "utf-8");
    renameSync(tmp, p);
    // update cache if default home
    if (home === homedir()) trustCache = next;
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error("failed to persist trust store");
  }
  // best-effort cleanup of stale tmp files left by previous crashes (do not delete current tmp which was already renamed)
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.startsWith("trust.json.tmp.")) {
        try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

export function setInstallMode(mode: "off" | "auto", home = homedir()): void {
  const p = configPath(home);
  const dir = dirname(p);
  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    }
  } catch { existing = {}; }
  const next = { ...existing, installMode: mode };
  const tmp = `${p}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
    renameSync(tmp, p);
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error("failed to persist installMode");
  }
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (f.startsWith("language-intelligence.json.tmp.")) {
        try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

export function resetLanguageIntelligenceCaches(): void {
  trustCache = null;
}

// Re-export path helpers for tests
export const __paths = { configPath, trustPath };
