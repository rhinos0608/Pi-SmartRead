/**
 * Declarative language server descriptor catalog.
 * No process spawning, no FS probing — pure data + lookups.
 */

export interface CommandCandidate {
  command: string;
  args: string[];
  platforms?: NodeJS.Platform[];
  requiredEnv?: string[];
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
}

export const LANGUAGE_SERVER_CATALOG: ServerDescriptor[] = [
  {
    id: "typescript",
    displayName: "TypeScript",
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
    commandCandidates: [
      { command: "typescript-language-server", args: ["--stdio"] },
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
    commandCandidates: [{ command: "bash-language-server", args: ["start"] }],
    priority: 100,
    expectedCapabilities: ["definition", "references", "hover"],
  },
  {
    id: "vscode-json-language-server",
    displayName: "JSON Language Server",
    languageIds: ["json"],
    extensions: [".json", ".jsonc"],
    rootMarkers: ["package.json", ".git"],
    commandCandidates: [{ command: "vscode-json-language-server", args: ["--stdio"] }],
    priority: 100,
    expectedCapabilities: ["hover", "documentSymbol"],
  },
  {
    id: "yaml-language-server",
    displayName: "YAML Language Server",
    languageIds: ["yaml"],
    extensions: [".yaml", ".yml"],
    rootMarkers: [".git"],
    commandCandidates: [{ command: "yaml-language-server", args: ["--stdio"] }],
    priority: 100,
    expectedCapabilities: ["hover", "documentSymbol"],
  },
  {
    id: "vscode-html-language-server",
    displayName: "HTML Language Server",
    languageIds: ["html"],
    extensions: [".html", ".htm"],
    rootMarkers: [".git"],
    commandCandidates: [{ command: "vscode-html-language-server", args: ["--stdio"] }],
    priority: 100,
    expectedCapabilities: ["hover", "documentSymbol"],
  },
  {
    id: "vscode-css-language-server",
    displayName: "CSS Language Server",
    languageIds: ["css"],
    extensions: [".css", ".scss", ".less"],
    rootMarkers: [".git"],
    commandCandidates: [{ command: "vscode-css-language-server", args: ["--stdio"] }],
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
  const filtered = LANGUAGE_SERVER_CATALOG.filter((d) => d.languageIds.includes(languageId));
  return sortedByPriority(filtered);
}

export function getDescriptorsForExtension(ext: string): ServerDescriptor[] {
  const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const filtered = LANGUAGE_SERVER_CATALOG.filter((d) =>
    d.extensions.some((e) => e.toLowerCase() === normalized),
  );
  return sortedByPriority(filtered);
}
