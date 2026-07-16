export const SMARTREAD_TOOL_GUIDE_TITLE = "SmartRead Tool Guide";

const TOOL_GUIDE_LINES = [
  "Use read for known paths and inspect for file/directory understanding — both return details.workspaceEvidence that authorizes patch:",
  "- read { path }: exact file with contextual enrichment (imports, git history, git notes, graph, LSP) + strong evidence.",
  "- read { paths: [...] }: multiple known files with batch evidence.",
  "- read { query }: indexed BM25+embedding RRF, then reads selected files; falls back to grep+AST discovery.",
  "- inspect { path }: directory → ranked repo map; file → structural facts (callers, parent, children, overrides, re-exports) + quality signals (complexity, public API, reuse, recency, tests, deprecation).",
  "- grep { pattern }: primary code search — BM25 ranking + symbol matching + semantic fallback. Use for any pattern, symbol name, or concept.",
  "Prefer narrow params. After code changes, re-run reads/inspects that informed decisions.",
];

export function renderSmartReadToolGuide(task?: string): string {
  const trimmedTask = task?.trim();
  const taskLine = trimmedTask ? [`Task: ${trimmedTask}`, ""] : [];
  return [...taskLine, ...TOOL_GUIDE_LINES].join("\n");
}
