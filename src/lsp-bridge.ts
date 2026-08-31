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
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { resolveLanguageServer } from "./language-intelligence-runtime.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";

// ── Language intelligence wiring ───────────────────────────────────────
// Cache of resolved executable/args per `${root}:${languageId}` so that
// LSPManager can spawn the exact resolved binary (project-local path or
// override) rather than the bare PATH command. Key: `${root}:${languageId}`
export const resolvedServerCache = new Map<string, { executable: string; args: string[] }>();

const EXT_FOR_LANGUAGE: Record<string, string> = {
  typescript: ".ts",
  typescriptreact: ".tsx",
  javascript: ".js",
  javascriptreact: ".jsx",
  python: ".py",
  rust: ".rs",
  go: ".go",
  java: ".java",
  c: ".c",
  cpp: ".cpp",
  csharp: ".cs",
  php: ".php",
  bash: ".sh",
  shellscript: ".sh",
  json: ".json",
  yaml: ".yaml",
  html: ".html",
  css: ".css",
  lua: ".lua",
  ruby: ".rb",
};

function dummyFileForLanguage(languageId: string, root: string): string {
  const ext = EXT_FOR_LANGUAGE[languageId] ?? ".txt";
  return join(root, `__probe__${ext}`);
}

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

export interface LSPDiagnostic {
  message: string;
  severity?: number;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface LSPDocumentChange {
  /** Absolute file path that changed */
  filePath: string;
  /** New full text content */
  text: string;
}

// Extension seam: future mutating autofix/format and external security-scanner triage plugs here — add new status values (e.g. "needs-triage") and result fields without closing switch/default paths.
// Additive-friendly honesty status — use string union with (string & {}) so future values like "needs-triage" do not break existing consumers.
export type LspOutcomeStatus = "unavailable" | "empty" | "confirmed" | "degraded" | (string & {});

export interface LspNavigationOutcomeSingle {
  status: LspOutcomeStatus;
  location: LSPLocation | null;
}

export interface LspNavigationOutcomeList {
  status: LspOutcomeStatus;
  locations: LSPLocation[];
}

export interface LspDocumentSymbolsOutcome {
  status: LspOutcomeStatus;
  symbols: LSPDocumentSymbol[];
}

export interface LspWorkspaceSymbolsOutcome {
  status: LspOutcomeStatus;
  symbols: LSPWorkspaceSymbol[];
}

export interface LspHoverOutcome {
  status: LspOutcomeStatus;
  hover: LSPHoverResult | null;
}

export interface LSPCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LSPRange;
  selectionRange: LSPRange;
  detail?: string;
  tags?: number[];
  data?: unknown;
}

export interface LSPCallHierarchyIncomingCall {
  from: LSPCallHierarchyItem;
  fromRanges: LSPRange[];
}

export interface LSPCallHierarchyOutgoingCall {
  to: LSPCallHierarchyItem;
  fromRanges: LSPRange[];
}

export interface LspDiagnosticsOutcome {
  status: LspOutcomeStatus;
  diagnostics: LSPDiagnostic[];
  truncated?: boolean;
}

export interface LspCallHierarchyPrepareOutcome {
  status: LspOutcomeStatus;
  items: LSPCallHierarchyItem[];
}

export interface LspIncomingCallsOutcome {
  status: LspOutcomeStatus;
  calls: LSPCallHierarchyIncomingCall[];
}

export interface LspOutgoingCallsOutcome {
  status: LspOutcomeStatus;
  calls: LSPCallHierarchyOutgoingCall[];
}

export interface LspOutcomeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  waitMs?: number;
  maxPerFile?: number;
}

export interface LSPBridge {
  isAvailable(): boolean;
  goToDefinition(filePath: string, line: number, character: number, root: string): Promise<LSPLocation | null>;
  findReferences(filePath: string, line: number, character: number, root: string): Promise<LSPLocation[]>;
  getDocumentSymbols(filePath: string, root: string): Promise<LSPDocumentSymbol[]>;
  goToImplementation(filePath: string, line: number, character: number, root: string): Promise<LSPLocation[]>;
  prepareCallHierarchy(filePath: string, line: number, character: number, root: string): Promise<LSPCallHierarchyItem[]>;
  incomingCalls(item: LSPCallHierarchyItem, root: string): Promise<LSPCallHierarchyIncomingCall[]>;
  outgoingCalls(item: LSPCallHierarchyItem, root: string): Promise<LSPCallHierarchyOutgoingCall[]>;

  /** Query workspace/symbol across all active LSP servers */
  workspaceSymbol(query: string, root: string): Promise<LSPWorkspaceSymbol[]>;

  /** Query textDocument/hover for type/signature info at a position */
  hover(filePath: string, line: number, character: number, root: string): Promise<LSPHoverResult | null>;

  /** Open a file on the LSP server (idempotent — no-op if already open) */
  openFile(filePath: string, root: string, purpose?: "warmup" | "request"): Promise<void>;

  /** Send full-text didChange to the LSP server for an open file */
  updateFile(filePath: string, text: string, root: string): Promise<void>;

  /** Send didSave to the LSP server for an open file */
  didSave(filePath: string, root: string): Promise<void>;

  /** Send didClose to release the file on the LSP server */
  closeFile(filePath: string, root: string): Promise<void>;

  /** Return absolute paths of all files currently open on any LSP connection */
  getOpenFiles(): string[];

  /** Collect latest publishDiagnostics notifications for file. */
  getDiagnostics(filePath: string, root: string): Promise<LSPDiagnostic[]>;

  // ── Outcome (honesty-labeled) navigation + diagnostics — additive, bounded by timeout + AbortSignal ──
  goToDefinitionOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeSingle>;
  findReferencesOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList>;
  getDocumentSymbolsOutcome(filePath: string, root: string, opts?: LspOutcomeOptions): Promise<LspDocumentSymbolsOutcome>;
  goToImplementationOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList>;
  workspaceSymbolOutcome(query: string, root: string, opts?: LspOutcomeOptions): Promise<LspWorkspaceSymbolsOutcome>;
  hoverOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspHoverOutcome>;
  getFreshDiagnosticsOutcome(filePath: string, root: string, opts?: LspOutcomeOptions): Promise<LspDiagnosticsOutcome>;
  rename(filePath: string, line: number, character: number, newName: string, root: string): Promise<LspWorkspaceEdit | null>;
  prepareRename(filePath: string, line: number, character: number, root: string): Promise<{ range: LSPRange; placeholder?: string } | null>;
  organizeImports(filePath: string, root: string): Promise<LspWorkspaceEdit | null>;
  formatting(filePath: string, root: string, tabSize?: number, insertSpaces?: boolean): Promise<LspWorkspaceEdit | null>;
  codeActions(filePath: string, range: LSPRange, context: { diagnostics?: unknown[]; only?: string[] }, root: string): Promise<Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }>>;
  // Call hierarchy — raw item-based incoming/outgoing, outcome position-based (internally resolves via prepareCallHierarchy)
  prepareCallHierarchyOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspCallHierarchyPrepareOutcome>;
  incomingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspIncomingCallsOutcome>;
  outgoingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspOutgoingCallsOutcome>;

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
  const hasCMakeLists = existsSync(join(root, "CMakeLists.txt"));
  const hasMakefile = existsSync(join(root, "Makefile")) || existsSync(join(root, "makefile")) || existsSync(join(root, "GNUMakefile"));
  const hasCompileCommands = existsSync(join(root, "compile_commands.json"));
  const hasComposerJson = existsSync(join(root, "composer.json"));
  const hasCSharpProject = hasCSharpMarker(root);
  const hasGemfile = existsSync(join(root, "Gemfile"));

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
  if (hasCMakeLists || hasMakefile || hasCompileCommands) {
    detected.push("c", "cpp");
  }
  if (hasCSharpProject) {
    detected.push("csharp");
  }
  if (hasComposerJson) {
    detected.push("php");
  }
  if (hasGemfile) {
    detected.push("ruby");
  }

  // Sample source extensions unconditionally and UNION with marker-based detection
  // (caps at 200 top-level entries so perf remains cheap for large projects).
  {
    const exts = sampleSourceExtensions(root);
    const langMap: Record<string, string[]> = {
      ts: ["typescript"], tsx: ["typescriptreact", "typescript"],
      js: ["javascript"], jsx: ["javascriptreact", "javascript"],
      py: ["python"], rs: ["rust"], go: ["go"], java: ["java"],
      c: ["c"], h: ["c"], cpp: ["cpp"], hpp: ["cpp"], cc: ["cpp"], cxx: ["cpp"], hh: ["cpp"], hxx: ["cpp"],
      cs: ["csharp"], php: ["php"], sh: ["bash"], bash: ["bash"],
      json: ["json"], jsonc: ["json"], yaml: ["yaml"], yml: ["yaml"], html: ["html"], htm: ["html"],
      css: ["css"], scss: ["css"], less: ["css"], lua: ["lua"], rb: ["ruby"],
    };
    for (const extRaw of exts) {
      const ext = extRaw.toLowerCase();
      const langs = langMap[ext];
      if (langs) for (const l of langs) if (!detected.includes(l)) detected.push(l);
    }
  }

  // Deduplicate
  const unique = [...new Set(detected)];
  const { commands: availableServers, languages: supported } = findAvailableServers(unique, root);

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

function hasCSharpMarker(root: string): boolean {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && (e.name.endsWith(".csproj") || e.name.endsWith(".sln"))) return true;
    }
  } catch { /* ignore */ }
  return false;
}

// ── LSP server availability detection ──────────────────────────────

export interface ServerConfig {
  command: string;
  args: string[];
  languageIds: string[];
}

export const ALL_SERVER_CONFIGS: ServerConfig[] = [
  { command: "typescript-language-server", args: ["--stdio"], languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
  { command: "typescriptlangserver", args: ["--stdio"], languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"] },
  { command: "pyright", args: ["--stdio"], languageIds: ["python"] },
  { command: "pylsp", args: ["--stdio"], languageIds: ["python"] },
  { command: "pyls", args: ["--stdio"], languageIds: ["python"] },
  { command: "jedi-language-server", args: ["--stdio"], languageIds: ["python"] },
  { command: "rust-analyzer", args: ["--stdio"], languageIds: ["rust"] },
  { command: "gopls", args: [], languageIds: ["go"] },
  { command: "jdtls", args: [], languageIds: ["java"] },
  { command: "clangd", args: [], languageIds: ["c", "cpp"] },
  { command: "omnisharp", args: ["--languageserver"], languageIds: ["csharp"] },
  { command: "csharp-ls", args: [], languageIds: ["csharp"] },
  { command: "bash-language-server", args: ["start"], languageIds: ["bash", "shellscript"] },
  { command: "intelephense", args: ["--stdio"], languageIds: ["php"] },
  { command: "phpactor", args: ["language-server"], languageIds: ["php"] },
  // 6 net-new languages from LANGUAGE_SERVER_CATALOG — synced, not duplicated (see catalog)
  { command: "vscode-json-language-server", args: ["--stdio"], languageIds: ["json"] },
  { command: "yaml-language-server", args: ["--stdio"], languageIds: ["yaml"] },
  { command: "vscode-html-language-server", args: ["--stdio"], languageIds: ["html"] },
  { command: "vscode-css-language-server", args: ["--stdio"], languageIds: ["css"] },
  { command: "lua-language-server", args: [], languageIds: ["lua"] },
  { command: "solargraph", args: ["stdio"], languageIds: ["ruby"] },
];

function findAvailableServers(neededLanguages: string[], root: string = process.cwd()): { commands: string[]; languages: string[] } {
  const available: string[] = [];
  const resolvedLanguages: string[] = [];
  const seenLangs = new Set<string>();
  for (const lang of neededLanguages) {
    if (seenLangs.has(lang)) continue;
    seenLangs.add(lang);
    const dummy = dummyFileForLanguage(lang, root);
    try {
      const res = resolveLanguageServer(dummy, root);
      if (res && res.status === "available") {
        resolvedServerCache.set(`${root}:${lang}`, { executable: res.executable, args: res.args });
        const cmd = res.executable.includes("/") || res.executable.includes("\\") ? basename(res.executable) : res.executable;
        // Push the exact executable for overrides (e.g. my-pyright) so caller sees it; for project-local push basename for compat
        if (res.executable.includes("/") || res.executable.includes("\\")) {
          available.push(cmd);
        } else {
          available.push(res.executable);
        }
        resolvedLanguages.push(lang);
      } else {
        resolvedServerCache.delete(`${root}:${lang}`);
      }
    } catch {
      resolvedServerCache.delete(`${root}:${lang}`);
    }
  }
  return { commands: available, languages: resolvedLanguages };
}


// ── Language ID detection ──────────────────────────────────────────

export function detectLanguageFromExtension(filePath: string): string | null {
  const ext = filePath.toLowerCase();
  if (ext.endsWith(".ts") || ext.endsWith(".mts") || ext.endsWith(".cts")) return "typescript";
  if (ext.endsWith(".tsx")) return "typescriptreact";
  if (ext.endsWith(".js") || ext.endsWith(".mjs") || ext.endsWith(".cjs")) return "javascript";
  if (ext.endsWith(".jsx")) return "javascriptreact";
  if (ext.endsWith(".py")) return "python";
  if (ext.endsWith(".rs")) return "rust";
  if (ext.endsWith(".go")) return "go";
  if (ext.endsWith(".java")) return "java";
  if (ext.endsWith(".c")) return "c";
  if (ext.endsWith(".h")) return "c";
  if (ext.endsWith(".cpp")) return "cpp";
  if (ext.endsWith(".hpp")) return "cpp";
  if (ext.endsWith(".cc")) return "cpp";
  if (ext.endsWith(".cxx")) return "cpp";
  if (ext.endsWith(".hh")) return "cpp";
  if (ext.endsWith(".hxx")) return "cpp";
  if (ext.endsWith(".cs")) return "csharp";
  if (ext.endsWith(".php")) return "php";
  if (ext.endsWith(".sh")) return "bash";
  if (ext.endsWith(".bash")) return "bash";
  if (ext.endsWith(".json") || ext.endsWith(".jsonc")) return "json";
  if (ext.endsWith(".yaml") || ext.endsWith(".yml")) return "yaml";
  if (ext.endsWith(".html") || ext.endsWith(".htm")) return "html";
  if (ext.endsWith(".css") || ext.endsWith(".scss") || ext.endsWith(".less")) return "css";
  if (ext.endsWith(".lua")) return "lua";
  if (ext.endsWith(".rb")) return "ruby";
  return null;
}

// ── JSON-RPC connection ────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Exported for unit testing only (constructing a connection against a mocked
 * child process). Not part of the public LSPBridge surface — external
 * callers should go through getLSPBridge().
 */
export class LSPConnection {
  /** Cap on accumulated stdout buffer size before we force-close the connection. */
  private static readonly BUFFER_LIMIT_BYTES = 50 * 1024 * 1024; // 50MB

  private proc: ReturnType<typeof spawn> | null = null;
  private reqId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private closed = false;

  /** Track which files are open on this connection */
  private openDocuments = new Map<string, number>(); // filePath → version
  private diagnostics = new Map<string, LSPDiagnostic[]>();

  /** Registered handlers for server-initiated notifications, keyed by method */
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();

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
          callHierarchy: { dynamicRegistration: false },
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
    if (this.openDocuments.has(resolved)) return;
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
   * sends didOpen with the given content instead (a didChange is only valid
   * once the server has seen a matching didOpen).
   */
  async didChange(filePath: string, text: string): Promise<void> {
    const resolved = resolve(filePath);
    const uri = `file://${resolved}`;
    // Drop any diagnostics published for the previous document state so a
    // post-edit poll cannot observe stale results from before this update.
    this.diagnostics.delete(resolved);
    if (!this.openDocuments.has(resolved)) {
      const version = 1;
      this.openDocuments.set(resolved, version);
      await this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: detectLanguageFromExtension(resolved) ?? "plaintext", version, text },
      });
      return;
    }
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

  /**
   * Notify the LSP server that an open file was saved. No-op if the file is
   * not currently tracked as open on this connection.
   */
  async didSave(filePath: string): Promise<void> {
    const resolved = resolve(filePath);
    if (!this.openDocuments.has(resolved)) return;
    const uri = `file://${resolved}`;
    await this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  /**
   * Subscribe to server-initiated notifications for a given method (e.g.
   * "window/logMessage"). Multiple handlers may be registered for the same
   * method. Returns an unsubscribe function that removes only this handler.
   */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = [];
      this.notificationHandlers.set(method, handlers);
    }
    handlers.push(handler);
    return () => {
      const list = this.notificationHandlers.get(method);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    };
  }

  /** Check if a file is currently open on this connection */
  isOpen(filePath: string): boolean {
    return this.openDocuments.has(resolve(filePath));
  }

  /** Get all open file paths on this connection */
  getOpenFilePaths(): string[] {
    return [...this.openDocuments.keys()];
  }

  /** Get latest cached publishDiagnostics results for a document */
  getDiagnostics(filePath: string): LSPDiagnostic[] { return this.diagnostics.get(resolve(filePath)) ?? []; }

  /** Clear cached publishDiagnostics for a document (used before fresh poll to avoid stale confirmed). */
  clearDiagnostics(filePath: string): void { this.diagnostics.delete(resolve(filePath)); }

  /** Whether a publishDiagnostics receipt exists for file (distinguishes confirmed-empty from unconfirmed). */
  hasDiagnostics(filePath: string): boolean { return this.diagnostics.has(resolve(filePath)); }

  /** Get open document count */
  get openDocumentCount(): number {
    return this.openDocuments.size;
  }

  async rename(filePath: string, line0: number, character0: number, newName: string): Promise<LspWorkspaceEdit | null> {
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/rename", { textDocument: { uri }, position: { line: line0, character: character0 }, newName });
    } catch {
      return null;
    }
    if (!result || typeof result !== "object") return null;
    const raw = result as Record<string, unknown>;
    const fileEdits: Array<{ filePath: string; edits: Array<{ range: LSPRange; newText: string }> }> = [];
    const toPath = (u: string): string | null => {
      try {
        if (u.startsWith("file://")) return resolve(fileURLToPath(u));
        return null;
      } catch { return null; }
    };
    if (Array.isArray(raw.documentChanges)) {
      for (const dc of raw.documentChanges as unknown[]) {
        if (!dc || typeof dc !== "object") return null;
        const entry = dc as Record<string, unknown>;
        // Fail cleanly on resource operations (CreateFile/RenameFile/DeleteFile) — rename v1 only supports TextDocumentEdit; returning partial edits would be unsafe
        if (typeof entry.kind === "string") return null;
        const td = entry.textDocument as Record<string, unknown> | undefined;
        const edits = entry.edits as unknown;
        if (!td || typeof td.uri !== "string" || !Array.isArray(edits)) return null;
        const fp = toPath(td.uri as string);
        if (!fp) return null;
        const normEdits: Array<{ range: LSPRange; newText: string }> = [];
        for (const e of edits as unknown[]) {
          if (!e || typeof e !== "object") continue;
          const er = e as Record<string, unknown>;
          const range = er.range as LSPRange | undefined;
          const newText = er.newText as string | undefined;
          if (!range || typeof newText !== "string") continue;
          normEdits.push({ range, newText });
        }
        if (normEdits.length) fileEdits.push({ filePath: fp, edits: normEdits });
      }
    } else if (raw.changes && typeof raw.changes === "object") {
      const changes = raw.changes as Record<string, unknown>;
      for (const [uriKey, editsRaw] of Object.entries(changes)) {
        const fp = toPath(uriKey);
        if (!fp) return null;
        if (!Array.isArray(editsRaw)) return null;
        const normEdits: Array<{ range: LSPRange; newText: string }> = [];
        for (const e of editsRaw as unknown[]) {
          if (!e || typeof e !== "object") continue;
          const er = e as Record<string, unknown>;
          const range = er.range as LSPRange | undefined;
          const newText = er.newText as string | undefined;
          if (!range || typeof newText !== "string") continue;
          normEdits.push({ range, newText });
        }
        if (normEdits.length) fileEdits.push({ filePath: fp, edits: normEdits });
      }
    } else {
      return null;
    }
    if (fileEdits.length === 0) return null;
    // Convert to protocol LspWorkspaceEdit shape (fileEdits with LspTextEdit)
    return { fileEdits: fileEdits.map((fe) => ({ filePath: fe.filePath, edits: fe.edits.map((ed) => ({ filePath: fe.filePath, range: ed.range, newText: ed.newText })) })) } as unknown as LspWorkspaceEdit;
  }

  async prepareRename(filePath: string, line0: number, character0: number): Promise<{ range: LSPRange; placeholder?: string } | null> {
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/prepareRename", { textDocument: { uri }, position: { line: line0, character: character0 } });
    } catch {
      return null;
    }
    if (!result || typeof result !== "object") return null;
    // Server may return Range directly or { range, placeholder, defaultBehavior } etc
    const r = result as Record<string, unknown>;
    if (r.start && r.end) {
      // Is a Range itself
      const start = r.start as Record<string, unknown>;
      const end = r.end as Record<string, unknown>;
      if (typeof start.line === "number" && typeof start.character === "number" && typeof end.line === "number" && typeof end.character === "number") {
        return { range: r as unknown as LSPRange };
      }
    }
    if (r.range && typeof r.range === "object") {
      const range = r.range as LSPRange;
      const placeholder = typeof r.placeholder === "string" ? (r.placeholder as string) : undefined;
      if (range.start && range.end) return { range, placeholder };
    }
    return null;
  }

  async organizeImports(filePath: string): Promise<LspWorkspaceEdit | null> {
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/codeAction", {
        textDocument: { uri },
        range: { start: { line: 0, character: 0 }, end: { line: Number.MAX_SAFE_INTEGER, character: 0 } },
        context: { only: ["source.organizeImports"] },
      });
    } catch {
      return null;
    }
    if (!Array.isArray(result)) return null;
    const actions = result as Array<Record<string, unknown>>;
    let editRaw: unknown = null;
    for (const a of actions) {
      if (a && typeof a === "object" && "edit" in a && (a as Record<string, unknown>).edit) {
        editRaw = (a as Record<string, unknown>).edit;
        break;
      }
    }
    if (!editRaw) return null;
    return convertWorkspaceEdit(editRaw);
  }

  async formatting(filePath: string, tabSize?: number, insertSpaces?: boolean): Promise<LspWorkspaceEdit | null> {
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: tabSize ?? 2, insertSpaces: insertSpaces ?? true },
      });
    } catch {
      return null;
    }
    if (!Array.isArray(result) || (result as unknown[]).length === 0) return null;
    const editsRaw = result as Array<Record<string, unknown>>;
    const fp = resolve(filePath);
    const edits: Array<{ range: LSPRange; newText: string }> = [];
    for (const e of editsRaw) {
      if (!e || typeof e !== "object") continue;
      const range = (e as Record<string, unknown>).range as LSPRange | undefined;
      const newText = (e as Record<string, unknown>).newText as string | undefined;
      if (!range || typeof newText !== "string") continue;
      edits.push({ range, newText });
    }
    if (edits.length === 0) return null;
    return { fileEdits: [{ filePath: fp, edits: edits.map((ed) => ({ filePath: fp, range: ed.range, newText: ed.newText })) }] } as unknown as LspWorkspaceEdit;
  }

  async codeActions(
    filePath: string,
    range: LSPRange,
    context: { diagnostics?: unknown[]; only?: string[] },
  ): Promise<Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }>> {
    const uri = pathToFileURL(resolve(filePath)).href;
    let result: unknown;
    try {
      result = await this.request("textDocument/codeAction", {
        textDocument: { uri },
        range,
        context,
      });
    } catch {
      return [];
    }
    if (!Array.isArray(result) || result === null) return [];
    const actions = result as Array<Record<string, unknown>>;
    return actions.map((a) => {
      const title = typeof a.title === "string" ? (a.title as string) : "";
      const kind = typeof a.kind === "string" ? (a.kind as string) : undefined;
      const isPreferred = typeof a.isPreferred === "boolean" ? (a.isPreferred as boolean) : undefined;
      let edit: LspWorkspaceEdit | undefined;
      if (a.edit) {
        const converted = convertWorkspaceEdit(a.edit);
        if (converted) edit = converted;
      }
      return { title, kind, edit, isPreferred };
    });
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
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (this.buffer.length > LSPConnection.BUFFER_LIMIT_BYTES) {
      console.error(
        `[lsp-bridge] LSP connection stdout buffer exceeded ${LSPConnection.BUFFER_LIMIT_BYTES} bytes ` +
        `without a complete message; forcibly closing the connection to prevent unbounded memory growth.`,
      );
      this.buffer = Buffer.alloc(0);
      this.closed = true;
      this._rejectAll(new Error("LSP connection buffer overflow"));
      try { this.proc?.kill(); } catch { /* best effort */ }
      return;
    }

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const headerText = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const match = /^Content-Length: (\d+)/.exec(headerText);
      if (!match) break;
      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);
      try {
        const msg = JSON.parse(body.toString("utf-8"));
        if (msg.method === "textDocument/publishDiagnostics") {
          const uri = msg.params?.uri as string | undefined;
          if (typeof uri === "string" && uri.startsWith("file:")) {
            try {
              this.diagnostics.set(resolve(fileURLToPath(uri)), (msg.params?.diagnostics ?? []) as LSPDiagnostic[]);
            } catch {
              // Ignore malformed file URIs without updating the map.
            }
          }
        }
        if (msg.id !== undefined && msg.id !== null) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.error) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        } else if (typeof msg.method === "string") {
          // Server-initiated notification (no id) — dispatch to registered handlers.
          const handlers = this.notificationHandlers.get(msg.method);
          if (handlers && handlers.length > 0) {
            for (const handler of [...handlers]) {
              try { handler(msg.params); } catch { /* isolate handler errors from the read loop */ }
            }
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
      const { ensureLanguageServerAvailable } = await import("./language-intelligence-runtime.js");
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

function convertWorkspaceEdit(raw: unknown): LspWorkspaceEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const toPath = (u: string): string | null => {
    try {
      return fileURLToPath(u);
    } catch {
      return null;
    }
  };
  const fileEdits: Array<{ filePath: string; edits: Array<{ range: LSPRange; newText: string }> }> = [];
  if (Array.isArray((obj as Record<string, unknown>).documentChanges)) {
    for (const dc of (obj as Record<string, unknown>).documentChanges as unknown[]) {
      const entry = dc as Record<string, unknown>;
      // Reject resource operations (CreateFile/RenameFile/DeleteFile) — return null for whole edit
      if (typeof entry.kind === "string") return null;
      const td = entry.textDocument as Record<string, unknown> | undefined;
      const editsRaw = entry.edits as unknown[] | undefined;
      if (!td || !Array.isArray(editsRaw)) return null;
      const fp = toPath(td.uri as string);
      if (!fp) continue;
      const normEdits: Array<{ range: LSPRange; newText: string }> = [];
      for (const er of editsRaw) {
        const e = er as Record<string, unknown>;
        const range = e.range as LSPRange | undefined;
        const newText = e.newText as string | undefined;
        if (!range || typeof newText !== "string") continue;
        normEdits.push({ range, newText });
      }
      fileEdits.push({ filePath: fp, edits: normEdits });
    }
  }
  if (obj.changes && typeof obj.changes === "object") {
    for (const [uriKey, editsRaw] of Object.entries(obj.changes as Record<string, unknown>)) {
      const fp = toPath(uriKey);
      if (!fp) continue;
      if (!Array.isArray(editsRaw)) continue;
      const normEdits: Array<{ range: LSPRange; newText: string }> = [];
      for (const er of editsRaw as unknown[]) {
        const e = er as Record<string, unknown>;
        const range = e.range as LSPRange | undefined;
        const newText = e.newText as string | undefined;
        if (!range || typeof newText !== "string") continue;
        normEdits.push({ range, newText });
      }
      fileEdits.push({ filePath: fp, edits: normEdits });
    }
  }
  if (fileEdits.length === 0) return null;
  return { fileEdits: fileEdits.map((fe) => ({ filePath: fe.filePath, edits: fe.edits.map((ed) => ({ filePath: fe.filePath, range: ed.range, newText: ed.newText })) })) } as unknown as LspWorkspaceEdit;
}

function toZeroBased(line1: number): number { return Math.max(0, line1 - 1); }
const DEFAULT_OUTCOME_TIMEOUT_MS = 5000;
async function withBudget<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  return await new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (done) return; done = true; reject(new Error(`timed out after ${timeoutMs}ms`)); }, timeoutMs);
    const onAbort = () => { if (done) return; done = true; clearTimeout(timer); reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then((v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(v); }, (e) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(e); });
  });
}

async function createBridge(): Promise<LSPBridge | null> {
  return {
    isAvailable: () => {
      try {
        // Evaluate actual cached managers (keyed by workspace root), not the
        // dead `__default__` sentinel that is never inserted into the cache.
        for (const mgr of managerCache.values()) {
          if (mgr.connectedLanguageCount > 0) return true;
        }
        return false;
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

    async prepareCallHierarchy(
      filePath: string, line: number, character: number, root: string,
    ): Promise<LSPCallHierarchyItem[]> {
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        await server.openFile(filePath);
        const result = await server.request("textDocument/prepareCallHierarchy", {
          textDocument: { uri: `file://${resolve(filePath)}` },
          position: { line, character },
        }) as LSPCallHierarchyItem[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async incomingCalls(
      item: LSPCallHierarchyItem, root: string,
    ): Promise<LSPCallHierarchyIncomingCall[]> {
      const langId = detectLanguageFromExtension(item.uri.replace(/^file:\/\//, ""));
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        const result = await server.request("callHierarchy/incomingCalls", { item }) as LSPCallHierarchyIncomingCall[] | null;
        return result ?? [];
      } catch { return []; }
    },

    async outgoingCalls(
      item: LSPCallHierarchyItem, root: string,
    ): Promise<LSPCallHierarchyOutgoingCall[]> {
      const langId = detectLanguageFromExtension(item.uri.replace(/^file:\/\//, ""));
      if (!langId) return [];
      try {
        const mgr = cachedManager(root);
        const server = await mgr.getServer(langId);
        if (!server) return [];
        const result = await server.request("callHierarchy/outgoingCalls", { item }) as LSPCallHierarchyOutgoingCall[] | null;
        return result ?? [];
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

    async openFile(filePath: string, root: string, purpose?: "warmup" | "request"): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.openFile(filePath, root, purpose ?? "warmup");
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

    async didSave(filePath: string, root: string): Promise<void> {
      try {
        const mgr = cachedManager(root);
        await mgr.didSave(filePath);
      } catch { /* best effort */ }
    },

    async getDiagnostics(filePath: string, root: string): Promise<LSPDiagnostic[]> {
      try {
        const mgr = cachedManager(root);
        return await mgr.getDiagnosticsFor(filePath);
      } catch { return []; }
    },

    async rename(filePath: string, line: number, character: number, newName: string, root: string): Promise<LspWorkspaceEdit | null> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      if (line0 < 0 || char0 < 0) return null;
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return null;
        return await withBudget(server.rename(filePath, line0, char0, newName), timeoutMs);
      } catch { return null; }
    },
    async prepareRename(filePath: string, line: number, character: number, root: string): Promise<{ range: LSPRange; placeholder?: string } | null> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      if (line0 < 0 || char0 < 0) return null;
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return null;
        return await withBudget(server.prepareRename(filePath, line0, char0), timeoutMs);
      } catch { return null; }
    },
    async organizeImports(filePath: string, root: string): Promise<LspWorkspaceEdit | null> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return null;
        return await withBudget(server.organizeImports(filePath), timeoutMs);
      } catch { return null; }
    },
    async formatting(filePath: string, root: string, tabSize?: number, insertSpaces?: boolean): Promise<LspWorkspaceEdit | null> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return null; }
      if (!langId) return null;
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return null;
        return await withBudget(server.formatting(filePath, tabSize, insertSpaces), timeoutMs);
      } catch { return null; }
    },
    async codeActions(filePath: string, range: LSPRange, context: { diagnostics?: unknown[]; only?: string[] }, root: string): Promise<Array<{ title: string; kind?: string; edit?: LspWorkspaceEdit; isPreferred?: boolean }>> {
      let langId: string | null;
      try { langId = detectLanguageFromExtension(filePath); } catch { return []; }
      if (!langId) return [];
      const timeoutMs = 10_000;
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs);
        if (!server) return [];
        return await withBudget(server.codeActions(filePath, range, context), timeoutMs);
      } catch { return []; }
    },
    async goToDefinitionOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeSingle> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", location: null };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", location: null };
        const loc = await withBudget(serverGoToDefinition(server, filePath, line0, char0), timeoutMs, opts?.signal);
        if (!loc) return { status: "empty", location: null };
        return { status: "confirmed", location: loc };
      } catch { return { status: "degraded", location: null }; }
    },

    async findReferencesOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", locations: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", locations: [] };
        const locs = await withBudget((async () => {
          await server.openFile(filePath);
          const result = await server.request("textDocument/references", { textDocument: { uri: `file://${resolve(filePath)}` }, position: { line: line0, character: char0 }, context: { includeDeclaration: true } }) as LSPLocation[] | null;
          return result ?? [];
        })(), timeoutMs, opts?.signal);
        if (locs.length === 0) return { status: "empty", locations: [] };
        return { status: "confirmed", locations: locs };
      } catch { return { status: "degraded", locations: [] }; }
    },

    async getDocumentSymbolsOutcome(filePath: string, root: string, opts?: LspOutcomeOptions): Promise<LspDocumentSymbolsOutcome> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", symbols: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", symbols: [] };
        const symbols = await withBudget((async () => {
          await server.openFile(filePath);
          const result = await server.request("textDocument/documentSymbol", { textDocument: { uri: `file://${resolve(filePath)}` } }) as LSPDocumentSymbol[] | null;
          return result ?? [];
        })(), timeoutMs, opts?.signal);
        if (symbols.length === 0) return { status: "empty", symbols: [] };
        return { status: "confirmed", symbols };
      } catch { return { status: "degraded", symbols: [] }; }
    },

    async goToImplementationOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspNavigationOutcomeList> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", locations: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", locations: [] };
        const locs = await withBudget((async () => {
          await server.openFile(filePath);
          const result = await server.request("textDocument/implementation", { textDocument: { uri: `file://${resolve(filePath)}` }, position: { line: line0, character: char0 } }) as LSPLocation | LSPLocation[] | null;
          if (!result) return [];
          return Array.isArray(result) ? result : [result];
        })(), timeoutMs, opts?.signal);
        if (locs.length === 0) return { status: "empty", locations: [] };
        return { status: "confirmed", locations: locs };
      } catch { return { status: "degraded", locations: [] }; }
    },

    async workspaceSymbolOutcome(query: string, root: string, opts?: LspOutcomeOptions): Promise<LspWorkspaceSymbolsOutcome> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      try {
        const mgr = cachedManager(root);
        const symbols = await withBudget(mgr.workspaceSymbol(query), timeoutMs, opts?.signal);
        if (symbols.length === 0) {
          // distinguish no server vs empty: if no connected languages then unavailable
          if (!mgr.connectedLanguageCount) return { status: "unavailable", symbols: [] };
          return { status: "empty", symbols: [] };
        }
        return { status: "confirmed", symbols };
      } catch { return { status: "degraded", symbols: [] }; }
    },

    async hoverOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspHoverOutcome> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", hover: null };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", hover: null };
        const result = await withBudget((async () => {
          await server.openFile(filePath);
          return server.hover(filePath, line0, char0);
        })(), timeoutMs, opts?.signal);
        if (!result) return { status: "empty", hover: null };
        return { status: "confirmed", hover: result };
      } catch { return { status: "degraded", hover: null }; }
    },

    async prepareCallHierarchyOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspCallHierarchyPrepareOutcome> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", items: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", items: [] };
        const items = await withBudget((async () => {
          await server.openFile(filePath);
          const result = await server.request("textDocument/prepareCallHierarchy", {
            textDocument: { uri: `file://${resolve(filePath)}` },
            position: { line: line0, character: char0 },
          }) as LSPCallHierarchyItem[] | null;
          return result ?? [];
        })(), timeoutMs, opts?.signal);
        if (items.length === 0) return { status: "empty", items: [] };
        return { status: "confirmed", items };
      } catch { return { status: "degraded", items: [] }; }
    },

    // Design choice: outcome-level incoming/outgoing are position-based.
    // They internally call prepareCallHierarchy to resolve the CallHierarchyItem, then call the calls request.
    // Raw item-based incomingCalls/outgoingCalls remain available for callers that already have an item (avoiding redundant prepare).
    async incomingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspIncomingCallsOutcome> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", calls: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", calls: [] };
        const calls = await withBudget((async () => {
          await server.openFile(filePath);
          const items = await server.request("textDocument/prepareCallHierarchy", {
            textDocument: { uri: `file://${resolve(filePath)}` },
            position: { line: line0, character: char0 },
          }) as LSPCallHierarchyItem[] | null;
          if (!items || items.length === 0) return null;
          const item = items[0]!;
          const result = await server.request("callHierarchy/incomingCalls", { item }) as LSPCallHierarchyIncomingCall[] | null;
          return result ?? [];
        })(), timeoutMs, opts?.signal);
        if (calls === null) return { status: "empty", calls: [] };
        if (calls.length === 0) return { status: "empty", calls: [] };
        return { status: "confirmed", calls };
      } catch { return { status: "degraded", calls: [] }; }
    },

    async outgoingCallsOutcome(filePath: string, line: number, character: number, root: string, opts?: LspOutcomeOptions): Promise<LspOutgoingCallsOutcome> {
      const line0 = toZeroBased(line);
      const char0 = toZeroBased(character);
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", calls: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", calls: [] };
        const calls = await withBudget((async () => {
          await server.openFile(filePath);
          const items = await server.request("textDocument/prepareCallHierarchy", {
            textDocument: { uri: `file://${resolve(filePath)}` },
            position: { line: line0, character: char0 },
          }) as LSPCallHierarchyItem[] | null;
          if (!items || items.length === 0) return null;
          const item = items[0]!;
          const result = await server.request("callHierarchy/outgoingCalls", { item }) as LSPCallHierarchyOutgoingCall[] | null;
          return result ?? [];
        })(), timeoutMs, opts?.signal);
        if (calls === null) return { status: "empty", calls: [] };
        if (calls.length === 0) return { status: "empty", calls: [] };
        return { status: "confirmed", calls };
      } catch { return { status: "degraded", calls: [] }; }
    },

    async getFreshDiagnosticsOutcome(filePath: string, root: string, opts?: LspOutcomeOptions): Promise<LspDiagnosticsOutcome> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_OUTCOME_TIMEOUT_MS;
      const waitMs = opts?.waitMs ?? 1500;
      const langId = detectLanguageFromExtension(filePath);
      if (!langId) return { status: "unavailable", diagnostics: [] };
      try {
        const mgr = cachedManager(root);
        const server = await withBudget(mgr.getServer(langId, { purpose: "request" }), timeoutMs, opts?.signal);
        if (!server) return { status: "unavailable", diagnostics: [] };
        const resolved = resolve(filePath);
        // clear stale cached diagnostics before refresh — only diagnostics observed after this point count as confirmed
        server.clearDiagnostics(resolved);
        // force refresh if already open (openFile is idempotent otherwise)
        if (server.isOpen(resolved)) {
          try { await withBudget(server.didClose(resolved), Math.min(500, timeoutMs), opts?.signal); } catch {}
        }
        await withBudget(server.openFile(filePath), timeoutMs, opts?.signal);
        const start = Date.now();
        let pullSucceeded = false;
        // poll cached diagnostics with budget respecting waitMs + timeout; distinguish confirmed-empty (receipt exists) from unconfirmed
        const poll = async (): Promise<LSPDiagnostic[]> => {
          while (Date.now() - start < waitMs) {
            if (opts?.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
            const hasReceipt = server.hasDiagnostics(resolved);
            if (hasReceipt) return server.getDiagnostics(resolved);
            const diags = await mgr.getDiagnosticsFor(filePath);
            if (diags.length > 0) return diags;
            await new Promise((r) => setTimeout(r, 50));
          }
          return await mgr.getDiagnosticsFor(filePath);
        };
        let diagnostics = await withBudget(poll(), timeoutMs, opts?.signal);
        const hasPublishReceipt = server.hasDiagnostics(resolved);
        // pull fallback: try textDocument/diagnostic if no publish receipt and no diagnostics yet
        if (diagnostics.length === 0 && !hasPublishReceipt) {
          try {
            const uri = `file://${resolved}`;
            const pull = await withBudget((server as any).request("textDocument/diagnostic", { textDocument: { uri }, previousResultId: "" }), Math.min(400, timeoutMs), opts?.signal) as any;
            if (pull !== null) {
              pullSucceeded = true;
              const items: LSPDiagnostic[] = pull?.items ?? pull?.diagnostics ?? (Array.isArray(pull) ? pull : []);
              if (items.length > 0) diagnostics = items;
            }
            // empty items with successful pull counts as confirmed-empty via pullSucceeded
          } catch {}
        }
        if (diagnostics.length > 0) {
          const maxPer = opts?.maxPerFile;
          if (maxPer !== undefined && diagnostics.length > maxPer) return { status: "confirmed", diagnostics: diagnostics.slice(0, maxPer), truncated: true };
          return { status: "confirmed", diagnostics };
        }
        if (hasPublishReceipt || pullSucceeded) return { status: "empty", diagnostics: [] };
        return { status: "degraded", diagnostics: [] };
      } catch { return { status: "degraded", diagnostics: [] }; }
    },

    getOpenFiles(): string[] {
      const files: string[] = [];
      for (const mgr of managerCache.values()) {
        files.push(...mgr.getAllOpenFiles());
      }
      return files;
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
  } else {
    // Move to end of access order (most-recently-used)
    const idx = managerAccessOrder.indexOf(root);
    if (idx !== -1) managerAccessOrder.splice(idx, 1);
    managerAccessOrder.push(root);
  }
  return mgr;
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

export function resetLSPBridge(): void {
  bridgeInstance = null;
  initAttempted = false;
}
