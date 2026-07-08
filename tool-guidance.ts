export const SMARTREAD_TOOL_GUIDE_TITLE = "SmartRead Tool Guide";

const TOOL_GUIDE_LINES = [
  "Use SmartRead tools by job:",
  "- read: exact file by path; use offset/limit for large files.",
  '- read_files: several known files in one call; add query: "..." to rank unknown files by intent.',
  '- search: exact text, identifiers, regex, AST patterns; depth: "deep" for broad questions with semantic + graph evidence.',
  "- symbol: known symbol names — find, outline, declaration, references, implementations.",
  "- repo_map: quick repository structure orientation; use focus for relevant files or symbols.",
  "Prefer narrow params. After code changes, re-run reads/searches that informed decisions.",
];

export function renderSmartReadToolGuide(task?: string): string {
  const trimmedTask = task?.trim();
  const taskLine = trimmedTask ? [`Task: ${trimmedTask}`, ""] : [];
  return [...taskLine, ...TOOL_GUIDE_LINES].join("\n");
}
