/**
 * LSPManager — per-root server lifecycle, routing, and manager cache.
 *
 * Split from lsp-bridge.ts (Phase B): manager, LRU cache, cachedManager,
 * prepareDocument/shutdown/evict/invalidate helpers. No behavior change.
 */
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { realpathSync, existsSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LSPConnection } from "./lsp-connection.js";
import { canonicalProjectRoot, computeConfigFingerprint, buildSessionKey } from "./lsp-session-key.js";
import { getActiveCatalog, getDescriptorsForLanguage } from "../language-intelligence/language-server-catalog.js";
import { AmbiguousServerError, type LspSessionOptions } from "./lsp-types.js";
import {
  ALL_SERVER_CONFIGS,
  detectLanguageFromExtension,
  detectProjectLanguages,
  dummyFileForLanguage,
  resolvedServerCache,
  resolvedServerListCache,
  withBudget,
  type LSPDiagnostic,
  type LSPHoverResult,
  type LSPRange,
  type LSPWorkspaceSymbol,
  type ServerConfig,
} from "./lsp-types.js";

// ── LSP Manager ────────────────────────────────────────────────────

export class LSPManager {
  private connections = new Map<string, LSPConnection>();
  private rootUri: string;
  private availableConfigs: ServerConfig[];
  private _startupPromise: Promise<void> | null = null;

  /** Exposes merged configs for behavioral regression tests. */
  getAvailableConfigs(): ServerConfig[] { return this.availableConfigs; }

  constructor(root: string) {
    this.rootUri = root;
    const info = detectProjectLanguages(root);
    const availableSet = new Set(info.availableServers);
    // Build from resolver cache so project-local/override executables are honored.
    // Multi-role: the list cache holds EVERY eligible descriptor per language
    // (semantic + linter siblings); single-entry cache is first-entry fallback.
    const resolverConfigs: ServerConfig[] = [];
    for (const lang of info.detectedLanguages) {
      const listed = resolvedServerListCache.get(`${root}:${lang}`);
      const entries = listed && listed.length > 0
        ? listed
        : (() => { const one = resolvedServerCache.get(`${root}:${lang}`); return one ? [one] : []; })();
      for (const cached of entries) {
        resolverConfigs.push({
          command: cached.executable,
          args: cached.args,
          languageIds: [lang],
          descriptorId: cached.descriptorId,
          ...(cached.role !== undefined ? { role: cached.role } : {}),
        });
      }
    }
    if (resolverConfigs.length > 0) {
      // GROUP by resolved (executable, args) identity and MERGE languageIds before coverage filtering.
      const byKey = new Map<string, ServerConfig>();
      for (const cfg of resolverConfigs) {
        const key = `${cfg.command}\0${JSON.stringify(cfg.args)}\0${cfg.role ?? ""}`;
        const existing = byKey.get(key);
        if (existing) {
          for (const lid of cfg.languageIds) if (!existing.languageIds.includes(lid)) existing.languageIds.push(lid);
        } else {
          byKey.set(key, {
            command: cfg.command,
            args: [...cfg.args],
            languageIds: [...cfg.languageIds],
            ...(cfg.descriptorId ? { descriptorId: cfg.descriptorId } : {}),
            ...(cfg.role ? { role: cfg.role } : {}),
          });
        }
      }
      const deduped = [...byKey.values()];
      // Dedupe legacy by LANGUAGE ID coverage, not command string — a resolver config resolving to
      // /repo/node_modules/.bin/pyright covers "python" so any legacy config for python must be excluded
      // even though its bare command "pyright" != full path.
      const coveredLanguages = new Set(deduped.flatMap((c) => c.languageIds));
      const legacy = ALL_SERVER_CONFIGS.filter(
        (cfg) => availableSet.has(cfg.command) && !cfg.languageIds.some((lang) => coveredLanguages.has(lang)),
      );
      this.availableConfigs = [...deduped, ...legacy];
    } else {
      this.availableConfigs = ALL_SERVER_CONFIGS.filter((cfg) => availableSet.has(cfg.command));
    }
  }

  /** Eagerly start all available LSP servers in parallel. */
  async startAll(): Promise<void> {
    if (this._startupPromise) return this._startupPromise;
    this._startupPromise = this._doStartAll();
    return this._startupPromise;
  }

  private async _doStartAll(): Promise<void> {
    // Pick one server config per language, then start each selected command
    // once and share that connection across every language it supports.
    const configForLanguage = new Map<string, ServerConfig>();
    for (const cfg of this.availableConfigs) {
      for (const langId of cfg.languageIds) {
        if (!configForLanguage.has(langId)) {
          configForLanguage.set(langId, cfg);
        }
      }
    }

    const selectedConfigs = [...new Set(configForLanguage.values())];
    const promises: Promise<void>[] = [];
    for (const config of selectedConfigs) {
      promises.push((async () => {
        try {
          const conn = new LSPConnection();
          conn.languageIds = config.languageIds;
          conn.descriptorId = config.descriptorId ?? config.command;
          conn.name = basename(config.command);
          conn.projectRoot = canonicalProjectRoot(this.rootUri);
          await conn.start(config.command, config.args, this.rootUri);
          for (const langId of config.languageIds) {
            if (configForLanguage.get(langId) === config) {
              this.connections.set(langId, conn);
            }
          }
        } catch {
          // Server unavailable for this language — next bridge call can retry
        }
      })());
    }
    await Promise.all(promises);
  }

  get detectedLanguages(): string[] {
    return detectProjectLanguages(this.rootUri).detectedLanguages;
  }

  get availableServers(): string[] {
    return this.availableConfigs.map((c) => c.command);
  }

  get connectedLanguageCount(): number {
    return this.connections.size;
  }

  async getServer(languageId: string, opts?: { purpose?: "warmup" | "request" } & LspSessionOptions): Promise<LSPConnection | null> {
    // Await eager startup if still in progress
    if (this._startupPromise) await this._startupPromise;
    const session = opts as LspSessionOptions | undefined;
    const candidates = this.availableConfigs.filter((c) => c.languageIds.includes(languageId));
    // Multi same-language servers require explicit selection.
    const distinct = new Map(candidates.map((c) => [`${c.descriptorId ?? c.command}::${c.command}::${JSON.stringify(c.args)}`, c]));
    if (distinct.size > 1 && !session?.descriptorId && !session?.serverId && !session?.role) {
      throw new AmbiguousServerError(languageId, [...distinct.keys()]);
    }
    let selected = candidates;
    if (session?.descriptorId) selected = selected.filter((c) => (c.descriptorId ?? c.command) === session.descriptorId);
    else if (session?.serverId) selected = selected.filter((c) => c.command === session.serverId || (c.descriptorId ?? "") === session.serverId);
    if (session?.role) selected = selected.filter((c) => (c.role ?? "primary") === session.role);
    if (selected.length === 0) return null;
    // Ambiguity whenever multiple eligible descriptors remain — including within
    // one role. Never silently fall back to first match; caller must disambiguate.
    const distinctSelected = new Map(selected.map((c) => [`${c.descriptorId ?? c.command}::${c.command}::${JSON.stringify(c.args)}`, c]));
    if (distinctSelected.size > 1) {
      throw new AmbiguousServerError(languageId, [...distinctSelected.keys()]);
    }
    const target = selected;

    // Session-keyed reuse: same canonical root + descriptor + fingerprint reuses conn.
    for (const config of target) {
      const fp = this.fingerprintFor(languageId, config, session);
      const key = buildSessionKey(this.rootUri, fp);
      const existing = sessionStore.get(key);
      if (existing && !(existing.conn as any).closed) {
        this.connections.set(this.sessionLangKey(languageId, session), existing.conn);
        existing.lastUsed = Date.now();
        return existing.conn;
      }
    }
    // Legacy eager connections predate fingerprinted session identity and
    // carry no lease key. Strict executor requests pass allowInstall:false;
    // never satisfy those from the eager cache or an LRU eviction could kill
    // an in-flight request and descriptor/config provenance would be lost.
    const cachedKey = this.sessionLangKey(languageId, session);
    const cached = this.connections.get(cachedKey);
    if (session?.allowInstall !== false && cached && !(cached as any).closed) return cached;
    if (cached && (session?.allowInstall === false || (cached as any).closed)) {
      this.connections.delete(cachedKey);
    }

    // Fallback: try starting on-demand for this language
    for (const config of target) {
      try {
        const conn = await this.startSession(languageId, config, session);
        if (conn) return conn;
      } catch (e) { if (e instanceof AmbiguousServerError) throw e; /* try next server config */ }
    }
    // Managed auto-install orchestration (purpose-aware, never for warmup).
    // Strict path passes allowInstall:false to forbid install WITHOUT broadening legacy behavior.
    if (session?.allowInstall === false) return null;
    try {
      const purpose = session?.purpose ?? "warmup";
      const dummy = dummyFileForLanguage(languageId, this.rootUri);
      const { ensureLanguageServerAvailable } = await import("../language-intelligence/language-intelligence-runtime.js");
      let res: Awaited<ReturnType<typeof ensureLanguageServerAvailable>> | null = null;
      try {
        res = await withBudget(ensureLanguageServerAvailable(dummy, this.rootUri, { purpose }), 10000);
      } catch { res = null; }
      if (res && res.status === "available" && (res as unknown as { tier: string }).tier === "managed") {
        // Check if already in availableConfigs; if not, add and start
        const already = this.availableConfigs.some((c) => c.command === res.executable && JSON.stringify(c.args) === JSON.stringify(res.args));
        if (!already) {
          const newCfg: ServerConfig = {
            command: res.executable,
            args: res.args,
            languageIds: [languageId],
            descriptorId: res.descriptorId,
            ...(res.role !== undefined ? { role: res.role } : {}),
          };
          this.availableConfigs.push(newCfg);
          resolvedServerCache.set(`${this.rootUri}:${languageId}`, {
            descriptorId: res.descriptorId,
            executable: res.executable,
            args: res.args,
            ...(res.role !== undefined ? { role: res.role } : {}),
          });
        }
        try {
          const conn = new LSPConnection();
          conn.languageIds = [languageId];
          conn.descriptorId = res.descriptorId;
          conn.name = basename(res.executable);
          conn.projectRoot = canonicalProjectRoot(this.rootUri);
          await conn.start(res.executable, res.args, this.rootUri);
          this.connections.set(languageId, conn);
          return conn;
        } catch { /* spawn failed after install */ }
      }
    } catch { /* ensure is best-effort */ }
    return null;
  }

  private sessionLangKey(languageId: string, session?: LspSessionOptions): string {
    if (!session?.descriptorId && !session?.serverId && !session?.role) return languageId;
    return `${languageId}::${session.descriptorId ?? session.serverId ?? session.role}`;
  }

  /** Fingerprint inputs: descriptor + resolved exe/args + initOptions/settings/folders + validated env. */
  private fingerprintFor(languageId: string, config: ServerConfig, session?: LspSessionOptions) {
    const desc = getDescriptorsForLanguage(languageId).find((d) => d.id === (config.descriptorId ?? session?.descriptorId))
      ?? getDescriptorsForLanguage(languageId)[0];
    const initializationOptions = session?.initializationOptions ?? config.initializationOptions ?? desc?.initializationOptions ?? undefined;
    const settings = session?.settings ?? config.settings ?? desc?.settings ?? undefined;
    const workspaceFolders = session?.workspaceFolders ?? config.workspaceFolders ?? [canonicalProjectRoot(this.rootUri)];
    const envOverlay = validateEnvOverlay(session?.envOverlay ?? config.envOverlay);
    const requiredEnvValues = readRequiredEnv(desc?.commandCandidates.flatMap((c) => c.requiredEnv ?? []) ?? []);
    return {
      descriptorId: config.descriptorId ?? session?.descriptorId ?? desc?.id ?? config.command,
      executable: config.command, args: config.args,
      initializationOptions, settings, workspaceFolders, envOverlay, requiredEnvValues,
    };
  }

  /** Start session: inject initOptions/folders into initialize, send didChangeConfiguration, replace stale fingerprint. */
  private async startSession(languageId: string, config: ServerConfig, session?: LspSessionOptions): Promise<LSPConnection | null> {
    const fp = this.fingerprintFor(languageId, config, session);
    const key = buildSessionKey(this.rootUri, fp);
    const canonical = canonicalProjectRoot(this.rootUri);
    // Fingerprint replace: drop zero-lease stale sessions for same root+descriptor.
    for (const [k, e] of [...sessionStore]) {
      if (e.root === canonical && e.descriptorId === fp.descriptorId && k !== key && e.leases === 0) {
        try { e.conn.shutdown(); } catch {}
        sessionStore.delete(k);
      }
    }
    const conn = new LSPConnection();
    conn.languageIds = config.languageIds;
    conn.descriptorId = fp.descriptorId;
    conn.name = basename(config.command);
    conn.projectRoot = canonical;
    const initOptions = fp.initializationOptions as Record<string, unknown> | undefined;
    const folders = fp.workspaceFolders as string[];
    // Session fingerprint settings reach server workspace/configuration responses
    // via the connection (server → client path), not a client-request patch.
    conn.sessionSettings = fp.settings;
    const origRequest = conn.request.bind(conn);
    (conn as any).request = (method: string, params: unknown, ropts?: { signal?: AbortSignal }) => {
      if (method === "initialize" && params && typeof params === "object") {
        const p = params as Record<string, unknown>;
        if (initOptions !== undefined) p.initializationOptions = initOptions;
        if (folders.length) {
          p.workspaceFolders = folders.map((f) => ({
            uri: pathToFileURL(resolve(f)).href,
            name: basename(resolve(f)),
          }));
        }
      }
      return (origRequest as any)(method, params, ropts);
    };
    // Validated env overlay reaches the server process; values are never logged.
    await conn.start(config.command, config.args, this.rootUri, { env: fp.envOverlay });
    (conn as any).sessionInitOptions = initOptions;
    (conn as any).sessionSettings = fp.settings;
    (conn as any).sessionKey = key;
    if (fp.settings !== undefined) {
      try { await conn.notify("workspace/didChangeConfiguration", { settings: fp.settings }); } catch {}
    }
    sessionStore.set(key, { conn, fingerprint: computeConfigFingerprint(fp), descriptorId: fp.descriptorId, root: canonical, leases: 0, lastUsed: Date.now() });
    this.connections.set(this.sessionLangKey(languageId, session), conn);
    return conn;
  }

  /** Route to the right server for a file and open it */
  async openFile(filePath: string, _root?: string, opts?: { purpose?: "warmup" | "request" }): Promise<void>;
  async openFile(filePath: string, _root?: string, purpose?: "warmup" | "request"): Promise<void>;
  async openFile(filePath: string, _root?: string, optsOrPurpose?: { purpose?: "warmup" | "request" } | "warmup" | "request"): Promise<void> {
    const purpose = typeof optsOrPurpose === "string" ? optsOrPurpose : (optsOrPurpose?.purpose ?? "warmup");
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return;
    const server = await this.getServer(langId, { purpose });
    if (!server) return;
    await server.openFile(filePath);
  }

  /** Route updateFile to the right server */
  async updateFile(filePath: string, text: string): Promise<void> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return;
    const server = await this.getServer(langId);
    if (!server) return;
    await server.didChange(filePath, text);
  }

  async rename(languageId: string, filePath: string, line0: number, character0: number, newName: string): Promise<LspWorkspaceEdit | null> {
    const server = await this.getServer(languageId, { purpose: "request" });
    if (!server) return null;
    return server.rename(filePath, line0, character0, newName);
  }

  async prepareRename(languageId: string, filePath: string, line0: number, character0: number): Promise<{ range: LSPRange; placeholder?: string } | null> {
    const server = await this.getServer(languageId, { purpose: "request" });
    if (!server) return null;
    return server.prepareRename(filePath, line0, character0);
  }

  async organizeImports(filePath: string): Promise<LspWorkspaceEdit | null> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return null;
    const server = await this.getServer(langId, { purpose: "request" });
    if (!server) return null;
    return server.organizeImports(filePath);
  }

  async formatting(filePath: string, tabSize?: number, insertSpaces?: boolean): Promise<LspWorkspaceEdit | null> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return null;
    const server = await this.getServer(langId, { purpose: "request" });
    if (!server) return null;
    return server.formatting(filePath, tabSize, insertSpaces);
  }

  async codeActions(
    filePath: string,
    range: LSPRange,
    context: { diagnostics?: unknown[]; only?: string[] },
  ): Promise<Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }>> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return [];
    const server = await this.getServer(langId, { purpose: "request" });
    if (!server) return [];
    return server.codeActions(filePath, range, context);
  }

  /** Route closeFile to the right server */
  async closeFile(filePath: string): Promise<void> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return;
    const server = await this.getServer(langId);
    if (!server) return;
    await server.didClose(filePath);
  }

  /** Route didSave to the right server */
  async didSave(filePath: string): Promise<void> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return;
    const server = await this.getServer(langId);
    if (!server) return;
    await server.didSave(filePath);
  }

  /** Route diagnostics lookup to the right server */
  async getDiagnosticsFor(filePath: string): Promise<LSPDiagnostic[]> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return [];
    const server = await this.getServer(langId);
    if (!server) return [];
    return server.getDiagnostics(filePath);
  }

  async hasDiagnosticsFor(filePath: string): Promise<boolean> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return false;
    const server = await this.getServer(langId);
    if (!server) return false;
    return server.hasDiagnostics(filePath);
  }

  /** Query workspace/symbol across all servers */
  async workspaceSymbol(query: string): Promise<LSPWorkspaceSymbol[]> {
    await this.startAll();
    const allSymbols: LSPWorkspaceSymbol[] = [];
    for (const conn of this.connections.values()) {
      try {
        const symbols = await conn.workspaceSymbol(query);
        allSymbols.push(...symbols);
      } catch {
        // Individual server failure is non-fatal
      }
    }
    return allSymbols;
  }

  /** Query hover at a position */
  async hover(filePath: string, line: number, character: number): Promise<LSPHoverResult | null> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return null;
    const server = await this.getServer(langId);
    if (!server) return null;
    await server.openFile(filePath);
    return server.hover(filePath, line, character);
  }

  /** Get all open files across all connections */
  getAllOpenFiles(): string[] {
    const files: string[] = [];
    for (const conn of this.connections.values()) {
      files.push(...conn.getOpenFilePaths());
    }
    return files;
  }

  async shutdown(): Promise<void> {
    for (const conn of new Set(this.connections.values())) conn.shutdown();
    this.connections.clear();
  }
}
// ── Session store: leases, nested roots, precise invalidation ────────────

export interface SessionEntry {
  conn: LSPConnection;
  fingerprint: string;
  descriptorId: string;
  root: string;
  leases: number;
  lastUsed: number;
}

export const sessionStore = new Map<string, SessionEntry>();

/** Validate env overlay: declared string keys/values only (catalog has NO descriptor.environment). */
export function validateEnvOverlay(input?: Record<string, string>): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

export function readRequiredEnv(keys: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = process.env[k];
  return out;
}

/** Acquire lease (inc use-count). */
export function acquireLease(key: string): SessionEntry | null {
  const e = sessionStore.get(key);
  if (!e) return null;
  e.leases += 1;
  e.lastUsed = Date.now();
  return e;
}

/** Release lease (dec use-count). Runs a deferred explicit manager eviction once leases drain. */
export function releaseLease(key: string): void {
  const e = sessionStore.get(key);
  if (!e) return;
  e.leases = Math.max(0, e.leases - 1);
  e.lastUsed = Date.now();
  maybeRunPendingManagerEviction(e.root);
}

/** Acquire request-scoped lease: getServer + inc. Caller must releaseLease in finally. */
export async function acquireSession(root: string, languageId: string, opts?: LspSessionOptions): Promise<{ conn: LSPConnection; key: string } | null> {
  const mgr = cachedManager(root);
  const conn = await mgr.getServer(languageId, opts as any);
  if (!conn) return null;
  const key = (conn as any).sessionKey as string | undefined;
  if (!key) {
    // Strict callers require a real session-store lease. A keyless connection
    // is a legacy eager session and is intentionally not a valid strict route.
    if (opts?.allowInstall === false) return null;
    return { conn, key: `${canonicalProjectRoot(root)}::${languageId}::legacy` };
  }
  acquireLease(key);
  return { conn, key };
}

/** Reaper closes zero-lease sessions only; leased survivors stay alive. */
export function reapZeroLeaseSessions(maxIdleMs = 60_000, now = Date.now()): string[] {
  const reaped: string[] = [];
  for (const [k, e] of [...sessionStore]) {
    if (e.leases === 0 && now - e.lastUsed >= maxIdleMs) {
      try { e.conn.shutdown(); } catch {}
      sessionStore.delete(k);
      reaped.push(k);
    }
  }
  return reaped;
}

export function _clearSessionStore(): void { sessionStore.clear(); }

/** Precise invalidation: exact session key, or stale fingerprints for root+descriptor. */
export function invalidateSession(key: string): void {
  const e = sessionStore.get(key);
  if (!e) return;
  try { e.conn.shutdown(); } catch {}
  sessionStore.delete(key);
}

export function invalidateStaleFingerprints(root: string, descriptorId: string, keepFingerprint: string): void {
  const canonical = canonicalProjectRoot(root);
  for (const [k, e] of [...sessionStore]) {
    if (e.root === canonical && e.descriptorId === descriptorId && e.fingerprint !== keepFingerprint && e.leases === 0) {
      try { e.conn.shutdown(); } catch {}
      sessionStore.delete(k);
    }
  }
}

/** Nested roots: nearest ancestor dir containing any catalog marker wins; else canonical cwd. */
export function resolveSessionRoot(filePath: string, cwd: string): string {
  const markers = new Set<string>();
  for (const d of getActiveCatalog()) for (const m of d.rootMarkers) markers.add(m);
  let dir: string | null = dirname(resolve(filePath));
  while (dir) {
    for (const m of markers) { try { if (existsSync(join(dir, m))) { try { return realpathSync(dir); } catch { return dir; } } } catch {} }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return canonicalProjectRoot(cwd);
}

/** Manager for the nested root owning filePath. */
export function cachedManagerForFile(filePath: string, cwd: string): LSPManager {
  return cachedManager(resolveSessionRoot(filePath, cwd));
}
// ── Manager cache with bounded size ──────────────────────────────────

const MAX_MANAGER_CACHE_SIZE = 5;

/** Tracks insertion order for LRU eviction */
const managerAccessOrder: string[] = [];

/** Shuts down and removes all managers from the cache */
export async function prepareDocument(conn: LSPConnection, filePath: string): Promise<void> {
  return conn.prepareDocument(filePath);
}

export async function shutdownAllManagers(): Promise<void> {
  pendingManagerEvictions.clear();
  for (const mgr of managerCache.values()) {
    await mgr.shutdown();
  }
  managerCache.clear();
  managerAccessOrder.length = 0;
}

export const managerCache = new Map<string, LSPManager>();
/** Active lease count for a manager root (sum of session leases). */
export function managerLeaseCount(root: string): number {
  const canonical = canonicalProjectRoot(root);
  let n = 0;
  for (const e of sessionStore.values()) if (e.root === canonical) n += e.leases;
  return n;
}
export function cachedManager(root: string): LSPManager {
  let mgr = managerCache.get(root);
  if (!mgr) {
    // Lease/idle-aware eviction: evict oldest ZERO-lease manager; leased managers
    // are never evicted. When every cached manager holds a lease, refuse eviction
    // and grow past the bound rather than killing a leased manager.
    if (managerCache.size >= MAX_MANAGER_CACHE_SIZE) {
      const victim = managerAccessOrder.find((r) => managerLeaseCount(r) === 0);
      if (victim) {
        const oldMgr = managerCache.get(victim);
        if (oldMgr) { oldMgr.shutdown().catch(() => {}); }
        managerCache.delete(victim);
        const vi = managerAccessOrder.indexOf(victim);
        if (vi !== -1) managerAccessOrder.splice(vi, 1);
      }
    }
    mgr = new LSPManager(root);
    managerCache.set(root, mgr);
    managerAccessOrder.push(root);
  } else {
    // Move to end of access order (most-recently-used)
    const idx = managerAccessOrder.indexOf(root);
    if (idx !== -1) managerAccessOrder.splice(idx, 1);
    managerAccessOrder.push(root);
  }
  return mgr;
}
export function invalidateResolvedServerCacheForRoot(root: string): void {
  const prefix = `${root}:`;
  for (const key of [...resolvedServerCache.keys()]) {
    if (key.startsWith(prefix)) resolvedServerCache.delete(key);
  }
  for (const key of [...resolvedServerListCache.keys()]) {
    if (key.startsWith(prefix)) resolvedServerListCache.delete(key);
  }
}

/** Canonical roots with a deferred explicit eviction: honored once leases drain to zero. */
const pendingManagerEvictions = new Set<string>();

/** True when an explicit eviction for root was refused (leased) and is still deferred. */
export function isManagerEvictionPending(root: string): boolean {
  return pendingManagerEvictions.has(canonicalProjectRoot(root));
}

/** Run a deferred explicit eviction once its leases drain to zero (fire-and-forget). */
function maybeRunPendingManagerEviction(rootCanonical: string): void {
  if (!pendingManagerEvictions.has(rootCanonical)) return;
  let remaining = 0;
  for (const e of sessionStore.values()) if (e.root === rootCanonical) remaining += e.leases;
  if (remaining > 0) return;
  const victim = [...managerCache.keys()].find((k) => canonicalProjectRoot(k) === rootCanonical);
  if (victim === undefined) { pendingManagerEvictions.delete(rootCanonical); return; }
  void (async () => {
    const mgr = managerCache.get(victim);
    try { await mgr?.shutdown(); } catch { /* best effort */ }
    managerCache.delete(victim);
    const idx = managerAccessOrder.indexOf(victim);
    if (idx !== -1) managerAccessOrder.splice(idx, 1);
    pendingManagerEvictions.delete(rootCanonical);
  })();
}

export async function evictManagerForRoot(root: string): Promise<boolean> {
  const mgr = managerCache.get(root);
  if (!mgr) { pendingManagerEvictions.delete(canonicalProjectRoot(root)); return true; }
  if (managerLeaseCount(root) > 0) {
    // Leased: never kill in-flight work — defer until leases drain to zero.
    pendingManagerEvictions.add(canonicalProjectRoot(root));
    return false;
  }
  pendingManagerEvictions.delete(canonicalProjectRoot(root));
  try { await mgr.shutdown(); } catch { /* best effort */ }
  managerCache.delete(root);
  const idx = managerAccessOrder.indexOf(root);
  if (idx !== -1) managerAccessOrder.splice(idx, 1);
  return true;
}
