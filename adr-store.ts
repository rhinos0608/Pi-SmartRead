import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type AdrStatus = "proposed" | "accepted" | "superseded" | "rejected";

export interface AdrRecord {
  id: string;
  title: string;
  status: AdrStatus;
  date: string;
  context: string;
  decision: string;
  consequences: string;
  tags: string[];
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "decision";
}

export function adrDirectory(root: string): string {
  return join(resolve(root), ".pi-smartread", "adrs");
}

export function renderAdr(record: AdrRecord): string {
  return [
    "---",
    `id: ${record.id}`,
    `status: ${record.status}`,
    `date: ${record.date}`,
    `tags: ${record.tags.join(",")}`,
    "---",
    "",
    `# ${record.title}`,
    "",
    "## Context",
    record.context,
    "",
    "## Decision",
    record.decision,
    "",
    "## Consequences",
    record.consequences,
    "",
  ].join("\n");
}

export function parseAdr(text: string): AdrRecord | null {
  const match = /^---\n([\s\S]*?)\n---\n\n# (.+?)\n\n## Context\n([\s\S]*?)\n\n## Decision\n([\s\S]*?)\n\n## Consequences\n([\s\S]*?)\n?$/m.exec(text);
  if (!match) return null;
  const meta = new Map(match[1]!.split(/\r?\n/g).map((line) => {
    const idx = line.indexOf(":");
    return idx === -1 ? [line, ""] : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
  }));
  const status = meta.get("status") as AdrStatus;
  if (!status || !["proposed", "accepted", "superseded", "rejected"].includes(status)) return null;
  return {
    id: meta.get("id") ?? "",
    title: match[2]!.trim(),
    status,
    date: meta.get("date") ?? "",
    tags: (meta.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    context: match[3]!.trim(),
    decision: match[4]!.trim(),
    consequences: match[5]!.trim(),
  };
}

export function writeAdr(root: string, input: Omit<AdrRecord, "id" | "date"> & { id?: string; date?: string }): string {
  const dir = adrDirectory(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const id = input.id ?? `${date}-${slugify(input.title)}`;
  const record: AdrRecord = { ...input, id, date };
  const path = join(dir, `${id}.md`);
  writeFileSync(path, renderAdr(record), { mode: 0o600 });
  return path;
}

const MAX_ADR_FILE_BYTES = 2_000_000;

export function readAdrs(root: string): AdrRecord[] {
  const dir = adrDirectory(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      const path = join(dir, name);
      try {
        if (statSync(path).size > MAX_ADR_FILE_BYTES) return null;
        return parseAdr(readFileSync(path, "utf-8"));
      } catch {
        return null;
      }
    })
    .filter((record): record is AdrRecord => record !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}
