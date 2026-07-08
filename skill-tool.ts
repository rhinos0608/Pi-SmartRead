import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

interface SkillFrontmatter {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
}

interface SkillEntry {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
  disableModelInvocation: boolean;
}

interface SkillDiagnostic {
  path: string;
  message: string;
}

const DEFAULT_SKILL_FILE = "SKILL.md";
const MAX_SEARCH_RESULTS = 20;

export const SkillToolSchema = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("list"),
    Type.Literal("search"),
    Type.Literal("read"),
  ], { description: "Skill operation. Defaults to read when name is provided, search when query is provided, otherwise list." })),
  name: Type.Optional(Type.String({ description: "Skill name to read. Exact, case-insensitive, and substring matches are accepted." })),
  query: Type.Optional(Type.String({ description: "Search text matched against skill names and descriptions." })),
  file: Type.Optional(Type.String({ description: "File inside skill directory to read. Defaults to SKILL.md.", default: DEFAULT_SKILL_FILE })),
  includeHidden: Type.Optional(Type.Boolean({ description: "Include skills with disable-model-invocation: true in list/search output.", default: false })),
  cwd: Type.Optional(Type.String({ description: "Working directory for project skill discovery. Defaults to tool context cwd." })),
});

export type SkillToolInput = {
  action?: "list" | "search" | "read";
  name?: string;
  query?: string;
  file?: string;
  includeHidden?: boolean;
  cwd?: string;
};

function parseFrontmatter(raw: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return {};

  const frontmatter: SkillFrontmatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key === "name") frontmatter.name = value;
    if (key === "description") frontmatter.description = value;
    if (key === "disable-model-invocation") {
      frontmatter.disableModelInvocation = value === "true" || value === "yes" || value === "1";
    }
  }
  return frontmatter;
}

function findGitRoot(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function ancestorDirs(cwd: string): string[] {
  const resolved = path.resolve(cwd);
  const gitRoot = findGitRoot(resolved);
  const dirs: string[] = [];
  let current = resolved;
  while (true) {
    dirs.push(current);
    if (current === gitRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function readSettingsSkillPaths(settingsPath: string, diagnostics: SkillDiagnostic[]): string[] {
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as { skills?: unknown };
    return Array.isArray(parsed.skills) ? parsed.skills.filter((p): p is string => typeof p === "string") : [];
  } catch (err) {
    diagnostics.push({ path: settingsPath, message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

function resolveConfiguredPath(rawPath: string, baseDir: string): string {
  const expanded = rawPath.startsWith("~/") ? path.join(homedir(), rawPath.slice(2)) : rawPath;
  return path.resolve(baseDir, expanded);
}

function discoverRoots(cwd: string, diagnostics: SkillDiagnostic[]): Array<{ dir: string; source: string; includeRootFiles: boolean }> {
  const roots: Array<{ dir: string; source: string; includeRootFiles: boolean }> = [
    { dir: path.join(homedir(), ".pi", "agent", "skills"), source: "global:.pi", includeRootFiles: true },
    { dir: path.join(homedir(), ".agents", "skills"), source: "global:.agents", includeRootFiles: false },
  ];

  const ancestors = ancestorDirs(cwd);
  for (const dir of ancestors) {
    roots.push({ dir: path.join(dir, ".pi", "skills"), source: "project:.pi", includeRootFiles: true });
    roots.push({ dir: path.join(dir, ".agents", "skills"), source: "project:.agents", includeRootFiles: false });
    roots.push({ dir: path.join(dir, "skills"), source: "package:skills", includeRootFiles: true });

    const packagePath = path.join(dir, "package.json");
    if (existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(readFileSync(packagePath, "utf-8")) as { pi?: { skills?: unknown } };
        if (Array.isArray(pkg.pi?.skills)) {
          for (const skillPath of pkg.pi.skills) {
            if (typeof skillPath === "string") {
              roots.push({ dir: resolveConfiguredPath(skillPath, dir), source: "package:pi.skills", includeRootFiles: true });
            }
          }
        }
      } catch (err) {
        diagnostics.push({ path: packagePath, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  for (const settingsPath of [path.join(homedir(), ".pi", "agent", "settings.json"), ...ancestors.map((dir) => path.join(dir, ".pi", "settings.json"))]) {
    const baseDir = path.dirname(settingsPath);
    for (const skillPath of readSettingsSkillPaths(settingsPath, diagnostics)) {
      roots.push({ dir: resolveConfiguredPath(skillPath, baseDir), source: "settings", includeRootFiles: true });
    }
  }

  return roots;
}

function loadSkillFile(filePath: string, source: string, diagnostics: SkillDiagnostic[]): SkillEntry | undefined {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const frontmatter = parseFrontmatter(raw);
    if (!frontmatter.description?.trim()) return undefined;
    const baseDir = path.dirname(filePath);
    return {
      name: frontmatter.name || path.basename(baseDir),
      description: frontmatter.description,
      filePath,
      baseDir,
      source,
      disableModelInvocation: frontmatter.disableModelInvocation === true,
    };
  } catch (err) {
    diagnostics.push({ path: filePath, message: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

function scanSkillDir(dir: string, source: string, includeRootFiles: boolean, diagnostics: SkillDiagnostic[]): SkillEntry[] {
  if (!existsSync(dir)) return [];

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    diagnostics.push({ path: dir, message: err instanceof Error ? err.message : String(err) });
    return [];
  }

  const rootSkill = entries.find((entry) => entry.name === DEFAULT_SKILL_FILE);
  if (rootSkill?.isFile()) {
    const skill = loadSkillFile(path.join(dir, DEFAULT_SKILL_FILE), source, diagnostics);
    return skill ? [skill] : [];
  }

  const skills: SkillEntry[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      skills.push(...scanSkillDir(fullPath, source, false, diagnostics));
      continue;
    }
    if (includeRootFiles && entry.isFile() && entry.name.endsWith(".md")) {
      const skill = loadSkillFile(fullPath, source, diagnostics);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

function discoverSkills(cwd: string): { skills: SkillEntry[]; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, SkillEntry>();
  const seenRealPaths = new Set<string>();

  for (const root of discoverRoots(cwd, diagnostics)) {
    for (const skill of scanSkillDir(root.dir, root.source, root.includeRootFiles, diagnostics)) {
      let realPath = skill.filePath;
      try {
        realPath = realpathSync(skill.filePath);
      } catch {}
      if (seenRealPaths.has(realPath)) continue;
      seenRealPaths.add(realPath);
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }

  return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

function scoreSkill(skill: SkillEntry, query: string): number {
  const q = query.toLowerCase().trim();
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  if (name === q) return 100;
  if (name.includes(q)) return 80;
  if (description.includes(q)) return 50;
  return q.split(/\s+/).filter((term) => name.includes(term) || description.includes(term)).length * 10;
}

function findSkill(skills: SkillEntry[], name: string): SkillEntry | undefined {
  const query = name.trim();
  return skills.find((skill) => skill.name === query)
    ?? skills.find((skill) => skill.name.toLowerCase() === query.toLowerCase())
    ?? skills
      .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))[0]?.skill;
}

function resolveSkillFile(skill: SkillEntry, file: string): string {
  const requested = file || DEFAULT_SKILL_FILE;
  const target = path.resolve(skill.baseDir, requested);
  const realBase = realpathSync(skill.baseDir);
  const realTarget = realpathSync(target);
  const prefix = realBase.endsWith(path.sep) ? realBase : `${realBase}${path.sep}`;
  if (realTarget !== realBase && !realTarget.startsWith(prefix)) {
    throw new Error(`Skill file escapes skill directory: ${requested}`);
  }
  const stats = statSync(realTarget);
  if (!stats.isFile()) throw new Error(`Skill path is not a file: ${requested}`);
  return realTarget;
}

function renderSkillList(skills: SkillEntry[], diagnostics: SkillDiagnostic[]): string {
  const lines = [`Skills found: ${skills.length}`, ""];
  for (const skill of skills) {
    lines.push(`- ${skill.name} (${skill.source})`);
    lines.push(`  ${skill.description}`);
    lines.push(`  ${skill.filePath}${skill.disableModelInvocation ? " [hidden]" : ""}`);
  }
  if (diagnostics.length > 0) {
    lines.push("", `Diagnostics: ${diagnostics.length}`);
    for (const diagnostic of diagnostics.slice(0, 10)) {
      lines.push(`- ${diagnostic.path}: ${diagnostic.message}`);
    }
  }
  return lines.join("\n");
}

function renderSearchResults(results: SkillEntry[], query: string): string {
  if (results.length === 0) return `No skills matched query: ${query}`;
  return [
    `Skill matches for: ${query}`,
    "",
    ...results.map((skill) => `- ${skill.name}: ${skill.description}\n  ${skill.filePath}`),
    "",
    "Use action=read with name to load instructions.",
  ].join("\n");
}

function renderSkillRead(skill: SkillEntry, filePath: string, text: string): string {
  const rel = path.relative(skill.baseDir, filePath) || DEFAULT_SKILL_FILE;
  return [
    `<skill name="${skill.name}" location="${skill.filePath}">`,
    `Source: ${skill.source}`,
    `References are relative to ${skill.baseDir}.`,
    `File: ${rel}`,
    "",
    text,
    "</skill>",
  ].join("\n");
}

function textResult(text: string, isError = false): { content: Array<{ type: "text"; text: string }>; details: Record<string, never>; isError?: boolean } {
  return isError
    ? { content: [{ type: "text", text }], details: {}, isError }
    : { content: [{ type: "text", text }], details: {} };
}

export function createSkillTool(): ToolDefinition {
  return {
    name: "skill",
    label: "skill",
    description: "Discover and read Pi Agent Skills: reusable procedural instructions for tasks like debugging, security review, frontend design, or documentation. Use before specialized work, e.g. { action: \"search\", query: \"diagnose flaky test\" } or { name: \"security-review\" }. Prefer repo tools like search, read, and repo_map for project source code; skills explain how to work, not what the current code contains.",
    parameters: SkillToolSchema as Record<string, unknown>,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = (params ?? {}) as SkillToolInput;
      const cwd = input.cwd ? path.resolve(input.cwd) : ctx?.cwd ?? process.cwd();
      const { skills: allSkills, diagnostics } = discoverSkills(cwd);
      const visibleSkills = input.includeHidden ? allSkills : allSkills.filter((skill) => !skill.disableModelInvocation);
      const action = input.action ?? (input.name ? "read" : input.query ? "search" : "list");

      if (action === "list") {
        return textResult(renderSkillList(visibleSkills, diagnostics));
      }

      if (action === "search") {
        const query = input.query ?? input.name ?? "";
        if (!query.trim()) {
          return textResult("query required for skill search", true);
        }
        const matches = visibleSkills
          .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
          .filter((result) => result.score > 0)
          .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
          .slice(0, MAX_SEARCH_RESULTS)
          .map((result) => result.skill);
        return textResult(renderSearchResults(matches, query));
      }

      if (!input.name?.trim()) {
        return textResult("name required for skill read", true);
      }
      const skill = findSkill(visibleSkills, input.name);
      if (!skill) {
        return textResult(`Skill not found: ${input.name}\n\n${renderSkillList(visibleSkills, [])}`, true);
      }

      try {
        const filePath = resolveSkillFile(skill, input.file ?? DEFAULT_SKILL_FILE);
        const text = readFileSync(filePath, "utf-8");
        return textResult(renderSkillRead(skill, filePath, text));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(message, true);
      }
    },
  };
}
