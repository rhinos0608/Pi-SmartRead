export const SMARTREAD_TOOL_GUIDE_TITLE = "SmartRead Tool Guide";

const TOOL_GUIDE_LINES = [
  "Tool split: grep discovers candidates, read returns already-known source content, inspect analyzes aggregate structure/architecture, and LSP answers exact compiler/language-server semantic questions. Only complete rendered read blocks provide strong evidence for patch:",
  "- read { path } / { paths: [...] }: read one or several known files with contextual/batch evidence. read has no natural-language query mode. { symbol } is for reading source around an already-known qualified symbol, not for semantic navigation.",
  "- grep { pattern } or { queries: [...] }: primary broad/textual code discovery with lexical/BM25/symbol/semantic layers; use structural for ast-grep matching and graphFilter for graph-constrained discovery. Grep returns search-match evidence only, so read the source before editing it.",
  "- inspect { mode: 'file', path, analysis? }: aggregate structural analysis of a known file: dependencies/dependents, call graph, impact, dead code, routes, diff mapping, and quality signals.",
  "- inspect { mode: 'directory', path, analysis? }: repository/architecture analysis: ranked map, graph summary, clusters, layers, service boundaries, hotspots, routes, and related structural views. Inspect does not expose LSP navigation or diagnostics.",
  "- LSP { operation, ... }: strict read-only compiler/language-server semantics. Use it for definitions, declarations, references, implementations, hover, document/workspace symbols, type/call hierarchy, diagnostics, completion/signature/inlay information, semantic tokens, and refactor/code-action proposals. Positions are 0-based in server.positionEncoding; proposals never write files.",
  "- Rule of thumb: if the question is 'what does the language server/compiler know about this exact symbol/location?', use LSP. If it is 'what is the shape, architecture, blast radius, graph, or quality of this file/repo?', use inspect.",
  "- inspect { mode: 'script', script }: compose a bounded dependent multi-hop investigation when later grep/read/LSP/graph calls depend on earlier results. Do not use script for a lookup that one direct tool call covers.",
  "- skill: discover and read reusable agent workflow skills.",
  "Prefer narrow params. Large unbounded source reads may return a compact AST outline instead of the full source body, so use offset/limit or symbol for specific slices. After code changes, re-run the reads/inspects/LSP checks that informed decisions.",
];

export function renderSmartReadToolGuide(task?: string): string {
  const trimmedTask = task?.trim();
  const taskLine = trimmedTask ? [`Task: ${trimmedTask}`, ""] : [];
  return [...taskLine, ...TOOL_GUIDE_LINES].join("\n");
}
