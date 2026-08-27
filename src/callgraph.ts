/** Static call graph extraction for TypeScript/JavaScript/Python/Go/Rust. */
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import Parser from "tree-sitter";
import { createRequire } from "node:module";
import { initParser } from "./tags.js";
import { filenameToLang, type SupportedLanguage } from "./languages.js";

const require = createRequire(import.meta.url);
type Grammar = Parameters<Parser["setLanguage"]>[0];
const grammars: Partial<Record<SupportedLanguage, Grammar>> = {
  typescript: require("tree-sitter-typescript").typescript as Grammar,
  tsx: require("tree-sitter-typescript").tsx as Grammar,
  javascript: require("tree-sitter-javascript") as Grammar,
  python: require("tree-sitter-python") as Grammar,
  go: require("tree-sitter-go") as Grammar,
  rust: require("tree-sitter-rust") as Grammar,
};
const grammarCache = new Map<SupportedLanguage, Grammar>();
function grammar(lang: SupportedLanguage): Grammar | undefined {
  const cached = grammarCache.get(lang); if (cached) return cached;
  const value = grammars[lang]; if (value) grammarCache.set(lang, value); return value;
}

type NodeId = string;
export type FunctionKind = "function" | "method";
export interface FunctionInfo { name: string; file: string; line: number; calls: string[]; calledBy: string[]; id?: NodeId; qualifiedName?: string; kind?: FunctionKind; endLine?: number; isLeaf?: boolean; }
export interface CallEdge { caller: string; callee: string; resolved: boolean; callerLine?: number; callerId?: NodeId; calleeId?: NodeId; calleeFile?: string; receiver?: string; importPath?: string; callSite?: { line: number; column: number }; diagnostic?: "external" | "ambiguous" | "unresolved" | "receiver-unknown"; }
export interface CallGraphDiagnostics { total: number; resolved: number; unresolved: number; ambiguous: number; external: number; receiverUnknown: number; skippedFileCount: number; }
export interface CallGraphResult { functions: FunctionInfo[]; callersOf: (nameOrId: string) => FunctionInfo[]; calleesOf: (nameOrId: string) => FunctionInfo[]; findById?: (id: NodeId) => FunctionInfo | undefined; edgeCount: number; edgeList?: CallEdge[]; diagnostics?: CallGraphDiagnostics; }

type Decl = FunctionInfo & { id: NodeId; qualifiedName: string; kind: FunctionKind; start: number; end: number; scope: string[]; fileAbs: string; node: Parser.SyntaxNode };
type Binding = { path?: string; imported: string; namespace?: boolean };
type FileData = { path: string; rel: string; tree: Parser.Tree; lang: SupportedLanguage; decls: Decl[]; imports: Map<string, Binding> };
const declarationTypes = new Set(["function_declaration", "function_definition", "function_item", "method_declaration", "method_definition"]);
const classTypes = new Set(["class_declaration", "class_definition", "struct_item", "impl_item"]);
function nodeName(n: Parser.SyntaxNode): string | undefined { return n.childForFieldName("name")?.text; }
function commonRoot(files: string[]): string {
  const paths = files.map(file => resolve(file)); if (!paths.length) return process.cwd();
  if (paths.length === 1) return dirname(paths[0]!);
  const parts = paths.map(p => p.split("/")); let i = 0;
  while (i < parts[0]!.length && parts.every(p => p[i] === parts[0]![i])) i++;
  return parts[0]!.slice(0, Math.max(1, i)).join("/") || "/";
}
function classScope(n: Parser.SyntaxNode): string[] { const out: string[] = []; for (let p = n.parent; p; p = p.parent) if (classTypes.has(p.type)) { const name = nodeName(p); if (name) out.unshift(name); } return out; }
function decls(root: Parser.SyntaxNode, rel: string, abs: string): Decl[] {
  const out: Decl[] = [];
  function walk(n: Parser.SyntaxNode): void {
    if (declarationTypes.has(n.type) || (n.type === "function_expression" || n.type === "arrow_function" && n.parent?.type === "variable_declarator")) {
      const parentName = n.parent?.type === "variable_declarator" ? n.parent.childForFieldName("name")?.text : undefined;
      const name = nodeName(n) ?? parentName ?? "(anonymous)";
      const scope = classScope(n), qualifiedName = [...scope, name].join(".");
      const line = n.startPosition.row + 1, endLine = n.endPosition.row + 1;
      const id = `${rel}::${qualifiedName}@${line}-${endLine}`;
      out.push({ id, name, file: rel, line, endLine, calls: [], calledBy: [], qualifiedName, kind: scope.length || n.type === "method_declaration" || n.type === "method_definition" ? "method" : "function", start: n.startIndex, end: n.endIndex, scope, fileAbs: abs, node: n });
    }
    for (let i = 0; i < n.namedChildCount; i++) { const child = n.namedChild(i); if (child) walk(child); }
  }
  walk(root); return out;
}
function resolveImport(from: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(from), spec);
  for (const suffix of ["", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", "/index.ts", "/index.js", "/__init__.py"]) { const p = `${base}${suffix}`; try { if (statSync(p).isFile()) return resolve(p); } catch { /* missing candidate */ } }
  return undefined;
}
function quoted(text: string): string | undefined { const value = text.trim(); return value.length > 1 && ((value[0] === "\"" && value.at(-1) === "\"") || (value[0] === "'" && value.at(-1) === "'")) ? value.slice(1, -1) : undefined; }
function imports(tree: Parser.Tree, file: string, lang: SupportedLanguage): Map<string, Binding> {
  const out = new Map<string, Binding>();
  function add(alias: string | undefined, imported: string, spec: string, namespace = false): void { if (alias) out.set(alias, { path: resolveImport(file, spec), imported, namespace }); }
  function walk(n: Parser.SyntaxNode): void {
    if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
      if (n.type === "import_statement") {
        const source = quoted(n.childForFieldName("source")?.text ?? ""); if (source) {
          const clause = n.childForFieldName("import");
          if (clause) for (let i = 0; i < clause.namedChildCount; i++) { const c = clause.namedChild(i); if (!c) continue; if (c.type === "namespace_import") add(c.childForFieldName("name")?.text, "*", source, true); else if (c.type === "named_import") add(c.childForFieldName("alias")?.text ?? c.childForFieldName("name")?.text, c.childForFieldName("name")?.text ?? "", source); else if (c.type === "identifier") add(c.text, "default", source); }
        }
      }
      if (n.type === "call_expression" && n.childForFieldName("function")?.text === "require") { const arg = n.childForFieldName("arguments")?.namedChild(0); const source = quoted(arg?.text ?? ""); const parent = n.parent; if (source && parent?.type === "variable_declarator") add(parent.childForFieldName("name")?.text, "*", source, true); }
    } else if (lang === "python") {
      if (n.type === "import_from_statement") { const module = n.childForFieldName("module_name")?.text; if (module) { const name = n.childForFieldName("name"); if (name) for (let i = 0; i < name.namedChildCount; i++) { const c = name.namedChild(i); if (c) add(c.text, c.text, module); } } }
      if (n.type === "import_statement") for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) add(c.text.split(" as ").at(-1), c.text, c.text); }
    } else if (lang === "go" && n.type === "import_spec") { const path = quoted(n.childForFieldName("path")?.text ?? ""); if (path) add(n.childForFieldName("name")?.text ?? path.split("/").at(-1), "*", path, true); }
    else if (lang === "rust" && n.type === "use_declaration") { const path = n.namedChildren.at(-1)?.text; if (path) { const alias = path.split("::").at(-1); if (alias) add(alias, alias, path, true); } }
    for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) walk(c); }
  }
  walk(tree.rootNode); return out;
}
function target(n: Parser.SyntaxNode): { name: string; receiver?: string } | undefined {
  const fn = n.childForFieldName("function"); if (!fn) return undefined;
  if (fn.type === "identifier") return { name: fn.text };
  const property = fn.childForFieldName("property") ?? fn.childForFieldName("attribute") ?? fn.childForFieldName("field");
  if (property) { const object = fn.childForFieldName("object") ?? fn.childForFieldName("argument"); return { name: property.text, receiver: object?.text ?? fn.text.slice(0, -(property.text.length + 1)) }; }
  const last = fn.namedChildren.at(-1); if (last) return { name: last.text, receiver: fn.text.slice(0, -(last.text.length + 2)) };
  return undefined;
}
function enclosing(ds: Decl[], n: Parser.SyntaxNode): Decl | undefined { return ds.filter(d => d.start <= n.startIndex && d.end >= n.endIndex).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]; }

export async function buildCallGraph(files: string[]): Promise<CallGraphResult> {
  await initParser(); const root = commonRoot(files), data: FileData[] = []; let skipped = 0;
  for (const input of files) { const path = resolve(input), lang = filenameToLang(path), g = lang && grammar(lang); if (!lang || !g) { skipped++; continue; } let code: string; try { code = readFileSync(path, "utf8"); } catch { skipped++; continue; } const parser = new Parser(); parser.setLanguage(g); const tree = parser.parse(code); const rel = relative(root, path) || extname(path); data.push({ path, rel, tree, lang, decls: decls(tree.rootNode, rel, path), imports: imports(tree, path, lang) }); }
  const byFile = new Map(data.map(d => [d.path, d])), byId = new Map<string, Decl>();
  for (const d of data) for (const fn of d.decls) byId.set(fn.id, fn);
  const edges: CallEdge[] = [], counts: CallGraphDiagnostics = { total: 0, resolved: 0, unresolved: 0, ambiguous: 0, external: 0, receiverUnknown: 0, skippedFileCount: skipped };
  for (const file of data) { function walk(n: Parser.SyntaxNode): void { if (n.type === "call_expression" || n.type === "call") { const caller = enclosing(file.decls, n), t = target(n); if (caller && t) { const edge: CallEdge = { caller: caller.id, callee: t.name, resolved: false, callerId: caller.id, callerLine: n.startPosition.row + 1, callSite: { line: n.startPosition.row + 1, column: n.startPosition.column }, receiver: t.receiver }; counts.total++; let candidates: Decl[] = [];
          const binding = file.imports.get(t.receiver ?? t.name);
          if (t.receiver) { if (t.receiver === "this" || t.receiver === "self") candidates = file.decls.filter(d => d.name === t.name && d.scope.join(".") === caller.scope.join(".")); else if (binding?.path) { edge.importPath = binding.path; candidates = byFile.get(binding.path)?.decls.filter(d => d.name === t.name) ?? []; } else { edge.diagnostic = "receiver-unknown"; counts.receiverUnknown++; } }
          else if (binding?.path) { edge.importPath = binding.path; candidates = byFile.get(binding.path)?.decls.filter(d => binding.imported === "*" || d.name === binding.imported) ?? []; }
          else {
            candidates = file.decls.filter(d => d.name === t.name && (d.scope.join(".") === caller.scope.join(".") || d.scope.length === 0));
            if (candidates.length === 0) candidates = data.flatMap(item => item.decls.filter(d => d.name === t.name && d.scope.length === 0));
          }
          if (candidates.length === 1) { const callee = candidates[0]!; edge.resolved = true; edge.calleeId = callee.id; edge.callee = callee.id; edge.calleeFile = callee.file; caller.calls.push(callee.id); callee.calledBy.push(caller.id); counts.resolved++; }
          else if (candidates.length > 1) { edge.diagnostic = "ambiguous"; counts.ambiguous++; }
          else if (!edge.diagnostic) { edge.diagnostic = binding && !binding.path ? "external" : "unresolved"; if (edge.diagnostic === "external") counts.external++; }
          if (!edge.resolved) counts.unresolved++; edges.push(edge); } } for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) walk(c); } } walk(file.tree.rootNode); }
  const functions = [...byId.values()]; for (const fn of functions) fn.isLeaf = fn.calls.length === 0;
  const findById = (id: string): FunctionInfo | undefined => byId.get(id);
  const lookup = (q: string): Decl[] => byId.has(q) ? [byId.get(q)!] : functions.filter(f => f.name === q).length === 1 ? functions.filter(f => f.name === q) : [];
  return { functions, findById, edgeList: edges, edgeCount: counts.resolved, diagnostics: counts, callersOf: q => { const ids = new Set(lookup(q).map(f => f.id)); return edges.filter(e => e.resolved && e.calleeId && ids.has(e.calleeId)).map(e => byId.get(e.callerId!)).filter((f): f is Decl => Boolean(f)); }, calleesOf: q => { const ids = new Set(lookup(q).map(f => f.id)); return edges.filter(e => e.resolved && e.callerId && ids.has(e.callerId)).map(e => byId.get(e.calleeId!)).filter((f): f is Decl => Boolean(f)); } };
}
export async function findCallers(files: string[], targetFunction: string, signal?: AbortSignal): Promise<{ file: string; callerFunction: string }[]> {
  if (signal?.aborted) return [];
  const graph = await buildCallGraph(files), out: { file: string; callerFunction: string }[] = [], seen = new Set<string>();
  for (const edge of graph.edgeList ?? []) {
    const callee = edge.calleeId ? graph.findById?.(edge.calleeId) : undefined;
    if (edge.callee !== targetFunction && callee?.name !== targetFunction) continue;
    const fn = edge.callerId ? graph.findById?.(edge.callerId) : undefined;
    if (fn && !seen.has(fn.id!)) { seen.add(fn.id!); out.push({ file: fn.file, callerFunction: fn.name }); }
  }
  return out;
}
