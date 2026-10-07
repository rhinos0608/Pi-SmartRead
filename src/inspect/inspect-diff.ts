/**
 * Phase B split of inspect.ts: git-diff internals.
 *
 * Moved verbatim (runGitDiff, renderDiffSection). No behavior change.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as pathResolve } from "node:path";
import { findGitRoot } from "../git/git-history.js";
import type { DiffTarget } from "./inspect-types.js";
import type { CallGraphResult } from "../structural/callgraph.js";

const execFileAsync = promisify(execFile);

/**
 * Run git diff and return structured changes for the diff param.
 * Returns null when git is absent, not a repo, or diff fails.
 */
export async function runGitDiff(
    diffTarget: DiffTarget,
    cwd: string
): Promise<{ file: string; status?: string; oldFile?: string; addedCount: number; addedLines: number[]; deletedLines: number; changedLineRanges: Array<{ startLine: number; endLine: number }> }[] | null> {
    const gitRoot = await findGitRoot(cwd);
    if (!gitRoot) return null;

    const args: string[] = ["diff"];
    if (diffTarget === "staged") args.push("--cached");
    else if (diffTarget === "HEAD") args.push("HEAD~1");
    args.push("--numstat");

    let stdout: string;
    try {
        const result = await execFileAsync("git", args, {
            cwd: gitRoot,
            encoding: "utf-8",
            maxBuffer: 5 * 1024 * 1024,
        }) as { stdout: string };
        stdout = result.stdout;
    } catch {
        return null;
    }

    if (!stdout.trim()) return [];

    const files: Array<{
        file: string;
        addedCount: number;
        addedLines: number[];
        deletedLines: number;
        changedLineRanges: Array<{ startLine: number; endLine: number }>;
    }> = [];

    for (const line of stdout.trim().split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const added = parseInt(parts[0]!, 10);
        const _deleted = parseInt(parts[1]!, 10);
        const file = parts.slice(2).join("\t").trim();
        if (!file || isNaN(added)) continue;
        files.push({ file, addedCount: added, addedLines: [], deletedLines: _deleted, changedLineRanges: [] });
    }

    if (files.length === 0) return files;

    // Get unified diff with hunk headers for line number mapping
    const unifiedArgs: string[] = ["diff"];
    if (diffTarget === "staged") unifiedArgs.push("--cached");
    else if (diffTarget === "HEAD") unifiedArgs.push("HEAD~1");
    unifiedArgs.push("--unified=0");

    try {
        const unifiedResult = await execFileAsync("git", unifiedArgs, {
            cwd: gitRoot,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024,
        }) as { stdout: string };
        const unifiedStdout = unifiedResult.stdout;

        // Parse hunk headers to get changed line ranges per file
        const hunkRegex = /@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
        let currentFile = "";
        for (const uline of unifiedStdout.split("\n")) {
            const fileMatch = uline.match(/^\+\+\+\s+b\/(.+)$/);
            if (fileMatch) {
                currentFile = fileMatch[1]!;
                continue;
            }
            if (!currentFile) continue;
            const hunkMatch = hunkRegex.exec(uline);
            if (hunkMatch) {
                const startLine = parseInt(hunkMatch[1]!, 10);
                const hunkLen = hunkMatch[2] ? parseInt(hunkMatch[2]!, 10) : 1;
                const endLine = startLine + hunkLen - 1;
                const entry = files.find(f => f.file === currentFile);
                if (entry && hunkLen > 0) {
                    entry.addedLines.push(startLine, endLine);
                    entry.changedLineRanges.push({ startLine, endLine });
                }
            }
        }
    } catch {
        // Unified diff parsing is best-effort; numstat data is still usable
    }

    return files;
}

/**
 * Render the diff impact section text.
 */
export async function renderDiffSection(
    diffTarget: DiffTarget,
    cwd: string,
    callGraph?: CallGraphResult | null,
): Promise<{ text: string; emittedFiles: string[] }> {
    const changes = await runGitDiff(diffTarget, cwd);

    if (changes === null) {
        return { text: "## Diff Impact\n\nError: inspect diff requires a git repository", emittedFiles: [] };
    }

    if (changes.length === 0) {
        return { text: `## Diff Impact: ${diffTarget} changes\n\n(no changes found)`, emittedFiles: [] };
    }

    // Find symbols in changed line ranges using basic function-definition regex
    const lines: string[] = [
        `## Diff Impact: ${diffTarget} changes`,
        "",
        `Changed Files (${changes.length}):`,
    ];

    for (const change of changes) {
        const absPath = pathResolve(cwd, change.file);
        const symbols = (callGraph?.functions ?? []).filter((fn) => {
            const fnPath = pathResolve(cwd, fn.file);
            return fnPath === absPath && change.changedLineRanges.some((r) => fn.line <= r.endLine && (fn.endLine ?? fn.line) >= r.startLine);
        });
        const symbolNote = symbols.length > 0
            ? `${symbols.length} symbol${symbols.length !== 1 ? "s" : ""} modified: ${symbols.map((fn) => fn.qualifiedName ?? fn.name).join(", ")}`
            : "symbols unavailable (AST coverage incomplete)";
        lines.push(`  ${change.file}  — ${symbolNote}`);
    }

    // Risk requires complete impact evidence; diff churn alone is not evidence.
    lines.push("", "Impact assessment: unavailable (diff does not include complete callgraph coverage)");

    return { text: lines.join("\n"), emittedFiles: changes.map(c => pathResolve(cwd, c.file)) };
}
