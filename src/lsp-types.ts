/**
 * LSP types + project/language detection.
 *
 * Split from lsp-bridge.ts (Phase B): type surface, resolved-server cache,
 * project-language detection, server-availability detection, and
 * extension-based language detection. No behavior change.
 */
import type { LspWorkspaceEdit } from "@rhinos0608/pi-workspace-protocol";
import { existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveLanguageServer } from "./language-intelligence-runtime.js";

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

export function dummyFileForLanguage(languageId: string, root: string): string {
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
// ── Language ID detection ─────────────────────────────────────────

/** Suffix → languageId lookup, ordered to preserve legacy if-chain precedence. */
const EXTENSION_SUFFIX_TABLE: ReadonlyArray<readonly [string, string]> = [
  [".ts", "typescript"], [".mts", "typescript"], [".cts", "typescript"],
  [".tsx", "typescriptreact"],
  [".js", "javascript"], [".mjs", "javascript"], [".cjs", "javascript"],
  [".jsx", "javascriptreact"],
  [".py", "python"],
  [".rs", "rust"],
  [".go", "go"],
  [".java", "java"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".hpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
  [".cs", "csharp"],
  [".php", "php"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".json", "json"], [".jsonc", "json"],
  [".yaml", "yaml"], [".yml", "yaml"],
  [".html", "html"], [".htm", "html"],
  [".css", "css"], [".scss", "css"], [".less", "css"],
  [".lua", "lua"],
  [".rb", "ruby"],
];

export function detectLanguageFromExtension(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  for (const [suffix, lang] of EXTENSION_SUFFIX_TABLE) {
    if (lower.endsWith(suffix)) return lang;
  }
  return null;
}

// ── Shared async budget helper (moved verbatim, now exported for lsp-manager/lsp-bridge) ──
export async function withBudget<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  return await new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (done) return; done = true; reject(new Error(`timed out after ${timeoutMs}ms`)); }, timeoutMs);
    const onAbort = () => { if (done) return; done = true; clearTimeout(timer); reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then((v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(v); }, (e) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(e); });
  });
}
