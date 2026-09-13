/** Static call graph extraction for TypeScript/JavaScript/Python/Go/Rust. */
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import Parser from "tree-sitter";
import { createRequire } from "node:module";
import { commonPathRoot } from "../workspace/workspace-boundary.js";
import { initParser } from "./tags.js";
import { filenameToLang, type SupportedLanguage } from "../languages.js";

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
function isClassNode(n: Parser.SyntaxNode): boolean { return classTypes.has(n.type); }
function classScope(n: Parser.SyntaxNode): string[] {
  const out: string[] = [];
  for (let p = n.parent; p; p = p.parent) {
    if (!isClassNode(p)) continue;
    const name = nodeName(p);
    if (name) out.unshift(name);
  }
  return out;
}
function isAnonymousDecl(n: Parser.SyntaxNode): boolean {
  if (n.type === "function_expression") return true;
  return n.type === "arrow_function" && n.parent?.type === "variable_declarator";
}
function isDeclNode(n: Parser.SyntaxNode): boolean {
  return declarationTypes.has(n.type) || isAnonymousDecl(n);
}
function declParentName(n: Parser.SyntaxNode): string | undefined {
  if (n.parent?.type !== "variable_declarator") return undefined;
  return n.parent.childForFieldName("name")?.text;
}
function isMethodNode(n: Parser.SyntaxNode, scope: string[]): boolean {
  if (scope.length > 0) return true;
  return n.type === "method_declaration" || n.type === "method_definition";
}
function makeDecl(n: Parser.SyntaxNode, rel: string, abs: string): Decl {
  const name = nodeName(n) ?? declParentName(n) ?? "(anonymous)";
  const scope = classScope(n);
  const qualifiedName = [...scope, name].join(".");
  const line = n.startPosition.row + 1;
  const endLine = n.endPosition.row + 1;
  const id = `${rel}::${qualifiedName}@${line}-${endLine}`;
  return { id, name, file: rel, line, endLine, calls: [], calledBy: [], qualifiedName, kind: isMethodNode(n, scope) ? "method" : "function", start: n.startIndex, end: n.endIndex, scope, fileAbs: abs, node: n };
}
function walkDecls(n: Parser.SyntaxNode, rel: string, abs: string, out: Decl[]): void {
  if (isDeclNode(n)) out.push(makeDecl(n, rel, abs));
  for (let i = 0; i < n.namedChildCount; i++) {
    const child = n.namedChild(i);
    if (child) walkDecls(child, rel, abs, out);
  }
}
function decls(root: Parser.SyntaxNode, rel: string, abs: string): Decl[] {
  const out: Decl[] = [];
  walkDecls(root, rel, abs, out);
  return out;
}
function resolveImport(from: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = resolve(dirname(from), spec);
  for (const suffix of ["", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", "/index.ts", "/index.js", "/__init__.py"]) { const p = `${base}${suffix}`; try { if (statSync(p).isFile()) return resolve(p); } catch { /* missing candidate */ } }
  return undefined;
}
function isDoubleQuoted(value: string): boolean {
  return value.length > 1 && value[0] === "\"" && value.at(-1) === "\"";
}

function isSingleQuoted(value: string): boolean {
  return value.length > 1 && value[0] === "'" && value.at(-1) === "'";
}

function quoted(text: string): string | undefined {
  const value = text.trim();
  if (isDoubleQuoted(value) || isSingleQuoted(value)) return value.slice(1, -1);
  return undefined;
}
type AddBinding = (alias: string | undefined, imported: string, spec: string, namespace?: boolean) => void;

function makeAddBinding(out: Map<string, Binding>, file: string): AddBinding {
  return (alias, imported, spec, namespace = false): void => {
    if (alias) out.set(alias, { path: resolveImport(file, spec), imported, namespace });
  };
}

function isTsLang(lang: SupportedLanguage): boolean {
  return lang === "typescript" || lang === "tsx" || lang === "javascript";
}

function addImportClauseMember(c: Parser.SyntaxNode, source: string, add: AddBinding): void {
  if (c.type === "namespace_import") add(c.childForFieldName("name")?.text, "*", source, true);
  else if (c.type === "named_import") add(c.childForFieldName("alias")?.text ?? c.childForFieldName("name")?.text, c.childForFieldName("name")?.text ?? "", source);
  else if (c.type === "identifier") add(c.text, "default", source);
}

function addTsImportStatement(n: Parser.SyntaxNode, add: AddBinding): void {
  if (n.type !== "import_statement") return;
  const source = quoted(n.childForFieldName("source")?.text ?? "");
  if (!source) return;
  const clause = n.childForFieldName("import");
  if (!clause) return;
  for (let i = 0; i < clause.namedChildCount; i++) {
    const c = clause.namedChild(i);
    if (c) addImportClauseMember(c, source, add);
  }
}

function isRequireCall(n: Parser.SyntaxNode): boolean {
  return n.type === "call_expression" && n.childForFieldName("function")?.text === "require";
}

function requireSource(n: Parser.SyntaxNode): string | undefined {
  return quoted(n.childForFieldName("arguments")?.namedChild(0)?.text ?? "");
}

function isDeclaratorParent(n: Parser.SyntaxNode): boolean {
  return n.parent?.type === "variable_declarator";
}

function addTsRequire(n: Parser.SyntaxNode, add: AddBinding): void {
  if (!isRequireCall(n)) return;
  const source = requireSource(n);
  if (!source || !isDeclaratorParent(n)) return;
  add(n.parent!.childForFieldName("name")?.text, "*", source, true);
}

function handleTsNode(n: Parser.SyntaxNode, add: AddBinding): void {
  addTsImportStatement(n, add);
  addTsRequire(n, add);
}

function addPythonFrom(n: Parser.SyntaxNode, add: AddBinding): void {
  if (n.type !== "import_from_statement") return;
  const module = n.childForFieldName("module_name")?.text;
  if (!module) return;
  const name = n.childForFieldName("name");
  if (!name) return;
  for (let i = 0; i < name.namedChildCount; i++) {
    const c = name.namedChild(i);
    if (c) add(c.text, c.text, module);
  }
}

function addPythonImport(n: Parser.SyntaxNode, add: AddBinding): void {
  if (n.type !== "import_statement") return;
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c) add(c.text.split(" as ").at(-1), c.text, c.text);
  }
}

function handlePythonNode(n: Parser.SyntaxNode, add: AddBinding): void {
  addPythonFrom(n, add);
  addPythonImport(n, add);
}

function handleGoNode(n: Parser.SyntaxNode, add: AddBinding): void {
  if (n.type !== "import_spec") return;
  const path = quoted(n.childForFieldName("path")?.text ?? "");
  if (!path) return;
  add(n.childForFieldName("name")?.text ?? path.split("/").at(-1), "*", path, true);
}

function handleRustNode(n: Parser.SyntaxNode, add: AddBinding): void {
  if (n.type !== "use_declaration") return;
  const path = n.namedChildren.at(-1)?.text;
  if (!path) return;
  const alias = path.split("::").at(-1);
  if (alias) add(alias, alias, path, true);
}

function handleImportNode(n: Parser.SyntaxNode, lang: SupportedLanguage, add: AddBinding): void {
  if (isTsLang(lang)) handleTsNode(n, add);
  else if (lang === "python") handlePythonNode(n, add);
  else if (lang === "go") handleGoNode(n, add);
  else if (lang === "rust") handleRustNode(n, add);
}

function walkImports(n: Parser.SyntaxNode, lang: SupportedLanguage, add: AddBinding): void {
  handleImportNode(n, lang, add);
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c) walkImports(c, lang, add);
  }
}

function imports(tree: Parser.Tree, file: string, lang: SupportedLanguage): Map<string, Binding> {
  const out = new Map<string, Binding>();
  walkImports(tree.rootNode, lang, makeAddBinding(out, file));
  return out;
}
function callFnNode(n: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return n.childForFieldName("function") ?? undefined;
}

function propertyOf(fn: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return fn.childForFieldName("property") ?? fn.childForFieldName("attribute") ?? fn.childForFieldName("field") ?? undefined;
}

function propertyTarget(fn: Parser.SyntaxNode, property: Parser.SyntaxNode): { name: string; receiver?: string } {
  const object = fn.childForFieldName("object") ?? fn.childForFieldName("argument");
  return { name: property.text, receiver: object?.text ?? fn.text.slice(0, -(property.text.length + 1)) };
}

function lastChildTarget(fn: Parser.SyntaxNode): { name: string; receiver?: string } | undefined {
  const last = fn.namedChildren.at(-1);
  if (!last) return undefined;
  return { name: last.text, receiver: fn.text.slice(0, -(last.text.length + 2)) };
}

function target(n: Parser.SyntaxNode): { name: string; receiver?: string } | undefined {
  const fn = callFnNode(n);
  if (!fn) return undefined;
  if (fn.type === "identifier") return { name: fn.text };
  const property = propertyOf(fn);
  if (property) return propertyTarget(fn, property);
  return lastChildTarget(fn);
}
function enclosing(ds: Decl[], n: Parser.SyntaxNode): Decl | undefined { return ds.filter(d => d.start <= n.startIndex && d.end >= n.endIndex).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]; }

function isCallNode(n: Parser.SyntaxNode): boolean {
  return n.type === "call_expression" || n.type === "call";
}

function isSelfReceiver(receiver: string): boolean {
  return receiver === "this" || receiver === "self";
}

function sameScope(a: Decl, b: Decl): boolean {
  return a.scope.join(".") === b.scope.join(".");
}

function readSource(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function parseFile(path: string, root: string): FileData | undefined {
  const lang = filenameToLang(path);
  const g = lang && grammar(lang);
  if (!lang || !g) return undefined;
  const code = readSource(path);
  if (code === undefined) return undefined;
  const parser = new Parser();
  parser.setLanguage(g);
  const tree = parser.parse(code);
  const rel = relative(root, path) || extname(path);
  return { path, rel, tree, lang, decls: decls(tree.rootNode, rel, path), imports: imports(tree, path, lang) };
}

function loadFileData(files: string[]): { data: FileData[]; skipped: number } {
  const root = commonPathRoot(files);
  const data: FileData[] = [];
  let skipped = 0;
  for (const input of files) {
    const parsed = parseFile(resolve(input), root);
    if (parsed) data.push(parsed);
    else skipped++;
  }
  return { data, skipped };
}

function freshCounts(skipped: number): CallGraphDiagnostics {
  return { total: 0, resolved: 0, unresolved: 0, ambiguous: 0, external: 0, receiverUnknown: 0, skippedFileCount: skipped };
}

interface GraphIndex { byFile: Map<string, FileData>; byId: Map<string, Decl> }

function indexFileData(data: FileData[]): GraphIndex {
  const byFile = new Map(data.map((d) => [d.path, d] as [string, FileData]));
  const byId = new Map<string, Decl>();
  for (const d of data) for (const fn of d.decls) byId.set(fn.id, fn);
  return { byFile, byId };
}

function makeEdge(caller: Decl, t: { name: string; receiver?: string }, n: Parser.SyntaxNode): CallEdge {
  return { caller: caller.id, callee: t.name, resolved: false, callerId: caller.id, callerLine: n.startPosition.row + 1, callSite: { line: n.startPosition.row + 1, column: n.startPosition.column }, receiver: t.receiver };
}

function receiverCandidates(file: FileData, caller: Decl, name: string, receiver: string, binding: Binding | undefined, index: GraphIndex, edge: CallEdge, counts: CallGraphDiagnostics): Decl[] {
  if (isSelfReceiver(receiver)) return file.decls.filter((d) => d.name === name && sameScope(d, caller));
  if (binding?.path) {
    edge.importPath = binding.path;
    return index.byFile.get(binding.path)?.decls.filter((d) => d.name === name) ?? [];
  }
  edge.diagnostic = "receiver-unknown";
  counts.receiverUnknown++;
  return [];
}

function isLocalCandidate(d: Decl, caller: Decl, name: string): boolean {
  return d.name === name && (sameScope(d, caller) || d.scope.length === 0);
}

function importCandidates(binding: Binding, index: GraphIndex, edge: CallEdge): Decl[] {
  edge.importPath = binding.path;
  return index.byFile.get(binding.path!)?.decls.filter((d) => binding.imported === "*" || d.name === binding.imported) ?? [];
}

function globalCandidates(data: FileData[], name: string): Decl[] {
  return data.flatMap((item) => item.decls.filter((d) => d.name === name && d.scope.length === 0));
}

function bareCandidates(file: FileData, data: FileData[], caller: Decl, name: string, binding: Binding | undefined, index: GraphIndex, edge: CallEdge): Decl[] {
  if (binding?.path) return importCandidates(binding, index, edge);
  const local = file.decls.filter((d) => isLocalCandidate(d, caller, name));
  if (local.length > 0) return local;
  return globalCandidates(data, name);
}

function resolveCandidates(file: FileData, data: FileData[], caller: Decl, t: { name: string; receiver?: string }, index: GraphIndex, edge: CallEdge, counts: CallGraphDiagnostics): Decl[] {
  const binding = file.imports.get(t.receiver ?? t.name);
  if (t.receiver) return receiverCandidates(file, caller, t.name, t.receiver, binding, index, edge, counts);
  return bareCandidates(file, data, caller, t.name, binding, index, edge);
}

function markResolved(edge: CallEdge, caller: Decl, callee: Decl, counts: CallGraphDiagnostics): void {
  edge.resolved = true;
  edge.calleeId = callee.id;
  edge.callee = callee.id;
  edge.calleeFile = callee.file;
  caller.calls.push(callee.id);
  callee.calledBy.push(caller.id);
  counts.resolved++;
}

function markUnresolvedKind(edge: CallEdge, binding: Binding | undefined, counts: CallGraphDiagnostics): void {
  if (edge.diagnostic) return;
  edge.diagnostic = binding && !binding.path ? "external" : "unresolved";
  if (edge.diagnostic === "external") counts.external++;
}

interface EdgeCtx { file: FileData; data: FileData[]; index: GraphIndex; counts: CallGraphDiagnostics; edges: CallEdge[] }

function finalizeEdgeCandidates(edge: CallEdge, candidates: Decl[], caller: Decl, binding: Binding | undefined, ctx: EdgeCtx): void {
  if (candidates.length === 1) markResolved(edge, caller, candidates[0]!, ctx.counts);
  else if (candidates.length > 1) {
    edge.diagnostic = "ambiguous";
    ctx.counts.ambiguous++;
  } else markUnresolvedKind(edge, binding, ctx.counts);
  if (!edge.resolved) ctx.counts.unresolved++;
  ctx.edges.push(edge);
}

function processCallNode(n: Parser.SyntaxNode, caller: Decl, t: { name: string; receiver?: string }, ctx: EdgeCtx): void {
  const edge = makeEdge(caller, t, n);
  ctx.counts.total++;
  const binding = ctx.file.imports.get(t.receiver ?? t.name);
  const candidates = resolveCandidates(ctx.file, ctx.data, caller, t, ctx.index, edge, ctx.counts);
  finalizeEdgeCandidates(edge, candidates, caller, binding, ctx);
}

function visitCallNode(n: Parser.SyntaxNode, ctx: EdgeCtx): void {
  if (!isCallNode(n)) return;
  const caller = enclosing(ctx.file.decls, n);
  const t = target(n);
  if (caller && t) processCallNode(n, caller, t, ctx);
}

function walkFileCalls(n: Parser.SyntaxNode, ctx: EdgeCtx): void {
  visitCallNode(n, ctx);
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (c) walkFileCalls(c, ctx);
  }
}

function markLeaves(functions: FunctionInfo[]): void {
  for (const fn of functions) fn.isLeaf = fn.calls.length === 0;
}

function lookupDecl(q: string, index: GraphIndex, functions: FunctionInfo[]): Decl[] {
  if (index.byId.has(q)) return [index.byId.get(q)!];
  const named = functions.filter((f) => f.name === q);
  if (named.length === 1) return named as Decl[];
  return [];
}

function relatedBy(edges: CallEdge[], index: GraphIndex, q: string, functions: FunctionInfo[], dir: "callers" | "callees"): FunctionInfo[] {
  const ids = new Set(lookupDecl(q, index, functions).map((f) => f.id));
  if (dir === "callers") {
    return edges.filter((e) => e.resolved && e.calleeId && ids.has(e.calleeId)).map((e) => index.byId.get(e.callerId!)).filter((f): f is Decl => Boolean(f));
  }
  return edges.filter((e) => e.resolved && e.callerId && ids.has(e.callerId)).map((e) => index.byId.get(e.calleeId!)).filter((f): f is Decl => Boolean(f));
}

export async function buildCallGraph(files: string[]): Promise<CallGraphResult> {
  await initParser();
  const { data, skipped } = loadFileData(files);
  const index = indexFileData(data);
  const counts = freshCounts(skipped);
  const edges: CallEdge[] = [];
  for (const file of data) walkFileCalls(file.tree.rootNode, { file, data, index, counts, edges });
  const functions = [...index.byId.values()];
  markLeaves(functions);
  const findById = (id: string): FunctionInfo | undefined => index.byId.get(id);
  return { functions, findById, edgeList: edges, edgeCount: counts.resolved, diagnostics: counts, callersOf: (q) => relatedBy(edges, index, q, functions, "callers"), calleesOf: (q) => relatedBy(edges, index, q, functions, "callees") };
}
function edgeTargets(edge: CallEdge, targetFunction: string, graph: CallGraphResult): boolean {
  if (edge.callee === targetFunction) return true;
  if (!edge.calleeId) return false;
  return graph.findById?.(edge.calleeId)?.name === targetFunction;
}

function collectCaller(edge: CallEdge, graph: CallGraphResult, out: { file: string; callerFunction: string }[], seen: Set<string>): void {
  const fn = edge.callerId ? graph.findById?.(edge.callerId) : undefined;
  if (!fn || !fn.id || seen.has(fn.id)) return;
  seen.add(fn.id);
  out.push({ file: fn.file, callerFunction: fn.name });
}

export async function findCallers(files: string[], targetFunction: string, signal?: AbortSignal): Promise<{ file: string; callerFunction: string }[]> {
  if (signal?.aborted) return [];
  const graph = await buildCallGraph(files);
  const out: { file: string; callerFunction: string }[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edgeList ?? []) {
    if (!edgeTargets(edge, targetFunction, graph)) continue;
    collectCaller(edge, graph, out, seen);
  }
  return out;
}
