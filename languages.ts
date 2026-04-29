/**
 * Language detection for tree-sitter repo map.
 * Maps file extensions to tree-sitter language names.
 */

export type SupportedLanguage =
  | "bash"
  | "c"
  | "c_sharp"
  | "clojure"
  | "commonlisp"
  | "cpp"
  | "css"
  | "d"
  | "dart"
  | "elisp"
  | "elixir"
  | "elm"
  | "fortran"
  | "gleam"
  | "go"
  | "haskell"
  | "hcl"
  | "java"
  | "javascript"
  | "julia"
  | "kotlin"
  | "lua"
  | "matlab"
  | "ocaml"
  | "ocaml_interface"
  | "php"
  | "pony"
  | "properties"
  | "python"
  | "ql"
  | "r"
  | "racket"
  | "ruby"
  | "rust"
  | "scala"
  | "solidity"
  | "swift"
  | "tsx"
  | "typescript"
  | "udev"
  | "zig";

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  // Shell
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",

  // C
  ".c": "c",
  ".h": "c",

  // C#
  ".cs": "c_sharp",

  // Clojure
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",

  // Common Lisp
  ".lisp": "commonlisp",
  ".cl": "commonlisp",

  // C++
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",

  // CSS
  ".css": "css",
  ".scss": "css",
  ".less": "css",

  // D
  ".d": "d",

  // Dart
  ".dart": "dart",

  // Elisp
  ".el": "elisp",

  // Elixir
  ".ex": "elixir",
  ".exs": "elixir",

  // Elm
  ".elm": "elm",

  // Fortran
  ".f": "fortran",
  ".f90": "fortran",
  ".f95": "fortran",

  // Gleam
  ".gleam": "gleam",

  // Go
  ".go": "go",

  // Haskell
  ".hs": "haskell",
  ".lhs": "haskell",

  // HCL (Terraform)
  ".tf": "hcl",
  ".hcl": "hcl",

  // Java
  ".java": "java",

  // JavaScript
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",

  // Julia
  ".jl": "julia",

  // Kotlin
  ".kt": "kotlin",
  ".kts": "kotlin",

  // Lua
  ".lua": "lua",

  // MATLAB
  ".m": "matlab",

  // OCaml
  ".ml": "ocaml",
  ".mli": "ocaml_interface",

  // PHP
  ".php": "php",

  // Pony
  ".pony": "pony",

  // Properties
  ".properties": "properties",

  // Python
  ".py": "python",
  ".pyi": "python",
  ".pyx": "python",

  // QL (CodeQL)
  ".ql": "ql",

  // R
  ".r": "r",
  ".R": "r",

  // Racket
  ".rkt": "racket",

  // Ruby
  ".rb": "ruby",

  // Rust
  ".rs": "rust",

  // Scala
  ".scala": "scala",

  // Solidity
  ".sol": "solidity",

  // Swift
  ".swift": "swift",

  // TypeScript
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mts": "typescript",
  ".cts": "typescript",

  // Udev
  ".rules": "udev",

  // Zig
  ".zig": "zig",
};

/**
 * Map a tree-sitter language name to its WASM filename.
 * Some languages need alias resolution.
 */
export const LANGUAGE_WASM_ALIASES: Partial<Record<SupportedLanguage, string>> = {
  c_sharp: "c-sharp",
  commonlisp: "commonlisp",
  ocaml_interface: "ocaml",
};

/**
 * Query name aliases — some languages have differently-named .scm files.
 */
export const QUERY_NAME_ALIASES: Partial<Record<SupportedLanguage, string[]>> = {
  c_sharp: ["csharp", "c_sharp"],
  tsx: ["typescript", "tsx"],
};

/**
 * Returns the supported language for a file extension, or undefined.
 */
export function extToLang(ext: string): SupportedLanguage | undefined {
  return EXTENSION_MAP[ext.toLowerCase()];
}

/**
 * Returns the supported language for a filename, or undefined.
 */
export function filenameToLang(filename: string): SupportedLanguage | undefined {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return undefined;
  const ext = filename.slice(dotIndex);
  return extToLang(ext);
}

/**
 * Returns true if the file has a supported language for repo-map analysis.
 */
export function isSupportedFile(filepath: string): boolean {
  return filenameToLang(filepath) !== undefined;
}

/**
 * Returns the set of all supported file extensions.
 */
export function getSupportedExtensions(): string[] {
  return Object.keys(EXTENSION_MAP);
}
