export const SMARTREAD_TOOL_GUIDE_TITLE = "SmartRead Tool Guide";

const TOOL_GUIDE_LINES = [
  "Use inspect for all discovery — it replaces read/read_files/search/symbol/repo_map:",
  "- inspect { path }: exact file by path; add offset/limit for large files.",
  '- inspect { query }: rank files/matches by intent; add depth: "deep" for broad questions with semantic + graph evidence.',
  "- inspect { symbol }: known symbol names — find, outline, declaration, references, implementations.",
  '- inspect { action: "map" }: quick repository structure orientation.',
  "Prefer narrow params. After code changes, re-run inspects that informed decisions.",
];

export function renderSmartReadToolGuide(task?: string): string {
  const trimmedTask = task?.trim();
  const taskLine = trimmedTask ? [`Task: ${trimmedTask}`, ""] : [];
  return [...taskLine, ...TOOL_GUIDE_LINES].join("\n");
}
