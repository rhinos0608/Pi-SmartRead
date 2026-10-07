/**
 * Find output: grouped-by-directory rendering plus tool details.
 */
import { dirname } from "node:path";
import type { FindMode } from "./find-modes.js";
import { findModeLabel } from "./find-modes.js";

export interface FindEntry {
    path: string;
    type: "file" | "directory";
    score?: number;
    dirty?: boolean;
}

export interface FindRenderInput {
    pattern: string;
    mode: FindMode;
    entries: FindEntry[];
    total: number;
    elapsedMs: number;
    timedOut: boolean;
    unjudged: boolean;
}

function parentDir(relPath: string, type: "file" | "directory"): string {
    if (type === "directory") {
        const parent = dirname(relPath);
        return parent === "." ? "." : parent;
    }
    const dir = dirname(relPath);
    return dir === "." ? "." : dir;
}

function displayName(relPath: string, type: "file" | "directory"): string {
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    return type === "directory" ? `${base}/` : base;
}

function headerDir(dir: string): string {
    return dir === "." ? "./" : `${dir}/`;
}

/**
 * Group entries by parent directory, parents sorted with "." first,
 * entries within a group in the ranking order they arrived in.
 */
export function groupFindEntries(entries: FindEntry[]): Array<{ dir: string; items: FindEntry[] }> {
    const groups = new Map<string, FindEntry[]>();
    for (const entry of entries) {
        const dir = parentDir(entry.path, entry.type);
        const list = groups.get(dir);
        if (list) list.push(entry);
        else groups.set(dir, [entry]);
    }
    return [...groups.entries()]
        .sort((a, b) => {
            if (a[0] === ".") return -1;
            if (b[0] === ".") return 1;
            return a[0].localeCompare(b[0]);
        })
        .map(([dir, items]) => ({ dir, items }));
}

export function formatFindOutput(input: FindRenderInput): string {
    const { pattern, mode, entries, total, elapsedMs, timedOut, unjudged } = input;
    const noun = entries.length === 1 ? "entry" : "entries";
    const judged = mode === "natural-language" && unjudged ? ", ranked (unjudged)" : "";
    const lines = [
        `${total} ${noun} for "${pattern}" (${findModeLabel(mode)}${judged}, ${(elapsedMs / 1000).toFixed(1)}s)`,
        "",
    ];
    if (entries.length === 0) {
        lines.push("(no matches)");
    }
    for (const group of groupFindEntries(entries)) {
        lines.push(`# ${headerDir(group.dir)}`);
        for (const item of group.items) {
            const name = displayName(item.path, item.type);
            if (item.type === "directory") {
                lines.push(`  ${name}  [dir]`);
                continue;
            }
            const dirty = item.dirty === true && mode !== "natural-language" ? "*" : "";
            const score = typeof item.score === "number" ? `  ${item.score.toFixed(2)}` : "";
            lines.push(`  ${name}${dirty}${score}`);
        }
    }
    if (entries.length < total) {
        lines.push(`(showing ${entries.length} of ${total} — narrow the pattern or set path)`);
    }
    if (timedOut) {
        lines.push("(partial results: traversal budget exceeded — narrow the pattern or set path)");
    }
    return lines.join("\n");
}
