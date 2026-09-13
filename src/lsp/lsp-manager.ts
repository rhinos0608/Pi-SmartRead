/**
 * LSPManager — per-root server lifecycle, routing, and manager cache.
 *
 * Split from lsp-bridge.ts (Phase B): manager, LRU cache, cachedManager,
 * prepareDocument/shutdown/evict/invalidate helpers. No behavior change.
 */
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { LSPConnection } from "./lsp-connection.js";
import {
  ALL_SERVER_CONFIGS,
  detectLanguageFromExtension,
  detectProjectLanguages,
  dummyFileForLanguage,
  resolvedServerCache,
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
    // Resolver maps languageId -> {executable, args}; merge with legacy filter as fallback.
    const resolverConfigs: ServerConfig[] = [];
    for (const lang of info.detectedLanguages) {
      const cached = resolvedServerCache.get(`${root}:${lang}`);
      if (cached) {
        resolverConfigs.push({ command: cached.executable, args: cached.args, languageIds: [lang] });
      }
    }
    if (resolverConfigs.length > 0) {
      // GROUP by resolved (executable, args) identity and MERGE languageIds before coverage filtering.
      const byKey = new Map<string, ServerConfig>();
      for (const cfg of resolverConfigs) {
        const key = `${cfg.command}\0${JSON.stringify(cfg.args)}`;
        const existing = byKey.get(key);
        if (existing) {
          for (const lid of cfg.languageIds) if (!existing.languageIds.includes(lid)) existing.languageIds.push(lid);
        } else {
          byKey.set(key, { command: cfg.command, args: [...cfg.args], languageIds: [...cfg.languageIds] });
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

  async getServer(languageId: string, opts?: { purpose?: "warmup" | "request" }): Promise<LSPConnection | null> {
    // Await eager startup if still in progress
    if (this._startupPromise) await this._startupPromise;

    // Check cached connections (started eagerly)
    const cached = this.connections.get(languageId);
    if (cached && !(cached as any).closed) return cached;
    if (cached) this.connections.delete(languageId);

    // Fallback: try starting on-demand for this language
    for (const config of this.availableConfigs) {
      if (!config.languageIds.includes(languageId)) continue;
      try {
        const conn = new LSPConnection();
        conn.languageIds = config.languageIds;
        await conn.start(config.command, config.args, this.rootUri);
        this.connections.set(languageId, conn);
        return conn;
      } catch { /* try next server config */ }
    }
    // Managed auto-install orchestration (purpose-aware, never for warmup)
    try {
      const purpose = opts?.purpose ?? "warmup";
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
          const newCfg: ServerConfig = { command: res.executable, args: res.args, languageIds: [languageId] };
          this.availableConfigs.push(newCfg);
          resolvedServerCache.set(`${this.rootUri}:${languageId}`, { executable: res.executable, args: res.args });
        }
        try {
          const conn = new LSPConnection();
          conn.languageIds = [languageId];
          await conn.start(res.executable, res.args, this.rootUri);
          this.connections.set(languageId, conn);
          return conn;
        } catch { /* spawn failed after install */ }
      }
    } catch { /* ensure is best-effort */ }
    return null;
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
// ── Manager cache with bounded size ──────────────────────────────────

const MAX_MANAGER_CACHE_SIZE = 5;

/** Tracks insertion order for LRU eviction */
const managerAccessOrder: string[] = [];

/** Shuts down and removes all managers from the cache */
export async function prepareDocument(conn: LSPConnection, filePath: string): Promise<void> {
  return conn.prepareDocument(filePath);
}

export async function shutdownAllManagers(): Promise<void> {
  for (const mgr of managerCache.values()) {
    await mgr.shutdown();
  }
  managerCache.clear();
  managerAccessOrder.length = 0;
}

export const managerCache = new Map<string, LSPManager>();
export function cachedManager(root: string): LSPManager {
  let mgr = managerCache.get(root);
  if (!mgr) {
    // Synchronous eviction before adding a new manager
    if (managerCache.size >= MAX_MANAGER_CACHE_SIZE) {
      const oldest = managerAccessOrder.shift();
      if (oldest) {
        const oldMgr = managerCache.get(oldest);
        if (oldMgr) {
          oldMgr.shutdown().catch(() => {});
        }
        managerCache.delete(oldest);
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
}

export async function evictManagerForRoot(root: string): Promise<void> {
  const mgr = managerCache.get(root);
  if (!mgr) return;
  try { await mgr.shutdown(); } catch { /* best effort */ }
  managerCache.delete(root);
  const idx = managerAccessOrder.indexOf(root);
  if (idx !== -1) managerAccessOrder.splice(idx, 1);
}
