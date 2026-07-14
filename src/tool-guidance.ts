export const SMARTREAD_TOOL_GUIDE_TITLE = "SmartRead Tool Guide";

const TOOL_GUIDE_LINES = [
  "Use read for known paths and inspect for discovery — both return details.workspaceEvidence that authorizes patch:",
  "- read { path }: exact file with contextual enrichment (imports, git history, git notes, graph, LSP) + strong evidence.",
  "- inspect { path }: exact file by path; add offset/limit for large files. Same enrichment + strong evidence.",
  '- inspect { query }: grep + AST search; add depth: "deep" to keep both and add semantic + symbol + graph + LSP evidence.',
  "- inspect { symbol }: known symbol names — find, outline, declaration, references, implementations.",
  '- inspect { action: "map" }: quick repository structure orientation.',
  "Prefer narrow params. After code changes, re-run reads/inspects that informed decisions.",
];

export function renderSmartReadToolGuide(task?: string): string {
  const trimmedTask = task?.trim();
  const taskLine = trimmedTask ? [`Task: ${trimmedTask}`, ""] : [];
  return [...taskLine, ...TOOL_GUIDE_LINES].join("\n");
}
