/**
 * LSP Bridge — minimal JSON-RPC LSP client for symbol-level queries.
 *
 * Spawns standard language servers over stdio and speaks the Language
 * Server Protocol (LSP) to provide goToDefinition, findReferences,
 * getDocumentSymbols, goToImplementation, workspace/symbol, hover,
 * and incremental document tracking (didOpen/didChange/didClose).
 *
 * Project structure detection:
 *   Scans the project root for config files (package.json, go.mod, Cargo.toml, etc.)
 *   and source files to determine which languages are in use. Only attempts to
 *   start LSP servers relevant to the detected project languages.
 *
 * Server availability:
 *   Checks PATH for each LSP server binary. Only attempts connections when the
 *   binary exists. Never spawns processes that will immediately fail.
 *
 * Document tracking:
 *   Tracks which files are open on each server connection. OpenFile is idempotent
 *   (no-op if already open). DidChange sends full-text sync updates. DidClose
 *   releases the document and lets the server free resources.
 *
 * The LSP protocol is a standard — this module is self-contained and
 * does not import from smart-edit.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export interface LSPRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface LSPLocation {
  uri: string;
  range: LSPRange;
}

export interface LSPDocumentSymbol {
  name: string;
  kind: number;
  range: LSPRange;
  selectionRange: LSPRange;
  children?: LSPDocumentSymbol[];
}

export interface LSPMarkupContent {
  kind: "markdown" | "plaintext";
  value: string;
}

export interface LSPHoverResult {
  contents: LSPMarkupContent | string | Array<LSPMarkupContent | string>;
  range?: LSPRange;
}

export interface LSPWorkspaceSymbol {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: LSPRange;
  };
  containerName?: string;
}

export interface LSPDocumentChange {
  /** Absolute file path that changed */
  filePath: string;
  /** New full text content */
  text: string;
}

export interface LSPBridge {
  isAvailable(): boolean;
  goToDefinition(filePath: string, line: number, character: number, root: string): Promise<LSPLocation | null>;
  findReferences(filePath: string, line: number, character: number, root: string): Promise<LSPLocation[]>;
  getDocumentSymbols(filePath: string, root: string): Promise<LSPDocumentSymbol[]>;
  goToImplementation(filePath: string, line: number, character: number, root: string): Promise<LSPLocation[]>;

  /** Query workspace/symbol across all active LSP servers */
  workspaceSymbol(query: string, root: string): Promise<LSPWorkspaceSymbol[]>;

  /** Query textDocument/hover for type/signature info at a position */
  hover(filePath: string, line: number, character: number, root: string): Promise<LSPHoverResult | null>;

  /** Open a file on the LSP server (idempotent — no-op if already open) */
  openFile(filePath: string, root: string): Promise<void>;

  /** Send full-text didChange to the LSP server for an open file */
  updateFile(filePath: string, text: string, root: string): Promise<void>;

  /** Send didClose to release the file on the LSP server */
  closeFile(filePath: string, root: string): Promise<void>;

  /** Return absolute paths of all files currently open on any LSP connection */
  getOpenFiles(): string[];

  /** Get stats for diagnostics */
  getStats(): LSPBridgeStats;
}

export interface LSPBridgeStats {
  /** Number of manager/repo roots cached */
  managerCount: number;
  /** Per-root connection counts */
  connectionsByRoot: Record<string, number>;
  /** Total open documents across all servers */
  totalOpenDocuments: number;
}

export interface ProjectLSPInfo {
  /** Language IDs detected from project config files */
  detectedLanguages: string[];
  /** LSP server commands that are available on PATH */
  availableServers: string[];
  /** LSP languages the bridge can serve for this project */
  supportedLanguages: string[];
}

// ── Project structure detection ─────────────────────────────────────

export function detectProjectLanguages(root: string): ProjectLSPInfo {
  const detected: string[] = [];

  // Check for project-level config files
  const hasPkgJson = existsSync(join(root, "package.json"));
  const hasTsconfig = existsSync(join(root, "tsconfig.json")) || existsSync(join(root, "jsconfig.json"));
  const hasPyproject = existsSync(join(root, "pyproject.toml"));
  const hasSetupPy = existsSync(join(root, "setup.py")) || existsSync(join(root, "setup.cfg"));
  const hasRequirements = existsSync(join(root, "requirements.txt"));
  const hasGoMod = existsSync(join(root, "go.mod"));
  const hasCargoToml = existsSync(join(root, "Cargo.toml"));
  const hasBuildGradle = existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"));
  const hasPomXml = existsSync(join(root, "pom.xml"));

  if (hasPkgJson || hasTsconfig) {
    detected.push("typescript", "javascript");
  }
  if (hasPyproject || hasSetupPy || hasRequirements) {
    detected.push("python");
  }
  if (hasGoMod) {
    detected.push("go");
  }
  if (hasCargoToml) {
    detected.push("rust");
  }
  if (hasBuildGradle || hasPomXml) {
    detected.push("java");
  }

  // If no project-config detected, sample source files
  if (detected.length === 0) {
    const exts = sampleSourceExtensions(root);
    const langMap: Record<string, string[]> = {
      ts: ["typescript"], tsx: ["typescriptreact", "typescript"],
      js: ["javascript"], jsx: ["javascriptreact", "javascript"],
      py: ["python"], rs: ["rust"], go: ["go"], java: ["java"],
    };
    for (const ext of exts) {
      const langs = langMap[ext];
      if (langs) for (const l of langs) if (!detected.includes(l)) detected.push(l);
    }
  }

  // Deduplicate
  const unique = [...new Set(detected)];
  const availableServers = findAvailableServers(unique);
  const supported = intersection(availableServers, unique);

  return {
    detectedLanguages: unique,
    availableServers,
    supportedLanguages: supported,
  };
}

function sampleSourceExtensions(root: string): string[] {
  const exts = new Set<string>();
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isFile()) {
        const dot = entry.name.lastIndexOf(".");
        if (dot > 0) exts.add(entry.name.slice(dot + 1));
        if (++count > 200) break;
      }
    }
  } catch { /* ignore */ }
  return [...exts];
}

function intersection(a: string[], b: string[]): string[] {
  const set = new Set(b);
  return a.filter((x) => set.has(x));
}

// ── LSP server availability detection ──────────────────────────────

interface ServerConfig {
  command: string;
  args: string[];
  languageIds: string[];
}

const ALL_SERVER_CONFIGS: ServerConfig[] = [
  { command: "typescript-language-server", args: ["--stdio"], languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
  { command: "typescriptlangserver", args: ["--stdio"], languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
  { command: "pyright", args: ["--stdio"], languageIds: ["python"] },
  { command: "pylsp", args: ["--stdio"], languageIds: ["python"] },
  { command: "pyls", args: ["--stdio"], languageIds: ["python"] },
  { command: "jedi-language-server", args: ["--stdio"], languageIds: ["python"] },
  { command: "rust-analyzer", args: ["--stdio"], languageIds: ["rust"] },
  { command: "gopls", args: [], languageIds: ["go"] },
  { command: "java", args: [], languageIds: ["java"] }, // jdtls is typically a shell script
];

function findAvailableServers(neededLanguages: string[]): string[] {
  const neededSet = new Set(neededLanguages);
  const available: string[] = [];

  for (const config of ALL_SERVER_CONFIGS) {
    // Only check servers whose languages are needed
    if (!config.languageIds.some((id) => neededSet.has(id))) continue;
    if (binaryExists(config.command)) {
      available.push(config.command);
    }
  }

  return available;
}

function binaryExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    try {
      execFileSync("where", [command], { stdio: "ignore", timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Language ID detection ──────────────────────────────────────────

function detectLanguageFromExtension(filePath: string): string | null {
  const ext = filePath.toLowerCase();
  if (ext.endsWith(".ts") || ext.endsWith(".mts") || ext.endsWith(".cts")) return "typescript";
  if (ext.endsWith(".tsx")) return "typescriptreact";
  if (ext.endsWith(".js") || ext.endsWith(".mjs") || ext.endsWith(".cjs")) return "javascript";
  if (ext.endsWith(".jsx")) return "javascriptreact";
  if (ext.endsWith(".py")) return "python";
  if (ext.endsWith(".rs")) return "rust";
  if (ext.endsWith(".go")) return "go";
  if (ext.endsWith(".java")) return "java";
  return null;
}

// ── JSON-RPC connection ────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15_000;

class LSPConnection {
  private proc: ReturnType<typeof spawn> | null = null;
  private reqId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private closed = false;

  /** Track which files are open on this connection */
  private openDocuments = new Map<string, number>(); // filePath → version

  /** The language IDs this server handles */
  languageIds: string[] = [];

  async start(command: string, args: string[], rootUri: string): Promise<void> {
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout?.on("data", (chunk: Buffer) => this._onData(chunk));
    this.proc.on("exit", () => { this.closed = true; this._rejectAll(new Error("LSP server exited")); });
    this.proc.on("error", () => { this.closed = true; });

    const initResult = await this.request("initialize", {
      processId: process.pid,
      rootUri: `file://${rootUri}`,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          implementation: { dynamicRegistration: false },
          hover: { dynamicRegistration: false },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
        },
      },
    });
    if (!initResult) throw new Error("LSP initialize failed");
    await this.notify("initialized", {});
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return null;
    const id = this.reqId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`LSP request ${method} timed out`)), REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.proc?.stdin?.write(header + body);
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    this.proc?.stdin?.write(header + body);
  }

  /**
   * Open a file with the LSP server. Idempotent — if the file is already open,
   * sends didClose + didOpen to refresh its content.
   */
  async openFile(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    if (this.openDocuments.has(resolved)) {
      // File is already open — its content is up-to-date from the last openFile call.
      // No need to send didChange unless updateFile() was called explicitly.
      return;
    }
    const uri = `file://${resolved}`;
    const text = existsSync(resolved) ? readFileSync(resolved, "utf-8") : "";
    const version = (this.openDocuments.get(resolved) ?? 0) + 1;
    this.openDocuments.set(resolved, version);
    await this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: detectLanguageFromExtension(resolved) ?? "plaintext", version, text },
    });
  }

  /**
   * Send full-text didChange for an open file. If the file is not open yet,
   * calls openFile instead.
   */
  async didChange(filePath: string, text: string): Promise<void> {
    const resolved = resolve(filePath);
    const uri = `file://${resolved}`;
    const currentVersion = this.openDocuments.get(resolved) ?? 0;
    const version = currentVersion + 1;
    this.openDocuments.set(resolved, version);
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /**
   * Close a file on the LSP server.
   */
  async didClose(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    if (!this.openDocuments.has(resolved)) return;
    const uri = `file://${resolved}`;
    this.openDocuments.delete(resolved);
    await this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  /** Check if a file is currently open on this connection */
  isOpen(filePath: string): boolean {
    return this.openDocuments.has(resolve(filePath));
  }

  /** Get all open file paths on this connection */
  getOpenFilePaths(): string[] {
    return [...this.openDocuments.keys()];
  }

  /** Get open document count */
  get openDocumentCount(): number {
    return this.openDocuments.size;
  }

  /**
   * Query workspace/symbol on this server.
   */
  async workspaceSymbol(query: string): Promise<LSPWorkspaceSymbol[]> {
    const result = await this.request("workspace/symbol", { query });
    return (result as LSPWorkspaceSymbol[]) ?? [];
  }

  /**
   * Query textDocument/hover at a position.
   */
  async hover(filePath: string, line: number, character: number): Promise<LSPHoverResult | null> {
    const resolved = resolve(filePath);
    const uri = `file://${resolved}`;
    const result = await this.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
    return (result as LSPHoverResult) ?? null;
  }

  shutdown(): void {
    this.closed = true;
    this.request("shutdown", {})
       .catch(() => {})
       .finally(() => this.notify("exit", {}).catch(() => {}));
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("LSP shutdown"));
    }
    this.pending.clear();
    this.openDocuments.clear();
    setTimeout(() => this.proc?.kill(), 1000);
  }

  private _onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    while (true) {
      const match = this.buffer.match(/^Content-Length: (\d+)\r\n\r\n/);
      if (!match) break;
      const contentLength = parseInt(match[1]!, 10);
      const headerEnd = match[0].length;
      if (this.buffer.length < headerEnd + contentLength) break;
      const content = this.buffer.slice(headerEnd, headerEnd + contentLength);
      this.buffer = this.buffer.slice(headerEnd + contentLength);
      try {
        const msg = JSON.parse(content);
        if (msg.id !== undefined && msg.id !== null) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        }
      } catch { /* ignore malformed messages */ }
    }
  }

  private _rejectAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}

// ── LSP Manager ────────────────────────────────────────────────────

class LSPManager {
  private connections = new Map<string, LSPConnection>();
  private rootUri: string;
  private availableConfigs: ServerConfig[];
  private _startupPromise: Promise<void> | null = null;

  constructor(root: string) {
    this.rootUri = root;
    const info = detectProjectLanguages(root);
    const availableSet = new Set(info.availableServers);
    this.availableConfigs = ALL_SERVER_CONFIGS.filter((cfg) => availableSet.has(cfg.command));
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

  async getServer(languageId: string): Promise<LSPConnection | null> {
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
    return null;
  }

  /** Route to the right server for a file and open it */
  async openFile(filePath: string): Promise<void> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return;
    const server = await this.getServer(langId);
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

  /** Route closeFile to the right server */
  async closeFile(filePath: string): Promise<void> {
    const langId = detectLanguageFromExtension(filePath);
    if (!langId) return;
    const server = await this.getServer(langId);
    if (!server) return;
    await server.didClose(filePath);
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
export async function shutdownAllManagers(): Promise<void> {
  for (const mgr of managerCache.values()) {
    await mgr.shutdown();
  }
  managerCache.clear();
  managerAccessOrder.length = 0;
}

const managerCache = new Map<string, LSPManager>();

let bridgeInstance: LSPBridge | null = null;
let initAttempted = false;

async function createBridge(): Promise<LSPBridge | null> {
  return {
    isAvailable: () => {
      try {
        const mgr = managerCache.get("__default__");
        return mgr ? mgr.connectedLanguageCount > 0 : false;
      } catch { return false; }
    },

    async goToDefinition(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPLocation | null> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return null;
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return null;
        return serverGoToDefinition(server, filePath, line, character);
      } catch { return null; }
    },

    async findReferences(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPLocation[]> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        await server.openFile(filePath);
        const result = await server.request("textDocument/references", {
          textDocument: { uri: `file://${resolve(filePath)}` },
          position: { line, character },
          context: { includeDeclaration: true },
        }) as LSPLocation[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async getDocumentSymbols(
      filePath: string, root: string,
    ): Promise<LSPDocumentSymbol[]> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        await server.openFile(filePath);
        const result = await server.request("textDocument/documentSymbol", {
          textDocument: { uri: `file://${resolve(filePath)}` },
        }) as LSPDocumentSymbol[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async goToImplementation(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPLocation[]> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        await server.openFile(filePath);
        const result = await server.request("textDocument/implementation", {
          textDocument: { uri: `file://${resolve(filePath)}` },
          position: { line, character },
        }) as LSPLocation | LSPLocation[] | null;
        if (!result) return [];
        return Array.isArray(result) ? result : [result];
      } catch { return []; }
    },

    async workspaceSymbol(query: string, root: string): Promise<LSPWorkspaceSymbol[]> {
      try {
        const mgr = cachedManager(root);
        return mgr.workspaceSymbol(query);
      } catch { return []; }
    },

    async hover(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPHoverResult | null> {
      try {
        const mgr = cachedManager(root);
        return mgr.hover(filePath, line, character);
      } catch { return null; }
    },

    async openFile(filePath: string, root: string): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.openFile(filePath);
      } catch { /* best effort */ }
    },

    async updateFile(filePath: string, text: string, root: string): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.updateFile(filePath, text);
      } catch { /* best effort */ }
    },

    async closeFile(filePath: string, root: string): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.closeFile(filePath);
      } catch { /* best effort */ }
    },

    getOpenFiles(): string[] {
      const files: string[] = [];
      for (const mgr of managerCache.values()) {
        files.push(...mgr.getAllOpenFiles());
      }
      return files;
    },

    getStats(): LSPBridgeStats {
      const connectionsByRoot: Record<string, number> = {};
      let totalOpenDocuments = 0;
      for (const [root, mgr] of managerCache) {
        const count = (mgr as any).connectedLanguageCount ?? 0;
        connectionsByRoot[root] = count;
        totalOpenDocuments += (mgr as any).getAllOpenFiles()?.length ?? 0;
      }
      return {
        managerCount: managerCache.size,
        connectionsByRoot,
        totalOpenDocuments,
      };
    },
  };
}

async function serverGoToDefinition(
  server: LSPConnection, filePath: string, line: number, character: number,
): Promise<LSPLocation | null> {
  await server.openFile(filePath);
  const result = await server.request("textDocument/definition", {
    textDocument: { uri: `file://${resolve(filePath)}` },
    position: { line, character },
  }) as LSPLocation | LSPLocation[] | null;
  if (!result) return null;
  const locations = Array.isArray(result) ? result : [result];
  return locations[0] ?? null;
}

function cachedManager(root: string): LSPManager {
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
    // Eagerly start all available servers, but don't block the return
    mgr.startAll().catch(() => {});
  } else {
    // Move to end of access order (most-recently-used)
    const idx = managerAccessOrder.indexOf(root);
    if (idx !== -1) managerAccessOrder.splice(idx, 1);
    managerAccessOrder.push(root);
  }
  return mgr;
}

// ── Module-level eager init ───────────────────────────────────────

// Kick off LSP server startup at module load time for the current
// working directory (typically the project root). Servers start in
// the background before the first tool call.
const EAGER_INIT_TIMEOUT_MS = 8000;

const eagerRoot = process.cwd();
if (eagerRoot && existsSync(eagerRoot)) {
  let timedOut = false;
  setTimeout(() => { timedOut = true; }, EAGER_INIT_TIMEOUT_MS);
  (async () => {
    try {
      const info = detectProjectLanguages(eagerRoot);
      if (timedOut) return;
      if (info.supportedLanguages.length > 0) {
        const mgr = new LSPManager(eagerRoot);
        managerCache.set(eagerRoot, mgr);
        await Promise.race([
          mgr.startAll(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("eager init timeout")), EAGER_INIT_TIMEOUT_MS)),
        ]);
      }
    } catch { /* LSP initialization is best-effort */ }
  })().catch(() => {});
}

// ── Public API ────────────────────────────────────────────────────

const BRIDGE_INIT_TIMEOUT_MS = 5000;

export async function getLSPBridge(): Promise<LSPBridge | null> {
  if (!initAttempted) {
    initAttempted = true;
    bridgeInstance = await Promise.race([
      createBridge(),
      new Promise<LSPBridge | null>((resolve) => setTimeout(() => resolve(null), BRIDGE_INIT_TIMEOUT_MS)),
    ]);
  }
  return bridgeInstance;
}

export function getProjectLSPInfo(root: string): ProjectLSPInfo {
  return detectProjectLanguages(root);
}

export function resetLSPBridge(): void {
  bridgeInstance = null;
  initAttempted = false;
}
