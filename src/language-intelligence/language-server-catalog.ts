/**
 * Declarative language server descriptor catalog.
 * No process spawning, no FS probing — pure data + lookups.
 */

export interface CommandCandidate {
  command: string;
  args: string[];
  platforms?: NodeJS.Platform[];
  requiredEnv?: string[];
  managedInstall?: { type: "npm"; packageName: string; version: string; bin: string };
}

export interface ServerDescriptor {
  id: string;
  displayName: string;
  languageIds: string[];
  extensions: string[]; // e.g. [".ts", ".tsx"]
  filenames?: string[]; // e.g. ["Gemfile"]
  rootMarkers: string[]; // e.g. ["package.json"]
  commandCandidates: CommandCandidate[];
  priority: number;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  expectedCapabilities?: string[];
  /** Role tag for multi same-language servers (e.g. "primary" | "fallback"). */
  roles?: string[];
}

/** Validated custom (runtime-registered) descriptors. Catalog is runtime source of truth. */
const customDescriptors: ServerDescriptor[] = [];

export function validateDescriptor(d: ServerDescriptor): string[] {
  const errs: string[] = [];
  if (!d.id) errs.push("id required");
  if (!d.languageIds?.length) errs.push("languageIds required");
  if (!d.commandCandidates?.length) errs.push("commandCandidates required");
  for (const c of d.commandCandidates ?? []) if (!c.command) errs.push(`candidate missing command in ${d.id}`);
  return errs;
}

/** Register validated custom descriptors (throws on invalid). */
export function registerCustomDescriptors(descs: ServerDescriptor[]): void {
  for (const d of descs) {
    const errs = validateDescriptor(d);
    if (errs.length) throw new Error(`invalid descriptor ${d.id}: ${errs.join("; ")}`);
  }
  for (const d of descs) {
    const i = customDescriptors.findIndex((x) => x.id === d.id);
    if (i >= 0) customDescriptors[i] = d; else customDescriptors.push(d);
  }
}

export function clearCustomDescriptors(): void { customDescriptors.length = 0; }

/** Runtime source of truth: built-in catalog + validated custom descriptors. */
export function getActiveCatalog(): ServerDescriptor[] { return [...LANGUAGE_SERVER_CATALOG, ...customDescriptors]; }

/**
 * Known TypeScript language-server (TLS) launch profile.
 *
 * TLS answers definition/references/hover/rename from a `--serverMode
 * partialSemantic` syntax server while the project loads. SmartRead manages
 * TLS sessions semantic-only instead (`tsserver.useSyntaxServer: "never"`):
 * cold starts may be slower or time out, but never return partial-semantic
 * answers. Scoped to this profile only — never to arbitrary descriptors or
 * unverified alternative executables.
 */
export const TYPESCRIPT_DESCRIPTOR_ID = "typescript";

/** Value forced for `tsserver.useSyntaxServer` on the known TLS launch profile. */
export const TLS_SEMANTIC_ONLY_USE_SYNTAX_SERVER = "never";

/** Explicitly conflicting TLS initialization: fail, never silently override. */
export class TlsSemanticOnlyConflictError extends Error {
  constructor(descriptorId: string, actual: unknown) {
    super(
      `TLS semantic-only session misconfigured for descriptor "${descriptorId}": ` +
      `initializationOptions.tsserver.useSyntaxServer is ${JSON.stringify(actual)} ` +
      `but SmartRead requires "never" (full semantic server; partial-semantic ` +
      `syntax answers are not served). Remove the override or set it to "never".`,
    );
    this.name = "TlsSemanticOnlyConflictError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when (command, args) match a command candidate of the known TLS launch profile. */
export function isKnownTlsLaunch(command: string, args: string[]): boolean {
  const tls = LANGUAGE_SERVER_CATALOG.find((d) => d.id === TYPESCRIPT_DESCRIPTOR_ID);
  if (!tls) return false;
  return tls.commandCandidates.some((c) => c.command === command && JSON.stringify(c.args) === JSON.stringify(args));
}

/**
 * Effective initializationOptions for the known TLS launch profile: merges
 * `tsserver.useSyntaxServer: "never"` over any unrelated configured fields
 * (unrelated nested `tsserver` settings survive). An explicitly conflicting
 * configured value throws TlsSemanticOnlyConflictError — never silently
 * overridden. Call only for the known TLS profile; other descriptors pass
 * their configured options through untouched.
 */
export function applyTlsSemanticOnlyPolicy(configured?: Record<string, unknown>): Record<string, unknown> {
  const base = isRecord(configured) ? configured : {};
  const tsserver = (base as Record<string, unknown>).tsserver;
  if (tsserver !== undefined) {
    if (!isRecord(tsserver)) {
      throw new TlsSemanticOnlyConflictError(TYPESCRIPT_DESCRIPTOR_ID, tsserver);
    }
    const mode = (tsserver as Record<string, unknown>).useSyntaxServer;
    if (mode !== undefined && mode !== TLS_SEMANTIC_ONLY_USE_SYNTAX_SERVER) {
      throw new TlsSemanticOnlyConflictError(TYPESCRIPT_DESCRIPTOR_ID, mode);
    }
  }
  const existing = isRecord(tsserver) ? (tsserver as Record<string, unknown>) : {};
  return {
    ...(base as Record<string, unknown>),
    tsserver: { ...existing, useSyntaxServer: TLS_SEMANTIC_ONLY_USE_SYNTAX_SERVER },
  };
}

export const LANGUAGE_SERVER_CATALOG: ServerDescriptor[] = [
  {
    id: "typescript",
    displayName: "TypeScript",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
    commandCandidates: [
      { command: "typescript-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "typescript-language-server", version: "6.0.0", bin: "typescript-language-server" } },
      { command: "typescriptlangserver", args: ["--stdio"] },
    ],
    priority: 100,
    expectedCapabilities: ["definition", "references", "rename", "hover", "documentSymbol"],
  },
  {
    id: "python",
    displayName: "Python",
    languageIds: ["python"],
    extensions: [".py", ".pyi", ".pyx"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
    commandCandidates: [
      { command: "pyright-langserver", args: ["--stdio"], managedInstall: { type: "npm", packageName: "pyright", version: "1.1.413", bin: "pyright-langserver" } },
      { command: "pyright", args: ["--stdio"] },
      { command: "pylsp", args: ["--stdio"] },
      { command: "pyls", args: ["--stdio"] },
      { command: "jedi-language-server", args: ["--stdio"] },
    ],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover", "rename"],
  },
  {
    id: "rust-analyzer",
    displayName: "Rust Analyzer",
    languageIds: ["rust"],
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
    commandCandidates: [{ command: "rust-analyzer", args: [] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "gopls",
    displayName: "gopls",
    languageIds: ["go"],
    extensions: [".go"],
    rootMarkers: ["go.mod"],
    commandCandidates: [{ command: "gopls", args: [] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "clangd",
    displayName: "clangd",
    languageIds: ["c", "cpp"],
    extensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh"],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", "Makefile", ".git"],
    commandCandidates: [{ command: "clangd", args: [] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "omnisharp",
    displayName: "OmniSharp",
    languageIds: ["csharp"],
    extensions: [".cs"],
    rootMarkers: ["omnisharp.json", ".sln"],
    commandCandidates: [{ command: "omnisharp", args: ["--languageserver"] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "csharp-ls",
    displayName: "csharp-ls",
    languageIds: ["csharp"],
    extensions: [".cs"],
    rootMarkers: [".sln"],
    commandCandidates: [{ command: "csharp-ls", args: [] }],
    priority: 50,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "jdtls",
    displayName: "Eclipse JDT LS",
    languageIds: ["java"],
    extensions: [".java"],
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".git"],
    commandCandidates: [{ command: "jdtls", args: [] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "intelephense",
    displayName: "Intelephense",
    languageIds: ["php"],
    extensions: [".php"],
    rootMarkers: ["composer.json"],
    commandCandidates: [{ command: "intelephense", args: ["--stdio"] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "phpactor",
    displayName: "Phpactor",
    languageIds: ["php"],
    extensions: [".php"],
    rootMarkers: ["composer.json"],
    commandCandidates: [{ command: "phpactor", args: ["language-server"] }],
    priority: 50,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "bash-language-server",
    displayName: "Bash Language Server",
    languageIds: ["bash", "shellscript"],
    extensions: [".sh", ".bash"],
    rootMarkers: [".git"],
    commandCandidates: [{ command: "bash-language-server", args: ["start"], managedInstall: { type: "npm", packageName: "bash-language-server", version: "5.6.0", bin: "bash-language-server" } }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "vscode-json-language-server",
    displayName: "JSON Language Server",
    languageIds: ["json"],
    extensions: [".json", ".jsonc"],
    rootMarkers: ["package.json", ".git"],
    commandCandidates: [{ command: "vscode-json-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "vscode-langservers-extracted", version: "4.10.0", bin: "vscode-json-language-server" } }],
    priority: 100,
    expectedCapabilities: ["hover", "documentSymbol"],
  },
  {
    id: "yaml-language-server",
    displayName: "YAML Language Server",
    languageIds: ["yaml"],
    extensions: [".yaml", ".yml"],
    rootMarkers: [".git"],
    commandCandidates: [{ command: "yaml-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "yaml-language-server", version: "1.24.0", bin: "yaml-language-server" } }],
    priority: 100,
    expectedCapabilities: ["hover", "documentSymbol"],
  },
  {
    id: "vscode-html-language-server",
    displayName: "HTML Language Server",
    languageIds: ["html"],
    extensions: [".html", ".htm"],
    rootMarkers: [".git"],
    commandCandidates: [{ command: "vscode-html-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "vscode-langservers-extracted", version: "4.10.0", bin: "vscode-html-language-server" } }],
    priority: 100,
    expectedCapabilities: ["hover", "documentSymbol"],
  },
  {
    id: "vscode-css-language-server",
    displayName: "CSS Language Server",
    languageIds: ["css"],
    extensions: [".css", ".scss", ".less"],
    rootMarkers: [".git"],
    commandCandidates: [{ command: "vscode-css-language-server", args: ["--stdio"], managedInstall: { type: "npm", packageName: "vscode-langservers-extracted", version: "4.10.0", bin: "vscode-css-language-server" } }],
    priority: 100,
    expectedCapabilities: ["hover", "documentSymbol"],
  },
  {
    id: "lua-language-server",
    displayName: "Lua Language Server",
    languageIds: ["lua"],
    extensions: [".lua"],
    rootMarkers: [".git"],
    commandCandidates: [{ command: "lua-language-server", args: [] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "solargraph",
    displayName: "Solargraph",
    languageIds: ["ruby"],
    extensions: [".rb"],
    filenames: ["Gemfile", "Rakefile"],
    rootMarkers: ["Gemfile", ".git"],
    commandCandidates: [{ command: "solargraph", args: ["stdio"] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
];

function sortedByPriority(descriptors: ServerDescriptor[]): ServerDescriptor[] {
  return [...descriptors].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
}

export function getDescriptorsForLanguage(languageId: string): ServerDescriptor[] {
  const filtered = getActiveCatalog().filter((d) => d.languageIds.includes(languageId));
  return sortedByPriority(filtered);
}

export function getDescriptorsForExtension(ext: string): ServerDescriptor[] {
  const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const filtered = getActiveCatalog().filter((d) =>
    d.extensions.some((e) => e.toLowerCase() === normalized),
  );
  return sortedByPriority(filtered);
}
