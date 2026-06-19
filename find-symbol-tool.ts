import { existsSync, promises as fs, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { toToolDefinition } from "./types.js";
import Parser from "tree-sitter";
import { initParser, loadLanguage, getQueryPath } from "./tags.js";
import { filenameToLang } from "./languages.js";
import { findSrcFiles } from "./file-discovery.js";
import { resolveSymbol } from "./symbol-resolver.js";
import { loadGrammar } from "./grammar-loader.js";
import { getGraphifyEnricher } from "./graphify-enricher.js";
import { ToolCategory, ToolRegistry } from "./tool-registry.js";
import { getLSPBridge, type LSPBridge, type LSPDocumentSymbol } from "./lsp-bridge.js";
import { expandToMonorepoRoots } from "./monorepo-detector.js";

// ── Schemas ─────────────────────────────────────────────────────────

const FindSymbolSchema = Type.Object({
  query: Type.String({ description: "Symbol name or pattern to search for. Supports qualified paths like 'ClassName.methodName'." }),
  include_body: Type.Optional(Type.Boolean({ description: "Include symbol source body in results (default: false)." })),
  maxResults: Type.Optional(Type.Number({ description: "Maximum results to return (1-10000, default: 30).", minimum: 1, maximum: 10000, default: 30 })),
  directory: Type.Optional(Type.String({ description: "Root directory to scope the search (default: extension working directory).", default: "." })),
});

const SymbolInfoSchema = Type.Object({
  action: Type.Union([
    Type.Literal("outline"),
    Type.Literal("declaration"),
    Type.Literal("references"),
    Type.Literal("implementations"),
  ], { description: "What to query: outline (file structure), declaration (canonical definition), references (all usages), implementations (interface/class implementors)." }),
  query: Type.Optional(Type.String({ description: "Symbol name or pattern (required for declaration/references/implementations)." })),
  path: Type.Optional(Type.String({ description: "File path (required for outline; optional context for others)." })),
  directory: Type.Optional(Type.String({ description: "Root directory (default: cwd).", default: "." })),
  include_body: Type.Optional(Type.Boolean({ description: "Include symbol source body (declaration/implementations)." })),
  maxResults: Type.Optional(Type.Number({ description: "Max results (references/implementations, default: 30).", minimum: 1, maximum: 10000, default: 30 })),
  childDepth: Type.Optional(Type.Number({ description: "Child depth for outline (default: 0).", minimum: 0, maximum: 5, default: 0 })),
});


// ── Helpers ────────────────────────────────────────────────────────

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

function resolveDirectory(directory: string | undefined, defaultCwd: string): string {
  const result = directory ? resolve(defaultCwd, directory) : resolve(defaultCwd);
  try {
    const realCwd = realpathSync(resolve(defaultCwd));
    let realDir: string;
    try {
      realDir = realpathSync(result);
    } catch {
      realDir = result;
    }
    const rel = relative(realCwd, realDir);
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
      throw new Error(`Directory outside workspace: ${directory ?? "."}`);
    }
    return realDir;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Directory outside workspace")) {
      throw err;
    }
    return result;
  }
}

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

// ── Handlers ───────────────────────────────────────────────────────

async function handleSymbol(
  query: string,
  maxResults: number,
  includeBody: boolean,
  root: string,
  cwd: string,
  signal?: AbortSignal,
) {
  // Fire off LSP workspace search concurrently with the tree-sitter scan so
  // both strategies contribute without sequential latency cost.
  const lspSearchPromise: Promise<SymbolEntry[]> = (async (): Promise<SymbolEntry[]> => {
    try {
      const bridge = await lsp();
      if (!bridge) return [];
      const symbols = await bridge.workspaceSymbol(query, root);
      return symbols.map((s) => ({
        name: s.name,
        kind: symbolKindToString(s.kind),
        relative_path: relative(cwd, decodeURIComponent(s.location.uri.replace(/^file:\/\//, ""))),
        line: s.location.range.start.line + 1,
        name_path: s.containerName ? `${s.containerName}.${s.name}` : s.name,
      }));
    } catch {
      return [];
    }
  })();

  const searchRoots = expandToMonorepoRoots(root);
  let allFiles: string[] = [];
  for (const sr of searchRoots) {
    const files = await findSrcFiles(sr, 50_000, signal);
    allFiles.push(...files);
  }
  allFiles = [...new Set(allFiles)];
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

  // Merge LSP results first (typically faster/more accurate for configured
  // language servers), then fill remaining slots with tree-sitter results.
  // Deduplicate by file:line so the same symbol isn't shown twice.
  const lspResults = await lspSearchPromise;
  const seen = new Set<string>();
  const merged: SymbolEntry[] = [];
  for (const r of lspResults) {
    if (merged.length >= maxResults) break;
    const key = `${r.relative_path}:${r.line}`;
    if (!seen.has(key)) { seen.add(key); merged.push(r); }
  }
  for (const m of matches) {
    if (merged.length >= maxResults) break;
    const key = `${m.relative_path}:${m.line}`;
    if (!seen.has(key)) { seen.add(key); merged.push(m); }
  }

  return { matches: merged, totalDefs, filesScanned: allFiles.length };
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

  try {
    const bridge = await lsp();
    if (bridge) {
      const docSymbols = await bridge.getDocumentSymbols(fullPath, root);
      if (docSymbols.length > 0) {
        symbols = flattenDocumentSymbols(docSymbols);
      }
    }
  } catch { /* LSP unavailable — fall through */ }

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

  const filtered = symbols.filter((s) => {
    const symbolDepth = s.namePath.split(".").length - 1;
    return symbolDepth <= depth;
  });

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
  if (relativePath) {
    const bridge = await lsp();
    if (bridge) {
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

/** Extract body text from a tree-sitter match for implementor entries. */
function getBodyTextForMatch(match: {
  captures: Array<{ node: { parent: { childForFieldName?: (name: string) => { text: string } | null; children: Array<{ type: string; text: string }>; text: string } | null } }>;
}): string | undefined {
  for (const cap of match.captures) {
    const parent = cap.node.parent;
    if (parent) {
      const bodyNode = parent.childForFieldName?.("body")
        ?? parent.children.find((c) => /body|block|declaration_list|field_declaration_list/.test(c.type));
      return (bodyNode ?? parent).text;
    }
  }
  return undefined;
}

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

  if (implementors.length === 0) {
    const result = await resolveSymbol(
      root, query,
      relativePath ? relative(cwd, resolve(root, relativePath)) : undefined,
      undefined, 5,
    );
    const defFiles = new Set(result.definitions.map((d) => d.file));
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

    if (implementors.length === 0) {
      const implSearchRoots = expandToMonorepoRoots(root);
      let implAllFiles: string[] = [];
      for (const sr of implSearchRoots) {
        implAllFiles.push(...await findSrcFiles(sr, 30_000, signal));
      }
      implAllFiles = [...new Set(implAllFiles)];
      for (const filePath of implAllFiles) {
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

          const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const extendsRe = new RegExp(`\\bextends\\s+${escapedQuery}\\b`, "i");
          const implementsRe = new RegExp(`\\bimplements\\s+[^;{]{0,200}\\b${escapedQuery}\\b`, "i");
          if (!isImpl && !extendsRe.test(code) && !implementsRe.test(code)) continue;

          let line = 1;
          for (const cap of match.captures) {
            if (cap.name === "name") { line = cap.node.startPosition.row + 1; break; }
          }
          implementors.push({
            file: relFile, line, name, kind: "class",
            body: includeBody ? getBodyTextForMatch(match) : undefined,
          });
        }
      }
    }
  }

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



// ── Tool definitions ───────────────────────────────────────────────

function createFindSymbolSearchTool(): ToolDefinition {
  return toToolDefinition({
    name: "find_symbol",
    label: "find_symbol",
    description: "Find symbols by name or pattern across the codebase using AST analysis and LSP (when available). Use when you know a symbol name and need to navigate to where it's defined. Supports qualified paths like 'ClassName.methodName' for precise matching.",
    parameters: FindSymbolSchema,

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const startTime = Date.now();
      const root = resolveDirectory(params.directory, ctx.cwd);
      const data = await handleSymbol(params.query, params.maxResults ?? 30, params.include_body ?? false, root, ctx.cwd, signal);
      return {
        content: [{ type: "text" as const, text: formatSymbolResult(data, params.query, startTime) }],
        details: data,
      };
    },
  });
}

function createSymbolInfoTool(): ToolDefinition {
  return toToolDefinition({
    name: "symbol_info",
    label: "symbol_info",
    description: "Query symbol information: outline (file structure), declaration (canonical definition), references (all usages), or implementations (interface/class implementors).",
    parameters: SymbolInfoSchema,

    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const startTime = Date.now();
      const root = resolveDirectory(params.directory, ctx.cwd);
      const action = params.action as string;

      switch (action) {
        case "outline": {
          if (!params.path) throw new Error('action "outline" requires "path" parameter');
          const data = await handleOverview(params.path, params.childDepth ?? 0, root);
          return { content: [{ type: "text" as const, text: formatOverviewResult(data, startTime) }], details: data };
        }
        case "declaration": {
          if (!params.query) throw new Error('action "declaration" requires "query" parameter');
          const data = await handleDeclaration(params.query, params.path, params.include_body ?? false, root, ctx.cwd);
          return { content: [{ type: "text" as const, text: formatDeclarationResult(data, params.query, startTime) }], details: data };
        }
        case "references": {
          if (!params.query) throw new Error('action "references" requires "query" parameter');
          const data = await handleReferences(params.query, params.path, params.maxResults ?? 30, root, ctx.cwd);
          return { content: [{ type: "text" as const, text: formatReferencesResult(data, params.query, startTime) }], details: data };
        }
        case "implementations": {
          if (!params.query) throw new Error('action "implementations" requires "query" parameter');
          const data = await handleImplementations(params.query, params.path, params.include_body ?? false, params.maxResults ?? 30, root, ctx.cwd, signal);
          return { content: [{ type: "text" as const, text: formatImplementationsResult(data, params.query, startTime) }], details: data };
        }
        default:
          throw new Error(`Unknown action: ${action}. Use outline, declaration, references, or implementations.`);
      }
    },
  });
}



// ── Registration ───────────────────────────────────────────────────

export function registerFindSymbolTool(): void {
  const registry = ToolRegistry.getInstance();
  const tools = [
    createFindSymbolSearchTool(),
    createSymbolInfoTool(),
  ];
  for (const tool of tools) {
    if (registry.get(tool.name)) continue;
    registry.register({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as Record<string, unknown>,
      execute: tool.execute,
      category: ToolCategory.SYMBOL,
    });
  }
}
