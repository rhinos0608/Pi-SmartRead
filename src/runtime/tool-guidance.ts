export const SMARTREAD_TOOL_GUIDE_TITLE = "SmartRead Tool Guide";

const TOOL_GUIDE_LINES = [
  "Use read for known paths and inspect for file/directory understanding. Only complete rendered read blocks provide strong evidence for patch:",
  "- read { path }: exact file with contextual enrichment (imports, git history, git notes, graph, LSP) + strong evidence.",
  "- read { paths: [...] }: multiple known files with batch evidence.",
  "- read { query }: indexed BM25+embedding RRF, then reads selected files; falls back to grep+AST discovery.",
  "- inspect { mode, path, ... }: mode file → structural facts (callers, parent, children, overrides, re-exports) + quality signals via analysis; mode directory → ranked repo map + architecture; mode navigate → LSP goto/symbol/hover via navigation {operation, line, character, query, maxResults} and fresh LSP diagnostics via diagnostics {waitMs, maxPerFile, maxFiles}. Inspect returns metadata evidence only — you must read a file before editing it.",
  "- grep { pattern }: primary code search — BM25 ranking + symbol matching + semantic fallback. Default match is literal substring; |, .*, \\. and similar auto-detect as regex, but a bare '.' is not (foo.bar ≠ fooXbar). literal:true forces substring. Also accepts { queries: [...] } with 1-10 full search objects and grep.structural {language, skip, groupByFile} for ast-grep structural search. Grep returns search-match evidence only — you must read a file before editing it.",
  "- skill: manage agent skills.",
  "Prefer narrow params. Large unbounded source reads may return a compact AST symbol outline instead of the full source body — use offset/limit or symbol for specific slices. After code changes, re-run reads/inspects that informed decisions.",
  "- inspect { mode: 'script', script }: compose a multi-hop investigation (grep, then read/LSP/graph calls whose arguments depend on the previous result) in one bounded read-only call instead of N sequential round trips. See skill inspect-script-mode.",
];

export function renderSmartReadToolGuide(task?: string): string {
  const trimmedTask = task?.trim();
  const taskLine = trimmedTask ? [`Task: ${trimmedTask}`, ""] : [];
  return [...taskLine, ...TOOL_GUIDE_LINES].join("\n");
}
