/**
 * Unified find_symbol tool — symbol-level code exploration.
 *
 * Actions:
 *   symbol       — Find symbols by name/pattern. Uses tree-sitter definition tags.
 *                  Supports qualified paths ("ClassName.methodName").
 *   overview     — File outline via AST analysis. Returns all top-level symbols
 *                  with types, line ranges, and child symbol counts.
 *   references   — All reference locations for a symbol across the codebase.
 *   declaration  — Find the definition/declaration of a symbol given its
 *                  name and optional context file.
 *   implementations — Find types that implement an interface or extend a class
 *                  (heuristic: uses tag matching + graph).
 *   workspace    — Workspace-wide symbol search via LSP.
 *   hover        — Type/signature/quick-info at a file position via LSP.
 */
import { existsSync, promises as fs } from "node:fs";
import { relative, resolve } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import Parser from "tree-sitter";
import { initParser, loadLanguage, getQueryPath } from "./tags.js";
import { filenameToLang } from "./languages.js";
import { findSrcFiles } from "./file-discovery.js";
import { resolveSymbol } from "./symbol-resolver.js";
import { loadGrammar } from "./grammar-loader.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { ToolCategory, ToolRegistry } from "./tool-registry.js";
import { getLSPBridge, type LSPBridge, type LSPDocumentSymbol, type LSPWorkspaceSymbol } from "./lsp-bridge.js";

// ── Schema ─────────────────────────────────────────────────────────

const FindSymbolSchema = Type.Object({
  action: Type.Optional(
    Type.Unsafe<"symbol" | "overview" | "references" | "declaration" | "implementations" | "workspace" | "hover">({
      type: "string",
      enum: ["symbol", "overview", "references", "declaration", "implementations", "workspace", "hover"],
      description:
        "Action to perform. 'symbol' (default): find symbols by name/pattern. 'overview': get file outline. " +
        "'references': find all references to a symbol. 'declaration': find where a symbol is defined. " +
        "'implementations': find types that implement or extend a given type. " +
        "'workspace': workspace-wide symbol search via LSP. 'hover': type/signature info at a position via LSP.",
      default: "symbol",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Symbol name or pattern to search for. Supports qualified paths like 'ClassName.methodName'. " +
        "Required for actions: symbol, references, declaration, implementations, workspace.",
      minLength: 1,
    }),
  ),
  relative_path: Type.Optional(
    Type.String({
      description:
        "File path relative to project root. For 'overview': the file to outline. " +
        "For 'hover': the file to query. For other actions: the file containing the symbol (helps disambiguate).",
    }),
  ),
  include_body: Type.Optional(
    Type.Boolean({ description: "Include symbol source body in results (default: false)." }),
  ),
  depth: Type.Optional(
    Type.Number({
      description: "For 'overview': how many levels of children to include (0 = top-level only, default: 0).",
      minimum: 0, maximum: 5,
    }),
  ),
  max_results: Type.Optional(
    Type.Number({ description: "Maximum results to return (1-100, default: 30).", minimum: 1, maximum: 100 }),
  ),
  line: Type.Optional(
    Type.Number({
      description: "Line number (0-based) for 'hover' action.",
      minimum: 0,
    }),
  ),
  character: Type.Optional(
    Type.Number({
      description: "Character offset (0-based) for 'hover' action.",
      minimum: 0,
    }),
  ),
  directory: Type.Optional(
    Type.String({ description: "Root directory (default: extension working directory)." }),
  ),
});

type FindSymbolInput = Static<typeof FindSymbolSchema>;

// ── Helpers ────────────────────────────────────────────────────────

function resolveRoot(params: FindSymbolInput, defaultCwd: string): string {
  return params.directory ? resolve(defaultCwd, params.directory) : defaultCwd;
}

interface SymbolEntry {
  name: string;
  kind: string;
  relative_path: string;
  line: number;
  end_line?: number;
  name_path?: string;
  child_count?: number;
  body?: string;
}

// ── AST symbol extraction (reuses patterns from search-tool.ts) ─────

function extractSymbolName(node: { childForFieldName: (n: string) => { text: string } | null; namedChildren: ReadonlyArray<{ type: string; text: string; isNamed: boolean }> }): string | null {
  const nameField = node.childForFieldName?.("name");
  if (nameField) return nameField.text;
  for (const child of node.namedChildren) {
    if (child.isNamed && child.type === "identifier") return child.text;
  }
  return null;
}

function countNamedChildren(node: Parser.SyntaxNode): number {
  const kinds = new Set([
    "function_declaration", "function_definition", "method_definition",
    "class_declaration", "class_definition", "interface_declaration",
    "enum_declaration", "struct_item", "trait_item", "impl_item",
    "function_item", "arrow_function", "field_definition",
    "property_definition", "method_declaration", "variable_declarator",
  ]);
  let count = 0;
  for (const child of node.namedChildren) {
    if (kinds.has(child.type)) count++;
    count += countNamedChildren(child);
  }
  return count;
}

const SYMBOL_KIND_MAP: Record<string, string> = {
  function_declaration: "function",
  function_definition: "function",
  function_item: "function",
  method_definition: "method",
  method_declaration: "method",
  arrow_function: "function",
  class_declaration: "class",
  class_definition: "class",
  class_specifier: "class",
  struct_item: "class",
  impl_item: "class",
  interface_declaration: "interface",
  trait_item: "interface",
  enum_declaration: "enum",
  enum_item: "enum",
  enum_specifier: "enum",
  variable_declarator: "variable",
  lexical_declaration: "variable",
  const_declaration: "variable",
};

interface SimpleSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  childCount: number;
  namePath: string;
}

function extractSimpleSymbols(nodes: Parser.SyntaxNode[]): SimpleSymbol[] {
  const result: SimpleSymbol[] = [];

  function visit(node: Parser.SyntaxNode, parentNamePath: string, depth: number): void {
    const kind = SYMBOL_KIND_MAP[node.type];
    if (!kind) {
      if (depth < 3) {
        for (const child of node.namedChildren) {
          visit(child, parentNamePath, depth + 1);
        }
      }
      return;
    }

    const name = extractSymbolName(node as any);
    if (!name) return;

    const namePath = parentNamePath ? `${parentNamePath}.${name}` : name;
    result.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      childCount: countNamedChildren(node),
      namePath,
    });

    for (const child of node.namedChildren) {
      visit(child, namePath, depth + 1);
    }
  }

  for (const node of nodes) {
    visit(node, "", 0);
  }

  return result;
}

function buildNamePath(defNode: Parser.SyntaxNode, name: string): string {
  const parts: string[] = [name];
  let parent = defNode.parent;
  let safety = 0;
  while (parent && safety < 10) {
    safety++;
    if (["class_declaration", "class_definition", "interface_declaration",
         "struct_item", "trait_item", "impl_item"].includes(parent.type)) {
      const parentName = extractSymbolName(parent as any);
      if (parentName) parts.unshift(parentName);
    }
    parent = parent.parent;
  }
  return parts.join(".");
}

// ── Action: symbol ─────────────────────────────────────────────────

async function handleSymbol(
  query: string,
  maxResults: number,
  includeBody: boolean,
  root: string,
  cwd: string,
  signal?: AbortSignal,
) {
  const allFiles = await findSrcFiles(root, 50_000, signal);
  const matches: SymbolEntry[] = [];
  let totalDefs = 0;

  await initParser();

  const queryLower = query.toLowerCase();
  const queryParts = queryLower.split(".");

  for (const filePath of allFiles) {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (matches.length >= maxResults) break;

    const relFile = relative(cwd, filePath);
    const lang = filenameToLang(filePath);
    if (!lang) continue;

    const grammar = loadLanguage(lang);
    if (!grammar) continue;

    let code: string;
    try { code = await fs.readFile(filePath, "utf-8"); } catch { continue; }

    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse((offset) => code.slice(offset, offset + 1024));
    if (!tree?.rootNode) continue;

    const queryPath = getQueryPath(lang);
    if (!queryPath || !existsSync(queryPath)) continue;

    let tsQuery: Parser.Query;
    try {
      const querySource = await fs.readFile(queryPath, "utf-8");
      tsQuery = new Parser.Query(grammar, querySource);
    } catch { continue; }

    const tsMatches = tsQuery.matches(tree.rootNode);
    for (const match of tsMatches) {
      let name: string | undefined;
      let defNode: Parser.SyntaxNode | undefined;
      let defKind = "definition";

      for (const capture of match.captures) {
        if (capture.name.startsWith("name.definition")) {
          name = capture.node.text;
        } else if (capture.name.startsWith("definition")) {
          defNode = capture.node;
          defKind = capture.name.replace(/^definition\.?/, "") || "definition";
        }
      }

      if (!name || !defNode) continue;
      totalDefs++;

      const namePath = buildNamePath(defNode, name);
      const namePathLower = namePath.toLowerCase();
      const nameLower = name.toLowerCase();

      // Match: qualified parts, or simple substring on name or path
      const isMatch = namePathLower.includes(queryLower) ||
        nameLower.includes(queryLower) ||
        queryParts.every((part) => namePathLower.includes(part));

      if (!isMatch) continue;

      matches.push({
        name, kind: defKind, relative_path: relFile,
        line: defNode.startPosition.row + 1,
        end_line: defNode.endPosition.row + 1,
        name_path: namePath,
        body: includeBody ? defNode.text : undefined,
      });

      if (matches.length >= maxResults) break;
    }
  }

  return { matches, totalDefs, filesScanned: allFiles.length };
}

// ── LSP helpers ────────────────────────────────────────────────────

let _lspBridge: LSPBridge | null | undefined;
async function lsp(): Promise<LSPBridge | null> {
  if (_lspBridge === undefined) _lspBridge = await getLSPBridge();
  return _lspBridge;
}

function flattenDocumentSymbols(symbols: LSPDocumentSymbol[], parentNamePath = ""): SimpleSymbol[] {
  const result: SimpleSymbol[] = [];
  for (const sym of symbols) {
    const namePath = parentNamePath ? `${parentNamePath}.${sym.name}` : sym.name;
    const kind = symbolKindToString(sym.kind);
    result.push({
      name: sym.name,
      kind,
      startLine: sym.range.start.line + 1,
      endLine: sym.range.end.line + 1,
      childCount: sym.children?.length ?? 0,
      namePath,
    });
    if (sym.children) {
      result.push(...flattenDocumentSymbols(sym.children, namePath));
    }
  }
  return result;
}

function symbolKindToString(kind: number): string {
  // LSP SymbolKind enum: 1=File,2=Module,3=Namespace,4=Package,5=Class,
  // 6=Method,7=Property,8=Field,9=Constructor,10=Enum,11=Interface,
  // 12=Function,13=Variable,14=Constant,15=String,16=Number,17=Boolean,18=Array,
  // 19=Object,20=Key,21=Null,22=EnumMember,23=Struct,24=Event,25=Operator,26=TypeParameter
  switch (kind) {
    case 5: return "class";
    case 6: return "method";
    case 7: case 8: return "property";
    case 9: return "method";
    case 10: return "enum";
    case 11: return "interface";
    case 12: return "function";
    case 13: case 14: return "variable";
    case 23: return "class";
    default: return "symbol";
  }
}

// ── Action: workspace ───────────────────────────────────────────────

interface WorkspaceSymbolEntry {
  name: string;
  kind: string;
  file: string;
  line: number;
  containerName?: string;
}

async function handleWorkspace(
  query: string,
  maxResults: number,
  root: string,
): Promise<{ symbol: string; results: WorkspaceSymbolEntry[]; total: number }> {
  const bridge = await lsp();
  if (!bridge) return { symbol: query, results: [], total: 0 };

  const symbols: LSPWorkspaceSymbol[] = await bridge.workspaceSymbol(query, root);
  const results: WorkspaceSymbolEntry[] = symbols.slice(0, maxResults).map((s) => {
    const filePath = s.location.uri.replace(/^file:\/\//, "");
    const relFile = relative(root, filePath);
    return {
      name: s.name,
      kind: symbolKindToString(s.kind),
      file: relFile,
      line: s.location.range.start.line + 1,
      containerName: s.containerName,
    };
  });

  return { symbol: query, results, total: symbols.length };
}

// ── Action: hover ────────────────────────────────────────────────────

interface HoverResult {
  contents: string | null;
  kind: "markdown" | "plaintext" | null;
  range?: { startLine: number; startChar: number; endLine: number; endChar: number };
}

async function handleHover(
  relativePath: string,
  line: number,
  character: number,
  root: string,
): Promise<{ symbol: string; result: HoverResult | null }> {
  const fullPath = resolve(root, relativePath);
  const bridge = await lsp();
  if (!bridge) return { symbol: relativePath, result: null };

  const hover = await bridge.hover(fullPath, line, character, root);
  if (!hover) return { symbol: relativePath, result: null };

  // Extract string contents from the LSPHoverResult
  let contents: string;
  let kind: "markdown" | "plaintext" | null = null;

  if (typeof hover.contents === "string") {
    contents = hover.contents;
  } else if (Array.isArray(hover.contents)) {
    contents = hover.contents
      .map((c) => (typeof c === "string" ? c : c.value))
      .join("\n");
  } else {
    // LSPMarkupContent
    contents = hover.contents.value;
    kind = hover.contents.kind;
  }

  const result: HoverResult = { contents, kind };
  if (hover.range) {
    result.range = {
      startLine: hover.range.start.line + 1,
      startChar: hover.range.start.character,
      endLine: hover.range.end.line + 1,
      endChar: hover.range.end.character,
    };
  }

  return { symbol: relativePath, result };
}

// ── Action: overview ───────────────────────────────────────────────

interface OverviewResult {
  symbols: SymbolEntry[];
  relative_path: string;
  total: number;
}

async function handleOverview(
  relativePath: string,
  depth: number,
  root: string,
): Promise<OverviewResult> {
  const fullPath = resolve(root, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${relativePath}`);
  }

  const lang = filenameToLang(fullPath);
  if (!lang) {
    throw new Error(`Cannot determine language for: ${relativePath}`);
  }

  let symbols: SimpleSymbol[] = [];

  // Try LSP getDocumentSymbols (most accurate, supports all LSP languages)
  try {
    const bridge = await lsp();
    if (bridge) {
      const docSymbols = await bridge.getDocumentSymbols(fullPath, root);
      if (docSymbols.length > 0) {
        symbols = flattenDocumentSymbols(docSymbols);
      }
    }
  } catch { /* LSP unavailable — fall through */ }

  // Try web-tree-sitter WASM (no LSP server needed, multi-language)
  // Only run if LSP didn't produce results
  if (symbols.length === 0) {
    try {
      const grammarInfo = await loadGrammar(fullPath);
      if (grammarInfo) {
        const ParserModule = (grammarInfo as any).module as any;
        if (ParserModule) {
          const code = await fs.readFile(fullPath, "utf-8");
          const parser = new ParserModule();
          const tree = parser.parse(code);
          if (tree?.rootNode) {
            symbols = extractSimpleSymbols([tree.rootNode]);
          }
        }
      }
    } catch { /* WASM unavailable — fall through */ }
  }

  // Fallback: native tree-sitter (JS/TS/Python/Go/Rust)
  if (symbols.length === 0) {
    try {
      const nativeGrammar = loadLanguage(lang);
      if (nativeGrammar) {
        const code = await fs.readFile(fullPath, "utf-8");
        const parser = new Parser();
        parser.setLanguage(nativeGrammar);
        const tree = parser.parse((offset) => code.slice(offset, offset + 1024));
        if (tree?.rootNode) {
          symbols = extractSimpleSymbols([tree.rootNode]);
        }
      }
    } catch { /* give up */ }
  }

  if (symbols.length === 0) {
    return { symbols: [], relative_path: relativePath, total: 0 };
  }

  // Filter by depth
  const filtered = depth === 0
    ? symbols.filter((s) => !s.namePath.includes("."))
    : symbols;

  return {
    symbols: filtered.slice(0, 200).map((s) => ({
      name: s.name,
      kind: s.kind,
      line: s.startLine,
      end_line: s.endLine,
      name_path: s.namePath,
      child_count: s.childCount,
      relative_path: relativePath,
    })),
    relative_path: relativePath,
    total: filtered.length,
  };
}

// ── Action: references ─────────────────────────────────────────────

async function handleReferences(
  query: string,
  relativePath: string | undefined,
  maxResults: number,
  root: string,
  cwd: string,
) {
  const result = await resolveSymbol(
    root,
    query,
    relativePath ? relative(cwd, resolve(root, relativePath)) : undefined,
    undefined,
    maxResults,
  );

  return {
    symbol: result.symbol,
    definitions: result.definitions,
    references: result.references,
    best_definition: result.bestDefinition
      ? { file: result.bestDefinition.file, line: result.bestDefinition.line, kind: result.bestDefinition.kind }
      : null,
    strategy: result.strategy,
    stats: result.stats,
  };
}

// ── Action: declaration ────────────────────────────────────────────

async function handleDeclaration(
  query: string,
  relativePath: string | undefined,
  includeBody: boolean,
  root: string,
  cwd: string,
) {
  // Try LSP goToDefinition first (more precise, handles re-exports, type aliases)
  if (relativePath) {
    const bridge = await lsp();
    if (bridge) {
      // For LSP, we need a file:line location. Use the relative path directly
      // and search for the query in the file to find its position.
      const fullPath = resolve(root, relativePath);
      if (existsSync(fullPath)) {
        try {
          const code = await fs.readFile(fullPath, "utf-8");
          const lines = code.split("\n");
          for (let i = 0; i < Math.min(lines.length, 200); i++) {
            const lineText = lines[i]!;
            const charIdx = lineText.toLowerCase().indexOf(query.toLowerCase());
            if (charIdx >= 0) {
              const loc = await bridge.goToDefinition(fullPath, i, charIdx, root);
              if (loc) {
                const filePath = decodeURIComponent(loc.uri.replace(/^file:\/\//, ""));
                const relFile = relative(root, filePath);
                let body: string | undefined;
                if (includeBody) {
                  try {
                    const defCode = await fs.readFile(filePath, "utf-8");
                    const defLines = defCode.split("\n");
                    const start = Math.max(0, loc.range.start.line - 5);
                    const end = Math.min(defLines.length, loc.range.end.line + 5);
                    body = defLines.slice(start, end).join("\n");
                  } catch { /* ignore */ }
                }
                return {
                  symbol: query,
                  declaration: {
                    file: relFile,
                    line: loc.range.start.line + 1,
                    kind: "symbol",
                    body,
                  },
                  source: "lsp",
                };
              }
              break;
            }
          }
        } catch { /* LSP lookup failed — fall back */ }
      }
    }
  }

  // Fallback: tree-sitter symbol resolution
  const result = await resolveSymbol(
    root,
    query,
    relativePath ? relative(cwd, resolve(root, relativePath)) : undefined,
    undefined,
    10,
  );

  if (result.definitions.length === 0) {
    return { symbol: query, declaration: null as null, message: "no definition found" };
  }

  const def = result.definitions[0]!;
  let body: string | undefined;
  if (includeBody) {
    try {
      const fullPath = resolve(root, def.file);
      const code = await fs.readFile(fullPath, "utf-8");
      const lines = code.split("\n");
      const start = Math.max(0, def.line - 5);
      const end = Math.min(lines.length, def.line + 15);
      body = lines.slice(start, end).join("\n");
    } catch { /* ignore */ }
  }

  return {
    symbol: query,
    declaration: { file: def.file, line: def.line, kind: def.kind, context: def.context, body },
  };
}

// ── Action: implementations ────────────────────────────────────────

async function handleImplementations(
  query: string,
  relativePath: string | undefined,
  includeBody: boolean,
  maxResults: number,
  root: string,
  cwd: string,
  signal?: AbortSignal,
) {
  const implementors: Array<{ file: string; line: number; name: string; kind: string; body?: string }> = [];

  // Try LSP goToImplementation first (most precise, supports all LSP languages)
  if (relativePath) {
    const bridge = await lsp();
    if (bridge) {
      const fullPath = resolve(root, relativePath);
      if (existsSync(fullPath)) {
        try {
          const code = await fs.readFile(fullPath, "utf-8");
          const lines = code.split("\n");
          for (let i = 0; i < Math.min(lines.length, 200); i++) {
            const charIdx = lines[i]!.toLowerCase().indexOf(query.toLowerCase());
            if (charIdx >= 0) {
              const locations = await bridge.goToImplementation(fullPath, i, charIdx, root);
              for (const loc of locations ?? []) {
                if (implementors.length >= maxResults) break;
                const filePath = decodeURIComponent(loc.uri.replace(/^file:\/\//, ""));
                const relFile = relative(root, filePath);
                const fileName = relFile.split("/").pop() ?? relFile;
                if (!implementors.some((x) => x.file === relFile)) {
                  implementors.push({
                    file: relFile,
                    line: loc.range.start.line + 1,
                    name: fileName.replace(/\.[^.]+$/, ""),
                    kind: "implementation",
                  });
                }
              }
              if (implementors.length > 0) break;
            }
          }
        } catch { /* LSP unavailable — try other passes */ }
      }
    }
  }

  // Fallback: resolve the interface/type via tree-sitter
  if (implementors.length === 0) {
    const result = await resolveSymbol(
      root, query,
      relativePath ? relative(cwd, resolve(root, relativePath)) : undefined,
      undefined, 5,
    );
    const defFiles = new Set(result.definitions.map((d) => d.file));
    // Also try LSP on the resolved definition file
    if (defFiles.size > 0 && implementors.length === 0) {
      const bridge = await lsp();
      if (bridge) {
        for (const defFile of defFiles) {
          const fullPath = resolve(root, defFile);
          if (existsSync(fullPath)) {
            try {
              const defCode = await fs.readFile(fullPath, "utf-8");
              const defLines = defCode.split("\n");
              for (let i = 0; i < Math.min(defLines.length, 100); i++) {
                const charIdx = defLines[i]!.toLowerCase().indexOf(query.toLowerCase());
                if (charIdx >= 0) {
                  const locations = await bridge.goToImplementation(fullPath, i, charIdx, root);
                  for (const loc of locations ?? []) {
                    if (implementors.length >= maxResults) break;
                    const filePath = decodeURIComponent(loc.uri.replace(/^file:\/\//, ""));
                    const relFile = relative(root, filePath);
                    if (!implementors.some((x) => x.file === relFile)) {
                      const fileName = relFile.split("/").pop() ?? relFile;
                      implementors.push({
                        file: relFile,
                        line: loc.range.start.line + 1,
                        name: fileName.replace(/\.[^.]+$/, ""),
                        kind: "implementation",
                      });
                    }
                  }
                  break;
                }
              }
            } catch { /* continue to tree-sitter fallback */ }
          }
        }
      }
    }

    // Tree-sitter heuristic fallback
    if (implementors.length === 0) {
      const allFiles = await findSrcFiles(root, 30_000, signal);
      for (const filePath of allFiles) {
    if (signal?.aborted) break;
    if (implementors.length >= maxResults) break;

    const relFile = relative(cwd, filePath);
    const lang = filenameToLang(filePath);
    if (!lang) continue;

    const grammar = loadLanguage(lang);
    if (!grammar) continue;

    let code: string;
    try { code = await fs.readFile(filePath, "utf-8"); } catch { continue; }

    const parser = new Parser();
    parser.setLanguage(grammar);
    const tree = parser.parse((offset) => code.slice(offset, offset + 1024));
    if (!tree?.rootNode) continue;

    // Search for class/struct definitions
    const classQueryStr = `[(class_declaration (name) @name) (class_definition (name) @name) (struct_item (name) @name) (trait_item (name) @name) (impl_item (trait (identifier) @impl_trait)) (impl_item (type (identifier) @impl_type))]`;
    let classQuery: Parser.Query;
    try { classQuery = new Parser.Query(grammar, classQueryStr); } catch { continue; }

    const classMatches = classQuery.matches(tree.rootNode);
    for (const match of classMatches) {
      let name: string | undefined;
      let isImpl = false;

      for (const capture of match.captures) {
        if (capture.name === "name") {
          name = capture.node.text;
        }
        if (capture.name === "impl_trait" || capture.name === "impl_type") {
          if (capture.node.text.toLowerCase() === query.toLowerCase()) {
            isImpl = true;
          }
        }
      }
      if (!name) continue;

      // Check extends/implements keywords
      const extendsRe = new RegExp(`\\bextends\\s+${query}\\b`, "i");
      const implementsRe = new RegExp(`\\bimplements\\s+[^;{]*\\b${query}\\b`, "i");
      if (!isImpl && !extendsRe.test(code) && !implementsRe.test(code)) continue;

      let line = 1;
      for (const cap of match.captures) {
        if (cap.name === "name") { line = cap.node.startPosition.row + 1; break; }
      }
      implementors.push({
        file: relFile, line, name, kind: "class",
        body: includeBody ? match.captures[0]?.node.text : undefined,
      });
    }
  }  // end for (filePath)
    }  // end tree-sitter fallback
  }  // end outer fallback

  // Check graphify for implementation relationships
  try {
    const enricher = getGraphifyEnricher(cwd);
    if (enricher.isAvailable) {
      const result = await resolveSymbol(root, query, undefined, undefined, 5);
      for (const def of result.definitions) {
        const fullPath = resolve(root, def.file);
        const related = enricher.getRelatedFilesForPath(fullPath);
        for (const r of related) {
          if (implementors.length >= maxResults) break;
          if (/implement|extend|subclass/i.test(r.relation)) {
            if (!implementors.some((i) => i.file === r.targetLabel)) {
              implementors.push({
                file: r.targetLabel, line: 0,
                name: r.targetLabel.split("/").pop() ?? r.targetLabel,
                kind: r.relation,
              });
            }
          }
        }
      }
    }
  } catch { /* best-effort */ }

  // Deduplicate
  const seen = new Set<string>();
  const unique = implementors.filter((i) => {
    const key = `${i.file}:${i.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { symbol: query, implementors: unique.slice(0, maxResults), total_found: unique.length };
}

// ── Output formatting ──────────────────────────────────────────────


function formatSymbolResult(data: { matches: SymbolEntry[]; totalDefs: number; filesScanned: number }, query: string, startTime: number): string {
  const { matches } = data;
  const elapsed = Date.now() - startTime;
  const lines: string[] = [
    `Found ${matches.length} symbol(s) matching "${query}" (${data.totalDefs} defs scanned across ${data.filesScanned} files, ${elapsed}ms):`,
    "",
  ];
  for (const m of matches) {
    const nps = m.name_path && m.name_path !== m.name ? `  [${m.name_path}]` : "";
    const bh = m.end_line ? ` (L${m.line}-${m.end_line})` : `:${m.line}`;
    lines.push(`  ${m.relative_path}${bh}  [${m.kind}]  ${m.name}${nps}`);
    lines.push("");
  }
  if (matches.length === 0) {
    lines.push(`> No symbols found. Try \`search mode=code query="${query}"\` for full-text search.`, "");
  }
  return lines.join("\n");
}

function formatOverviewResult(data: OverviewResult, startTime: number): string {
  const { symbols, relative_path } = data;
  const lines: string[] = [
    `Symbol overview for ${relative_path} (${data.total} symbols, ${Date.now() - startTime}ms):`,
    "",
  ];
  const byKind = new Map<string, SymbolEntry[]>();
  for (const s of symbols) {
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }
  for (const [kind, entries] of byKind) {
    lines.push(`  ── ${kind}s ──`);
    for (const e of entries) {
      const ci = e.child_count ? `  (${e.child_count} children)` : "";
      const np = e.name_path && e.name_path !== e.name ? ` → ${e.name_path}` : "";
      lines.push(`    ${e.name}  L${e.line}${np}${ci}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatReferencesResult(data: any, _query: string, startTime: number): string {
  const lines: string[] = [`References for "${data.symbol}" (${Date.now() - startTime}ms):`, ""];
  if (data.best_definition) {
    const bd = data.best_definition;
    lines.push(`  Definition → ${bd.file}:${bd.line}  [${bd.kind}]`);
    lines.push("");
  }
  if (data.definitions?.length > 0) {
    lines.push(`  ${data.definitions.length} definition(s):`);
    for (const d of data.definitions.slice(0, 5)) {
      const ctx = d.context ? `\n${d.context.split("\n").map((l: string) => `    ${l}`).join("\n")}` : "";
      lines.push(`    ${d.file}:${d.line}  [def]${ctx}`);
    }
    if (data.definitions.length > 5) lines.push(`    ... and ${data.definitions.length - 5} more`);
    lines.push("");
  }
  if (data.references?.length > 0) {
    lines.push(`  ${data.references.length} reference(s):`);
    for (const r of data.references.slice(0, 20)) {
      const ctx = r.context ? `\n${r.context.split("\n").map((l: string) => `    ${l}`).join("\n")}` : "";
      lines.push(`    ${r.file}:${r.line}  [ref]${ctx}`);
    }
    if (data.references.length > 20) lines.push(`    ... and ${data.references.length - 20} more`);
    lines.push("");
  }
  if (!data.best_definition && (!data.references || data.references.length === 0)) {
    lines.push(`  [No references or definitions found]`, "");
  }
  return lines.join("\n");
}

function formatDeclarationResult(data: any, _query: string, startTime: number): string {
  const lines: string[] = [`Declaration for "${data.symbol}" (${Date.now() - startTime}ms):`, ""];
  if (data.declaration) {
    const d = data.declaration;
    lines.push(`  ${d.file}:${d.line}  [${d.kind}]`);
    if (d.context) lines.push(`  ${d.context}`);
    if (d.body) {
      lines.push("  Body:");
      for (const l of d.body.split("\n")) lines.push(`    ${l}`);
    }
  } else {
    lines.push(`  [No declaration found]`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatImplementationsResult(data: any, _query: string, startTime: number): string {
  const lines: string[] = [
    `Implementations/extensions of "${data.symbol}" (${data.total_found} found, ${Date.now() - startTime}ms):`,
    "",
  ];
  if (data.implementors.length === 0) {
    lines.push(`  [No implementors found]`, "");
    return lines.join("\n");
  }
  for (const impl of data.implementors) {
    lines.push(`  ${impl.file}:${impl.line}  [${impl.kind}]  ${impl.name}`);
    if (impl.body) {
      const bl = impl.body.split("\n");
      for (const l of bl.slice(0, 5)) lines.push(`    ${l}`);
      if (bl.length > 5) lines.push(`    ... (${bl.length - 5} more lines)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── Format: workspace ───────────────────────────────────────────────

function formatWorkspaceResult(data: { symbol: string; results: WorkspaceSymbolEntry[]; total: number }, _query: string, startTime: number): string {
  const lines: string[] = [
    `Workspace symbols for "${data.symbol}" (${data.total} found, ${Date.now() - startTime}ms):`,
    "",
  ];
  if (data.results.length === 0) {
    lines.push(`  [No workspace symbols found]`, "");
    return lines.join("\n");
  }
  for (const r of data.results) {
    const container = r.containerName ? ` (in ${r.containerName})` : "";
    lines.push(`  ${r.file}:${r.line}  [${r.kind}]  ${r.name}${container}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatHoverResult(data: { symbol: string; result: HoverResult | null }, _query: string, startTime: number): string {
  const elapsed = Date.now() - startTime;
  if (!data.result) {
    return `Hover for "${data.symbol}" (${elapsed}ms):\n\n  [No hover info available]\n`;
  }
  const rangeStr = data.result.range
    ? ` at L${data.result.range.startLine}:${data.result.range.startChar}-L${data.result.range.endLine}:${data.result.range.endChar}`
    : "";
  const kindStr = data.result.kind ? `  [${data.result.kind}]` : "";
  return [
    `Hover for "${data.symbol}"${rangeStr} (${elapsed}ms):${kindStr}`,
    "",
    data.result.contents,
    "",
  ].join("\n");
}

// ── Tool definition ────────────────────────────────────────────────

export function createFindSymbolTool(): ToolDefinition {
  return {
    name: "find_symbol",
    label: "find_symbol",
    description:
      "Explore codebase symbols with action-based dispatch. 'symbol' (default): find symbols by name/pattern using tree-sitter AST analysis. " +
      "'overview': get file outline with all symbol types and line ranges. " +
      "'references': find all cross-file references to a symbol. " +
      "'declaration': find where a symbol is defined. " +
      "'implementations': find types that implement, extend, or subclass a given type. " +
      "'workspace': workspace-wide symbol search via LSP. " +
      "'hover': type/signature/quick-info at a file position via LSP. " +
      "Supports qualified name paths like 'ClassName.methodName' for precise matching.",
    parameters: FindSymbolSchema,

    async execute(
      _toolCallId: string,
      params: FindSymbolInput,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const action = params.action ?? "symbol";
      const root = resolveRoot(params, ctx.cwd);
      const cwd = ctx.cwd;
      const startTime = Date.now();
      const maxResults = params.max_results ?? 30;

      switch (action) {
        case "overview": {
          if (typeof params.relative_path !== "string" || !params.relative_path.trim()) {
            throw new Error('action "overview" requires a non-empty "relative_path"');
          }
          const depth = params.depth ?? 0;
          const data = await handleOverview(params.relative_path, depth, root);
          return {
            content: [{ type: "text" as const, text: formatOverviewResult(data, startTime) }],
            details: data,
          };
        }

        case "references": {
          if (typeof params.query !== "string" || !params.query.trim()) {
            throw new Error('action "references" requires a non-empty "query"');
          }
          const data = await handleReferences(params.query, params.relative_path, maxResults, root, cwd);
          return {
            content: [{ type: "text" as const, text: formatReferencesResult(data, params.query, startTime) }],
            details: data,
          };
        }

        case "declaration": {
          if (typeof params.query !== "string" || !params.query.trim()) {
            throw new Error('action "declaration" requires a non-empty "query"');
          }
          const data = await handleDeclaration(params.query, params.relative_path, params.include_body ?? false, root, cwd);
          return {
            content: [{ type: "text" as const, text: formatDeclarationResult(data, params.query, startTime) }],
            details: data,
          };
        }

        case "implementations": {
          if (typeof params.query !== "string" || !params.query.trim()) {
            throw new Error('action "implementations" requires a non-empty "query"');
          }
          const data = await handleImplementations(params.query, params.relative_path, params.include_body ?? false, maxResults, root, cwd, signal);
          return {
            content: [{ type: "text" as const, text: formatImplementationsResult(data, params.query, startTime) }],
            details: data,
          };
        }

        case "workspace": {
          if (typeof params.query !== "string" || !params.query.trim()) {
            throw new Error('action "workspace" requires a non-empty "query"');
          }
          const data = await handleWorkspace(params.query, maxResults, root);
          return {
            content: [{ type: "text" as const, text: formatWorkspaceResult(data, params.query, startTime) }],
            details: data,
          };
        }

        case "hover": {
          if (typeof params.relative_path !== "string" || !params.relative_path.trim()) {
            throw new Error('action "hover" requires a non-empty "relative_path"');
          }
          if (params.line === undefined || params.character === undefined) {
            throw new Error('action "hover" requires "line" and "character" parameters');
          }
          const data = await handleHover(params.relative_path, params.line, params.character, root);
          return {
            content: [{ type: "text" as const, text: formatHoverResult(data, params.query ?? params.relative_path, startTime) }],
            details: data,
          };
        }

        default:
        case "symbol": {
          if (typeof params.query !== "string" || !params.query.trim()) {
            throw new Error('action "symbol" (default) requires a non-empty "query"');
          }
          const data = await handleSymbol(params.query, maxResults, params.include_body ?? false, root, cwd, signal);
          return {
            content: [{ type: "text" as const, text: formatSymbolResult(data, params.query, startTime) }],
            details: data,
          };
        }
      }
    },
  } as unknown as ToolDefinition;
}

// ── Registration helper ────────────────────────────────────────────

export function registerFindSymbolTool(): void {
  const registry = ToolRegistry.getInstance();
  if (registry.get("find_symbol")) return;
  const toolDef = createFindSymbolTool();
  registry.register({
    name: "find_symbol",
    description: toolDef.description,
    inputSchema: FindSymbolSchema,
    execute: toolDef.execute,
    category: ToolCategory.SYMBOL,
  });
}
