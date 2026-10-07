import { existsSync, realpathSync } from "node:fs";
import { join, dirname, resolve, extname, delimiter, basename } from "node:path";
import { LANGUAGE_SERVER_CATALOG, type ServerDescriptor, getDescriptorsForLanguage } from "./language-server-catalog.js";
import { loadConfig, isRootTrusted } from "./language-intelligence-config.js";
import { isServerInstalled, getInstalledBinPath } from "./language-intelligence-installer.js";

// ── Types ───────────────────────────────────────────────────────────

export type ResolutionResult =
  | {
      status: "available";
      languageId: string;
      root: string;
      descriptorId: string;
      executable: string;
      args: string[];
      tier: "override" | "project-local" | "system" | "managed";
      /** Role tag preserved from the matched descriptor (descriptor.roles[0]); undefined when untagged. */
      role?: string;
    }
  | {
      status: "degraded";
      languageId: string;
      reasonCode: "unsupported-language" | "no-server-descriptor" | "language-disabled" | "project-local-untrusted" | "executable-missing" | "invalid-override";
      message: string;
      attemptedDescriptorIds: string[];
      fallback: "ast" | "text";
    };

export interface ResolveOptions {
  /** Dependency injection for testing — defaults to PATH filesystem check (no spawn) */
  checkExecutable?: (cmd: string) => boolean;
  /** Filesystem existence check for project-local bins — injectable to verify zero FS stat when untrusted */
  fileExists?: (path: string) => boolean;
  /** Injected home for config/trust reads (testing) */
  homedir?: string;
  /** Injected override for isRootTrusted (testing alternative) */
  isRootTrustedFn?: (root: string) => boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────

// Pure filesystem PATH check — no process spawning. Resolver only; real spawn-based
// probing is deferred to Worker 1B's integration layer.
function defaultCheckExecutable(cmd: string): boolean {
  if (!cmd) return false;
  // If cmd already a path, just stat it.
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd);
  const pathEnv = process.env.PATH ?? "";
  if (!pathEnv) return false;
  const dirs = pathEnv.split(delimiter);
  const isWin = process.platform === "win32";
  const exts = isWin ? ["", ".exe", ".cmd", ".bat", ".com"] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, cmd + ext))) return true;
    }
  }
  return false;
}

// Languages with known AST grammars. Derived from actual repo support:
// - src/grammar-loader.ts EXT_TO_WASM (tree-sitter WASM grammars): typescript, javascript, python,
//   rust, go, java, c, cpp, csharp, php, ruby, css, bash/shellscript
// - src/structural-search.ts LANG_MAP / SUPPORTED_STRUCTURAL_LANGUAGES (ast-grep): adds json, yaml, html
// Union of both = fallback "ast"; everything else (lua, etc.) = "text".
// Choice: hardcoded union to avoid circular import (grammar-loader pulls web-tree-sitter optional dep;
// structural-search pulls @ast-grep/napi). Direct import would couple resolver to heavy optional deps.
// Lua removed: no grammar in either module, so degraded Lua must claim "text" not "ast".
const HAS_AST_GRAMMAR = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact",
  "python", "rust", "go", "c", "cpp", "csharp", "java", "php", "bash", "shellscript",
  "json", "yaml", "html", "css", "ruby",
]);

function fallbackForLanguage(languageId: string): "ast" | "text" {
  return HAS_AST_GRAMMAR.has(languageId) ? "ast" : "text";
}

// Extension → languageId reverse map built from catalog
function buildExtensionMap(): Map<string, string> {
  const m = new Map<string, string>();
  for (const desc of LANGUAGE_SERVER_CATALOG) {
    for (const ext of desc.extensions) {
      const key = ext.toLowerCase();
      if (!m.has(key)) m.set(key, desc.languageIds[0]!);
    }
  }
  return m;
}
const EXT_MAP = buildExtensionMap();

export function detectLanguageId(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  if (!ext) {
    // also handle bare filenames via catalog filenames
    const base = basename(filePath);
    for (const desc of LANGUAGE_SERVER_CATALOG) {
      if (desc.filenames?.includes(base)) return desc.languageIds[0] ?? null;
    }
    return null;
  }
  return EXT_MAP.get(ext) ?? null;
}

// Walk up from dirname(filePath), check each marker existence, nearest wins.
function detectRoot(filePath: string, cwd: string, markers: string[]): string {
  const start = dirname(resolve(filePath));
  const allMarkers = markers.length ? markers : [".git"];
  // Collect candidate markers union across matching descriptors handled by caller
  let dir: string | null = start;
  while (dir) {
    for (const m of allMarkers) {
      try {
        if (existsSync(join(dir, m))) return realpathSync(dir);
      } catch {
        if (existsSync(join(dir, m))) return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // no marker found → cwd canonicalized
  try { return realpathSync(resolve(cwd)); } catch { return resolve(cwd); }
}

export function detectProjectRoot(filePath: string, cwd: string): string {
  const languageId = detectLanguageId(filePath);
  if (!languageId) {
    try { return realpathSync(resolve(cwd)); } catch { return resolve(cwd); }
  }
  const markers = allMarkersForLanguage(languageId);
  return detectRoot(filePath, cwd, markers);
}

function allMarkersForLanguage(languageId: string): string[] {
  const descs = getDescriptorsForLanguage(languageId);
  const set = new Set<string>();
  for (const d of descs) for (const m of d.rootMarkers) set.add(m);
  return [...set];
}

function roleForDescriptor(desc: ServerDescriptor): string | undefined {
  return desc.roles?.[0];
}

/** Single available resolution (narrowed from ResolutionResult). */
export type AvailableResolution = Extract<ResolutionResult, { status: "available" }>;

interface CollectDeps {
  root: string;
  languageId: string;
  isTrusted: (r: string) => boolean;
  fileExists: (p: string) => boolean;
  checkExecutable: (cmd: string) => boolean;
  homedir?: string;
}

// Per-descriptor best-tier collection: every eligible descriptor contributes at most
// one entry (project-local > system > managed), so role-tagged siblings coexist
// instead of the first match suppressing the rest.
function collectAvailable(
  descriptors: ServerDescriptor[],
  deps: CollectDeps,
): AvailableResolution[] {
  const out: AvailableResolution[] = [];
  const trusted = deps.isTrusted(deps.root);
  for (const desc of descriptors) {
    const single = [desc];
    // Project-local only when trusted (tryProjectLocal returns null untrusted
    // without FS stat; also skip per-desc call when untrusted).
    if (trusted) {
      const local = tryProjectLocal(single, deps.root, deps.isTrusted, deps.fileExists);
      if (local && local.status === "available") { out.push(local); continue; }
    }
    const sys = trySystemPath(single, deps.root, deps.languageId, deps.checkExecutable);
    if (sys && sys.status === "available") { out.push(sys); continue; }
    const managed = tryManaged(single, deps.root, deps.languageId, deps.homedir);
    if (managed && managed.status === "available") out.push(managed);
  }
  return out;
}

/**
 * Multi-preserving resolver: returns one available resolution per eligible
 * descriptor (best tier each), roles intact. Empty when degraded (disabled,
 * invalid override, or nothing executable) — caller maps to degradedFallback.
 */
export function resolveAllLanguageServers(
  filePath: string,
  cwd: string,
  opts: ResolveOptions = {},
): AvailableResolution[] {
  const checkExecutable = opts.checkExecutable ?? defaultCheckExecutable;
  const fileExists = opts.fileExists ?? existsSync;
  const isTrusted = (root: string): boolean => {
    if (opts.isRootTrustedFn) return opts.isRootTrustedFn(root);
    return isRootTrusted(root, opts.homedir as string | undefined);
  };
  const languageId = detectLanguageId(filePath);
  if (!languageId) return [];
  const descriptors = getDescriptorsForLanguage(languageId);
  if (descriptors.length === 0) return [];
  const cfg = loadConfig(opts.homedir);
  if (cfg.disabled?.includes(languageId)) return [];
  const markers = allMarkersForLanguage(languageId);
  const root = detectRoot(filePath, cwd, markers);
  const override = cfg.overrides?.[languageId];
  // Explicit command override wins alone (single pinned entry or empty).
  if (override?.command) {
    if (!checkExecutable(override.command)) return [];
    const descriptorId = override.descriptorId ?? descriptors[0]!.id;
    const overrideDesc = descriptors.find((d) => d.id === descriptorId) ?? descriptors[0]!;
    const overrideRole = roleForDescriptor(overrideDesc);
    return [{
      status: "available", languageId, root, descriptorId,
      executable: override.command, args: override.args ?? [], tier: "override",
      ...(overrideRole !== undefined ? { role: overrideRole } : {}),
    }];
  }
  let ordered = descriptors;
  if (override && !override.command && override.descriptorId) {
    const pinned = descriptors.find((d) => d.id === override.descriptorId);
    if (!pinned) return [];
    ordered = [pinned, ...descriptors.filter((d) => d.id !== pinned.id)];
  }
  return collectAvailable(ordered, {
    root, languageId, isTrusted, fileExists, checkExecutable, homedir: opts.homedir,
  });
}

// ── Main resolver ───────────────────────────────────────────────────

export function resolveLanguageServer(
  filePath: string,
  cwd: string,
  opts: ResolveOptions = {},
): ResolutionResult {
  const checkExecutable = opts.checkExecutable ?? defaultCheckExecutable;
  const fileExists = opts.fileExists ?? existsSync;
  const isTrusted = (root: string): boolean => {
    if (opts.isRootTrustedFn) return opts.isRootTrustedFn(root);
    return isRootTrusted(root, opts.homedir as string | undefined);
  };

  const languageId = detectLanguageId(filePath);
  if (!languageId) {
    return {
      status: "degraded",
      languageId: "unknown",
      reasonCode: "unsupported-language",
      message: `unsupported language for file: ${filePath}`,
      attemptedDescriptorIds: [],
      fallback: "text",
    };
  }

  const descriptors = getDescriptorsForLanguage(languageId);
  if (descriptors.length === 0) {
    return {
      status: "degraded",
      languageId,
      reasonCode: "no-server-descriptor",
      message: `no server descriptor for language: ${languageId}`,
      attemptedDescriptorIds: [],
      fallback: fallbackForLanguage(languageId),
    };
  }

  // Check disabled list
  const cfg = loadConfig(opts.homedir);
  if (cfg.disabled?.includes(languageId)) {
    return {
      status: "degraded",
      languageId,
      reasonCode: "language-disabled",
      message: `language disabled via config: ${languageId}`,
      attemptedDescriptorIds: descriptors.map((d) => d.id),
      fallback: fallbackForLanguage(languageId),
    };
  }

  // Determine project root (nearest marker wins) — use union of markers for language
  const markers = allMarkersForLanguage(languageId);
  const root = detectRoot(filePath, cwd, markers);
  const attemptedDescriptorIds = descriptors.map((d) => d.id);

  // Tier 1: Explicit override
  const override = cfg.overrides?.[languageId];
  if (override?.command) {
    const cmd = override.command;
    const args = override.args ?? [];
    const descriptorId = override.descriptorId ?? descriptors[0]!.id;
    const overrideDesc = descriptors.find((d) => d.id === descriptorId) ?? descriptors[0]!;
    const overrideRole = roleForDescriptor(overrideDesc);
    if (checkExecutable(cmd)) {
      return { status: "available", languageId, root, descriptorId, executable: cmd, args, tier: "override", ...(overrideRole !== undefined ? { role: overrideRole } : {}) };
    }
    return {
      status: "degraded",
      languageId,
      reasonCode: "invalid-override",
      message: `override executable not found: ${cmd}`,
      attemptedDescriptorIds,
      fallback: fallbackForLanguage(languageId),
    };
  }
  if (override && !override.command && override.descriptorId) {
    // descriptor-only override (no custom command) — treat as pinning to that descriptor, fall through to tier 2/3 with pinned order
    const pinned = descriptors.find((d) => d.id === override.descriptorId);
    if (!pinned) {
      return {
        status: "degraded",
        languageId,
        reasonCode: "invalid-override",
        message: `unknown descriptorId in override: ${override.descriptorId}`,
        attemptedDescriptorIds,
        fallback: fallbackForLanguage(languageId),
      };
    }
    // Reorder descriptors with pinned first
    const reordered = [pinned, ...descriptors.filter((d) => d.id !== pinned.id)];
    // Collect every eligible descriptor (best tier each), pinned first; serve
    // the first for the single-result contract.
    const pinnedAvail = collectAvailable(reordered, {
      root, languageId, isTrusted, fileExists, checkExecutable, homedir: opts.homedir,
    });
    if (pinnedAvail.length > 0) return pinnedAvail[0]!;
    return degradedFallback(languageId, attemptedDescriptorIds, reordered, isTrusted, root);
  }

  // Collect every eligible descriptor (best tier each) so role-tagged siblings
  // all reach the caller; serve the first for the single-result contract.
  // resolveAllLanguageServers exposes the full list to the manager.
  const all = collectAvailable(descriptors, {
    root, languageId, isTrusted, fileExists, checkExecutable, homedir: opts.homedir,
  });
  if (all.length > 0) return all[0]!;

  // Tier 5: Degraded
  return degradedFallback(languageId, attemptedDescriptorIds, descriptors, isTrusted, root);
}

function tryProjectLocal(
  descriptors: ServerDescriptor[],
  root: string,
  isTrusted: (r: string) => boolean,
  fileExists: (p: string) => boolean,
): ResolutionResult | null {
  if (!isTrusted(root)) {
    // Do NOT stat filesystem for binaries — avoid side channel. Return null to let caller
    // fall through to PATH; final degraded will surface project-local-untrusted if appropriate.
    return null;
  }
  for (const desc of descriptors) {
    for (const cand of desc.commandCandidates) {
      // platform / env filtering
      if (cand.platforms && !cand.platforms.includes(process.platform)) continue;
      if (cand.requiredEnv && cand.requiredEnv.some((k: string) => !process.env[k])) continue;
      const localBin = join(root, "node_modules", ".bin", cand.command);
      const isWin = process.platform === "win32";
      const exts = isWin ? ["", ".cmd", ".exe", ".bat", ".com"] : [""];
      for (const ext of exts) {
        const candidate = localBin + ext;
        if (fileExists(candidate)) {
          return {
            status: "available",
            languageId: desc.languageIds[0]!,
            root,
            descriptorId: desc.id,
            executable: candidate,
            args: cand.args,
            tier: "project-local",
            ...(roleForDescriptor(desc) !== undefined ? { role: roleForDescriptor(desc)! } : {}),
          };
        }
      }
    }
  }
  return null;
}

function trySystemPath(
  descriptors: ServerDescriptor[],

  root: string,
  languageId: string,
  checkExecutable: (cmd: string) => boolean,
): ResolutionResult | null {
  for (const desc of descriptors) {
    for (const cand of desc.commandCandidates) {
      if (cand.platforms && !cand.platforms.includes(process.platform)) continue;
      if (cand.requiredEnv && cand.requiredEnv.some((k: string) => !process.env[k])) continue;
      if (checkExecutable(cand.command)) {
        return {
          status: "available",
          languageId,
          root,
          descriptorId: desc.id,
          executable: cand.command,
          args: cand.args,
          tier: "system",
          ...(roleForDescriptor(desc) !== undefined ? { role: roleForDescriptor(desc)! } : {}),
        };
      }
    }
  }
  return null;
}

function tryManaged(
  descriptors: ServerDescriptor[],
  root: string,
  languageId: string,
  homedir?: string,
): ResolutionResult | null {
  for (const desc of descriptors) {
    for (const cand of desc.commandCandidates) {
      if (cand.platforms && !cand.platforms.includes(process.platform)) continue;
      if (cand.requiredEnv && cand.requiredEnv.some((k: string) => !process.env[k])) continue;
      if (cand.managedInstall) {
        const { packageName, version, bin } = cand.managedInstall;
        // fast sync check: lockfile read + stat
        if (isServerInstalled(packageName, version, homedir as string | undefined)) {
          const binPath = getInstalledBinPath(packageName, bin, homedir as string | undefined);
          if (binPath) {
            return {
              status: "available",
              languageId,
              root,
              descriptorId: desc.id,
              executable: binPath,
              args: cand.args,
              tier: "managed",
              ...(roleForDescriptor(desc) !== undefined ? { role: roleForDescriptor(desc)! } : {}),
            };
          }
        }
      }
    }
  }
  return null;
}

// ── Async orchestration (install on demand) ─────────────────────────
// Retry-storm guard: per (languageId, root) failed installs not retried within same session.
const failedInstallAttempts = new Set<string>();
export function _clearFailedInstallAttempts(): void {
  failedInstallAttempts.clear();
}
export function _getFailedInstallAttempts(): Set<string> {
  return failedInstallAttempts;
}
function failedKey(languageId: string, root: string): string {
  return `${languageId}:${root}`;
}
function findManagedCandidate(descriptors: ServerDescriptor[]): { desc: ServerDescriptor; cand: NonNullable<ServerDescriptor["commandCandidates"][number]>; } | null {
  for (const desc of descriptors) {
    for (const cand of desc.commandCandidates) {
      if (cand.managedInstall) return { desc, cand: cand as NonNullable<typeof cand> };
    }
  }
  return null;
}
const inFlightInstalls = new Map<string, Promise<ResolutionResult>>();
export function _clearInFlightInstalls(): void { inFlightInstalls.clear(); }
export async function ensureLanguageServerAvailable(
  filePath: string,
  cwd: string,
  opts: { purpose: "warmup" | "request"; homedir?: string; checkExecutable?: ResolveOptions["checkExecutable"]; fileExists?: ResolveOptions["fileExists"]; isRootTrustedFn?: ResolveOptions["isRootTrustedFn"] },
): Promise<ResolutionResult> {
  const initial = resolveLanguageServer(filePath, cwd, { homedir: opts.homedir, checkExecutable: opts.checkExecutable, fileExists: opts.fileExists, isRootTrustedFn: opts.isRootTrustedFn });
  if (initial.status === "available") return initial;
  // Config-disabled languages must never trigger auto-install — violates explicit user configuration.
  if (initial.status === "degraded" && initial.reasonCode === "language-disabled") {
    return initial;
  }
  if (opts.purpose !== "request") return initial;
  const cfg = loadConfig(opts.homedir as string | undefined);
  if (cfg.installMode !== "auto") return initial;
  // need root for guard key — use cwd canonical fallback if degraded has no root; initial is degraded so compute root via file's language descriptors
  const languageId = initial.languageId;
  // try to get root from Tier 2/3 logic: if unsupported-language, no install candidate anyway
  if (languageId === "unknown") return initial;
  const descs = getDescriptorsForLanguage(languageId);
  const managed = findManagedCandidate(descs);
  if (!managed) return initial;
  // Determine root for guard — compute nearest-marker root for accurate per (language, root) key
  const markers = allMarkersForLanguage(languageId);
  const rootForKey = detectRoot(filePath, cwd, markers);
  const key = failedKey(languageId, rootForKey);
  if (failedInstallAttempts.has(key)) return initial;
  const existing = inFlightInstalls.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<ResolutionResult> => {
    const { installServer } = await import("./language-intelligence-installer.js");
    const result = await installServer(managed.cand.managedInstall!, { homedir: opts.homedir });
    if (!result.ok) {
      failedInstallAttempts.add(key);
      return initial;
    }
    // re-resolve synchronously — Tier 4 will now find the newly installed binary
    const after = resolveLanguageServer(filePath, cwd, { homedir: opts.homedir, checkExecutable: opts.checkExecutable, fileExists: opts.fileExists, isRootTrustedFn: opts.isRootTrustedFn });
    return after;
  })();
  inFlightInstalls.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightInstalls.delete(key);
  }
}

function degradedFallback(
  languageId: string,
  attemptedDescriptorIds: string[],
  descriptors: ServerDescriptor[],
  isTrusted: (r: string) => boolean,
  root: string,
): ResolutionResult {
  // Determine most informative reasonCode
  const trusted = isTrusted(root);
  // If any descriptor had project-local candidates but root untrusted, surface that
  if (!trusted && descriptors.some((d) => d.commandCandidates.length > 0)) {
    return {
      status: "degraded",
      languageId,
      reasonCode: "project-local-untrusted",
      message: `project-local binaries skipped — root not trusted: ${root}`,
      attemptedDescriptorIds,
      fallback: fallbackForLanguage(languageId),
    };
  }
  return {
    status: "degraded",
    languageId,
    reasonCode: "executable-missing",
    message: `no executable found for language: ${languageId}`,
    attemptedDescriptorIds,
    fallback: fallbackForLanguage(languageId),
  };
}
